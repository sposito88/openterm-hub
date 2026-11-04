import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import v8 from 'node:v8'
import nacl from 'tweetnacl'
import type { Host, ImportClientSource, ImportSummary, OsId, Protocol, ProxyType } from '@shared/types'
import { describeKey, importKey } from './keys'
import { parseJump, parseSshConfig } from './sshconfig'
import { normalizeGroup, type Store } from './store'

/**
 * Import format for migrating from other SSH clients, with secrets included.
 * Documented in docs/IMPORT.md.
 */
export interface ImportFile {
  format: 'openterm-hub-import'
  version: 1
  groups?: string[]
  keys?: Array<{ ref: string; label: string; privateKey: string; passphrase?: string }>
  /** Reusable logins; hosts point at them with identityRef. */
  identities?: Array<{ ref: string; label: string; username: string; password?: string; keyRef?: string }>
  hosts?: Array<{
    ref?: string
    label: string
    group?: string
    hostname: string
    port?: number
    username?: string
    password?: string
    keyRef?: string
    /** When set, username, password and keyRef of the host are ignored. */
    identityRef?: string
    protocol?: Protocol
    os?: OsId | null
    agentForward?: boolean
    jumpHostRef?: string
    snippetRef?: string
    tags?: string[]
    proxy?: {
      type: ProxyType
      host: string
      port: number
      username?: string
      password?: string
    } | null
  }>
  snippets?: Array<{ ref?: string; label: string; script: string }>
  /** publicKey as in known_hosts / authorized_keys: "ssh-ed25519 AAAA…". */
  knownHosts?: Array<{ host: string; port?: number; publicKey: string }>
}

export function isImportFile(raw: unknown): raw is ImportFile {
  return (raw as ImportFile)?.format === 'openterm-hub-import'
}

export function importFile(store: Store, file: ImportFile): ImportSummary {
  if (file.version !== 1) throw new Error('Versão do arquivo de importação não suportada')
  const sum: ImportSummary = { hosts: 0, identities: 0, linked: 0, keys: 0, snippets: 0, knownHosts: 0, skipped: 0, errors: [] }

  for (const g of file.groups ?? []) {
    if (g?.trim()) store.saveGroup(g)
  }

  // Keys: reuse an existing key with the same fingerprint.
  const keyIds = new Map<string, string>()
  for (const k of file.keys ?? []) {
    try {
      const { fingerprint } = describeKey(k.privateKey, k.passphrase || undefined, k.label)
      const existing = store.keys().find((x) => x.fingerprint === fingerprint)
      if (existing) {
        keyIds.set(k.ref, existing.id)
        sum.skipped++
        continue
      }
      keyIds.set(k.ref, importKey(store, { label: k.label, privateKey: k.privateKey, passphrase: k.passphrase }).id)
      sum.keys++
    } catch (err) {
      sum.errors.push(`Chave "${k.label}": ${(err as Error).message}`)
    }
  }

  // Identities: reuse one with the same username, password and key.
  const identityIds = new Map<string, string>()
  for (const i of file.identities ?? []) {
    if (!i.username?.trim()) {
      sum.errors.push(`Identidade "${i.label}": sem usuário`)
      continue
    }
    const keyId = (i.keyRef && keyIds.get(i.keyRef)) || null
    const existing = store
      .identities()
      .find((x) => x.username === i.username && x.keyId === keyId && (store.getSecret(`identity:${x.id}:password`) ?? '') === (i.password ?? ''))
    if (existing) {
      identityIds.set(i.ref, existing.id)
      sum.skipped++
      continue
    }
    const saved = store.saveIdentity({ label: i.label || i.username, username: i.username, hasPassword: !!i.password, keyId })
    if (i.password) store.setSecret(`identity:${saved.id}:password`, i.password)
    identityIds.set(i.ref, saved.id)
    sum.identities++
  }

  // Snippets: reuse one with the same script.
  const snippetIds = new Map<string, string>()
  for (const s of file.snippets ?? []) {
    if (!s.script?.trim()) continue
    const existing = store.snippets().find((x) => x.script === s.script)
    const id = existing?.id ?? store.saveSnippet({ label: s.label || s.script.slice(0, 40), script: s.script }).id
    if (existing) sum.skipped++
    else sum.snippets++
    if (s.ref) snippetIds.set(s.ref, id)
  }

  // Hosts: skip only exact copies (same address, label, group and effective login).
  // Entries for the same server that differ are kept, since either could be in use.
  const hostIds = new Map<string, string>()
  const pendingJumps: Array<[string, string]> = []
  for (const h of file.hosts ?? []) {
    const port = Number(h.port) || (h.protocol === 'telnet' ? 23 : 22)
    if (!h.hostname?.trim()) {
      sum.errors.push(`Host "${h.label}": sem endereço`)
      continue
    }
    const group = normalizeGroup(h.group ?? '')
    const identityId = (h.identityRef && identityIds.get(h.identityRef)) || null
    const identity = identityId ? store.identity(identityId) : undefined
    const username = identity ? '' : (h.username ?? '')
    const password = identity ? undefined : h.password
    const effective = identity
      ? { username: identity.username, password: store.getSecret(`identity:${identity.id}:password`) ?? '' }
      : { username, password: password ?? '' }
    const label = h.label || h.hostname
    const existing = store.hosts().find((x) => {
      const c = store.credentials(x)
      return (
        x.hostname === h.hostname.trim() &&
        x.port === port &&
        x.label === label &&
        normalizeGroup(x.group ?? '') === group &&
        c.username === effective.username &&
        (c.password ?? '') === effective.password
      )
    })
    if (existing) {
      if (h.ref) hostIds.set(h.ref, existing.id)
      if (identityId && !existing.identityId) {
        // Same login as before, now shared: link it and drop the host's own copy.
        store.saveHost({ ...existing, identityId, username: '', hasPassword: false, keyId: null })
        store.setSecret(`host:${existing.id}:password`, undefined)
        sum.linked++
      } else {
        sum.skipped++
      }
      continue
    }
    const proxy = h.proxy?.host?.trim()
      ? {
          type: h.proxy.type,
          host: h.proxy.host.trim(),
          port: Number(h.proxy.port) || 1080,
          username: (h.proxy.username ?? '').trim(),
          hasPassword: !!h.proxy.password
        }
      : null
    const host: Omit<Host, 'id'> = {
      label,
      group,
      hostname: h.hostname.trim(),
      port,
      username,
      protocol: h.protocol ?? 'ssh',
      os: h.os ?? null,
      hasPassword: !!password,
      keyId: identity ? null : (h.keyRef && keyIds.get(h.keyRef)) || null,
      identityId,
      useAgent: !identity && !password && !h.keyRef,
      agentForward: !!h.agentForward,
      jumpHostId: null,
      startupSnippetId: (h.snippetRef && snippetIds.get(h.snippetRef)) || null,
      tags: h.tags ?? [],
      proxy
    }
    const saved = store.saveHost(host)
    if (password) store.setSecret(`host:${saved.id}:password`, password)
    if (proxy && h.proxy?.password) store.setSecret(`host:${saved.id}:proxyPassword`, h.proxy.password)
    if (h.ref) hostIds.set(h.ref, saved.id)
    if (h.jumpHostRef) pendingJumps.push([saved.id, h.jumpHostRef])
    sum.hosts++
  }
  for (const [id, ref] of pendingJumps) {
    const jump = hostIds.get(ref)
    const host = store.host(id)
    if (host && jump && jump !== id) store.saveHost({ ...host, jumpHostId: jump })
  }

  // Known hosts: keep fingerprints already trusted.
  for (const k of file.knownHosts ?? []) {
    const [keyType, b64] = k.publicKey.trim().split(/\s+/)
    if (!keyType || !b64) {
      sum.errors.push(`Known host "${k.host}": chave pública inválida`)
      continue
    }
    const port = Number(k.port) || 22
    if (store.knownHost(k.host, port)) {
      sum.skipped++
      continue
    }
    const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')
    store.trustHost({ host: k.host, port, keyType, fingerprint, addedAt: new Date().toISOString() })
    sum.knownHosts++
  }
  return sum
}

