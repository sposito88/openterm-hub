import { useState, type FormEvent } from 'react'
import type { Host, HostInput, LoginStep, OsId, Protocol, ProxyType } from '@shared/types'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { HostBadge, OS_LIST } from '../components/OsIcon'
import { Check, Drawer, Field, FormActions } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'
import { TERMINAL_THEMES } from '../terminalThemes'
import { IdentityEditor } from './Identities'

const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, mosh: 22, telnet: 23 }

export function HostEditor({ host, initialGroup = '', onClose }: { host: Host | null; initialGroup?: string; onClose(): void }) {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const [form, setForm] = useState<HostInput>(() => ({
    id: host?.id,
    label: host?.label ?? '',
    group: host?.group ?? initialGroup,
    hostname: host?.hostname ?? '',
    port: host?.port ?? 22,
    username: host?.username ?? '',
    protocol: host?.protocol ?? 'ssh',
    os: host?.os ?? null,
    theme: host?.theme ?? null,
    keyId: host?.keyId ?? null,
    identityId: host?.identityId ?? null,
    useAgent: host?.useAgent ?? true,
    agentForward: host?.agentForward ?? false,
    jumpHostId: host?.jumpHostId ?? null,
    startupSnippetId: host?.startupSnippetId ?? null,
    tags: host?.tags ?? [],
    loginSteps: host?.loginSteps ?? [],
    autoSudo: host?.autoSudo ?? false,
    proxy: host?.proxy ?? null,
    localBefore: host?.localBefore ?? '',
    localAfter: host?.localAfter ?? ''
  }))
  const [stepSecrets, setStepSecrets] = useState<Record<string, string>>({})
  const [proxyPassword, setProxyPassword] = useState<string | undefined>(undefined)
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [passwordLoaded, setPasswordLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newIdentity, setNewIdentity] = useState(false)
  const identity = form.identityId ? snap.identities.find((i) => i.id === form.identityId) : undefined
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const groups = [...new Set([...(snap.groups ?? []), ...snap.hosts.map((h) => h.group)].filter(Boolean))].sort((a, b) => a.localeCompare(b))

  const loadSavedPassword = async (): Promise<string> => {
    if (!passwordLoaded && host?.hasPassword && host.id) {
      const pw = await api.getHostPassword(host.id)
      setPassword(pw || '')
      setPasswordLoaded(true)
      return pw || ''
    }
    return password
  }

  const toggleShowPassword = async (): Promise<void> => {
    if (!showPassword) {
      await loadSavedPassword()
    }
    setShowPassword(!showPassword)
  }

  const copyPassword = async (): Promise<void> => {
    const pw = await loadSavedPassword()
    if (pw) {
      await navigator.clipboard.writeText(pw)
      useApp.getState().toast(t('passwordCopied'))
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const pw = clearPassword ? '' : (passwordLoaded || password) ? password : undefined
    const saved = await attempt(() => api.saveHost({ ...form, password: pw, proxyPassword, stepSecrets }))
    setBusy(false)
    if (saved) onClose()
  }

  return (
    <Drawer title={host ? t('edit') : t('newHost')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('label')}>
          <input className="input" value={form.label} onChange={(e) => set('label', e.target.value)} autoFocus />
        </Field>
        <div className="row">
          <Field label={t('protocol')}>
            <select
              className="input"
              value={form.protocol}
              onChange={(e) => {
                const p = e.target.value as Protocol
                setForm((f) => ({ ...f, protocol: p, port: f.port === DEFAULT_PORT[f.protocol] ? DEFAULT_PORT[p] : f.port }))
              }}
            >
              <option value="ssh">SSH</option>
              <option value="mosh">Mosh</option>
              <option value="telnet">Telnet</option>
            </select>
          </Field>
          <Field label={t('group')}>
            <input className="input" list="groups" value={form.group} onChange={(e) => set('group', e.target.value)} />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label={t('operatingSystem')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HostBadge host={form} />
            <select
              className="input"
              value={form.os ?? ''}
              onChange={(e) => set('os', (e.target.value || null) as OsId | null)}
            >
              <option value="">{t('osAuto')}</option>
              {OS_LIST.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field label={t('terminalTheme')}>
          <select
            className="input"
            value={form.theme ?? ''}
            onChange={(e) => set('theme', e.target.value || null)}
          >
            <option value="">{t('defaultTheme')}</option>
            {TERMINAL_THEMES.map((th) => (
              <option key={th.id} value={th.id}>
                {th.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label={t('address')}>
            <input className="input" value={form.hostname} onChange={(e) => set('hostname', e.target.value)} required />
          </Field>
          <div style={{ flex: '0 0 90px' }}>
            <Field label={t('port')}>
              <input className="input" type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
            </Field>
          </div>
        </div>
        {form.protocol !== 'ssh' && <p className="note">{t('moshNote')}</p>}
        <Field label={t('identity')}>
          <select className="input" value={form.identityId ?? ''} onChange={(e) => set('identityId', e.target.value || null)}>
            <option value="">{t('identityNone')}</option>
            {[...snap.identities]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label} ({i.username})
                </option>
              ))}
          </select>
        </Field>
        {identity ? (
          <p className="note">
            {t('fromIdentity')} <b>{identity.label}</b> ({identity.username}).
          </p>
        ) : (
          <>
            <Field label={t('username')}>
              <input className="input" value={form.username} onChange={(e) => set('username', e.target.value)} />
            </Field>
            {form.protocol === 'ssh' && (
              <>
                <Field label={host?.hasPassword ? t('passwordKeep') : t('password')}>
                  <div className="input-group">
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      placeholder={host?.hasPassword && !passwordLoaded && !password ? '••••••••' : ''}
                      disabled={clearPassword}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        setPasswordLoaded(true)
                      }}
                    />
                    <div className="input-group-actions">
                      <button
                        type="button"
                        className="input-action-btn"
                        title={showPassword ? t('hidePassword') : t('showPassword')}
                        onClick={toggleShowPassword}
                        disabled={clearPassword || (!host?.hasPassword && !password)}
                      >
                        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={15} />
                      </button>
                      <button
                        type="button"
                        className="input-action-btn"
                        title={t('copyPassword')}
                        onClick={copyPassword}
                        disabled={clearPassword || (!host?.hasPassword && !password)}
                      >
                        <Icon name="copy" size={15} />
                      </button>
                    </div>
                  </div>
                </Field>
                {host?.hasPassword && <Check label={t('removePassword')} checked={clearPassword} onChange={setClearPassword} />}
                <Field label={t('key')}>
                  <select className="input" value={form.keyId ?? ''} onChange={(e) => set('keyId', e.target.value || null)}>
                    <option value="">{t('none')}</option>
                    {snap.keys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label} ({k.type})
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            {form.username.trim() && (
              <button type="button" className="btn small" style={{ marginBottom: 12 }} onClick={() => setNewIdentity(true)}>
                <Icon name="user" /> {t('saveAsIdentity')}
              </button>
            )}
          </>
        )}
        {form.protocol === 'ssh' && (
          <>
            <Field label={t('jumpHost')}>
              <select className="input" value={form.jumpHostId ?? ''} onChange={(e) => set('jumpHostId', e.target.value || null)}>
                <option value="">{t('none')}</option>
                {snap.hosts
                  .filter((h) => h.id !== host?.id && h.protocol === 'ssh')
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t('startupSnippet')}>
              <select className="input" value={form.startupSnippetId ?? ''} onChange={(e) => set('startupSnippetId', e.target.value || null)}>
                <option value="">{t('none')}</option>
                {snap.snippets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Check label={t('useAgent')} checked={form.useAgent} onChange={(v) => set('useAgent', v)} />
            <Check label={t('agentForward')} checked={form.agentForward} onChange={(v) => set('agentForward', v)} />
          </>
        )}
        <details className="section" open={!!form.loginSteps?.length || form.autoSudo}>
          <summary>{t('automation')}</summary>
          <p className="note">{t('loginStepsHint')}</p>
          <LoginSteps
            steps={form.loginSteps ?? []}
            secrets={stepSecrets}
            onChange={(v) => set('loginSteps', v)}
            onSecret={(id, v) => setStepSecrets((x) => ({ ...x, [id]: v }))}
          />
          <Check label={t('autoSudo')} checked={!!form.autoSudo} onChange={(v) => set('autoSudo', v)} />
          <p className="note">{t('autoSudoHint')}</p>
        </details>
        {form.protocol === 'ssh' && (
          <details className="section" open={!!form.proxy}>
            <summary>{t('proxy')}</summary>
            <ProxyFields
              proxy={form.proxy ?? null}
              password={proxyPassword}
              onChange={(v) => set('proxy', v)}
              onPassword={setProxyPassword}
            />
            {form.jumpHostId && <p className="note">{t('proxyJumpNote')}</p>}
          </details>
        )}
        <details className="section" open={!!(form.localBefore || form.localAfter)}>
          <summary>{t('localCommands')}</summary>
          <Field label={t('localBefore')}>
            <input className="input mono" value={form.localBefore ?? ''} placeholder="nmcli con up vpn-empresa" onChange={(e) => set('localBefore', e.target.value)} />
          </Field>
          <Field label={t('localAfter')}>
            <input className="input mono" value={form.localAfter ?? ''} placeholder="nmcli con down vpn-empresa" onChange={(e) => set('localAfter', e.target.value)} />
          </Field>
          <p className="note">{t('localCommandsHint')}</p>
        </details>
        <Field label={t('tags')}>
          <input
            className="input"
            value={form.tags.join(', ')}
            onChange={(e) => set('tags', e.target.value.split(','))}
          />
        </Field>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
      {newIdentity && (
        <IdentityEditor
          identity={null}
          initial={{ label: form.username, username: form.username, password: password || undefined, keyId: form.keyId }}
          onClose={() => setNewIdentity(false)}
          onSaved={(i) => set('identityId', i.id)}
        />
      )}
    </Drawer>
  )
}

function LoginSteps({
  steps,
  secrets,
  onChange,
  onSecret
}: {
  steps: LoginStep[]
  secrets: Record<string, string>
  onChange(v: LoginStep[]): void
  onSecret(id: string, v: string): void
}) {
  const t = useT()
  const update = (i: number, patch: Partial<LoginStep>): void => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={s.id} className="step">
          <span className="step-n">{i + 1}</span>
          <input className="input mono" placeholder={t('stepExpect')} value={s.expect} onChange={(e) => update(i, { expect: e.target.value })} />
          <input
            className="input mono"
            type={s.secret ? 'password' : 'text'}
            placeholder={s.secret ? (secrets[s.id] === undefined ? t('stepSecretKeep') : '') : t('stepSend')}
            value={s.secret ? (secrets[s.id] ?? '') : s.send}
            onChange={(e) => (s.secret ? onSecret(s.id, e.target.value) : update(i, { send: e.target.value }))}
          />
          <button
            type="button"
            className={`btn small icon ${s.secret ? 'active' : ''}`}
            title={t('stepSecret')}
            onClick={() => {
              // Turning a step secret moves what was typed into the encrypted field.
              if (!s.secret && s.send) onSecret(s.id, s.send)
              update(i, { secret: !s.secret, send: '' })
            }}
          >
            <Icon name={s.secret ? 'eyeOff' : 'eye'} />
          </button>
          <button type="button" className="btn small icon danger" title={t('delete')} onClick={() => onChange(steps.filter((_, j) => j !== i))}>
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn small"
        onClick={() => onChange([...steps, { id: crypto.randomUUID(), expect: '', send: '', secret: false }])}
      >
        <Icon name="plus" /> {t('addStep')}
      </button>
    </div>
  )
}

function ProxyFields({
  proxy,
  password,
  onChange,
  onPassword
}: {
  proxy: HostInput['proxy']
  password: string | undefined
  onChange(v: HostInput['proxy']): void
  onPassword(v: string): void
}) {
  const t = useT()
  const p = proxy ?? { type: 'socks5' as ProxyType, host: '', port: 1080, username: '', hasPassword: false }
  const set = (patch: Partial<typeof p>): void => onChange({ ...p, ...patch })
  return (
    <>
      <div className="row">
        <Field label={t('proxyType')}>
          <select
            className="input"
            value={proxy ? p.type : ''}
            onChange={(e) => {
              const type = e.target.value as ProxyType | ''
              if (!type) return onChange(null)
              const port = !proxy || p.port === (p.type === 'http' ? 8080 : 1080) ? (type === 'http' ? 8080 : 1080) : p.port
              onChange({ ...p, type, port })
            }}
          >
            <option value="">{t('none')}</option>
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP (CONNECT)</option>
          </select>
        </Field>
        {proxy && (
          <>
            <Field label={t('address')}>
              <input className="input" value={p.host} onChange={(e) => set({ host: e.target.value })} required />
            </Field>
            <div style={{ flex: '0 0 90px' }}>
              <Field label={t('port')}>
                <input className="input" type="number" min={1} max={65535} value={p.port} onChange={(e) => set({ port: Number(e.target.value) })} />
              </Field>
            </div>
          </>
        )}
      </div>
      {proxy && (
        <div className="row">
          <Field label={t('proxyUser')}>
            <input className="input" value={p.username} onChange={(e) => set({ username: e.target.value })} />
          </Field>
          <Field label={p.hasPassword ? t('passwordKeep') : t('password')}>
            <input
              className="input"
              type="password"
              value={password ?? ''}
              placeholder={p.hasPassword && password === undefined ? '••••••••' : ''}
              onChange={(e) => onPassword(e.target.value)}
            />
          </Field>
        </div>
      )}
    </>
  )
}
