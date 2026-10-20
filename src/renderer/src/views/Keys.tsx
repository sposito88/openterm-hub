import { useState, type FormEvent } from 'react'
import type { GeneratedKeyRequest, SshKey } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'

function GenerateForm({ onClose }: { onClose(): void }) {
  const t = useT()
  const [req, setReq] = useState<GeneratedKeyRequest>({ label: '', type: 'ed25519', passphrase: '' })
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const ok = await attempt(() => api.generateKey({ ...req, label: req.label.trim() || `${req.type}-key` }))
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Drawer title={t('generateKey')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={req.label} onChange={(e) => setReq({ ...req, label: e.target.value })} autoFocus />
        </Field>
        <div className="row">
          <Field label={t('type')}>
            <select
              className="input"
              value={req.type}
              onChange={(e) => {
                const type = e.target.value as GeneratedKeyRequest['type']
                setReq({ ...req, type, bits: type === 'rsa' ? 4096 : type === 'ecdsa' ? 256 : undefined })
              }}
            >
              <option value="ed25519">Ed25519</option>
              <option value="rsa">RSA</option>
              <option value="ecdsa">ECDSA</option>
            </select>
          </Field>
          {req.type !== 'ed25519' && (
            <Field label={t('bits')}>
              <select className="input" value={req.bits} onChange={(e) => setReq({ ...req, bits: Number(e.target.value) })}>
                {(req.type === 'rsa' ? [2048, 3072, 4096] : [256, 384, 521]).map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <Field label={t('passphrase')}>
          <input className="input" type="password" value={req.passphrase} onChange={(e) => setReq({ ...req, passphrase: e.target.value })} />
        </Field>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Drawer>
  )
}

function ImportForm({ onClose }: { onClose(): void }) {
  const t = useT()
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (await attempt(() => api.importKey({ label: label.trim() || 'imported-key', privateKey, passphrase }))) onClose()
  }
  const fromFile = async (): Promise<void> => {
    const text = await attempt(() => api.importKeyFile())
    if (text) setPrivateKey(text)
  }
  return (
    <Drawer title={t('importKey')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <Field label={t('privateKey')}>
          <textarea className="input mono" rows={8} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} required />
        </Field>
        <button type="button" className="btn small" onClick={fromFile}>
          {t('fromFile')}
        </button>
        <div style={{ height: 12 }} />
        <Field label={t('passphrase')}>
          <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        <FormActions onCancel={onClose} />
      </form>
    </Drawer>
  )
}

function InstallMenu({ keyItem, onClose }: { keyItem: SshKey; onClose(): void }) {
  const t = useT()
  const hosts = useApp((s) => s.snapshot!.hosts).filter((h) => h.protocol === 'ssh')
  const toast = useApp((s) => s.toast)
  return (
    <div className="menu" style={{ right: 0 }} onMouseLeave={onClose}>
      {hosts.map((h) => (
        <button
          key={h.id}
          onClick={async () => {
            onClose()
            const ok = await attempt(() => api.installKeyOnHost(keyItem.id, h.id).then(() => true))
            if (ok) toast(`${t('installed')} ${h.label}`)
          }}
        >
          {h.label}
        </button>
      ))}
    </div>
  )
}

export function Keys() {
  const t = useT()
  const keys = useApp((s) => s.snapshot!.keys)
  const toast = useApp((s) => s.toast)
  const [mode, setMode] = useState<'generate' | 'import' | null>(null)
  const [installFor, setInstallFor] = useState<string | null>(null)

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('keys')}</h1>
        <button className="btn" onClick={() => setMode('import')}>
          <Icon name="import" /> {t('importKey')}
        </button>
        <button className="btn primary" onClick={() => setMode('generate')}>
          <Icon name="plus" /> {t('generateKey')}
        </button>
      </div>
      {keys.length === 0 ? (
        <div className="empty">{t('noKeys')}</div>
      ) : (
        <div className="list">
          {keys.map((k) => (
            <div key={k.id} className="list-item">
              <Icon name="key" size={18} />
              <div className="grow">
                <div>
                  <b>{k.label}</b> <span className="chip">{k.type}</span>
                  {k.hasPassphrase && <span className="chip">passphrase</span>}
                </div>
                <div className="dim mono truncate selectable">{k.fingerprint}</div>
              </div>
              <button
                className="btn small"
                onClick={() => {
                  void navigator.clipboard.writeText(k.publicKey)
                  toast(t('copied'))
                }}
              >
                <Icon name="copy" /> {t('copyPublic')}
              </button>
              <div style={{ position: 'relative' }}>
                <button className="btn small" onClick={() => setInstallFor(installFor === k.id ? null : k.id)}>
                  {t('installOn')}
                </button>
                {installFor === k.id && <InstallMenu keyItem={k} onClose={() => setInstallFor(null)} />}
              </div>
              <button className="btn small" onClick={() => attempt(() => api.exportPrivateKey(k.id))}>
                <Icon name="download" /> {t('exportKey')}
              </button>
              <button
                className="btn small icon danger"
                title={t('delete')}
                onClick={() => confirm(`${t('confirmDelete')}\n${k.label}`) && attempt(() => api.deleteKey(k.id))}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
      {mode === 'generate' && <GenerateForm onClose={() => setMode(null)} />}
      {mode === 'import' && <ImportForm onClose={() => setMode(null)} />}
    </div>
  )
}
