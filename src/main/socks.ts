import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** Minimal SOCKS5 (RFC 1928): no authentication, CONNECT command only. */

export type Greeting = { methods: number[]; consumed: number }
export type ConnectRequest = { host: string; port: number; consumed: number }

export function parseGreeting(buf: Buffer): Greeting | null {
  if (buf.length < 2) return null
  if (buf[0] !== 5) throw new Error('Versão SOCKS não suportada')
  const n = buf[1]
  if (buf.length < 2 + n) return null
  return { methods: [...buf.subarray(2, 2 + n)], consumed: 2 + n }
}

export function parseRequest(buf: Buffer): ConnectRequest | null {
  if (buf.length < 4) return null
  if (buf[0] !== 5) throw new Error('Versão SOCKS não suportada')
  if (buf[1] !== 1) throw Object.assign(new Error('Comando SOCKS não suportado'), { reply: 7 })
  const atyp = buf[3]
  let host: string
  let offset: number
  if (atyp === 1) {
    if (buf.length < 10) return null
    host = [...buf.subarray(4, 8)].join('.')
    offset = 8
  } else if (atyp === 3) {
    if (buf.length < 5) return null
    const len = buf[4]
    if (buf.length < 5 + len + 2) return null
    host = buf.subarray(5, 5 + len).toString('utf8')
    offset = 5 + len
  } else if (atyp === 4) {
    if (buf.length < 22) return null
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
    host = parts.join(':')
    offset = 20
  } else {
    throw Object.assign(new Error('Tipo de endereço SOCKS não suportado'), { reply: 8 })
  }
  return { host, port: buf.readUInt16BE(offset), consumed: offset + 2 }
}

export function reply(code: number): Buffer {
  return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])
}

export type Connector = (host: string, port: number, src: Socket) => Promise<Duplex>

export function createSocksServer(connect: Connector): Server {
  return createServer((sock) => {
    let buf = Buffer.alloc(0)
    let stage: 'greeting' | 'request' | 'piping' = 'greeting'
    sock.on('error', () => sock.destroy())

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      try {
        if (stage === 'greeting') {
          const g = parseGreeting(buf)
          if (!g) return
          buf = buf.subarray(g.consumed)
          if (!g.methods.includes(0)) {
            sock.end(Buffer.from([5, 0xff]))
            return
          }
          sock.write(Buffer.from([5, 0]))
          stage = 'request'
        }
        if (stage === 'request') {
          const r = parseRequest(buf)
          if (!r) return
          const rest = buf.subarray(r.consumed)
          stage = 'piping'
          sock.off('data', onData)
          sock.pause()
          connect(r.host, r.port, sock).then(
            (stream) => {
              sock.write(reply(0))
              if (rest.length) stream.write(rest)
              sock.pipe(stream).pipe(sock)
              stream.on('error', () => sock.destroy())
              sock.on('close', () => stream.destroy())
              sock.resume()
            },
            () => sock.end(reply(5))
          )
        }
      } catch (err) {
        sock.end(reply((err as { reply?: number }).reply ?? 1))
      }
    }
    sock.on('data', onData)
  })
}
