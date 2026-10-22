import { spawn } from 'node:child_process'
import type { Host } from '@shared/types'

/**
 * A host's local commands (run on this computer): "before" when the first
 * connection to the host opens (bring a VPN up, wake-on-LAN) and "after" when
 * the last one closes. Terminal, SFTP and tunnels to the same host share them,
 * so closing an SFTP tab never takes the VPN down under an open terminal.
 */

const TIMEOUT_MS = 120_000

/** Host details for the commands, as environment variables (never spliced into the command line). */
export function hostEnv(host: Host, username: string): Record<string, string> {
  return {
    OPENTERM_HOST: host.hostname,
    OPENTERM_PORT: String(host.port),
    OPENTERM_USER: username,
    OPENTERM_LABEL: host.label
  }
}

export function runLocalCommand(command: string, env: Record<string, string>, timeoutMs = TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    const keep = (d: Buffer): void => {
      out = (out + d.toString()).slice(-2000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Comando local excedeu ${Math.round(timeoutMs / 1000)} s: ${command}`))
    }, timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Comando local falhou: ${err.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      const tail = out.trim().split('\n').slice(-3).join(' / ')
      reject(new Error(`Comando local falhou (código ${code}): ${command}${tail ? ` — ${tail}` : ''}`))
    })
  })
}

interface Entry {
  count: number
  ready: Promise<void>
  after: string
  env: Record<string, string>
}

export type Runner = (command: string, env: Record<string, string>) => Promise<void>

export class LocalHooks {
  private hosts = new Map<string, Entry>()

  constructor(
    private run: Runner = runLocalCommand,
    private onAfterError: (err: Error) => void = () => {}
  ) {}

  /**
   * Runs the host's "before" command when it is the first user and returns the
   * release function, which runs "after" once the last user releases it.
   */
  async acquire(host: Host, username: string): Promise<() => void> {
    const before = host.localBefore?.trim() ?? ''
    const after = host.localAfter?.trim() ?? ''
    if (!before && !after && !this.hosts.has(host.id)) return () => {}
    const env = hostEnv(host, username)
    let e = this.hosts.get(host.id)
    if (!e) {
      e = { count: 0, ready: before ? this.run(before, env) : Promise.resolve(), after, env }
      this.hosts.set(host.id, e)
    }
    const entry = e
    entry.count++
    try {
      await entry.ready
    } catch (err) {
      // A failed "before" leaves nothing to undo; the next connection tries again.
      if (--entry.count === 0) this.hosts.delete(host.id)
      throw err
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.count > 0) return
      this.hosts.delete(host.id)
      if (entry.after) void this.run(entry.after, entry.env).catch((err: Error) => this.onAfterError(err))
    }
  }
}