// ---- External client parsers (Termius, PuTTY, MobaXterm, SSH config) --------

/**
 * Decodes a Buffer that may be UTF-16LE (common in Windows .reg exports),
 * UTF-16BE, UTF-8 (with or without BOM), or Windows-1252 / Latin-1 (common in MobaXterm .mxtsessions/.ini).
 */
export function decodeBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2)
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return swapped.toString('utf16le')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  // Heuristic for BOM-less UTF-16LE
  if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00) {
    return buf.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  if (utf8.includes('\uFFFD')) {
    return buf.toString('latin1')
  }
  return utf8
}

function cleanGroupPath(raw: string | undefined, fallback = ''): string {
  if (!raw) return fallback
  const normalized = normalizeGroup(raw.replace(/[\\>]/g, '/'))
  return normalized || fallback
}

function normalizeProtocol(raw: string | undefined): Protocol {
  const p = (raw ?? '').trim().toLowerCase()
  if (p === 'telnet') return 'telnet'
  if (p === 'mosh') return 'mosh'
  return 'ssh'
}

/** RFC 4180 CSV parser supporting `,` and `;` delimiters, quoted fields and multiline values. */
export function parseCsvRows(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '')
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ''
  // Auto-detect semicolon vs comma outside quotes
  let commas = 0
  let semis = 0
  let inQuotes = false
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch === ',') commas++
    else if (!inQuotes && ch === ';') semis++
  }
  const delim = semis > commas ? ';' : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delim) {
      row.push(field.trim())
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i++
      row.push(field.trim())
      field = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field.trim() || row.length > 0) {
    row.push(field.trim())
    if (row.some((c) => c !== '')) rows.push(row)
  }
  return rows
}

/**
 * Parses Termius CSV exports.
 * Standard Termius header: `Groups,Label,Tags,Hostname/IP,Protocol,Port`
 * Also supports extended columns: `Username`, `Password`, `Key`, `Jump Host`.
 */
export function parseTermiusCsv(text: string): ImportFile {
  const rows = parseCsvRows(text)
  if (rows.length === 0) throw new Error('Arquivo CSV vazio')

  const headerRaw = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, ''))
  const isHeader = headerRaw.some((h) =>
    ['groups', 'group', 'label', 'name', 'hostname/ip', 'hostname', 'address', 'ip', 'host', 'protocol', 'port'].includes(h)
  )

  const colIdx = (names: string[], fallback = -1): number => {
    if (!isHeader) return fallback
    return headerRaw.findIndex((h) => names.includes(h))
  }

  const iGroup = colIdx(['groups', 'group', 'folder', 'grupo', 'grupos'], 0)
  const iLabel = colIdx(['label', 'name', 'title', 'nome'], 1)
  const iTags = colIdx(['tags', 'tag'], 2)
  const iHost = colIdx(['hostname/ip', 'hostname', 'address', 'ip', 'host', 'endereco', 'endereço'], 3)
  const iProto = colIdx(['protocol', 'proto', 'protocolo'], 4)
  const iPort = colIdx(['port', 'porta'], 5)
  const iUser = colIdx(['username', 'user', 'login', 'usuario', 'usuário'], 6)
  const iPass = colIdx(['password', 'pass', 'senha'], 7)
  const iKey = colIdx(['key', 'privatekey', 'private_key', 'sshkey', 'ssh_key'], 8)
  const iJump = colIdx(['jumphost', 'jump_host', 'proxyjump', 'proxy_jump', 'bastion'], 9)

  const dataRows = isHeader ? rows.slice(1) : rows
  const hosts: NonNullable<ImportFile['hosts']> = []
  const keys: NonNullable<ImportFile['keys']> = []
  const groups = new Set<string>()
  const refByLabel = new Map<string, string>()
  const jumpTargets: Array<{ hostIdx: number; jumpName: string }> = []

  dataRows.forEach((r, idx) => {
    const get = (i: number): string => (i >= 0 && i < r.length ? r[i].trim() : '')
    let hostname = get(iHost)
    let username = get(iUser)
    if (!hostname) return
    if (hostname.includes('@') && !username) {
      const [u, h] = hostname.split('@')
      username = u
      hostname = h
    }
    const protoRaw = get(iProto).toLowerCase()
    if (protoRaw && !['ssh', 'sftp', 'mosh', 'telnet'].includes(protoRaw)) return

    const protocol = normalizeProtocol(protoRaw)
    const defaultPort = protocol === 'telnet' ? 23 : 22
    const port = Number(get(iPort)) || defaultPort
    const label = get(iLabel) || hostname
    const group = cleanGroupPath(get(iGroup), 'Termius')
    if (group) groups.add(group)

    const tags = get(iTags)
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter(Boolean)
    const password = get(iPass) || undefined
    const rawKey = get(iKey)
    let keyRef: string | undefined
    if (rawKey && rawKey.includes('BEGIN ')) {
      keyRef = `k_${idx}`
      keys.push({ ref: keyRef, label: `${label}-key`, privateKey: rawKey.replace(/\\n/g, '\n') })
    }

    const ref = `h_${idx}`
    refByLabel.set(label.toLowerCase(), ref)
    refByLabel.set(hostname.toLowerCase(), ref)

    const jumpName = get(iJump)
    if (jumpName) jumpTargets.push({ hostIdx: hosts.length, jumpName })

    hosts.push({
      ref,
      label,
      group,
      hostname,
      port,
      username: username || undefined,
      password,
      keyRef,
      protocol,
      tags
    })
  })

  for (const { hostIdx, jumpName } of jumpTargets) {
    const targetRef = refByLabel.get(jumpName.toLowerCase())
    if (targetRef) hosts[hostIdx].jumpHostRef = targetRef
  }

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groups],
    keys,
    hosts
  }
}

/**
 * Parses Termius JSON exports or structured objects (hosts, groups, identities, keys, snippets).
 */
