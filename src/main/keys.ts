import { createHash } from 'node:crypto'
import { utils, type ParsedKey } from 'ssh2'
import type { GeneratedKeyRequest, ImportKeyRequest, SshKey } from '@shared/types'
import { connectHost, exec, shellQuote, type SshDeps } from './ssh'
import type { Store } from './store'

function parse(privateKey: string, passphrase?: string): ParsedKey {
  const parsed = utils.parseKey(privateKey, passphrase)
  if (parsed instanceof Error) {
    if (/passphrase/i.test(parsed.message)) throw new Error('Chave protegida: informe a passphrase')
    throw new Error(`Chave inválida: ${parsed.message}`)
  }
  return Array.isArray(parsed) ? parsed[0] : parsed
}

export function describeKey(privateKey: string, passphrase: string | undefined, label: string) {
  const parsed = parse(privateKey, passphrase)
  const wire = parsed.getPublicSSH()
  const comment = (parsed.comment || label).replace(/\s+/g, '_')
  return {
    type: parsed.type,
    publicKey: `${parsed.type} ${wire.toString('base64')} ${comment}`,
    fingerprint: 'SHA256:' + createHash('sha256').update(wire).digest('base64').replace(/=+$/, ''),
    encrypted: !!passphrase && utils.parseKey(privateKey) instanceof Error
  }
}

function persist(store: Store, label: string, privateKey: string, passphrase?: string): SshKey {
  const info = describeKey(privateKey, passphrase, label)
  const key = store.saveKey({
    label,
    type: info.type,
    publicKey: info.publicKey,
    fingerprint: info.fingerprint,
    hasPassphrase: info.encrypted
  })
  store.setSecret(`key:${key.id}:private`, privateKey)
  store.setSecret(`key:${key.id}:passphrase`, info.encrypted ? passphrase : undefined)
  return key
}

export function generateKey(store: Store, req: GeneratedKeyRequest): SshKey {
  const comment = req.label.replace(/\s+/g, '_')
  const opts: Record<string, unknown> = { comment }
  if (req.type === 'rsa') opts.bits = req.bits ?? 4096
  if (req.type === 'ecdsa') opts.bits = req.bits ?? 256
  if (req.passphrase) {
    opts.passphrase = req.passphrase
    opts.cipher = 'aes256-ctr'
  }
  const pair = utils.generateKeyPairSync(req.type, opts as never)
  return persist(store, req.label, pair.private, req.passphrase || undefined)
}

export function importKey(store: Store, req: ImportKeyRequest): SshKey {
  const privateKey = req.privateKey.trim() + '\n'
  return persist(store, req.label, privateKey, req.passphrase || undefined)
}

/** Equivalent of ssh-copy-id: appends the public key to ~/.ssh/authorized_keys if missing. */
export async function installKeyOnHost(deps: SshDeps, keyId: string, hostId: string): Promise<void> {
  const key = deps.store.key(keyId)
  if (!key) throw new Error('Chave não encontrada')
  const client = await connectHost(deps, hostId)
  try {
    const q = shellQuote(key.publicKey)
    const cmd =
      'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ' +
      `(grep -qxF ${q} ~/.ssh/authorized_keys || printf '%s\\n' ${q} >> ~/.ssh/authorized_keys)`
    const res = await exec(client, cmd)
    if (res.code !== 0) throw new Error(res.stderr.trim() || `Comando remoto falhou (código ${res.code})`)
  } finally {
    client.end()
  }
}
