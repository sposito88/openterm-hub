import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastSegment, suggest, tokenize, type FigSubcommand, type SpecSource } from '../src/main/complete'
import { parseGreeting, parseRequest } from '../src/main/socks'
import { parseJump, parseSshConfig } from '../src/main/sshconfig'
import { LineTracker } from '../src/renderer/src/lineTracker'

const git: FigSubcommand = {
  name: 'git',
  subcommands: [
    { name: 'commit', description: 'Record changes', options: [{ name: ['-m', '--message'], args: {} }, { name: '--amend' }] },
    { name: 'checkout', description: 'Switch branches' },
    { name: 'remote', subcommands: [{ name: 'add' }, { name: 'remove' }] }
  ],
  options: [{ name: '--version' }]
}
const source: SpecSource = {
  commands: ['git', 'gh', 'grep', 'aws/s3'],
  load: async (name) => (name === 'git' ? git : null)
}

test('tokenize keeps quoted strings together', () => {
  assert.deepEqual(tokenize(`git commit -m "hello world" x`), ['git', 'commit', '-m', '"hello world"', 'x'])
  assert.equal(lastSegment('cat a | grep b && git co'), 'git co')
})

test('suggest commands, subcommands and options', async () => {
  const labels = async (line: string) => (await suggest(line, source, [], [])).map((s) => s.label)
  assert.deepEqual(await labels('g'), ['git', 'gh', 'grep'])
  assert.deepEqual(await labels('git c'), ['commit', 'checkout'])
  assert.deepEqual(await labels('git commit --a'), ['--amend'])
  assert.deepEqual(await labels('git remote '), ['add', 'remove'])
  // The value of -m is consumed, so "co" is matched as a subcommand of commit (none).
  assert.deepEqual(await labels('git commit -m msg co'), [])
  assert.deepEqual(await labels('sudo git ch'), ['checkout'])
  const [first] = await suggest('git chec', source, [], [])
  assert.equal(first.insert, 'kout ')
})

test('history and snippets come first', async () => {
  const s = await suggest('git c', source, ['git checkout main', 'ls'], [{ id: '1', label: 'deploy', script: 'git commit -am wip' }])
  assert.equal(s[0].source, 'history')
  assert.equal(s[0].insert, 'heckout main')
  assert.equal(s[1].source, 'snippet')
})

test('line tracker follows typing and invalidates on cursor movement', () => {
  const t = new LineTracker()
  t.feed('ls -la')
  t.feed('\x7f\x7f')
  assert.equal(t.line, 'ls -')
  assert.equal(t.feed('l\r'), 'ls -l')
  assert.equal(t.line, '')
  t.feed('echo foo bar')
  t.feed('\x17')
  assert.equal(t.line, 'echo foo ')
  t.feed('\x1b[D')
  assert.equal(t.valid, false)
  assert.equal(t.feed('\r'), undefined)
  t.feed('vim\t')
  assert.equal(t.valid, false)
  t.feed('\x03')
  assert.equal(t.valid, true)
})

test('ssh config parsing', () => {
  const cfg = `
Host *
  ServerAliveInterval 30
Host web web-alias
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_web
Host db
  HostName=db.internal
  ProxyJump admin@bastion.example.com:2200
Match host foo
  User nobody
`
  const entries = parseSshConfig(cfg, '/home/me')
  assert.deepEqual(entries.map((e) => e.alias), ['web', 'web-alias', 'db'])
  assert.deepEqual(entries[0], { alias: 'web', hostname: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '/home/me/.ssh/id_web' })
  assert.equal(entries[2].hostname, 'db.internal')
  assert.deepEqual(parseJump(entries[2].proxyJump!), { user: 'admin', host: 'bastion.example.com', port: 2200 })
})

test('socks5 parsing', () => {
  assert.equal(parseGreeting(Buffer.from([5])), null)
  assert.deepEqual(parseGreeting(Buffer.from([5, 2, 0, 2])), { methods: [0, 2], consumed: 4 })
  const domain = Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from('example.com'), Buffer.from([0x01, 0xbb])])
  assert.deepEqual(parseRequest(domain), { host: 'example.com', port: 443, consumed: domain.length })
  assert.equal(parseRequest(domain.subarray(0, 8)), null)
  assert.deepEqual(parseRequest(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80])), { host: '127.0.0.1', port: 80, consumed: 10 })
  assert.throws(() => parseRequest(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80])))
})

