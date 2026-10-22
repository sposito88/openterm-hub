import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { test } from 'node:test'
import type { Host } from '../src/shared/types'
import { askFields, expandSnippet } from '../src/shared/snippetVars'
import { Autoresponder, stripAnsi } from '../src/main/automation'
import { LocalHooks, runLocalCommand } from '../src/main/localCommand'
import { proxyConnect } from '../src/main/proxy'
import { createSocksServer } from '../src/main/socks'

test('snippet variables: built-ins, globals, ask and foreign templates', () => {
  const ctx = {
    host: '10.0.0.5',
    label: 'web',
    user: 'ana',
    port: 2222,
    now: new Date(2026, 9, 22, 9, 5, 7),
    variables: [{ name: 'env', value: 'prod' }, { name: 'host', value: 'ignored: built-in wins' }]
  }
  const script = 'ssh {{user}}@{{host}} -p {{port}} # {{label}} {{env}} {{date}} {{time}}'
  assert.equal(expandSnippet(script, ctx), 'ssh ana@10.0.0.5 -p 2222 # web prod 2026-10-22 09:05:07')
  // Other tools' templates and unknown names stay as they are.
  assert.equal(expandSnippet("docker ps --format '{{.Names}}' {{ .Values }} {{nope}}", ctx), "docker ps --format '{{.Names}}' {{ .Values }} {{nope}}")
  const asking = 'systemctl restart {{ask:Serviço?=nginx}} && journalctl -u {{ask:Serviço?=nginx}} -n {{ask:Linhas}}'
  assert.deepEqual(askFields(asking), [
    { question: 'Serviço?', default: 'nginx' },
    { question: 'Linhas', default: '' }
  ])
  assert.equal(expandSnippet(asking, ctx, { 'Serviço?': 'redis', Linhas: '50' }), 'systemctl restart redis && journalctl -u redis -n 50')
  assert.equal(expandSnippet(asking, ctx, {}), 'systemctl restart nginx && journalctl -u nginx -n ')
})

function responder(opts: Partial<ConstructorParameters<typeof Autoresponder>[0]> = {}) {
  const written: string[] = []
  const notices: string[] = []
  const done: Array<[boolean, string | undefined]> = []
  const auto = new Autoresponder({
    steps: [],
    write: (d) => written.push(d),
    notice: (t) => notices.push(t),
    onStepsDone: (ok, reason) => done.push([ok, reason]),
    ...opts
  })
  return { auto, written, notices, done }
}

test('login sequence answers in order, across chunks, with regex and colours', () => {
  const r = responder({
    steps: [
      { expect: 'Select target:', send: '2' },
      { expect: '/^\\$ ?$/m', send: 'sudo su -' },
      { expect: 'password for', send: 'pw' }
    ]
  })
  // Output that arrived before the session was registered is checked on start().
  r.auto.feed('Welcome\r\nSelect tar')
  assert.deepEqual(r.written, [])
  r.auto.start()
  r.auto.feed('\x1b[1mget:\x1b[0m ')
  assert.deepEqual(r.written, ['2\r'])
  r.auto.feed('\r\nbastion\r\n$ ')
  assert.deepEqual(r.written, ['2\r', 'sudo su -\r'])
  // The text matched by a step never satisfies the next one.
  r.auto.feed('[sudo] PASSWORD FOR ana: ')
  assert.deepEqual(r.written, ['2\r', 'sudo su -\r', 'pw\r'])
  assert.deepEqual(r.done, [[true, undefined]])
  r.auto.dispose()
})

test('a step that never shows up stops the sequence and says where', async () => {
  const r = responder({ steps: [{ expect: 'never', send: 'x' }], stepTimeoutMs: 20 })
  r.auto.start()
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(r.done.length, 1)
  assert.equal(r.done[0][0], false)
  assert.match(r.done[0][1]!, /passo 1.*never/)
  r.auto.feed('never')
  assert.deepEqual(r.written, [], 'nothing typed after giving up')
})

