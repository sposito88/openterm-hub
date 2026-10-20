import { useState, type FormEvent } from 'react'
import type { CredentialPrompt } from '@shared/types'
import { api } from '../api'
import { useT } from '../i18n'
import { useApp } from '../state'
import { Field, Modal } from './ui'

/** Gives the keyboard back to the visible terminal once a dialog closes. */
function refocusTerminal(): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.pane:not([hidden]) .xterm-helper-textarea')?.focus())
}

function CredentialForm({ prompt }: { prompt: CredentialPrompt }) {
  const t = useT()
  const [values, setValues] = useState(() => prompt.fields.map(() => ''))
  const answer = (v: string[] | null): void => {
    api.answerCredential(prompt.promptId, v)
    useApp.setState((s) => ({ credentialPrompts: s.credentialPrompts.filter((p) => p.promptId !== prompt.promptId) }))
    refocusTerminal()
  }
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    answer(values)
  }
  return (
    <Modal title={prompt.title}>
      <form onSubmit={submit}>
        {prompt.instructions && <p className="note">{prompt.instructions}</p>}
        {prompt.fields.map((f, i) => (
          <Field key={i} label={f.label}>
            <input
              className="input"
              type={f.secret ? 'password' : 'text'}
              autoFocus={i === 0}
              value={values[i]}
              onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </Field>
        ))}
        <div className="actions">
          <button type="button" className="btn" onClick={() => answer(null)}>
            {t('cancel')}
          </button>
          <button className="btn primary">{t('ok')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Shows one pending question from the main process at a time. */
export function Prompts() {
  const t = useT()
  const hostKey = useApp((s) => s.hostKeyPrompts[0])
  const credential = useApp((s) => s.credentialPrompts[0])

  if (hostKey) {
    const answer = (accept: boolean): void => {
      api.answerHostKey(hostKey.promptId, accept)
      useApp.setState((s) => ({ hostKeyPrompts: s.hostKeyPrompts.filter((p) => p.promptId !== hostKey.promptId) }))
      refocusTerminal()
    }
    return (
      <Modal title={t('hostKeyTitle')}>
        <div className={`banner ${hostKey.previous ? 'danger' : ''}`}>{hostKey.previous ? t('hostKeyChanged') : t('hostKeyUnknown')}</div>
        <div>
          <b>
            {hostKey.host}:{hostKey.port}
          </b>{' '}
          <span className="chip">{hostKey.keyType}</span>
        </div>
        <div className="fp mono">{hostKey.fingerprint}</div>
        {hostKey.previous && (
          <>
            <div className="dim">{t('previous')}</div>
            <div className="fp mono">{hostKey.previous}</div>
          </>
        )}
        <div className="actions">
          <button className="btn" onClick={() => answer(false)} autoFocus>
            {t('reject')}
          </button>
          <button className={`btn ${hostKey.previous ? 'danger' : 'primary'}`} onClick={() => answer(true)}>
            {t('trust')}
          </button>
        </div>
      </Modal>
    )
  }
  if (credential) return <CredentialForm key={credential.promptId} prompt={credential} />
  return null
}
