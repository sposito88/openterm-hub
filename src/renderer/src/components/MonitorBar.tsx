import { useEffect, useState } from 'react'
import type { SessionStats } from '@shared/types'
import { useT } from '../i18n'
import { Icon } from './Icon'

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let u = 0
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024
    u++
  }
  const decimals = u >= 3 ? 1 : 0
  return `${val.toFixed(decimals)} ${units[u]}`
}

export function formatPairBytes(used: number, total: number): { text: string; pct: number } {
  const pct = total > 0 ? Math.round(Math.max(0, Math.min(100, (used / total) * 100))) : 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let u = 0
  let tVal = total
  while (tVal >= 1024 && u < units.length - 1) {
    tVal /= 1024
    u++
  }
  const div = Math.pow(1024, u)
  const decimals = u >= 3 ? 1 : 0
  const uStr = (used / div).toFixed(decimals)
  const tStr = (total / div).toFixed(decimals)
  return { text: `${uStr}/${tStr} ${units[u]} (${pct}%)`, pct }
}

export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '—'
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < 1024 * 1024) {
    const kb = bytesPerSec / 1024
    return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB/s`
  }
  const mb = bytesPerSec / (1024 * 1024)
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB/s`
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function meterLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit'
  if (pct >= 70) return 'warn'
  return 'ok'
}

function Meter({ pct }: { pct: number | null }) {
  const val = pct === null ? 0 : Math.max(0, Math.min(100, pct))
  const level = meterLevel(val)
  return (
    <span className="mon-bar" aria-hidden>
      <span className={`mon-fill ${level}`} style={{ width: `${val}%` }} />
    </span>
  )
}

export function MonitorBar({ stats }: { stats: SessionStats | null }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!stats?.connectedAt) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [stats?.connectedAt])

  if (!stats) return null

  const cpuPct = stats.cpuPercent
  const mem = stats.memTotal && stats.memUsed !== null ? formatPairBytes(stats.memUsed, stats.memTotal) : null
  const disk = stats.diskTotal && stats.diskUsed !== null ? formatPairBytes(stats.diskUsed, stats.diskTotal) : null
  const elapsed = formatElapsed(now - stats.connectedAt)
  const cpuTitle =
    cpuPct !== null
      ? `CPU: ${cpuPct}%${stats.loadAvg !== null && stats.loadAvg !== undefined ? ` · Load: ${stats.loadAvg.toFixed(2)}` : ''}`
      : 'CPU'
  const timeTitle =
    stats.uptimeSeconds !== null && stats.uptimeSeconds !== undefined
      ? `${t('connectedTime')}: ${elapsed} · ${t('serverUptime')}: ${formatUptime(stats.uptimeSeconds)}`
      : `${t('connectedTime')}: ${elapsed}`

  return (
    <div className="term-monitor mono">
      <div className="mon-item" title={cpuTitle}>
        <span className="mon-label">CPU</span>
        <Meter pct={cpuPct} />
        <span className="mon-val">{cpuPct !== null ? `${cpuPct}%` : '…'}</span>
      </div>

      {mem && (
        <div className="mon-item" title={`RAM: ${formatBytesCompact(stats.memUsed!)} / ${formatBytesCompact(stats.memTotal!)} (${mem.pct}%)`}>
          <span className="mon-label">RAM</span>
          <Meter pct={mem.pct} />
          <span className="mon-val">{mem.text}</span>
        </div>
      )}

      {disk && (
        <div className="mon-item" title={`${t('rootDisk')}: ${formatBytesCompact(stats.diskUsed!)} / ${formatBytesCompact(stats.diskTotal!)} (${disk.pct}%)`}>
          <span className="mon-label">/</span>
          <Meter pct={disk.pct} />
          <span className="mon-val">{disk.text}</span>
        </div>
      )}

      {(stats.rxRate !== null || stats.txRate !== null) && (
        <div className="mon-item mon-net" title={`${t('netDown')}: ${formatRate(stats.rxRate)} · ${t('netUp')}: ${formatRate(stats.txRate)}`}>
          <span className={`mon-rate down ${(stats.rxRate ?? 0) > 0 ? 'active' : ''}`}>↓ {formatRate(stats.rxRate)}</span>
          <span className={`mon-rate up ${(stats.txRate ?? 0) > 0 ? 'active' : ''}`}>↑ {formatRate(stats.txRate)}</span>
        </div>
      )}

      <div className="mon-item mon-time" title={timeTitle}>
        <Icon name="clock" size={12} />
        <span>{elapsed}</span>
      </div>
    </div>
  )
}