export function parseTermiusJson(raw: unknown): ImportFile {
  if (isImportFile(raw)) return raw
  const obj = Array.isArray(raw) ? { hosts: raw } : (raw as Record<string, unknown>)
  if (!obj || typeof obj !== 'object') throw new Error('JSON do Termius inválido')

  // Group tree resolution (Termius uses id + parent_group_id / parent_id)
  const rawGroups = (Array.isArray(obj.groups) ? obj.groups : []) as Array<Record<string, unknown> | string>
  const groupById = new Map<string, { name: string; parentId?: string }>()
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue
    const id = String(g.id ?? g.pk ?? '')
    const name = String(g.label ?? g.name ?? g.title ?? '').trim()
    const parentId = g.parent_group_id ?? g.parent_id ?? (g.parent_group as Record<string, unknown>)?.id
    if (id && name) groupById.set(id, { name, parentId: parentId ? String(parentId) : undefined })
  }
  const resolveGroupById = (id: string): string => {
    const parts: string[] = []
    const seen = new Set<string>()
    let cur: string | undefined = id
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const g = groupById.get(cur)
      if (!g) break
      parts.unshift(g.name)
      cur = g.parentId
    }
    return cleanGroupPath(parts.join(' / '))
  }

  const groups = new Set<string>()
  for (const id of groupById.keys()) {
    const path = resolveGroupById(id)
    if (path) groups.add(path)
  }
  for (const g of rawGroups) {
    if (typeof g === 'string' && g.trim()) groups.add(cleanGroupPath(g))
  }

  const keys: NonNullable<ImportFile['keys']> = []
  const rawKeys = (Array.isArray(obj.keys) ? obj.keys : Array.isArray(obj.ssh_keys) ? obj.ssh_keys : []) as Array<Record<string, unknown>>
  for (let i = 0; i < rawKeys.length; i++) {
    const k = rawKeys[i]
    if (!k || typeof k !== 'object') continue
    const priv = String(k.private_key ?? k.privateKey ?? k.key ?? '').trim()
    if (!priv) continue
    const ref = String(k.id ?? k.pk ?? k.ref ?? `k_${i}`)
    const label = String(k.label ?? k.name ?? k.title ?? `termius-key-${i + 1}`).trim()
    const passphrase = k.passphrase ? String(k.passphrase) : undefined
    keys.push({ ref, label, privateKey: priv, passphrase })
  }

  const identities: NonNullable<ImportFile['identities']> = []
  const rawIdentities = (Array.isArray(obj.identities) ? obj.identities : []) as Array<Record<string, unknown>>
  for (let i = 0; i < rawIdentities.length; i++) {
    const idObj = rawIdentities[i]
    if (!idObj || typeof idObj !== 'object') continue
    const username = String(idObj.username ?? idObj.user ?? '').trim()
    if (!username) continue
    const ref = String(idObj.id ?? idObj.pk ?? idObj.ref ?? `i_${i}`)
    const label = String(idObj.label ?? idObj.name ?? username).trim()
    const password = idObj.password ? String(idObj.password) : undefined
    const keyRefRaw = idObj.ssh_key_id ?? idObj.key_id ?? idObj.keyRef ?? (idObj.ssh_key as Record<string, unknown>)?.id
    const keyRef = keyRefRaw ? String(keyRefRaw) : undefined
    identities.push({ ref, label, username, password, keyRef })
  }

  const snippets: NonNullable<ImportFile['snippets']> = []
  const rawSnippets = (Array.isArray(obj.snippets) ? obj.snippets : []) as Array<Record<string, unknown>>
  for (let i = 0; i < rawSnippets.length; i++) {
    const s = rawSnippets[i]
    if (!s || typeof s !== 'object') continue
    const script = String(s.script ?? s.command ?? s.body ?? '').trim()
    if (!script) continue
    const ref = String(s.id ?? s.pk ?? s.ref ?? `s_${i}`)
    const label = String(s.label ?? s.name ?? s.title ?? script.slice(0, 40)).trim()
    snippets.push({ ref, label, script })
  }

  const hosts: NonNullable<ImportFile['hosts']> = []
  const rawHosts = (
    Array.isArray(obj.hosts) ? obj.hosts : Array.isArray(obj.servers) ? obj.servers : Array.isArray(obj.items) ? obj.items : []
  ) as Array<Record<string, unknown>>

  for (let i = 0; i < rawHosts.length; i++) {
    const h = rawHosts[i]
    if (!h || typeof h !== 'object') continue
    const sshCfg = (h.ssh_config && typeof h.ssh_config === 'object' ? h.ssh_config : {}) as Record<string, unknown>
    const hostname = String(h.address ?? h.hostname ?? h.ip ?? h.host ?? '').trim()
    if (!hostname) continue
    const label = String(h.label ?? h.name ?? h.title ?? h.alias ?? hostname).trim() || hostname
    const port = Number(h.port ?? sshCfg.port) || 22
    const username = String(h.username ?? h.user ?? sshCfg.username ?? sshCfg.user ?? '').trim() || undefined
    const password = h.password ? String(h.password) : sshCfg.password ? String(sshCfg.password) : undefined

    let group = ''
    const groupId = h.group_id ?? (h.group as Record<string, unknown>)?.id
    if (groupId && groupById.has(String(groupId))) {
      group = resolveGroupById(String(groupId))
    } else if (typeof h.group === 'string') {
      group = cleanGroupPath(h.group)
    } else if (typeof h.group_name === 'string') {
      group = cleanGroupPath(h.group_name)
    } else if (Array.isArray(h.groups)) {
      group = cleanGroupPath(h.groups.map(String).join(' / '))
    }
    if (!group) group = 'Termius'
    groups.add(group)

    const idRefRaw = h.identity_id ?? h.identityRef ?? sshCfg.identity_id ?? (sshCfg.identity as Record<string, unknown>)?.id
    const keyRefRaw = h.ssh_key_id ?? h.key_id ?? h.keyRef ?? sshCfg.ssh_key_id ?? (sshCfg.ssh_key as Record<string, unknown>)?.id
    const jumpRefRaw = h.jump_host_id ?? h.jumpHostRef ?? sshCfg.proxy_jump_id ?? (sshCfg.proxy_jump as Record<string, unknown>)?.id
    const snippetRefRaw = h.startup_snippet_id ?? h.snippetRef ?? sshCfg.startup_snippet_id ?? (sshCfg.startup_snippet as Record<string, unknown>)?.id

    const rawTags = h.tags
    const tags = Array.isArray(rawTags)
      ? rawTags.map((t) => (typeof t === 'object' && t ? String((t as Record<string, unknown>).label ?? (t as Record<string, unknown>).name ?? '') : String(t))).filter(Boolean)
      : typeof rawTags === 'string'
        ? rawTags.split(/[,;]/).map((t) => t.trim()).filter(Boolean)
        : []

    hosts.push({
      ref: String(h.id ?? h.pk ?? h.ref ?? `h_${i}`),
      label,
      group,
      hostname,
      port,
      username,
      password,
      identityRef: idRefRaw ? String(idRefRaw) : undefined,
      keyRef: keyRefRaw ? String(keyRefRaw) : undefined,
      jumpHostRef: jumpRefRaw ? String(jumpRefRaw) : undefined,
      snippetRef: snippetRefRaw ? String(snippetRefRaw) : undefined,
      protocol: normalizeProtocol(String(h.protocol ?? 'ssh')),
      agentForward: !!(h.agentForward ?? h.agent_forwarding ?? sshCfg.agent_forwarding),
      tags
    })
  }

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groups],
    keys,
    identities,
    snippets,
    hosts
  }
}

/**
 * Converts an ssh_config file (either ~/.ssh/config or a Termius SSH config export) into an ImportFile.
 */
