import { connect as netConnect, createServer, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import type { ForwardRule, ForwardStatus } from '@shared/types'
import { createSocksServer } from './socks'
import { connectHost, type SshDeps } from './ssh'

type Send = (channel: string, payload: ForwardStatus) => void

interface Running {
  client: Client
  server?: Server
}

function forwardOut(client: Client, srcAddr: string, srcPort: number, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut(srcAddr, srcPort, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
  })
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, address, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

export class Forwarding {
  private running = new Map<string, Running>()
  private statuses = new Map<string, ForwardStatus>()

  constructor(
    private deps: SshDeps,
    private send: Send
  ) {}

  private setStatus(ruleId: string, state: ForwardStatus['state'], error?: string): void {
    const s = { ruleId, state, error }
    this.statuses.set(ruleId, s)
    this.send('forward:status', s)
  }

  list(): ForwardStatus[] {
    return [...this.statuses.values()]
  }

  async start(ruleId: string): Promise<void> {
    if (this.running.has(ruleId)) return
    const rule = this.deps.store.forward(ruleId)
    if (!rule) throw new Error('Regra não encontrada')
    this.setStatus(ruleId, 'starting')
    let client: Client | undefined
    try {
      client = await connectHost(this.deps, rule.hostId)
      const entry: Running = { client }
      this.running.set(ruleId, entry)
      client.on('close', () => {
        if (this.running.get(ruleId) !== entry) return
        entry.server?.close()
        this.running.delete(ruleId)
        this.setStatus(ruleId, 'error', 'Conexão SSH encerrada')
      })
      entry.server = await this.bind(rule, client)
      this.setStatus(ruleId, 'running')
    } catch (err) {
      this.running.delete(ruleId)
      client?.end()
      this.setStatus(ruleId, 'error', (err as Error).message)
      throw err
    }
  }

  private async bind(rule: ForwardRule, client: Client): Promise<Server | undefined> {
    if (rule.kind === 'local') {
      const server = createServer((sock) => {
        sock.on('error', () => sock.destroy())
        forwardOut(client, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, rule.destHost, rule.destPort).then(
          (stream) => {
            sock.pipe(stream).pipe(sock)
            stream.on('error', () => sock.destroy())
            sock.on('close', () => stream.destroy())
          },
          () => sock.destroy()
        )
      })
      await listen(server, rule.bindPort, rule.bindAddress)
      return server
    }

    if (rule.kind === 'dynamic') {
      const server = createSocksServer((host, port, src) =>
        forwardOut(client, src.remoteAddress ?? '127.0.0.1', src.remotePort ?? 0, host, port)
      )
      await listen(server, rule.bindPort, rule.bindAddress)
      return server
    }

    // remote: the server listens on bindAddress:bindPort and we connect locally to dest.
    // With bindPort 0 the server picks the port, so match on the one it reports.
    const boundPort = await new Promise<number>((resolve, reject) => {
      client.forwardIn(rule.bindAddress, rule.bindPort, (err, port) => (err ? reject(err) : resolve(port || rule.bindPort)))
    })
    client.on('tcp connection', (info, accept, reject) => {
      if (info.destPort !== boundPort) return reject()
      const channel = accept()
      const sock = netConnect(rule.destPort, rule.destHost)
      sock.on('error', () => channel.close())
      channel.on('error', () => sock.destroy())
      channel.pipe(sock).pipe(channel)
    })
    return undefined
  }

  stop(ruleId: string): void {
    const entry = this.running.get(ruleId)
    this.running.delete(ruleId)
    entry?.server?.close()
    entry?.client.end()
    this.setStatus(ruleId, 'stopped')
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }
}
