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
import { Identities } from './views/Identities'
import { Keys } from './views/Keys'
import { Logs } from './views/Logs'
import { KnownHosts, Settings, shortcutRecording } from './views/Settings'
import { SftpTab } from './views/SftpTab'
import { Snippets } from './views/Snippets'
import { TerminalTab } from './views/TerminalTab'
import { Workspaces } from './views/Workspaces'
import { WorkspaceTab } from './views/WorkspaceTab'
import { findTerminalTheme, TERMINAL_THEMES } from './terminalThemes'

const NAV: Array<{ view: View; icon: IconName; label: TKey }> = [
  { view: 'hosts', icon: 'server', label: 'hosts' },
  { view: 'keys', icon: 'key', label: 'keys' },
  { view: 'identities', icon: 'user', label: 'identities' },
  { view: 'workspaces', icon: 'workspace', label: 'workspaces' },
  { view: 'forwards', icon: 'tunnel', label: 'forwards' },
  { view: 'snippets', icon: 'code', label: 'snippets' },
  { view: 'knownHosts', icon: 'shield', label: 'knownHosts' },
  { view: 'logs', icon: 'clock', label: 'logs' }
]

const VIEWS: Record<View, () => React.JSX.Element> = {
  hosts: Hosts,
  identities: Identities,
  workspaces: Workspaces,
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

export function App() {
  const t = useT()
  const snapshot = useApp((s) => s.snapshot)
  const uiLight = useUiLight()
  const { view, tabs, activeTab, toasts, setView, activate, closeTab, openTab, mergeTabs, duplicateTab, splitTab, renameTab, setTabTheme, closeOtherTabs } = useApp()
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropZone, setDropZone] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null)
  const [tabContextMenu, setTabContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [themeSubmenu, setThemeSubmenu] = useState(false)

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
        <button className="tab" onClick={() => openTab('sftp', 'SFTP', { kind: 'local' })} title={translate('newSftpTab')}>
          <Icon name="folder" />
          <span>SFTP</span>
        </button>
        {tabs.map((tab) => {
          const host = tab.target.kind === 'host' ? snapshot?.hosts.find((h) => h.id === (tab.target as { hostId: string }).hostId) : undefined
          const themeId = tab.themeOverride ?? host?.theme
          const themeObj = themeId ? findTerminalTheme(themeId, uiLight) : null

          return (
            <div
              key={tab.id}
              className={`tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => activate(tab.id)}
              onDoubleClick={() => {
                const newTitle = window.prompt(t('renameTab'), tab.title)
                if (newTitle && newTitle.trim()) renameTab(tab.id, newTitle.trim())
              }}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setTabContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
                setThemeSubmenu(false)
              }}
              role="tab"
              draggable={tab.kind === 'terminal' || tab.kind === 'workspace'}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/openterm-tab', tab.id)
                e.dataTransfer.effectAllowed = 'move'
                setDraggingTabId(tab.id)
              }}
              onDragEnd={() => {
                setDraggingTabId(null)
                setDropZone(null)
              }}
              onDragOver={(e) => {
                if (draggingTabId && draggingTabId !== tab.id) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                const srcId = e.dataTransfer.getData('text/openterm-tab')
                if (srcId && srcId !== tab.id) {
                  mergeTabs(srcId, tab.id, 'horizontal')
                }
                setDraggingTabId(null)
                setDropZone(null)
              }}
            >
              {themeObj && (
                <span
                  className="tab-theme-dot"
                  style={{ backgroundColor: themeObj.colors.cursor || themeObj.colors.background }}
                  title={`${t('terminalTheme')}: ${themeObj.name}`}
                />
              )}
              <Icon name={tab.kind === 'sftp' ? 'folder' : tab.kind === 'workspace' ? 'workspace' : 'terminal'} />
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
          )
        })}
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
            {tab.kind === 'terminal' ? (
              <TerminalTab tab={tab} active={activeTab === tab.id} />
            ) : tab.kind === 'workspace' ? (
              <WorkspaceTab tab={tab} active={activeTab === tab.id} />
            ) : (
              <SftpTab tab={tab} />
            )}
          </div>
        ))}
        {draggingTabId && activeTab && activeTab !== draggingTabId && (
          <div
            className="workspace-drop-overlay"
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left) / rect.width
              const y = (e.clientY - rect.top) / rect.height
              if (x < 0.35) setDropZone('left')
              else if (x > 0.65) setDropZone('right')
              else if (y < 0.5) setDropZone('top')
              else setDropZone('bottom')
            }}
            onDragLeave={() => setDropZone(null)}
            onDrop={(e) => {
              e.preventDefault()
              const srcId = e.dataTransfer.getData('text/openterm-tab')
              if (srcId && activeTab && srcId !== activeTab) {
                const dir = dropZone === 'top' || dropZone === 'bottom' ? 'vertical' : 'horizontal'
                mergeTabs(srcId, activeTab, dir)
              }
              setDraggingTabId(null)
              setDropZone(null)
            }}
          >
            <div className={`drop-zone-quadrant left ${dropZone === 'left' ? 'hover' : ''}`}>
              <span>{t('splitHorizontal')} (←)</span>
            </div>
            <div className={`drop-zone-quadrant right ${dropZone === 'right' ? 'hover' : ''}`}>
              <span>{t('splitHorizontal')} (→)</span>
            </div>
            <div className={`drop-zone-quadrant top ${dropZone === 'top' ? 'hover' : ''}`}>
              <span>{t('splitVertical')} (↑)</span>
            </div>
            <div className={`drop-zone-quadrant bottom ${dropZone === 'bottom' ? 'hover' : ''}`}>
              <span>{t('splitVertical')} (↓)</span>
            </div>
          </div>
        )}
      </main>

      {tabContextMenu && (() => {
        const targetTab = tabs.find((t) => t.id === tabContextMenu.tabId)
        if (!targetTab) return null
        const host = targetTab.target.kind === 'host' ? snapshot?.hosts.find((h) => h.id === (targetTab.target as { hostId: string }).hostId) : undefined
        const activeThemeId = targetTab.themeOverride ?? host?.theme ?? snapshot?.settings.terminalTheme
        const isTerminalLike = targetTab.kind === 'terminal' || targetTab.kind === 'workspace'

        return (
          <div
            className="menu context-menu"
            style={{ position: 'fixed', left: Math.min(tabContextMenu.x, window.innerWidth - 240), top: tabContextMenu.y, zIndex: 120 }}
            onMouseLeave={() => {
              setTabContextMenu(null)
              setThemeSubmenu(false)
            }}
          >
            <button
              onClick={() => {
                duplicateTab(targetTab.id)
                setTabContextMenu(null)
              }}
            >
              <Icon name="copy" size={14} /> {t('duplicate')}
            </button>
            <button
              onClick={() => {
                setTabContextMenu(null)
                const newTitle = window.prompt(t('renameTab'), targetTab.title)
                if (newTitle && newTitle.trim()) renameTab(targetTab.id, newTitle.trim())
              }}
            >
              <Icon name="edit" size={14} /> {t('rename')}
            </button>

            {isTerminalLike && (
              <>
                <button
                  onClick={() => {
                    splitTab(targetTab.id, 'horizontal', targetTab.target, targetTab.title)
                    setTabContextMenu(null)
                  }}
                >
                  <Icon name="splitHorizontal" size={14} /> {t('splitHorizontal')}
                </button>
                <button
                  onClick={() => {
                    splitTab(targetTab.id, 'vertical', targetTab.target, targetTab.title)
                    setTabContextMenu(null)
                  }}
                >
                  <Icon name="splitVertical" size={14} /> {t('splitVertical')}
                </button>
                <hr />
                <button
                  onClick={() => setThemeSubmenu(!themeSubmenu)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="palette" size={14} /> {t('sessionTheme')}
                  </span>
                  <span>{themeSubmenu ? '▴' : '▾'}</span>
                </button>
                {themeSubmenu && (
                  <div style={{ paddingLeft: 8, maxHeight: 180, overflowY: 'auto' }}>
                    <button
                      className={!targetTab.themeOverride ? 'active' : ''}
                      onClick={() => {
                        setTabTheme(targetTab.id, undefined)
                        setTabContextMenu(null)
                        setThemeSubmenu(false)
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: findTerminalTheme(host?.theme ?? snapshot?.settings.terminalTheme ?? 'auto', uiLight).colors.background, border: '1px solid var(--border)' }} />
                      <span>{t('defaultTheme')}</span>
                      {!targetTab.themeOverride && <span style={{ marginLeft: 'auto' }}>✓</span>}
                    </button>
                    {TERMINAL_THEMES.map((th) => (
                      <button
                        key={th.id}
                        className={activeThemeId === th.id ? 'active' : ''}
                        onClick={() => {
                          setTabTheme(targetTab.id, th.id)
                          setTabContextMenu(null)
                          setThemeSubmenu(false)
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                      >
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: th.colors.background, border: '1px solid var(--border)' }} />
                        <span>{th.name}</span>
                        {activeThemeId === th.id && <span style={{ marginLeft: 'auto' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            <hr />
            <button
              onClick={() => {
                closeTab(targetTab.id)
                setTabContextMenu(null)
              }}
            >
              <Icon name="x" size={14} /> {t('close')}
            </button>
            {tabs.length > 1 && (
              <button
                onClick={() => {
                  closeOtherTabs(targetTab.id)
                  setTabContextMenu(null)
                }}
              >
                <Icon name="x" size={14} /> {t('closeOtherTabs')}
              </button>
            )}
          </div>
        )
      })()}

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
