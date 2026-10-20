import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_LINES = 5000

/** bash: one command per line; "#1700000000" timestamp lines are skipped. */
export function parseBash(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() && !/^#\d+$/.test(l))
}

/** zsh: plain lines, or EXTENDED_HISTORY ": 1700000000:0;command"; "\" ends a continued line. */
export function parseZsh(text: string): string[] {
  const out: string[] = []
  let pending = ''
  for (const raw of text.split('\n')) {
    const line = pending ? raw : raw.replace(/^: \d+:\d+;/, '')
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1) + '\n'
      continue
    }
    const cmd = pending + line
    pending = ''
    if (cmd.trim()) out.push(cmd)
  }
  return out
}

/** fish: YAML-like "- cmd: command" entries with "\n" and "\\" escapes. */
export function parseFish(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^- cmd: (.*)$/gm)) {
    out.push(m[1].replace(/\\\\|\\n/g, (e) => (e === '\\n' ? '\n' : '\\')))
  }
  return out
}

/**
 * Commands from the local shells' history files, oldest first, without
 * duplicates or multi-line entries (those are not useful as suggestions).
 */
export async function loadShellHistory(home = homedir()): Promise<string[]> {
  const sources: Array<[string, (t: string) => string[]]> = [
    [join(home, '.bash_history'), parseBash],
    [join(home, '.zsh_history'), parseZsh],
    [join(home, '.local/share/fish/fish_history'), parseFish]
  ]
  const all: string[] = []
  for (const [file, parse] of sources) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (text) all.push(...parse(text))
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = all.length - 1; i >= 0 && out.length < MAX_LINES; i--) {
    const cmd = all[i].trim()
    if (!cmd || cmd.includes('\n') || seen.has(cmd)) continue
    seen.add(cmd)
    out.push(cmd)
  }
  return out.reverse()
}
