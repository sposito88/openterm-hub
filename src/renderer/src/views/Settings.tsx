import { useEffect, useState, type ReactNode } from 'react'
import {
  comboFromEvent,
  comboKeys,
  defaultShortcuts,
  IS_MAC,
  isValidShortcut,
  resolveShortcuts,
  SHORTCUT_ACTIONS,
  type ShortcutAction
} from '@shared/shortcuts'
import { BUILTIN_VARIABLES } from '@shared/snippetVars'
import { TERM_TYPES, WORD_SEPARATORS, type FileAssociation, type Settings as SettingsT, type SnippetVariable, type SyncStatus } from '@shared/types'
import { BUNDLED_FONTS, fontStack, systemMonospaceFonts } from '../fonts'
import { api } from '../api'
import { Icon, type IconName } from '../components/Icon'
import { useT, type TKey } from '../i18n'
import { attempt, useApp, useUiLight, type SettingsSection } from '../state'
import { TERMINAL_THEMES, type TerminalTheme } from '../terminalThemes'

const REPO = 'https://github.com/sposito88/openterm-hub'

/** Set while a shortcut is being recorded, so global shortcuts do not fire. */
export const shortcutRecording = { active: false }

function save(patch: Partial<SettingsT>): void {
  void attempt(() => api.saveSettings(patch))
}

function Switch({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="label">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function ToggleRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <Row label={label} hint={hint}>
      <Switch on={value} onChange={onChange} />
    </Row>
  )
}

function ThemePreview({ theme }: { theme: TerminalTheme }) {
  const c = theme.colors
  return (
    <div className="theme-preview" style={{ background: c.background }}>
      <i style={{ background: c.green, width: '80%' }} />
      <i style={{ background: c.foreground, width: '55%', opacity: 0.8 }} />
      <i style={{ background: c.blue, width: '70%' }} />
      <i style={{ background: c.yellow, width: '35%' }} />
    </div>
  )
}

const CUSTOM = '__custom__'
const FONT_PREVIEW = 'deploy@web-01:~$ ls -la  0O 1lI {}[]  ═║╔╗ █▓▒░ → ✓'

