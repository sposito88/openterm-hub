import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { FileEntry } from '@shared/types'
import { api, errorMessage } from '../api'
import { Icon } from '../components/Icon'
import { formatBytes, Modal } from '../components/ui'
import { useT, type TKey } from '../i18n'
import { crumbs, joinPath, modeString, parent, selectForAction, selectItems, uniqueName } from '../paths'
import { attempt, useApp, type Tab } from '../state'

type Side = 'left' | 'right'

/** What a pane shows: this computer, or a vault host through its own SFTP session. */
type Source = { kind: 'local' } | { kind: 'host'; hostId: string; sftpId: string; label: string }

interface PaneState {
  source: Source | null
  path: string
  entries: FileEntry[]
  selected: string[]
  lastClicked: string | null
  error?: string
  connecting?: string
}

const EMPTY: PaneState = { source: null, path: '', entries: [], selected: [], lastClicked: null }
const other = (side: Side): Side => (side === 'left' ? 'right' : 'left')

/** What each pane can do; the local and remote sides implement it differently. */
interface PaneOps {
  list(path: string): Promise<void>
  open(e: FileEntry, command?: string): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(items: FileEntry[]): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

interface MenuState {
  x: number
  y: number
  side: Side
  entries: FileEntry[]
  canSelectAll: boolean
  onSelectAll(): void
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

function ContextMenu(props: {
  menu: MenuState
  ops: PaneOps
  otherName: string
  onNavigate(path: string): void
  onCopy(items: FileEntry[]): void
  onDialog(d: Dialog): void
  onClose(): void
}) {
  const { menu, ops, onDialog, onClose } = props
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  const selected = menu.entries
  const single = selected.length === 1 ? selected[0] : null
  const hasSelection = selected.length > 0

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
      {hasSelection && (
        <>
          {single && item(single.isDir ? t('open') : t('openFile'), () => (single.isDir ? props.onNavigate(single.path) : void attempt(() => ops.open(single))))}
          {single && !single.isDir && item(t('openWith') + '…', () => onDialog({ kind: 'openWith', entry: single, side: menu.side }))}
          {item(`${t('copyTo')} ${props.otherName}`, () => props.onCopy(selected))}
          <hr />
          {single &&
            item(t('rename'), () =>
              onDialog({
                kind: 'input',
                side: menu.side,
                title: t('newName'),
                initial: single.name,
                done: (name) => ops.rename(single.path, joinPath(parent(single.path), name))
              })
            )}
          {item(
            t('delete'),
            async () => {
              const promptText = single
                ? `${t('confirmDelete')}\n${single.path}`
                : `${t('confirmDeleteMany').replace('{n}', String(selected.length))}\n${selected.map((x) => x.name).join('\n')}`
              if (confirm(promptText)) await attempt(() => ops.remove(selected))
            },
            { danger: true }
          )}
          <hr />
        </>
      )}
      {item(t('refresh'), () => void ops.list(''))}
      {item(t('newFolder'), () => onDialog({ kind: 'input', side: menu.side, title: t('folderName'), initial: '', done: (name) => ops.mkdir(name) }))}
      {single && item(t('editPermissions'), () => onDialog({ kind: 'chmod', entry: single, side: menu.side }))}
      {item(t('selectAll'), () => menu.onSelectAll(), { disabled: !menu.canSelectAll })}
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
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const groups = new Map<string, typeof hosts>()
  for (const h of [...hosts].sort((a, b) => a.label.localeCompare(b.label))) {
    if (q && ![h.label, h.hostname, h.username, h.group].some((v) => v.toLowerCase().includes(q))) continue
    groups.set(h.group, [...(groups.get(h.group) ?? []), h])
  }
  const first = [...groups.values()][0]?.[0]
  return (
    <div ref={ref} className="menu source-picker" style={{ position: 'fixed', left: anchor.left, top: anchor.bottom + 4 }}>
      <input
        className="input"
        autoFocus
        placeholder={t('searchHosts')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && first) onPick(first.id)
        }}
      />
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

export type SortColumn = 'name' | 'mtime' | 'size' | 'kind'
export type SortDirection = 'asc' | 'desc'

export function sortEntries(
  entries: FileEntry[],
  sortCol: SortColumn,
  sortDir: SortDirection,
  getKind: (e: FileEntry) => string
): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1
    }
    let cmp = 0
    switch (sortCol) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        break
      case 'mtime':
        cmp = (a.mtime || 0) - (b.mtime || 0)
        break
      case 'size':
        cmp = (a.size || 0) - (b.size || 0)
        break
      case 'kind': {
        const kindA = getKind(a)
        const kindB = getKind(b)
        cmp = kindA.localeCompare(kindB, undefined, { numeric: true, sensitivity: 'base' })
        break
      }
    }
    if (cmp === 0) {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    }
    return sortDir === 'asc' ? cmp : -cmp
  })
}

