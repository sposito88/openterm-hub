import { createHash } from 'node:crypto'
import type { Host, ImportSummary, Protocol } from '@shared/types'
import { describeKey, importKey } from './keys'
import type { Store } from './store'

/**
 * Import format for migrating from other SSH clients, with secrets included.
 * Documented in docs/IMPORT.md. Unlike the backup format, the file holds
 * passwords and private keys in plain text, so it should be deleted after use.
 */
export interface ImportFile {
  format: 'openterm-hub-import'
  version: 1
  keys?: Array<{ ref: string; label: string; privateKey: string; passphrase?: string }>
  hosts?: Array<{
    ref?: string
    label: string
    group?: string
    hostname: string
    port?: number
    username?: string
    password?: string
    keyRef?: string
    protocol?: Protocol
    agentForward?: boolean
    jumpHostRef?: string
    snippetRef?: string
    tags?: string[]
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
  const sum: ImportSummary = { hosts: 0, keys: 0, snippets: 0, knownHosts: 0, skipped: 0, errors: [] }

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

  // Hosts: skip only exact copies. Entries for the same server that differ in
  // label, group or password are kept, since either could be the one in use.
  const hostIds = new Map<string, string>()
  const pendingJumps: Array<[string, string]> = []
  for (const h of file.hosts ?? []) {
    const port = Number(h.port) || 22
    const username = h.username ?? ''
    if (!h.hostname?.trim()) {
      sum.errors.push(`Host "${h.label}": sem endereço`)
      continue
    }
    const label = h.label || h.hostname
    const existing = store
      .hosts()
      .find(
        (x) =>
          x.hostname === h.hostname.trim() &&
          x.port === port &&
          x.username === username &&
          x.label === label &&
          x.group === (h.group ?? '') &&
          (store.getSecret(`host:${x.id}:password`) ?? '') === (h.password ?? '')
      )
    if (existing) {
      if (h.ref) hostIds.set(h.ref, existing.id)
      sum.skipped++
      continue
    }
    const host: Omit<Host, 'id'> = {
      label,
      group: h.group ?? '',
      hostname: h.hostname.trim(),
      port,
      username,
      protocol: h.protocol ?? 'ssh',
      hasPassword: !!h.password,
      keyId: (h.keyRef && keyIds.get(h.keyRef)) || null,
      useAgent: !h.password && !h.keyRef,
      agentForward: !!h.agentForward,
      jumpHostId: null,
      startupSnippetId: (h.snippetRef && snippetIds.get(h.snippetRef)) || null,
      tags: h.tags ?? []
    }
    const saved = store.saveHost(host)
    if (h.password) store.setSecret(`host:${saved.id}:password`, h.password)
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
