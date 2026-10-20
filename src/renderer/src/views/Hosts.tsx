import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Host, SerialPortInfo } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { Drawer, Field } from '../components/ui'
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

export function Hosts() {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const toast = useApp((s) => s.toast)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Host | null | undefined>(undefined)
  const [serial, setSerial] = useState(false)

  // The "open serial connection" shortcut lands here.
  useEffect(() => {
    const open = (): void => setSerial(true)
    window.addEventListener('openterm:serial', open)
    return () => window.removeEventListener('openterm:serial', open)
  }, [])

  /** Username shown for a host: its identity's when it has one. */
  const userOf = (h: Host): string => (h.identityId ? (snap.identities.find((i) => i.id === h.identityId)?.username ?? '') : h.username)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (h: Host): boolean =>
      !q || [h.label, h.hostname, userOf(h), h.group, ...h.tags].some((v) => v.toLowerCase().includes(q))
    const map = new Map<string, Host[]>()
    for (const h of snap.hosts.filter(match).sort((a, b) => a.label.localeCompare(b.label))) {
      const list = map.get(h.group) ?? []
      list.push(h)
      map.set(h.group, list)
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [snap.hosts, query])

  const importConfig = async (): Promise<void> => {
    const n = await attempt(() => api.importSshConfig())
    if (n !== undefined) toast(`${t('imported')}: ${n} hosts`)
  }

  const remove = async (h: Host): Promise<void> => {
    if (confirm(`${t('confirmDelete')}\n${h.label}`)) await attempt(() => api.deleteHost(h.id))
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('hosts')}</h1>
        <input className="input search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" onClick={openLocal}>
          <Icon name="terminal" /> {t('localTerminal')}
        </button>
        <button className="btn" onClick={() => setSerial(true)}>
          <Icon name="plug" /> {t('serial')}
        </button>
        <button className="btn" onClick={importConfig}>
          <Icon name="import" /> {t('importSshConfig')}
        </button>
        <button className="btn primary" onClick={() => setEditing(null)}>
          <Icon name="plus" /> {t('newHost')}
        </button>
      </div>

      {!snap.secureStorage && <div className="banner">{t('insecureStorage')}</div>}
      {snap.hosts.length === 0 && <div className="empty">{t('noHosts')}</div>}

      {groups.map(([group, hosts]) => (
        <section key={group}>
          {group && <div className="group-title">{group}</div>}
          <div className="cards">
            {hosts.map((h) => (
              <div key={h.id} className="card" onDoubleClick={() => connectHost(h)} title={t('connect')}>
                <div className="card-icon">{h.protocol === 'ssh' ? <Icon name="server" /> : h.protocol[0].toUpperCase()}</div>
                <div className="card-body">
                  <div className="card-title">{h.label}</div>
                  <div className="card-sub">
                    {h.protocol}, {userOf(h) ? `${userOf(h)}@` : ''}
                    {h.hostname}
                    {h.port !== 22 ? `:${h.port}` : ''}
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
                  <button className="btn small icon danger" title={t('delete')} onClick={() => remove(h)}>
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {editing !== undefined && <HostEditor host={editing} onClose={() => setEditing(undefined)} />}
      {serial && <SerialDialog onClose={() => setSerial(false)} />}
    </div>
  )
}
