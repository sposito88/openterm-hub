import type { ReactNode } from 'react'
import { useT } from '../i18n'

export function Drawer({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="backdrop center">
      <div className="modal">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export function FormActions({ onCancel, busy }: { onCancel(): void; busy?: boolean }) {
  const t = useT()
  return (
    <div className="actions">
      <button type="button" className="btn" onClick={onCancel}>
        {t('cancel')}
      </button>
      <button type="submit" className="btn primary" disabled={busy}>
        {t('save')}
      </button>
    </div>
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
