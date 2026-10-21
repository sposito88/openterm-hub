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

export interface Crumb {
  label: string
  path: string
}

/**
 * Breadcrumb segments of a POSIX or Windows path, each with the path it opens.
 * Long paths keep the root and the last `keep` folders, with "…" in between.
 */
export function crumbs(path: string, keep = 4): Crumb[] {
  const win = /^[A-Za-z]:/.test(path)
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const out: Crumb[] = win ? [] : [{ label: '/', path: '/' }]
  let acc = ''
  for (const [i, part] of parts.entries()) {
    acc = win ? (i === 0 ? `${part}\\` : `${acc.replace(/\\$/, '')}\\${part}`) : `${acc}/${part}`
    out.push({ label: part, path: acc })
  }
  if (out.length <= keep + 1) return out
  const hidden = out[out.length - keep - 1]
  return [out[0], { label: '…', path: hidden.path }, ...out.slice(-keep)]
}

export interface SelectModifiers {
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

/**
 * Multi-selection logic for SFTP file rows (Ctrl/Cmd toggle, Shift range, normal click).
 * Mirrors Termius ConnectedSFTP (`singleSelect`, `rangeSelect`, `normalSelect`).
 */
export function selectItems(
  shownPaths: readonly string[],
  selected: readonly string[],
  lastClicked: string | null,
  targetPath: string,
  mods: SelectModifiers = {}
): { selected: string[]; lastClicked: string } {
  if (mods.ctrlKey || mods.metaKey) {
    const next = selected.includes(targetPath)
      ? selected.filter((p) => p !== targetPath)
      : [...selected, targetPath]
    return { selected: next, lastClicked: targetPath }
  }
  if (mods.shiftKey) {
    const targetIdx = shownPaths.indexOf(targetPath)
    if (targetIdx === -1) return { selected: [targetPath], lastClicked: targetPath }
    const lastIdx = lastClicked ? shownPaths.indexOf(lastClicked) : 0
    const anchorIdx = lastIdx === -1 ? 0 : lastIdx
    const start = Math.min(anchorIdx, targetIdx)
    const end = Math.max(anchorIdx, targetIdx) + 1
    return { selected: shownPaths.slice(start, end), lastClicked: targetPath }
  }
  return { selected: [targetPath], lastClicked: targetPath }
}

/**
 * Preserves multi-selection when right-clicking or dragging an already-selected item;
 * otherwise selects only the target item.
 */
export function selectForAction(
  selected: readonly string[],
  lastClicked: string | null,
  targetPath: string
): { selected: string[]; lastClicked: string | null } {
  if (selected.includes(targetPath)) {
    return { selected: [...selected], lastClicked }
  }
  return { selected: [targetPath], lastClicked: targetPath }
}

