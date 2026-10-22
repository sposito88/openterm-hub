import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { ForwardRule, Host, Identity, KnownHost, Snippet, SshKey, SyncStatus, Workspace } from '@shared/types'

/**
 * Optional sync through a folder the user already syncs (Nextcloud, Syncthing,
 * Dropbox, a Git repo…). The vault file is encrypted end to end with a
 * passphrase that never leaves this computer: AES-256-GCM, key from scrypt.
 * Devices merge item by item (newest updatedAt wins, deletions are kept as
 * tombstones), and conflict copies made by the sync tool are merged too.
 */

export interface VaultData {
  hosts: Host[]
  identities: Identity[]
  keys: SshKey[]
  snippets: Snippet[]
  forwards: ForwardRule[]
  workspaces: Workspace[]
  groups: string[]
  knownHosts: KnownHost[]
  /** Item id → when it was deleted (ms). */
  deleted: Record<string, number>
  /** Secrets of the items above (host:<id>:…, identity:<id>:…, key:<id>:…), in clear text inside the encrypted vault. */
  secrets: Record<string, string>
}

const COLLECTIONS = ['hosts', 'identities', 'keys', 'snippets', 'forwards', 'workspaces'] as const
const TOMBSTONE_DAYS = 180
export const VAULT_FILE = 'openterm-hub-vault.json'
/** The vault and the conflict copies sync tools make of it. */
const VAULT_RE = /^openterm-hub-vault.*\.json$/i
const SYNCED_SECRET_RE = /^(host|identity|key):([^:]+):/

export function isSyncedSecret(name: string): boolean {
  return SYNCED_SECRET_RE.test(name)
}

function owner(secretName: string): string | undefined {
  return SYNCED_SECRET_RE.exec(secretName)?.[2]
}

export function mergeVaults(local: VaultData, remote: VaultData, now = Date.now()): VaultData {
  const deleted: Record<string, number> = {}
  const cutoff = now - TOMBSTONE_DAYS * 86_400_000
  for (const [id, t] of [...Object.entries(local.deleted ?? {}), ...Object.entries(remote.deleted ?? {})]) {
    if (t >= cutoff) deleted[id] = Math.max(deleted[id] ?? 0, t)
  }
  // Owner id → whose copy won, so its secrets come along with it.
  const winner = new Map<string, 'local' | 'remote'>()
  const out = { deleted } as VaultData
  for (const key of COLLECTIONS) {
    const l = new Map((local[key] ?? []).map((x) => [x.id, x]))
    const r = new Map((remote[key] ?? []).map((x) => [x.id, x]))
    const merged: Array<{ id: string; updatedAt?: number }> = []
    for (const id of new Set([...l.keys(), ...r.keys()])) {
      const a = l.get(id)
      const b = r.get(id)
      const useRemote = !a || (!!b && (b.updatedAt ?? 0) > (a.updatedAt ?? 0))
      const pick = useRemote ? b! : a
      if (deleted[id] !== undefined && deleted[id] >= (pick.updatedAt ?? 0)) continue
      merged.push(pick)
      winner.set(id, useRemote ? 'remote' : 'local')
    }
    ;(out as unknown as Record<string, unknown>)[key] = merged
  }
  out.secrets = {}
  for (const side of ['local', 'remote'] as const) {
    const src = side === 'local' ? local.secrets : remote.secrets
    for (const [name, value] of Object.entries(src ?? {})) {
      const id = owner(name)
      if (id && winner.get(id) === side) out.secrets[name] = value
    }
  }
  out.groups = [...new Set([...(local.groups ?? []), ...(remote.groups ?? [])])].sort((a, b) => a.localeCompare(b))
  const known = new Map<string, KnownHost>()
  for (const k of [...(local.knownHosts ?? []), ...(remote.knownHosts ?? [])]) {
    const id = `${k.host}:${k.port}`
    const cur = known.get(id)
    if (!cur || k.addedAt > cur.addedAt) known.set(id, k)
  }
  out.knownHosts = [...known.values()]
  return out
}

