import { connect, isIP, type Socket } from 'node:net'
import type { ProxyType } from '@shared/types'

export interface ProxyTarget {
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
}

/** Reads from a socket until `done` says how many bytes form the reply. */
function readReply(sock: Socket, done: (buf: Buffer) => number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const cleanup = (): void => {
      // Paused until the next reader (or ssh2) resumes it, so no byte is dropped in between.
      sock.pause()
      sock.off('data', onData)
      sock.off('error', onError)
      sock.off('close', onClose)
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('O proxy fechou a conexão'))
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      let n: number | null
      try {
        n = done(buf)
      } catch (err) {
        cleanup()
        return reject(err)
      }
      if (n === null) return
      cleanup()
      // Bytes past the reply already belong to the tunnelled connection (the SSH banner).
      if (buf.length > n) sock.unshift(buf.subarray(n))
      resolve(buf.subarray(0, n))
    }
    sock.on('data', onData)
    sock.once('error', onError)
    sock.once('close', onClose)
    sock.resume()
  })
}

const SOCKS_ERRORS: Record<number, string> = {
  1: 'falha geral',
  2: 'conexão não permitida pelas regras',
  3: 'rede inalcançável',
  4: 'host inalcançável',
  5: 'conexão recusada',
  6: 'TTL expirado',
  7: 'comando não suportado',
  8: 'tipo de endereço não suportado'
}

async function socks5(sock: Socket, p: ProxyTarget, host: string, port: number): Promise<void> {
  const auth = !!p.username
  sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]))
  const [, method] = await readReply(sock, (b) => (b.length >= 2 ? 2 : null))
  if (method === 2) {
    const u = Buffer.from(p.username ?? '')
    const pw = Buffer.from(p.password ?? '')
    if (u.length > 255 || pw.length > 255) throw new Error('Usuário ou senha do proxy longos demais')
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]))
    const [, status] = await readReply(sock, (b) => (b.length >= 2 ? 2 : null))
    if (status !== 0) throw new Error('Proxy SOCKS5: usuário ou senha recusados')
  } else if (method !== 0) {
    throw new Error(auth || method !== 0xff ? 'Proxy SOCKS5: método de autenticação não suportado' : 'Proxy SOCKS5 exige usuário e senha')
  }

  let addr: Buffer
  if (isIP(host) === 4) addr = Buffer.from([1, ...host.split('.').map(Number)])
  else if (isIP(host) === 6) {
    const words = expandIpv6(host)
    addr = Buffer.alloc(17)
    addr[0] = 4
    words.forEach((w, i) => addr.writeUInt16BE(w, 1 + i * 2))
  } else {
    const name = Buffer.from(host)
    if (name.length > 255) throw new Error('Nome de host longo demais para SOCKS5')
    addr = Buffer.concat([Buffer.from([3, name.length]), name])
  }
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(port)
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]))
  const reply = await readReply(sock, (b) => {
    if (b.length < 5) return null
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : -1
    if (len < 0) throw new Error('Resposta SOCKS5 inválida')
    return b.length >= 4 + len + 2 ? 4 + len + 2 : null
  })
  if (reply[1] !== 0) throw new Error(`Proxy SOCKS5: ${SOCKS_ERRORS[reply[1]] ?? `erro ${reply[1]}`}`)
}

function expandIpv6(ip: string): number[] {
  const [head, tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const parts = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return parts.map((x) => parseInt(x, 16) || 0)
}

async function httpConnect(sock: Socket, p: ProxyTarget, host: string, port: number): Promise<void> {
  const target = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
  if (p.username) lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}`)
  sock.write(lines.join('\r\n') + '\r\n\r\n')
  const head = await readReply(sock, (b) => {
    const i = b.indexOf('\r\n\r\n')
    if (i < 0 && b.length > 16_384) throw new Error('Resposta do proxy HTTP longa demais')
    return i < 0 ? null : i + 4
  })
  const status = head.toString('latin1').split('\r\n')[0]
  const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(status)?.[1])
  if (code === 407) throw new Error('Proxy HTTP: autenticação necessária ou recusada (407)')
  if (code < 200 || code > 299 || !code) throw new Error(`Proxy HTTP recusou o túnel: ${status || 'resposta inválida'}`)
}

/**
 * Opens a TCP connection to host:port through a SOCKS5 or HTTP (CONNECT) proxy.
 * The socket comes back paused, holding any bytes that followed the proxy's
 * reply; its reader resumes it (ssh2 does when it takes a `sock`).
 */
export async function proxyConnect(p: ProxyTarget, host: string, port: number, timeoutMs = 20_000): Promise<Socket> {
  const sock = connect(p.port, p.host)
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error('Tempo esgotado aguardando o proxy')))
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    if (p.type === 'socks5') await socks5(sock, p, host, port)
    else await httpConnect(sock, p, host, port)
  } catch (err) {
    sock.destroy()
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH') {
      throw new Error(`Não foi possível conectar ao proxy ${p.host}:${p.port} (${e.code})`)
    }
    throw err
  }
  sock.setTimeout(0)
  return sock
}
