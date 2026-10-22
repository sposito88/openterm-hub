import { useState, type FormEvent } from 'react'
import type { Identity, IdentityInput } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Check, Drawer, Field, FormActions } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'

/** Create or edit an identity; returns the saved one through onSaved. */
export function IdentityEditor({
  identity,
  initial,
  onClose,
  onSaved
}: {
  identity: Identity | null
  /** Prefill for a new identity (e.g. "save as identity" from a host). */
  initial?: Partial<IdentityInput>
  onClose(): void
  onSaved?(identity: Identity): void
}) {
  const t = useT()
  const keys = useApp((s) => s.snapshot!.keys)
  const [form, setForm] = useState<IdentityInput>(() => ({
    id: identity?.id,
    label: identity?.label ?? initial?.label ?? '',
    username: identity?.username ?? initial?.username ?? '',
    keyId: identity?.keyId ?? initial?.keyId ?? null
  }))
  const [password, setPassword] = useState(initial?.password ?? '')
  const [clearPassword, setClearPassword] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [passwordLoaded, setPasswordLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadSavedPassword = async (): Promise<string> => {
    if (!passwordLoaded && identity?.hasPassword && identity.id) {
      const pw = await api.getIdentityPassword(identity.id)
      setPassword(pw || '')
      setPasswordLoaded(true)
      return pw || ''
    }
    return password
  }

  const toggleShowPassword = async (): Promise<void> => {
    if (!showPassword) {
      await loadSavedPassword()
    }
    setShowPassword(!showPassword)
  }

  const copyPassword = async (): Promise<void> => {
    const pw = await loadSavedPassword()
    if (pw) {
      await navigator.clipboard.writeText(pw)
      useApp.getState().toast(t('passwordCopied'))
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const pw = clearPassword ? '' : (passwordLoaded || password) ? password : undefined
    const saved = await attempt(() => api.saveIdentity({ ...form, password: pw }))
    setBusy(false)
    if (!saved) return
    onSaved?.(saved)
    onClose()
  }

  return (
    <Drawer title={identity ? t('edit') : t('newIdentity')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={form.label} placeholder={form.username} onChange={(e) => setForm({ ...form, label: e.target.value })} autoFocus />
        </Field>
        <Field label={t('username')}>
          <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
        </Field>
        <Field label={identity?.hasPassword ? t('passwordKeep') : t('password')}>
          <div className="input-group">
            <input
              className="input"
              type={showPassword ? 'text' : 'password'}
              value={password}
              placeholder={identity?.hasPassword && !passwordLoaded && !password ? '••••••••' : ''}
              disabled={clearPassword}
              onChange={(e) => {
                setPassword(e.target.value)
                setPasswordLoaded(true)
              }}
            />
            <div className="input-group-actions">
              <button
                type="button"
                className="input-action-btn"
                title={showPassword ? t('hidePassword') : t('showPassword')}
                onClick={toggleShowPassword}
                disabled={clearPassword || (!identity?.hasPassword && !password)}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={15} />
              </button>
              <button
                type="button"
                className="input-action-btn"
                title={t('copyPassword')}
                onClick={copyPassword}
                disabled={clearPassword || (!identity?.hasPassword && !password)}
              >
                <Icon name="copy" size={15} />
              </button>
            </div>
          </div>
        </Field>
        {identity?.hasPassword && <Check label={t('removePassword')} checked={clearPassword} onChange={setClearPassword} />}
        <Field label={t('key')}>
          <select className="input" value={form.keyId ?? ''} onChange={(e) => setForm({ ...form, keyId: e.target.value || null })}>
            <option value="">{t('none')}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({k.type})
              </option>
            ))}
          </select>
        </Field>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Drawer>
  )
}

export function Identities() {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const [editing, setEditing] = useState<Identity | null | undefined>(undefined)
  const usage = (id: string): number => snap.hosts.filter((h) => h.identityId === id).length

  const remove = async (i: Identity): Promise<void> => {
    const msg = t('deleteIdentityConfirm').replace('{name}', i.label).replace('{n}', String(usage(i.id)))
    if (confirm(msg)) await attempt(() => api.deleteIdentity(i.id))
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('identities')}</h1>
        <button className="btn primary" onClick={() => setEditing(null)}>
          <Icon name="plus" /> {t('newIdentity')}
        </button>
      </div>
      <p className="note" style={{ marginTop: -6, marginBottom: 16 }}>
        {t('identitiesHint')}
      </p>
      {snap.identities.length === 0 ? (
        <div className="empty">{t('noIdentities')}</div>
      ) : (
        <div className="list">
          {[...snap.identities]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((i) => {
              const key = i.keyId ? snap.keys.find((k) => k.id === i.keyId) : undefined
              return (
                <div key={i.id} className="list-item">
                  <Icon name="user" size={18} />
                  <div className="grow">
                    <div>
                      <b>{i.label}</b> <span className="dim mono">{i.username}</span>
                    </div>
                    <div>
                      {i.hasPassword && <span className="chip">{t('passwordSaved')}</span>}
                      {key && (
                        <span className="chip">
                          {t('key')}: {key.label}
                        </span>
                      )}
                      <span className="chip">{t('usedBy').replace('{n}', String(usage(i.id)))}</span>
                    </div>
                  </div>
                  <button className="btn small icon" title={t('edit')} onClick={() => setEditing(i)}>
                    <Icon name="edit" />
                  </button>
                  <button className="btn small icon danger" title={t('delete')} onClick={() => remove(i)}>
                    <Icon name="trash" />
                  </button>
                </div>
              )
            })}
        </div>
      )}
      {editing !== undefined && <IdentityEditor identity={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}
