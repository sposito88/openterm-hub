import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { utils } from 'ssh2'
import type { Host, Identity, KnownHost, Snippet, SshKey } from '../src/shared/types'
import {
  decodeBuffer,
  importFile,
  parseExternalImport,
  parseMobaXterm,
  parsePuttyReg,
  parsePuttySessionFiles,
  parsePuttyWindowsRegistry,
  parseSuperPuttyXml,
  parseTermiusCsv,
  parseTermiusJson,
  type ImportFile
} from '../src/main/importer'
import { normalizeGroup } from '../src/main/store'

function fakeStore() {
  const hosts: Host[] = []
  const groups: string[] = []
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
    saveHost: (h: Omit<Host, 'id'> & { id?: string }) => upsert(hosts, { ...h, group: normalizeGroup(h.group ?? '') }),
    groups: () => groups,
    saveGroup: (g: string) => {
      const clean = normalizeGroup(g)
      if (clean && !groups.includes(clean)) groups.push(clean)
    },
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

test('Termius CSV, SSH Config (with multi-word labels & group comments) and JSON imports', () => {
  const store = fakeStore()

  // 1. Termius CSV export (standard + extended columns)
  const csv = [
    'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password',
    '"Produção/Web","Web 01","linux,nginx",10.10.1.10,SSH,2222,deploy,webpass123',
    '"Produção/DB","Postgres Primary","db",admin@10.10.1.20,SSH,22,,dbpass456'
  ].join('\n')
  const fromCsv = parseTermiusCsv(csv)
  const sumCsv = importFile(store as never, fromCsv)
  assert.equal(sumCsv.hosts, 2)
  assert.equal(store.hosts()[0].label, 'Web 01')
  assert.equal(store.hosts()[0].group, 'Produção / Web')
  assert.equal(store.hosts()[0].port, 2222)
  assert.deepEqual(store.hosts()[0].tags, ['linux', 'nginx'])
  assert.equal(store.secrets.get(`host:${store.hosts()[0].id}:password`), 'webpass123')
  assert.equal(store.hosts()[1].username, 'admin')
  assert.equal(store.hosts()[1].hostname, '10.10.1.20')
  assert.equal(store.secrets.get(`host:${store.hosts()[1].id}:password`), 'dbpass456')

  // 2. Termius SSH Config export (multi-word Host names without quotes + group comments + same IP on two hosts)
  const sshCfg = `
# Group: Cloud / AWS
# Tags: prod, bastion
Host Meu Bastion AWS
  HostName 54.1.2.3
  User ec2-user
  Port 22
  ForwardAgent yes

Host App Interna 01
  HostName 10.0.1.50
  User ubuntu
  ProxyJump Meu Bastion AWS
  # Password: secret-app-pw

Host App Interna 02 (Mesmo IP)
  HostName 10.0.1.50
  User ubuntu
`
  const fromSsh = parseExternalImport(sshCfg, 'termius_ssh_config', 'termius', '/home/me')
  const sumSsh = importFile(store as never, fromSsh)
  assert.equal(sumSsh.hosts, 3, 'keeps multi-word labels intact and does not drop second host with same IP')
  const bastion = store.hosts().find((h) => h.label === 'Meu Bastion AWS')!
  const app1 = store.hosts().find((h) => h.label === 'App Interna 01')!
  const app2 = store.hosts().find((h) => h.label === 'App Interna 02 (Mesmo IP)')!
  assert.equal(bastion.group, 'Cloud / AWS')
  assert.equal(bastion.agentForward, true)
  assert.equal(app1.jumpHostId, bastion.id)
  assert.equal(store.secrets.get(`host:${app1.id}:password`), 'secret-app-pw')
  assert.ok(app2)

  // 3. Termius JSON export (group tree, identities, ssh_config nested object)
  const json = {
    groups: [
      { id: 'g1', label: 'Clientes' },
      { id: 'g2', label: 'Acme', parent_group_id: 'g1' }
    ],
    identities: [{ id: 'id1', label: 'Root Acme', username: 'root', password: 'root-acme-pw' }],
    hosts: [
      {
        id: 'h1',
        label: 'ERP Acme',
        address: '172.16.0.10',
        group_id: 'g2',
        ssh_config: { port: 22022, identity_id: 'id1', agent_forwarding: true },
        tags: [{ label: 'erp' }]
      }
    ]
  }
  const fromJson = parseTermiusJson(json)
  const sumJson = importFile(store as never, fromJson)
  assert.equal(sumJson.hosts, 1)
  assert.equal(sumJson.identities, 1)
  const erp = store.hosts().find((h) => h.label === 'ERP Acme')!
  assert.equal(erp.group, 'Clientes / Acme')
  assert.equal(erp.port, 22022)
  assert.deepEqual(store.credentials(erp), { username: 'root', password: 'root-acme-pw', keyId: null })
})

test('PuTTY (.reg UTF-16LE, Linux sessions, Windows reg query, SuperPuTTY XML) imports', () => {
  const store = fakeStore()
  const pair = utils.generateKeyPairSync('ed25519')

  const regText = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]',
    '"HostName"=""',
    '',
    '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Servidor%20Produ%C3%A7%C3%A3o]',
    '"HostName"="deploy@192.168.50.10"',
    '"PortNumber"=dword:000008ae',
    '"Protocol"="ssh"',
    '"Folder"="Datacenter%5CSul"',
    '"Password"="putty-secret"',
    '"PublicKeyFile"="C:\\\\keys\\\\id_ed25519.ppk"',
    '"AgentFwd"=dword:00000001',
    '"RemoteCommand"="sudo su -"',
    '"ProxyMethod"=dword:00000002',
    '"ProxyHost"="127.0.0.1"',
    '"ProxyPort"=dword:00000438',
    '"ProxyUsername"="pxuser"',
    '"ProxyPassword"="pxpass"'
  ].join('\r\n')

  // Encode as UTF-16LE with BOM, just like Windows regedit.exe
  const utf16Buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(regText, 'utf16le')])
  assert.ok(decodeBuffer(utf16Buf).includes('Servidor%20Produ'))

  const parsedReg = parseExternalImport(utf16Buf, 'putty-sessions.reg', 'putty', '/home/me', () => pair.private)
  const sumReg = importFile(store as never, parsedReg)
  assert.equal(sumReg.hosts, 1)
  assert.equal(sumReg.keys, 1)
  assert.equal(sumReg.snippets, 1)

  const h = store.hosts()[0]
  assert.equal(h.label, 'Servidor Produção')
  assert.equal(h.group, 'Datacenter / Sul')
  assert.equal(h.hostname, '192.168.50.10')
  assert.equal(h.username, 'deploy')
  assert.equal(h.port, 2222) // 0x08ae = 2222
  assert.equal(h.agentForward, true)
  assert.equal(store.secrets.get(`host:${h.id}:password`), 'putty-secret')
  assert.equal(store.secrets.get(`host:${h.id}:proxyPassword`), 'pxpass')
  assert.deepEqual(h.proxy, { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'pxuser', hasPassword: true })

  // Linux ~/.putty/sessions format
  const linuxSessions = parsePuttySessionFiles([
    { name: 'Router%20Core', content: 'HostName=10.0.0.254\nPortNumber=23\nProtocol=telnet\nUserName=admin\n' }
  ])
  assert.equal(linuxSessions.hosts?.[0].protocol, 'telnet')
  assert.equal(linuxSessions.hosts?.[0].port, 23)

  // Windows `reg query` output
  const winRegOut = [
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Web%20Node',
    '    HostName    REG_SZ    10.20.30.40',
    '    PortNumber    REG_DWORD    0x16',
    '    Protocol    REG_SZ    ssh',
    '    UserName    REG_SZ    ubuntu'
  ].join('\r\n')
  const parsedWinReg = parsePuttyWindowsRegistry(winRegOut)
  assert.equal(parsedWinReg.hosts?.[0].label, 'Web Node')
  assert.equal(parsedWinReg.hosts?.[0].hostname, '10.20.30.40')
  assert.equal(parsedWinReg.hosts?.[0].port, 22)

  // SuperPuTTY XML
  const xml = `<ArrayOfSessionData><SessionData SessionId="Prod/Cluster/Node01" SessionName="Node 01" Host="10.9.0.1" Port="22" Proto="SSH" Username="root" /></ArrayOfSessionData>`
  const parsedXml = parseSuperPuttyXml(xml)
  assert.equal(parsedXml.hosts?.[0].label, 'Node 01')
  assert.equal(parsedXml.hosts?.[0].group, 'Prod / Cluster')
})

