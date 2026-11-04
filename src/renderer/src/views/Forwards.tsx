import { useMemo, useState, type FormEvent } from 'react'
import type { ForwardKind, ForwardRule } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions, useViewMode, ViewToggle } from '../components/ui'
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useViewMode('forwards', 'grid')
  const blank: Draft = { label: '', hostId: snap.hosts[0]?.id ?? '', kind: 'local', bindAddress: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80 }

  const visibleForwards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return snap.forwards.filter((r) => {
      if (!q) return true
      const host = snap.hosts.find((h) => h.id === r.hostId)
      return [r.label, describe(r), host?.label ?? ''].some((v) => v.toLowerCase().includes(q))
    })
  }, [snap.forwards, snap.hosts, query])

  return (
    <div className="page" onClick={() => setSelectedId(null)}>
      <div className="page-head" onClick={(e) => e.stopPropagation()}>
        <h1>{t('forwards')}</h1>
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={() => setEditing(blank)}>
          <Icon name="plus" /> {t('newRule')}
        </button>
      </div>
      {visibleForwards.length === 0 ? (
        <div className="empty">{t('noRules')}</div>
      ) : (
        <div className={viewMode === 'grid' ? 'cards' : 'cards list-mode'}>
          {visibleForwards.map((r) => {
            const st = status[r.id]
            const state = st?.state ?? 'stopped'
            const active = state === 'running' || state === 'starting'
            const host = snap.hosts.find((h) => h.id === r.hostId)
            return (
              <div
                key={r.id}
                tabIndex={0}
                className={`card ${selectedId === r.id ? 'selected' : ''}`}
                title={t('doubleClickToEdit')}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedId(r.id)
                }}
                onFocus={() => setSelectedId(r.id)}
                onDoubleClick={() => {
                  if (!active) setEditing(r)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !active) {
                    e.preventDefault()
                    setEditing(r)
                  } else if (e.key === 'Delete') {
                    e.preventDefault()
                    if (confirm(t('confirmDelete'))) void attempt(() => api.deleteForward(r.id))
                  }
                }}
              >
                <div className="card-icon">
                  <Icon name="tunnel" size={18} />
                </div>
                <div className="card-body">
                  <div className="card-title">{r.label || describe(r)}</div>
                  <div className="card-sub mono">
                    {describe(r)} via {host?.label ?? '?'}
                    {st?.error ? `: ${st.error}` : ''}
                  </div>
                  <div className="card-chips">
                    <span className={`chip ${state === 'running' ? 'ok' : state === 'error' ? 'err' : ''}`}>{t(state)}</span>
                  </div>
                </div>
                <div className="card-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
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
              </div>
            )
          })}
        </div>
      )}
      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
