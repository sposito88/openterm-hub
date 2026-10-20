// Generates THIRD_PARTY_NOTICES.md with the license text of every package that
// ships with the app: production dependencies (recursively) plus the libraries
// bundled into the renderer.
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER_BUNDLED = ['react', 'react-dom', 'scheduler', 'zustand', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-web-links']

const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { encoding: 'utf8' }))
const found = new Map()
const walk = (deps = {}) => {
  for (const [name, info] of Object.entries(deps)) {
    if (!info.version || found.has(name)) continue
    found.set(name, info.version)
    walk(info.dependencies)
  }
}
walk(tree.dependencies)
for (const name of RENDERER_BUNDLED) {
  const pkg = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'))
  found.set(name, pkg.version)
}

let out = '# Third-party notices\n\nOpenTerm Hub is MIT licensed. It ships the open source components below, each under its own license.\nElectron and Chromium notices are included in every build (`LICENSE.electron.txt`, `LICENSES.chromium.html`).\n\n'
const missing = []
for (const name of [...found.keys()].sort()) {
  const dir = join('node_modules', name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
  const text = file ? readFileSync(join(dir, file), 'utf8').trim() : null
  if (!text) missing.push(name)
  const license =
    (typeof pkg.license === 'string' ? pkg.license : pkg.license?.type) ?? pkg.licenses?.[0]?.type ?? 'UNKNOWN'
  out += `## ${name}@${found.get(name)} (${license})\n\n${text ? '```\n' + text + '\n```' : '_No license file in the package; see its repository._'}\n\n`
}
writeFileSync('THIRD_PARTY_NOTICES.md', out)
console.log(`${found.size} packages, ${missing.length} without a license file: ${missing.join(', ') || '-'}`)
