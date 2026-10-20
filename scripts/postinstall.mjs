// Linux: node-pty ships no Linux prebuild, so compile it against Electron's
// headers and place it in prebuilds/linux-<arch>, where node-pty looks for it
// and where electron-builder.yml expects it. serialport has Linux prebuilds.
// Windows and macOS use the N-API prebuilds that ship inside both packages,
// so no compiler toolchain is needed there.
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'

// patches/: small fixes to dependencies (e.g. FIDO2 security keys in ssh2).
execSync('patch-package', { stdio: 'inherit' })

if (process.platform === 'linux') {
  execSync('electron-rebuild -f -o node-pty', { stdio: 'inherit' })
  const dir = `node_modules/node-pty/prebuilds/linux-${process.arch}`
  mkdirSync(dir, { recursive: true })
  copyFileSync('node_modules/node-pty/build/Release/pty.node', `${dir}/pty.node`)
}