test('MobaXterm (.mxtsessions and MobaXterm.ini) imports', () => {
  const store = fakeStore()
  const mxtsessions = [
    '[Bookmarks]',
    'SubRep=',
    'ImgNum=42',
    'Bastion Root=#109#0%203.0.113.5%22%ops%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont#0#',
    '',
    '[Bookmarks_1]',
    'SubRep=Clientes\\Financeiro',
    'ImgNum=41',
    'API Financeiro=#109#0%10.50.0.12%2222%finadmin%%htop%-1%%%22%%203.0.113.5%22%ops%_ProfileDir_\\.ssh\\id_ed25519%%-1%0%0%0%%1080%%0%0%1#MobaFont#0#',
    'Switch Telnet=#98#1%10.50.0.1%23%netops%%-1%-1#MobaFont#0#',
    'Windows RDP=#91#4%10.50.0.99%3389%Administrator#MobaFont#0#'
  ].join('\r\n')

  const parsed = parseMobaXterm(mxtsessions, '/home/ops')
  const sum = importFile(store as never, parsed)
  // Bastion Root + API Financeiro (linked to Bastion Root) + Switch Telnet = 3 hosts (RDP is skipped)
  assert.equal(sum.hosts, 3)
  assert.equal(sum.snippets, 1)

  const bastionHost = store.hosts().find((h) => h.label === 'Bastion Root')!
  const apiHost = store.hosts().find((h) => h.label === 'API Financeiro')!
  assert.equal(apiHost.group, 'Clientes / Financeiro')
  assert.equal(apiHost.hostname, '10.50.0.12')
  assert.equal(apiHost.port, 2222)
  assert.equal(apiHost.username, 'finadmin')
  assert.equal(apiHost.jumpHostId, bastionHost.id)
  assert.ok(apiHost.startupSnippetId)

  const sw = store.hosts().find((h) => h.label === 'Switch Telnet')!
  assert.equal(sw.protocol, 'telnet')
  assert.equal(sw.port, 23)
})

