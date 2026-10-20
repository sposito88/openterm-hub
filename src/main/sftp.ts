import { randomUUID } from 'node:crypto'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import type { FileEntry, TransferProgress } from '@shared/types'
import { connectHost, type SshDeps } from './ssh'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

type Send = (channel: string, ...args: unknown[]) => void
/** Opens a local file with a program ('' = the system default application). */
export type Opener = (file: string, command: string) => Promise<void>

/** Splits "code --wait" style commands; quotes group words. No shell is involved. */
export function splitCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

function p<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))))
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

interface Conn {
  client: Client
  sftp: SFTPWrapper
  /** Files opened with "Open with": watched and uploaded again on save. */
  opened: Array<{ watcher: FSWatcher; dir: string }>
}

export class Sftp {
  private conns = new Map<string, Conn>()

  constructor(
    private deps: SshDeps,
    private send: Send,
    private opener: Opener
  ) {}

  private conn(id: string): Conn {
    const c = this.conns.get(id)
    if (!c) throw new Error('Sessão SFTP encerrada')
    return c
  }

  async open(hostId: string): Promise<{ sftpId: string; home: string }> {
    const client = await connectHost(this.deps, hostId)
    try {
      const sftp = await p<SFTPWrapper>((cb) => client.sftp(cb))
      const home = await p<string>((cb) => sftp.realpath('.', cb))
      const sftpId = randomUUID()
      this.conns.set(sftpId, { client, sftp, opened: [] })
      client.on('close', () => this.close(sftpId))
      return { sftpId, home }
    } catch (err) {
      client.end()
      throw err
    }
  }

  close(id: string): void {
    const conn = this.conns.get(id)
    if (!conn) return
    this.conns.delete(id)
    for (const o of conn.opened) {
      o.watcher.close()
      void fs.rm(o.dir, { recursive: true, force: true })
    }
    conn.client.end()
  }

