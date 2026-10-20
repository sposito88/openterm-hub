import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { SshDeps } from '../src/main/ssh'
import { connectHost, exec, listAgentKeys } from '../src/main/ssh'

/**
 * End-to-end check of FIDO2 security keys through ssh-agent, against a real
 * OpenSSH sshd. A test agent signs like a hardware key would (OpenSSH
 * PROTOCOL.u2f, sk-ssh-ed25519@openssh.com) with a software Ed25519 key.
 */
const SSHD = '/usr/sbin/sshd'
const skip = process.platform !== 'linux' || !existsSync(SSHD) ? 'needs OpenSSH sshd on Linux' : false

const SK_TYPE = 'sk-ssh-ed25519@openssh.com'
const APPLICATION = 'ssh:'

const str = (b: Buffer | string): Buffer => {
  const data = Buffer.isBuffer(b) ? b : Buffer.from(b)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  return Buffer.concat([len, data])
}
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest()

const dir = mkdtempSync(join(tmpdir(), 'oth-fido-'))
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const skBlob = Buffer.concat([str(SK_TYPE), str(rawPub), str(APPLICATION)])
let signatures = 0
/** Whether the simulated authenticator reports that the user touched it. */
let userPresence = true

/** Minimal ssh-agent: lists the security key and signs like the authenticator would. */
function startAgent(socket: string): Server {
  return createServer((conn) => {
    let buf = Buffer.alloc(0)
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const msg = buf.subarray(4, 4 + buf.readUInt32BE(0))
        buf = buf.subarray(4 + msg.length)
        let reply: Buffer
        if (msg[0] === 11) {
          // SSH_AGENTC_REQUEST_IDENTITIES → SSH_AGENT_IDENTITIES_ANSWER
          const count = Buffer.alloc(4)
          count.writeUInt32BE(1)
          reply = Buffer.concat([Buffer.from([12]), count, str(skBlob), str('yubikey de teste')])
        } else if (msg[0] === 13) {
          // SSH_AGENTC_SIGN_REQUEST: string key, string data, uint32 flags
          const keyLen = msg.readUInt32BE(1)
          const dataLen = msg.readUInt32BE(5 + keyLen)
          const data = msg.subarray(9 + keyLen, 9 + keyLen + dataLen)
          const flags = Buffer.from([userPresence ? 0x01 : 0x00]) // bit 0: the key was touched
          const counter = Buffer.alloc(4)
          counter.writeUInt32BE(++signatures)
          const signed = Buffer.concat([sha256(APPLICATION), flags, counter, sha256(data)])
          const sig = sign(null, signed, privateKey)
          reply = Buffer.concat([Buffer.from([14]), str(Buffer.concat([str(SK_TYPE), str(sig), flags, counter]))])
        } else {
          reply = Buffer.from([5]) // SSH_AGENT_FAILURE
        }
        const len = Buffer.alloc(4)
        len.writeUInt32BE(reply.length)
        conn.write(Buffer.concat([len, reply]))
      }
    })
  }).listen(socket)
}

let sshd: ChildProcess | undefined
let sshdExited = false
let agent: Server | undefined
let port = 0

before(async () => {
  if (skip) return
  const free = createServer().listen(0, '127.0.0.1')
  await once(free, 'listening')
  port = (free.address() as AddressInfo).port
  free.close()
  await new Promise<void>((resolve, reject) => {
    const kg = spawn('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_key')])
    kg.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ssh-keygen failed'))))
  })
  writeFileSync(join(dir, 'authorized_keys'), `${SK_TYPE} ${skBlob.toString('base64')} test\n`, { mode: 0o600 })
  writeFileSync(
    join(dir, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'host_key')}`,
      `PidFile ${join(dir, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
      'StrictModes no',
      'UsePAM no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes'
    ].join('\n') + '\n'
  )
  sshd = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
  sshd.on('exit', () => (sshdExited = true))
  await new Promise((r) => setTimeout(r, 600))
  agent = startAgent(join(dir, 'agent.sock'))
  await once(agent, 'listening')
  process.env.SSH_AUTH_SOCK = join(dir, 'agent.sock')
})

after(() => {
  sshd?.kill()
  agent?.close()
})

test('logs in to OpenSSH with a FIDO2 security key held by ssh-agent', { skip }, async (t) => {
  // CI images may lack what a non-root sshd needs (e.g. /run/sshd).
  if (sshdExited) return t.skip('sshd could not start here')
  const host = {
    id: 'fido', label: 'fido', group: '', hostname: '127.0.0.1', port, username: userInfo().username, protocol: 'ssh' as const,
    hasPassword: false, keyId: null, useAgent: true, agentForward: false, jumpHostId: null, startupSnippetId: null, tags: []
  }
  const deps = {
    store: {
      host: () => host,
      getSecret: () => undefined,
      knownHost: () => undefined,
      trustHost: () => {},
      settings: () => ({ keepaliveSeconds: 0 })
    },
    prompts: { hostKey: async () => true, credentials: async () => null, notice: (text: string) => notices.push(text) }
  } as unknown as SshDeps
  const notices: string[] = []

  const keys = await listAgentKeys()
  assert.deepEqual(keys.map((k) => [k.type, k.securityKey]), [[SK_TYPE, true]])

  const client = await connectHost(deps, 'fido')
  const res = await exec(client, 'echo fido-ok')
  client.end()
  assert.equal(res.stdout.trim(), 'fido-ok')
  assert.ok(signatures >= 1, 'the agent signed with the security key')
  assert.ok(notices.some((n) => n.includes('chave de segurança')), 'the user is told to touch the key')
})

test('OpenSSH refuses a security-key signature made without a touch', { skip }, async (t) => {
  if (sshdExited) return t.skip('sshd could not start here')
  userPresence = false
  try {
    const host = {
      id: 'fido', label: 'fido', group: '', hostname: '127.0.0.1', port, username: userInfo().username, protocol: 'ssh' as const,
      hasPassword: false, keyId: null, useAgent: true, agentForward: false, jumpHostId: null, startupSnippetId: null, tags: []
    }
    const deps = {
      store: { host: () => host, getSecret: () => undefined, knownHost: () => undefined, trustHost: () => {}, settings: () => ({ keepaliveSeconds: 0 }) },
      prompts: { hostKey: async () => true, credentials: async () => null, notice: () => {} }
    } as unknown as SshDeps
    await assert.rejects(connectHost(deps, 'fido'), /authentication methods failed/)
  } finally {
    userPresence = true
  }
})
