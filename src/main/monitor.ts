import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import type { Client } from 'ssh2'
import type { SessionStats } from '@shared/types'
import { exec } from './ssh'

export const MONITOR_CMD =
  'echo "===CPU==="; head -n 1 /proc/stat 2>/dev/null; ' +
  'echo "===LOAD==="; cat /proc/loadavg 2>/dev/null; ' +
  'echo "===UPTIME==="; cat /proc/uptime 2>/dev/null; ' +
  'echo "===MEM==="; grep -E "^(MemTotal|MemFree|Buffers|Cached|SReclaimable|MemAvailable):" /proc/meminfo 2>/dev/null; ' +
  'echo "===NET==="; cat /proc/net/dev 2>/dev/null; ' +
  'echo "===DISK==="; df -Pk / 2>/dev/null | tail -n 1'

export interface MonitorSampleState {
  cpu?: { total: number; idle: number }
  net?: { rx: number; tx: number; at: number }
  lastCpuPercent?: number | null
  lastRxRate?: number | null
  lastTxRate?: number | null
}

function parseSections(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parts = raw.split(/^===([A-Z]+)===\r?$/m)
  for (let i = 1; i + 1 < parts.length; i += 2) {
    out[parts[i]] = parts[i + 1].trim()
  }
  return out
}

export function parseMonitorOutput(
  raw: string,
  prev: MonitorSampleState,
  connectedAt: number,
  nowMs = Date.now()
): { stats: SessionStats | null; next: MonitorSampleState } {
  const sec = parseSections(raw)
  const next: MonitorSampleState = { ...prev }

  // 1. CPU (/proc/stat: cpu user nice system idle iowait irq softirq steal ...)
  let cpuPercent: number | null = prev.lastCpuPercent ?? null
  const cpuLine = sec.CPU?.split(/\r?\n/)[0]?.trim() ?? ''
  const cpuMatch = cpuLine.match(/^cpu\s+(.+)$/)
  if (cpuMatch) {
    const nums = cpuMatch[1]
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n))
    if (nums.length >= 4) {
      const idle = nums[3] + (nums[4] ?? 0)
      const total = nums.slice(0, 8).reduce((a, b) => a + b, 0)
      if (prev.cpu && total > prev.cpu.total) {
        const dTotal = total - prev.cpu.total
        const dIdle = Math.max(0, idle - prev.cpu.idle)
        cpuPercent = Math.round(Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)))
        next.lastCpuPercent = cpuPercent
      }
      next.cpu = { total, idle }
    }
  }

  // 2. Load average & Uptime
  let loadAvg: number | null = null
  if (sec.LOAD) {
    const first = Number(sec.LOAD.trim().split(/\s+/)[0])
    if (Number.isFinite(first)) loadAvg = first
  }
  let uptimeSeconds: number | null = null
  if (sec.UPTIME) {
    const first = Number(sec.UPTIME.trim().split(/\s+/)[0])
    if (Number.isFinite(first) && first >= 0) uptimeSeconds = Math.floor(first)
  }

  // 3. Memory (/proc/meminfo, values in kB)
  let memTotal: number | null = null
  let memUsed: number | null = null
  if (sec.MEM) {
    const mem: Record<string, number> = {}
    for (const line of sec.MEM.split(/\r?\n/)) {
      const m = line.match(/^(\w+):\s*(\d+)/)
      if (m) mem[m[1]] = Number(m[2]) * 1024
    }
    if (mem.MemTotal && mem.MemTotal > 0) {
      memTotal = mem.MemTotal
      if (mem.MemAvailable !== undefined) {
        memUsed = Math.max(0, memTotal - mem.MemAvailable)
      } else if (mem.MemFree !== undefined) {
        const reclaimable = (mem.Buffers ?? 0) + (mem.Cached ?? 0) + (mem.SReclaimable ?? 0)
        memUsed = Math.max(0, memTotal - mem.MemFree - reclaimable)
      }
    }
  }

  // 4. Network (/proc/net/dev: iface: rx_bytes rx_packets ... tx_bytes ...)
  let rxRate: number | null = prev.lastRxRate ?? null
  let txRate: number | null = prev.lastTxRate ?? null
  if (sec.NET) {
    let rxSum = 0
    let txSum = 0
    let foundIface = false
    for (const line of sec.NET.split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const iface = line.slice(0, idx).trim()
      if (!iface || iface === 'lo') continue
      const cols = line
        .slice(idx + 1)
        .trim()
        .split(/\s+/)
        .map(Number)
      if (cols.length >= 9 && Number.isFinite(cols[0]) && Number.isFinite(cols[8])) {
        rxSum += cols[0]
        txSum += cols[8]
        foundIface = true
      }
    }
    if (foundIface) {
      if (prev.net && nowMs > prev.net.at) {
        const dt = (nowMs - prev.net.at) / 1000
        if (dt > 0 && rxSum >= prev.net.rx && txSum >= prev.net.tx) {
          rxRate = Math.round((rxSum - prev.net.rx) / dt)
          txRate = Math.round((txSum - prev.net.tx) / dt)
          next.lastRxRate = rxRate
          next.lastTxRate = txRate
        }
      } else {
        rxRate = 0
        txRate = 0
      }
      next.net = { rx: rxSum, tx: txSum, at: nowMs }
    }
  }

  // 5. Root filesystem (df -Pk / -> Filesystem 1024-blocks Used Available Capacity Mounted-on)
  let diskTotal: number | null = null
  let diskUsed: number | null = null
  if (sec.DISK) {
    const m = sec.DISK.trim().match(/(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\/\s*$/)
    if (m) {
      const totalKb = Number(m[1])
      const usedKb = Number(m[2])
      if (totalKb > 0 && Number.isFinite(totalKb) && Number.isFinite(usedKb)) {
        diskTotal = totalKb * 1024
        diskUsed = usedKb * 1024
      }
    }
  }

  const hasAny =
    cpuPercent !== null ||
    next.cpu !== undefined ||
    memTotal !== null ||
    diskTotal !== null ||
    rxRate !== null

  if (!hasAny) return { stats: null, next }

  return {
    stats: {
      connectedAt,
      cpuPercent,
      loadAvg,
      memUsed,
      memTotal,
      diskUsed,
      diskTotal,
      rxRate,
      txRate,
      uptimeSeconds
    },
    next
  }
}