test('without steps the sequence is done at start, so the startup snippet runs then', () => {
  const r = responder()
  assert.equal(r.done.length, 0)
  r.auto.start()
  assert.deepEqual(r.done, [[true, undefined]])
})

test('sudo password: only after a command, once, and never in a loop', () => {
  const r = responder({ sudoPassword: 's3cret' })
  r.auto.start()
  // Text that only looks like the prompt (a file being printed) is not answered.
  r.auto.feed('[sudo] password for ana: ')
  assert.deepEqual(r.written, [])
  // A command that prints the prompt's text right after Enter is not sudo either.
  r.auto.feed("$ echo '[sudo] password for ana: '")
  r.auto.userInput('\r')
  r.auto.feed("\r\n[sudo] password for ana: ")
  assert.deepEqual(r.written, [])
  // A real sudo: the typed command (echoed by the shell, or recalled with ↑) runs sudo.
  r.auto.feed('\r\n$ sudo apt update')
  r.auto.userInput('\r')
  r.auto.feed('\r\n[sudo] password for ana: ')
  assert.deepEqual(r.written, ['s3cret\r'])
  // Refused: sudo asks again by itself; we stop instead of retrying.
  r.auto.feed('\r\nSorry, try again.\r\n[sudo] password for ana: ')
  assert.deepEqual(r.written, ['s3cret\r'])
  assert.equal(r.notices.length, 1)
  r.auto.userInput('sudo ls\r')
  r.auto.feed('[sudo] password for ana: ')
  assert.deepEqual(r.written, ['s3cret\r'], 'stays off for the session')
  // Login steps that run sudo arm it too.
  const step = responder({ sudoPassword: 'pw', steps: [{ expect: '$', send: 'sudo su -' }] })
  step.auto.start()
  step.auto.feed('$ ')
  step.auto.feed('sudo su -\r\n[sudo] password for ana: ')
  assert.deepEqual(step.written, ['sudo su -\r', 'pw\r'])
  // Portuguese prompt.
  const pt = responder({ sudoPassword: 'x' })
  pt.auto.start()
  // Pasted text or a snippet: the command is in what was sent, before any echo.
  pt.auto.userInput('sudo -v\r')
  pt.auto.feed('[sudo] senha para ana: ')
  assert.deepEqual(pt.written, ['x\r'])
  assert.equal(stripAnsi('\x1b]0;title\x07\x1b[32mok\x1b[0m'), 'ok')
})

const host = (over: Partial<Host> = {}): Host => ({
  id: 'h1', label: 'web', group: '', hostname: '10.0.0.9', port: 22, username: 'ana', protocol: 'ssh', hasPassword: false,
  keyId: null, identityId: null, useAgent: false, agentForward: false, jumpHostId: null, startupSnippetId: null, tags: [], ...over
})

test('local commands: "before" once for concurrent users, "after" when the last one leaves', async () => {
  const ran: string[] = []
  let fail = false
  const hooks = new LocalHooks(async (cmd, env) => {
    ran.push(`${cmd} ${env.OPENTERM_HOST}`)
    await new Promise((r) => setTimeout(r, 10))
    if (fail && cmd === 'up') throw new Error('vpn down')
  })
  const h = host({ localBefore: 'up', localAfter: 'down' })
  const [a, b] = await Promise.all([hooks.acquire(h, 'ana'), hooks.acquire(h, 'ana')])
  assert.deepEqual(ran, ['up 10.0.0.9'])
  a()
  a()
  assert.deepEqual(ran, ['up 10.0.0.9'], 'releasing twice counts once; one user is still there')
  b()
  assert.deepEqual(ran, ['up 10.0.0.9', 'down 10.0.0.9'])
  fail = true
  await assert.rejects(hooks.acquire(h, 'ana'), /vpn down/)
  fail = false
  ;(await hooks.acquire(h, 'ana'))()
  assert.deepEqual(ran.slice(-2), ['up 10.0.0.9', 'down 10.0.0.9'], 'a failed "before" is retried and leaves nothing to undo')
  assert.deepEqual(ran.filter((x) => x.startsWith('down')).length, 2)
  // Hosts without commands cost nothing.
  ;(await hooks.acquire(host(), 'ana'))()
})