export function parseSshConfigToImport(
  text: string,
  home: string,
  opts?: { singleHostPerBlock?: boolean; defaultGroup?: string; readKey?: (path: string) => string | null }
): ImportFile {
  const defaultGroup = opts?.defaultGroup ?? 'ssh config'
  const entries = parseSshConfig(text, home, {
    singleHostPerBlock: opts?.singleHostPerBlock,
    defaultGroup
  })

  const keys: NonNullable<ImportFile['keys']> = []
  const keyRefByPath = new Map<string, string | undefined>()
  const getKeyRef = (filePath: string | undefined): string | undefined => {
    if (!filePath || !opts?.readKey) return undefined
    if (!keyRefByPath.has(filePath)) {
      const priv = opts.readKey(filePath)
      if (priv) {
        const ref = `k_${keys.length}`
        const label = filePath.split(/[\\/]/).pop() || 'ssh-key'
        keys.push({ ref, label, privateKey: priv })
        keyRefByPath.set(filePath, ref)
      } else {
        keyRefByPath.set(filePath, undefined)
      }
    }
    return keyRefByPath.get(filePath)
  }

  const hosts: NonNullable<ImportFile['hosts']> = []
  const groups = new Set<string>()
  const refByAlias = new Map<string, string>()

  entries.forEach((e, idx) => {
    const ref = `ssh_${idx}`
    const group = cleanGroupPath(e.group, defaultGroup)
    if (group) groups.add(group)
    refByAlias.set(e.alias.toLowerCase(), ref)
    hosts.push({
      ref,
      label: e.alias,
      group,
      hostname: e.hostname,
      port: e.port ?? 22,
      username: e.user,
      password: e.password,
      keyRef: getKeyRef(e.identityFile),
      protocol: 'ssh',
      agentForward: !!e.agentForward,
      tags: e.tags ?? []
    })
  })

  entries.forEach((e, idx) => {
    if (!e.proxyJump) return
    let jumpRef = refByAlias.get(e.proxyJump.toLowerCase())
    if (!jumpRef) {
      const j = parseJump(e.proxyJump)
      jumpRef = `ssh_jump_${idx}`
      const group = cleanGroupPath(e.group, defaultGroup)
      hosts.push({
        ref: jumpRef,
        label: e.proxyJump,
        group,
        hostname: j.host,
        port: j.port ?? 22,
        username: j.user,
        protocol: 'ssh'
      })
      refByAlias.set(e.proxyJump.toLowerCase(), jumpRef)
    }
    if (jumpRef !== hosts[idx].ref) {
      hosts[idx].jumpHostRef = jumpRef
    }
  })

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groups],
    keys,
    hosts
  }
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%20'))
  } catch {
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }
}

interface PuttyRawSession {
  name: string
  values: Record<string, string>
}

function buildImportFromPuttySessions(sessions: PuttyRawSession[], readKey?: (path: string) => string | null): ImportFile {
  const hosts: NonNullable<ImportFile['hosts']> = []
  const keys: NonNullable<ImportFile['keys']> = []
  const snippets: NonNullable<ImportFile['snippets']> = []
  const groups = new Set<string>()
  const keyRefByPath = new Map<string, string | undefined>()

  const getKeyRef = (filePath: string | undefined): string | undefined => {
    if (!filePath || !readKey) return undefined
    if (!keyRefByPath.has(filePath)) {
      const priv = readKey(filePath)
      if (priv) {
        const ref = `pk_${keys.length}`
        const label = filePath.split(/[\\/]/).pop()?.replace(/\.ppk$/i, '') || 'putty-key'
        keys.push({ ref, label, privateKey: priv })
        keyRefByPath.set(filePath, ref)
      } else {
        keyRefByPath.set(filePath, undefined)
      }
    }
    return keyRefByPath.get(filePath)
  }

  sessions.forEach((sess, idx) => {
    const label = safeDecodeUri(sess.name).trim()
    if (!label || label.toLowerCase() === 'default settings') return

    const v = sess.values
    let hostname = (v.HostName ?? '').trim()
    if (!hostname) return

    const protoRaw = (v.Protocol ?? 'ssh').toLowerCase()
    if (protoRaw !== 'ssh' && protoRaw !== 'telnet' && protoRaw !== 'mosh') return
    const protocol = normalizeProtocol(protoRaw)

    let username = (v.UserName ?? '').trim()
    if (hostname.includes('@')) {
      const [u, h] = hostname.split('@')
      if (!username) username = u
      hostname = h
    }

    const defaultPort = protocol === 'telnet' ? 23 : 22
    const port = Number(v.PortNumber) || defaultPort
    const folderRaw = safeDecodeUri(v.Folder ?? v.PuttySubFolder ?? '').trim()
    const group = cleanGroupPath(folderRaw && folderRaw !== 'Default' ? folderRaw : '', 'PuTTY')
    if (group) groups.add(group)

    const password = v.Password ? v.Password : undefined
    const keyRef = getKeyRef(v.PublicKeyFile)
    const agentForward = Number(v.AgentFwd) === 1

    let snippetRef: string | undefined
    const remoteCmd = (v.RemoteCommand ?? '').trim()
    if (remoteCmd) {
      snippetRef = `ps_${idx}`
      snippets.push({ ref: snippetRef, label: `${label} (startup)`, script: remoteCmd })
    }

    // PuTTY ProxyMethod: 2 = SOCKS5, 3 = HTTP
    const proxyMethod = Number(v.ProxyMethod) || 0
    const proxyHost = (v.ProxyHost ?? '').trim()
    let proxy: NonNullable<ImportFile['hosts']>[number]['proxy'] = null
    if ((proxyMethod === 2 || proxyMethod === 3) && proxyHost && proxyHost !== 'proxy') {
      proxy = {
        type: proxyMethod === 3 ? 'http' : 'socks5',
        host: proxyHost,
        port: Number(v.ProxyPort) || (proxyMethod === 3 ? 8080 : 1080),
        username: (v.ProxyUsername ?? '').trim() || undefined,
        password: v.ProxyPassword || undefined
      }
    }

    hosts.push({
      ref: `putty_${idx}`,
      label,
      group,
      hostname,
      port,
      username: username || undefined,
      password,
      keyRef,
      protocol,
      agentForward,
      snippetRef,
      proxy
    })
  })

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groups],
    keys,
    snippets,
    hosts
  }
}

/**
 * Parses a Windows Registry `.reg` file exported from PuTTY or KiTTY.
 */
export function parsePuttyReg(text: string, readKey?: (path: string) => string | null): ImportFile {
  const sessions: PuttyRawSession[] = []
  let current: PuttyRawSession | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue

    const secMatch = line.match(/^\[HKEY_[^\]]*\\(?:PuTTY|KiTTY)\\Sessions\\([^\]]+)\]$/i)
    if (secMatch) {
      current = { name: secMatch[1], values: {} }
      sessions.push(current)
      continue
    }
    if (line.startsWith('[')) {
      current = null
      continue
    }
    if (!current) continue

    const strMatch = line.match(/^"([^"]+)"="(.*)"$/)
    if (strMatch) {
      const key = strMatch[1]
      const val = strMatch[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      current.values[key] = val
      continue
    }
    const dwordMatch = line.match(/^"([^"]+)"=dword:([0-9a-fA-F]+)$/)
    if (dwordMatch) {
      current.values[dwordMatch[1]] = String(parseInt(dwordMatch[2], 16))
    }
  }

  return buildImportFromPuttySessions(sessions, readKey)
}

/**
 * Parses `reg query HKCU\Software\SimonTatham\PuTTY\Sessions /s` output on Windows.
 */
export function parsePuttyWindowsRegistry(output: string, readKey?: (path: string) => string | null): ImportFile {
  const sessions: PuttyRawSession[] = []
  let current: PuttyRawSession | null = null

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const secMatch = line.match(/^HKEY_[^\r\n]*\\(?:PuTTY|KiTTY)\\Sessions\\(.+)$/i)
    if (secMatch) {
      current = { name: secMatch[1].trim(), values: {} }
      sessions.push(current)
      continue
    }
    if (!current) continue

    const valMatch = line.match(/^(\S+)\s+(REG_SZ|REG_DWORD)\s*(.*)$/)
    if (valMatch) {
      const [, key, kind, rawVal] = valMatch
      if (kind === 'REG_DWORD') {
        const num = rawVal.trim().startsWith('0x') ? parseInt(rawVal.trim(), 16) : Number(rawVal.trim())
        current.values[key] = String(num || 0)
      } else {
        current.values[key] = rawVal.trim()
      }
    }
  }

  return buildImportFromPuttySessions(sessions, readKey)
}

/**
 * Parses Linux/macOS `~/.putty/sessions/<name>` files (`Key=Value` format).
 */
