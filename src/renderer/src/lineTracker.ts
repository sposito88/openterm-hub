/**
 * Mirrors what the user is typing on the shell prompt, from the keystrokes
 * sent to the session. Anything that moves the cursor or lets the shell
 * rewrite the line (arrows, Tab completion, escape sequences) marks the
 * line as unknown until the next Enter / Ctrl+C.
 */
export class LineTracker {
  line = ''
  valid = true

  /** Returns the submitted line when the input contains Enter. */
  feed(data: string): string | undefined {
    if (data.startsWith('\x1b')) {
      this.valid = false
      return undefined
    }
    let submitted: string | undefined
    for (const c of data) {
      if (c === '\r' || c === '\n') {
        if (this.valid) submitted = this.line
        this.reset()
      } else if (c === '\x7f' || c === '\b') {
        this.line = this.line.slice(0, -1)
      } else if (c === '\x03' || c === '\x15' || c === '\x04') {
        this.reset()
      } else if (c === '\x17') {
        this.line = this.line.replace(/\S+\s*$/, '')
      } else if (c < ' ') {
        this.valid = false
      } else {
        this.line += c
      }
    }
    return submitted
  }

  reset(): void {
    this.line = ''
    this.valid = true
  }
}
