import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { FileEntry } from '@shared/types'
import { api, errorMessage } from '../api'
import { Icon } from '../components/Icon'
import { formatBytes, Modal } from '../components/ui'
import { useT } from '../i18n'
import { parent } from '../paths'
import { attempt, useApp, type Tab } from '../state'

interface PaneState {
  path: string
  entries: FileEntry[]
  sel: FileEntry | null
  error?: string
}

const EMPTY: PaneState = { path: '', entries: [], sel: null }


function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
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

function FilePane(props: {
  title: string
  state: PaneState
  onNavigate(path: string): void
  onSelect(e: FileEntry): void
  /** Double click on a file. */
  onOpen?(e: FileEntry): void
  actions: ReactNode
}) {
  const t = useT()
  const showHidden = useApp((s) => s.snapshot!.settings.sftpShowHidden)
  const { state } = props
  const entries = showHidden ? state.entries : state.entries.filter((e) => !e.name.startsWith('.'))
  const [draft, setDraft] = useState(state.path)
  useEffect(() => setDraft(state.path), [state.path])

  return (
    <div className="fpane">
      <div className="fpane-head">
        <span className="title">{props.title}</span>
        <button className="btn small icon" title={t('up')} onClick={() => props.onNavigate(parent(state.path))}>
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
      <div className="fpane-head">{props.actions}</div>
      <div className="ftable">
        <div className="frow head">
          <span>{t('name')}</span>
          <span className="num">{t('size')}</span>
          <span className="num">{t('modified')}</span>
        </div>
        {state.error && <div className="empty">{state.error}</div>}
        {entries.map((e) => (
          <div
            key={e.path}
            className={`frow ${state.sel?.path === e.path ? 'sel' : ''}`}
            onClick={() => props.onSelect(e)}
            onDoubleClick={() => (e.isDir ? props.onNavigate(e.path) : props.onOpen?.(e))}
          >
            <span className="n">
              <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
              {e.name}
            </span>
            <span className="num">{e.isDir ? '' : formatBytes(e.size)}</span>
            <span className="num">{e.mtime ? new Date(e.mtime).toLocaleString() : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SftpTab({ tab }: { tab: Tab }) {
  const t = useT()
  const transfers = useApp((s) => s.transfers)
  const [sftpId, setSftpId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<PaneState>(EMPTY)
  const [remote, setRemote] = useState<PaneState>(EMPTY)
  const [input, setInput] = useState<{ title: string; initial: string; done(v: string): Promise<unknown> } | null>(null)
  const mine = useRef(new Set<string>())
  const handled = useRef(new Set<string>())
  const idRef = useRef<string | null>(null)

  const listLocal = async (path: string): Promise<void> => {
    try {
      setLocal({ path, entries: await api.localList(path), sel: null })
    } catch (err) {
      setLocal((s) => ({ ...s, error: errorMessage(err) }))
    }
  }

  const listRemote = async (path: string, id = idRef.current): Promise<void> => {
    if (!id) return
    try {
      setRemote({ path, entries: await api.sftpList(id, path), sel: null })
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
      if (p.error) useApp.getState().toast(`${p.name}: ${p.error}`, true)
      if (p.direction === 'upload') void listRemote(remote.path)
      else void listLocal(local.path)
    }
  }, [transfers])

  const upload = async (): Promise<void> => {
    if (!sftpId || !local.sel) return
    const id = await attempt(() => api.sftpUpload(sftpId, local.sel!.path, remote.path))
    if (id) mine.current.add(id)
  }

  const download = async (): Promise<void> => {
    if (!sftpId || !remote.sel) return
    const id = await attempt(() => api.sftpDownload(sftpId, remote.sel!.path, local.path))
    if (id) mine.current.add(id)
  }

  /** "Open with": edits the remote file locally; saves are uploaded back. */
  const openRemote = (e: FileEntry): void => {
    if (sftpId && !e.isDir) void attempt(() => api.sftpOpenFile(sftpId, e.path))
  }

  if (error) {
    return (
      <div className="page">
        <div className="banner danger">{error}</div>
      </div>
    )
  }

  const myTransfers = Object.values(transfers).filter((p) => mine.current.has(p.transferId))

  return (
    <>
      <div className="sftp">
        <FilePane
          title={t('localFiles')}
          state={local}
          onNavigate={listLocal}
          onSelect={(e) => setLocal((s) => ({ ...s, sel: e }))}
          actions={
            <button className="btn small primary" disabled={!local.sel || !sftpId} onClick={upload}>
              {t('upload')}
            </button>
          }
        />
        <FilePane
          title={t('remoteFiles')}
          state={remote}
          onNavigate={(p) => listRemote(p)}
          onSelect={(e) => setRemote((s) => ({ ...s, sel: e }))}
          onOpen={openRemote}
          actions={
            <>
              <button className="btn small primary" disabled={!remote.sel} onClick={download}>
                {t('download')}
              </button>
              <button className="btn small" disabled={!remote.sel || remote.sel.isDir} onClick={() => remote.sel && openRemote(remote.sel)}>
                <Icon name="external" /> {t('openFile')}
              </button>
              <button
                className="btn small"
                disabled={!sftpId}
                onClick={() =>
                  setInput({
                    title: t('folderName'),
                    initial: '',
                    done: (name) => api.sftpMkdir(sftpId!, join(remote.path, name))
                  })
                }
              >
                <Icon name="plus" /> {t('newFolder')}
              </button>
              <button
                className="btn small"
                disabled={!remote.sel}
                onClick={() =>
                  setInput({
                    title: t('newName'),
                    initial: remote.sel!.name,
                    done: (name) => api.sftpRename(sftpId!, remote.sel!.path, join(remote.path, name))
                  })
                }
              >
                {t('rename')}
              </button>
              <button
                className="btn small danger"
                disabled={!remote.sel}
                onClick={async () => {
                  if (!confirm(`${t('confirmDelete')}\n${remote.sel!.path}`)) return
                  await attempt(() => api.sftpDelete(sftpId!, remote.sel!.path))
                  void listRemote(remote.path)
                }}
              >
                <Icon name="trash" /> {t('delete')}
              </button>
            </>
          }
        />
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
      {input && (
        <InputModal
          title={input.title}
          initial={input.initial}
          onDone={async (v) => {
            const action = input
            setInput(null)
            if (v === null) return
            await attempt(() => action.done(v))
            void listRemote(remote.path)
          }}
        />
      )}
    </>
  )
}