export function parsePuttySessionFiles(files: Array<{ name: string; content: string }>, readKey?: (path: string) => string | null): ImportFile {
  const sessions: PuttyRawSession[] = files.map(({ name, content }) => {
    const values: Record<string, string> = {}
    for (const raw of content.split(/\r?\n/)) {
      const idx = raw.indexOf('=')
      if (idx <= 0) continue
      const k = raw.slice(0, idx).trim()
      const v = raw.slice(idx + 1).trim()
      values[k] = v
    }
    return { name, values }
  })
  return buildImportFromPuttySessions(sessions, readKey)
}

/**
 * Parses SuperPuTTY `Sessions.xml` files (`<SessionData ... />`).
 */
export function parseSuperPuttyXml(text: string): ImportFile {
  const hosts: NonNullable<ImportFile['hosts']> = []
  const groups = new Set<string>()
  const tagRe = /<SessionData\b([^>]*?)\/?>/gi
  let m: RegExpExecArray | null

  const getAttr = (attrs: string, name: string): string => {
    const attrRe = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')
    return attrRe.exec(attrs)?.[1]?.trim() ?? ''
  }

  let idx = 0
  while ((m = tagRe.exec(text)) !== null) {
    const attrs = m[1]
    const host = getAttr(attrs, 'Host')
    if (!host) continue
    const protoRaw = (getAttr(attrs, 'Proto') || 'SSH').toLowerCase()
    if (!['ssh', 'telnet', 'mosh'].includes(protoRaw)) continue
    const protocol = normalizeProtocol(protoRaw)
    const port = Number(getAttr(attrs, 'Port')) || (protocol === 'telnet' ? 23 : 22)
    const sessionId = getAttr(attrs, 'SessionId')
    const sessionName = getAttr(attrs, 'SessionName')
    const parts = sessionId.split(/[\\/]/).filter(Boolean)
    const label = sessionName || parts[parts.length - 1] || host
    const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'PuTTY'
    const group = cleanGroupPath(folder, 'PuTTY')
    if (group) groups.add(group)
    const username = getAttr(attrs, 'Username') || undefined

    hosts.push({
      ref: `sputty_${idx++}`,
      label,
      group,
      hostname: host,
      port,
      username,
      protocol
    })
  }

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groups],
    hosts
  }
}

/**
 * Parses MobaXterm `.mxtsessions` and `MobaXterm.ini` files.
 */
export function parseMobaXterm(text: string, home = '', readKey?: (path: string) => string | null): ImportFile {
  const hosts: NonNullable<ImportFile['hosts']> = []
  const keys: NonNullable<ImportFile['keys']> = []
  const snippets: NonNullable<ImportFile['snippets']> = []
  const groups = new Set<string>()
  const keyRefByPath = new Map<string, string | undefined>()

  const getKeyRef = (rawPath: string | undefined): string | undefined => {
    if (!rawPath || !readKey) return undefined
    const clean = rawPath.replace(/^_ProfileDir_[\\/]?/i, home ? `${home}/` : '').trim()
    if (!clean || clean === '<none>') return undefined
    if (!keyRefByPath.has(clean)) {
      const priv = readKey(clean)
      if (priv) {
        const ref = `mk_${keys.length}`
        const label = clean.split(/[\\/]/).pop() || 'mobaxterm-key'
        keys.push({ ref, label, privateKey: priv })
        keyRefByPath.set(clean, ref)
      } else {
        keyRefByPath.set(clean, undefined)
      }
    }
    return keyRefByPath.get(clean)
  }

  let inBookmarks = false
  let currentSubRep = ''
  let idx = 0
  const refByHost = new Map<string, string>()
  const pendingJumps: Array<{ hostIdx: number; gatewayHost: string; gatewayPort: number; gatewayUser?: string; group: string; label: string }> = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue

    const secMatch = line.match(/^\[([^\]]+)\]$/)
    if (secMatch) {
      const secName = secMatch[1].trim()
      inBookmarks = /^Bookmarks(_\d+)?$/i.test(secName)
      currentSubRep = ''
      continue
    }
    if (!inBookmarks) continue

    if (/^SubRep\s*=/i.test(line)) {
      const val = line.slice(line.indexOf('=') + 1).trim()
      currentSubRep = cleanGroupPath(val)
      continue
    }
    if (/^ImgNum\s*=/i.test(line)) continue

    const eqIdx = line.indexOf('=')
    if (eqIdx <= 0) continue
    const label = line.slice(0, eqIdx).trim()
    const rhs = line.slice(eqIdx + 1).trim()
    if (!rhs.startsWith('#')) continue

    // Format: #<IconNum>#<Params>#<FontAndTermParams>#<Extra>#<Comment>...
    const hashParts = rhs.slice(1).split('#')
    if (hashParts.length < 2) continue
    const params = hashParts[1].split('%')
    // Type: 0 = SSH, 1 = Telnet, 7 = SFTP, 10 = Mosh
    const sessType = params[0]?.trim()
    if (sessType !== '0' && sessType !== '1' && sessType !== '7' && sessType !== '10') continue

    const protocol: Protocol = sessType === '1' ? 'telnet' : sessType === '10' ? 'mosh' : 'ssh'
    const hostname = (params[1] ?? '').trim()
    if (!hostname) continue

    const defaultPort = protocol === 'telnet' ? 23 : 22
    const port = Number(params[2]) || defaultPort
    const username = (params[3] ?? '').trim() || undefined
    const remoteCmd = (params[5] ?? '').trim()
    const gatewayHost = (params[11] ?? '').split('__PIPE__')[0]?.trim()
    const gatewayPort = Number((params[12] ?? '').split('__PIPE__')[0]) || 22
    const gatewayUser = (params[13] ?? '').split('__PIPE__')[0]?.trim() || undefined
    const keyPath = (params[14] ?? '').trim()

    const group = currentSubRep || 'MobaXterm'
    groups.add(group)

    let snippetRef: string | undefined
    if (remoteCmd && remoteCmd !== '<none>' && remoteCmd !== '-1' && remoteCmd !== '0') {
      snippetRef = `ms_${idx}`
      snippets.push({ ref: snippetRef, label: `${label} (startup)`, script: remoteCmd })
    }

    const ref = `moba_${idx++}`
    refByHost.set(hostname.toLowerCase(), ref)

    if (gatewayHost && gatewayHost !== '<none>' && gatewayHost !== '-1' && gatewayHost !== '0' && /[a-zA-Z.]/.test(gatewayHost)) {
      pendingJumps.push({ hostIdx: hosts.length, gatewayHost, gatewayPort, gatewayUser, group, label })
    }

    hosts.push({
      ref,
      label: label || hostname,
      group,
      hostname,
      port,
      username,
      keyRef: getKeyRef(keyPath),
      snippetRef,
      protocol
    })
  }

  for (const j of pendingJumps) {
    let jumpRef = refByHost.get(j.gatewayHost.toLowerCase())
    if (!jumpRef) {
      jumpRef = `moba_jump_${idx++}`
      hosts.push({
        ref: jumpRef,
        label: `${j.label} (jump)`,
        group: j.group,
        hostname: j.gatewayHost,
        port: j.gatewayPort,
        username: j.gatewayUser,
        protocol: 'ssh'
      })
      refByHost.set(j.gatewayHost.toLowerCase(), jumpRef)
    }
    if (jumpRef !== hosts[j.hostIdx].ref) {
      hosts[j.hostIdx].jumpHostRef = jumpRef
    }
  }

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groups],
    keys,
    snippets,
    hosts
  }
}