/** Order-independent form, to tell whether two vaults hold the same data. */
export function canonical(v: VaultData): string {
  const byId = <T extends { id: string }>(xs: T[] = []): T[] => [...xs].sort((a, b) => a.id.localeCompare(b.id))
  const sortKeys = (o: Record<string, unknown> = {}): Array<[string, unknown]> => Object.entries(o).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([
    ...COLLECTIONS.map((k) => byId(v[k] as Array<{ id: string }>)),
    [...(v.groups ?? [])].sort(),
    [...(v.knownHosts ?? [])].map((k) => `${k.host}:${k.port}:${k.fingerprint}:${k.addedAt}`).sort(),
    sortKeys(v.deleted),
    sortKeys(v.secrets)
  ])
}

// ---- encryption ---------------------------------------------------------------

interface VaultFile {
  format: 'openterm-hub-vault'
  version: 1
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number }
  iv: string
  tag: string
  data: string
  updatedAt: number
}

const KDF = { N: 2 ** 17, r: 8, p: 1 }
const AAD = Buffer.from('openterm-hub-vault:1')

function scrypt(pass: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pass, salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key))))
}

const keyCache = new Map<string, Buffer>()

async function deriveKey(pass: string, kdf: VaultFile['kdf']): Promise<Buffer> {
  // The parameters come from a file: bounded, so a crafted vault cannot exhaust memory or CPU.
  if (kdf.name !== 'scrypt' || kdf.N > 2 ** 20 || kdf.N < 2 ** 14 || kdf.r > 16 || kdf.p > 4) throw new Error('Cofre com parâmetros de chave inválidos')
  const id = `${kdf.salt}:${kdf.N}:${kdf.r}:${kdf.p}:${pass}`
  const cached = keyCache.get(id)
  if (cached) return cached
  const key = await scrypt(pass, Buffer.from(kdf.salt, 'base64'), { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r })
  keyCache.clear()
  keyCache.set(id, key)
  return key
}

export async function encryptVault(v: VaultData, pass: string, salt?: string): Promise<string> {
  const kdf = { name: 'scrypt' as const, salt: salt ?? randomBytes(16).toString('base64'), ...KDF }
  const key = await deriveKey(pass, kdf)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(v))), cipher.final()])
  const file: VaultFile = {
    format: 'openterm-hub-vault',
    version: 1,
    kdf,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    updatedAt: Date.now()
  }
  return JSON.stringify(file, null, 1)
}

export class WrongPassphrase extends Error {
  constructor() {
    super('Senha do cofre incorreta (ou arquivo corrompido)')
  }
}

export async function decryptVault(text: string, pass: string): Promise<{ data: VaultData; salt: string }> {
  const f = JSON.parse(text) as VaultFile
  if (f?.format !== 'openterm-hub-vault' || f.version !== 1) throw new Error('Arquivo não é um cofre do OpenTerm Hub')
  const key = await deriveKey(pass, f.kdf)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'))
  decipher.setAAD(AAD)
  decipher.setAuthTag(Buffer.from(f.tag, 'base64'))
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(f.data, 'base64')), decipher.final()])
  } catch {
    throw new WrongPassphrase()
  }
  return { data: JSON.parse(gunzipSync(plain).toString('utf8')) as VaultData, salt: f.kdf.salt }
}

// ---- scheduling -----------------------------------------------------------------

export interface SyncStore {
  syncPayload(): VaultData
  applySync(v: VaultData): void
  settings(): { syncEnabled: boolean; syncFolder: string }
  getSecret(name: string): string | undefined
  onChange(cb: () => void): void
}

const DEBOUNCE_MS = 2000
const PERIOD_MS = 5 * 60_000

