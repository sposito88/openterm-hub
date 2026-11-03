export interface SshConfigEntry {
  alias: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
  group?: string
  agentForward?: boolean
  tags?: string[]
  password?: string
}

export interface SshConfigOptions {
  /** Treat the entire `Host <value>` line as a single label (used by Termius exports where labels have spaces). */
  singleHostPerBlock?: boolean
  defaultGroup?: string
}

function splitHostPatterns(value: string, singleHostPerBlock?: boolean): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (singleHostPerBlock) {
    const clean = trimmed.replace(/^"(.*)"$/, '$1').trim()
    return clean && !/[*?!]/.test(clean) ? [clean] : []
  }
  // If the entire line is a single quoted string, keep spaces intact.
  if (/^"[^"]+"$/.test(trimmed)) {
    const clean = trimmed.slice(1, -1).trim()
    return clean && !/[*?!]/.test(clean) ? [clean] : []
  }
  const tokens: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) {
    const tok = (m[1] ?? m[2]).trim()
    if (tok && !/[*?!]/.test(tok)) tokens.push(tok)
  }
  return tokens
}

/**
 * Parses the subset of ssh_config(5) that maps to saved hosts. Wildcard
 * patterns are skipped; `Match` blocks are ignored. Comments like
 * `# Group: Prod / Web`, `# Tags: a, b` and `# Password: ...` are preserved.
 */
export function parseSshConfig(text: string, home: string, opts?: SshConfigOptions): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []
  let current: SshConfigEntry[] = []
  let activeGroup = opts?.defaultGroup
  let pendingTags: string[] | undefined

  for (const raw of text.split(/\r?\n/)) {
    const commentMatch = raw.match(/^\s*#\s*(group|folder|grupo|tags|password|senha)\s*:\s*(.+)$/i)
    if (commentMatch) {
      const cKey = commentMatch[1].toLowerCase()
      const cVal = commentMatch[2].trim()
      if (cKey === 'group' || cKey === 'folder' || cKey === 'grupo') {
        activeGroup = cVal
      } else if (cKey === 'tags') {
        pendingTags = cVal.split(/[,;]/).map((t) => t.trim()).filter(Boolean)
      } else if ((cKey === 'password' || cKey === 'senha') && current.length > 0) {
        for (const e of current) e.password = cVal
      }
      continue
    }

    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const rawVal = m[2].trim()
    const value = rawVal.replace(/^"(.*)"$/, '$1')

    if (key === 'host') {
      const aliases = splitHostPatterns(rawVal, opts?.singleHostPerBlock)
      current = aliases.map((alias) => {
        const entry: SshConfigEntry = { alias, hostname: alias }
        if (activeGroup) entry.group = activeGroup
        if (pendingTags?.length) entry.tags = [...pendingTags]
        return entry
      })
      pendingTags = undefined
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
      else if (key === 'identityfile' && !e.identityFile) e.identityFile = value.replace(/^~(?=\/|$|\\)/, home)
      else if (key === 'proxyjump' && value.toLowerCase() !== 'none') e.proxyJump = value.split(',')[0].trim().replace(/^"(.*)"$/, '$1')
      else if (key === 'forwardagent') e.agentForward = /^(yes|true|1)$/i.test(value)
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
