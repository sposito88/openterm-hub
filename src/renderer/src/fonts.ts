// Monospace fonts shipped with the app (SIL OFL / Ubuntu Font Licence), so the
// terminal looks the same on every machine. Regular and bold only.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/fira-code/400.css'
import '@fontsource/fira-code/700.css'
import '@fontsource/cascadia-code/400.css'
import '@fontsource/cascadia-code/700.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@fontsource/roboto-mono/400.css'
import '@fontsource/roboto-mono/700.css'
import '@fontsource/ubuntu-mono/400.css'
import '@fontsource/ubuntu-mono/700.css'
import '@fontsource/noto-sans-mono/400.css'
import '@fontsource/noto-sans-mono/700.css'
import '@fontsource/inconsolata/400.css'
import '@fontsource/inconsolata/700.css'

export const BUNDLED_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'Noto Sans Mono',
  'Inconsolata'
]

/**
 * CSS font-family for the terminal. The setting is a single family name; a
 * value with commas is an advanced, hand-written stack and is used as is.
 */
export function fontStack(setting: string): string {
  if (setting.includes(',')) return setting
  return `"${setting.replace(/"/g, '')}", "JetBrains Mono", monospace`
}

const loadedFonts = new Set<string>()

/**
 * Waits until the first family of the stack is loaded, so xterm measures the right glyphs.
 * Resolves to true the first time a given family/size pair finishes loading.
 */
export async function ensureFontLoaded(setting: string, size: number): Promise<boolean> {
  const first = fontStack(setting).split(',')[0].trim().replace(/^["']|["']$/g, '')
  const key = `${first}:${size}`
  if (loadedFonts.has(key)) return false
  if (typeof document !== 'undefined' && document.fonts) {
    await Promise.all([document.fonts.load(`${size}px "${first}"`), document.fonts.load(`bold ${size}px "${first}"`)]).catch(() => {})
  }
  loadedFonts.add(key)
  return true
}

let systemFonts: Promise<string[]> | null = null

/**
 * Monospace families installed on this computer (Local Font Access API).
 * A family counts as monospace when "iiiii" and "WWWWW" render equally wide.
 */
export function systemMonospaceFonts(): Promise<string[]> {
  systemFonts ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts
    if (!query) return []
    const fonts = await query().catch(() => [])
    const ctx = document.createElement('canvas').getContext('2d')!
    const isMono = (family: string): boolean => {
      ctx.font = `16px "${family}", serif`
      return Math.abs(ctx.measureText('iiiii').width - ctx.measureText('WWWWW').width) < 0.5
    }
    const families = [...new Set(fonts.map((f) => f.family))].filter((f) => !BUNDLED_FONTS.includes(f))
    return families.filter(isMono).sort((a, b) => a.localeCompare(b))
  })()
  return systemFonts
}
