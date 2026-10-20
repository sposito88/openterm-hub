import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FigSubcommand, SpecSource } from './complete'

const SPEC_NAME = /^@?[\w.-]+(\/[\w.-]+)*$/

/**
 * Loads specs from @withfig/autocomplete (MIT/ISC) on demand. Inside a
 * packaged app the package is unpacked from the asar archive, because ES
 * modules are imported from the real filesystem.
 */
export function figSpecs(): SpecSource {
  const require = createRequire(__filename)
  let dir: string
  try {
    dir = dirname(require.resolve('@withfig/autocomplete')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  } catch {
    return { commands: [], load: async () => null }
  }

  const cache = new Map<string, Promise<FigSubcommand | null>>()
  const source: SpecSource = { commands: [], load }
  const known = new Set<string>()

  void import(pathToFileURL(join(dir, 'index.js')).href)
    .then((m: { default: string[] }) => {
      source.commands = m.default
      for (const c of m.default) known.add(c)
    })
    .catch(() => {})

  function load(name: string): Promise<FigSubcommand | null> {
    // Only names listed in the package index (or nested spec paths) can be loaded.
    if (!SPEC_NAME.test(name) || name.includes('..')) return Promise.resolve(null)
    if (!known.has(name) && !known.has(name.split('/')[0])) return Promise.resolve(null)
    let p = cache.get(name)
    if (!p) {
      p = import(pathToFileURL(join(dir, `${name}.js`)).href).then(
        (m: { default: unknown }) => (m.default && typeof m.default === 'object' ? (m.default as FigSubcommand) : null),
        () => null
      )
      cache.set(name, p)
    }
    return p
  }

  return source
}