function FilePane(props: {
  side: Side
  title: string
  state: PaneState
  onPickSource(anchor: DOMRect): void
  onNavigate(path: string): void
  onRefresh(): void
  canBack: boolean
  canForward: boolean
  onBack(): void
  onForward(): void
  onSelectionChange(selected: string[], lastClicked: string | null): void
  onOpen(e: FileEntry): void
  onDelete(items: FileEntry[]): void
  onMenu(m: MenuState): void
  /** Rows from the other pane were dropped here. */
  onDropFromOther(paths: string[]): void
  /** Files dragged in from the OS file manager (local paths). */
  onDropFiles(paths: string[]): void
}) {
  const t = useT()
  const showHidden = useApp((s) => s.snapshot!.settings.sftpShowHidden)
  const { state } = props
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState(state.path)
  const [editingPath, setEditingPath] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [sortCol, setSortCol] = useState<'name' | 'mtime' | 'size' | 'kind'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  useEffect(() => setDraft(state.path), [state.path])
  // A filter belongs to the folder it was typed in.
  const sourceKey = state.source?.kind === 'host' ? state.source.sftpId : state.source?.kind
  useEffect(() => setFilter(''), [state.path, sourceKey])

  const toggleSort = (col: 'name' | 'mtime' | 'size' | 'kind'): void => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir(col === 'mtime' || col === 'size' ? 'desc' : 'asc')
    }
  }

  const q = filter.trim().toLowerCase()
  const filtered = state.entries.filter(
    (e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q))
  )
  const entries = sortEntries(filtered, sortCol, sortDir, (e) => kindOf(e, t))
  const shownPaths = entries.map((e) => e.path)
  const selectedSet = new Set(state.selected)
  const selectedEntries = entries.filter((e) => selectedSet.has(e.path))
  const atRoot = parent(state.path) === state.path

  const selectAll = (): void => {
    props.onSelectionChange(shownPaths, state.lastClicked)
  }

  const openMenu = (ev: React.MouseEvent, entry: FileEntry | null): void => {
    ev.preventDefault()
    ev.stopPropagation()
    let activePaths = state.selected
    if (entry) {
      const next = selectForAction(state.selected, state.lastClicked, entry.path)
      activePaths = next.selected
      if (!selectedSet.has(entry.path)) {
        props.onSelectionChange(next.selected, next.lastClicked)
      }
    }
    const activeSet = new Set(activePaths)
    props.onMenu({
      x: ev.clientX,
      y: ev.clientY,
      side: props.side,
      entries: entry ? entries.filter((e) => activeSet.has(e.path)) : [],
      canSelectAll: entries.length > 0,
      onSelectAll: selectAll
    })
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
        const raw = ev.dataTransfer.getData(`openterm/${other(props.side)}`)
        if (raw) {
          let paths: string[]
          try {
            const parsed = JSON.parse(raw)
            paths = Array.isArray(parsed) ? parsed : [raw]
          } catch {
            paths = [raw]
          }
          return props.onDropFromOther(paths)
        }
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
          <input
            className="input"
            placeholder={t('filter')}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              props.onSelectionChange([], null)
            }}
          />
        </div>
        <button
          className="btn small"
          onClick={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect()
            props.onMenu({
              x: r.left,
              y: r.bottom + 4,
              side: props.side,
              entries: selectedEntries,
              canSelectAll: entries.length > 0,
              onSelectAll: selectAll
            })
          }}
        >
          {t('actions')} ▾
        </button>
      </div>
      {!state.source && !state.connecting && !state.error ? (
        <div className="connect-host">
          <div className="connect-icon">
            <Icon name="folder" size={22} />
          </div>
          <h3>{t('connectToHost')}</h3>
          <p className="dim">{t('connectToHostHint')}</p>
          <button className="btn" onClick={(ev) => props.onPickSource(ev.currentTarget.getBoundingClientRect())}>
            {t('selectHost')}
          </button>
        </div>
      ) : (
        <>
      <div className="fpane-head">
        <button className="btn small icon" title={t('back')} disabled={!props.canBack} onClick={props.onBack}>
          <Icon name="chevronLeft" />
        </button>
        <button className="btn small icon" title={t('forward')} disabled={!props.canForward} onClick={props.onForward}>
          <Icon name="chevronRight" />
        </button>
        <button className="btn small icon" title={t('up')} disabled={atRoot} onClick={() => props.onNavigate(parent(state.path))}>
          <Icon name="up" />
        </button>
        <button className="btn small icon" title={t('refresh')} onClick={props.onRefresh}>
          <Icon name="refresh" />
        </button>
        {editingPath ? (
          <input
            className="input mono"
            style={{ height: 26 }}
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                props.onNavigate(draft)
                setEditingPath(false)
              } else if (e.key === 'Escape') setEditingPath(false)
            }}
          />
        ) : (
          <div className="crumbs" title={t('editPath')} onClick={(e) => e.target === e.currentTarget && setEditingPath(true)}>
            {crumbs(state.path).map((c, i, all) => (
              <span key={c.path + i} className="crumb">
                <button className={i === all.length - 1 ? 'current' : ''} onClick={() => props.onNavigate(c.path)}>
                  {i === 0 && c.label === '/' ? <Icon name="folder" size={13} /> : c.label}
                </button>
                {i < all.length - 1 && <span className="sep">›</span>}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className="ftable"
        tabIndex={0}
        onClick={() => props.onSelectionChange([], null)}
        onContextMenu={(ev) => openMenu(ev, null)}
        onKeyDown={(ev) => {
          if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
            ev.preventDefault()
            selectAll()
          } else if (ev.key === 'Escape') {
            props.onSelectionChange([], null)
          } else if (ev.key === 'Delete' && selectedEntries.length > 0) {
            ev.preventDefault()
            props.onDelete(selectedEntries)
          }
        }}
      >
        <div className="frow head" onClick={(ev) => ev.stopPropagation()}>
          <button
            type="button"
            className={`col-header ${sortCol === 'name' ? 'active' : ''}`}
            onClick={() => toggleSort('name')}
            title={sortCol === 'name' && sortDir === 'asc' ? 'Nome (A → Z)' : 'Nome (Z → A)'}
          >
            <span>{t('name')}</span>
            <span className="sort-indicator">{sortCol === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
          </button>
          <button
            type="button"
            className={`col-header num ${sortCol === 'mtime' ? 'active' : ''}`}
            onClick={() => toggleSort('mtime')}
            title={sortCol === 'mtime' && sortDir === 'desc' ? 'Mais recentes primeiro' : 'Mais antigos primeiro'}
          >
            <span>{t('modified')}</span>
            <span className="sort-indicator">{sortCol === 'mtime' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
          </button>
          <button
            type="button"
            className={`col-header num ${sortCol === 'size' ? 'active' : ''}`}
            onClick={() => toggleSort('size')}
            title={sortCol === 'size' && sortDir === 'desc' ? 'Maiores primeiro' : 'Menores primeiro'}
          >
            <span>{t('size')}</span>
            <span className="sort-indicator">{sortCol === 'size' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
          </button>
          <button
            type="button"
            className={`col-header ${sortCol === 'kind' ? 'active' : ''}`}
            onClick={() => toggleSort('kind')}
            title="Ordenar por tipo"
          >
            <span>{t('kind')}</span>
            <span className="sort-indicator">{sortCol === 'kind' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
          </button>
        </div>
        {state.connecting && <div className="empty">{t('connecting')} {state.connecting}…</div>}
        {state.error && <div className="empty">{state.error}</div>}
        {!state.error && !state.connecting && state.source && entries.length === 0 && (
          <div className="empty">
            {q ? (
              <>
                {t('noFilterMatch').replace('{q}', filter.trim())}{' '}
                <button className="btn small" onClick={() => setFilter('')}>
                  {t('clearFilter')}
                </button>
              </>
            ) : (
              t('emptyFolder')
            )}
          </div>
        )}
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
            className={`frow ${selectedSet.has(e.path) ? 'sel' : ''}`}
            draggable
            onDragStart={(ev) => {
              const next = selectForAction(state.selected, state.lastClicked, e.path)
              if (!selectedSet.has(e.path)) {
                props.onSelectionChange(next.selected, next.lastClicked)
              }
              const dragSet = new Set(next.selected)
              const dragPaths = entries.filter((x) => dragSet.has(x.path)).map((x) => x.path)
              ev.dataTransfer.setData(`openterm/${props.side}`, JSON.stringify(dragPaths.length ? dragPaths : [e.path]))
            }}
            onClick={(ev) => {
              ev.stopPropagation()
              const next = selectItems(shownPaths, state.selected, state.lastClicked, e.path, {
                ctrlKey: ev.ctrlKey,
                metaKey: ev.metaKey,
                shiftKey: ev.shiftKey
              })
              props.onSelectionChange(next.selected, next.lastClicked)
            }}
            onDoubleClick={() => (e.isDir ? props.onNavigate(e.path) : props.onOpen(e))}
            onContextMenu={(ev) => openMenu(ev, e)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && selectedEntries.length <= 1) {
                ev.stopPropagation()
                e.isDir ? props.onNavigate(e.path) : props.onOpen(e)
              }
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
        </>
      )}
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
  // Back/forward history of each pane (folders, per source).
  const history = useRef<Record<Side, { back: string[]; forward: string[] }>>({ left: { back: [], forward: [] }, right: { back: [], forward: [] } })
  const [, bumpHistory] = useState(0)
  const renameTab = useApp((s) => s.renameTab)

  const patch = (side: Side, p: Partial<PaneState>): void => setPanes((s) => ({ ...s, [side]: { ...s[side], ...p } }))

  const list = async (side: Side, path: string, source = panesRef.current[side].source): Promise<void> => {
    if (!source) return
    const target = path || panesRef.current[side].path
    try {
      const entries = source.kind === 'local' ? await api.localList(target) : await api.sftpList(source.sftpId, target)
      patch(side, { source, path: target, entries, selected: [], lastClicked: null, error: undefined, connecting: undefined })
    } catch (err) {
      patch(side, { error: errorMessage(err), connecting: undefined })
    }
  }

  /** User navigation: remembered for back/forward (refreshes are not). */
  const navigate = (side: Side, path: string): void => {
    const current = panesRef.current[side].path
    if (path && current && path !== current) {
      history.current[side].back.push(current)
      history.current[side].forward = []
      bumpHistory((n) => n + 1)
    }
    void list(side, path)
  }

  const step = (side: Side, dir: 'back' | 'forward'): void => {
    const h = history.current[side]
    const target = h[dir].pop()
    if (target === undefined) return
    h[dir === 'back' ? 'forward' : 'back'].push(panesRef.current[side].path)
    bumpHistory((n) => n + 1)
    void list(side, target)
  }

  /** Tab title: "SFTP", or the hosts open in it. */
  const retitle = (): void => {
    const names = (['left', 'right'] as const)
      .map((s) => panesRef.current[s].source)
      .filter((src): src is Extract<Source, { kind: 'host' }> => src?.kind === 'host')
      .map((src) => src.label)
    renameTab(tab.id, names.length ? `SFTP · ${names.join(' ↔ ')}` : 'SFTP')
  }

  /** Points a pane at this computer (hostId null) or at a vault host. */
  const choose = async (side: Side, hostId: string | null): Promise<void> => {
    history.current[side] = { back: [], forward: [] }
    const previous = panesRef.current[side].source
    const release = (): void => {
      if (previous?.kind === 'host') {
        api.sftpClose(previous.sftpId)
        sessions.current.delete(previous.sftpId)
      }
    }
    if (hostId === null) {
      release()
      await list(side, await api.localHome(), { kind: 'local' })
      return retitle()
    }
    const host = hosts.find((h) => h.id === hostId)
    if (!host) return
    patch(side, { connecting: host.label, error: undefined, entries: [], selected: [], lastClicked: null })
    try {
      const { sftpId, home } = await api.sftpOpen(hostId)
      if (closed.current) return api.sftpClose(sftpId)
      sessions.current.add(sftpId)
      release()
      await list(side, home, { kind: 'host', hostId, sftpId, label: host.label })
      retitle()
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
        remove: async (items) => {
          await Promise.all(items.map((e) => api.sftpDelete(id, e.path)))
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
      remove: async (items) => {
        for (const e of items) {
          await api.localDelete(e.path)
          toast(`${e.name}: ${t('movedToTrash')}`)
        }
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

  const copyMany = async (side: Side, items: FileEntry[]): Promise<void> => {
    const source = panesRef.current[side].source
    if (!source) return
    for (const item of items) {
      await copyInto(source, item, other(side))
    }
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
    return s?.kind === 'host' ? s.label : s ? t('localFiles') : (panes[side].connecting ?? t('selectHost'))
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
            onNavigate={(p) => navigate(side, p)}
            onRefresh={() => void list(side, '')}
            canBack={history.current[side].back.length > 0}
            canForward={history.current[side].forward.length > 0}
            onBack={() => step(side, 'back')}
            onForward={() => step(side, 'forward')}
            onSelectionChange={(selected, lastClicked) => patch(side, { selected, lastClicked })}
            onOpen={(e) => void attempt(() => opsFor(side).open(e))}
            onDelete={async (items) => {
              const promptText =
                items.length === 1
                  ? `${t('confirmDelete')}\n${items[0].path}`
                  : `${t('confirmDeleteMany').replace('{n}', String(items.length))}\n${items.map((x) => x.name).join('\n')}`
              if (confirm(promptText)) await attempt(() => opsFor(side).remove(items))
            }}
            onMenu={setMenu}
            onDropFromOther={(paths) => {
              const pathSet = new Set(paths)
              const items = panesRef.current[other(side)].entries.filter((x) => pathSet.has(x.path))
              if (items.length) void copyMany(other(side), items)
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
              {!p.done && (
                <button
                  type="button"
                  className="btn small icon"
                  style={{ marginLeft: 6, padding: '2px 4px' }}
                  title={t('cancelTransfer')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void api.sftpCancel(p.transferId)
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
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
          onNavigate={(path) => navigate(menu.side, path)}
          onCopy={(items) => void copyMany(menu.side, items)}
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