/** Bundled fonts, monospace fonts installed on this computer, or a custom CSS stack. */
function FontPicker({ s }: { s: SettingsT }) {
  const t = useT()
  const [system, setSystem] = useState<string[]>([])
  const known = BUNDLED_FONTS.includes(s.fontFamily) || system.includes(s.fontFamily)
  const [custom, setCustom] = useState(!s.fontFamily || s.fontFamily.includes(','))
  useEffect(() => void systemMonospaceFonts().then(setSystem), [])
  const value = custom || !known ? CUSTOM : s.fontFamily
  return (
    <>
      <Row label={t('fontFamily')}>
        <select
          className="input"
          style={{ width: 300 }}
          value={value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) return setCustom(true)
            setCustom(false)
            save({ fontFamily: e.target.value })
          }}
        >
          <optgroup label={t('bundledFonts')}>
            {BUNDLED_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
          {system.length > 0 && (
            <optgroup label={t('systemFonts')}>
              {system.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM}>{t('customFont')}</option>
        </select>
      </Row>
      {value === CUSTOM && (
        <Row label={t('customFont')} hint={t('customFontHint')}>
          <input
            className="input mono"
            style={{ width: 300 }}
            defaultValue={known ? '' : s.fontFamily}
            placeholder="'Minha Fonte', monospace"
            onBlur={(e) => e.target.value.trim() && save({ fontFamily: e.target.value.trim() })}
          />
        </Row>
      )}
      <div className="font-preview" style={{ fontFamily: fontStack(s.fontFamily), fontSize: s.fontSize }}>
        {FONT_PREVIEW}
      </div>
    </>
  )
}

/** Double-click word separators: xterm default, PuTTY style or custom characters. */
function WordSeparatorRow({ s }: { s: SettingsT }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const matched = s.wordSeparator === WORD_SEPARATORS.default ? 'default' : s.wordSeparator === WORD_SEPARATORS.putty ? 'putty' : 'custom'
  const preset = editing ? 'custom' : matched
  const [draft, setDraft] = useState(s.wordSeparator)
  useEffect(() => setDraft(s.wordSeparator), [s.wordSeparator])
  return (
    <>
      <Row label={t('wordSeparator')} hint={t('wordSeparatorHint')}>
        <div className="segmented">
          <button
            className={preset === 'default' ? 'on' : ''}
            onClick={() => {
              setEditing(false)
              save({ wordSeparator: WORD_SEPARATORS.default })
            }}
          >
            {t('wsDefault')}
          </button>
          <button
            className={preset === 'putty' ? 'on' : ''}
            onClick={() => {
              setEditing(false)
              save({ wordSeparator: WORD_SEPARATORS.putty })
            }}
          >
            PuTTY
          </button>
          <button className={preset === 'custom' ? 'on' : ''} onClick={() => setEditing(true)}>
            {t('wsCustom')}
          </button>
        </div>
      </Row>
      {preset === 'custom' && (
        <Row label={t('wsCharacters')}>
          <input
            className="input mono"
            style={{ width: 300 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft && save({ wordSeparator: draft })}
          />
        </Row>
      )}
    </>
  )
}

function TerminalSection({ s }: { s: SettingsT }) {
  const t = useT()
  const uiLight = useUiLight()
  const auto = TERMINAL_THEMES[uiLight ? 1 : 0]
  return (
    <>
      <div className="panel">
        <h2>{t('terminalSection')}</h2>
        <ToggleRow label={t('autocomplete')} value={s.autocomplete} onChange={(v) => save({ autocomplete: v })} />
        <ToggleRow label={t('autoReconnect')} value={s.autoReconnect} onChange={(v) => save({ autoReconnect: v })} />
        <ToggleRow label={t('importShellHistory')} hint={t('importShellHistoryHint')} value={s.importShellHistory} onChange={(v) => save({ importShellHistory: v })} />
        <ToggleRow label={t('copyOnSelectLabel')} value={s.copyOnSelect} onChange={(v) => save({ copyOnSelect: v })} />
        <WordSeparatorRow s={s} />
        <ToggleRow label={t('bellSound')} value={s.bellSound} onChange={(v) => save({ bellSound: v })} />
        <ToggleRow label={t('boldBright')} value={s.boldBright} onChange={(v) => save({ boldBright: v })} />
        <Row label={t('termType')}>
          <select className="input" value={s.termType} onChange={(e) => save({ termType: e.target.value as SettingsT['termType'] })}>
            {TERM_TYPES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Row>
        <Row label={t('cursorStyle')}>
          <select className="input" value={s.cursorStyle} onChange={(e) => save({ cursorStyle: e.target.value as SettingsT['cursorStyle'] })}>
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </Row>
        <Row label={t('scrollback')}>
          <input className="input" type="number" min={500} step={500} value={s.scrollback} onChange={(e) => save({ scrollback: Number(e.target.value) || 10000 })} />
        </Row>
        <Row label={t('keepalive')}>
          <input className="input" type="number" min={0} value={s.keepaliveSeconds} onChange={(e) => save({ keepaliveSeconds: Math.max(0, Number(e.target.value)) })} />
        </Row>
      </div>

      <div className="panel">
        <FontPicker s={s} />
        <Row label={t('textSize')}>
          <div className="stepper">
            <button className="btn icon" onClick={() => save({ fontSize: Math.max(8, s.fontSize - 1) })}>
              <Icon name="minus" />
            </button>
            <input className="input" type="number" min={8} max={32} value={s.fontSize} onChange={(e) => save({ fontSize: Number(e.target.value) || 14 })} />
            <button className="btn icon" onClick={() => save({ fontSize: Math.min(32, s.fontSize + 1) })}>
              <Icon name="plus" />
            </button>
          </div>
        </Row>
      </div>

      <div className="panel">
        <h2>{t('terminalTheme')}</h2>
        <div className="themes">
          <button className={`theme-card ${s.terminalTheme === 'auto' ? 'on' : ''}`} onClick={() => save({ terminalTheme: 'auto' })}>
            <ThemePreview theme={auto} />
            <div>
              <div>Auto</div>
              <div className="dim" style={{ fontSize: 11 }}>
                {t('theme')}: {t('system').toLowerCase()}
              </div>
            </div>
          </button>
          {TERMINAL_THEMES.map((th) => (
            <button key={th.id} className={`theme-card ${s.terminalTheme === th.id ? 'on' : ''}`} onClick={() => save({ terminalTheme: th.id })}>
              <ThemePreview theme={th} />
              <div>
                <div>{th.name}</div>
                <div className="dim" style={{ fontSize: 11 }}>
                  {th.light ? t('light') : t('dark')}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function AppearanceSection({ s }: { s: SettingsT }) {
  const t = useT()
  const options: Array<[SettingsT['theme'], TKey]> = [
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'system']
  ]
  return (
    <div className="panel">
      <Row label={t('theme')}>
        <div className="segmented">
          {options.map(([v, k]) => (
            <button key={v} className={s.theme === v ? 'on' : ''} onClick={() => save({ theme: v })}>
              {t(k)}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t('language')}>
        <select className="input" value={s.language} onChange={(e) => save({ language: e.target.value as SettingsT['language'] })}>
          <option value="pt">Português</option>
          <option value="en">English</option>
        </select>
      </Row>
    </div>
  )
}

function SftpSection({ s }: { s: SettingsT }) {
  const t = useT()
  const [draft, setDraft] = useState<FileAssociation>({ ext: '', command: '' })
  const list = s.fileAssociations
  const add = (): void => {
    const ext = draft.ext.trim().replace(/^\./, '').toLowerCase()
    if (!ext) return
    save({ fileAssociations: [...list.filter((a) => a.ext !== ext), { ext, command: draft.command.trim() }] })
    setDraft({ ext: '', command: '' })
  }
  return (
    <>
      <div className="panel">
        <ToggleRow label={t('sftpShowHidden')} value={s.sftpShowHidden} onChange={(v) => save({ sftpShowHidden: v })} />
      </div>
      <div className="panel">
        <h2>{t('fileAssociations')}</h2>
        <p className="note">{t('fileAssocHint')}</p>
        {list.length === 0 && <p className="note">{t('noAssociations')}</p>}
        {list.map((a) => (
          <div key={a.ext} className="setting-row">
            <span className="mono">.{a.ext}</span>
            <span className="mono grow truncate" style={{ flex: 1 }}>
              {a.command || <span className="dim">{t('system')}</span>}
            </span>
            <button className="btn small icon danger" title={t('delete')} onClick={() => save({ fileAssociations: list.filter((x) => x.ext !== a.ext) })}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
        <div className="setting-row">
          <input className="input mono" style={{ width: 110 }} placeholder={t('extension')} value={draft.ext} onChange={(e) => setDraft({ ...draft, ext: e.target.value })} />
          <input
            className="input mono"
            style={{ flex: 1, width: 'auto' }}
            placeholder={`${t('command')}: code --wait`}
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn small primary" onClick={add} disabled={!draft.ext.trim()}>
            <Icon name="plus" /> {t('add')}
          </button>
        </div>
      </div>
    </>
  )
}

function actionLabel(t: (k: TKey) => string, a: ShortcutAction): string {
  if (/^tab\d$/.test(a)) return `${t('sc_tab')} ${a.slice(3)}`
  return t(`sc_${a}` as TKey)
}

function ShortcutsSection({ s }: { s: SettingsT }) {
  const t = useT()
  const toast = useApp((st) => st.toast)
  const map = resolveShortcuts(s.shortcuts)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)

  useEffect(() => {
    shortcutRecording.active = recording !== null
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(null)
      const combo = comboFromEvent(e)
      if (!combo) return
      if (!isValidShortcut(combo)) return toast(t('invalidShortcut'), true)
      const other = SHORTCUT_ACTIONS.find((a) => a !== recording && map[a] === combo)
      if (other) return toast(`${t('conflict')}: ${actionLabel(t, other)}`, true)
      save({ shortcuts: { ...s.shortcuts, [recording]: combo } })
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      shortcutRecording.active = false
    }
  }, [recording, s.shortcuts])

  return (
    <div className="panel" style={{ padding: '10px 8px' }}>
      <div className="shortcut-row dim" style={{ cursor: 'default', fontSize: 12 }}>
        <span>{t('shortcut')}</span>
        <span>{t('action')}</span>
        <button className="btn small" onClick={() => save({ shortcuts: {} })}>
          {t('resetDefaults')}
        </button>
      </div>
      {SHORTCUT_ACTIONS.map((a) => (
        <div key={a} className={`shortcut-row ${recording === a ? 'recording' : ''}`} onClick={() => setRecording(a)}>
          <span>
            {recording === a ? (
              <span className="dim">{t('pressKeys')}</span>
            ) : map[a] ? (
              comboKeys(map[a]).map((k) => (
                <span key={k} className="kbd">
                  {k}
                </span>
              ))
            ) : (
              <span className="dim">{t('disabled')}</span>
            )}
          </span>
          <span>{actionLabel(t, a)}</span>
          <span>
            {map[a] && map[a] !== '' && (
              <button
                className="btn small"
                onClick={(e) => {
                  e.stopPropagation()
                  save({ shortcuts: { ...s.shortcuts, [a]: '' } })
                }}
              >
                {t('disable')}
              </button>
            )}
            {map[a] !== defaultShortcuts(IS_MAC)[a] && (
              <button
                className="btn small"
                style={{ marginLeft: 4 }}
                onClick={(e) => {
                  e.stopPropagation()
                  const rest = { ...s.shortcuts }
                  delete rest[a]
                  save({ shortcuts: rest })
                }}
              >
                <Icon name="refresh" />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function LogsSection({ s }: { s: SettingsT }) {
  const t = useT()
  const setView = useApp((st) => st.setView)
  return (
    <div className="panel">
      <ToggleRow label={t('sessionLogging')} hint={t('sessionLoggingHint')} value={s.sessionLogging} onChange={(v) => save({ sessionLogging: v })} />
      <div className="setting-row">
        <button className="btn" onClick={() => setView('logs')}>
          <Icon name="clock" /> {t('openLogs')}
        </button>
        <button className="btn danger" onClick={() => confirm(t('confirmDelete')) && attempt(() => api.clearLogs())}>
          <Icon name="trash" /> {t('clearLogs')}
        </button>
      </div>
    </div>
  )
}

function VariablesSection({ s }: { s: SettingsT }) {
  const t = useT()
  const [vars, setVars] = useState<SnippetVariable[]>(s.variables)
  const update = (next: SnippetVariable[]): void => setVars(next)
  // Saved when a field loses focus, so typing does not write the settings on every key.
  const commit = (next = vars): void => save({ variables: next.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), value: v.value })) })
  return (
    <div className="panel">
      <div className="setting-row">
        <div>
          <div className="label">{t('snippetVariables')}</div>
          <div className="hint">{t('snippetVariablesHint')}</div>
          <div className="hint mono">{[...BUILTIN_VARIABLES.map((v) => `{{${v}}}`), '{{ask:Pergunta=padrão}}'].join('  ')}</div>
        </div>
      </div>
      {vars.map((v, i) => (
        <div key={i} className="var-row">
          <input
            className="input mono"
            placeholder={t('variableName')}
            value={v.name}
            onChange={(e) => update(vars.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^\w-]/g, '') } : x)))}
            onBlur={() => commit()}
          />
          <input
            className="input mono"
            placeholder={t('variableValue')}
            value={v.value}
            onChange={(e) => update(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            onBlur={() => commit()}
          />
          <button
            className="btn small icon danger"
            title={t('delete')}
            onClick={() => {
              const next = vars.filter((_, j) => j !== i)
              update(next)
              commit(next)
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => update([...vars, { name: '', value: '' }])}>
        <Icon name="plus" /> {t('addVariable')}
      </button>
    </div>
  )
}

function SyncSection() {
  const t = useT()
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [folder, setFolder] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  useEffect(() => {
    void api.syncStatus().then((x) => {
      setSt(x)
      setFolder(x.folder)
    })
    return api.onSyncStatus(setSt)
  }, [])
  if (!st) return null
  const enable = async (): Promise<void> => {
    if (pass !== pass2) return useApp.getState().toast(t('passphraseMismatch'), true)
    const res = await attempt(() => api.enableSync(folder, pass || undefined))
    if (!res) return
    setSt(res)
    setPass('')
    setPass2('')
    if (res.error) useApp.getState().toast(res.error, true)
  }
  return (
    <div className="panel">
      <div className="setting-row">
        <div>
          <div className="label">{t('syncTitle')}</div>
          <div className="hint">{t('syncHint')}</div>
        </div>
        {st.enabled && <Switch on onChange={() => void attempt(() => api.disableSync()).then((x) => x && setSt(x))} />}
      </div>
      <Row label={t('syncFolder')} hint={t('syncFolderHint')}>
        <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
          <input className="input mono" value={folder} onChange={(e) => setFolder(e.target.value)} style={{ width: 260 }} />
          <button
            className="btn small"
            title={t('chooseFolder')}
            onClick={async () => {
              const picked = await api.pickFolder()
              if (picked) setFolder(picked)
            }}
          >
            <Icon name="folder" />
          </button>
        </div>
      </Row>
      <Row label={st.hasPassphrase ? t('syncPassphraseKeep') : t('syncPassphrase')} hint={t('syncPassphraseHint')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={st.hasPassphrase ? '••••••••' : ''} />
          <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={t('repeatPassphrase')} />
        </div>
      </Row>
      <div className="setting-row">
        <span className={`sync-status ${st.error ? 'error' : ''}`}>
          {st.busy
            ? t('syncing')
            : st.error
              ? st.error
              : st.lastSync
                ? `${t('lastSync')}: ${new Date(st.lastSync).toLocaleString()}`
                : st.enabled
                  ? ''
                  : t('syncOff')}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {st.enabled && (
            <button className="btn" disabled={st.busy} onClick={() => void attempt(() => api.syncNow()).then((x) => x && setSt(x))}>
              <Icon name="refresh" /> {t('syncNow')}
            </button>
          )}
          <button className="btn primary" disabled={st.busy || !folder.trim() || (!st.hasPassphrase && !pass)} onClick={enable}>
            {st.enabled ? t('save') : t('enableSync')}
          </button>
        </div>
      </div>
    </div>
  )
}

function BackupSection() {
  const t = useT()
  const toast = useApp((st) => st.toast)
  return (
    <div className="panel">
      <div className="setting-row">
        <span>{t('exportBackup')}</span>
        <button className="btn" onClick={async () => (await attempt(() => api.exportBackup())) && toast('OK')}>
          <Icon name="download" /> {t('backup')}
        </button>
      </div>
      <div className="setting-row">
        <div>
          <div className="label">{t('importBackup')}</div>
          <div className="hint">{t('importHint')}</div>
        </div>
        <button
          className="btn"
          onClick={async () => {
            const res = await attempt(() => api.importBackup())
            if (!res) return
            if (res === 'backup') return toast('OK')
            const linked = res.linked ? `, ${res.linked} ${t('linkedToIdentity')}` : ''
            const msg = `${t('imported')}: ${res.hosts} hosts, ${res.identities} ${t('identities').toLowerCase()}, ${res.keys} ${t('keys').toLowerCase()}, ${res.snippets} snippets, ${res.knownHosts} known hosts${linked} (${res.skipped} ${t('alreadyPresent')})`
            toast(msg)
            for (const e of res.errors.slice(0, 5)) toast(e, true)
            if (res.errors.length > 5) toast(`+${res.errors.length - 5} ${t('error').toLowerCase()}`, true)
            toast(t('deleteImportFile'), true)
          }}
        >
          <Icon name="import" /> {t('importBackup')}
        </button>
      </div>
    </div>
  )
}

function AboutSection() {
  const t = useT()
  const [version, setVersion] = useState('')
  // Read from the running app: a number typed here went stale release after release.
  useEffect(() => void api.appVersion().then(setVersion), [])
  const links: Array<[TKey, string]> = [
    ['documentation', `${REPO}#readme`],
    ['requestFeature', `${REPO}/issues/new?labels=enhancement`],
    ['reportBug', `${REPO}/issues/new?labels=bug`],
    ['changelog', `${REPO}/releases`]
  ]
  return (
    <div className="panel">
      <div className="setting-row">
        <div>
          <div className="label">OpenTerm Hub {version}</div>
          <div className="hint">{t('aboutText')}</div>
        </div>
      </div>
      {links.map(([k, url]) => (
        <button key={k} className="link-row" onClick={() => api.openExternal(url)}>
          {t(k)} <Icon name="external" size={14} />
        </button>
      ))}
    </div>
  )
}

const SECTIONS: Array<{ id: SettingsSection; icon: IconName; label: TKey }> = [
  { id: 'terminal', icon: 'terminal', label: 'terminalSection' },
  { id: 'appearance', icon: 'palette', label: 'appearance' },
  { id: 'sftp', icon: 'folder', label: 'sftpSection' },
  { id: 'shortcuts', icon: 'keyboard', label: 'shortcuts' },
  { id: 'variables', icon: 'code', label: 'snippetVariables' },
  { id: 'sync', icon: 'refresh', label: 'syncTitle' },
  { id: 'logs', icon: 'clock', label: 'logs' },
  { id: 'backup', icon: 'download', label: 'backup' },
  { id: 'about', icon: 'external', label: 'about' }
]

export function Settings() {
  const t = useT()
  const s = useApp((st) => st.snapshot!.settings)
  const section = useApp((st) => st.settingsSection)
  const open = useApp((st) => st.openSettings)
  const body: Record<SettingsSection, ReactNode> = {
    terminal: <TerminalSection s={s} />,
    appearance: <AppearanceSection s={s} />,
    sftp: <SftpSection s={s} />,
    shortcuts: <ShortcutsSection s={s} />,
    variables: <VariablesSection s={s} />,
    sync: <SyncSection />,
    logs: <LogsSection s={s} />,
    backup: <BackupSection />,
    about: <AboutSection />
  }
  return (
    <div className="settings">
      <nav className="settings-nav">
        <h1>{t('settings')}</h1>
        {SECTIONS.map((x) => (
          <button key={x.id} className={`nav-item ${section === x.id ? 'active' : ''}`} onClick={() => open(x.id)}>
            <Icon name={x.icon} /> {t(x.label)}
          </button>
        ))}
      </nav>
      <div className="settings-body">{body[section]}</div>
    </div>
  )
}

export function KnownHosts() {
  const t = useT()
  const known = useApp((s) => s.snapshot!.knownHosts)
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('knownHosts')}</h1>
      </div>
      {known.length === 0 ? (
        <div className="empty">{t('noKnownHosts')}</div>
      ) : (
        <div className="list">
          {known.map((k) => (
            <div key={`${k.host}:${k.port}`} className="list-item">
              <Icon name="shield" size={18} />
              <div className="grow">
                <div>
                  <b>
                    {k.host}:{k.port}
                  </b>{' '}
                  <span className="chip">{k.keyType}</span>
                </div>
                <div className="dim mono truncate selectable">{k.fingerprint}</div>
              </div>
              <span className="dim">{new Date(k.addedAt).toLocaleDateString()}</span>
              <button
                className="btn small icon danger"
                title={t('delete')}
                onClick={() => confirm(t('confirmDelete')) && attempt(() => api.deleteKnownHost(k.host, k.port))}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
