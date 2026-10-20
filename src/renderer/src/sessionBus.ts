import { api } from './api'

interface Handlers {
  data(chunk: string): void
  exit(reason: string): void
}

const handlers = new Map<string, Handlers>()
// Output can arrive before openSession() resolves, so it is held until a handler registers.
const early = new Map<string, Array<['data' | 'exit', string]>>()

function dispatch(id: string, kind: 'data' | 'exit', payload: string): void {
  const h = handlers.get(id)
  if (h) h[kind](payload)
  else {
    const q = early.get(id) ?? []
    q.push([kind, payload])
    early.set(id, q)
  }
}

api.onSessionData((id, data) => dispatch(id, 'data', data))
api.onSessionExit((id, reason) => dispatch(id, 'exit', reason))

export function subscribe(id: string, h: Handlers): () => void {
  handlers.set(id, h)
  for (const [kind, payload] of early.get(id) ?? []) h[kind](payload)
  early.delete(id)
  return () => {
    handlers.delete(id)
    early.delete(id)
  }
}

/** Tab id → session id, so other views (snippets) can type into a terminal. */
export const tabSessions = new Map<string, string>()

/** What keyboard shortcuts can do to a terminal tab. */
export interface TerminalActions {
  copy(): void
  paste(): void
  selectAll(): void
  find(): void
}

/** Tab id → actions of its terminal (only terminal tabs register). */
export const terminalActions = new Map<string, TerminalActions>()
