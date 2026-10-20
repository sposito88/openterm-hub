export interface SshConfigEntry {
  alias: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

/**
 * Parses the subset of ssh_config(5) that maps to saved hosts. Wildcard
 * patterns are skipped; `Match` blocks are ignored.
 */
export function parseSshConfig(text: string, home: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []
  let current: SshConfigEntry[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')

    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((a) => !/[*?!]/.test(a))
        .map((alias) => ({ alias, hostname: alias }))
      entries.push(...current)
      continue
    }
    if (key === 'match') {
      current = []
      continue
    }
    for (const e of current) {
      if (key === 'hostname') e.hostname = value
      else if (key === 'user') e.user = value
      else if (key === 'port') e.port = Number(value) || undefined
      else if (key === 'identityfile' && !e.identityFile) e.identityFile = value.replace(/^~(?=\/|$)/, home)
      else if (key === 'proxyjump' && value.toLowerCase() !== 'none') e.proxyJump = value.split(',')[0].trim()
    }
  }
  return entries
}

/** Splits a ProxyJump spec `[user@]host[:port]`. */
export function parseJump(spec: string): { user?: string; host: string; port?: number } {
  const m = spec.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  if (!m) return { host: spec }
  return { user: m[1], host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : undefined }
}
