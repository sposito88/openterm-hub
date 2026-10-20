import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect, createServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { after, before, test } from 'node:test'
import { Server, utils, type Connection } from 'ssh2'
import type { ForwardRule, Host, KnownHost, SshKey } from '../src/shared/types'
import { Forwarding } from '../src/main/forwarding'
import { generateKey, installKeyOnHost } from '../src/main/keys'
import { connectHost, exec, type SshDeps } from '../src/main/ssh'

let sshPort = 0
let echoPort = 0
const execs: string[] = []
const servers: Array<Server | NetServer> = []

async function listen(server: Server | NetServer): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = (s.address() as AddressInfo).port
  s.close()
  return port
}

function handleClient(client: Connection): void {
  client.on('error', () => {})
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'alice' && ctx.password === 'secret') return ctx.accept()
    ctx.reject(['password'])
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      accept().on('exec', (acc, _rej, info) => {
        execs.push(info.command)
        const ch = acc()
        ch.exit(0)
        ch.end()
      })
    })
    client.on('tcpip', (accept, _reject, info) => {
      const ch = accept()
      const sock = connect(info.destPort, info.destIP)
      ch.pipe(sock).pipe(ch)
    })
    client.on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward' || !accept || !reject) return reject?.()
      const { bindAddr, bindPort } = info as { bindAddr: string; bindPort: number }
      const srv = createServer((sock) => {
        client.forwardOut(bindAddr, bindPort, '127.0.0.1', sock.remotePort ?? 0, (err, ch) => {
          if (err) return sock.destroy()
          sock.pipe(ch).pipe(sock)
        })
      })
      servers.push(srv)
      srv.listen(bindPort, bindAddr, () => accept(bindPort))
    })
  })
}

function fakeDeps(opts: { password?: string; answers?: string[] }) {
  const host: Host = {
    id: 'h1', label: 'test', group: '', hostname: '127.0.0.1', port: 0, username: 'alice', protocol: 'ssh',
    hasPassword: !!opts.password, keyId: null, useAgent: false, agentForward: false, jumpHostId: null, startupSnippetId: null, tags: []
  }
  const secrets = new Map<string, string>()
  if (opts.password) secrets.set('host:h1:password', opts.password)
  const known: KnownHost[] = []
  const keys: SshKey[] = []
  const forwards: ForwardRule[] = []
  const hostKeyPrompts: Array<{ fingerprint: string; previous?: string }> = []
  const credentialPrompts: string[] = []
  const store = {
    host: (id: string) => (id === 'h1' ? { ...host, port: sshPort } : undefined),
    getSecret: (n: string) => secrets.get(n),
    setSecret: (n: string, v?: string) => (v ? secrets.set(n, v) : secrets.delete(n)),
    knownHost: (h: string, p: number) => known.find((k) => k.host === h && k.port === p),
    trustHost: (e: KnownHost) => {
      known.splice(0, known.length, ...known.filter((k) => k.host !== e.host || k.port !== e.port), e)
    },
    settings: () => ({ keepaliveSeconds: 0 }),
    forward: (id: string) => forwards.find((f) => f.id === id),
    key: (id: string) => keys.find((k) => k.id === id),
    saveKey: (k: Omit<SshKey, 'id'>) => {
      const full = { ...k, id: `k${keys.length + 1}` }
      keys.push(full)
      return full
    }
  }
  const prompts = {
    hostKey: async (p: { fingerprint: string; previous?: string }) => {
      hostKeyPrompts.push(p)
      return true
    },
    credentials: async (p: { title: string }) => {
      credentialPrompts.push(p.title)
      return opts.answers ?? null
    }
  }
  const deps = { store, prompts } as unknown as SshDeps
  return { deps, known, forwards, hostKeyPrompts, credentialPrompts }
}

before(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  sshPort = await listen(new Server({ hostKeys: [hostKey] }, handleClient))
  echoPort = await listen(createServer((s) => s.pipe(s)))
})

after(() => {
  for (const s of servers) s.close()
})

async function roundTrip(sock: Socket, text: string): Promise<string> {
  sock.write(text)
  const [data] = await once(sock, 'data')
  return data.toString()
}

test('host key is confirmed once, then trusted; a changed key asks again', async () => {
  const f = fakeDeps({ password: 'secret' })
  ;(await connectHost(f.deps, 'h1')).end()
  assert.equal(f.hostKeyPrompts.length, 1)
  assert.match(f.known[0].fingerprint, /^SHA256:/)
  ;(await connectHost(f.deps, 'h1')).end()
  assert.equal(f.hostKeyPrompts.length, 1)
  f.known[0].fingerprint = 'SHA256:other'
  ;(await connectHost(f.deps, 'h1')).end()
  assert.equal(f.hostKeyPrompts.length, 2)
  assert.equal(f.hostKeyPrompts[1].previous, 'SHA256:other')
})

test('asks for the password when none is saved; cancel aborts', async () => {
  const ok = fakeDeps({ answers: ['secret'] })
  ;(await connectHost(ok.deps, 'h1')).end()
  assert.equal(ok.credentialPrompts.length, 1)
  const cancel = fakeDeps({})
  await assert.rejects(connectHost(cancel.deps, 'h1'))
})

test('local, dynamic (SOCKS5) and remote forwarding', async () => {
  const f = fakeDeps({ password: 'secret' })
  const fw = new Forwarding(f.deps, () => {})
  const localPort = await freePort()
  const socksPort = await freePort()
  const remotePort = await freePort()
  f.forwards.push(
    { id: 'L', label: '', hostId: 'h1', kind: 'local', bindAddress: '127.0.0.1', bindPort: localPort, destHost: '127.0.0.1', destPort: echoPort },
    { id: 'D', label: '', hostId: 'h1', kind: 'dynamic', bindAddress: '127.0.0.1', bindPort: socksPort, destHost: '', destPort: 0 },
    { id: 'R', label: '', hostId: 'h1', kind: 'remote', bindAddress: '127.0.0.1', bindPort: remotePort, destHost: '127.0.0.1', destPort: echoPort }
  )
  await fw.start('L')
  await fw.start('D')
  await fw.start('R')
  try {
    const l = connect(localPort, '127.0.0.1')
    assert.equal(await roundTrip(l, 'via-local'), 'via-local')
    l.destroy()

    const s = connect(socksPort, '127.0.0.1')
    assert.deepEqual([...Buffer.from(await roundTrip(s, '\x05\x01\x00'), 'latin1')], [5, 0])
    s.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, echoPort >> 8, echoPort & 0xff]))
    const [reply] = await once(s, 'data')
    assert.equal((reply as Buffer)[1], 0)
    assert.equal(await roundTrip(s, 'via-socks'), 'via-socks')
    s.destroy()

    const r = connect(remotePort, '127.0.0.1')
    assert.equal(await roundTrip(r, 'via-remote'), 'via-remote')
    r.destroy()
  } finally {
    fw.stopAll()
  }
})

test('generated key is installed with a safely quoted command', async () => {
  const f = fakeDeps({ password: 'secret' })
  const key = generateKey(f.deps.store, { label: "it's mine", type: 'ed25519' })
  assert.match(key.publicKey, /^ssh-ed25519 \S+ it's_mine$/)
  await installKeyOnHost(f.deps, key.id, 'h1')
  const cmd = execs.at(-1)!
  assert.ok(cmd.includes(`'ssh-ed25519 ${key.publicKey.split(' ')[1]} it'\\''s_mine'`))
  assert.ok(cmd.includes('authorized_keys'))
  const client = await connectHost(f.deps, 'h1')
  assert.equal((await exec(client, 'true')).code, 0)
  client.end()
})
