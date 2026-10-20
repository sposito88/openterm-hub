import { useState, type FormEvent } from 'react'
import type { Host, HostInput, Protocol } from '@shared/types'
import { api } from '../api'
import { Check, Drawer, Field, FormActions } from '../components/ui'
import { useT } from '../i18n'
import { attempt, useApp } from '../state'

const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, mosh: 22, telnet: 23 }

export function HostEditor({ host, onClose }: { host: Host | null; onClose(): void }) {
  const t = useT()
  const snap = useApp((s) => s.snapshot)!
  const [form, setForm] = useState<HostInput>(() => ({
    id: host?.id,
    label: host?.label ?? '',
    group: host?.group ?? '',
    hostname: host?.hostname ?? '',
    port: host?.port ?? 22,
    username: host?.username ?? '',
    protocol: host?.protocol ?? 'ssh',
    keyId: host?.keyId ?? null,
    useAgent: host?.useAgent ?? true,
    agentForward: host?.agentForward ?? false,
    jumpHostId: host?.jumpHostId ?? null,
    startupSnippetId: host?.startupSnippetId ?? null,
    tags: host?.tags ?? []
  }))
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const groups = [...new Set(snap.hosts.map((h) => h.group).filter(Boolean))]

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const pw = clearPassword ? '' : password || undefined
    const saved = await attempt(() => api.saveHost({ ...form, password: pw }))
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
        <Field label={t('username')}>
          <input className="input" value={form.username} onChange={(e) => set('username', e.target.value)} />
        </Field>
        {form.protocol === 'ssh' && (
          <>
            <Field label={host?.hasPassword ? t('passwordKeep') : t('password')}>
              <input className="input" type="password" value={password} disabled={clearPassword} onChange={(e) => setPassword(e.target.value)} />
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
        <Field label={t('tags')}>
          <input
            className="input"
            value={form.tags.join(', ')}
            onChange={(e) => set('tags', e.target.value.split(','))}
          />
        </Field>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Drawer>
  )
}
