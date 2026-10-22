import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { SerialPort } from 'serialport'
import type { ClientChannel } from 'ssh2'
import { askFields, expandSnippet } from '@shared/snippetVars'
import type { Host, LogEntry, SerialPortInfo, SessionInfo, SessionTarget, Snippet } from '@shared/types'
import { Autoresponder } from './automation'
import type { Logs, SessionLog } from './logs'
import { connectHost, type SshDeps } from './ssh'

type Send = (channel: string, ...args: unknown[]) => void

/** The user's shell: PowerShell on Windows, a login shell on macOS (like Terminal.app). */
export function localShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.OPENTERM_SHELL || 'powershell.exe', args: [] }
  const file = process.env.OPENTERM_SHELL || process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: process.platform === 'darwin' ? ['-l'] : [] }
}

/**
 * Apps started from the macOS Finder get a minimal PATH, so Homebrew tools
 * such as mosh would not be found.
 */
function childEnv(term: string): Record<string, string> {
  const env = { ...process.env, TERM: term, COLORTERM: 'truecolor' } as Record<string, string>
  if (process.platform === 'darwin') env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH].filter(Boolean).join(':')
  return env
}

interface Session {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  hostId?: string
  auto?: Autoresponder
}

export class Sessions {
  private sessions = new Map<string, Session>()
  private logs = new Map<string, SessionLog>()
  /** Automation of sessions still opening: their first output can arrive before open() returns. */
  private pendingAuto = new Map<string, Autoresponder>()

  constructor(
    private deps: SshDeps,
    private send: Send,
    private logStore: Logs
  ) {}

  private emitData = (id: string) => (data: string | Buffer) => {
    const text = data.toString()
    this.logs.get(id)?.write(text)
    this.send('session:data', id, text)
    ;(this.sessions.get(id)?.auto ?? this.pendingAuto.get(id))?.feed(text)
  }

  /**
   * Exit reasons sent to the renderer: "exit <code>" when the program ended
   * (the user typed exit), "disconnected" when the connection dropped, which
   * is what triggers automatic reconnection.
   */
  private emitExit = (id: string, reason: string): void => {
    const s = this.sessions.get(id)
    if (!s) return
    s.auto?.dispose()
    this.sessions.delete(id)
    this.logs.get(id)?.end(reason, reason !== 'disconnected')
    this.logs.delete(id)
    this.send('session:exit', id, reason)
  }

  private describe(target: SessionTarget): Pick<LogEntry, 'title' | 'target' | 'protocol'> {
    if (target.kind === 'local') return { title: 'Local', target: localShell().file, protocol: 'local' }
    if (target.kind === 'serial') return { title: target.path, target: `${target.path} @ ${target.baudRate}`, protocol: 'serial' }
    const host = this.deps.store.host(target.hostId)
    if (!host) throw new Error('Host não encontrado')
    const { username } = this.deps.store.credentials(host)
    const user = username ? `${username}@` : ''
    return { title: host.label || host.hostname, target: `${user}${host.hostname}:${host.port}`, protocol: host.protocol }
  }

  async open(target: SessionTarget, cols: number, rows: number): Promise<SessionInfo> {
    const id = randomUUID()
    const info = this.describe(target)
    const settings = this.deps.store.settings()
    const term = settings.termType
    let session: Session
    try {
      if (target.kind === 'local') {
        const shell = localShell()
        session = this.spawnPty(id, shell.file, shell.args, cols, rows, term)
      } else if (target.kind === 'serial') {
        session = await this.openSerial(id, target.path, target.baudRate)
      } else {
        const host = this.deps.store.host(target.hostId)!
        const auto = this.automate(id, host)
        this.pendingAuto.set(id, auto)
        try {
          if (host.protocol === 'ssh') session = await this.openSsh(id, target.hostId, cols, rows, term)
          else session = await this.openPtyHost(id, host, cols, rows, term)
        } catch (err) {
          auto.dispose()
          throw err
        } finally {
          this.pendingAuto.delete(id)
        }
        session.hostId = host.id
        session.auto = auto
      }
    } catch (err) {
      this.logStore.start(info, false).end((err as Error).message, false)
      throw err
    }

    this.logs.set(id, this.logStore.start(info, settings.sessionLogging))
    this.sessions.set(id, session)
    session.auto?.start()
    return { id, title: info.title }
  }

  /** Mosh and Telnet run the system binaries; the host's local commands wrap them. */
  private async openPtyHost(id: string, host: Host, cols: number, rows: number, term: string): Promise<Session> {
    const { username } = this.deps.store.credentials(host)
    const release = (await this.deps.hooks?.acquire(host, username)) ?? (() => {})
    let session: Session
    try {
      if (host.protocol === 'mosh') {
        // Mosh authenticates through the system ssh, so it uses ~/.ssh config and keys.
        const dest = username ? `${username}@${host.hostname}` : host.hostname
        session = this.spawnPty(id, 'mosh', [`--ssh=ssh -p ${host.port}`, dest], cols, rows, term, release)
      } else {
        session = this.spawnPty(id, 'telnet', [host.hostname, String(host.port)], cols, rows, term, release)
      }
    } catch (err) {
      release()
      throw err
    }
    return session
  }

