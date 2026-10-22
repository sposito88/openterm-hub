import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import type { SessionTarget, Settings, Suggestion } from '@shared/types'
import { api, errorMessage } from '../api'
import { Icon } from '../components/Icon'
import { ensureFontLoaded, fontStack } from '../fonts'
import { translate, useT } from '../i18n'
import { LineTracker, trimTrailingSpaces } from '../lineTracker'
import { subscribe, tabSessions, terminalActions } from '../sessionBus'
import { useApp, useUiLight, type Tab } from '../state'
import { findTerminalTheme, TERMINAL_THEMES } from '../terminalThemes'
import { openSftp } from './Hosts'
import { runSnippet } from './Snippets'

const SOURCE_LABEL: Record<Suggestion['source'], string> = {
  history: 'hist',
  snippet: 'snippet',
  command: 'cmd',
  subcommand: 'sub',
  option: 'opt'
}

/** Seconds to wait before each automatic reconnection attempt. */
const RECONNECT_DELAYS = [2, 4, 8, 15, 30]

interface Popup {
  items: Suggestion[]
  sel: number
  left: number
  top?: number
  bottom?: number
}

function termOptions(s: Settings, uiLight: boolean, activeThemeId?: string): ITerminalOptions {
  return {
    fontFamily: fontStack(s.fontFamily),
    fontSize: s.fontSize,
    wordSeparator: s.wordSeparator,
    // Wide glyphs from fallback fonts are squeezed into their cell instead of overlapping.
    rescaleOverlappingGlyphs: true,
    cursorStyle: s.cursorStyle,
    scrollback: s.scrollback,
    drawBoldTextInBrightColors: s.boldBright,
    theme: findTerminalTheme(activeThemeId || s.terminalTheme, uiLight).colors
  }
}

interface TerminalUiBridge {
  hostEl: HTMLDivElement | null
  wrapEl: HTMLDivElement | null
  popup: Popup | null
  setPopup(p: Popup | null): void
  setSearching(v: boolean): void
  broadcastActive?: boolean
  onBroadcastWrite?: (data: string) => void
  onSessionReady?: (paneId: string, sessionId: string) => void
  onSessionClosed?: (paneId: string) => void
}

interface RetainedTerminal {
  sKey: string
  container: HTMLDivElement
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  ui: TerminalUiBridge
  accept(s: Suggestion): void
  paste(): void
  getSessionId(): string | null
  disposeTimer?: ReturnType<typeof setTimeout>
  dispose(): void
}

/**
 * Live terminal instances indexed by `sKey` (`paneId || tab.id`). When a tab is
 * split or merged into a workspace, the old `<TerminalTab>` unmounts and the new
 * pane `<TerminalTab>` mounts with the same `sKey` in the same commit; retaining
 * the instance preserves the active SSH/local session, buffer, and WebGL canvas.
 */
const retainedTerminals = new Map<string, RetainedTerminal>()
const liveTerminals = new Set<Terminal>()

function refreshTerminalRender(term: Terminal | null): void {
  if (!term) return
  const core = (term as unknown as {
    _core?: {
      _renderService?: { clear(): void }
    }
  })._core
  core?._renderService?.clear()
  if (term.rows > 0) term.refresh(0, term.rows - 1)
}

/**
 * @xterm/addon-webgl shares a single TextureAtlas instance across all terminals
 * that use the same font and theme. Clearing the atlas on one terminal wipes the
 * shared glyph pages without clearing `_model` on the others, so every live
 * terminal must reset its renderer model and redraw together.
 */
function clearAllTextureAtlases(): void {
  for (const t of liveTerminals) {
    t.clearTextureAtlas()
    refreshTerminalRender(t)
  }
}

function fitTerminal(term: Terminal | null, fit: FitAddon | null, el: HTMLElement | null): void {
  if (!term || !fit || !el || el.offsetWidth <= 0 || el.offsetHeight <= 0) return
  const core = (term as unknown as {
    _core?: {
      _charSizeService?: { measure(): void }
    }
  })._core
  core?._charSizeService?.measure()
  const dims = fit.proposeDimensions()
  if (dims && dims.cols < term.cols) {
    trimTrailingSpaces(term)
  }
  fit.fit()
}

