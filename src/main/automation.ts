/**
 * Answers prompts in a terminal session's output: the host's login sequence
 * ("when X shows up, type Y") and, when enabled, sudo's password prompt.
 * Runs in the main process, so saved passwords never reach the renderer.
 */

export interface AutoStep {
  expect: string
  /** Already resolved: {{password}} and secret answers filled in. */
  send: string
}

export interface AutoOptions {
  steps: AutoStep[]
  /** Answer sudo's prompt with this password (undefined = off). */
  sudoPassword?: string
  write(data: string): void
  /** The sequence ended: ok = every step ran, otherwise why it stopped. */
  onStepsDone?(ok: boolean, reason?: string): void
  notice?(text: string): void
  stepTimeoutMs?: number
}

// CSI / OSC / charset escapes: the prompt text is matched without colours and titles.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g
/** "[sudo] password for ana:" and its translations ("[sudo] senha para ana:"). */
export const SUDO_PROMPT_RE = /\[sudo\][^\r\n]*:\s*$/i
const SUDO_FAILED_RE = /sorry, try again|incorrect password|tente novamente|senha incorreta/i
/** A command line that runs sudo (not text that merely mentions "[sudo]"). */
export const SUDO_COMMAND_RE = /(^|[\s;&|(`$])sudo(\s|$)/
const TAIL = 4096
const ARM_MS = 10_000

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** Plain text matches case-insensitively anywhere; /re/flags is a regular expression. */
export function stepMatcher(expect: string): (text: string) => number {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(expect.trim())
  if (re) {
    let rx: RegExp
    try {
      rx = new RegExp(re[1], re[2].replace(/[gy]/g, ''))
    } catch {
      throw new Error(`Expressão regular inválida: ${expect}`)
    }
    return (text) => {
      const m = rx.exec(text)
      return m ? m.index + m[0].length : -1
    }
  }
  const needle = expect.toLowerCase()
  return (text) => {
    const i = text.toLowerCase().indexOf(needle)
    return i < 0 ? -1 : i + needle.length
  }
}

export class Autoresponder {
  private buf = ''
  private step = 0
  private matchers: Array<(text: string) => number>
  private timer: ReturnType<typeof setTimeout> | undefined
  private sudoSent = false
  private sudoOff = false
  /**
   * sudo is answered only shortly after a command that runs sudo was sent, so
   * output that merely looks like its prompt (echo, cat of a file) never gets the password.
   */
  private armedUntil = 0
  /** The terminal line being edited, as echoed by the shell (also shows commands recalled with ↑). */
  private screenLine = ''
  private started = false
  private disposed = false

  constructor(private o: AutoOptions) {
    this.matchers = o.steps.map((s) => stepMatcher(s.expect))
  }

  /** Called once the session can be written to; output fed before is kept and checked now. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    if (this.o.steps.length) this.arm()
    else this.finish(true)
    this.process()
  }

  private get running(): boolean {
    return this.step < this.o.steps.length
  }

  private arm(): void {
    clearTimeout(this.timer)
    const n = this.step
    this.timer = setTimeout(() => {
      const s = this.o.steps[n]
      this.step = this.o.steps.length
      this.finish(false, `Sequência de login parou no passo ${n + 1}: "${s.expect}" não apareceu`)
    }, this.o.stepTimeoutMs ?? 20_000)
  }

  private finish(ok: boolean, reason?: string): void {
    clearTimeout(this.timer)
    if (this.disposed) return
    this.o.onStepsDone?.(ok, reason)
    this.o.onStepsDone = undefined
  }

  feed(chunk: string): void {
    if (this.disposed) return
    const text = stripAnsi(chunk)
    this.buf = (this.buf + text).slice(-TAIL)
    this.screenLine = (this.screenLine + text).split('\n').pop()!.slice(-TAIL)
    if (this.started) this.process()
  }

  private process(): void {
    // An empty "expect" waits for the first output, not for nothing.
    while (this.running && this.buf) {
      const end = this.matchers[this.step](this.buf)
      if (end < 0) return
      // Only what came after the match can satisfy the next step.
      this.buf = this.buf.slice(end)
      const send = this.o.steps[this.step].send
      this.o.write(send + '\r')
      this.armedUntil = SUDO_COMMAND_RE.test(send) ? Date.now() + ARM_MS : 0
      this.step++
      if (this.running) this.arm()
      else this.finish(true)
    }
    this.sudo()
  }

  private sudo(): void {
    if (this.o.sudoPassword === undefined || this.sudoOff || !SUDO_PROMPT_RE.test(this.buf)) return
    // A second prompt right after ours means the password was refused: stop, never loop.
    if (this.sudoSent && SUDO_FAILED_RE.test(this.buf)) {
      this.sudoOff = true
      this.o.notice?.('Senha do sudo recusada: digite-a manualmente / sudo password refused: type it yourself')
      return
    }
    if (Date.now() > this.armedUntil) return
    this.armedUntil = 0
    this.sudoSent = true
    this.buf = ''
    this.o.write(this.o.sudoPassword + '\r')
  }

  /** The user ran a command: when it runs sudo, its prompt may follow (a new one, not a retry of ours). */
  userInput(data: string): void {
    const enter = data.search(/[\r\n]/)
    if (enter < 0) return
    // Typed text is echoed back later; pasted or snippet text carries the command itself.
    const command = this.screenLine + '\n' + data.slice(0, enter)
    this.sudoSent = false
    this.armedUntil = SUDO_COMMAND_RE.test(command) ? Date.now() + ARM_MS : 0
    this.buf = ''
    this.screenLine = ''
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
  }
}
