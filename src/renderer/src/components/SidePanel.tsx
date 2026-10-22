import { useEffect, useMemo, useState } from 'react'
import type { CommandHistory } from '@shared/types'
import { api } from '../api'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'
import { runSnippet } from '../views/Snippets'
import { Icon } from './Icon'

export type SidePanelKind = 'snippets' | 'history'

/** How many of the most used commands the tip offers as snippets. */
const TIP_SIZE = 3

function snippetLabel(command: string): string {
  return command.length > 40 ? command.slice(0, 39) + '…' : command
}

/**
 * Panel beside a terminal: snippets and the command history (this app's and
 * the local shells'), with a tip to save the most used commands as snippets.
 */
export function SidePanel({
  kind,
  tabId,
  onKind,
  onType,
  onClose
}: {
  kind: SidePanelKind
  tabId: string
  onKind(k: SidePanelKind): void
  /** Types text into this terminal (run = followed by Enter). */
  onType(text: string, run: boolean): void
  onClose(): void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  return (
    <aside className="side-panel">
      <div className="side-panel-tabs">
        <button className={`btn small icon ${kind === 'snippets' ? 'active' : ''}`} title={t('snippets')} onClick={() => onKind('snippets')}>
          <Icon name="code" />
        </button>
        <button className={`btn small icon ${kind === 'history' ? 'active' : ''}`} title={t('history')} onClick={() => onKind('history')}>
          <Icon name="clock" />
        </button>
        <button className="btn small icon" style={{ marginLeft: 'auto' }} title={t('close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="side-panel-search">
        <Icon name="search" size={14} />
        <input className="input" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {kind === 'history' ? <HistoryList query={query} onType={onType} /> : <SnippetList query={query} tabId={tabId} />}
    </aside>
  )
}

function SnippetList({ query, tabId }: { query: string; tabId: string }) {
  const t = useT()
  const snippets = useApp((s) => s.snapshot!.snippets)
  const q = query.trim().toLowerCase()
  const shown = snippets.filter((s) => !q || s.label.toLowerCase().includes(q) || s.script.toLowerCase().includes(q))
  if (!snippets.length) return <div className="side-panel-empty">{t('noSnippets')}</div>
  return (
    <div className="side-panel-list">
      {shown.map((s) => (
        <button key={s.id} className="side-panel-item" title={s.script} onClick={() => runSnippet(s, tabId)}>
          <b>{s.label}</b>
          <span className="mono dim truncate">{s.script.replace(/\n/g, ' ⏎ ')}</span>
        </button>
      ))}
    </div>
  )
}

function HistoryList({ query, onType }: { query: string; onType(text: string, run: boolean): void }) {
  const t = useT()
  const snippets = useApp((s) => s.snapshot!.snippets)
  const dismissed = useApp((s) => s.snapshot!.settings.historyTipDismissed)
  const [history, setHistory] = useState<CommandHistory | null>(null)

  useEffect(() => {
    const load = (): void => void api.commandHistory().then(setHistory)
    load()
    return api.onHistoryChanged(load)
  }, [])

  // Most used commands that are not snippets yet; shown until closed, and again when a new one enters the top.
  const tip = useMemo(() => {
    const saved = new Set(snippets.map((s) => s.script.trim()))
    return (history?.frequent ?? []).map((f) => f.command).filter((c) => !saved.has(c)).slice(0, TIP_SIZE)
  }, [history, snippets])
  const showTip = tip.length === TIP_SIZE && tip.some((c) => !dismissed.includes(c))
  const [drafts, setDrafts] = useState<string[]>([])
  useEffect(() => setDrafts(tip), [tip.join('\n')])

  if (!history) return null
  const q = query.trim().toLowerCase()
  const shown = history.recent.filter((c) => !q || c.toLowerCase().includes(q))

  const saveTip = async (): Promise<void> => {
    const commands = drafts.map((d) => d.trim()).filter(Boolean)
    for (const script of commands) await attempt(() => api.saveSnippet({ label: snippetLabel(script), script }))
    useApp.getState().toast(t('snippetsSaved').replace('{n}', String(commands.length)))
  }
  const saveOne = async (command: string): Promise<void> => {
    if (await attempt(() => api.saveSnippet({ label: snippetLabel(command), script: command }))) useApp.getState().toast(t('snippetSaved'))
  }

  return (
    <div className="side-panel-list">
      {showTip && !q && (
        <div className="history-tip">
          <Icon name="code" size={20} />
          <p>{t('historyTip')}</p>
          {drafts.map((d, i) => (
            <input key={i} className="input mono" value={d} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? e.target.value : x)))} />
          ))}
          <div className="history-tip-actions">
            <button className="btn small" onClick={() => void attempt(() => api.saveSettings({ historyTipDismissed: tip }))}>
              {t('close')}
            </button>
            <button className="btn small primary" onClick={() => void saveTip()}>
              {t('save')}
            </button>
          </div>
        </div>
      )}
      {shown.length === 0 && <div className="side-panel-empty">{t('noHistory')}</div>}
      {shown.map((cmd) => (
        <div key={cmd} className="side-panel-item history-item" title={t('historyItemHint')} onClick={() => onType(cmd, false)}>
          <span className="mono truncate">{cmd}</span>
          <span className="history-actions">
            <button
              className="btn small icon"
              title={t('run')}
              onClick={(e) => {
                e.stopPropagation()
                onType(cmd, true)
              }}
            >
              <Icon name="play" size={13} />
            </button>
            <button
              className="btn small icon"
              title={t('saveAsSnippet')}
              onClick={(e) => {
                e.stopPropagation()
                void saveOne(cmd)
              }}
            >
              <Icon name="code" size={13} />
            </button>
            <button
              className="btn small icon danger"
              title={t('forgetCommand')}
              onClick={(e) => {
                e.stopPropagation()
                void attempt(() => api.forgetCommand(cmd))
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}
