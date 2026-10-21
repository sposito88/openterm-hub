import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Host, SerialPortInfo } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { GroupBadge, HostBadge, OsGlyph } from '../components/OsIcon'
import { Drawer, Field, FormActions } from '../components/ui'
import { translate, useT } from '../i18n'
import { attempt, useApp } from '../state'
import { HostEditor } from './HostEditor'

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

export function connectHost(host: Host): void {
  useApp.getState().openTab('terminal', host.label, { kind: 'host', hostId: host.id })
}

export function openSftp(host: Host): void {
  useApp.getState().openTab('sftp', `SFTP · ${host.label}`, { kind: 'host', hostId: host.id })
}

export function openLocal(): void {
  useApp.getState().openTab('terminal', translate('localTerminal'), { kind: 'local' })
}

function normalizeGroupPath(name: string): string {
  return name
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
}

function SerialDialog({ onClose }: { onClose(): void }) {
  const t = useT()
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null)
  const [path, setPath] = useState('')
  const [baud, setBaud] = useState(115200)

  useEffect(() => {
    void attempt(() => api.listSerialPorts()).then((p) => {
      setPorts(p ?? [])
      if (p?.[0]) setPath(p[0].path)
    })
  }, [])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!path) return
    useApp.getState().openTab('terminal', `${path}`, { kind: 'serial', path, baudRate: baud })
    onClose()
  }

  return (
    <Drawer title={t('serial')} onClose={onClose}>
      <form onSubmit={submit}>
        {ports && ports.length === 0 && <p className="note">{t('noPorts')}</p>}
        <Field label={t('serialPort')}>
          <input className="input" list="serial-ports" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/dev/ttyUSB0" />
          <datalist id="serial-ports">
            {ports?.map((p) => (
              <option key={p.path} value={p.path}>
                {p.manufacturer}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label={t('baudRate')}>
          <select className="input" value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
            {BAUD_RATES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Field>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary">{t('open')}</button>
        </div>
      </form>
    </Drawer>
  )
}

function GroupEditor({
  groupPath,
  parentDefault = '',
  onClose,
  onSaved
}: {
  /** Existing full group path when editing; null when creating a new group. */
  groupPath: string | null
  parentDefault?: string
  onClose(): void
  onSaved?(newPath: string): void
}) {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const parts = groupPath ? groupPath.split(' / ') : []
  const initialLeaf = groupPath ? parts[parts.length - 1] : ''
  const initialParent = groupPath ? parts.slice(0, -1).join(' / ') : parentDefault

  const [name, setName] = useState(initialLeaf)
  const [parent, setParent] = useState(initialParent)
  const [hostSearch, setHostSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (!groupPath) return new Set()
    return new Set(snap.hosts.filter((h) => h.group === groupPath).map((h) => h.id))
  })
  const [busy, setBusy] = useState(false)

  const allParentOptions = useMemo(() => {
    const set = new Set<string>()
    for (const raw of [...(snap.groups ?? []), ...snap.hosts.map((h) => h.group)]) {
      const segs = normalizeGroupPath(raw).split(' / ').filter(Boolean)
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join(' / ')
        if (!groupPath || (prefix !== groupPath && !prefix.startsWith(groupPath + ' / '))) {
          set.add(prefix)
        }
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [snap.groups, snap.hosts, groupPath])

  const filteredHosts = useMemo(() => {
    const q = hostSearch.trim().toLowerCase()
    return [...snap.hosts]
      .filter((h) => !q || h.label.toLowerCase().includes(q) || h.hostname.toLowerCase().includes(q) || h.group.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [snap.hosts, hostSearch])

  const toggleHost = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const cleanLeaf = normalizeGroupPath(name)
    if (!cleanLeaf) return
    const cleanParent = normalizeGroupPath(parent)
    const fullPath = cleanParent ? `${cleanParent} / ${cleanLeaf}` : cleanLeaf
    setBusy(true)
    const res = await attempt(() => api.saveGroup(fullPath, groupPath ?? undefined, [...selectedIds]))
    setBusy(false)
    if (res !== undefined) {
      onSaved?.(fullPath)
      onClose()
    }
  }

  return (
    <Drawer title={groupPath ? t('editGroup') : t('newGroup')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('groupName')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </Field>
        <Field label={t('parentGroup')}>
          <input className="input" list="parent-groups" value={parent} onChange={(e) => setParent(e.target.value)} placeholder={t('none')} />
          <datalist id="parent-groups">
            {allParentOptions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Field>
        {snap.hosts.length > 0 && (
          <Field label={`${t('groupHosts')} (${selectedIds.size})`}>
            <input
              className="input"
              style={{ marginBottom: 6 }}
              placeholder={t('searchHosts')}
              value={hostSearch}
              onChange={(e) => setHostSearch(e.target.value)}
            />
            <div className="list" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {filteredHosts.map((h) => (
                <label key={h.id} className="list-item" style={{ cursor: 'pointer', padding: '7px 12px' }}>
                  <input type="checkbox" checked={selectedIds.has(h.id)} onChange={() => toggleHost(h.id)} />
                  <HostBadge host={h} />
                  <div className="grow truncate">
                    <div className="truncate" style={{ fontWeight: 500 }}>
                      {h.label}
                    </div>
                    <div className="dim truncate" style={{ fontSize: 11 }}>
                      {h.hostname}
                      {h.group ? ` · ${h.group}` : ''}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </Field>
        )}
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Drawer>
  )
}

function ImportDrawer({ onClose }: { onClose(): void }) {
  const t = useT()
  const toast = useApp((s) => s.toast)

  const importConfig = async (): Promise<void> => {
    const n = await attempt(() => api.importSshConfig())
    if (n !== undefined) {
      toast(`${t('imported')}: ${n} hosts`)
      onClose()
    }
  }

  const importFile = async (): Promise<void> => {
    const res = await attempt(() => api.importBackup())
    if (!res) return
    if (res === 'backup') {
      toast(t('imported'))
    } else {
      toast(`${t('imported')}: ${res.hosts} hosts, ${res.identities} ${t('identities').toLowerCase()}, ${res.keys} ${t('keys').toLowerCase()}`)
    }
    onClose()
  }

  return (
    <Drawer title={t('importMenu')} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button type="button" className="btn" style={{ height: 38, justifyContent: 'flex-start' }} onClick={importConfig}>
          <Icon name="import" /> {t('importSshConfig')}
        </button>
        <button type="button" className="btn" style={{ height: 38, justifyContent: 'flex-start' }} onClick={importFile}>
          <Icon name="folder" /> {t('importBackup')}
        </button>
        <p className="note">{t('importHint')}</p>
      </div>
    </Drawer>
  )
}

interface GroupCardItem {
  fullPath: string
  displayName: string
  parentPath: string
  hostCount: number
}

export function Hosts() {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const [query, setQuery] = useState('')
  const [currentGroup, setCurrentGroup] = useState('')
  const [editing, setEditing] = useState<Host | null | undefined>(undefined)
  const [editingGroup, setEditingGroup] = useState<{ path: string | null; parent: string } | undefined>(undefined)
  const [serial, setSerial] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)

  // The "open serial connection" shortcut lands here.
  useEffect(() => {
    const open = (): void => setSerial(true)
    window.addEventListener('openterm:serial', open)
    return () => window.removeEventListener('openterm:serial', open)
  }, [])

  // Close the "+ New host" chevron dropdown on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (splitRef.current && !splitRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  /** Username shown for a host: its identity's when it has one. */
  const userOf = (h: Host): string => (h.identityId ? (snap.identities.find((i) => i.id === h.identityId)?.username ?? '') : h.username)

  const allGroups = useMemo<GroupCardItem[]>(() => {
    const paths = new Set<string>()
    for (const raw of [...(snap.groups ?? []), ...snap.hosts.map((h) => h.group)]) {
      const clean = normalizeGroupPath(raw)
      if (!clean) continue
      const parts = clean.split(' / ')
      for (let i = 1; i <= parts.length; i++) {
        paths.add(parts.slice(0, i).join(' / '))
      }
    }
    return [...paths]
      .map((fullPath) => {
        const parts = fullPath.split(' / ')
        const displayName = parts[parts.length - 1]
        const parentPath = parts.slice(0, -1).join(' / ')
        const hostCount = snap.hosts.filter((h) => {
          const g = normalizeGroupPath(h.group)
          return g === fullPath || g.startsWith(fullPath + ' / ')
        }).length
        return { fullPath, displayName, parentPath, hostCount }
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [snap.groups, snap.hosts])

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allGroups.filter((g) => {
      const inCurrentLevel = g.parentPath === currentGroup
      if (!q) return inCurrentLevel
      const underCurrent = !currentGroup || g.fullPath.startsWith(currentGroup + ' / ')
      return underCurrent && g.fullPath.toLowerCase().includes(q)
    })
  }, [allGroups, currentGroup, query])

  const visibleHosts = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchQuery = (h: Host): boolean =>
      !q || [h.label, h.hostname, userOf(h), h.group, ...(h.tags ?? [])].some((v) => v.toLowerCase().includes(q))
    const matchGroup = (h: Host): boolean => {
      if (!currentGroup) return true
      const g = normalizeGroupPath(h.group)
      return g === currentGroup || g.startsWith(currentGroup + ' / ')
    }
    return snap.hosts.filter((h) => matchGroup(h) && matchQuery(h)).sort((a, b) => a.label.localeCompare(b.label))
  }, [snap.hosts, snap.identities, currentGroup, query])

  const removeHost = async (h: Host): Promise<void> => {
    if (confirm(`${t('confirmDelete')}\n${h.label}`)) await attempt(() => api.deleteHost(h.id))
  }

  const removeGroup = async (g: GroupCardItem): Promise<void> => {
    if (!confirm(t('deleteGroupConfirm').replace('{name}', g.fullPath))) return
    await attempt(() => api.deleteGroup(g.fullPath))
    if (currentGroup === g.fullPath || currentGroup.startsWith(g.fullPath + ' / ')) {
      setCurrentGroup(g.parentPath)
    }
  }

  const breadcrumbs = currentGroup ? currentGroup.split(' / ') : []

  const formatHostCount = (n: number): string => (n === 1 ? t('hostSingular') : t('hostPlural').replace('{n}', String(n)))

  return (
    <div className="page">
      <div className="page-head">
        <div className="split-btn-wrap" ref={splitRef}>
          <button className="btn split-main" onClick={() => setEditing(null)}>
            <Icon name="plus" size={15} /> {t('newHost')}
          </button>
          <button
            className={`btn split-chevron${menuOpen ? ' open' : ''}`}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={t('actions')}
            title={t('actions')}
          >
            <Icon name={menuOpen ? 'chevronUp' : 'chevronDown'} size={14} />
          </button>
          {menuOpen && (
            <div className="split-dropdown">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setEditingGroup({ path: null, parent: currentGroup })
                }}
              >
                <OsGlyph kind="group" size={16} />
                <span>{t('newGroup')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setImportOpen(true)
                }}
              >
                <Icon name="import" size={16} />
                <span>{t('importMenu')}</span>
              </button>
            </div>
          )}
        </div>

        <button className="btn ghost-tool" onClick={openLocal}>
          <Icon name="terminal" size={15} /> {t('terminalBtn')}
        </button>
        <button className="btn ghost-tool" onClick={() => setSerial(true)}>
          <Icon name="plug" size={15} /> {t('serial')}
        </button>

        <div style={{ marginLeft: 'auto' }}>
          <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {!snap.secureStorage && <div className="banner">{t('insecureStorage')}</div>}

      {breadcrumbs.length > 0 && (
        <div className="group-breadcrumbs">
          <button type="button" className="crumb-link" onClick={() => setCurrentGroup('')}>
            {t('hosts')}
          </button>
          {breadcrumbs.map((seg, idx) => {
            const path = breadcrumbs.slice(0, idx + 1).join(' / ')
            const isLast = idx === breadcrumbs.length - 1
            return (
              <span key={path} className="crumb-part">
                <Icon name="chevronRight" size={13} />
                {isLast ? (
                  <span className="crumb-current">{seg}</span>
                ) : (
                  <button type="button" className="crumb-link" onClick={() => setCurrentGroup(path)}>
                    {seg}
                  </button>
                )}
              </span>
            )
          })}
          <button
            type="button"
            className="btn small icon"
            style={{ marginLeft: 6 }}
            title={t('editGroup')}
            onClick={() => setEditingGroup({ path: currentGroup, parent: breadcrumbs.slice(0, -1).join(' / ') })}
          >
            <Icon name="edit" size={13} />
          </button>
        </div>
      )}

      {visibleGroups.length === 0 && visibleHosts.length === 0 && <div className="empty">{t('noHosts')}</div>}

      {visibleGroups.length > 0 && (
        <section className="entity-section">
          <div className="section-title">{t('groups')}</div>
          <div className="cards">
            {visibleGroups.map((g) => (
              <div key={g.fullPath} className="card" onClick={() => setCurrentGroup(g.fullPath)} title={g.fullPath}>
                <GroupBadge />
                <div className="card-body">
                  <div className="card-title">{g.displayName}</div>
                  <div className="card-sub">{formatHostCount(g.hostCount)}</div>
                </div>
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn small icon"
                    title={t('editGroup')}
                    onClick={() => setEditingGroup({ path: g.fullPath, parent: g.parentPath })}
                  >
                    <Icon name="edit" />
                  </button>
                  <button className="btn small icon danger" title={t('delete')} onClick={() => removeGroup(g)}>
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {visibleHosts.length > 0 && (
        <section className="entity-section">
          <div className="section-title">{t('hosts')}</div>
          <div className="cards">
            {visibleHosts.map((h) => (
              <div key={h.id} className="card" onDoubleClick={() => connectHost(h)} title={t('connect')}>
                <HostBadge host={h} />
                <div className="card-body">
                  <div className="card-title">{h.label}</div>
                  <div className="card-sub">
                    {h.protocol}, {userOf(h) || h.hostname}
                  </div>
                  {h.tags.length > 0 && (
                    <div>
                      {h.tags.map((tag) => (
                        <span key={tag} className="chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="card-actions">
                  <button className="btn small icon" title={t('connect')} onClick={() => connectHost(h)}>
                    <Icon name="play" />
                  </button>
                  {h.protocol === 'ssh' && (
                    <button className="btn small icon" title={t('sftp')} onClick={() => openSftp(h)}>
                      <Icon name="folder" />
                    </button>
                  )}
                  <button className="btn small icon" title={t('edit')} onClick={() => setEditing(h)}>
                    <Icon name="edit" />
                  </button>
                  <button className="btn small icon danger" title={t('delete')} onClick={() => removeHost(h)}>
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {editing !== undefined && <HostEditor host={editing} initialGroup={currentGroup} onClose={() => setEditing(undefined)} />}
      {editingGroup !== undefined && (
        <GroupEditor
          groupPath={editingGroup.path}
          parentDefault={editingGroup.parent}
          onClose={() => setEditingGroup(undefined)}
          onSaved={(newPath) => {
            if (editingGroup.path && currentGroup === editingGroup.path) setCurrentGroup(newPath)
          }}
        />
      )}
      {importOpen && <ImportDrawer onClose={() => setImportOpen(false)} />}
      {serial && <SerialDialog onClose={() => setSerial(false)} />}
    </div>
  )
}
