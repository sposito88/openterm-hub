import { create } from 'zustand'
import type {
  CredentialPrompt,
  ForwardStatus,
  HostKeyPrompt,
  SessionTarget,
  Snapshot,
  TransferProgress
} from '@shared/types'
import { api, errorMessage } from './api'
import { translate } from './i18n'

export type View = 'hosts' | 'keys' | 'forwards' | 'snippets' | 'knownHosts' | 'logs' | 'settings'
export type SettingsSection = 'terminal' | 'appearance' | 'sftp' | 'shortcuts' | 'logs' | 'backup' | 'about'

export interface Tab {
  id: string
  kind: 'terminal' | 'sftp'
  title: string
  target: SessionTarget
}

interface Toast {
  id: number
  text: string
  error?: boolean
}

interface AppState {
  snapshot: Snapshot | null
  view: View
  settingsSection: SettingsSection
  /** The OS prefers a light theme (used when the theme setting is "system"). */
  systemLight: boolean
  tabs: Tab[]
  /** null = the vault (hosts, keys, …) is shown instead of a tab. */
  activeTab: string | null
  lastTerminal: string | null
  forwardStatus: Record<string, ForwardStatus>
  transfers: Record<string, TransferProgress>
  hostKeyPrompts: HostKeyPrompt[]
  credentialPrompts: CredentialPrompt[]
  toasts: Toast[]
  refresh(): Promise<void>
  setView(v: View): void
  openSettings(section: SettingsSection): void
  openTab(kind: Tab['kind'], title: string, target: SessionTarget): void
  closeTab(id: string): void
  activate(id: string | null): void
  renameTab(id: string, title: string): void
  toast(text: string, error?: boolean): void
}

let tabSeq = 0
let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  view: 'hosts',
  settingsSection: 'terminal',
  systemLight: window.matchMedia('(prefers-color-scheme: light)').matches,
  tabs: [],
  activeTab: null,
  lastTerminal: null,
  forwardStatus: {},
  transfers: {},
  hostKeyPrompts: [],
  credentialPrompts: [],
  toasts: [],

  refresh: async () => set({ snapshot: await api.getSnapshot() }),
  setView: (view) => set({ view, activeTab: null }),
  openSettings: (settingsSection) => set({ view: 'settings', settingsSection, activeTab: null }),

  openTab: (kind, title, target) => {
    const id = `tab-${++tabSeq}`
    set((s) => ({
      tabs: [...s.tabs, { id, kind, title, target }],
      activeTab: id,
      lastTerminal: kind === 'terminal' ? id : s.lastTerminal
    }))
  },

  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTab = s.activeTab === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTab
      const lastTerminal = s.lastTerminal === id ? (tabs.filter((t) => t.kind === 'terminal').pop()?.id ?? null) : s.lastTerminal
      return { tabs, activeTab, lastTerminal }
    })
  },

  activate: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    set((s) => ({ activeTab: id, lastTerminal: tab?.kind === 'terminal' ? tab.id : s.lastTerminal }))
  },

  renameTab: (id, title) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  toast: (text, error) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, text, error }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), error ? 7000 : 3500)
  }
}))

/** Runs an async action and reports failures as an error toast. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    useApp.getState().toast(errorMessage(err), true)
    return undefined
  }
}

/** Whether the UI is currently light, resolving the "system" theme. */
export function useUiLight(): boolean {
  return useApp((s) => (s.snapshot?.settings.theme === 'system' ? s.systemLight : s.snapshot?.settings.theme === 'light'))
}

export function wireEvents(): void {
  window
    .matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', (e) => useApp.setState({ systemLight: e.matches }))
  api.onNotice((text) => useApp.getState().toast(text))
  api.onSftpSynced((name, error) => {
    if (error) useApp.getState().toast(`${name}: ${error}`, true)
    else useApp.getState().toast(`${name}: ${translate('synced')}`)
  })
  api.onSnapshotChanged(() => void useApp.getState().refresh())
  api.onForwardStatus((st) => useApp.setState((s) => ({ forwardStatus: { ...s.forwardStatus, [st.ruleId]: st } })))
  api.onTransferProgress((p) => useApp.setState((s) => ({ transfers: { ...s.transfers, [p.transferId]: p } })))
  api.onHostKeyPrompt((p) => useApp.setState((s) => ({ hostKeyPrompts: [...s.hostKeyPrompts, p] })))
  api.onCredentialPrompt((p) => useApp.setState((s) => ({ credentialPrompts: [...s.credentialPrompts, p] })))
  api.onPromptCancel((id) =>
    useApp.setState((s) => ({
      hostKeyPrompts: s.hostKeyPrompts.filter((p) => p.promptId !== id),
      credentialPrompts: s.credentialPrompts.filter((p) => p.promptId !== id)
    }))
  )
  void api.forwardStatuses().then((list) =>
    useApp.setState({ forwardStatus: Object.fromEntries(list.map((st) => [st.ruleId, st])) })
  )
}
