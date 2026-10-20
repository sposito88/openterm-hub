import type { Snippet, Suggestion } from '@shared/types'

/** The parts of a Fig autocomplete spec (https://fig.io/docs) that we use. */
type Named = { name: string | string[]; description?: string }
export interface FigArg {
  isOptional?: boolean
  suggestions?: Array<string | Named>
}
export interface FigOption extends Named {
  args?: FigArg | FigArg[]
}
export interface FigSubcommand extends Named {
  subcommands?: FigSubcommand[]
  options?: FigOption[]
  args?: FigArg | FigArg[]
  loadSpec?: unknown
}

export interface SpecSource {
  commands: string[]
  load(name: string): Promise<FigSubcommand | null>
}

const MAX_SUGGESTIONS = 12
const MAX_HISTORY = 3

function names(n: Named): string[] {
  return Array.isArray(n.name) ? n.name : [n.name]
}

function argList(a: FigArg | FigArg[] | undefined): FigArg[] {
  return a ? (Array.isArray(a) ? a : [a]) : []
}

function short(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split('\n')[0]
  return line.length > 90 ? line.slice(0, 87) + '…' : line
}

/** Splits on whitespace while keeping quoted strings together. */
export function tokenize(line: string): string[] {
  const tokens: string[] = []
  const re = /"(?:[^"\\]|\\.)*"?|'[^']*'?|\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) tokens.push(m[0])
  return tokens
}

/** Only the last command of a pipeline / list is completed. */
export function lastSegment(line: string): string {
  const parts = line.split(/\|\||&&|[|;]/)
  return parts[parts.length - 1].replace(/^\s+/, '')
}

function prefixMatches<T extends Named>(items: T[] | undefined, partial: string): Array<{ item: T; name: string }> {
  const out: Array<{ item: T; name: string }> = []
  for (const item of items ?? []) {
    const name = names(item).find((n) => n.startsWith(partial) && n !== partial)
    if (name) out.push({ item, name })
  }
  return out
}

export async function suggest(
  line: string,
  source: SpecSource,
  history: string[],
  snippets: Snippet[]
): Promise<Suggestion[]> {
  if (!line.trim()) return []
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const push = (s: Suggestion): void => {
    if (out.length >= MAX_SUGGESTIONS || !s.insert || seen.has(s.label)) return
    seen.add(s.label)
    out.push(s)
  }

  for (let i = history.length - 1, n = 0; i >= 0 && n < MAX_HISTORY; i--) {
    const h = history[i]
    if (h.length > line.length && h.startsWith(line)) {
      push({ insert: h.slice(line.length), replaceLength: 0, label: h, source: 'history' })
      n++
    }
  }
  for (const s of snippets) {
    if (s.script.length > line.length && s.script.startsWith(line) && !s.script.includes('\n')) {
      push({ insert: s.script.slice(line.length), replaceLength: 0, label: s.script, description: s.label, source: 'snippet' })
    }
  }

  const segment = lastSegment(line)
  const tokens = tokenize(segment)
  const endsWithSpace = /\s$/.test(segment)
  const partial = endsWithSpace || tokens.length === 0 ? '' : tokens[tokens.length - 1]
  const done = endsWithSpace ? tokens : tokens.slice(0, -1)
  while (done[0] === 'sudo') done.shift()

  if (done.length === 0) {
    if (!partial) return out
    for (const cmd of source.commands) {
      if (cmd.startsWith(partial) && cmd !== partial && !cmd.includes('/')) {
        push({ insert: cmd.slice(partial.length) + ' ', replaceLength: 0, label: cmd, source: 'command' })
      }
    }
    return out
  }

  const root = await source.load(done[0])
  if (!root) return out
  let node: FigSubcommand = root
  for (let i = 1; i < done.length; i++) {
    const t = done[i]
    if (t.startsWith('-')) {
      const opt = node.options?.find((o) => names(o).some((n) => t === n))
      if (opt && argList(opt.args).some((a) => !a.isOptional)) i++
      continue
    }
    const sub: FigSubcommand | undefined = node.subcommands?.find((s) => names(s).includes(t))
    if (!sub) continue
    node = (typeof sub.loadSpec === 'string' ? await source.load(sub.loadSpec) : null) ?? sub
  }

  if (partial.startsWith('-')) {
    for (const { item, name } of prefixMatches(node.options, partial)) {
      push({ insert: name.slice(partial.length) + ' ', replaceLength: 0, label: name, description: short(item.description), source: 'option' })
    }
    return out
  }
  for (const { item, name } of prefixMatches(node.subcommands, partial)) {
    push({ insert: name.slice(partial.length) + ' ', replaceLength: 0, label: name, description: short(item.description), source: 'subcommand' })
  }
  for (const arg of argList(node.args)) {
    const named = (arg.suggestions ?? []).map((s) => (typeof s === 'string' ? { name: s } : s))
    for (const { item, name } of prefixMatches(named, partial)) {
      push({ insert: name.slice(partial.length) + ' ', replaceLength: 0, label: name, description: short(item.description), source: 'subcommand' })
    }
  }
  return out
}
