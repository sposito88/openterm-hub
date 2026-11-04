import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { LogEntry } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { useViewMode, ViewToggle } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp, useUiLight } from '../state'
import { fontStack } from '../fonts'
import { findTerminalTheme } from '../terminalThemes'

function duration(e: LogEntry): string {
  if (!e.endedAt) return ''
  const s = Math.max(0, Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}min` : m ? `${m}min ${s % 60}s` : `${s}s`
}

/** Replays a recorded session into a read-only terminal. */
function Transcript({ entry, onClose }: { entry: LogEntry; onClose(): void }) {
  const t = useT()
  const settings = useApp((s) => s.snapshot!.settings)
  const uiLight = useUiLight()
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const theme = findTerminalTheme(settings.terminalTheme, uiLight).colors
    const term = new Terminal({ disableStdin: true, fontFamily: fontStack(settings.fontFamily), fontSize: settings.fontSize, scrollback: 100000, theme })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el.current!)
    fit.fit()
    void api.readLog(entry.id).then((text) => term.write(text))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      term.dispose()
    }
  }, [entry.id])

  return (
    <div className="backdrop center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(1100px, calc(100% - 48px))' }}>
        <div className="page-head" style={{ marginBottom: 10 }}>
          <h1 style={{ fontSize: 15 }}>
            {entry.title} <span className="dim mono">{entry.target}</span>
          </h1>
          <button className="btn small icon" onClick={onClose} title={t('close')}>
            <Icon name="x" />
          </button>
        </div>
        <div ref={el} style={{ height: '65vh', background: findTerminalTheme(settings.terminalTheme, uiLight).colors.background, padding: 6, borderRadius: 8 }} />
      </div>
    </div>
  )
}

export function Logs() {
  const t = useT()
  const openSettings = useApp((s) => s.openSettings)
  const logging = useApp((s) => s.snapshot!.settings.sessionLogging)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [viewing, setViewing] = useState<LogEntry | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useViewMode('logs', 'list')

  useEffect(() => {
    const load = (): void => void api.listLogs().then(setEntries)
    load()
    return api.onLogsChanged(load)
  }, [])

  const q = query.trim().toLowerCase()
  const shown = entries.filter((e) => !q || [e.title, e.target, e.protocol, e.result ?? ''].some((v) => v.toLowerCase().includes(q)))

  return (
    <div className="page" onClick={() => setSelectedId(null)}>
      <div className="page-head" onClick={(e) => e.stopPropagation()}>
        <h1>{t('logs')}</h1>
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" onClick={() => openSettings('logs')}>
          <Icon name="gear" /> {t('settings')}
        </button>
        <button className="btn danger" disabled={entries.length === 0} onClick={() => confirm(t('confirmDelete')) && attempt(() => api.clearLogs())}>
          <Icon name="trash" /> {t('clearLogs')}
        </button>
      </div>
      {!logging && (
        <p className="note">
          {t('sessionLogging')}: {t('disabled').toLowerCase()}.
        </p>
      )}
      {shown.length === 0 ? (
        <div className="empty">{t('noLogs')}</div>
      ) : (
        <div className={viewMode === 'grid' ? 'cards' : 'cards list-mode'}>
          {shown.map((e) => (
            <div
              key={e.id}
              tabIndex={0}
              className={`card ${selectedId === e.id ? 'selected' : ''}`}
              title={e.hasTranscript ? t('viewTranscript') : undefined}
              onClick={(ev) => {
                ev.stopPropagation()
                setSelectedId(e.id)
              }}
              onFocus={() => setSelectedId(e.id)}
              onDoubleClick={() => {
                if (e.hasTranscript) setViewing(e)
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && e.hasTranscript) {
                  ev.preventDefault()
                  setViewing(e)
                } else if (ev.key === 'Delete') {
                  ev.preventDefault()
                  void attempt(() => api.deleteLog(e.id))
                }
              }}
            >
              <div className="card-icon">
                <Icon name={e.protocol === 'local' ? 'terminal' : e.protocol === 'serial' ? 'plug' : 'server'} size={18} />
              </div>
              <div className="card-body">
                <div className="card-title">{e.title}</div>
                <div className="card-sub mono">
                  {e.target}, {new Date(e.startedAt).toLocaleString()}
                  {e.endedAt ? `, ${t('duration').toLowerCase()} ${duration(e)}` : ''}
                </div>
                <div className="card-chips">
                  <span className="chip">{e.protocol}</span>
                  {!e.endedAt && !e.result ? (
                    <span className="chip ok">{t('inProgress')}</span>
                  ) : (
                    <span className={`chip ${e.ok ? '' : 'err'}`}>{e.result === 'interrupted' ? t('interrupted') : e.result}</span>
                  )}
                </div>
              </div>
              <div className="card-actions" onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}>
                {e.hasTranscript ? (
                  <button className="btn small" onClick={() => setViewing(e)}>
                    <Icon name="terminal" /> {t('viewTranscript')}
                  </button>
                ) : (
                  <span className="dim" style={{ fontSize: 12, paddingRight: 4 }}>
                    {t('noTranscript')}
                  </span>
                )}
                <button className="btn small icon danger" title={t('delete')} onClick={() => attempt(() => api.deleteLog(e.id))}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {viewing && <Transcript entry={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
