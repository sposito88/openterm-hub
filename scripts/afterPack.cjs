// electron-builder hook: keeps only the native binaries of the target OS.
// File patterns cannot do this because their ${platform} macro is the build
// machine's OS, not the target's.
const { readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName // linux | win32 | darwin
  const resources =
    platform === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  const modules = join(resources, 'app.asar.unpacked', 'node_modules')
  for (const pkg of ['node-pty', '@serialport/bindings-cpp']) {
    const prebuilds = join(modules, pkg, 'prebuilds')
    for (const dir of readdirSync(prebuilds)) {
      if (!dir.startsWith(`${platform}-`)) rmSync(join(prebuilds, dir), { recursive: true, force: true })
    }
  }
}
