import { useState } from 'react'
import type { Workspace, WorkspacePane, SessionTarget } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'

export function Workspaces() {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const openWorkspace = useApp((s) => s.openWorkspace)
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>('horizontal')
  const [selectedHosts, setSelectedHosts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const workspaces = snap.workspaces ?? []

  const hostName = (target: SessionTarget): string => {
    if (target.kind === 'host') {
      return snap.hosts.find((h) => h.id === target.hostId)?.label ?? 'Host'
    }
    return target.kind === 'local' ? 'Terminal local' : 'Serial'
  }

  const remove = async (ws: Workspace): Promise<void> => {
    const msg = t('deleteWorkspaceConfirm').replace('{name}', ws.label)
    if (confirm(msg)) await attempt(() => api.deleteWorkspace(ws.id))
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (selectedHosts.length === 0) return
    setBusy(true)
    const panes: WorkspacePane[] = selectedHosts.map((hId, i) => {
      if (hId === '__local__') {
        return { id: `p${i + 1}`, target: { kind: 'local' }, title: 'Terminal local' }
      }
      const h = snap.hosts.find((x) => x.id === hId)
      return { id: `p${i + 1}`, target: { kind: 'host', hostId: hId }, title: h?.label }
    })
    const wsName = label.trim() || t('workspace')
    const saved = await attempt(() => api.saveWorkspace({ label: wsName, layout, panes }))
    setBusy(false)
    if (saved) {
      setCreating(false)
      setLabel('')
      setSelectedHosts([])
      openWorkspace(saved)
    }
  }

  const toggleHost = (id: string): void => {
    setSelectedHosts((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('workspaces')}</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {t('newWorkspace')}
        </button>
      </div>
      <p className="note" style={{ marginTop: -6, marginBottom: 16 }}>
        {t('saveWorkspaceHint')}
      </p>

      {workspaces.length === 0 ? (
        <div className="empty">{t('noWorkspaces')}</div>
      ) : (
        <div className="list">
          {workspaces.map((ws) => (
            <div key={ws.id} className="list-item">
              <Icon name="workspace" size={20} />
              <div className="grow">
                <div>
                  <b>{ws.label}</b>
                </div>
                <div style={{ marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="chip">
                    <Icon name={ws.layout === 'horizontal' ? 'splitHorizontal' : 'splitVertical'} size={12} />
                    <span>{ws.layout === 'horizontal' ? t('layoutHorizontal') : t('layoutVertical')}</span>
                  </span>
                  <span className="chip">{t('hostsCount').replace('{n}', String(ws.panes.length))}</span>
                  <span className="dim" style={{ fontSize: 12 }}>
                    {ws.panes.map((p) => p.title || hostName(p.target)).join(' · ')}
                  </span>
                </div>
              </div>
              <button className="btn small primary" onClick={() => openWorkspace(ws)}>
                <Icon name="play" size={13} /> {t('openWorkspace')}
              </button>
              <button className="btn small icon danger" title={t('delete')} onClick={() => remove(ws)}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Drawer title={t('newWorkspace')} onClose={() => setCreating(false)}>
          <form onSubmit={submit}>
            <Field label={t('label')}>
              <input
                className="input"
                autoFocus
                value={label}
                placeholder="Ex.: Cluster Web + DB"
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </Field>

            <Field label="Layout">
              <div className="segmented">
                <button
                  type="button"
                  className={layout === 'horizontal' ? 'on' : ''}
                  onClick={() => setLayout('horizontal')}
                >
                  <Icon name="splitHorizontal" size={13} />
                  <span>{t('layoutHorizontal')}</span>
                </button>
                <button
                  type="button"
                  className={layout === 'vertical' ? 'on' : ''}
                  onClick={() => setLayout('vertical')}
                >
                  <Icon name="splitVertical" size={13} />
                  <span>{t('layoutVertical')}</span>
                </button>
              </div>
            </Field>

            <Field label="Servidores a incluir (selecione 2 ou mais)">
              <div className="list" style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
                <label key="__local__" className="list-item" style={{ cursor: 'pointer', padding: '6px 10px' }}>
                  <input
                    type="checkbox"
                    checked={selectedHosts.includes('__local__')}
                    onChange={() => toggleHost('__local__')}
                  />
                  <Icon name="terminal" size={15} />
                  <span>Terminal local</span>
                </label>
                {snap.hosts.map((h) => (
                  <label key={h.id} className="list-item" style={{ cursor: 'pointer', padding: '6px 10px' }}>
                    <input
                      type="checkbox"
                      checked={selectedHosts.includes(h.id)}
                      onChange={() => toggleHost(h.id)}
                    />
                    <Icon name="server" size={15} />
                    <div className="grow">
                      <b>{h.label}</b> <span className="dim mono">{h.username ? `${h.username}@` : ''}{h.hostname}</span>
                    </div>
                  </label>
                ))}
              </div>
            </Field>

            <FormActions onCancel={() => setCreating(false)} busy={busy || selectedHosts.length === 0} />
          </form>
        </Drawer>
      )}
    </div>
  )
}