const FIRST_FOLLOWUP_MS = 1000
const POLL_INTERVAL_MS = 3000

/** Polls a remote SSH host over secondary exec channels on the existing SSH connection. */
export function startSshMonitor(client: Client, onStats: (stats: SessionStats) => void): () => void {
  const connectedAt = Date.now()
  let state: MonitorSampleState = {}
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let sampleCount = 0

  onStats({
    connectedAt,
    cpuPercent: null,
    loadAvg: null,
    memUsed: null,
    memTotal: null,
    diskUsed: null,
    diskTotal: null,
    rxRate: null,
    txRate: null,
    uptimeSeconds: null
  })

  const poll = async (): Promise<void> => {
    if (disposed) return
    try {
      const { stdout } = await exec(client, MONITOR_CMD)
      if (disposed) return
      const res = parseMonitorOutput(stdout, state, connectedAt)
      state = res.next
      if (res.stats) {
        failures = 0
        sampleCount++
        onStats(res.stats)
      } else {
        failures++
      }
    } catch {
      failures++
    }
    if (!disposed && failures < 3) {
      const delay = sampleCount === 1 ? FIRST_FOLLOWUP_MS : POLL_INTERVAL_MS
      timer = setTimeout(() => void poll(), delay)
    }
  }

  void poll()

  return () => {
    disposed = true
    clearTimeout(timer)
  }
}

/** Polls the local machine for local terminal tabs using /proc on Linux and Node os/fs APIs elsewhere. */
export function startLocalMonitor(onStats: (stats: SessionStats) => void): () => void {
  const connectedAt = Date.now()
  let state: MonitorSampleState = {}
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let sampleCount = 0

  const poll = async (): Promise<void> => {
    if (disposed) return
    try {
      const nowMs = Date.now()
      const cpus = os.cpus()
      let total = 0
      let idle = 0
      for (const c of cpus) {
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
        idle += c.times.idle
      }
      let cpuPercent: number | null = state.lastCpuPercent ?? null
      if (state.cpu && total > state.cpu.total) {
        const dTotal = total - state.cpu.total
        const dIdle = Math.max(0, idle - state.cpu.idle)
        cpuPercent = Math.round(Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)))
        state.lastCpuPercent = cpuPercent
      }
      state.cpu = { total, idle }

      const memTotal = os.totalmem()
      let memUsed = Math.max(0, memTotal - os.freemem())
      let rxRate: number | null = state.lastRxRate ?? null
      let txRate: number | null = state.lastTxRate ?? null

      if (process.platform === 'linux') {
        const [memRaw, netRaw] = await Promise.all([
          fsp.readFile('/proc/meminfo', 'utf8').catch(() => ''),
          fsp.readFile('/proc/net/dev', 'utf8').catch(() => '')
        ])
        if (memRaw || netRaw) {
          const parsed = parseMonitorOutput(`===MEM===\n${memRaw}\n===NET===\n${netRaw}`, state, connectedAt, nowMs)
          state = { ...parsed.next, cpu: state.cpu, lastCpuPercent: cpuPercent }
          if (parsed.stats?.memUsed !== null && parsed.stats?.memUsed !== undefined) memUsed = parsed.stats.memUsed
          rxRate = parsed.stats?.rxRate ?? rxRate
          txRate = parsed.stats?.txRate ?? txRate
        }
      }

      let diskTotal: number | null = null
      let diskUsed: number | null = null
      try {
        const rootPath = process.platform === 'win32' ? process.env.SystemDrive || 'C:\\' : '/'
        const st = await fsp.statfs(rootPath)
        diskTotal = st.blocks * st.bsize
        diskUsed = Math.max(0, (st.blocks - st.bfree) * st.bsize)
      } catch {
        // statfs unsupported or inaccessible
      }

      if (disposed) return
      sampleCount++
      onStats({
        connectedAt,
        cpuPercent,
        loadAvg: process.platform === 'win32' ? null : os.loadavg()[0],
        memUsed,
        memTotal,
        diskUsed,
        diskTotal,
        rxRate,
        txRate,
        uptimeSeconds: Math.floor(os.uptime())
      })
    } catch {
      // ignore local polling errors
    }
    if (!disposed) {
      const delay = sampleCount === 1 ? FIRST_FOLLOWUP_MS : POLL_INTERVAL_MS
      timer = setTimeout(() => void poll(), delay)
    }
  }

  void poll()

  return () => {
    disposed = true
    clearTimeout(timer)
  }
}
