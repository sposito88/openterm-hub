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
  const map = resolveShortcuts({ closeTab: '', copy: 'Ctrl+Alt+C' })
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
