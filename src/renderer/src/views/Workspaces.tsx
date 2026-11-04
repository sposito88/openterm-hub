import { useMemo, useState } from 'react'
import type { Workspace, WorkspacePane, SessionTarget } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field, FormActions, useViewMode, ViewToggle } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'

export function Workspaces() {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const openWorkspace = useApp((s) => s.openWorkspace)
  const [editing, setEditing] = useState<Workspace | null | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useViewMode('workspaces', 'grid')
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

  const startCreate = (): void => {
    setLabel('')
    setLayout('horizontal')
    setSelectedHosts([])
    setEditing(null)
  }

  const startEdit = (ws: Workspace): void => {
    setLabel(ws.label)
    setLayout(ws.layout)
    setSelectedHosts(
      ws.panes.map((p) => (p.target.kind === 'local' ? '__local__' : p.target.kind === 'host' ? p.target.hostId : '__local__'))
    )
    setEditing(ws)
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
    const saved = await attempt(() => api.saveWorkspace({ id: editing?.id, label: wsName, layout, panes }))
    setBusy(false)
    if (saved) {
      const wasCreate = !editing
      setEditing(undefined)
      setLabel('')
      setSelectedHosts([])
      if (wasCreate) openWorkspace(saved)
    }
  }

  const toggleHost = (id: string): void => {
    setSelectedHosts((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const visibleWorkspaces = useMemo(() => {
    const q = query.trim().toLowerCase()
    return workspaces.filter(
      (ws) =>
        !q ||
        ws.label.toLowerCase().includes(q) ||
        ws.panes.some((p) => (p.title || hostName(p.target)).toLowerCase().includes(q))
    )
  }, [workspaces, query, snap.hosts])

  return (
    <div className="page" onClick={() => setSelectedId(null)}>
      <div className="page-head" onClick={(e) => e.stopPropagation()}>
        <h1>{t('workspaces')}</h1>
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={startCreate}>
          <Icon name="plus" /> {t('newWorkspace')}
        </button>
      </div>
      <p className="note" style={{ marginTop: -6, marginBottom: 16 }}>
        {t('saveWorkspaceHint')}
      </p>

      {visibleWorkspaces.length === 0 ? (
        <div className="empty">{t('noWorkspaces')}</div>
      ) : (
        <div className={viewMode === 'grid' ? 'cards' : 'cards list-mode'}>
          {visibleWorkspaces.map((ws) => (
            <div
              key={ws.id}
              tabIndex={0}
              className={`card ${selectedId === ws.id ? 'selected' : ''}`}
              title={t('doubleClickToEdit')}
              onClick={(e) => {
                e.stopPropagation()
                setSelectedId(ws.id)
              }}
              onFocus={() => setSelectedId(ws.id)}
              onDoubleClick={() => startEdit(ws)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  startEdit(ws)
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  void remove(ws)
                }
              }}
            >
              <div className="card-icon">
                <Icon name="workspace" size={18} />
              </div>
              <div className="card-body">
                <div className="card-title">{ws.label}</div>
                <div className="card-sub">
                  {ws.panes.map((p) => p.title || hostName(p.target)).join(' · ')}
                </div>
                <div className="card-chips">
                  <span className="chip">
                    <Icon name={ws.layout === 'horizontal' ? 'splitHorizontal' : 'splitVertical'} size={12} />
                    <span>{ws.layout === 'horizontal' ? t('layoutHorizontal') : t('layoutVertical')}</span>
                  </span>
                  <span className="chip">{t('hostsCount').replace('{n}', String(ws.panes.length))}</span>
                </div>
              </div>
              <div className="card-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <button className="btn small primary" title={t('openWorkspace')} onClick={() => openWorkspace(ws)}>
                  <Icon name="play" size={13} /> {t('openWorkspace')}
                </button>
                <button className="btn small icon" title={t('edit')} onClick={() => startEdit(ws)}>
                  <Icon name="edit" />
                </button>
                <button className="btn small icon danger" title={t('delete')} onClick={() => remove(ws)}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <Drawer title={editing ? t('editWorkspace') : t('newWorkspace')} onClose={() => setEditing(undefined)}>
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

            <Field label="Servidores a incluir (selecione 1 ou mais)">
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

            <FormActions onCancel={() => setEditing(undefined)} busy={busy || selectedHosts.length === 0} />
          </form>
        </Drawer>
      )}
    </div>
  )
}
