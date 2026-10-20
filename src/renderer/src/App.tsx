import { useEffect, useState } from 'react'
import { comboFromEvent, resolveShortcuts, type ShortcutAction } from '@shared/shortcuts'
import { api } from './api'
import { Icon, type IconName } from './components/Icon'
import { Prompts } from './components/Prompts'
import { translate, useT, type TKey } from './i18n'
import { terminalActions } from './sessionBus'
import { attempt, useApp, useUiLight, wireEvents, type View } from './state'
import { Forwards } from './views/Forwards'
import { Hosts, openLocal, openSftp } from './views/Hosts'
import { Keys } from './views/Keys'
import { Logs } from './views/Logs'
import { KnownHosts, Settings, shortcutRecording } from './views/Settings'
import { SftpTab } from './views/SftpTab'
import { Snippets } from './views/Snippets'
import { TerminalTab } from './views/TerminalTab'

const NAV: Array<{ view: View; icon: IconName; label: TKey }> = [
  { view: 'hosts', icon: 'server', label: 'hosts' },
  { view: 'keys', icon: 'key', label: 'keys' },
  { view: 'forwards', icon: 'tunnel', label: 'forwards' },
  { view: 'snippets', icon: 'code', label: 'snippets' },
  { view: 'knownHosts', icon: 'shield', label: 'knownHosts' },
  { view: 'logs', icon: 'clock', label: 'logs' }
]

const VIEWS: Record<View, () => React.JSX.Element> = {
  hosts: Hosts,
  keys: Keys,
  forwards: Forwards,
  snippets: Snippets,
  knownHosts: KnownHosts,
  logs: Logs,
  settings: Settings
}

wireEvents()

/** Runs a keyboard shortcut action. Returns false when it does not apply right now. */
function runAction(action: ShortcutAction): boolean {
  const s = useApp.getState()
  const settings = s.snapshot!.settings
  const ids: Array<string | null> = [null, ...s.tabs.map((x) => x.id)]
  const current = s.tabs.find((x) => x.id === s.activeTab)
  const term = s.activeTab ? terminalActions.get(s.activeTab) : undefined
  const fontSize = (n: number): void => void attempt(() => api.saveSettings({ fontSize: Math.min(32, Math.max(8, n)) }))

  if (action.startsWith('tab')) {
    const n = Number(action.slice(3))
    if (!s.tabs[n - 1]) return false
    s.activate(s.tabs[n - 1].id)
    return true
  }
  switch (action) {
    case 'nextTab':
    case 'prevTab': {
      const i = ids.indexOf(s.activeTab)
      s.activate(ids[(i + (action === 'nextTab' ? 1 : ids.length - 1)) % ids.length])
      return true
    }
    case 'closeTab':
      if (!s.activeTab) return false
      s.closeTab(s.activeTab)
      return true
    case 'copy':
    case 'paste':
    case 'selectAll':
    case 'find':
      if (!term) return false
      term[action]()
      return true
    case 'fontBigger':
      fontSize(settings.fontSize + 1)
      return true
    case 'fontSmaller':
      fontSize(settings.fontSize - 1)
      return true
    case 'fontReset':
      fontSize(14)
      return true
    case 'openHosts':
      s.setView('hosts')
      return true
    case 'localTerminal':
      openLocal()
      return true
    case 'serial':
      s.setView('hosts')
      window.dispatchEvent(new Event('openterm:serial'))
      return true
    case 'portForwarding':
      s.setView('forwards')
      return true
    case 'snippets':
      s.setView('snippets')
      return true
    case 'sftp': {
      const host = current?.target.kind === 'host' ? s.snapshot!.hosts.find((h) => h.id === (current.target as { hostId: string }).hostId) : undefined
      if (host?.protocol !== 'ssh') return false
      openSftp(host)
      return true
    }
    case 'settings':
      s.openSettings('terminal')
      return true
  }
  return false
}

function SftpPicker({ onClose }: { onClose(): void }) {
  const t = useT()
  const hosts = useApp((s) => s.snapshot!.hosts).filter((h) => h.protocol === 'ssh')
  return (
    <div className="menu" style={{ left: 0, top: 36 }} onMouseLeave={onClose}>
      <div className="dim" style={{ padding: '4px 10px', fontSize: 11 }}>
        {hosts.length ? t('chooseHost') : t('noSshHosts')}
      </div>
      {hosts.map((h) => (
        <button
          key={h.id}
          onClick={() => {
            onClose()
            openSftp(h)
          }}
        >
          {h.label}
        </button>
      ))}
    </div>
  )
}

export function App() {
  const t = useT()
  const snapshot = useApp((s) => s.snapshot)
  const uiLight = useUiLight()
  const { view, tabs, activeTab, toasts, setView, activate, closeTab } = useApp()
  const [sftpPicker, setSftpPicker] = useState(false)

  useEffect(() => {
    void useApp.getState().refresh()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = uiLight ? 'light' : 'dark'
    document.documentElement.lang = snapshot?.settings.language === 'en' ? 'en' : 'pt-BR'
  }, [uiLight, snapshot?.settings.language])

  // Global shortcuts run in the capture phase, before the terminal sees the keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const settings = useApp.getState().snapshot?.settings
      if (!settings || shortcutRecording.active) return
      const combo = comboFromEvent(e)
      if (!combo) return
      if (combo === 'Ctrl+Tab' || combo === 'Ctrl+Shift+Tab') {
        e.preventDefault()
        runAction(combo === 'Ctrl+Tab' ? 'nextTab' : 'prevTab')
        return
      }
      const map = resolveShortcuts(settings.shortcuts)
      const action = (Object.keys(map) as ShortcutAction[]).find((a) => map[a] === combo)
      if (action && runAction(action)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!snapshot) return null
  const Page = VIEWS[view]

  return (
    <div className="app">
      <div className="brand">
        <div className="brand-mark">&gt;_</div>
        OpenTerm Hub
      </div>
      <div className="tabbar">
        <button className={`tab ${activeTab === null ? 'active' : ''}`} onClick={() => activate(null)}>
          <Icon name="server" />
          <span>{t('vault')}</span>
        </button>
        <div style={{ position: 'relative', display: 'flex' }}>
          <button className="tab" onClick={() => setSftpPicker(!sftpPicker)} title={translate('chooseHost')}>
            <Icon name="folder" />
            <span>SFTP</span>
          </button>
          {sftpPicker && <SftpPicker onClose={() => setSftpPicker(false)} />}
        </div>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => activate(tab.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
            role="tab"
          >
            <Icon name={tab.kind === 'sftp' ? 'folder' : 'terminal'} />
            <span>{tab.title}</span>
            <button
              className="tab-close"
              title={t('close')}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>

      <nav className="sidebar">
        {NAV.map((n) => (
          <button key={n.view} className={`nav-item ${activeTab === null && view === n.view ? 'active' : ''}`} onClick={() => setView(n.view)}>
            <Icon name={n.icon} /> {t(n.label)}
          </button>
        ))}
        <div className="nav-spacer" />
        <button className={`nav-item ${activeTab === null && view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
          <Icon name="gear" /> {t('settings')}
        </button>
      </nav>

      <main className="content">
        <div className="pane" hidden={activeTab !== null}>
          <Page />
        </div>
        {tabs.map((tab) => (
          <div key={tab.id} className="pane" hidden={activeTab !== tab.id}>
            {tab.kind === 'terminal' ? <TerminalTab tab={tab} active={activeTab === tab.id} /> : <SftpTab tab={tab} />}
          </div>
        ))}
      </main>

      <Prompts />
      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.error ? 'error' : ''}`}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  )
}
