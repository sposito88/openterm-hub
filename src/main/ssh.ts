import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { Client, OpenSSHAgent, type AuthenticationType, type AuthHandlerMiddleware, type ConnectConfig, type ParsedKey } from 'ssh2'
import type { AgentKey, Host } from '@shared/types'
import type { Prompts } from './prompts'
import type { Store } from './store'

export interface SshDeps {
  store: Store
  prompts: Prompts
}

const MAX_JUMP_DEPTH = 5

/** ssh-agent socket; on Windows the OpenSSH agent service listens on a named pipe. */
export function agentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  return process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined
}
const HANDSHAKE_TIMEOUT_MS = 30_000

/** Per-connection state shared by the host verifier and the auth handler. */
interface Handshake {
  signal: AbortSignal
  /** Waits for a user prompt with the handshake timeout paused. */
  ask<T>(prompt: Promise<T>): Promise<T>
}

export function hostKeyInfo(key: Buffer): { keyType: string; fingerprint: string } {
  const len = key.readUInt32BE(0)
  const keyType = key.subarray(4, 4 + len).toString('latin1')
  const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return { keyType, fingerprint }
}

/** Keys held by the system ssh-agent (FIDO2 sk-* keys included, see patches/ssh2). */
export function listAgentKeys(path = agentPath()): Promise<AgentKey[]> {
  if (!path) return Promise.resolve([])
  return new Promise((resolve) => {
    new OpenSSHAgent(path).getIdentities((err, keys) => {
      if (err || !keys) return resolve([])
      // OpenSSHAgent always yields parsed keys (the typings also allow raw entries).
      resolve(
        (keys as ParsedKey[]).map((k) => ({
          type: k.type,
          comment: k.comment,
          fingerprint: 'SHA256:' + createHash('sha256').update(k.getPublicSSH()).digest('base64').replace(/=+$/, ''),
          securityKey: k.type.startsWith('sk-')
        }))
      )
    })
  })
}

async function verifyHostKey(deps: SshDeps, host: Host, key: Buffer, hs: Handshake): Promise<boolean> {
  const { keyType, fingerprint } = hostKeyInfo(key)
  const known = deps.store.knownHost(host.hostname, host.port)
  if (known && known.fingerprint === fingerprint) return true
  const accepted = await hs.ask(
    deps.prompts.hostKey({ host: host.hostname, port: host.port, keyType, fingerprint, previous: known?.fingerprint }, hs.signal)
  )
  if (accepted && !hs.signal.aborted) {
    deps.store.trustHost({ host: host.hostname, port: host.port, keyType, fingerprint, addedAt: new Date().toISOString() })
  }
  return accepted
}

interface Candidate {
  type: AuthenticationType
  make: () => Promise<Parameters<Parameters<AuthHandlerMiddleware>[2]>[0] | null>
}

/**
 * Tries, in order: SSH agent, the host's private key, the saved password,
 * keyboard-interactive and finally asks the user for a password. Methods the
 * server does not offer are skipped; cancelling any prompt aborts the login.
 */