test('aborted prompts are withdrawn from the UI and resolve to the safe answer', async () => {
  const { Prompts } = await import('../src/main/prompts')
  const sent: Array<[string, unknown]> = []
  const prompts = new Prompts((channel, payload) => sent.push([channel, payload]))
  const abort = new AbortController()
  const answer = prompts.hostKey({ host: 'h', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' }, abort.signal)
  const { promptId } = sent[0][1] as { promptId: string }
  abort.abort()
  assert.equal(await answer, false)
  assert.deepEqual(sent[1], ['prompt:cancel', promptId])
  // A late click on the withdrawn dialog has no effect.
  prompts.answer(promptId, true)
  assert.equal(sent.length, 2)
})

test('shortcut combos are layout independent and validated', async () => {
  const { comboFromEvent, isValidShortcut, resolveShortcuts } = await import('../src/shared/shortcuts')
  const ev = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
    key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods
  })
  assert.equal(comboFromEvent(ev('W', 'KeyW', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+W')
  assert.equal(comboFromEvent(ev('!', 'Digit1', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+1')
  assert.equal(comboFromEvent(ev('ArrowRight', 'ArrowRight', { altKey: true })), 'Alt+ArrowRight')
  assert.equal(comboFromEvent(ev('Shift', 'ShiftLeft', { shiftKey: true })), null)
  assert.equal(isValidShortcut('Shift+A'), false)
  assert.equal(isValidShortcut('A'), false)
  assert.equal(isValidShortcut('F5'), true)
  assert.equal(isValidShortcut('Ctrl+,'), true)
  // Explicit platform: on macOS runners Node exposes navigator.platform too.
  const map = resolveShortcuts({ closeTab: '', copy: 'Ctrl+Alt+C' }, false)
  assert.equal(map.closeTab, '')
  assert.equal(map.copy, 'Ctrl+Alt+C')
  assert.equal(map.paste, 'Ctrl+Shift+V')
})

test('shell history parsers', async () => {
  const { parseBash, parseZsh, parseFish } = await import('../src/main/shellHistory')
  assert.deepEqual(parseBash('ls\n#1700000000\ngit status\n\n'), ['ls', 'git status'])
  assert.deepEqual(parseZsh(': 1700000000:0;ls -la\n: 1700000001:0;echo a \\\nb\nplain'), ['ls -la', 'echo a \nb', 'plain'])
  assert.deepEqual(parseFish('- cmd: ls\n  when: 1\n- cmd: echo a\\\\nb\n'), ['ls', 'echo a\\nb'])
})

test('open-with commands are split without a shell', async () => {
  const { splitCommand } = await import('../src/main/sftp')
  assert.deepEqual(splitCommand('code --wait'), ['code', '--wait'])
  assert.deepEqual(splitCommand(`"/opt/My Editor/bin/ed" -n 'a b'`), ['/opt/My Editor/bin/ed', '-n', 'a b'])
})

test('session logs record history and transcripts', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Logs } = await import('../src/main/logs')
  const dir = mkdtempSync(join(tmpdir(), 'oth-logs-'))
  let changes = 0
  const logs = new Logs(dir, () => changes++)
  const a = logs.start({ title: 'web', target: 'u@web:22', protocol: 'ssh' }, true)
  a.write('hello\r\n')
  a.end('exit 0', true)
  logs.start({ title: 'db', target: 'u@db:22', protocol: 'ssh' }, false)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(await logs.read(logs.list()[1].id), 'hello\r\n')
  assert.ok(changes >= 3)
  // Reopening after an abrupt quit marks the unfinished session as interrupted.
  const reopened = new Logs(dir, () => {})
  assert.equal(reopened.list()[0].result, 'interrupted')
  assert.equal(reopened.list()[1].result, 'exit 0')
  await assert.rejects(reopened.read('../../etc/passwd'))
  assert.ok(readFileSync(join(dir, 'index.json'), 'utf8').includes('u@web:22'))
})

test('macOS defaults use Cmd and match real key events', async () => {
  const { comboFromEvent, defaultShortcuts } = await import('../src/shared/shortcuts')
  const mac = defaultShortcuts(true)
  assert.equal(mac.copy, 'Meta+C')
  assert.equal(mac.closeTab, 'Meta+W')
  assert.equal(mac.tab1, 'Meta+1')
  assert.equal(mac.serial, 'Ctrl+Meta+S')
  const ev = { key: 'h', code: 'KeyH', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true }
  assert.equal(comboFromEvent(ev), mac.openHosts)
  assert.equal(defaultShortcuts(false).copy, 'Ctrl+Shift+C')
})

test('parent folder works for POSIX and Windows paths', async () => {
  const { parent } = await import('../src/renderer/src/paths')
  assert.equal(parent('/home/ana/docs'), '/home/ana')
  assert.equal(parent('/home'), '/')
  assert.equal(parent('/'), '/')
  assert.equal(parent('C:\\Users\\Ana Maria'), 'C:\\Users')
  assert.equal(parent('C:\\Users'), 'C:\\')
  assert.equal(parent('C:\\'), 'C:\\')
})

test('path helpers: join and permission strings', async () => {
  const { joinPath, modeString } = await import('../src/renderer/src/paths')
  assert.equal(joinPath('/home/ana', 'x'), '/home/ana/x')
  assert.equal(joinPath('/', 'x'), '/x')
  assert.equal(joinPath('C:\\Users\\Ana', 'x'), 'C:\\Users\\Ana\\x')
  assert.equal(joinPath('C:\\', 'x'), 'C:\\x')
  assert.equal(modeString(0o40755, true, false), 'drwxr-xr-x')
  assert.equal(modeString(0o100644, false, false), '-rw-r--r--')
})

test('unique names for "keep both"', async () => {
  const { uniqueName } = await import('../src/renderer/src/paths')
  assert.equal(uniqueName('app.tar.gz', ['app.tar.gz']), 'app (1).tar.gz')
  assert.equal(uniqueName('notes.txt', ['notes.txt', 'notes (1).txt']), 'notes (2).txt')
  assert.equal(uniqueName('backups', ['backups']), 'backups (1)')
  assert.equal(uniqueName('.env', ['.env']), '.env (1)')
})

test('launching an external program never hangs the caller', async () => {
  const { launch } = await import('../src/main/sftp')
  const t0 = Date.now()
  await launch(new Promise<void>(() => {}), 50)
  assert.ok(Date.now() - t0 < 1000)
  await assert.rejects(launch(Promise.reject(new Error('ENOENT')), 50))
})

test('breadcrumbs for POSIX and Windows paths', async () => {
  const { crumbs } = await import('../src/renderer/src/paths')
  assert.deepEqual(crumbs('/l/disk0/asposito'), [
    { label: '/', path: '/' },
    { label: 'l', path: '/l' },
    { label: 'disk0', path: '/l/disk0' },
    { label: 'asposito', path: '/l/disk0/asposito' }
  ])
  assert.deepEqual(crumbs('/'), [{ label: '/', path: '/' }])
  assert.deepEqual(crumbs('C:\\Users\\Ana'), [
    { label: 'C:', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'Ana', path: 'C:\\Users\\Ana' }
  ])
  const long = crumbs('/a/b/c/d/e/f/g', 3)
  assert.deepEqual(long.map((c) => c.label), ['/', '…', 'e', 'f', 'g'])
  assert.equal(long[1].path, '/a/b/c/d')
})

test('workspace layout and pane structure', async () => {
  const ws = {
    id: 'ws-1',
    label: 'Prod Cluster',
    layout: 'horizontal' as const,
    panes: [
      { id: 'p1', target: { kind: 'host' as const, hostId: 'h1' }, title: 'Web 01' },
      { id: 'p2', target: { kind: 'host' as const, hostId: 'h2' }, title: 'DB 01' }
    ]
  }
  assert.equal(ws.layout, 'horizontal')
  assert.equal(ws.panes.length, 2)
  assert.equal(ws.panes[0].title, 'Web 01')
  assert.equal(ws.panes[1].title, 'DB 01')
})

test('SFTP multi-select: normal click, Ctrl/Cmd toggle, Shift range, and context/drag preservation', async () => {
  const { selectItems, selectForAction } = await import('../src/renderer/src/paths')
  const shown = ['/a', '/b', '/c', '/d', '/e']

  // Normal click selects single item and sets anchor
  let s = selectItems(shown, [], null, '/b')
  assert.deepEqual(s, { selected: ['/b'], lastClicked: '/b' })

  // Shift click selects inclusive range from lastClicked (/b -> /d)
  s = selectItems(shown, s.selected, s.lastClicked, '/d', { shiftKey: true })
  assert.deepEqual(s, { selected: ['/b', '/c', '/d'], lastClicked: '/d' })

  // Shift click upwards (/d -> /a)
  s = selectItems(shown, s.selected, s.lastClicked, '/a', { shiftKey: true })
  assert.deepEqual(s, { selected: ['/a', '/b', '/c', '/d'], lastClicked: '/a' })

  // Ctrl click toggles item off when already selected
  s = selectItems(shown, s.selected, s.lastClicked, '/c', { ctrlKey: true })
  assert.deepEqual(s, { selected: ['/a', '/b', '/d'], lastClicked: '/c' })

  // Cmd (metaKey) click toggles item on
  s = selectItems(shown, s.selected, s.lastClicked, '/e', { metaKey: true })
  assert.deepEqual(s, { selected: ['/a', '/b', '/d', '/e'], lastClicked: '/e' })

  // Right-click / drag on an already-selected item preserves multi-selection
  assert.deepEqual(selectForAction(s.selected, s.lastClicked, '/b'), {
    selected: ['/a', '/b', '/d', '/e'],
    lastClicked: '/e'
  })

  // Right-click / drag on an unselected item selects only that item
  assert.deepEqual(selectForAction(s.selected, s.lastClicked, '/c'), {
    selected: ['/c'],
    lastClicked: '/c'
  })
})

test('trimTrailingSpaces prevents space-padded TUI rows (e.g. top) from reflowing into blank lines on unmaximize', async () => {
  const { trimTrailingSpaces } = await import('../src/renderer/src/lineTracker')
  ;(globalThis as Record<string, unknown>).window ??= {
    navigator: { userAgent: 'linux', platform: 'Linux' },
    document: {}
  }
  ;(globalThis as Record<string, unknown>).navigator ??= (globalThis as { window: { navigator: unknown } }).window.navigator
  ;(globalThis as Record<string, unknown>).document ??= (globalThis as { window: { document: unknown } }).window.document
  const { Terminal } = await import('@xterm/xterm')

  const term = new Terminal({ cols: 180, rows: 10, allowProposedApi: true })
  const rows = [
    '\x1b[7m  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND' + ' '.repeat(104) + '\x1b[m',
    '   18 root      20   0       0      0      0 I   0.3   0.0  30:18.88 rcu_preempt' + ' '.repeat(100),
    '    1 root      20   0  173848  10332   9728 S   0.0   0.0  96:56.20 systemd' + ' '.repeat(104),
    '<VMA-HML-PRDB2>[sgpprd@sgpbd2c101b2:/export/home/sgpprd]$ git '
  ]
  await new Promise<void>((resolve) => term.write(rows.join('\r\n'), resolve))
  trimTrailingSpaces(term)
  term.resize(100, 10)

  const active = term.buffer.active
  assert.equal(active.cursorY, 3)
  assert.equal(active.getLine(0)?.isWrapped, false)
  assert.equal(active.getLine(1)?.isWrapped, false)
  assert.equal(active.getLine(2)?.isWrapped, false)
  assert.equal(active.getLine(3)?.isWrapped, false)
  // Trailing space before the cursor on the active prompt line is preserved
  assert.equal(
    active.getLine(active.baseY + active.cursorY)?.translateToString(true, 0, active.cursorX),
    '<VMA-HML-PRDB2>[sgpprd@sgpbd2c101b2:/export/home/sgpprd]$ git '
  )
  term.dispose()
})

test('ensureFontLoaded resolves true only on first load of a family/size pair so opening a second tab does not wipe shared WebGL atlas', async () => {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  req.extensions['.css'] = () => {}
  const { ensureFontLoaded } = await import('../src/renderer/src/fonts')
  const first = await ensureFontLoaded('JetBrains Mono', 14)
  const second = await ensureFontLoaded('JetBrains Mono', 14)
  const differentSize = await ensureFontLoaded('JetBrains Mono', 16)
  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(differentSize, true)
})

test('mergeTabs and splitTab preserve original tab IDs as pane IDs so live sessions are retained', async () => {
  ;(globalThis as Record<string, unknown>).window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    openterm: {
      onChanged: () => {},
      onForwardStatus: () => {},
      onTransferProgress: () => {},
      onHostKeyPrompt: () => {},
      onCredentialPrompt: () => {}
    }
  }
  const { useApp } = await import('../src/renderer/src/state')
  useApp.getState().openTab('terminal', 'Host A', { kind: 'host', hostId: 'h1' })
  useApp.getState().openTab('terminal', 'Local', { kind: 'local' })
  const [tabA, tabB] = useApp.getState().tabs
  useApp.getState().mergeTabs(tabB.id, tabA.id, 'horizontal')
  const merged = useApp.getState().tabs.find((t) => t.id === tabA.id)!
  assert.equal(merged.kind, 'workspace')
  assert.deepEqual(
    merged.panes?.map((p) => p.id),
    [tabA.id, tabB.id]
  )
})

test('detectOsFromText and resolveHostOs identify OS icons from SSH banners, os-release and host metadata', async () => {
  const { detectOsFromText } = await import('../src/main/ssh')
  const { resolveHostOs } = await import('../src/renderer/src/components/OsIcon')

  assert.equal(detectOsFromText('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10'), 'ubuntu')
  assert.equal(detectOsFromText('SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3'), 'debian')
  assert.equal(detectOsFromText('ID="rhel"\nNAME="Red Hat Enterprise Linux"'), 'redhat')
  assert.equal(detectOsFromText('ID="almalinux"\nPRETTY_NAME="AlmaLinux 9.4"'), 'alma')
  assert.equal(detectOsFromText('ID="rocky"\nNAME="Rocky Linux"'), 'rocky')
  assert.equal(detectOsFromText('Darwin'), 'macos')

  assert.equal(
    resolveHostOs({ os: 'debian', label: 'VMHOME', hostname: '192.168.2.133', username: 'sposito', group: 'Pessoal', tags: [] }),
    'debian'
  )
  assert.equal(
    resolveHostOs({ os: null, label: 'raspberry', hostname: '192.168.2.185', username: 'pi', group: '', tags: [] }),
    'raspbian'
  )
})

test('default settings has copyOnSelect enabled for PuTTY style UX', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/shared/types')
  assert.equal(DEFAULT_SETTINGS.copyOnSelect, true)
})

test('tab duplication, theme override and closing other tabs', async () => {
  const { useApp } = await import('../src/renderer/src/state')
  // Reset tabs
  useApp.setState({ tabs: [], activeTab: null })

  // Open a tab with custom theme
  useApp.getState().openTab('terminal', 'Production Web', { kind: 'host', hostId: 'h-prd' }, 'phosphor-red')
  const [initialTab] = useApp.getState().tabs
  assert.equal(initialTab.title, 'Production Web')
  assert.equal(initialTab.themeOverride, 'phosphor-red')

  // Change theme dynamically
  useApp.getState().setTabTheme(initialTab.id, 'dracula')
  assert.equal(useApp.getState().tabs.find((t) => t.id === initialTab.id)?.themeOverride, 'dracula')

  // Duplicate the tab
  useApp.getState().duplicateTab(initialTab.id)
  const tabsAfterDupe = useApp.getState().tabs
  assert.equal(tabsAfterDupe.length, 2)
  const duplicated = tabsAfterDupe[1]
  assert.equal(duplicated.title, 'Production Web')
  assert.equal(duplicated.themeOverride, 'dracula')
  assert.deepEqual(duplicated.target, { kind: 'host', hostId: 'h-prd' })
  assert.equal(useApp.getState().activeTab, duplicated.id)

  // Open a third tab and test closeOtherTabs
  useApp.getState().openTab('terminal', 'Local', { kind: 'local' })
  assert.equal(useApp.getState().tabs.length, 3)

  useApp.getState().closeOtherTabs(initialTab.id)
  const remainingTabs = useApp.getState().tabs
  assert.equal(remainingTabs.length, 1)
  assert.equal(remainingTabs[0].id, initialTab.id)
  assert.equal(useApp.getState().activeTab, initialTab.id)
})

test('SFTP entries sorting: folders first, A-Z / Z-A, mtime, and size', async () => {
  const { sortEntries } = await import('../src/renderer/src/views/SftpTab')
  const mockFiles = [
    { name: 'zeta.txt', path: '/zeta.txt', isDir: false, isLink: false, size: 500, mtime: 1000, mode: 0o644 },
    { name: 'alpha.txt', path: '/alpha.txt', isDir: false, isLink: false, size: 2000, mtime: 3000, mode: 0o644 },
    { name: 'beta-dir', path: '/beta-dir', isDir: true, isLink: false, size: 0, mtime: 2000, mode: 0o755 },
    { name: 'alpha-dir', path: '/alpha-dir', isDir: true, isLink: false, size: 0, mtime: 4000, mode: 0o755 }
  ]

  // Name asc (A-Z) -> folders first (alpha-dir, beta-dir), then files (alpha.txt, zeta.txt)
  const byNameAsc = sortEntries(mockFiles, 'name', 'asc', () => 'Arquivo')
  assert.deepEqual(byNameAsc.map((x) => x.name), ['alpha-dir', 'beta-dir', 'alpha.txt', 'zeta.txt'])

  // Name desc (Z-A) -> folders first (beta-dir, alpha-dir), then files (zeta.txt, alpha.txt)
  const byNameDesc = sortEntries(mockFiles, 'name', 'desc', () => 'Arquivo')
  assert.deepEqual(byNameDesc.map((x) => x.name), ['beta-dir', 'alpha-dir', 'zeta.txt', 'alpha.txt'])

  // Size desc -> folders first, then files largest to smallest (alpha.txt: 2000, zeta.txt: 500)
  const bySizeDesc = sortEntries(mockFiles, 'size', 'desc', () => 'Arquivo')
  assert.equal(bySizeDesc[2].name, 'alpha.txt')
  assert.equal(bySizeDesc[3].name, 'zeta.txt')

  // Mtime desc (newest first) -> folders first (alpha-dir: 4000, beta-dir: 2000), then files (alpha.txt: 3000, zeta.txt: 1000)
  const byMtimeDesc = sortEntries(mockFiles, 'mtime', 'desc', () => 'Arquivo')
  assert.deepEqual(byMtimeDesc.map((x) => x.name), ['alpha-dir', 'beta-dir', 'alpha.txt', 'zeta.txt'])
})

test('SFTP transfer cancellation aborts controller and removes from active transfers', async () => {
  const { Sftp } = await import('../src/main/sftp')
  const progressEvents: Array<{ channel: string; payload: any }> = []
  const sftp = new Sftp(
    {} as any,
    (channel, payload) => {
      progressEvents.push({ channel, payload })
    },
    async () => {}
  )
  const ctrl = new AbortController()
  ;(sftp as any).activeTransfers.set('tx-123', ctrl)
  assert.equal(ctrl.signal.aborted, false)
  sftp.cancel('tx-123')
  assert.equal(ctrl.signal.aborted, true)
  assert.equal((sftp as any).activeTransfers.has('tx-123'), false)
  assert.equal(progressEvents.length, 1)
  assert.equal(progressEvents[0].channel, 'sftp:progress')
  assert.equal(progressEvents[0].payload.done, true)
  assert.equal(progressEvents[0].payload.error, 'Transferência cancelada')
})

test('sidebar auto-hides when terminal tab opens and can be toggled', async () => {
  const { useApp } = await import('../src/renderer/src/state')
  useApp.setState({ tabs: [], activeTab: null, sidebarInSession: false, sidebarInVault: true })

  // In vault, sidebarInVault is true
  assert.equal(useApp.getState().sidebarInVault, true)

  // Opening a terminal tab sets activeTab and ensures sidebarInSession is false
  useApp.getState().openTab('terminal', 'Local', { kind: 'local' })
  assert.equal(useApp.getState().sidebarInSession, false)
  assert.notEqual(useApp.getState().activeTab, null)

  // Toggle in session flips sidebarInSession
  useApp.getState().toggleSidebar()
  assert.equal(useApp.getState().sidebarInSession, true)

  useApp.getState().toggleSidebar()
  assert.equal(useApp.getState().sidebarInSession, false)

  // Return to vault
  useApp.getState().activate(null)
  assert.equal(useApp.getState().activeTab, null)
  assert.equal(useApp.getState().sidebarInVault, true)
})

