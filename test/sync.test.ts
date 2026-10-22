import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Host, Snippet } from '../src/shared/types'
import { canonical, decryptVault, encryptVault, mergeVaults, Sync, VAULT_FILE, WrongPassphrase, type SyncStore, type VaultData } from '../src/main/sync'

const empty = (): VaultData => ({
  hosts: [], identities: [], keys: [], snippets: [], forwards: [], workspaces: [], groups: [], knownHosts: [], deleted: {}, secrets: {}
})

const host = (id: string, label: string, updatedAt: number): Host => ({
  id, label, group: '', hostname: `${id}.example`, port: 22, username: 'ana', protocol: 'ssh', hasPassword: true,
  keyId: null, identityId: null, useAgent: false, agentForward: false, jumpHostId: null, startupSnippetId: null, tags: [], updatedAt
})

test('merge: newest item wins and brings its own secrets', () => {
  const a = { ...empty(), hosts: [host('h1', 'old', 100), host('h2', 'only here', 100)], secrets: { 'host:h1:password': 'old-pw', 'host:h2:password': 'pw2' } }
  const b = { ...empty(), hosts: [host('h1', 'new', 200)], secrets: { 'host:h1:password': 'new-pw', 'host:h1:step:s1': 'enable-pw' } }
  const m = mergeVaults(a, b)
  assert.deepEqual(m.hosts.map((h) => h.label).sort(), ['new', 'only here'])
  assert.deepEqual(m.secrets, { 'host:h1:password': 'new-pw', 'host:h1:step:s1': 'enable-pw', 'host:h2:password': 'pw2' })
  // Merging is symmetric in content.
  assert.equal(canonical(mergeVaults(b, a)), canonical(m))
})

test('merge: deletions win over older copies, later edits survive them', () => {
  const now = Date.now()
  const a = { ...empty(), hosts: [host('h1', 'x', now - 1000), host('h2', 'edited after', now)], secrets: { 'host:h1:password': 'pw' } }
  const b = { ...empty(), deleted: { h1: now - 500, h2: now - 500, ancient: now - 400 * 86_400_000 } }
  const m = mergeVaults(a, b, now)
  assert.deepEqual(m.hosts.map((h) => h.id), ['h2'])
  assert.deepEqual(m.secrets, {}, "a deleted host's password goes too")
  assert.deepEqual(Object.keys(m.deleted).sort(), ['h1', 'h2'], 'old tombstones are pruned')
})

test('merge: groups and known hosts are combined', () => {
  const k = (host: string, fp: string, addedAt: string) => ({ host, port: 22, keyType: 'ssh-ed25519', fingerprint: fp, addedAt })
  const m = mergeVaults(
    { ...empty(), groups: ['Prod'], knownHosts: [k('a', 'SHA256:old', '2026-01-01')] },
    { ...empty(), groups: ['Dev', 'Prod'], knownHosts: [k('a', 'SHA256:new', '2026-02-01'), k('b', 'SHA256:b', '2026-01-01')] }
  )
  assert.deepEqual(m.groups, ['Dev', 'Prod'])
  assert.deepEqual(m.knownHosts.map((x) => `${x.host}=${x.fingerprint}`).sort(), ['a=SHA256:new', 'b=SHA256:b'])
})

test('vault encryption: round trip, wrong passphrase, tampering', async () => {
  const v = { ...empty(), hosts: [host('h1', 'web', 1)], secrets: { 'host:h1:password': 'hunter2' } }
  const text = await encryptVault(v, 'correct horse')
  assert.ok(!text.includes('hunter2') && !text.includes('web'), 'nothing readable in the file')
  const back = await decryptVault(text, 'correct horse')
  assert.equal(canonical(back.data), canonical(v))
  await assert.rejects(decryptVault(text, 'wrong passphrase'), WrongPassphrase)
  const f = JSON.parse(text)
  f.data = Buffer.from(Buffer.from(f.data, 'base64').map((b: number, i: number) => (i === 3 ? b ^ 1 : b))).toString('base64')
  await assert.rejects(decryptVault(JSON.stringify(f), 'correct horse'), WrongPassphrase)
  f.kdf.N = 2 ** 30
  await assert.rejects(decryptVault(JSON.stringify(f), 'correct horse'), /parâmetros/)
})

const dirs: string[] = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function device(folder: string, pass = 'shared passphrase') {
  let data = empty()
  const listeners: Array<() => void> = []
  const store: SyncStore & { data(): VaultData; edit(fn: (v: VaultData) => void): void } = {
    syncPayload: () => structuredClone(data),
    applySync: (v) => {
      data = structuredClone(v)
      listeners.forEach((l) => l())
    },
    settings: () => ({ syncEnabled: true, syncFolder: folder }),
    getSecret: (n) => (n === 'sync:passphrase' ? pass : undefined),
    onChange: (cb) => listeners.push(cb),
    data: () => data,
    edit: (fn) => fn(data)
  }
  const statuses: Array<{ error?: string }> = []
  const sync = new Sync(store, (s) => statuses.push(s))
  return { store, sync, statuses }
}

test('two devices converge through the folder, conflict copies included', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'oth-sync-'))
  dirs.push(folder)
  const a = device(folder)
  const b = device(folder)
  const snippet: Snippet = { id: 's1', label: 'up', script: 'uptime', updatedAt: Date.now() }
  a.store.edit((v) => {
    v.hosts.push(host('h1', 'web', Date.now()))
    v.secrets['host:h1:password'] = 'pw'
  })
  await a.sync.syncNow()
  assert.deepEqual(readdirSync(folder), [VAULT_FILE], 'no temp file left behind')
  b.store.edit((v) => v.snippets.push(snippet))
  await b.sync.syncNow()
  assert.deepEqual(b.store.data().hosts.map((h) => h.id), ['h1'])
  assert.equal(b.store.data().secrets['host:h1:password'], 'pw')
  await a.sync.syncNow()
  assert.deepEqual(a.store.data().snippets.map((s) => s.id), ['s1'])

  // A sync tool's conflict copy (both devices wrote at once) is merged, not lost.
  const c = device(folder)
  c.store.edit((v) => v.hosts.push(host('h9', 'from the conflict copy', Date.now())))
  writeFileSync(join(folder, 'openterm-hub-vault.sync-conflict-20261022-120000-ABC.json'), await encryptVault(c.store.data(), 'shared passphrase'))
  await a.sync.syncNow()
  assert.ok(a.store.data().hosts.some((h) => h.id === 'h9'))

  // A wrong passphrase is reported and changes nothing.
  const intruder = device(folder, 'not the passphrase')
  await intruder.sync.syncNow()
  assert.match(intruder.statuses.at(-1)?.error ?? '', /incorreta/)
  assert.equal(intruder.store.data().hosts.length, 0)
  const before = readFileSync(join(folder, VAULT_FILE), 'utf8')
  await a.sync.syncNow()
  assert.equal(readFileSync(join(folder, VAULT_FILE), 'utf8'), before, 'nothing changed: the vault is not rewritten')
  for (const d of [a, b, c, intruder]) d.sync.stop()
})