test('runLocalCommand passes host details as environment, reports failures', async () => {
  await runLocalCommand(`node -e "process.exit(process.env.OPENTERM_HOST === 'h' ? 0 : 5)"`, { OPENTERM_HOST: 'h' })
  await assert.rejects(runLocalCommand(`node -e "console.error('no route'); process.exit(3)"`, {}), /código 3.*no route/)
  await assert.rejects(runLocalCommand(`node -e "setTimeout(() => {}, 5000)"`, {}, 100), /excedeu/)
})

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

async function echoThrough(sock: import('node:net').Socket): Promise<string> {
  sock.write('ping')
  sock.resume()
  const [data] = await once(sock, 'data')
  sock.destroy()
  return data.toString()
}

test('SOCKS5 proxy, with and without a login', async () => {
  const echo = createServer((s) => s.pipe(s))
  const echoPort = await listen(echo)
  const open = createSocksServer(async (h, p) => connect(p, h))
  const openPort = await listen(open)
  assert.equal(await echoThrough(await proxyConnect({ type: 'socks5', host: '127.0.0.1', port: openPort }, '127.0.0.1', echoPort)), 'ping')
  assert.equal(await echoThrough(await proxyConnect({ type: 'socks5', host: '127.0.0.1', port: openPort }, 'localhost', echoPort)), 'ping')

  // A proxy that requires user/password (RFC 1929).
  const authed = createServer((sock) => {
    sock.once('data', (greet) => {
      if (!greet.includes(2)) return sock.end(Buffer.from([5, 0xff]))
      sock.write(Buffer.from([5, 2]))
      sock.once('data', (auth) => {
        const u = auth.subarray(2, 2 + auth[1]).toString()
        const p = auth.subarray(3 + auth[1]).toString()
        const ok = u === 'bob' && p === 'pw'
        sock.write(Buffer.from([1, ok ? 0 : 1]))
        if (!ok) return sock.end()
        sock.once('data', (req) => {
          const port = req.readUInt16BE(req.length - 2)
          const up = connect(port, '127.0.0.1', () => {
            // Reply and the first tunnelled bytes in one packet: nothing may be lost.
            sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            sock.pipe(up).pipe(sock)
          })
        })
      })
    })
  })
  const authPort = await listen(authed)
  const proxy = { type: 'socks5' as const, host: '127.0.0.1', port: authPort, username: 'bob', password: 'pw' }
  assert.equal(await echoThrough(await proxyConnect(proxy, '127.0.0.1', echoPort)), 'ping')
  await assert.rejects(proxyConnect({ ...proxy, password: 'bad' }, '127.0.0.1', echoPort), /recusados/)
  await assert.rejects(proxyConnect({ ...proxy, username: undefined }, '127.0.0.1', echoPort), /exige usuário/)
  for (const s of [echo, open, authed]) s.close()
})

test('HTTP CONNECT proxy with Basic auth', async () => {
  const echo = createServer((s) => s.pipe(s))
  const echoPort = await listen(echo)
  const http = createHttpServer()
  http.on('connect', (req, sock, head) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('bob:pw').toString('base64')}`) {
      return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    }
    const [h, p] = req.url!.split(':')
    const up = connect(Number(p), h, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      sock.pipe(up).pipe(sock)
    })
  })
  const port = await listen(http)
  const proxy = { type: 'http' as const, host: '127.0.0.1', port, username: 'bob', password: 'pw' }
  assert.equal(await echoThrough(await proxyConnect(proxy, '127.0.0.1', echoPort)), 'ping')
  await assert.rejects(proxyConnect({ ...proxy, password: 'x' }, '127.0.0.1', echoPort), /407/)
  await assert.rejects(proxyConnect({ ...proxy, port: await closedPort() }, '127.0.0.1', echoPort), /Não foi possível conectar ao proxy/)
  echo.close()
  http.close()
})

async function closedPort(): Promise<number> {
  const s = createServer()
  const port = await listen(s)
  await new Promise((r) => s.close(r))
  return port
}