  /**
   * Downloads a remote file to a private temp folder, opens it with the
   * associated program and uploads it back every time it is saved, while
   * this SFTP session stays open.
   */
  async openFile(id: string, remotePath: string, command: string): Promise<void> {
    const conn = this.conn(id)
    const name = posix.basename(remotePath)
    const dir = await fs.mkdtemp(join(tmpdir(), 'openterm-hub-'))
    // The local name is passed to other programs (through cmd.exe on Windows): keep it plain.
    const local = join(dir, name.replace(/[^\w.-]/g, '_'))
    await p<void>((cb) => conn.sftp.fastGet(remotePath, local, cb))
    let mtime = (await fs.stat(local)).mtimeMs
    let timer: ReturnType<typeof setTimeout> | undefined
    // Watch the folder, not the file: many editors save by replacing the file.
    const watcher = watch(dir, () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        const st = await fs.stat(local).catch(() => null)
        if (!st || st.mtimeMs === mtime) return
        mtime = st.mtimeMs
        try {
          await p<void>((cb) => this.conn(id).sftp.fastPut(local, remotePath, cb))
          this.send('sftp:synced', name)
        } catch (err) {
          this.send('sftp:synced', name, (err as Error).message)
        }
      }, 400)
    })
    conn.opened.push({ watcher, dir })
    await this.opener(local, command)
  }

  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.close(id)
  }

  async list(id: string, dir: string): Promise<FileEntry[]> {
    const { sftp } = this.conn(id)
    const items = await p<FileEntryWithStats[]>((cb) => sftp.readdir(dir, cb))
    const entries = await Promise.all(
      items.map(async (it) => {
        const path = posix.join(dir, it.filename)
        const isLink = (it.attrs.mode & S_IFMT) === S_IFLNK
        let isDir = (it.attrs.mode & S_IFMT) === S_IFDIR
        if (isLink) {
          isDir = await p<Stats>((cb) => sftp.stat(path, cb)).then((s) => s.isDirectory(), () => false)
        }
        return { name: it.filename, path, isDir, isLink, size: it.attrs.size, mtime: it.attrs.mtime * 1000, mode: it.attrs.mode }
      })
    )
    return sortEntries(entries)
  }

  mkdir(id: string, path: string): Promise<void> {
    const { sftp } = this.conn(id)
    return p<void>((cb) => sftp.mkdir(path, cb))
  }

  rename(id: string, from: string, to: string): Promise<void> {
    const { sftp } = this.conn(id)
    return p<void>((cb) => sftp.rename(from, to, cb))
  }

  /** Recursive delete. Uses lstat so a symlink is removed, never followed. */
  async delete(id: string, path: string): Promise<void> {
    const { sftp } = this.conn(id)
    const st = await p<Stats>((cb) => sftp.lstat(path, cb))
    if (!st.isDirectory()) return p<void>((cb) => sftp.unlink(path, cb))
    const items = await p<FileEntryWithStats[]>((cb) => sftp.readdir(path, cb))
    for (const it of items) await this.delete(id, posix.join(path, it.filename))
    await p<void>((cb) => sftp.rmdir(path, cb))
  }

  /** Starts an upload in the background; progress is reported through events. */
  upload(id: string, localPath: string, remoteDir: string): string {
    const { sftp } = this.conn(id)
    const name = basename(localPath)
    return this.transfer('upload', name, async (step) => {
      const total = await localSize(localPath)
      const put = async (src: string, dst: string): Promise<void> => {
        const st = await fs.stat(src)
        if (st.isDirectory()) {
          await p<void>((cb) => sftp.mkdir(dst, cb)).catch(() => {})
          for (const child of await fs.readdir(src)) await put(join(src, child), posix.join(dst, child))
        } else {
          await p<void>((cb) => sftp.fastPut(src, dst, { step: step.file }, cb))
          step.commit(st.size)
        }
      }
      step.start(total)
      await put(localPath, posix.join(remoteDir, name))
    })
  }

  download(id: string, remotePath: string, localDir: string): string {
    const { sftp } = this.conn(id)
    const name = posix.basename(remotePath)
    return this.transfer('download', name, async (step) => {
      const total = await this.remoteSize(sftp, remotePath)
      const get = async (src: string, dst: string): Promise<void> => {
        const st = await p<Stats>((cb) => sftp.stat(src, cb))
        if (st.isDirectory()) {
          await fs.mkdir(dst, { recursive: true })
          const items = await p<FileEntryWithStats[]>((cb) => sftp.readdir(src, cb))
          for (const it of items) await get(posix.join(src, it.filename), join(dst, it.filename))
        } else {
          await p<void>((cb) => sftp.fastGet(src, dst, { step: step.file }, cb))
          step.commit(st.size)
        }
      }
      step.start(total)
      await get(remotePath, join(localDir, name))
    })
  }

  private async remoteSize(sftp: SFTPWrapper, path: string): Promise<number> {
    const st = await p<Stats>((cb) => sftp.stat(path, cb))
    if (!st.isDirectory()) return st.size
    const items = await p<FileEntryWithStats[]>((cb) => sftp.readdir(path, cb))
    let sum = 0
    for (const it of items) sum += await this.remoteSize(sftp, posix.join(path, it.filename))
    return sum
  }

  private transfer(
    direction: TransferProgress['direction'],
    name: string,
    run: (step: {
      start: (total: number) => void
      file: (fileTransferred: number) => void
      commit: (fileSize: number) => void
    }) => Promise<void>
  ): string {
    const transferId = randomUUID()
    let total = 0
    let finished = 0 // bytes of files already completed
    let lastEmit = 0
    const emit = (transferred: number, done = false, error?: string): void => {
      this.send('sftp:progress', { transferId, name, direction, transferred, total, done, error })
    }
    run({
      start: (t) => {
        total = t
        emit(0)
      },
      file: (fileTransferred) => {
        const now = Date.now()
        if (now - lastEmit < 100) return
        lastEmit = now
        emit(finished + fileTransferred)
      },
      commit: (size) => {
        finished += size
        emit(finished)
      }
    }).then(
      () => emit(total, true),
      (err: Error) => emit(finished, true, err.message)
    )
    return transferId
  }
}

async function localSize(path: string): Promise<number> {
  const st = await fs.stat(path)
  if (!st.isDirectory()) return st.size
  let sum = 0
  for (const child of await fs.readdir(path)) sum += await localSize(join(path, child))
  return sum
}

export function localHome(): string {
  return homedir()
}

export async function localList(dir: string): Promise<FileEntry[]> {
  const items = await fs.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    items.map(async (it) => {
      const path = join(dir, it.name)
      const st = await fs.stat(path).catch(() => null)
      return {
        name: it.name,
        path,
        isDir: st ? st.isDirectory() : it.isDirectory(),
        isLink: it.isSymbolicLink(),
        size: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0,
        mode: st?.mode ?? 0
      }
    })
  )
  return sortEntries(entries)
}
