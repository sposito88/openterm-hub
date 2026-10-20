import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { FileEntry } from '@shared/types'
import { api, errorMessage } from '../api'
import { Icon } from '../components/Icon'
import { formatBytes, Modal } from '../components/ui'
import { useT, type TKey } from '../i18n'
import { joinPath, modeString, parent, uniqueName } from '../paths'
import { attempt, useApp, type Tab } from '../state'

type Side = 'left' | 'right'

/** What a pane shows: this computer, or a vault host through its own SFTP session. */
type Source = { kind: 'local' } | { kind: 'host'; hostId: string; sftpId: string; label: string }

interface PaneState {
  source: Source | null
  path: string
  entries: FileEntry[]
  sel: FileEntry | null
  error?: string
  connecting?: string
}

const EMPTY: PaneState = { source: null, path: '', entries: [], sel: null }
const other = (side: Side): Side => (side === 'left' ? 'right' : 'left')

/** What each pane can do; the local and remote sides implement it differently. */
interface PaneOps {
  list(path: string): Promise<void>
  open(e: FileEntry, command?: string): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(e: FileEntry): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

interface MenuState {
  x: number
  y: number
  side: Side
  entry: FileEntry | null
}

type Dialog =
  | { kind: 'input'; title: string; initial: string; done(v: string): Promise<unknown>; side: Side }
  | { kind: 'chmod'; entry: FileEntry; side: Side }
  | { kind: 'openWith'; entry: FileEntry; side: Side }
  | { kind: 'conflict'; name: string; resolve(choice: ConflictChoice): void }

type ConflictChoice = 'cancel' | 'replace' | 'keepBoth'

function kindOf(e: FileEntry, t: (k: TKey) => string): string {
  if (e.isDir) return t('folder')
  const dot = e.name.lastIndexOf('.')
  return dot > 0 ? e.name.slice(dot + 1).toLowerCase() : t('file')
}

function InputModal({ title, initial, onDone }: { title: string; initial: string; onDone(v: string | null): void }) {
  const t = useT()
  const [value, setValue] = useState(initial)
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    onDone(value.trim() || null)
  }
  return (
    <Modal title={title}>
      <form onSubmit={submit}>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <div className="actions">
          <button type="button" className="btn" onClick={() => onDone(null)}>
            {t('cancel')}
          </button>
          <button className="btn primary">{t('ok')}</button>
        </div>
      </form>
    </Modal>
  )
}

const PERM_ROWS: Array<[TKey, number]> = [
  ['permOwner', 6],
  ['permGroup', 3],
  ['permOthers', 0]
]
const PERM_COLS: Array<[TKey, number]> = [
  ['permRead', 2],
  ['permWrite', 1],
  ['permExec', 0]
]