let audio: AudioContext | null = null
function beep(): void {
  audio ??= new AudioContext()
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.frequency.value = 880
  gain.gain.value = 0.05
  osc.connect(gain).connect(audio.destination)
  osc.start()
  osc.stop(audio.currentTime + 0.08)
}

export interface TerminalTabProps {
  tab: Tab
  active: boolean
  paneId?: string
  paneTarget?: SessionTarget
  paneTitle?: string
  showPaneHeader?: boolean
  broadcastActive?: boolean
  isMaximized?: boolean
  onToggleBroadcast?: () => void
  onBroadcastWrite?: (data: string) => void
  onSplit?: (direction: 'horizontal' | 'vertical') => void
  onClosePane?: () => void
  onToggleMaximize?: () => void
  onSessionReady?: (paneId: string, sessionId: string) => void
  onSessionClosed?: (paneId: string) => void
}

export function TerminalTab(props: TerminalTabProps) {
  const {
    tab,
    active,
    paneId,
    paneTarget,
    paneTitle,
    showPaneHeader,
    broadcastActive,
    isMaximized,
    onToggleBroadcast,
    onBroadcastWrite,
    onSplit,
    onClosePane,
    onToggleMaximize,
    onSessionReady,
    onSessionClosed
  } = props
  const t = useT()
  const settings = useApp((s) => s.snapshot!.settings)
  const setTabTheme = useApp((s) => s.setTabTheme)
  const uiLight = useUiLight()
  const snippets = useApp((s) => s.snapshot!.snippets)
  const effectiveTarget = paneTarget || tab.target
  const host = useApp((s) => (effectiveTarget.kind === 'host' ? s.snapshot!.hosts.find((h) => h.id === (effectiveTarget as { hostId: string }).hostId) : undefined))
  const activeThemeId = (paneId ? tab.panes?.find((p) => p.id === paneId)?.themeOverride : undefined) ?? tab.themeOverride ?? host?.theme ?? settings.terminalTheme
  const currentTheme = findTerminalTheme(activeThemeId, uiLight)
  const hostEl = useRef<HTMLDivElement>(null)
  const wrapEl = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const settingsRef = useRef(settings)
  const prevVisualKeyRef = useRef(`${settings.fontFamily}|${settings.fontSize}|${settings.boldBright}|${activeThemeId}|${uiLight}`)
  const popupRef = useRef<Popup | null>(null)
  const acceptRef = useRef<(s: Suggestion) => void>(() => {})
  const pasteRef = useRef<(() => void) | null>(null)
  const [popup, setPopupState] = useState<Popup | null>(null)
  const [searching, setSearching] = useState(false)
  const [snippetMenu, setSnippetMenu] = useState(false)
  const [themeMenu, setThemeMenu] = useState(false)
  const [termContextMenu, setTermContextMenu] = useState<{ x: number; y: number } | null>(null)
  settingsRef.current = settings

  const sKey = paneId || tab.id
  const currentEntry = retainedTerminals.get(sKey)
  if (currentEntry) {
    currentEntry.ui.broadcastActive = broadcastActive
    currentEntry.ui.onBroadcastWrite = onBroadcastWrite
    currentEntry.ui.onSessionReady = onSessionReady
    currentEntry.ui.onSessionClosed = onSessionClosed
  }

  useEffect(() => {
    let entry = retainedTerminals.get(sKey)
    if (entry) {
      clearTimeout(entry.disposeTimer)
      entry.disposeTimer = undefined
      if (entry.container.parentElement !== hostEl.current) {
        hostEl.current!.appendChild(entry.container)
      }
    } else {
      const container = document.createElement('div')
      container.style.width = '100%'
      container.style.height = '100%'
      container.style.overflow = 'hidden'
      hostEl.current!.appendChild(container)

      const ui: TerminalUiBridge = {
        hostEl: hostEl.current,
        wrapEl: wrapEl.current,
        popup: null,
        setPopup: () => {},
        setSearching: () => {},
        broadcastActive,
        onBroadcastWrite,
        onSessionReady,
        onSessionClosed
      }

      const term = new Terminal({ ...termOptions(settingsRef.current, uiLight), allowProposedApi: true, macOptionIsMeta: true })
      liveTerminals.add(term)
      const fit = new FitAddon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(search)
      term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
      term.open(container)
      // WebGL draws box-drawing and block characters itself, pixel exact, so ASCII art
      // and TUIs line up whatever font is used. Falls back to the DOM renderer.
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // No WebGL (e.g. GPU blocklisted): the DOM renderer keeps working.
      }
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
      // Measure cells again once the web font is really loaded.
      void ensureFontLoaded(settingsRef.current.fontFamily, settingsRef.current.fontSize).then((newlyLoaded) => {
        if (disposed) return
        term.options.fontFamily = fontStack(settingsRef.current.fontFamily)
        if (newlyLoaded) clearAllTextureAtlases()
        fitTerminal(term, fit, ui.hostEl)
      })
      fitTerminal(term, fit, ui.hostEl)

      const tracker = new LineTracker()
      let sessionId: string | null = null
      let unsubscribe: (() => void) | null = null
      let exited = false
      let disposed = false
      let suggestTimer: ReturnType<typeof setTimeout> | undefined
      // Automatic reconnection after a dropped connection.
      let reconnectTimer: ReturnType<typeof setInterval> | undefined
      let attempt = 0

      /** True when the typed line is visible at the cursor, i.e. it is echoed (not a password). */
      const echoed = (line: string): boolean => {
        const buf = term.buffer.active
        if (buf.type === 'alternate') return false
        const row = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true, 0, buf.cursorX) ?? ''
        const tail = line.slice(-Math.min(line.length, buf.cursorX))
        return tail.length > 0 && row.endsWith(tail)
      }

      const refreshSuggestions = (): void => {
        clearTimeout(suggestTimer)
        if (!settingsRef.current.autocomplete || !tracker.valid || !tracker.line.trim()) return ui.setPopup(null)
        const line = tracker.line
        suggestTimer = setTimeout(async () => {
          if (!echoed(line)) return ui.setPopup(null)
          const items = await api.suggest(line).catch(() => [])
          if (disposed || tracker.line !== line || !tracker.valid || !ui.hostEl || !ui.wrapEl) return
          if (items.length === 0) return ui.setPopup(null)
          const screen = ui.hostEl.querySelector('.xterm-screen')!.getBoundingClientRect()
          const cellW = screen.width / term.cols
          const cellH = screen.height / term.rows
          const buf = term.buffer.active
          const left = Math.min(8 + buf.cursorX * cellW, Math.max(8, ui.wrapEl.clientWidth - 300))
          const below = buf.cursorY < term.rows / 2
          ui.setPopup({
            items,
            sel: 0,
            left,
            top: below ? 6 + (buf.cursorY + 1) * cellH + 2 : undefined,
            bottom: below ? undefined : ui.wrapEl.clientHeight - (6 + buf.cursorY * cellH) + 2
          })
        }, 90)
      }

      /**
       * Saves a submitted command once its echo has settled on screen. Input that
       * never shows up on the prompt line (passwords) is not recorded.
       */
      const recordIfEchoed = (line: string): void => {
        const buf = term.buffer.active
        if (!line.trim() || buf.type === 'alternate') return
        const y = buf.baseY + buf.cursorY
        setTimeout(() => {
          const normal = term.buffer.normal
          let text = normal.getLine(y)?.translateToString(true) ?? ''
          for (let i = y; i > 0 && normal.getLine(i)?.isWrapped; i--) {
            text = (normal.getLine(i - 1)?.translateToString() ?? '') + text
          }
          if (text.trimEnd().endsWith(line.trimEnd())) api.recordHistory(line)
        }, 300)
      }

      const sendInput = (data: string): void => {
        if (!sessionId) return
        const submitted = tracker.feed(data)
        if (ui.broadcastActive && ui.onBroadcastWrite) {
          ui.onBroadcastWrite(data)
        } else {
          api.writeSession(sessionId, data)
        }
        if (submitted !== undefined) recordIfEchoed(submitted)
        if (submitted !== undefined || data.startsWith('\x1b')) ui.setPopup(null)
        else refreshSuggestions()
      }

      const accept = (s: Suggestion): void => {
        ui.setPopup(null)
        sendInput('\x7f'.repeat(s.replaceLength) + s.insert)
      }

      const paste = (): void => {
        void navigator.clipboard.readText().then((text) => text && term.paste(text))
      }
      pasteRef.current = paste

      const cancelReconnect = (): void => {
        clearInterval(reconnectTimer)
        reconnectTimer = undefined
      }

      const scheduleReconnect = (): boolean => {
        const canRetry = settingsRef.current.autoReconnect && effectiveTarget.kind === 'host' && attempt < RECONNECT_DELAYS.length
        if (!canRetry || disposed) return false
        let left = RECONNECT_DELAYS[attempt++]
        const show = (): void => {
          term.write(`\r\x1b[2K\x1b[33m${translate('reconnecting')} ${left}s (${attempt}/${RECONNECT_DELAYS.length})\x1b[0m \x1b[2m${translate('reconnectHint')}\x1b[0m`)
        }
        show()
        reconnectTimer = setInterval(() => {
          left--
          if (left > 0) return show()
          cancelReconnect()
          term.write('\r\n')
          void connect()
        }, 1000)
        return true
      }

      const connect = async (): Promise<void> => {
        cancelReconnect()
        exited = false
        tracker.reset()
        const label = host ? `${host.username ? host.username + '@' : ''}${host.hostname}` : (paneTitle || tab.title)
        term.write(`\x1b[2m${translate('connecting')} ${label}…\x1b[0m\r\n`)
        try {
          await ensureFontLoaded(settingsRef.current.fontFamily, settingsRef.current.fontSize)
          if (disposed) return
          fitTerminal(term, fit, ui.hostEl)
          const info = await api.openSession(effectiveTarget, term.cols, term.rows)
          if (disposed) return api.closeSession(info.id)
          attempt = 0
          sessionId = info.id
          tabSessions.set(sKey, info.id)
          ui.onSessionReady?.(sKey, info.id)
          fitTerminal(term, fit, ui.hostEl)
          api.resizeSession(info.id, term.cols, term.rows)
          unsubscribe = subscribe(info.id, {
            data: (d) => term.write(d),
            exit: (reason) => {
              exited = true
              sessionId = null
              tabSessions.delete(sKey)
              ui.onSessionClosed?.(sKey)
              unsubscribe?.()
              ui.setPopup(null)
              term.write(`\r\n\x1b[33m[${translate('sessionClosed')}: ${reason}]\x1b[0m\r\n`)
              if (reason !== 'disconnected' || !scheduleReconnect()) term.write(`${translate('pressEnter')}\r\n`)
            }
          })
        } catch (err) {
          exited = true
          term.write(`\x1b[31m${errorMessage(err)}\x1b[0m\r\n`)
          // Keep retrying only while recovering from a drop, not on the first connection.
          if (attempt === 0 || !scheduleReconnect()) term.write(`${translate('pressEnter')}\r\n`)
        }
      }

      term.onData((data) => {
        if (exited) {
          if (data === '\r') void connect()
          else if (data === '\x1b' && reconnectTimer) {
            cancelReconnect()
            term.write(`\r\n${translate('pressEnter')}\r\n`)
          }
          return
        }
        sendInput(data)
      })
      term.onResize(({ cols, rows }) => sessionId && api.resizeSession(sessionId, cols, rows))
      term.onBell(() => settingsRef.current.bellSound && beep())
      // Full-screen programs (vim, less, man) use the alternate buffer; what is typed there
      // is not a shell command line.
      term.buffer.onBufferChange((b) => {
        tracker.reset()
        if (b.type === 'alternate') tracker.valid = false
        ui.setPopup(null)
      })
      term.onSelectionChange(() => {
        if (settingsRef.current.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
      })

      // Keys handled here must also be cancelled: xterm skips preventDefault() for them,
      // and an uncancelled Tab would move the focus out of the terminal.
      const handled = (ev: KeyboardEvent): false => {
        ev.preventDefault()
        ev.stopPropagation()
        return false
      }
      term.attachCustomKeyEventHandler((ev) => {
        const p = ui.popup
        if (ev.type !== 'keydown' || !p) return true
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          const n = p.items.length
          ui.setPopup({ ...p, sel: (p.sel + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n })
          return handled(ev)
        }
        if (ev.key === 'Tab') {
          accept(p.items[p.sel])
          return handled(ev)
        }
        if (ev.key === 'Escape') {
          ui.setPopup(null)
          return handled(ev)
        }
        return true
      })

      entry = {
        sKey,
        container,
        term,
        fit,
        search,
        ui,
        accept,
        paste,
        getSessionId: () => sessionId,
        dispose: () => {
          disposed = true
          liveTerminals.delete(term)
          clearTimeout(suggestTimer)
          cancelReconnect()
          terminalActions.delete(sKey)
          unsubscribe?.()
          if (sessionId) api.closeSession(sessionId)
          tabSessions.delete(sKey)
          ui.onSessionClosed?.(sKey)
          container.remove()
          term.dispose()
        }
      }
      retainedTerminals.set(sKey, entry)
      void connect()
    }

    const { term, fit, search, accept, paste, ui } = entry
    ui.hostEl = hostEl.current
    ui.wrapEl = wrapEl.current
    ui.setPopup = (p: Popup | null) => {
      popupRef.current = p
      ui.popup = p
      setPopupState(p)
    }
    ui.setSearching = setSearching
    ui.broadcastActive = broadcastActive
    ui.onBroadcastWrite = onBroadcastWrite
    ui.onSessionReady = onSessionReady
    ui.onSessionClosed = onSessionClosed

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    acceptRef.current = accept

    const existingSid = entry.getSessionId()
    if (existingSid) {
      onSessionReady?.(sKey, existingSid)
    }

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (settingsRef.current.copyOnSelect) {
        paste()
      } else {
        setTermContextMenu({ x: e.clientX, y: e.clientY })
      }
    }
    hostEl.current!.addEventListener('contextmenu', onContextMenu)

    const actions = {
      copy: () => term.hasSelection() && void navigator.clipboard.writeText(term.getSelection()),
      paste,
      selectAll: () => term.selectAll(),
      find: () => ui.setSearching(true)
    }
    terminalActions.set(tab.id, actions)
    terminalActions.set(sKey, actions)

    let mounted = true
    let resizeRaf = 0
    let wasHidden = false
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf)
      const el = hostEl.current
      if (!el || el.offsetWidth <= 0 || el.offsetHeight <= 0) {
        wasHidden = true
        return
      }
      const unhidden = wasHidden
      wasHidden = false
      fitTerminal(term, fit, el)
      if (unhidden) refreshTerminalRender(term)
      resizeRaf = requestAnimationFrame(() => {
        if (!mounted) return
        fitTerminal(term, fit, hostEl.current)
        if (unhidden) refreshTerminalRender(term)
      })
    })
    observer.observe(hostEl.current!)
    fitTerminal(term, fit, hostEl.current)
    refreshTerminalRender(term)
    resizeRaf = requestAnimationFrame(() => {
      if (!mounted) return
      fitTerminal(term, fit, hostEl.current)
      refreshTerminalRender(term)
    })

    const el = hostEl.current!
    return () => {
      mounted = false
      cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      el.removeEventListener('contextmenu', onContextMenu)
      entry.disposeTimer = setTimeout(() => {
        retainedTerminals.delete(sKey)
        entry.dispose()
      }, 0)
    }
    // The terminal lives for the whole life of the tab/pane.
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const visualKey = `${settings.fontFamily}|${settings.fontSize}|${settings.boldBright}|${activeThemeId}|${uiLight}`
    const visualChanged = prevVisualKeyRef.current !== visualKey
    prevVisualKeyRef.current = visualKey
    let cancelled = false
    void ensureFontLoaded(settings.fontFamily, settings.fontSize).then((newlyLoaded) => {
      if (cancelled) return
      Object.assign(term.options, termOptions(settings, uiLight, activeThemeId))
      if (visualChanged || newlyLoaded) clearAllTextureAtlases()
      fitTerminal(term, fitRef.current, hostEl.current)
    })
    return () => {
      cancelled = true
    }
  }, [settings, activeThemeId, uiLight])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      fitTerminal(termRef.current, fitRef.current, hostEl.current)
      refreshTerminalRender(termRef.current)
      termRef.current?.focus()
    })
  }, [active])

  const closeSearch = (): void => {
    setSearching(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  const termBg = currentTheme.colors.background

  const displayLabel = host?.label || paneTitle || tab.title
  const displaySub = host
    ? `${host.protocol}, ${host.username || 'root'}`
    : effectiveTarget.kind === 'local'
      ? 'local'
      : 'serial'

  return (
    <>
      {showPaneHeader ? (
        <div className="pane-header">
          <div className="pane-title">
            <Icon name={effectiveTarget.kind === 'host' ? 'server' : 'terminal'} size={14} />
            <span className="pane-label">{displayLabel}</span>
            <span className="pane-sub dim mono">{displaySub}</span>
          </div>
          <div className="pane-actions">
            {onToggleBroadcast && (
              <button
                className={`btn small ${broadcastActive ? 'active on' : ''}`}
                title={broadcastActive ? t('broadcastOn') : t('broadcastOff')}
                onClick={onToggleBroadcast}
              >
                <Icon name="broadcast" size={13} />
                <span>Broadcast</span>
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <button className="btn small icon" title={t('sessionTheme')} onClick={() => setThemeMenu(!themeMenu)}>
                <Icon name="palette" size={13} />
              </button>
              {themeMenu && (
                <div className="menu" style={{ right: 0, left: 'auto', top: 26, maxHeight: 280, overflowY: 'auto', zIndex: 100 }} onMouseLeave={() => setThemeMenu(false)}>
                  <div className="menu-group">{t('sessionTheme')}</div>
                  <button
                    className={!tab.themeOverride ? 'active' : ''}
                    onClick={() => {
                      setThemeMenu(false)
                      setTabTheme(tab.id, undefined)
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span style={{ width: 12, height: 12, borderRadius: 2, background: findTerminalTheme(host?.theme ?? settings.terminalTheme, uiLight).colors.background, border: '1px solid var(--border)' }} />
                    <span>{t('defaultTheme')}</span>
                    {!tab.themeOverride && <span style={{ marginLeft: 'auto' }}>✓</span>}
                  </button>
                  <hr />
                  {TERMINAL_THEMES.map((th) => (
                    <button
                      key={th.id}
                      className={activeThemeId === th.id ? 'active' : ''}
                      onClick={() => {
                        setThemeMenu(false)
                        setTabTheme(tab.id, th.id)
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span style={{ width: 12, height: 12, borderRadius: 2, background: th.colors.background, border: '1px solid var(--border)' }} />
                      <span>{th.name}</span>
                      {activeThemeId === th.id && <span style={{ marginLeft: 'auto' }}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {onSplit && (
              <>
                <button className="btn small icon" title={t('splitHorizontal')} onClick={() => onSplit('horizontal')}>
                  <Icon name="splitHorizontal" size={14} />
                </button>
                <button className="btn small icon" title={t('splitVertical')} onClick={() => onSplit('vertical')}>
                  <Icon name="splitVertical" size={14} />
                </button>
              </>
            )}
            {onToggleMaximize && (
              <button className="btn small icon" title={isMaximized ? t('restorePane') : t('maximizePane')} onClick={onToggleMaximize}>
                <Icon name={isMaximized ? 'minimize' : 'maximize'} size={13} />
              </button>
            )}
            {onClosePane && (
              <button className="btn small icon danger" title={t('close')} onClick={onClosePane}>
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="term-toolbar">
        <div style={{ position: 'relative' }}>
          <button className="btn small" onClick={() => setSnippetMenu(!snippetMenu)} disabled={snippets.length === 0}>
            <Icon name="code" /> {t('snippets')}
          </button>
          {snippetMenu && (
            <div className="menu" style={{ left: 0, top: 30 }} onMouseLeave={() => setSnippetMenu(false)}>
              {snippets.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSnippetMenu(false)
                    runSnippet(s, tab.id)
                    termRef.current?.focus()
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn small" onClick={() => setSearching(true)}>
          <Icon name="search" /> {t('findInTerminal')}
        </button>
        <div style={{ position: 'relative' }}>
          <button className="btn small" onClick={() => setThemeMenu(!themeMenu)} title={t('sessionTheme')}>
            <Icon name="palette" size={13} /> {currentTheme.name}
          </button>
          {themeMenu && (
            <div className="menu" style={{ left: 0, top: 30, maxHeight: 300, overflowY: 'auto', zIndex: 100 }} onMouseLeave={() => setThemeMenu(false)}>
              <div className="menu-group">{t('sessionTheme')}</div>
              <button
                className={!tab.themeOverride ? 'active' : ''}
                onClick={() => {
                  setThemeMenu(false)
                  setTabTheme(tab.id, undefined)
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ width: 12, height: 12, borderRadius: 2, background: findTerminalTheme(host?.theme ?? settings.terminalTheme, uiLight).colors.background, border: '1px solid var(--border)' }} />
                <span>{t('defaultTheme')} ({findTerminalTheme(host?.theme ?? settings.terminalTheme, uiLight).name})</span>
                {!tab.themeOverride && <span style={{ marginLeft: 'auto' }}>✓</span>}
              </button>
              <hr />
              {TERMINAL_THEMES.map((th) => (
                <button
                  key={th.id}
                  className={activeThemeId === th.id ? 'active' : ''}
                  onClick={() => {
                    setThemeMenu(false)
                    setTabTheme(tab.id, th.id)
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ width: 12, height: 12, borderRadius: 2, background: th.colors.background, border: '1px solid var(--border)' }} />
                  <span>{th.name}</span>
                  {activeThemeId === th.id && <span style={{ marginLeft: 'auto' }}>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {host?.protocol === 'ssh' && (
          <button className="btn small" onClick={() => openSftp(host)}>
            <Icon name="folder" /> {t('sftp')}
          </button>
        )}
      </div>
      )}
      <div className="term-wrap" ref={wrapEl} style={{ background: termBg }}>
        <div className="term-host" ref={hostEl} />
        {searching && (
          <div className="term-search">
            <input
              className="input"
              autoFocus
              placeholder={t('search')}
              onChange={(e) => searchRef.current?.findNext(e.target.value, { incremental: true })}
              onKeyDown={(e) => {
                const q = e.currentTarget.value
                if (e.key === 'Enter') {
                  if (e.shiftKey) searchRef.current?.findPrevious(q)
                  else searchRef.current?.findNext(q)
                } else if (e.key === 'Escape') closeSearch()
              }}
            />
            <button className="btn small icon" onClick={closeSearch}>
              <Icon name="x" />
            </button>
          </div>
        )}
        {popup && (
          <div className="suggest mono" style={{ left: popup.left, top: popup.top, bottom: popup.bottom }}>
            {popup.items.map((s, i) => (
              <div
                key={s.source + s.label}
                className={`suggest-item ${i === popup.sel ? 'sel' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  acceptRef.current(s)
                  termRef.current?.focus()
                }}
              >
                <span className="src">{SOURCE_LABEL[s.source]}</span>
                <span>{s.label}</span>
                {s.description && <span className="desc">{s.description}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {termContextMenu && (
        <div
          className="menu context-menu"
          style={{ position: 'fixed', left: termContextMenu.x, top: termContextMenu.y, zIndex: 100 }}
          onMouseLeave={() => setTermContextMenu(null)}
        >
          <button
            onClick={() => {
              setTermContextMenu(null)
              if (termRef.current?.hasSelection()) {
                void navigator.clipboard.writeText(termRef.current.getSelection())
              }
            }}
            disabled={!termRef.current?.hasSelection()}
          >
            <Icon name="copy" size={14} /> {t('copy')}
          </button>
          <button
            onClick={() => {
              setTermContextMenu(null)
              pasteRef.current?.()
            }}
          >
            <Icon name="import" size={14} /> {t('paste')}
          </button>
          <button
            onClick={() => {
              setTermContextMenu(null)
              termRef.current?.selectAll()
            }}
          >
            <Icon name="keyboard" size={14} /> {t('selectAll')}
          </button>
          <hr />
          <button
            onClick={() => {
              setTermContextMenu(null)
              termRef.current?.clear()
            }}
          >
            <Icon name="trash" size={14} /> {t('clear')}
          </button>
        </div>
      )}
    </>
  )
}