export class Sync {
  private state: Omit<SyncStatus, 'enabled' | 'folder' | 'hasPassphrase'> = { busy: false }
  private running: Promise<void> | null = null
  private again = false
  private applying = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private watcher: FSWatcher | undefined

  constructor(
    private store: SyncStore,
    private emit: (s: SyncStatus) => void
  ) {
    store.onChange(() => {
      if (!this.applying) this.schedule()
    })
  }

  status(): SyncStatus {
    const { syncEnabled, syncFolder } = this.store.settings()
    return { enabled: syncEnabled, folder: syncFolder, hasPassphrase: !!this.store.getSecret('sync:passphrase'), ...this.state }
  }

  /** (Re)starts watching after the settings changed; syncs right away when enabled. */
  restart(): void {
    this.watcher?.close()
    this.watcher = undefined
    clearInterval(this.interval)
    const { syncEnabled, syncFolder } = this.store.settings()
    if (!syncEnabled || !syncFolder) {
      this.state = { busy: false }
      this.emit(this.status())
      return
    }
    try {
      // Network and FUSE folders may not report changes: the periodic sync covers them.
      this.watcher = watch(syncFolder, (_e, name) => {
        if (!name || VAULT_RE.test(String(name))) this.schedule()
      })
      this.watcher.on('error', () => {})
    } catch {
      /* folder missing: reported by the sync itself */
    }
    this.interval = setInterval(() => this.schedule(0), PERIOD_MS)
    this.schedule(0)
  }

  stop(): void {
    this.watcher?.close()
    clearInterval(this.interval)
    clearTimeout(this.timer)
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (!this.store.settings().syncEnabled) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.syncNow(), delay)
  }

  async syncNow(): Promise<SyncStatus> {
    if (this.running) {
      this.again = true
      await this.running
      return this.status()
    }
    this.running = this.run()
    try {
      await this.running
    } finally {
      this.running = null
    }
    if (this.again) {
      this.again = false
      return this.syncNow()
    }
    return this.status()
  }

  private async run(): Promise<void> {
    const { syncEnabled, syncFolder } = this.store.settings()
    const pass = this.store.getSecret('sync:passphrase')
    if (!syncEnabled || !syncFolder || !pass) return
    this.state = { ...this.state, busy: true }
    this.emit(this.status())
    try {
      if (!(await stat(syncFolder).catch(() => null))?.isDirectory()) throw new Error(`Pasta de sincronização não encontrada: ${syncFolder}`)
      const local = this.store.syncPayload()
      let merged = local
      let main: VaultData | undefined
      let salt: string | undefined
      const names = (await readdir(syncFolder)).filter((n) => VAULT_RE.test(n)).sort((a, b) => (a === VAULT_FILE ? -1 : b === VAULT_FILE ? 1 : a.localeCompare(b)))
      for (const name of names) {
        try {
          const v = await decryptVault(await readFile(join(syncFolder, name), 'utf8'), pass)
          if (name === VAULT_FILE) {
            main = v.data
            salt = v.salt
          }
          merged = mergeVaults(merged, v.data)
        } catch (err) {
          // The main vault must open; a broken conflict copy is skipped.
          if (name === VAULT_FILE) throw err
        }
      }
      const target = canonical(merged)
      if (target !== canonical(local)) {
        this.applying = true
        try {
          this.store.applySync(merged)
        } finally {
          this.applying = false
        }
      }
      if (!main || canonical(main) !== target) {
        const file = join(syncFolder, VAULT_FILE)
        // Dot name: the sync tool never ships a half-written file as the vault.
        const tmp = join(syncFolder, `.${VAULT_FILE}.${process.pid}.tmp`)
        await writeFile(tmp, await encryptVault(merged, pass, salt), { mode: 0o600 })
        await rename(tmp, file)
      }
      this.state = { busy: false, lastSync: Date.now() }
    } catch (err) {
      this.state = { ...this.state, busy: false, error: (err as Error).message }
    }
    this.emit(this.status())
  }
}
