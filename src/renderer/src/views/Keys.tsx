import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AgentKey, GeneratedKeyRequest, SshKey } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions, useViewMode, ViewToggle } from '../components/ui'
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

/**
 * Keys in the system ssh-agent, including FIDO2 security keys (YubiKey…),
 * which never leave the device and are used through the agent.
 */
function AgentKeys() {
  const t = useT()
  const [keys, setKeys] = useState<AgentKey[] | null>(null)
  const load = (): void => void api.listAgentKeys().then(setKeys, () => setKeys([]))
  useEffect(load, [])
  return (
    <>
      <div className="page-head" style={{ marginTop: 28 }}>
        <h1 style={{ fontSize: 15 }}>{t('agentKeys')}</h1>
        <button className="btn small" onClick={load}>
          <Icon name="refresh" /> {t('refresh')}
        </button>
      </div>
      <p className="note">{t('agentKeysHint')}</p>
      {keys && keys.length === 0 ? (
        <div className="empty" style={{ padding: '16px 0' }}>
          {t('noAgentKeys')}
        </div>
      ) : (
        <div className="list">
          {keys?.map((k) => (
            <div key={k.fingerprint} className="list-item">
              <Icon name={k.securityKey ? 'shield' : 'key'} size={18} />
              <div className="grow">
                <div>
                  <b>{k.comment || k.type}</b> <span className="chip">{k.type}</span>
                  {k.securityKey && <span className="chip ok">FIDO2</span>}
                </div>
                <div className="dim mono truncate selectable">{k.fingerprint}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <details className="note" style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer' }}>{t('fidoHowTo')}</summary>
        <pre className="mono selectable fido-howto">{`ssh-keygen -t ed25519-sk -C "minha-yubikey"
ssh-add ~/.ssh/id_ed25519_sk
ssh-copy-id -i ~/.ssh/id_ed25519_sk.pub usuario@servidor`}</pre>
        <p>{t('fidoHowToHint')}</p>
      </details>
    </>
  )
}

function EditKeyDrawer({ keyItem, onClose }: { keyItem: SshKey; onClose(): void }) {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const [label, setLabel] = useState(keyItem.label)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const ok = await attempt(() => api.renameKey(keyItem.id, label))
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Drawer title={t('editKey')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus required />
        </Field>
        <Field label={t('type')}>
          <input className="input" value={keyItem.type} disabled />
        </Field>
        <Field label={t('fingerprint')}>
          <input className="input mono" value={keyItem.fingerprint} readOnly />
        </Field>
        <Field label={t('copyPublic')}>
          <textarea className="input mono" rows={4} value={keyItem.publicKey} readOnly />
        </Field>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            void navigator.clipboard.writeText(keyItem.publicKey)
            toast(t('copied'))
          }}
        >
          <Icon name="copy" /> {t('copyPublic')}
        </button>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Drawer>
  )
}

export function Keys() {
  const t = useT()
  const keys = useApp((s) => s.snapshot!.keys)
  const toast = useApp((s) => s.toast)
  const [mode, setMode] = useState<'generate' | 'import' | null>(null)
  const [editing, setEditing] = useState<SshKey | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useViewMode('keys', 'grid')
  const [installFor, setInstallFor] = useState<string | null>(null)

  const visibleKeys = useMemo(() => {
    const q = query.trim().toLowerCase()
    return keys.filter((k) => !q || k.label.toLowerCase().includes(q) || k.type.toLowerCase().includes(q) || k.fingerprint.toLowerCase().includes(q))
  }, [keys, query])

  const removeKey = (k: SshKey): void => {
    if (confirm(`${t('confirmDelete')}\n${k.label}`)) void attempt(() => api.deleteKey(k.id))
  }

  return (
    <div className="page" onClick={() => setSelectedId(null)}>
      <div className="page-head" onClick={(e) => e.stopPropagation()}>
        <h1>{t('keys')}</h1>
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" onClick={() => setMode('import')}>
          <Icon name="import" /> {t('importKey')}
        </button>
        <button className="btn primary" onClick={() => setMode('generate')}>
          <Icon name="plus" /> {t('generateKey')}
        </button>
      </div>
      {visibleKeys.length === 0 ? (
        <div className="empty">{t('noKeys')}</div>
      ) : (
        <div className={viewMode === 'grid' ? 'cards' : 'cards list-mode'}>
          {visibleKeys.map((k) => (
            <div
              key={k.id}
              tabIndex={0}
              className={`card ${selectedId === k.id ? 'selected' : ''}`}
              title={t('doubleClickToEdit')}
              onClick={(e) => {
                e.stopPropagation()
                setSelectedId(k.id)
              }}
              onFocus={() => setSelectedId(k.id)}
              onDoubleClick={() => setEditing(k)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setEditing(k)
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  removeKey(k)
                }
              }}
            >
              <div className="card-icon">
                <Icon name="key" size={18} />
              </div>
              <div className="card-body">
                <div className="card-title">{k.label}</div>
                <div className="card-sub mono selectable">{k.fingerprint}</div>
                <div className="card-chips">
                  <span className="chip">{k.type}</span>
                  {k.hasPassphrase && <span className="chip">passphrase</span>}
                </div>
              </div>
              <div className="card-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <button
                  className="btn small icon"
                  title={t('copyPublic')}
                  onClick={() => {
                    void navigator.clipboard.writeText(k.publicKey)
                    toast(t('copied'))
                  }}
                >
                  <Icon name="copy" />
                </button>
                <div style={{ position: 'relative' }}>
                  <button className="btn small" onClick={() => setInstallFor(installFor === k.id ? null : k.id)}>
                    {t('installOn')}
                  </button>
                  {installFor === k.id && <InstallMenu keyItem={k} onClose={() => setInstallFor(null)} />}
                </div>
                <button className="btn small icon" title={t('exportKey')} onClick={() => attempt(() => api.exportPrivateKey(k.id))}>
                  <Icon name="download" />
                </button>
                <button className="btn small icon" title={t('edit')} onClick={() => setEditing(k)}>
                  <Icon name="edit" />
                </button>
                <button className="btn small icon danger" title={t('delete')} onClick={() => removeKey(k)}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <AgentKeys />
      {mode === 'generate' && <GenerateForm onClose={() => setMode(null)} />}
      {mode === 'import' && <ImportForm onClose={() => setMode(null)} />}
      {editing && <EditKeyDrawer keyItem={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
