import { useState, useRef, type MouseEvent } from 'react'
import type { SessionTarget } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { useT } from '../i18n'
import { attempt, useApp, type Tab } from '../state'
import { TerminalTab } from './TerminalTab'

export function WorkspaceTab({ tab, active = true }: { tab: Tab; active?: boolean }) {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const splitTab = useApp((s) => s.splitTab)
  const closePane = useApp((s) => s.closePane)
  const toggleBroadcast = useApp((s) => s.toggleBroadcast)
  const toggleMaximizePane = useApp((s) => s.toggleMaximizePane)
  const setSplitRatio = useApp((s) => s.setSplitRatio)
  const renameTab = useApp((s) => s.renameTab)
  const toast = useApp((s) => s.toast)

  const panes = tab.panes ?? []
  const layout = tab.layout ?? 'horizontal'
  const ratio = tab.splitRatio ?? 50
  const isMaximized = !!tab.maximizedPaneId

  // Tracks active session IDs of all panes in this workspace for Broadcast
  const sessions = useRef<Map<string, string>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Host picker for quick split
  const [splitPicker, setSplitPicker] = useState<{
    paneId: string
    direction: 'horizontal' | 'vertical'
  } | null>(null)
  const [pickerFilter, setPickerFilter] = useState('')

  // Rename & Save modal
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState(tab.title)

  // Broadcast write to all sessions in this workspace
  const handleBroadcast = (data: string): void => {
    for (const sid of sessions.current.values()) {
      api.writeSession(sid, data)
    }
  }

  // Resizer drag handler
  const startResize = (e: MouseEvent): void => {
    e.preventDefault()
    draggingRef.current = true
    const onMove = (ev: globalThis.MouseEvent): void => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      let pct: number
      if (layout === 'horizontal') {
        pct = ((ev.clientX - rect.left) / rect.width) * 100
      } else {
        pct = ((ev.clientY - rect.top) / rect.height) * 100
      }
      setSplitRatio(tab.id, Math.round(pct))
    }
    const onUp = (): void => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.dispatchEvent(new Event('resize'))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handlePickTarget = (target: SessionTarget, label: string): void => {
    if (!splitPicker) return
    splitTab(tab.id, splitPicker.direction, target, label)
    setSplitPicker(null)
    setPickerFilter('')
  }

  const handleSaveWorkspace = async (): Promise<void> => {
    const label = saveName.trim() || tab.title
    const saved = await attempt(() =>
      api.saveWorkspace({
        label,
        layout: tab.layout ?? 'horizontal',
        panes: panes.map((p) => ({
          id: p.id,
          target: p.target,
          title: p.title
        }))
      })
    )
    if (saved) {
      renameTab(tab.id, label)
      toast(t('workspaceSaved'))
      setSaving(false)
    }
  }

  const filteredHosts = snap.hosts.filter((h) => {
    const q = pickerFilter.toLowerCase()
    return h.label.toLowerCase().includes(q) || h.hostname.toLowerCase().includes(q) || (h.group ?? '').toLowerCase().includes(q)
  })

  return (
    <div className="workspace-view" ref={containerRef}>
      {/* Top action bar of the workspace */}
      <div className="workspace-bar">
        <div className="workspace-info">
          <Icon name="workspace" size={15} />
          <span className="workspace-title" title={t('renameWorkspace')} onClick={() => setSaving(true)}>
            {tab.title}
          </span>
          <span className="chip dim">{layout === 'horizontal' ? t('layoutHorizontal') : t('layoutVertical')}</span>
          <span className="chip dim">{t('hostsCount').replace('{n}', String(panes.length))}</span>
        </div>
        <div className="workspace-controls">
          <button
            className={`btn small ${tab.broadcast ? 'active' : ''}`}
            title={tab.broadcast ? t('broadcastOn') : t('broadcastOff')}
            onClick={() => toggleBroadcast(tab.id)}
          >
            <Icon name="broadcast" size={13} />
            <span>Broadcast</span>
          </button>
          <button className="btn small" onClick={() => setSaving(true)} title={t('saveWorkspaceHint')}>
            <Icon name="save" size={13} />
            <span>{t('saveWorkspace')}</span>
          </button>
        </div>
      </div>

      {/* Grid of panes */}
      <div className={`workspace-panes ${layout === 'vertical' ? 'col' : 'row'}`}>
        {panes.map((pane, idx) => {
          const isFirst = idx === 0
          const hasTwo = panes.length === 2 && !isMaximized
          const hiddenByMaximize = isMaximized && tab.maximizedPaneId !== pane.id
          const paneStyle = hiddenByMaximize
            ? { display: 'none' }
            : hasTwo
              ? { flex: isFirst ? `${ratio} 1 0%` : `${100 - ratio} 1 0%` }
              : { flex: '1 1 0%' }

          return (
            <div key={pane.id} className="workspace-pane-item" style={paneStyle}>
              <TerminalTab
                tab={tab}
                active={active && !hiddenByMaximize}
                paneId={pane.id}
                paneTarget={pane.target}
                paneTitle={pane.title}
                showPaneHeader={true}
                broadcastActive={tab.broadcast}
                onToggleBroadcast={() => toggleBroadcast(tab.id)}
                onBroadcastWrite={handleBroadcast}
                onSessionReady={(pId, sId) => sessions.current.set(pId, sId)}
                onSessionClosed={(pId) => sessions.current.delete(pId)}
                isMaximized={tab.maximizedPaneId === pane.id}
                onToggleMaximize={() => toggleMaximizePane(tab.id, pane.id)}
                onClosePane={() => closePane(tab.id, pane.id)}
                onSplit={(dir) => setSplitPicker({ paneId: pane.id, direction: dir })}
              />
              {hasTwo && isFirst && (
                <div
                  className={`split-divider ${layout}`}
                  onMouseDown={startResize}
                  title="Arraste para redimensionar"
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Split Picker Popover */}
      {splitPicker && (
        <div className="modal-backdrop" onClick={() => setSplitPicker(null)}>
          <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="picker-header">
              <h3>{splitPicker.direction === 'horizontal' ? t('splitHorizontal') : t('splitVertical')}</h3>
              <button className="btn small icon" onClick={() => setSplitPicker(null)}>
                <Icon name="x" />
              </button>
            </div>
            <input
              className="input"
              autoFocus
              placeholder={t('searchHosts')}
              value={pickerFilter}
              onChange={(e) => setPickerFilter(e.target.value)}
            />
            <div className="picker-list">
              <button
                className="picker-item"
                onClick={() => handlePickTarget({ kind: 'local' }, 'Terminal local')}
              >
                <Icon name="terminal" size={16} />
                <div className="picker-text">
                  <b>Terminal local</b>
                  <span className="dim">Shell do sistema</span>
                </div>
              </button>
              {filteredHosts.map((h) => (
                <button
                  key={h.id}
                  className="picker-item"
                  onClick={() => handlePickTarget({ kind: 'host', hostId: h.id }, h.label)}
                >
                  <Icon name="server" size={16} />
                  <div className="picker-text">
                    <b>{h.label}</b>
                    <span className="dim mono">{h.username ? `${h.username}@` : ''}{h.hostname}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Save Workspace Modal */}
      {saving && (
        <div className="modal-backdrop" onClick={() => setSaving(false)}>
          <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="picker-header">
              <h3>{t('saveWorkspace')}</h3>
              <button className="btn small icon" onClick={() => setSaving(false)}>
                <Icon name="x" />
              </button>
            </div>
            <p className="note" style={{ margin: '0 0 12px' }}>{t('saveWorkspaceHint')}</p>
            <input
              className="input"
              autoFocus
              value={saveName}
              placeholder="Nome do workspace"
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveWorkspace()}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={() => setSaving(false)}>
                {t('cancel')}
              </button>
              <button className="btn primary" onClick={handleSaveWorkspace}>
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
