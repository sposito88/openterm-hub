/** Parent folder for POSIX paths and Windows paths (C:\Users → C:\). */
export function parent(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path
  const p = path.replace(/[\\/]+$/, '')
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut <= 0) return '/'
  const up = p.slice(0, cut)
  return /^[A-Za-z]:$/.test(up) ? up + '\\' : up
}
