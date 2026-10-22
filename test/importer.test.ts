import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { utils } from 'ssh2'
import type { Host, Identity, KnownHost, Snippet, SshKey } from '../src/shared/types'
import { importFile, type ImportFile } from '../src/main/importer'

function fakeStore() {
  const hosts: Host[] = []
  const identities: Identity[] = []
  const keys: SshKey[] = []
  const snippets: Snippet[] = []
  const known: KnownHost[] = []
  const secrets = new Map<string, string>()
  const upsert = <T extends { id: string }>(list: T[], item: Omit<T, 'id'> & { id?: string }): T => {
    const full = { ...item, id: item.id ?? randomUUID() } as T
    const i = list.findIndex((x) => x.id === full.id)
    if (i >= 0) list[i] = full
    else list.push(full)
    return full
  }
  return {
    hosts: () => hosts,
    host: (id: string) => hosts.find((h) => h.id === id),
    saveHost: (h: Omit<Host, 'id'> & { id?: string }) => upsert(hosts, h),
    identities: () => identities,
    identity: (id: string) => identities.find((i) => i.id === id),
    saveIdentity: (i: Omit<Identity, 'id'>) => upsert(identities, i),
    credentials(h: Host) {
      const i = h.identityId ? identities.find((x) => x.id === h.identityId) : undefined
      return i
        ? { username: i.username, password: secrets.get(`identity:${i.id}:password`), keyId: i.keyId }
        : { username: h.username, password: secrets.get(`host:${h.id}:password`), keyId: h.keyId }
    },
    keys: () => keys,
    saveKey: (k: Omit<SshKey, 'id'>) => upsert(keys, k),
    snippets: () => snippets,
    saveSnippet: (s: Omit<Snippet, 'id'>) => upsert(snippets, s),
    knownHost: (h: string, p: number) => known.find((k) => k.host === h && k.port === p),
    trustHost: (k: KnownHost) => known.push(k),
    setSecret: (n: string, v?: string) => (v ? secrets.set(n, v) : secrets.delete(n)),
    getSecret: (n: string) => secrets.get(n),
    secrets
  }
}

test('migration import with secrets, refs and de-duplication', () => {
  const store = fakeStore()
  const pair = utils.generateKeyPairSync('ed25519')
  const file: ImportFile = {
    format: 'openterm-hub-import',
    version: 1,
    keys: [{ ref: 'k1', label: 'deploy', privateKey: pair.private }, { ref: 'k2', label: 'broken', privateKey: 'not a key' }],
    snippets: [{ ref: 's1', label: 'up', script: 'uptime' }],
    hosts: [
      { ref: 'bastion', label: 'Bastion', group: 'Prod', hostname: '10.0.0.1', username: 'ops', password: 'pw1' },
      { ref: 'app', label: 'App', group: 'Prod / Web', hostname: '10.0.0.2', port: 2222, username: 'ops', keyRef: 'k1', jumpHostRef: 'bastion', snippetRef: 's1' },
      { label: 'no address', hostname: '' }
    ],
    knownHosts: [{ host: '10.0.0.1', publicKey: pair.public.split(' ').slice(0, 2).join(' ') }]
  }
  const sum = importFile(store as never, file)
  assert.deepEqual({ ...sum, errors: sum.errors.length }, { hosts: 2, identities: 0, linked: 0, keys: 1, snippets: 1, knownHosts: 1, skipped: 0, errors: 2 })
  assert.ok(sum.errors.every((e) => !e.includes('not a key')), 'errors never echo secret content')
  const [bastion, app] = store.hosts()
  assert.equal(store.secrets.get(`host:${bastion.id}:password`), 'pw1')
  assert.equal(app.jumpHostId, bastion.id)
  assert.equal(app.keyId, store.keys()[0].id)
  assert.equal(app.port, 2222)
  assert.equal(app.startupSnippetId, store.snippets()[0].id)
  assert.match(store.knownHost('10.0.0.1', 22)!.fingerprint, /^SHA256:/)

  // Importing the same file again adds nothing.
  const again = importFile(store as never, file)
  assert.equal(again.hosts + again.keys + again.snippets + again.knownHosts, 0)
  assert.equal(store.hosts().length, 2)
})

test('identities are shared, de-duplicated and link hosts imported before', () => {
  const store = fakeStore()
  // An earlier import without identities: the password lives on the host.
  importFile(store as never, {
    format: 'openterm-hub-import',
    version: 1,
    hosts: [{ label: 'web', group: 'Prod', hostname: '10.0.0.5', username: 'deploy', password: 's3cret' }]
  })
  const sum = importFile(store as never, {
    format: 'openterm-hub-import',
    version: 1,
    identities: [
      { ref: 'i1', label: 'deploy (prod)', username: 'deploy', password: 's3cret' },
      { ref: 'i2', label: 'same login again', username: 'deploy', password: 's3cret' }
    ],
    hosts: [
      { label: 'web', group: 'Prod', hostname: '10.0.0.5', identityRef: 'i1' },
      { label: 'api', group: 'Prod', hostname: '10.0.0.6', identityRef: 'i2' }
    ]
  })
  assert.equal(sum.identities, 1, 'two refs with the same login become one identity')
  assert.equal(sum.linked, 1, 'the existing host is linked, not duplicated')
  assert.equal(sum.hosts, 1)
  const [web, api] = store.hosts()
  assert.equal(web.identityId, store.identities()[0].id)
  assert.equal(store.secrets.has(`host:${web.id}:password`), false, "the host's own password copy is dropped")
  assert.equal(api.identityId, web.identityId)
  assert.deepEqual(store.credentials(api), { username: 'deploy', password: 's3cret', keyId: null })
})

test('generated ed25519 keys stay valid when the public key starts with 0x00', () => {
  // ssh2 used to strip every leading zero of the DER bit string, corrupting 1 in 256 keys.
  let leadingZero = 0
  for (let i = 0; i < 4000; i++) {
    const pair = utils.generateKeyPairSync('ed25519')
    const blob = Buffer.from(pair.public.split(' ')[1], 'base64')
    assert.equal(blob.length, 51, 'string "ssh-ed25519" + string with the 32-byte key')
    if (blob[19] === 0x00) leadingZero++
    assert.ok(!(utils.parseKey(pair.private) instanceof Error), 'private key parses')
  }
  assert.ok(leadingZero > 0, 'the loop covered keys that start with 0x00')
})
