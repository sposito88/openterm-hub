import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, promises as fs, readFileSync, renameSync, writeFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry } from '@shared/types'

const MAX_ENTRIES = 500

export interface SessionLog {
  write(data: string): void
  end(result: string, ok: boolean): void
}

/**
 * Connection history (who, when, how it ended) and, when enabled, a
 * transcript of each session's output in logs/<id>.log.
 */
export class Logs {
  private index: string
  private entries: LogEntry[]

  constructor(
    private dir: string,
    private onChange: () => void
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.index = join(dir, 'index.json')
    try {
      this.entries = JSON.parse(readFileSync(this.index, 'utf8')) as LogEntry[]
    } catch {
      this.entries = []
    }
    // Sessions still open when the app last quit abruptly.
    for (const e of this.entries) {
      if (!e.endedAt && !e.result) {
        e.result = 'interrupted'
        e.ok = false
      }
    }
  }

  private save(): void {
    const tmp = `${this.index}.tmp`
    writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 })
    renameSync(tmp, this.index)
    this.onChange()
  }

  private transcriptPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Log inválido')
    return join(this.dir, `${id}.log`)
  }

  start(info: Pick<LogEntry, 'title' | 'target' | 'protocol'>, transcript: boolean): SessionLog {
    const entry: LogEntry = { ...info, id: randomUUID(), startedAt: new Date().toISOString(), ok: true, hasTranscript: transcript }
    this.entries.unshift(entry)
    for (const old of this.entries.splice(MAX_ENTRIES)) {
      if (old.hasTranscript) void fs.rm(this.transcriptPath(old.id), { force: true })
    }
    this.save()
    let stream: WriteStream | null = transcript ? createWriteStream(this.transcriptPath(entry.id), { flags: 'a', mode: 0o600 }) : null
    let ended = false
    return {
      write: (data) => stream?.write(data),
      end: (result, ok) => {
        if (ended) return
        ended = true
        stream?.end()
        stream = null
        entry.endedAt = new Date().toISOString()
        entry.result = result
        entry.ok = ok
        this.save()
      }
    }
  }

  list(): LogEntry[] {
    return this.entries
  }

  async read(id: string): Promise<string> {
    return fs.readFile(this.transcriptPath(id), 'utf8').catch(() => '')
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.transcriptPath(id), { force: true })
    this.entries = this.entries.filter((e) => e.id !== id)
    this.save()
  }

  async clear(): Promise<void> {
    for (const e of this.entries) await fs.rm(this.transcriptPath(e.id), { force: true })
    this.entries = []
    this.save()
  }
}
