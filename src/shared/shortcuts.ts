/**
 * Keyboard shortcuts. Combos are strings such as "Ctrl+Shift+W" or
 * "Alt+ArrowRight": modifiers in the fixed order Ctrl, Alt, Shift, Meta,
 * then the key (letters upper case). Defaults avoid plain Ctrl+letter, which
 * shells use (Ctrl+N / Ctrl+P walk the history in readline).
 */
export const SHORTCUT_ACTIONS = [
  'tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6', 'tab7', 'tab8', 'tab9',
  'nextTab', 'prevTab', 'closeTab',
  'copy', 'paste', 'selectAll', 'find',
  'fontBigger', 'fontSmaller', 'fontReset',
  'openHosts', 'localTerminal', 'serial', 'portForwarding', 'snippets', 'sftp', 'settings',
  'toggleSidebar'
] as const

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  tab1: 'Ctrl+1',
  tab2: 'Ctrl+2',
  tab3: 'Ctrl+3',
  tab4: 'Ctrl+4',
  tab5: 'Ctrl+5',
  tab6: 'Ctrl+6',
  tab7: 'Ctrl+7',
  tab8: 'Ctrl+8',
  tab9: 'Ctrl+9',
  nextTab: 'Alt+ArrowRight',
  prevTab: 'Alt+ArrowLeft',
  closeTab: 'Ctrl+Shift+W',
  copy: 'Ctrl+Shift+C',
  paste: 'Ctrl+Shift+V',
  selectAll: 'Ctrl+Shift+A',
  find: 'Ctrl+Shift+F',
  fontBigger: 'Ctrl+=',
  fontSmaller: 'Ctrl+-',
  fontReset: 'Ctrl+0',
  openHosts: 'Ctrl+Shift+H',
  localTerminal: 'Ctrl+Shift+N',
  serial: 'Ctrl+Alt+S',
  portForwarding: 'Ctrl+Shift+P',
  snippets: 'Ctrl+Shift+S',
  sftp: 'Ctrl+Shift+O',
  settings: 'Ctrl+,',
  toggleSidebar: 'Ctrl+Shift+B'
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock'])

/** Combo string for a keyboard event, or null for a lone modifier key. */
export function comboFromEvent(ev: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  if (MODIFIER_KEYS.has(ev.key)) return null
  let key = ev.key
  // With Shift held, ev.key is the shifted symbol ("!" for 1); use the physical key instead.
  if (/^Digit\d$/.test(ev.code)) key = ev.code.slice(5)
  else if (/^Key[A-Z]$/.test(ev.code)) key = ev.code.slice(3)
  else if (key === ' ') key = 'Space'
  else if (key === '+') key = '='
  else if (key.length === 1) key = key.toUpperCase()
  const parts: string[] = []
  if (ev.ctrlKey) parts.push('Ctrl')
  if (ev.altKey) parts.push('Alt')
  if (ev.shiftKey) parts.push('Shift')
  if (ev.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

/** A combo is only accepted as a shortcut if it cannot be ordinary typing. */
export function isValidShortcut(combo: string): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (/^F\d{1,2}$/.test(key)) return true
  return mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta')
}

/**
 * macOS convention: Cmd (Meta) instead of Ctrl, and Cmd alone where Linux and
 * Windows terminals need Ctrl+Shift (Cmd+C is free there; Ctrl+C is SIGINT).
 */
export function defaultShortcuts(mac: boolean): Record<ShortcutAction, string> {
  if (!mac) return { ...DEFAULT_SHORTCUTS }
  const out = {} as Record<ShortcutAction, string>
  for (const a of SHORTCUT_ACTIONS) {
    const c = DEFAULT_SHORTCUTS[a]
    out[a] = c.startsWith('Ctrl+Shift+') && ['copy', 'paste', 'selectAll', 'find', 'closeTab'].includes(a)
      ? 'Meta+' + c.slice('Ctrl+Shift+'.length)
      : normalizeCombo(c.startsWith('Ctrl+Alt+') ? c.replace('Ctrl+Alt+', 'Ctrl+Meta+') : c.replace(/^Ctrl\+/, 'Meta+'))
  }
  // Option+arrows move by word in macOS shells, so tabs use Cmd+Shift+arrows.
  out.nextTab = 'Shift+Meta+ArrowRight'
  out.prevTab = 'Shift+Meta+ArrowLeft'
  return out
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta']

/** Puts modifiers in the order comboFromEvent produces. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+')
  const key = parts.pop()!
  return [...MODIFIER_ORDER.filter((m) => parts.includes(m)), key].join('+')
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

export function resolveShortcuts(custom: Record<string, string>, mac = IS_MAC): Record<ShortcutAction, string> {
  const out = defaultShortcuts(mac)
  for (const a of SHORTCUT_ACTIONS) if (a in custom) out[a] = custom[a]
  return out
}

/** Pretty label: "Ctrl+Shift+W" → ["Ctrl", "Shift", "W"], arrows as symbols. */
export function comboKeys(combo: string): string[] {
  const names: Record<string, string> = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Meta: IS_MAC ? '⌘' : 'Meta' }
  return combo ? combo.split('+').map((k) => names[k] ?? k) : []
}
