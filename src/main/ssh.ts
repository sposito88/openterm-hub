import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { Client, OpenSSHAgent, type AuthenticationType, type AuthHandlerMiddleware, type ConnectConfig, type ParsedKey } from 'ssh2'
import type { AgentKey, Host, OsId } from '@shared/types'
import type { LocalHooks } from './localCommand'
import type { Prompts } from './prompts'
import { proxyConnect } from './proxy'
import type { Store } from './store'

const OS_PATTERNS: ReadonlyArray<[RegExp, OsId]> = [
  [/\braspbian\b|\braspberry\s*pi\b/i, 'raspbian'],
  [/\bubuntu\b/i, 'ubuntu'],
  [/\bdebian\b/i, 'debian'],
  [/\balmalinux\b|\balma\b/i, 'alma'],
  [/\brocky\b/i, 'rocky'],
  [/\bcentos\b/i, 'centos'],
  [/\bfedora\b/i, 'fedora'],
  [/\bred\s*hat\b|\brhel\b|\bredhat\b/i, 'redhat'],
  [/\balpine\b/i, 'alpine'],
  [/\bamazon\b|\bamzn\b/i, 'amazon'],
  [/\barch\b|\bmanjaro\b/i, 'arch'],
  [/\bsuse\b|\bopensuse\b|\bsles\b/i, 'suse'],
  [/\bgentoo\b/i, 'gentoo'],
  [/\bmageia\b/i, 'mageia'],
  [/\bfreebsd\b/i, 'freebsd'],
  [/\bopenbsd\b/i, 'openbsd'],
  [/\bnetbsd\b/i, 'netbsd'],
  [/\bdarwin\b|\bmacos\b|\bmac\s*os\b/i, 'macos'],
  [/\bmikrotik\b|\brouteros\b/i, 'routeros'],
  [/\bcisco\b/i, 'cisco'],
  [/\bwindows\b|\bmsys_nt\b|\bcygwin\b|\bmingw\b|\bopenssh_for_windows\b/i, 'windows']
]

export function detectOsFromText(text: string): OsId | null {
  if (!text) return null
  // Prefer ID= and PRETTY_NAME= lines from /etc/os-release when present.
  const idMatch = text.match(/^(?:ID|NAME|PRETTY_NAME|DISTRIB_ID)=["']?([^"'\r\n]+)["']?/im)
  if (idMatch) {
    for (const [re, os] of OS_PATTERNS) {
      if (re.test(idMatch[1])) return os
    }
  }
  for (const [re, os] of OS_PATTERNS) {
    if (re.test(text)) return os
  }
  if (/\blinux\b/i.test(text)) return 'linux'
  return null
}

export interface SshDeps {
  store: Store
  prompts: Prompts
  /** The hosts' local before/after commands (absent in tests that do not need them). */
  hooks?: LocalHooks
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

  // The host's "before" command (VPN, wake-on-LAN) runs ahead of everything, the jump host included.
  const release = (await deps.hooks?.acquire(host, deps.store.credentials(host).username)) ?? (() => {})
  let jump: Client | undefined
  let sock: Duplex | undefined
  try {
    if (host.jumpHostId) {
      jump = await connectHost(deps, host.jumpHostId, depth + 1)
      sock = await forwardOut(jump, host.hostname, host.port)
    } else if (host.proxy?.host) {
      // With a jump host, the proxy that counts is the jump host's own (the first hop).
      const p = host.proxy
      sock = await proxyConnect({ ...p, password: deps.store.getSecret(`host:${host.id}:proxyPassword`) }, host.hostname, host.port)
    }
  } catch (err) {
    jump?.end()
    release()
    throw err
  }

  const client = new Client()
  // ssh2 emits 'error' after 'ready' too; without a listener Node would crash the app.
  client.on('error', () => {})
  client.on('close', () => {
    jump?.end()
    release()
  })

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
      release()
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

  // Auto-detect the remote operating system once when the host does not have one yet.
  const latest = deps.store.host(hostId)
  if (latest && !latest.os) {
    const remoteVer = ((client as unknown as { _protocol?: { _remoteVer?: string } })._protocol?._remoteVer) ?? ''
    const bannerOs = detectOsFromText(remoteVer)
    if (bannerOs && bannerOs !== 'linux') {
      deps.store.saveHost({ ...latest, os: bannerOs })
    } else {
      void exec(client, 'cat /etc/os-release /etc/*release 2>/dev/null; uname -s 2>/dev/null')
        .then(({ stdout }) => {
          const detected = detectOsFromText(stdout) ?? bannerOs
          const cur = deps.store.host(hostId)
          if (detected && cur && !cur.os) deps.store.saveHost({ ...cur, os: detected })
        })
        .catch(() => {})
    }
  }

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
