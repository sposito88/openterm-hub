import { useState, type FormEvent } from 'react'
import type { Snippet } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions } from '../components/ui'
import { translate, useT } from '../i18n'
import { tabSessions } from '../sessionBus'
import { attempt, useApp } from '../state'

/** Types a snippet into a terminal tab (the last used one by default) and focuses it. */
export function runSnippet(s: Snippet, tabId = useApp.getState().lastTerminal): void {
  const sessionId = tabId && tabSessions.get(tabId)
  if (!tabId || !sessionId) {
    useApp.getState().toast(translate('noTerminal'), true)
    return
  }
  api.writeSession(sessionId, s.script.replace(/\n?$/, '\n').replace(/\n/g, '\r'))
  useApp.getState().activate(tabId)
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
        <FormActions onCancel={onClose} />
      </form>
    </Drawer>
  )
}

export function Snippets() {
  const t = useT()
  const snippets = useApp((s) => s.snapshot!.snippets)
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null)
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('snippets')}</h1>
        <button className="btn primary" onClick={() => setEditing({})}>
          <Icon name="plus" /> {t('newSnippet')}
        </button>
      </div>
      {snippets.length === 0 ? (
        <div className="empty">{t('noSnippets')}</div>
      ) : (
        <div className="list">
          {snippets.map((s) => (
            <div key={s.id} className="list-item">
              <Icon name="code" size={18} />
              <div className="grow">
                <b>{s.label}</b>
                <div className="dim mono truncate">{s.script.replace(/\n/g, ' ⏎ ')}</div>
              </div>
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
          ))}
        </div>
      )}
      {editing && <SnippetEditor snippet={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
