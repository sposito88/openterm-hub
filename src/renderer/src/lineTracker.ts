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

interface XtermInternalLine {
  length: number
  isWrapped: boolean
  _data?: Uint32Array
  setCell(x: number, cell: unknown): void
}

interface XtermInternalBuffer {
  ybase: number
  y: number
  x: number
  getNullCell(): unknown
  lines: {
    length: number
    get(i: number): XtermInternalLine | undefined
  }
}

/**
 * Full-width curses/procps programs such as `top` pad every row with literal
 * ASCII spaces (0x20) out to the current terminal width instead of using `\x1b[K`.
 * When the window is later un-maximized or narrowed, xterm.js reflows those
 * trailing spaces onto continuation lines, producing blank lines between rows.
 * Converting trailing spaces back to null cells before resizing prevents that.
 */
export function trimTrailingSpaces(term: unknown): void {
  const buf = (term as { _core?: { _bufferService?: { buffer?: XtermInternalBuffer } } })?._core?._bufferService?.buffer
  if (!buf?.lines) return
  const nullCell = buf.getNullCell()
  const cursorLine = buf.ybase + buf.y
  for (let y = 0; y < buf.lines.length; y++) {
    // Only trim at the end of a logical line (not a line that wraps onto y + 1).
    if (y + 1 < buf.lines.length && buf.lines.get(y + 1)?.isWrapped) continue
    const line = buf.lines.get(y)
    if (!line?._data) continue
    const minCol = y === cursorLine ? buf.x : 0
    for (let x = line.length - 1; x >= minCol; x--) {
      const code = line._data[x * 3] & 0x3fffff
      if (code === 0) continue
      if (code === 0x20) {
        line.setCell(x, nullCell)
      } else {
        break
      }
    }
  }
}