function ChmodModal({ entry, onDone }: { entry: FileEntry; onDone(mode: number | null): void }) {
  const t = useT()
  const [mode, setMode] = useState(entry.mode & 0o777)
  const [octal, setOctal] = useState((entry.mode & 0o777).toString(8).padStart(3, '0'))
  const update = (m: number): void => {
    setMode(m)
    setOctal(m.toString(8).padStart(3, '0'))
  }
  return (
    <Modal title={`${t('editPermissions')}: ${entry.name}`}>
      <table className="perm-table">
        <thead>
          <tr>
            <th />
            {PERM_COLS.map(([k]) => (
              <th key={k}>{t(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERM_ROWS.map(([rowKey, shift]) => (
            <tr key={rowKey}>
              <td>{t(rowKey)}</td>
              {PERM_COLS.map(([colKey, bit]) => {
                const mask = 1 << (shift + bit)
                return (
                  <td key={colKey}>
                    <input type="checkbox" checked={!!(mode & mask)} onChange={(e) => update(e.target.checked ? mode | mask : mode & ~mask)} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
        <span className="dim" style={{ flex: 'none' }}>
          {t('octal')}
        </span>
        <input
          className="input mono"
          style={{ width: 90, flex: 'none' }}
          value={octal}
          onChange={(e) => {
            setOctal(e.target.value)
            if (/^[0-7]{3}$/.test(e.target.value)) setMode(parseInt(e.target.value, 8))
          }}
        />
        <span className="mono dim">{modeString(mode, entry.isDir, false)}</span>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => onDone(null)}>
          {t('cancel')}
        </button>
        <button className="btn primary" onClick={() => onDone(mode)}>
          {t('apply')}
        </button>
      </div>
    </Modal>
  )
}

function OpenWithModal({ entry, onDone }: { entry: FileEntry; onDone(command: string | null): void }) {
  const t = useT()
  const [command, setCommand] = useState('')
  const pick = async (): Promise<void> => {
    const program = await attempt(() => api.pickProgram())
    if (program) setCommand(/\s/.test(program) ? `"${program}"` : program)
  }
  return (
    <Modal title={`${t('openWith')} ${entry.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onDone(command.trim())
        }}
      >
        <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="code --wait" autoFocus />
        <p className="note">{t('openWithHint')}</p>
        <div className="actions">
          <button type="button" className="btn" style={{ marginRight: 'auto' }} onClick={pick}>
            {t('chooseProgram')}
          </button>
          <button type="button" className="btn" onClick={() => onDone(null)}>
            {t('cancel')}
          </button>
          <button className="btn primary">{t('openFile')}</button>
        </div>
      </form>
    </Modal>
  )
}

function ConflictModal({ name, onDone }: { name: string; onDone(c: ConflictChoice): void }) {
  const t = useT()
  return (
    <Modal title={t('alreadyExistsTitle')}>
      <p>{t('alreadyExists').replace('{name}', name)}</p>
      <div className="actions">
        <button className="btn" style={{ marginRight: 'auto' }} onClick={() => onDone('cancel')} autoFocus>
          {t('cancel')}
        </button>
        <button className="btn danger" onClick={() => onDone('replace')}>
          {t('replace')}
        </button>
        <button className="btn primary" onClick={() => onDone('keepBoth')}>
          {t('keepBoth')}
        </button>
      </div>
    </Modal>
  )
}

function ContextMenu(props: { menu: MenuState; ops: PaneOps; otherName: string; onCopy(e: FileEntry): void; onDialog(d: Dialog): void; onClose(): void }) {
  const { menu, ops, onDialog, onClose } = props
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  const e = menu.entry

  useEffect(() => {
    // Keep the menu inside the window.
    const r = ref.current!.getBoundingClientRect()
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 8), top: Math.min(menu.y, window.innerHeight - r.height - 8) })
    const close = (ev: Event): void => {
      if (ev instanceof KeyboardEvent && ev.key !== 'Escape') return
      if (ev.type === 'mousedown' && ref.current?.contains(ev.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('blur', close)
    }
  }, [])

  const item = (label: string, run: () => void, opts: { danger?: boolean; disabled?: boolean } = {}): ReactNode => (
    <button
      className={opts.danger ? 'danger' : ''}
      disabled={opts.disabled}
      onClick={() => {
        onClose()
        run()
      }}
    >
      {label}
    </button>
  )

  return (
    <div ref={ref} className="menu context-menu" style={{ position: 'fixed', ...pos }}>
      {e && (
        <>
          {item(e.isDir ? t('open') : t('openFile'), () => (e.isDir ? void ops.list(e.path) : void attempt(() => ops.open(e))))}
          {!e.isDir && item(t('openWith') + '…', () => onDialog({ kind: 'openWith', entry: e, side: menu.side }))}
          {item(`${t('copyTo')} ${props.otherName}`, () => props.onCopy(e))}
          <hr />
          {item(t('rename'), () =>
            onDialog({ kind: 'input', side: menu.side, title: t('newName'), initial: e.name, done: (name) => ops.rename(e.path, joinPath(parent(e.path), name)) })
          )}
          {item(
            t('delete'),
            async () => {
              if (confirm(`${t('confirmDelete')}\n${e.path}`)) await attempt(() => ops.remove(e))
            },
            { danger: true }
          )}
          <hr />
        </>
      )}
      {item(t('refresh'), () => void ops.list(''))}
      {item(t('newFolder'), () => onDialog({ kind: 'input', side: menu.side, title: t('folderName'), initial: '', done: (name) => ops.mkdir(name) }))}
      {e && item(t('editPermissions'), () => onDialog({ kind: 'chmod', entry: e, side: menu.side }))}
    </div>
  )
}

/** Chooser for what a pane shows: this computer or a vault host. */
function SourcePicker({ anchor, onPick, onClose }: { anchor: DOMRect; onPick(hostId: string | null): void; onClose(): void }) {
  const t = useT()
  const hosts = useApp((s) => s.snapshot!.hosts).filter((h) => h.protocol === 'ssh')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (ev: MouseEvent): void => {
      if (!ref.current?.contains(ev.target as Node)) onClose()
    }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [])
  const groups = new Map<string, typeof hosts>()
  for (const h of [...hosts].sort((a, b) => a.label.localeCompare(b.label))) groups.set(h.group, [...(groups.get(h.group) ?? []), h])
  return (
    <div ref={ref} className="menu source-picker" style={{ position: 'fixed', left: anchor.left, top: anchor.bottom + 4 }}>
      <button onClick={() => onPick(null)}>
        <Icon name="terminal" size={14} /> {t('thisComputer')}
      </button>
      {[...groups.entries()].map(([group, list]) => (
        <div key={group}>
          <hr />
          {group && <div className="menu-group">{group}</div>}
          {list.map((h) => (
            <button key={h.id} onClick={() => onPick(h.id)}>
              <Icon name="server" size={14} /> {h.label}
              <span className="dim"> {h.username ? `${h.username}@` : ''}{h.hostname}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function FilePane(props: {
  side: Side
  title: string
  state: PaneState
  onPickSource(anchor: DOMRect): void
  onNavigate(path: string): void
  onSelect(e: FileEntry): void
  onOpen(e: FileEntry): void
  onMenu(m: MenuState): void
  /** A row from the other pane was dropped here. */
  onDropFromOther(path: string): void
  /** Files dragged in from the OS file manager (local paths). */
  onDropFiles(paths: string[]): void
}) {
  const t = useT()
  const showHidden = useApp((s) => s.snapshot!.settings.sftpShowHidden)
  const { state } = props
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState(state.path)
  const [dropping, setDropping] = useState(false)
  useEffect(() => setDraft(state.path), [state.path])

  const q = filter.trim().toLowerCase()
  const entries = state.entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
  const atRoot = parent(state.path) === state.path

  const openMenu = (ev: React.MouseEvent, entry: FileEntry | null): void => {
    ev.preventDefault()
    ev.stopPropagation()
    if (entry) props.onSelect(entry)
    props.onMenu({ x: ev.clientX, y: ev.clientY, side: props.side, entry })
  }

  return (
    <div
      className={`fpane ${dropping ? 'dropping' : ''}`}
      onDragOver={(ev) => {
        const fromOther = ev.dataTransfer.types.includes(`openterm/${other(props.side)}`)
        const fromOs = ev.dataTransfer.types.includes('Files')
        if (fromOther || fromOs) {
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropping(false)
      }}
      onDrop={(ev) => {
        ev.preventDefault()
        setDropping(false)
        const path = ev.dataTransfer.getData(`openterm/${other(props.side)}`)
        if (path) return props.onDropFromOther(path)
        const files = [...ev.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
        if (files.length) props.onDropFiles(files)
      }}
    >
      <div className="fpane-head">
        <button className="title source-button" title={t('chooseSource')} onClick={(ev) => props.onPickSource(ev.currentTarget.getBoundingClientRect())}>
          <Icon name={state.source?.kind === 'host' ? 'server' : 'terminal'} size={14} />
          {props.title} ▾
        </button>
        <div className="fpane-filter">
          <Icon name="search" size={14} />
          <input className="input" placeholder={t('filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button
          className="btn small"
          onClick={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect()
            props.onMenu({ x: r.left, y: r.bottom + 4, side: props.side, entry: state.sel })
          }}
        >
          {t('actions')} ▾
        </button>
      </div>
      <div className="fpane-head">
        <button className="btn small icon" title={t('up')} disabled={atRoot} onClick={() => props.onNavigate(parent(state.path))}>
          <Icon name="up" />
        </button>
        <button className="btn small icon" title={t('refresh')} onClick={() => props.onNavigate(state.path)}>
          <Icon name="refresh" />
        </button>
        <input
          className="input mono"
          style={{ height: 26 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && props.onNavigate(draft)}
        />
      </div>
      <div className="ftable" onContextMenu={(ev) => openMenu(ev, null)}>
        <div className="frow head">
          <span>{t('name')}</span>
          <span className="num">{t('modified')}</span>
          <span className="num">{t('size')}</span>
          <span>{t('kind')}</span>
        </div>
        {state.connecting && <div className="empty">{t('connecting')} {state.connecting}…</div>}
        {state.error && <div className="empty">{state.error}</div>}
        {!atRoot && (
          <div className="frow" onDoubleClick={() => props.onNavigate(parent(state.path))}>
            <span className="n">
              <Icon name="folder" size={14} /> ..
            </span>
          </div>
        )}
        {entries.map((e) => (
          <div
            key={e.path}
            className={`frow ${state.sel?.path === e.path ? 'sel' : ''}`}
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData(`openterm/${props.side}`, e.path)
              props.onSelect(e)
            }}
            onClick={() => props.onSelect(e)}
            onDoubleClick={() => (e.isDir ? props.onNavigate(e.path) : props.onOpen(e))}
            onContextMenu={(ev) => openMenu(ev, e)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') e.isDir ? props.onNavigate(e.path) : props.onOpen(e)
            }}
            tabIndex={0}
          >
            <span className="n">
              <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
              <span className="fname">
                {e.name}
                <small className="mono">{modeString(e.mode, e.isDir, e.isLink)}</small>
              </span>
            </span>
            <span className="num">{e.mtime ? new Date(e.mtime).toLocaleString() : ''}</span>
            <span className="num">{e.isDir ? '--' : formatBytes(e.size)}</span>
            <span className="dim truncate">{kindOf(e, t)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SftpTab({ tab }: { tab: Tab }) {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const transfers = useApp((s) => s.transfers)
  const hosts = useApp((s) => s.snapshot!.hosts)
  const [panes, setPanes] = useState<Record<Side, PaneState>>({ left: EMPTY, right: EMPTY })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [picker, setPicker] = useState<{ side: Side; anchor: DOMRect } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const mine = useRef(new Set<string>())
  const handled = useRef(new Set<string>())
  // Latest state for async handlers created before a re-render.
  const panesRef = useRef(panes)
  panesRef.current = panes
  const sessions = useRef(new Set<string>())
  const closed = useRef(false)

  const patch = (side: Side, p: Partial<PaneState>): void => setPanes((s) => ({ ...s, [side]: { ...s[side], ...p } }))

  const list = async (side: Side, path: string, source = panesRef.current[side].source): Promise<void> => {
    if (!source) return
    const target = path || panesRef.current[side].path
    try {
      const entries = source.kind === 'local' ? await api.localList(target) : await api.sftpList(source.sftpId, target)
      patch(side, { source, path: target, entries, sel: null, error: undefined, connecting: undefined })
    } catch (err) {
      patch(side, { error: errorMessage(err), connecting: undefined })
    }
  }

  /** Points a pane at this computer (hostId null) or at a vault host. */
  const choose = async (side: Side, hostId: string | null): Promise<void> => {
    const previous = panesRef.current[side].source
    const release = (): void => {
      if (previous?.kind === 'host') {
        api.sftpClose(previous.sftpId)
        sessions.current.delete(previous.sftpId)
      }
    }
    if (hostId === null) {
      release()
      return list(side, await api.localHome(), { kind: 'local' })
    }
    const host = hosts.find((h) => h.id === hostId)
    if (!host) return
    patch(side, { connecting: host.label, error: undefined, entries: [] })
    try {
      const { sftpId, home } = await api.sftpOpen(hostId)
      if (closed.current) return api.sftpClose(sftpId)
      sessions.current.add(sftpId)
      release()
      await list(side, home, { kind: 'host', hostId, sftpId, label: host.label })
    } catch (err) {
      patch(side, { connecting: undefined, error: errorMessage(err) })
    }
  }

  useEffect(() => {
    void choose('left', null)
    if (tab.target.kind === 'host') void choose('right', tab.target.hostId)
    return () => {
      closed.current = true
      for (const id of sessions.current) api.sftpClose(id)
    }
    // One set of SFTP sessions per tab.
  }, [])

  // Refresh both panes when one of our transfers finishes.
  useEffect(() => {
    for (const p of Object.values(transfers)) {
      if (!p.done || !mine.current.has(p.transferId) || handled.current.has(p.transferId)) continue
      handled.current.add(p.transferId)
      if (p.error) toast(`${p.name}: ${p.error}`, true)
      void list('left', '')
      void list('right', '')
    }
  }, [transfers])

  const opsFor = (side: Side): PaneOps => {
    const source = panes[side].source
    const refresh = (): Promise<void> => list(side, '')
    const taken = (name: string): boolean => panesRef.current[side].entries.some((x) => x.name === name)
    if (source?.kind === 'host') {
      const id = source.sftpId
      return {
        list: (p) => list(side, p),
        open: (e, command) => api.sftpOpenFile(id, e.path, command),
        mkdir: async (name) => {
          if (taken(name)) throw new Error(t('nameTaken'))
          await api.sftpMkdir(id, joinPath(panesRef.current[side].path, name))
          await refresh()
        },
        rename: async (from, to) => {
          if (panesRef.current[side].entries.some((x) => x.path === to)) throw new Error(t('nameTaken'))
          await api.sftpRename(id, from, to)
          await refresh()
        },
        remove: async (e) => {
          await api.sftpDelete(id, e.path)
          await refresh()
        },
        chmod: async (path, mode) => {
          await api.sftpChmod(id, path, mode)
          await refresh()
        }
      }
    }
    return {
      list: (p) => list(side, p),
      open: (e, command) => api.localOpen(e.path, command),
      mkdir: async (name) => {
        if (taken(name)) throw new Error(t('nameTaken'))
        await api.localMkdir(joinPath(panesRef.current[side].path, name))
        await refresh()
      },
      rename: async (from, to) => {
        if (panesRef.current[side].entries.some((x) => x.path === to)) throw new Error(t('nameTaken'))
        await api.localRename(from, to)
        await refresh()
      },
      remove: async (e) => {
        await api.localDelete(e.path)
        toast(`${e.name}: ${t('movedToTrash')}`)
        await refresh()
      },
      chmod: async (path, mode) => {
        await api.localChmod(path, mode)
        await refresh()
      }
    }
  }

  const askConflict = (name: string): Promise<ConflictChoice> => new Promise((resolve) => setDialog({ kind: 'conflict', name, resolve }))

  /** Copies an item from `from` (a source, possibly an OS drop) into the `to` pane's folder. */
  const copyInto = async (from: Source, e: FileEntry, to: Side): Promise<void> => {
    const dest = panesRef.current[to]
    if (!dest.source) return
    let destName: string | undefined
    if (dest.entries.some((x) => x.name === e.name)) {
      const choice = await askConflict(e.name)
      if (choice === 'cancel') return
      if (choice === 'keepBoth') destName = uniqueName(e.name, dest.entries.map((x) => x.name))
    }
    const target = dest.source
    await attempt(async () => {
      if (from.kind === 'local' && target.kind === 'host') mine.current.add(await api.sftpUpload(target.sftpId, e.path, dest.path, destName))
      else if (from.kind === 'host' && target.kind === 'local') mine.current.add(await api.sftpDownload(from.sftpId, e.path, dest.path, destName))
      else if (from.kind === 'host' && target.kind === 'host') mine.current.add(await api.sftpCopy(from.sftpId, e.path, target.sftpId, dest.path, destName))
      else {
        await api.localCopy(e.path, dest.path, destName)
        await list(to, '')
      }
    })
  }

  const copy = (side: Side, e: FileEntry): void => {
    const source = panesRef.current[side].source
    if (source) void copyInto(source, e, other(side))
  }

  /** Files dropped from the OS file manager. */
  const dropFiles = async (side: Side, paths: string[]): Promise<void> => {
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop()!
      await copyInto({ kind: 'local' }, { name, path, isDir: false, isLink: false, size: 0, mtime: 0, mode: 0 }, side)
    }
  }

  const titleOf = (side: Side): string => {
    const s = panes[side].source
    return s?.kind === 'host' ? s.label : s ? t('localFiles') : panes[side].connecting ?? '…'
  }

  const myTransfers = Object.values(transfers).filter((p) => mine.current.has(p.transferId))
  const arrow = { upload: '↑', download: '↓', copy: '⇄' } as const

  return (
    <>
      <div className="sftp">
        {(['left', 'right'] as const).map((side) => (
          <FilePane
            key={side}
            side={side}
            title={titleOf(side)}
            state={panes[side]}
            onPickSource={(anchor) => setPicker({ side, anchor })}
            onNavigate={(p) => void list(side, p)}
            onSelect={(e) => patch(side, { sel: e })}
            onOpen={(e) => void attempt(() => opsFor(side).open(e))}
            onMenu={setMenu}
            onDropFromOther={(path) => {
              const e = panesRef.current[other(side)].entries.find((x) => x.path === path)
              if (e) copy(other(side), e)
            }}
            onDropFiles={(files) => void dropFiles(side, files)}
          />
        ))}
      </div>
      {myTransfers.length > 0 && (
        <div className="transfers">
          {myTransfers.map((p) => (
            <div key={p.transferId} className="transfer">
              <span className="truncate">
                {arrow[p.direction]} {p.name}
                {p.error ? ` (${p.error})` : ''}
              </span>
              <div className="bar">
                <div style={{ width: `${p.total ? Math.min(100, (p.transferred / p.total) * 100) : p.done ? 100 : 0}%` }} />
              </div>
              <span className="dim">{formatBytes(p.transferred)}</span>
            </div>
          ))}
        </div>
      )}
      {picker && (
        <SourcePicker
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          onPick={(hostId) => {
            setPicker(null)
            void choose(picker.side, hostId)
          }}
        />
      )}
      {menu && (
        <ContextMenu
          menu={menu}
          ops={opsFor(menu.side)}
          otherName={titleOf(other(menu.side))}
          onCopy={(e) => copy(menu.side, e)}
          onDialog={setDialog}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog?.kind === 'conflict' && (
        <ConflictModal
          name={dialog.name}
          onDone={(choice) => {
            setDialog(null)
            dialog.resolve(choice)
          }}
        />
      )}
      {dialog?.kind === 'input' && (
        <InputModal
          title={dialog.title}
          initial={dialog.initial}
          onDone={async (v) => {
            setDialog(null)
            if (v !== null) await attempt(() => dialog.done(v))
          }}
        />
      )}
      {dialog?.kind === 'chmod' && (
        <ChmodModal
          entry={dialog.entry}
          onDone={async (mode) => {
            setDialog(null)
            if (mode !== null) await attempt(() => opsFor(dialog.side).chmod(dialog.entry.path, mode))
          }}
        />
      )}
      {dialog?.kind === 'openWith' && (
        <OpenWithModal
          entry={dialog.entry}
          onDone={async (command) => {
            setDialog(null)
            if (command !== null) await attempt(() => opsFor(dialog.side).open(dialog.entry, command))
          }}
        />
      )}
    </>
  )
}