/**
 * Parses an external file from Termius, PuTTY, MobaXterm or SSH Config, with automatic format detection.
 */
export function parseExternalImport(
  content: Buffer | string,
  filename: string,
  source: ImportClientSource | 'auto',
  home: string,
  readKey?: (path: string) => string | null
): ImportFile {
  const text = typeof content === 'string' ? content : decodeBuffer(content)
  const trimmed = text.trim()
  const lowerName = filename.toLowerCase()

  // 0. LevelDB file / directory from Termius
  if (
    lowerName.endsWith('.ldb') ||
    lowerName.endsWith('.log') ||
    lowerName.endsWith('current') ||
    lowerName.endsWith('manifest-000001') ||
    lowerName.includes('.leveldb')
  ) {
    try {
      const dir = existsSync(filename) && statSync(filename).isDirectory() ? filename : dirname(filename)
      const res = parseTermiusLocalDatabase(dir, getTermiusLocalKey())
      if (res.hosts && res.hosts.length > 0) return res
    } catch {}
  }

  // 1. JSON files (OpenTerm Hub import, Termius JSON)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (isImportFile(parsed)) return parsed
    return parseTermiusJson(parsed)
  }

  // 2. SuperPuTTY XML
  if (trimmed.startsWith('<') && /<SessionData\b/i.test(trimmed)) {
    return parseSuperPuttyXml(trimmed)
  }

  // 3. Windows Registry .reg (PuTTY / KiTTY)
  if (
    source === 'putty' ||
    lowerName.endsWith('.reg') ||
    /^Windows Registry Editor/i.test(trimmed) ||
    /^REGEDIT4/i.test(trimmed) ||
    /\\(?:PuTTY|KiTTY)\\Sessions\\/i.test(trimmed)
  ) {
    if (/<SessionData\b/i.test(trimmed)) return parseSuperPuttyXml(trimmed)
    if (/\\(?:PuTTY|KiTTY)\\Sessions\\/i.test(trimmed)) return parsePuttyReg(trimmed, readKey)
    if (/^HostName=/m.test(trimmed)) {
      const name = filename.split(/[\\/]/).pop() || 'putty-host'
      return parsePuttySessionFiles([{ name, content: trimmed }], readKey)
    }
  }

  // 4. MobaXterm (.mxtsessions / MobaXterm.ini)
  if (
    source === 'mobaxterm' ||
    lowerName.endsWith('.mxtsessions') ||
    /\[Bookmarks(_\d+)?\]/i.test(trimmed) ||
    /^SubRep\s*=/m.test(trimmed)
  ) {
    return parseMobaXterm(trimmed, home, readKey)
  }

  // 5. SSH Config (Termius SSH Config export or standard ~/.ssh/config)
  if (
    source === 'sshconfig' ||
    /^\s*Host\s+\S+/im.test(trimmed) && /^\s*(HostName|User|Port|IdentityFile|ProxyJump)\s+/im.test(trimmed)
  ) {
    const isTermius = source === 'termius' || /termius/i.test(lowerName)
    return parseSshConfigToImport(trimmed, home, {
      singleHostPerBlock: isTermius,
      defaultGroup: isTermius ? 'Termius' : 'ssh config',
      readKey
    })
  }

  // 6. Termius CSV (or general CSV)
  if (source === 'termius' || lowerName.endsWith('.csv') || trimmed.includes(',')) {
    return parseTermiusCsv(trimmed)
  }

  throw new Error('Formato de arquivo não reconhecido')
}

// ---- Termius local auto-discovery (IndexedDB LevelDB reader) ----------------