  /**
   * The host's login sequence and sudo answers. The startup snippet waits for the
   * sequence: it is meant for the shell the sequence ends in (after "sudo su -").
   */
  private automate(id: string, host: Host): Autoresponder {
    const { username, password } = this.deps.store.credentials(host)
    const fill = (text: string): string => text.replace(/\{\{\s*password\s*\}\}/g, password ?? '').replace(/\{\{\s*user\s*\}\}/g, username)
    const steps = (host.loginSteps ?? [])
      .filter((s) => s.expect.trim() || s.send || s.secret)
      .map((s) => ({ expect: s.expect, send: s.secret ? (this.deps.store.getSecret(`host:${host.id}:step:${s.id}`) ?? '') : fill(s.send) }))
    return new Autoresponder({
      steps,
      sudoPassword: host.autoSudo && password ? password : undefined,
      write: (d) => this.sessions.get(id)?.write(d),
      notice: (text) => this.deps.prompts.notice(text),
      onStepsDone: (ok, reason) => {
        if (!ok && reason) this.deps.prompts.notice(`${host.label}: ${reason}`)
        const snippet = host.startupSnippetId ? this.deps.store.snippet(host.startupSnippetId) : undefined
        if (snippet) void this.typeSnippet(id, snippet)
      }
    })
  }

  /** Fills a snippet's variables ({{ask:…}} asks the user) and types it; false when cancelled. */
  async typeSnippet(id: string, snippet: Snippet): Promise<boolean> {
    const host = this.sessions.get(id)?.hostId ? this.deps.store.host(this.sessions.get(id)!.hostId!) : undefined
    const ctx = {
      host: host?.hostname,
      label: host?.label,
      user: host ? this.deps.store.credentials(host).username : undefined,
      port: host?.port,
      variables: this.deps.store.settings().variables
    }
    const asks = askFields(snippet.script)
    const answers: Record<string, string> = {}
    if (asks.length) {
      const values = await this.deps.prompts.credentials({
        title: snippet.label,
        fields: asks.map((a) => ({ label: a.question, secret: false, value: a.default }))
      })
      if (!values) return false
      asks.forEach((a, i) => (answers[a.question] = values[i] ?? ''))
    }
    if (!this.sessions.has(id)) return false
    this.write(id, expandSnippet(snippet.script, ctx, answers).replace(/\n?$/, '\n').replace(/\r?\n/g, '\r'))
    return true
  }

  private spawnPty(id: string, file: string, args: string[], cols: number, rows: number, term: string, onExit?: () => void): Session {
    const proc = pty.spawn(file, args, {
      name: term,
      cols,
      rows,
      cwd: homedir(),
      env: childEnv(term)
    })
    proc.onData(this.emitData(id))
    proc.onExit(({ exitCode }) => {
      onExit?.()
      this.emitExit(id, `exit ${exitCode}`)
    })
    return {
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      close: () => proc.kill()
    }
  }

  private async openSsh(id: string, hostId: string, cols: number, rows: number, term: string): Promise<Session> {
    const client = await connectHost(this.deps, hostId)
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term, cols, rows }, (err, s) => (err ? reject(err) : resolve(s)))
    }).catch((err) => {
      client.end()
      throw err
    })
    let exitCode: number | string | undefined
    // utf8 decoding on the stream keeps multi-byte characters intact across chunks.
    stream.setEncoding('utf8')
    stream.stderr.setEncoding('utf8')
    stream.on('data', this.emitData(id))
    stream.stderr.on('data', this.emitData(id))
    stream.on('exit', (code: number | null, signal?: string) => (exitCode = code ?? signal ?? 0))
    stream.on('close', () => {
      client.end()
      this.emitExit(id, exitCode === undefined ? 'disconnected' : `exit ${exitCode}`)
    })
    client.on('close', () => this.emitExit(id, 'disconnected'))
    return {
      write: (d) => stream.write(d),
      resize: (c, r) => stream.setWindow(r, c, 0, 0),
      close: () => {
        stream.close()
        client.end()
      }
    }
  }

  private async openSerial(id: string, path: string, baudRate: number): Promise<Session> {
    const port = new SerialPort({ path, baudRate, autoOpen: false })
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())))
    port.setEncoding('utf8')
    port.on('data', this.emitData(id))
    port.on('close', () => this.emitExit(id, 'disconnected'))
    port.on('error', () => this.emitExit(id, 'disconnected'))
    return {
      write: (d) => port.write(d),
      resize: () => {},
      close: () => port.close()
    }
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    s?.auto?.userInput(data)
    s?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(id)?.resize(cols, rows)
  }

  /** Closed by the user: logged as a normal end, never reconnected. */
  close(id: string): void {
    const s = this.sessions.get(id)
    s?.auto?.dispose()
    this.sessions.delete(id)
    this.logs.get(id)?.end('closed', true)
    this.logs.delete(id)
    s?.close()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  static async serialPorts(): Promise<SerialPortInfo[]> {
    const ports = await SerialPort.list()
    return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer }))
  }
}
