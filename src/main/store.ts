import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  type ForwardRule,
  type Host,
  type Identity,
  type Workspace,
  type KnownHost,
  type Settings,
  type Snapshot,
  type Snippet,
  type SshKey
} from '@shared/types'

interface Data {
  hosts: Host[]
  groups: string[]
  identities: Identity[]
  workspaces: Workspace[]
  keys: SshKey[]
  snippets: Snippet[]
  forwards: ForwardRule[]
  knownHosts: KnownHost[]
  settings: Settings
  history: string[]
}

const HISTORY_LIMIT = 2000

export function normalizeGroup(name: string): string {
  return name
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
}

function emptyData(): Data {
  return {
    hosts: [],
    groups: [],
    identities: [],
    workspaces: [],
    keys: [],
    snippets: [],
    forwards: [],
    knownHosts: [],
    settings: { ...DEFAULT_SETTINGS },
    history: []
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic write: a crash mid-write never leaves a truncated file behind. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

export class Store {
  private dir = app.getPath('userData')
  private dataFile = join(this.dir, 'data.json')
  private secretsFile = join(this.dir, 'secrets.json')
  private data: Data
  private secrets: Record<string, string>
  private listeners = new Set<() => void>()
  private batching = false
  private dirty = false

  constructor() {
    mkdirSync(this.dir, { recursive: true })
    const loaded = readJson<Partial<Data>>(this.dataFile, {})
    const settings = { ...DEFAULT_SETTINGS, ...loaded.settings }
    settings.shortcuts = { ...DEFAULT_SETTINGS.shortcuts, ...loaded.settings?.shortcuts }
    // The old default stack: the font is now bundled, so keep just its name.
    if (settings.fontFamily === "'JetBrains Mono', 'DejaVu Sans Mono', monospace") settings.fontFamily = 'JetBrains Mono'
    this.data = { ...emptyData(), ...loaded, settings }
    // Hosts saved before identities existed.
    this.data.hosts = this.data.hosts.map((h) => ({
      ...h,
      group: normalizeGroup(h.group ?? ''),
      os: h.os ?? null,
      identityId: h.identityId ?? null
    }))
    const groupSet = new Set<string>((this.data.groups ?? []).map(normalizeGroup).filter(Boolean))
    for (const h of this.data.hosts) {
      if (h.group) groupSet.add(h.group)
    }
    this.data.groups = [...groupSet].sort((a, b) => a.localeCompare(b))
    this.data.workspaces = this.data.workspaces ?? []
    this.secrets = readJson<Record<string, string>>(this.secretsFile, {})
  }

  get secureStorage(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb)
  }

  private commit(): void {
    if (this.batching) {
      this.dirty = true
      return
    }
    writeJson(this.dataFile, this.data)
    for (const cb of this.listeners) cb()
  }

  /** Runs many changes with a single write (and a single UI refresh) at the end. */
  batch<T>(fn: () => T): T {
    this.batching = true
    try {
      return fn()
    } finally {
      this.batching = false
      if (this.dirty) {
        this.dirty = false
        this.commit()
      }
    }
  }

  snapshot(): Snapshot {
    const { hosts, groups, identities, workspaces, keys, snippets, forwards, knownHosts, settings } = this.data
    const allGroups = new Set<string>(groups ?? [])
    for (const h of hosts) if (h.group) allGroups.add(h.group)
    return {
      hosts,
      groups: [...allGroups].sort((a, b) => a.localeCompare(b)),
      identities,
      workspaces: workspaces ?? [],
      keys,
      snippets,
      forwards,
      knownHosts,
      settings,
      secureStorage: this.secureStorage
    }
  }

  // ---- secrets -------------------------------------------------------------

  getSecret(name: string): string | undefined {
    const raw = this.secrets[name]
    if (raw === undefined) return undefined
    const buf = Buffer.from(raw.slice(4), 'base64')
    return raw.startsWith('enc:') ? safeStorage.decryptString(buf) : buf.toString('utf8')
  }

  setSecret(name: string, value: string | undefined): void {
    if (value === undefined || value === '') {
      delete this.secrets[name]
    } else if (safeStorage.isEncryptionAvailable()) {
      this.secrets[name] = 'enc:' + safeStorage.encryptString(value).toString('base64')
    } else {
      this.secrets[name] = 'raw:' + Buffer.from(value, 'utf8').toString('base64')
    }
    writeJson(this.secretsFile, this.secrets)
  }

  // ---- generic collections -------------------------------------------------

  private upsert<K extends 'hosts' | 'identities' | 'workspaces' | 'keys' | 'snippets' | 'forwards'>(
    key: K,
    item: Omit<Data[K][number], 'id'> & { id?: string }
  ): Data[K][number] {
    const list = this.data[key] as Array<Data[K][number]>
    const full = { ...item, id: item.id || randomUUID() } as Data[K][number]
    const idx = list.findIndex((x) => x.id === full.id)
    if (idx >= 0) list[idx] = full
    else list.push(full)
    this.commit()
    return full
  }

  private remove(key: 'hosts' | 'identities' | 'workspaces' | 'keys' | 'snippets' | 'forwards', id: string): void {
    const list = this.data[key] as Array<{ id: string }>
    this.data[key] = list.filter((x) => x.id !== id) as never
  }

  // ---- hosts ---------------------------------------------------------------

  hosts(): Host[] {
    return this.data.hosts
  }

  host(id: string): Host | undefined {
    return this.data.hosts.find((h) => h.id === id)
  }

  saveHost(host: Omit<Host, 'id'> & { id?: string }): Host {
    const normalizedGroup = normalizeGroup(host.group ?? '')
    if (normalizedGroup && !this.data.groups.includes(normalizedGroup)) {
      this.data.groups.push(normalizedGroup)
      this.data.groups.sort((a, b) => a.localeCompare(b))
    }
    return this.upsert('hosts', { ...host, group: normalizedGroup, os: host.os ?? null })
  }

  saveGroup(name: string, previousName?: string, hostIds?: string[]): void {
    const clean = normalizeGroup(name)
    if (!clean) throw new Error('Informe o nome do grupo')
    const prev = previousName ? normalizeGroup(previousName) : ''
    const groupSet = new Set<string>(this.data.groups.map(normalizeGroup).filter(Boolean))
    for (const h of this.data.hosts) if (h.group) groupSet.add(h.group)

    if (prev && prev !== clean) {
      const nextGroups = new Set<string>()
      for (const g of groupSet) {
        if (g === prev) nextGroups.add(clean)
        else if (g.startsWith(prev + ' / ')) nextGroups.add(clean + g.slice(prev.length))
        else nextGroups.add(g)
      }
      groupSet.clear()
      for (const g of nextGroups) groupSet.add(g)
      for (const h of this.data.hosts) {
        if (h.group === prev) h.group = clean
        else if (h.group.startsWith(prev + ' / ')) h.group = clean + h.group.slice(prev.length)
      }
    }

    groupSet.add(clean)
    if (hostIds !== undefined) {
      const selected = new Set(hostIds)
      for (const h of this.data.hosts) {
        if (selected.has(h.id)) h.group = clean
        else if (h.group === clean) h.group = ''
      }
    }
    this.data.groups = [...groupSet].sort((a, b) => a.localeCompare(b))
    this.commit()
  }

  deleteGroup(name: string): void {
    const clean = normalizeGroup(name)
    if (!clean) return
    this.data.groups = this.data.groups.filter((g) => g !== clean && !g.startsWith(clean + ' / '))
    for (const h of this.data.hosts) {
      if (h.group === clean || h.group.startsWith(clean + ' / ')) h.group = ''
    }
    this.commit()
  }

  deleteHost(id: string): void {
    this.remove('hosts', id)
    this.data.forwards = this.data.forwards.filter((f) => f.hostId !== id)
    for (const h of this.data.hosts) if (h.jumpHostId === id) h.jumpHostId = null
    this.setSecret(`host:${id}:password`, undefined)
    this.commit()
  }

  // ---- identities ------------------------------------------------------------

  identities(): Identity[] {
    return this.data.identities
  }

  identity(id: string): Identity | undefined {
    return this.data.identities.find((i) => i.id === id)
  }

  saveIdentity(identity: Omit<Identity, 'id'> & { id?: string }): Identity {
    return this.upsert('identities', identity)
  }

  /** Hosts using it get its username copied in, so they still know who to log in as. */
  deleteIdentity(id: string): void {
    const identity = this.identity(id)
    this.remove('identities', id)
    for (const h of this.data.hosts) {
      if (h.identityId !== id) continue
      h.identityId = null
      if (identity && !h.username) h.username = identity.username
    }
    this.setSecret(`identity:${id}:password`, undefined)
    this.commit()
  }

  /** Effective login of a host: its identity's when it has one, otherwise its own. */
  credentials(host: Host): { username: string; password: string | undefined; keyId: string | null } {
    const identity = host.identityId ? this.identity(host.identityId) : undefined
    if (identity) {
      return { username: identity.username, password: this.getSecret(`identity:${identity.id}:password`), keyId: identity.keyId }
    }
    return { username: host.username, password: this.getSecret(`host:${host.id}:password`), keyId: host.keyId }
  }


  // ---- workspaces ------------------------------------------------------------

  workspaces(): Workspace[] {
    return this.data.workspaces ?? []
  }

  workspace(id: string): Workspace | undefined {
    return (this.data.workspaces ?? []).find((w) => w.id === id)
  }

  saveWorkspace(workspace: Omit<Workspace, 'id'> & { id?: string }): Workspace {
    return this.upsert('workspaces', workspace)
  }

  deleteWorkspace(id: string): void {
    this.remove('workspaces', id)
    this.commit()
  }

  // ---- keys ----------------------------------------------------------------

  keys(): SshKey[] {
    return this.data.keys
  }

  key(id: string): SshKey | undefined {
    return this.data.keys.find((k) => k.id === id)
  }

  saveKey(key: Omit<SshKey, 'id'> & { id?: string }): SshKey {
    return this.upsert('keys', key)
  }

  deleteKey(id: string): void {
    this.remove('keys', id)
    for (const h of this.data.hosts) if (h.keyId === id) h.keyId = null
    for (const i of this.data.identities) if (i.keyId === id) i.keyId = null
    this.setSecret(`key:${id}:private`, undefined)
    this.setSecret(`key:${id}:passphrase`, undefined)
    this.commit()
  }

  // ---- snippets / forwards -------------------------------------------------

  snippet(id: string): Snippet | undefined {
    return this.data.snippets.find((s) => s.id === id)
  }

  snippets(): Snippet[] {
    return this.data.snippets
  }

  saveSnippet(s: Omit<Snippet, 'id'> & { id?: string }): Snippet {
    return this.upsert('snippets', s)
  }

  deleteSnippet(id: string): void {
    this.remove('snippets', id)
    for (const h of this.data.hosts) if (h.startupSnippetId === id) h.startupSnippetId = null
    this.commit()
  }

  forward(id: string): ForwardRule | undefined {
    return this.data.forwards.find((f) => f.id === id)
  }

  saveForward(r: Omit<ForwardRule, 'id'> & { id?: string }): ForwardRule {
    return this.upsert('forwards', r)
  }

  deleteForward(id: string): void {
    this.remove('forwards', id)
    this.commit()
  }

  // ---- known hosts ---------------------------------------------------------

  knownHost(host: string, port: number): KnownHost | undefined {
    return this.data.knownHosts.find((k) => k.host === host && k.port === port)
  }

  trustHost(entry: KnownHost): void {
    this.data.knownHosts = this.data.knownHosts.filter((k) => !(k.host === entry.host && k.port === entry.port))
    this.data.knownHosts.push(entry)
    this.commit()
  }

  deleteKnownHost(host: string, port: number): void {
    this.data.knownHosts = this.data.knownHosts.filter((k) => !(k.host === host && k.port === port))
    this.commit()
  }

  // ---- settings / history --------------------------------------------------

  settings(): Settings {
    return this.data.settings
  }

  saveSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.commit()
    return this.data.settings
  }

  history(): string[] {
    return this.data.history
  }

  recordHistory(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    const h = this.data.history.filter((x) => x !== trimmed)
    h.push(trimmed)
    this.data.history = h.slice(-HISTORY_LIMIT)
    // History changes on every command; persist without notifying the UI.
    writeJson(this.dataFile, this.data)
  }

  // ---- backup --------------------------------------------------------------

  /** Backup without any secret (passwords, private keys). */
  exportBackup(): object {
    const { hosts, groups, identities, workspaces, keys, snippets, forwards, knownHosts, settings } = this.data
    return { format: 'openterm-hub-backup', version: 1, hosts, groups: groups ?? [], identities, workspaces: workspaces ?? [], keys, snippets, forwards, knownHosts, settings }
  }

  importBackup(raw: unknown): void {
    const b = raw as Partial<Data> & { format?: string }
    if (b?.format !== 'openterm-hub-backup') throw new Error('Arquivo de backup inválido')
    const merge = <T extends { id: string }>(cur: T[], inc: T[] | undefined): T[] => {
      const map = new Map(cur.map((x) => [x.id, x]))
      for (const x of inc ?? []) map.set(x.id, { ...map.get(x.id), ...x })
      return [...map.values()]
    }
    this.data.identities = merge(
      this.data.identities,
      b.identities?.map((i) => ({ ...i, hasPassword: !!this.getSecret(`identity:${i.id}:password`) }))
    )
    this.data.hosts = merge(
      this.data.hosts,
      b.hosts?.map((h) => ({
        ...h,
        group: normalizeGroup(h.group ?? ''),
        os: h.os ?? null,
        identityId: h.identityId ?? null,
        hasPassword: !!this.getSecret(`host:${h.id}:password`)
      }))
    )
    const groupSet = new Set<string>([...(this.data.groups ?? []), ...(b.groups ?? [])].map(normalizeGroup).filter(Boolean))
    for (const h of this.data.hosts) if (h.group) groupSet.add(h.group)
    this.data.groups = [...groupSet].sort((a, b) => a.localeCompare(b))
    this.data.workspaces = merge(this.data.workspaces ?? [], (b as { workspaces?: Workspace[] }).workspaces)
    this.data.keys = merge(this.data.keys, b.keys)
    this.data.snippets = merge(this.data.snippets, b.snippets)
    this.data.forwards = merge(this.data.forwards, b.forwards)
    for (const k of b.knownHosts ?? []) {
      if (!this.knownHost(k.host, k.port)) this.data.knownHosts.push(k)
    }
    if (b.settings) this.data.settings = { ...this.data.settings, ...b.settings }
    this.commit()
  }
}