function snappyDecompress(buf: Buffer): Buffer {
  let pos = 0
  let ulen = 0
  let shift = 0
  while (pos < buf.length) {
    const b = buf[pos++]
    ulen |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  const out = Buffer.alloc(ulen)
  let outPos = 0
  while (pos < buf.length && outPos < ulen) {
    const tag = buf[pos++]
    const etype = tag & 0x03
    if (etype === 0) {
      let len = (tag >> 2) + 1
      if (len > 60) {
        const extra = len - 60
        len = buf.readUIntLE(pos, extra) + 1
        pos += extra
      }
      buf.copy(out, outPos, pos, pos + len)
      pos += len
      outPos += len
    } else {
      let len = 0
      let offset = 0
      if (etype === 1) {
        len = ((tag >> 2) & 7) + 4
        offset = ((tag & 0xe0) << 3) | buf[pos++]
      } else if (etype === 2) {
        len = (tag >> 2) + 1
        offset = buf.readUInt16LE(pos)
        pos += 2
      } else {
        len = (tag >> 2) + 1
        offset = buf.readUInt32LE(pos)
        pos += 4
      }
      if (offset === 0) break
      for (let i = 0; i < len; i++) {
        out[outPos] = out[outPos - offset]
        outPos++
      }
    }
  }
  return out
}

function rvar(buf: Buffer, p: number): [number, number] {
  let v = 0
  let s = 0
  while (p < buf.length) {
    const b = buf[p++]
    v |= (b & 0x7f) << s
    if (!(b & 0x80)) break
    s += 7
  }
  return [v, p]
}

interface LevelDbEntry {
  key: Buffer
  val: Buffer
  seq: number
  ktype: number
}

function parseLevelDbBlock(blk: Buffer): LevelDbEntry[] {
  const numRestarts = blk.readUInt32LE(blk.length - 4)
  const limit = blk.length - 4 * (numRestarts + 1)
  let p = 0
  let lastKey = Buffer.alloc(0)
  const items: LevelDbEntry[] = []
  while (p < limit) {
    let shared: number, unshared: number, vlen: number
    ;[shared, p] = rvar(blk, p)
    ;[unshared, p] = rvar(blk, p)
    ;[vlen, p] = rvar(blk, p)
    const key = Buffer.concat([lastKey.subarray(0, shared), blk.subarray(p, p + unshared)])
    p += unshared
    const val = blk.subarray(p, p + vlen)
    p += vlen
    lastKey = key
    const seq = Number(key.readBigUInt64LE(key.length - 8) >> 8n)
    const ktype = key[key.length - 8]
    items.push({ key: key.subarray(0, key.length - 8), val, seq, ktype })
  }
  return items
}

function readLdbEntries(filePath: string): LevelDbEntry[] {
  const data = readFileSync(filePath)
  if (data.length < 48) return []
  const footer = data.subarray(data.length - 48)
  let p = 0
  let idxOff: number, idxSz: number
  ;[, p] = rvar(footer, p)
  ;[, p] = rvar(footer, p)
  ;[idxOff, p] = rvar(footer, p)
  ;[idxSz, p] = rvar(footer, p)

  const idxBlk = ((): Buffer => {
    const btype = data[idxOff + idxSz]
    const raw = data.subarray(idxOff, idxOff + idxSz)
    return btype === 1 ? snappyDecompress(raw) : raw
  })()

  const out: LevelDbEntry[] = []
  for (const { val: hval } of parseLevelDbBlock(idxBlk)) {
    const [boff, p0] = rvar(hval, 0)
    const [bsz] = rvar(hval, p0)
    const btype = data[boff + bsz]
    const raw = data.subarray(boff, boff + bsz)
    const dblk = btype === 1 ? snappyDecompress(raw) : raw
    out.push(...parseLevelDbBlock(dblk))
  }
  return out
}

function readLogEntries(filePath: string): LevelDbEntry[] {
  const data = readFileSync(filePath)
  let pos = 0
  let buf = Buffer.alloc(0)
  const recs: Buffer[] = []
  while (pos < data.length) {
    const blockRem = 32768 - (pos % 32768)
    if (blockRem < 7) {
      pos += blockRem
      continue
    }
    if (pos + 7 > data.length) break
    const length = data.readUInt16LE(pos + 4)
    const rtype = data[pos + 6]
    pos += 7
    const frag = data.subarray(pos, pos + length)
    pos += length
    if (rtype === 1) recs.push(frag)
    else if (rtype === 2) buf = Buffer.from(frag)
    else if (rtype === 3) buf = Buffer.concat([buf, frag])
    else if (rtype === 4) {
      buf = Buffer.concat([buf, frag])
      recs.push(buf)
      buf = Buffer.alloc(0)
    }
  }

  const out: LevelDbEntry[] = []
  for (const r of recs) {
    if (r.length < 12) continue
    const seq = Number(r.readBigUInt64LE(0))
    const cnt = r.readUInt32LE(8)
    let p = 12
    for (let i = 0; i < cnt && p < r.length; i++) {
      const ktype = r[p++]
      let klen: number
      ;[klen, p] = rvar(r, p)
      const k = r.subarray(p, p + klen)
      p += klen
      if (ktype === 1) {
        let vlen: number
        ;[vlen, p] = rvar(r, p)
        const v = r.subarray(p, p + vlen)
        p += vlen
        out.push({ key: k, val: v, seq, ktype })
      } else {
        out.push({ key: k, val: Buffer.alloc(0), seq, ktype })
      }
    }
  }
  return out
}

export function findTermiusIndexedDbPath(home: string): string | null {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    candidates.push(
      join(appData, 'Termius', 'IndexedDB', 'file__0.indexeddb.leveldb'),
      join(localAppData, 'Termius', 'IndexedDB', 'file__0.indexeddb.leveldb')
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      join(home, 'Library', 'Application Support', 'Termius', 'IndexedDB', 'file__0.indexeddb.leveldb')
    )
  } else {
    // Linux: standard, snap, flatpak
    candidates.push(
      join(home, '.config', 'Termius', 'IndexedDB', 'file__0.indexeddb.leveldb'),
      join(home, 'snap', 'termius-app', 'current', '.config', 'Termius', 'IndexedDB', 'file__0.indexeddb.leveldb'),
      join(home, '.var', 'app', 'com.termius.Termius', 'config', 'Termius', 'IndexedDB', 'file__0.indexeddb.leveldb')
    )
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function getTermiusLocalKey(): Buffer | null {
  try {
    if (process.platform === 'linux') {
      const candidates = [
        'secret-tool lookup service termius-app account localKey',
        'secret-tool lookup service Termius account localKey',
        'secret-tool lookup service termius account localKey'
      ]
      for (const cmd of candidates) {
        try {
          const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
          if (out) return Buffer.from(out, 'base64')
        } catch {}
      }
      // Python DBus fallback (Secret Service API directly)
      const py =
        "import dbus\n" +
        "bus = dbus.SessionBus()\n" +
        "service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')\n" +
        "iface = dbus.Interface(service, 'org.freedesktop.Secret.Service')\n" +
        "for svc in ['termius-app', 'Termius', 'termius']:\n" +
        "    unlocked, _ = iface.SearchItems({'service': svc, 'account': 'localKey'})\n" +
        "    if not unlocked:\n" +
        "        unlocked, _ = iface.SearchItems({'service': svc})\n" +
        "    if unlocked:\n" +
        "        _, session_path = iface.OpenSession('plain', '')\n" +
        "        item = bus.get_object('org.freedesktop.secrets', unlocked[0])\n" +
        "        item_iface = dbus.Interface(item, 'org.freedesktop.Secret.Item')\n" +
        "        secret = item_iface.GetSecret(session_path)\n" +
        "        print(bytes(secret[2]).decode('utf-8'))\n" +
        "        break\n"
      try {
        const out = execSync(`python3 -c "${py.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
        if (out) return Buffer.from(out, 'base64')
      } catch {}
    } else if (process.platform === 'darwin') {
      const cmds = [
        'security find-generic-password -s termius-app -a localKey -w',
        'security find-generic-password -s Termius -a localKey -w',
        'security find-generic-password -s termius -a localKey -w'
      ]
      for (const cmd of cmds) {
        try {
          const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
          if (out) return Buffer.from(out, 'base64')
        } catch {}
      }
    } else if (process.platform === 'win32') {
      const ps = `powershell.exe -NoProfile -NonInteractive -Command "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault; foreach ($svc in @('termius-app','Termius','termius')) { try { $p = ($v.Retrieve($svc, 'localKey')).Password; if ($p) { Write-Output $p; break } } catch {} }"`
      const out = execSync(ps, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
      if (out) return Buffer.from(out, 'base64')
    }
  } catch {
    // Keyring access failed or not configured
  }
  return null
}

export function parseTermiusLocalDatabase(dbDir: string, encryptionKey: Buffer | null): ImportFile {
  const files = readdirSync(dbDir).sort()
  const map = new Map<string, LevelDbEntry>()

  for (const f of files) {
    const full = join(dbDir, f)
    let entries: LevelDbEntry[] = []
    try {
      if (f.endsWith('.ldb')) entries = readLdbEntries(full)
      else if (f.endsWith('.log')) entries = readLogEntries(full)
    } catch {}
    for (const e of entries) {
      const kHex = e.key.toString('hex')
      const existing = map.get(kHex)
      if (!existing || e.seq > existing.seq) map.set(kHex, e)
    }
  }

  const live = Array.from(map.values()).filter((e) => e.ktype === 1)

  const decryptVal = (val: unknown): unknown => {
    if (typeof val !== 'string' || !encryptionKey) return val
    try {
      const ct = Buffer.from(val, 'base64')
      if (ct.length >= 42 && ct[0] === 4) {
        const nonce = ct.subarray(2, 26)
        const box = ct.subarray(26)
        const opened = nacl.secretbox.open(new Uint8Array(box), new Uint8Array(nonce), new Uint8Array(encryptionKey))
        if (opened) return Buffer.from(opened).toString('utf8')
      }
    } catch {}
    return val
  }

  const deepDecrypt = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) return obj
    if (Array.isArray(obj)) return obj.map(deepDecrypt)
    if (typeof obj === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = deepDecrypt(v)
      }
      return out
    }
    if (typeof obj === 'string') return decryptVal(obj)
    return obj
  }

  const tryDeserialize = (val: Buffer): Record<string, unknown> | null => {
    for (let i = 0; i < val.length - 1; i++) {
      if (val[i] === 0xff && val[i + 1] >= 0x01 && val[i + 1] <= 0x30) {
        const sub = Buffer.from(val.subarray(i))
        const orig = sub[1]
        // Try version 15 (0x0f) which standard Node v8.deserialize accepts
        sub[1] = 0x0f
        try {
          const res = deepDecrypt(v8.deserialize(sub))
          if (res && typeof res === 'object' && !Array.isArray(res)) return res as Record<string, unknown>
        } catch {}
        // Try original version byte
        sub[1] = orig
        try {
          const res = deepDecrypt(v8.deserialize(sub))
          if (res && typeof res === 'object' && !Array.isArray(res)) return res as Record<string, unknown>
        } catch {}
      }
    }
    // Fallback: UTF-8 JSON
    if (val.length > 2) {
      try {
        const s = val.toString('utf8')
        const start = s.indexOf('{')
        if (start !== -1) {
          const res = deepDecrypt(JSON.parse(s.substring(start)))
          if (res && typeof res === 'object' && !Array.isArray(res)) return res as Record<string, unknown>
        }
      } catch {}
    }
    return null
  }

  const parseStore = (sid: number): Array<Record<string, unknown>> => {
    const recs = live.filter((e) => e.key.length > 4 && e.key[0] === 0 && e.key[1] === sid && e.key[2] === 1 && e.key[3] === 1)
    return recs
      .map((e) => tryDeserialize(e.val))
      .filter((x): x is Record<string, unknown> => x !== null)
  }

  let rawHosts = parseStore(0x0f)
  let rawGroups = parseStore(0x0e)
  let rawSshConfigs = parseStore(0x03)
  let rawIdentities = parseStore(0x0b)
  let rawKeys = parseStore(0x0a)

  // Universal scan fallback if specific store ID didn't find hosts
  if (rawHosts.length === 0) {
    const hostList: Array<Record<string, unknown>> = []
    const groupList: Array<Record<string, unknown>> = []
    const scList: Array<Record<string, unknown>> = []
    const identList: Array<Record<string, unknown>> = []
    const keyList: Array<Record<string, unknown>> = []

    for (const e of live) {
      const rec = tryDeserialize(e.val)
      if (!rec) continue

      if (
        (rec.address !== undefined || rec.hostname !== undefined || (rec.label !== undefined && (rec.ssh_config !== undefined || rec.credentials_mode !== undefined || rec.telnet_config !== undefined))) &&
        rec.parent_group === undefined &&
        rec.connected_at === undefined &&
        rec.session_log_data === undefined &&
        rec.workspaceTerminals === undefined
      ) {
        hostList.push(rec)
      } else if (rec.parent_group !== undefined && rec.address === undefined) {
        groupList.push(rec)
      } else if (rec.port !== undefined && (rec.agent_forwarding !== undefined || rec.env_variables !== undefined || rec.use_ssh_key !== undefined || rec.strict_host_key_check !== undefined)) {
        scList.push(rec)
      } else if (rec.username !== undefined && (rec.password !== undefined || rec.ssh_key !== undefined || rec.sshid_mode !== undefined)) {
        identList.push(rec)
      } else if (rec.private_key !== undefined || rec.public_key !== undefined) {
        keyList.push(rec)
      }
    }

    if (hostList.length > 0) {
      // Deduplicate hosts by id/local_id if present
      const seenIds = new Set<string>()
      for (const h of hostList) {
        const id = String(h.id ?? h.local_id ?? '')
        if (id) {
          if (seenIds.has(id)) continue
          seenIds.add(id)
        }
        rawHosts.push(h)
      }
      if (rawGroups.length === 0) rawGroups = groupList
      if (rawSshConfigs.length === 0) rawSshConfigs = scList
      if (rawIdentities.length === 0) rawIdentities = identList
      if (rawKeys.length === 0) rawKeys = keyList
    }
  }

  const groupsById = new Map<string, Record<string, unknown>>()
  for (const g of rawGroups) {
    const gid = String(g.id ?? g.local_id ?? '')
    if (gid) groupsById.set(gid, g)
  }

  const resolveGroup = (g: Record<string, unknown> | null | undefined): string => {
    if (!g) return ''
    const names: string[] = []
    let cur: Record<string, unknown> | null | undefined = g
    const seen = new Set<string>()
    while (cur) {
      const gid = String(cur.id ?? cur.local_id ?? '')
      if (seen.has(gid)) break
      seen.add(gid)
      if (cur.label) names.push(String(cur.label))
      const parent = cur.parent_group as Record<string, unknown> | undefined
      cur = parent ? groupsById.get(String(parent.id ?? parent.local_id)) : null
    }
    return names.reverse().join(' / ')
  }

  const sshConfigsById = new Map<string, Record<string, unknown>>()
  for (const sc of rawSshConfigs) {
    const id = String(sc.id ?? sc.local_id ?? '')
    if (id) sshConfigsById.set(id, sc)
  }

  const identitiesById = new Map<string, Record<string, unknown>>()
  for (const ident of rawIdentities) {
    const id = String(ident.id ?? ident.local_id ?? '')
    if (id) identitiesById.set(id, ident)
  }

  const keys: NonNullable<ImportFile['keys']> = []
  const keyRefMap = new Map<string, string>()
  for (const k of rawKeys) {
    const priv = String(k.private_key ?? '').trim()
    if (!priv) continue
    const ref = `tk_${k.id ?? k.local_id}`
    keyRefMap.set(String(k.id ?? k.local_id), ref)
    keys.push({
      ref,
      label: String(k.label ?? `termius-key-${k.id ?? k.local_id}`).trim(),
      privateKey: priv,
      passphrase: k.passphrase ? String(k.passphrase) : undefined
    })
  }

  const identities: NonNullable<ImportFile['identities']> = []
  const identityRefMap = new Map<string, string>()
  for (const ident of rawIdentities) {
    const ref = `ti_${ident.id ?? ident.local_id}`
    identityRefMap.set(String(ident.id ?? ident.local_id), ref)
    let kRef: string | undefined
    if (ident.ssh_key) {
      const kid = String((ident.ssh_key as Record<string, unknown>).id ?? (ident.ssh_key as Record<string, unknown>).local_id)
      kRef = keyRefMap.get(kid)
    }
    identities.push({
      ref,
      label: String(ident.label ?? ident.username ?? 'Identidade').trim(),
      username: String(ident.username ?? '').trim(),
      password: ident.password ? String(ident.password) : undefined,
      keyRef: kRef
    })
  }

  const hosts: NonNullable<ImportFile['hosts']> = []
  const groupsSet = new Set<string>()

  for (let i = 0; i < rawHosts.length; i++) {
    const h = rawHosts[i]
    const hostname = String(h.address ?? h.hostname ?? '').trim()
    if (!hostname) continue

    let grp = ''
    if (h.group) {
      const gid = String((h.group as Record<string, unknown>).id ?? (h.group as Record<string, unknown>).local_id)
      grp = resolveGroup(groupsById.get(gid) ?? (h.group as Record<string, unknown>))
    }
    if (!grp) grp = 'Termius'
    const normalizedGrp = cleanGroupPath(grp, 'Termius')
    if (normalizedGrp) groupsSet.add(normalizedGrp)

    let sc: Record<string, unknown> | null = null
    if (h.ssh_config) {
      const scid = String((h.ssh_config as Record<string, unknown>).id ?? (h.ssh_config as Record<string, unknown>).local_id)
      sc = sshConfigsById.get(scid) ?? (h.ssh_config as Record<string, unknown>)
    }

    let username: string | undefined
    let password: string | undefined
    let keyRef: string | undefined
    let identityRef: string | undefined

    if (sc && sc.identity) {
      const iid = String((sc.identity as Record<string, unknown>).id ?? (sc.identity as Record<string, unknown>).local_id)
      const ident = identitiesById.get(iid)
      if (ident) {
        identityRef = identityRefMap.get(iid)
        username = ident.username ? String(ident.username).trim() : undefined
        password = ident.password ? String(ident.password) : undefined
        if (ident.ssh_key) {
          const kid = String((ident.ssh_key as Record<string, unknown>).id ?? (ident.ssh_key as Record<string, unknown>).local_id)
          keyRef = keyRefMap.get(kid)
        }
      }
    }

    const port = Number(sc?.port) || 22
    const label = String(h.label ?? '').trim() || hostname

    hosts.push({
      ref: `th_${h.id ?? h.local_id ?? i}`,
      label,
      group: normalizedGrp,
      hostname,
      port,
      username,
      password,
      keyRef,
      identityRef,
      protocol: 'ssh',
      os: (h.os_name as OsId) || null,
      agentForward: !!sc?.agent_forwarding
    })
  }

  return {
    format: 'openterm-hub-import',
    version: 1,
    groups: [...groupsSet],
    keys,
    identities,
    hosts
  }
}
