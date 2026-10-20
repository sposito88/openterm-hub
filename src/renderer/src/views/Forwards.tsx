import { useState, type FormEvent } from 'react'
import type { ForwardKind, ForwardRule } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'

type Draft = Omit<ForwardRule, 'id'> & { id?: string }

function RuleEditor({ rule, onClose }: { rule: Draft; onClose(): void }) {
  const t = useT()
  const hosts = useApp((s) => s.snapshot!.hosts).filter((h) => h.protocol === 'ssh')
  const [r, setR] = useState<Draft>(rule)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setR((x) => ({ ...x, [k]: v }))
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (await attempt(() => api.saveForward(r))) onClose()
  }
  return (
    <Drawer title={r.id ? t('edit') : t('newRule')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={r.label} onChange={(e) => set('label', e.target.value)} autoFocus />
        </Field>
        <Field label="Host">
          <select className="input" value={r.hostId} onChange={(e) => set('hostId', e.target.value)} required>
            <option value="" disabled>
              —
            </option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('kind')}>
          <select className="input" value={r.kind} onChange={(e) => set('kind', e.target.value as ForwardKind)}>
            <option value="local">{t('local')} (-L)</option>
            <option value="remote">{t('remote')} (-R)</option>
            <option value="dynamic">{t('dynamic')} (-D)</option>
          </select>
        </Field>
        <div className="row">
          <Field label={t('bindAddress')}>
            <input className="input" value={r.bindAddress} onChange={(e) => set('bindAddress', e.target.value)} />
          </Field>
          <Field label={t('bindPort')}>
            <input className="input" type="number" value={r.bindPort} onChange={(e) => set('bindPort', Number(e.target.value))} />
          </Field>
        </div>
        {r.kind !== 'dynamic' && (
          <div className="row">
            <Field label={t('destHost')}>
              <input className="input" value={r.destHost} onChange={(e) => set('destHost', e.target.value)} required />
            </Field>
            <Field label={t('destPort')}>
              <input className="input" type="number" value={r.destPort} onChange={(e) => set('destPort', Number(e.target.value))} />
            </Field>
          </div>
        )}
        <FormActions onCancel={onClose} />
      </form>
    </Drawer>
  )
}

function describe(r: ForwardRule): string {
  const bind = `${r.bindAddress}:${r.bindPort}`
  if (r.kind === 'dynamic') return `SOCKS5 ${bind}`
  const dest = `${r.destHost}:${r.destPort}`
  return r.kind === 'local' ? `${bind} → ${dest}` : `remote ${bind} → ${dest}`
}

export function Forwards() {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const status = useApp((s) => s.forwardStatus)
  const [editing, setEditing] = useState<Draft | null>(null)
  const blank: Draft = { label: '', hostId: snap.hosts[0]?.id ?? '', kind: 'local', bindAddress: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80 }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('forwards')}</h1>
        <button className="btn primary" onClick={() => setEditing(blank)}>
          <Icon name="plus" /> {t('newRule')}
        </button>
      </div>
      {snap.forwards.length === 0 ? (
        <div className="empty">{t('noRules')}</div>
      ) : (
        <div className="list">
          {snap.forwards.map((r) => {
            const st = status[r.id]
            const state = st?.state ?? 'stopped'
            const active = state === 'running' || state === 'starting'
            const host = snap.hosts.find((h) => h.id === r.hostId)
            return (
              <div key={r.id} className="list-item">
                <Icon name="tunnel" size={18} />
                <div className="grow">
                  <div>
                    <b>{r.label || describe(r)}</b>{' '}
                    <span className={`chip ${state === 'running' ? 'ok' : state === 'error' ? 'err' : ''}`}>{t(state)}</span>
                  </div>
                  <div className="dim mono truncate">
                    {describe(r)} via {host?.label ?? '?'}
                    {st?.error ? `: ${st.error}` : ''}
                  </div>
                </div>
                {active ? (
                  <button className="btn small" onClick={() => api.stopForward(r.id)}>
                    <Icon name="stop" /> {t('stop')}
                  </button>
                ) : (
                  <button className="btn small primary" onClick={() => attempt(() => api.startForward(r.id))}>
                    <Icon name="play" /> {t('start')}
                  </button>
                )}
                <button className="btn small icon" title={t('edit')} onClick={() => setEditing(r)} disabled={active}>
                  <Icon name="edit" />
                </button>
                <button
                  className="btn small icon danger"
                  title={t('delete')}
                  onClick={() => confirm(t('confirmDelete')) && attempt(() => api.deleteForward(r.id))}
                >
                  <Icon name="trash" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
