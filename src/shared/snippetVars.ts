import type { SnippetVariable } from './types'

/**
 * Snippet variables: {{host}}, {{label}}, {{user}}, {{port}}, {{date}}, {{time}},
 * global ones from Settings ({{name}}) and {{ask:Question}} / {{ask:Question=default}},
 * asked when the snippet runs. Anything else between braces is left untouched, so
 * templates of other tools keep working: docker ps --format '{{.Names}}'.
 */

const VAR_RE = /\{\{\s*([A-Za-z_][\w-]*)(?::([^}]*))?\s*\}\}/g

export const BUILTIN_VARIABLES = ['host', 'label', 'user', 'port', 'date', 'time'] as const

export interface SnippetContext {
  host?: string
  label?: string
  user?: string
  port?: number
  now?: Date
  variables?: SnippetVariable[]
}

export interface AskField {
  question: string
  default: string
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function values(ctx: SnippetContext): Map<string, string> {
  const now = ctx.now ?? new Date()
  const map = new Map<string, string>()
  // Globals first: a built-in with the same name wins.
  for (const v of ctx.variables ?? []) if (v.name.trim()) map.set(v.name.trim(), v.value)
  if (ctx.host !== undefined) map.set('host', ctx.host)
  if (ctx.label !== undefined) map.set('label', ctx.label)
  if (ctx.user !== undefined) map.set('user', ctx.user)
  if (ctx.port !== undefined) map.set('port', String(ctx.port))
  map.set('date', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
  map.set('time', `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
  return map
}

function splitAsk(arg: string): AskField {
  const i = arg.indexOf('=')
  return i < 0 ? { question: arg.trim(), default: '' } : { question: arg.slice(0, i).trim(), default: arg.slice(i + 1).trim() }
}

/** Questions of the {{ask:…}} variables, once each, in order of appearance. */
export function askFields(script: string): AskField[] {
  const seen = new Map<string, AskField>()
  for (const m of script.matchAll(VAR_RE)) {
    if (m[1] !== 'ask' || m[2] === undefined) continue
    const f = splitAsk(m[2])
    if (f.question && !seen.has(f.question)) seen.set(f.question, f)
  }
  return [...seen.values()]
}

/** Fills the variables; answers holds the reply to each ask question. */
export function expandSnippet(script: string, ctx: SnippetContext, answers: Record<string, string> = {}): string {
  const map = values(ctx)
  return script.replace(VAR_RE, (whole, name: string, arg: string | undefined) => {
    if (name === 'ask' && arg !== undefined) {
      const f = splitAsk(arg)
      return answers[f.question] ?? f.default
    }
    if (arg !== undefined) return whole
    return map.get(name) ?? whole
  })
}