test('exportBackup and importBackup preserve passwords, proxy passwords, identity passwords and private keys', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Store } = await import('../src/main/store')
  const { generateKey } = await import('../src/main/keys')

  const dirA = mkdtempSync(join(tmpdir(), 'oth-backup-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'oth-backup-b-'))
  try {
    const storeA = new Store(dirA)
    const key = generateKey(storeA, { label: 'prod-ed25519', type: 'ed25519' })
    const ident = storeA.saveIdentity({ label: 'Root Shared', username: 'root', hasPassword: true, keyId: key.id })
    storeA.setSecret(`identity:${ident.id}:password`, 'shared-root-pw')

    const host = storeA.saveHost({
      label: 'DB Master',
      group: 'Produção / Banco',
      hostname: '10.99.0.10',
      port: 22,
      username: 'postgres',
      protocol: 'ssh',
      hasPassword: true,
      keyId: null,
      identityId: null,
      useAgent: false,
      agentForward: false,
      jumpHostId: null,
      startupSnippetId: null,
      tags: ['db'],
      proxy: { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'px', hasPassword: true }
    })
    storeA.setSecret(`host:${host.id}:password`, 'db-master-secret!')
    storeA.setSecret(`host:${host.id}:proxyPassword`, 'proxy-secret!')

    const backup = storeA.exportBackup()

    // Import into a brand-new Store instance
    const storeB = new Store(dirB)
    storeB.importBackup(backup)

    assert.equal(storeB.hosts().length, 1)
    assert.equal(storeB.hosts()[0].hasPassword, true)
    assert.equal(storeB.getSecret(`host:${host.id}:password`), 'db-master-secret!')
    assert.equal(storeB.hosts()[0].proxy?.hasPassword, true)
    assert.equal(storeB.getSecret(`host:${host.id}:proxyPassword`), 'proxy-secret!')

    assert.equal(storeB.identities().length, 1)
    assert.equal(storeB.identities()[0].hasPassword, true)
    assert.equal(storeB.getSecret(`identity:${ident.id}:password`), 'shared-root-pw')

    assert.equal(storeB.keys().length, 1)
    assert.ok(storeB.getSecret(`key:${key.id}:private`)?.includes('BEGIN OPENSSH PRIVATE KEY'))
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})
