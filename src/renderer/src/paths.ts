/** Joins a folder and a name with the folder's own separator (Windows or POSIX). */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

/** "file (1).tar.gz": first free name in a folder, keeping the (double) extension. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const m = name.match(/^(.+?)((?:\.tar)?\.[^.\s]+)?$/)!
  const base = m[1]
  const ext = m[2] ?? ''
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!used.has(candidate)) return candidate
  }
}

/** "drwxr-xr-x" style permission string. */
export function modeString(mode: number, isDir: boolean, isLink: boolean): string {
  const bits = 'rwxrwxrwx'
  let out = isLink ? 'l' : isDir ? 'd' : '-'
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-'
  return out
}

/** Parent folder for POSIX paths and Windows paths (C:\Users → C:\). */
export function parent(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path
  const p = path.replace(/[\\/]+$/, '')
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut <= 0) return '/'
  const up = p.slice(0, cut)
  return /^[A-Za-z]:$/.test(up) ? up + '\\' : up
}
