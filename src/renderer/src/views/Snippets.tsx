import { useMemo, useState, type FormEvent } from 'react'
import type { Snippet } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions, useViewMode, ViewToggle } from '../components/ui'
import { translate, useT } from '../i18n'
import { tabSessions } from '../sessionBus'
import { attempt, useApp } from '../state'

/**
 * Types a snippet into a terminal tab (the last used one by default) and focuses it.
 * The main process fills its variables, asking first when it has {{ask:…}}.
 */
export function runSnippet(s: Snippet, tabId = useApp.getState().lastTerminal): void {
  const sessionId = tabId && tabSessions.get(tabId)
  if (!tabId || !sessionId) {
    useApp.getState().toast(translate('noTerminal'), true)
    return
  }
  useApp.getState().activate(tabId)
  void attempt(() => api.runSnippet(sessionId, s.id))
}

function SnippetEditor({ snippet, onClose }: { snippet: Partial<Snippet>; onClose(): void }) {
  const t = useT()
  const [label, setLabel] = useState(snippet.label ?? '')
  const [script, setScript] = useState(snippet.script ?? '')
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (await attempt(() => api.saveSnippet({ id: snippet.id, label, script }))) onClose()
  }
  return (
    <Drawer title={snippet.id ? t('edit') : t('newSnippet')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <Field label={t('script')}>
          <textarea className="input mono" rows={8} value={script} onChange={(e) => setScript(e.target.value)} required />
        </Field>
        <p className="note">{t('snippetVarsHint')}</p>
        <FormActions onCancel={onClose} />
      </form>
    </Drawer>
  )
}

export function Snippets() {
  const t = useT()
  const snippets = useApp((s) => s.snapshot!.snippets)
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useViewMode('snippets', 'grid')

  const visibleSnippets = useMemo(() => {
    const q = query.trim().toLowerCase()
    return snippets.filter((s) => !q || s.label.toLowerCase().includes(q) || s.script.toLowerCase().includes(q))
  }, [snippets, query])

  return (
    <div className="page" onClick={() => setSelectedId(null)}>
      <div className="page-head" onClick={(e) => e.stopPropagation()}>
        <h1>{t('snippets')}</h1>
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={() => setEditing({})}>
          <Icon name="plus" /> {t('newSnippet')}
        </button>
      </div>
      {visibleSnippets.length === 0 ? (
        <div className="empty">{t('noSnippets')}</div>
      ) : (
        <div className={viewMode === 'grid' ? 'cards' : 'cards list-mode'}>
          {visibleSnippets.map((s) => (
            <div
              key={s.id}
              tabIndex={0}
              className={`card ${selectedId === s.id ? 'selected' : ''}`}
              title={t('doubleClickToEdit')}
              onClick={(e) => {
                e.stopPropagation()
                setSelectedId(s.id)
              }}
              onFocus={() => setSelectedId(s.id)}
              onDoubleClick={() => setEditing(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setEditing(s)
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  if (confirm(t('confirmDelete'))) void attempt(() => api.deleteSnippet(s.id))
                }
              }}
            >
              <div className="card-icon">
                <Icon name="code" size={18} />
              </div>
              <div className="card-body">
                <div className="card-title">{s.label}</div>
                <div className="card-sub mono">{s.script.replace(/\n/g, ' ⏎ ')}</div>
              </div>
              <div className="card-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <button className="btn small primary" onClick={() => runSnippet(s)}>
                  <Icon name="play" /> {t('run')}
                </button>
                <button className="btn small icon" title={t('edit')} onClick={() => setEditing(s)}>
                  <Icon name="edit" />
                </button>
                <button
                  className="btn small icon danger"
                  title={t('delete')}
                  onClick={() => confirm(t('confirmDelete')) && attempt(() => api.deleteSnippet(s.id))}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <SnippetEditor snippet={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
