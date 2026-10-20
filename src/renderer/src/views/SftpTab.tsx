import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { FileEntry } from '@shared/types'
import { api, errorMessage } from '../api'
import { Icon } from '../components/Icon'
import { formatBytes, Modal } from '../components/ui'
import { useT, type TKey } from '../i18n'
import { joinPath, modeString, parent, uniqueName } from '../paths'
import { attempt, useApp, type Tab } from '../state'

type Side = 'local' | 'remote'

interface PaneState {
  path: string
  entries: FileEntry[]
  sel: FileEntry | null
  error?: string
}

const EMPTY: PaneState = { path: '', entries: [], sel: null }

/** What each pane can do; the local and remote sides implement it differently. */
interface PaneOps {
  list(path: string): Promise<void>
  open(e: FileEntry, command?: string): Promise<void>
  /** Copies to the other pane's current folder (upload or download), optionally renamed. */
  copyToOther(e: FileEntry, destName?: string): Promise<void>
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

function ContextMenu(props: { menu: MenuState; ops: PaneOps; onCopy(e: FileEntry): void; onDialog(d: Dialog): void; onClose(): void }) {
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
          {item(menu.side === 'local' ? t('uploadToServer') : t('downloadToComputer'), () => props.onCopy(e))}
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

function FilePane(props: {
  side: Side
  title: string
  state: PaneState
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
        const fromOther = ev.dataTransfer.types.includes(`openterm/${props.side === 'local' ? 'remote' : 'local'}`)
        const fromOs = props.side === 'remote' && ev.dataTransfer.types.includes('Files')
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
        const path = ev.dataTransfer.getData(`openterm/${props.side === 'local' ? 'remote' : 'local'}`)
        if (path) return props.onDropFromOther(path)
        const files = [...ev.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
        if (files.length) props.onDropFiles(files)
      }}
    >
      <div className="fpane-head">
        <span className="title">{props.title}</span>
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
  const [sftpId, setSftpId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<PaneState>(EMPTY)
  const [remote, setRemote] = useState<PaneState>(EMPTY)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const mine = useRef(new Set<string>())
  const handled = useRef(new Set<string>())
  const idRef = useRef<string | null>(null)
  // Latest paths, for handlers created before a navigation.
  const paths = useRef({ local: '', remote: '' })
  paths.current = { local: local.path, remote: remote.path }

  const listLocal = async (path: string): Promise<void> => {
    const target = path || paths.current.local
    try {
      setLocal({ path: target, entries: await api.localList(target), sel: null })
    } catch (err) {
      setLocal((s) => ({ ...s, error: errorMessage(err) }))
    }
  }

  const listRemote = async (path: string, id = idRef.current): Promise<void> => {
    if (!id) return
    const target = path || paths.current.remote
    try {
      setRemote({ path: target, entries: await api.sftpList(id, target), sel: null })
    } catch (err) {
      setRemote((s) => ({ ...s, error: errorMessage(err) }))
    }
  }

  useEffect(() => {
    let closed = false
    if (tab.target.kind !== 'host') return
    void api.localHome().then(listLocal)
    api.sftpOpen(tab.target.hostId).then(
      ({ sftpId: id, home }) => {
        if (closed) return api.sftpClose(id)
        idRef.current = id
        setSftpId(id)
        void listRemote(home, id)
      },
      (err) => setError(errorMessage(err))
    )
    return () => {
      closed = true
      if (idRef.current) api.sftpClose(idRef.current)
    }
    // One SFTP connection per tab.
  }, [])

  // Refresh the destination pane when one of our transfers finishes.
  useEffect(() => {
    for (const p of Object.values(transfers)) {
      if (!p.done || !mine.current.has(p.transferId) || handled.current.has(p.transferId)) continue
      handled.current.add(p.transferId)
      if (p.error) toast(`${p.name}: ${p.error}`, true)
      if (p.direction === 'upload') void listRemote('')
      else void listLocal('')
    }
  }, [transfers])

  const track = (id: string | undefined): void => {
    if (id) mine.current.add(id)
  }

  const ops: Record<Side, PaneOps> = {
    local: {
      list: listLocal,
      open: (e, command) => api.localOpen(e.path, command),
      copyToOther: async (e, destName) => {
        if (sftpId) track(await api.sftpUpload(sftpId, e.path, paths.current.remote, destName))
      },
      mkdir: async (name) => {
        if (local.entries.some((x) => x.name === name)) throw new Error(t('nameTaken'))
        await api.localMkdir(joinPath(paths.current.local, name))
        await listLocal('')
      },
      rename: async (from, to) => {
        if (local.entries.some((x) => x.path === to)) throw new Error(t('nameTaken'))
        await api.localRename(from, to)
        await listLocal('')
      },
      remove: async (e) => {
        await api.localDelete(e.path)
        toast(`${e.name}: ${t('movedToTrash')}`)
        await listLocal('')
      },
      chmod: async (path, mode) => {
        await api.localChmod(path, mode)
        await listLocal('')
      }
    },
    remote: {
      list: (p) => listRemote(p),
      open: (e, command) => (sftpId ? api.sftpOpenFile(sftpId, e.path, command) : Promise.resolve()),
      copyToOther: async (e, destName) => {
        if (sftpId) track(await api.sftpDownload(sftpId, e.path, paths.current.local, destName))
      },
      mkdir: async (name) => {
        if (remote.entries.some((x) => x.name === name)) throw new Error(t('nameTaken'))
        await api.sftpMkdir(sftpId!, joinPath(paths.current.remote, name))
        await listRemote('')
      },
      rename: async (from, to) => {
        if (remote.entries.some((x) => x.path === to)) throw new Error(t('nameTaken'))
        await api.sftpRename(sftpId!, from, to)
        await listRemote('')
      },
      remove: async (e) => {
        await api.sftpDelete(sftpId!, e.path)
        await listRemote('')
      },
      chmod: async (path, mode) => {
        await api.sftpChmod(sftpId!, path, mode)
        await listRemote('')
      }
    }
  }

  const askConflict = (name: string): Promise<ConflictChoice> =>
    new Promise((resolve) => setDialog({ kind: 'conflict', name, resolve }))

  /** Copies to the other pane, asking first when the name is already taken there. */
  const copy = async (from: Side, e: FileEntry): Promise<void> => {
    const dest = from === 'local' ? remote : local
    let destName: string | undefined
    if (dest.entries.some((x) => x.name === e.name)) {
      const choice = await askConflict(e.name)
      if (choice === 'cancel') return
      if (choice === 'keepBoth') destName = uniqueName(e.name, dest.entries.map((x) => x.name))
    }
    await attempt(() => ops[from].copyToOther(e, destName))
  }

  /** Files dropped from the OS onto the remote pane. */
  const uploadPaths = async (localPaths: string[]): Promise<void> => {
    for (const path of localPaths) {
      const name = path.split(/[\\/]/).pop()!
      await copy('local', { name, path, isDir: false, isLink: false, size: 0, mtime: 0, mode: 0 })
    }
  }

  const entryAt = (side: Side, path: string): FileEntry | undefined => (side === 'local' ? local : remote).entries.find((e) => e.path === path)

  if (error) {
    return (
      <div className="page">
        <div className="banner danger">{error}</div>
      </div>
    )
  }

  const myTransfers = Object.values(transfers).filter((p) => mine.current.has(p.transferId))
  const pane = (side: Side, state: PaneState, setState: typeof setLocal, title: string): ReactNode => (
    <FilePane
      side={side}
      title={title}
      state={state}
      onNavigate={(p) => void ops[side].list(p)}
      onSelect={(e) => setState((s) => ({ ...s, sel: e }))}
      onOpen={(e) => void attempt(() => ops[side].open(e))}
      onMenu={setMenu}
      onDropFromOther={(path) => {
        const other: Side = side === 'local' ? 'remote' : 'local'
        const e = entryAt(other, path)
        if (e) void copy(other, e)
      }}
      onDropFiles={(files) => void uploadPaths(files)}
    />
  )

  return (
    <>
      <div className="sftp">
        {pane('local', local, setLocal, t('localFiles'))}
        {pane('remote', remote, setRemote, t('remoteFiles'))}
      </div>
      {myTransfers.length > 0 && (
        <div className="transfers">
          {myTransfers.map((p) => (
            <div key={p.transferId} className="transfer">
              <span className="truncate">
                {p.direction === 'upload' ? '↑' : '↓'} {p.name}
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
      {menu && <ContextMenu menu={menu} ops={ops[menu.side]} onCopy={(e) => void copy(menu.side, e)} onDialog={setDialog} onClose={() => setMenu(null)} />}
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
            if (mode !== null) await attempt(() => ops[dialog.side].chmod(dialog.entry.path, mode))
          }}
        />
      )}
      {dialog?.kind === 'openWith' && (
        <OpenWithModal
          entry={dialog.entry}
          onDone={async (command) => {
            setDialog(null)
            if (command !== null) await attempt(() => ops[dialog.side].open(dialog.entry, command))
          }}
        />
      )}
    </>
  )
}