function authHandler(deps: SshDeps, host: Host, hs: Handshake): AuthHandlerMiddleware {
  // The host's identity, when it has one, supplies the username, password and key.
  const { username, password, keyId: hostKeyId } = deps.store.credentials(host)
  const title = `${username}@${host.hostname}`
  const queue: Candidate[] = []
  let cancelled = false

  const agent = agentPath()
  if (host.useAgent && agent) {
    queue.push({
      type: 'agent',
      make: async () => {
        // A FIDO2 key blinks and waits for a touch: tell the user why the login pauses.
        if ((await listAgentKeys(agent)).some((k) => k.securityKey)) {
          deps.prompts.notice(`${title}: toque na sua chave de segurança se ela piscar / touch your security key if it blinks`)
        }
        return { type: 'agent', username, agent }
      }
    })
  }
  if (hostKeyId) {
    const keyId = hostKeyId
    queue.push({
      type: 'publickey',
      make: async () => {
        const key = deps.store.getSecret(`key:${keyId}:private`)
        if (!key) return { type: 'none', username }
        return { type: 'publickey', username, key, passphrase: deps.store.getSecret(`key:${keyId}:passphrase`) }
      }
    })
  }
  if (password) {
    queue.push({ type: 'password', make: async () => ({ type: 'password', username, password }) })
  }
  queue.push({
    type: 'keyboard-interactive',
    make: async () => ({
      type: 'keyboard-interactive',
      username,
      prompt: (name, instructions, _lang, prompts, finish) => {
        if (prompts.length === 0) return finish([])
        if (password && prompts.length === 1 && !prompts[0].echo) return finish([password])
        const ask = deps.prompts.credentials(
          {
            title: name || title,
            instructions: instructions || undefined,
            fields: prompts.map((p) => ({ label: p.prompt, secret: !p.echo }))
          },
          hs.signal
        )
        hs.ask(ask).then((values) => {
          if (hs.signal.aborted) return
          if (!values) cancelled = true
          finish(values ?? [])
        })
      }
    })
  })
  if (!password) {
    queue.push({
      type: 'password',
      make: async () => {
        const values = await hs.ask(deps.prompts.credentials({ title, fields: [{ label: 'Senha / Password', secret: true }] }, hs.signal))
        if (!values) return null
        return { type: 'password', username, password: values[0] }
      }
    })
  }

  return (methodsLeft, _partial, next) => {
    void (async () => {
      while (!cancelled && queue.length) {
        const c = queue.shift()!
        if (methodsLeft && !methodsLeft.includes(c.type)) continue
        const method = await c.make()
        if (hs.signal.aborted) return
        if (!method) break
        return next(method)
      }
      if (!hs.signal.aborted) next(false as never)
    })()
  }
}

function forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
  })
}

/** Opens an authenticated SSH connection to a saved host (through its jump host, if any). */
export async function connectHost(deps: SshDeps, hostId: string, depth = 0): Promise<Client> {
  const host = deps.store.host(hostId)
  if (!host) throw new Error('Host não encontrado')
  if (depth > MAX_JUMP_DEPTH) throw new Error('Cadeia de jump hosts muito longa (possível ciclo)')

  let jump: Client | undefined
  let sock: Duplex | undefined
  if (host.jumpHostId) {
    jump = await connectHost(deps, host.jumpHostId, depth + 1)
    try {
      sock = await forwardOut(jump, host.hostname, host.port)
    } catch (err) {
      jump.end()
      throw err
    }
  }

  const client = new Client()
  // ssh2 emits 'error' after 'ready' too; without a listener Node would crash the app.
  client.on('error', () => {})
  client.on('close', () => jump?.end())

  // The handshake timeout is ours (ssh2's readyTimeout is disabled) so that the time the
  // user spends reading a fingerprint or typing a password is not counted.
  const abort = new AbortController()
  const hs: Handshake = { signal: abort.signal, ask: (p) => p }

  const config: ConnectConfig = {
    host: host.hostname,
    port: host.port,
    username: deps.store.credentials(host).username,
    sock,
    readyTimeout: 0,
    keepaliveInterval: deps.store.settings().keepaliveSeconds * 1000,
    agent: host.agentForward ? agentPath() : undefined,
    agentForward: host.agentForward && !!agentPath(),
    tryKeyboard: true,
    authHandler: authHandler(deps, host, hs),
    hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
      // Never answer for a connection that already failed: its protocol state is gone.
      verifyHostKey(deps, host, key, hs).then(
        (ok) => !abort.signal.aborted && verify(ok),
        () => !abort.signal.aborted && verify(false)
      )
    }) as ConnectConfig['hostVerifier']
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let prompting = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abort.abort()
      client.removeListener('ready', onReady)
      client.destroy()
      jump?.end()
      reject(err)
    }
    const arm = (): void => {
      clearTimeout(timer)
      if (!settled && prompting === 0) {
        timer = setTimeout(() => fail(new Error('Tempo esgotado aguardando o servidor')), HANDSHAKE_TIMEOUT_MS)
      }
    }
    hs.ask = async (p) => {
      prompting++
      clearTimeout(timer)
      try {
        return await p
      } finally {
        prompting--
        arm()
      }
    }
    const onReady = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.removeListener('error', fail)
      resolve()
    }
    client.once('ready', onReady)
    client.once('error', fail)
    client.once('close', () => fail(new Error('Conexão encerrada durante o handshake')))
    arm()
    client.connect(config)
  })
  return client
}

export function exec(client: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => (stdout += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      stream.on('close', (code: number) => resolve({ code, stdout, stderr }))
    })
  })
}

/** POSIX single-quote escaping for values interpolated into remote shell commands. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
