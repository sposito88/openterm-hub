import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandHistory } from '@shared/types'

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

export interface ShellHistory {
  /** Oldest first, without duplicates or multi-line entries (not useful as suggestions). */
  commands: string[]
  /** How many times each command appears in the files (the shells keep repeats). */
  counts: Map<string, number>
}

/** Commands from the local shells' history files (bash, zsh, fish). */
export async function loadShellHistory(home = homedir()): Promise<ShellHistory> {
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
  const counts = new Map<string, number>()
  for (const raw of all) {
    const cmd = raw.trim()
    if (cmd && !cmd.includes('\n')) counts.set(cmd, (counts.get(cmd) ?? 0) + 1)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = all.length - 1; i >= 0 && out.length < MAX_LINES; i--) {
    const cmd = all[i].trim()
    if (!cmd || cmd.includes('\n') || seen.has(cmd)) continue
    seen.add(cmd)
    out.push(cmd)
  }
  return { commands: out.reverse(), counts }
}

/** Too short or too common to be worth a snippet. */
const TRIVIAL = new Set(['ls', 'll', 'la', 'l', 'cd', 'cd ..', 'cd ~', 'clear', 'cls', 'exit', 'pwd', 'history', 'top', 'htop', 'whoami'])

/**
 * The history panel's data: commands typed in the app (most recent first),
 * then the shells' own, and the most used ones across both, which are offered
 * as snippets. Hidden commands (removed by the user) never show up.
 */
export function historyOverview(
  app: string[],
  appCounts: Record<string, number>,
  shell: ShellHistory,
  hidden: ReadonlySet<string>,
  limit = 500
): CommandHistory {
  const recent: string[] = []
  const seen = new Set<string>()
  for (const list of [app, shell.commands]) {
    for (let i = list.length - 1; i >= 0 && recent.length < limit; i--) {
      const cmd = list[i]
      if (seen.has(cmd) || hidden.has(cmd)) continue
      seen.add(cmd)
      recent.push(cmd)
    }
  }
  const counts = new Map(shell.counts)
  for (const [cmd, n] of Object.entries(appCounts)) counts.set(cmd, (counts.get(cmd) ?? 0) + n)
  const frequent = [...counts]
    .filter(([cmd, n]) => n >= 2 && !hidden.has(cmd) && !TRIVIAL.has(cmd) && cmd.length >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([command, count]) => ({ command, count }))
  return { recent, frequent }
}
