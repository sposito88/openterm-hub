import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fsp, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Host, HostInput, Identity, IdentityInput, OpenTermApi, SessionTarget } from '@shared/types'
import { suggest } from './complete'
import { figSpecs } from './figspecs'
import { Forwarding } from './forwarding'
import { importFile, isImportFile } from './importer'
import { generateKey, importKey, installKeyOnHost } from './keys'
import { Logs } from './logs'
import { Prompts } from './prompts'
import { listAgentKeys } from './ssh'
import { Sessions } from './sessions'
import { launch, localHome, localList, Sftp, splitCommand, type Opener } from './sftp'
import { loadShellHistory } from './shellHistory'
import { parseJump, parseSshConfig } from './sshconfig'
import { Store } from './store'

// Separate profile for development and tests.
if (process.env.OPENTERM_DATA_DIR) app.setPath('userData', process.env.OPENTERM_DATA_DIR)
if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
const send = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'OpenTerm Hub',
    backgroundColor: '#0f1115',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

function cleanHost(input: HostInput, store: Store): Omit<Host, 'id'> & { id?: string } {
  const port = Number(input.port)
  if (!input.hostname.trim()) throw new Error('Informe o endereço do host')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta inválida')
  const id = input.id
  const stored = id ? !!store.getSecret(`host:${id}:password`) : false
  return {
    id,
    label: input.label.trim() || input.hostname.trim(),
    group: input.group.trim(),
    hostname: input.hostname.trim(),
    port,
    username: input.username.trim(),
    protocol: input.protocol,
    os: input.os ?? (id ? store.host(id)?.os ?? null : null),
    hasPassword: input.password === undefined ? stored : input.password !== '',
    keyId: input.keyId || null,
    identityId: input.identityId && store.identity(input.identityId) ? input.identityId : null,
    useAgent: !!input.useAgent,
    agentForward: !!input.agentForward,
    jumpHostId: input.jumpHostId && input.jumpHostId !== id ? input.jumpHostId : null,
    startupSnippetId: input.startupSnippetId || null,
    tags: input.tags.map((t) => t.trim()).filter(Boolean)
  }
}

const openWith: Opener = async (file, command) => {
  if (!command.trim()) {
    const err = await shell.openPath(file)
    if (err) throw new Error(err)
    return
  }
  const [program, ...args] = splitCommand(command)
  await new Promise<void>((resolve, reject) => {
    // Windows editors are often .cmd shims (code.cmd), which need cmd.exe. cmd.exe does not
    // quote arguments, and the temp folder may contain spaces ("C:\Users\Ana Maria\...").
    const win = process.platform === 'win32'
    const child = spawn(program, [...args, win ? `"${file}"` : file], { detached: true, stdio: 'ignore', shell: win })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function cleanIdentity(input: IdentityInput, store: Store): Omit<Identity, 'id'> & { id?: string } {
  if (!input.username.trim()) throw new Error('Informe o usuário')
  const id = input.id
  const stored = id ? !!store.getSecret(`identity:${id}:password`) : false
  return {
    id,
    label: input.label.trim() || input.username.trim(),
    username: input.username.trim(),
    hasPassword: input.password === undefined ? stored : input.password !== '',
    keyId: input.keyId && store.key(input.keyId) ? input.keyId : null
  }
}

function importSshConfig(store: Store): number {
  let text: string
  try {
    text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    throw new Error('~/.ssh/config não encontrado')
  }
  const entries = parseSshConfig(text, homedir())
  const byAlias = new Map<string, string>()
  const findHost = (hostname: string, user: string, port: number): Host | undefined =>
    store.hosts().find((h) => h.hostname === hostname && h.username === user && h.port === port)
  const keyByFile = new Map<string, string | null>()
  const keyFor = (file: string | undefined): string | null => {
    if (!file) return null
    if (!keyByFile.has(file)) {
      try {
        keyByFile.set(file, importKey(store, { label: file.split('/').pop()!, privateKey: readFileSync(file, 'utf8') }).id)
      } catch {
        keyByFile.set(file, null) // encrypted or unreadable keys are skipped
      }
    }
    return keyByFile.get(file)!
  }

  let created = 0
  for (const e of entries) {
    const user = e.user ?? ''
    const port = e.port ?? 22
    const existing = findHost(e.hostname, user, port)
    if (existing) {
      byAlias.set(e.alias, existing.id)
      continue
    }
    const host = store.saveHost({
      label: e.alias,
      group: 'ssh config',
      hostname: e.hostname,
      port,
      username: user,
      protocol: 'ssh',
      hasPassword: false,
      keyId: keyFor(e.identityFile),
      identityId: null,
      useAgent: true,
      agentForward: false,
      jumpHostId: null,
      startupSnippetId: null,
      tags: []
    })
    byAlias.set(e.alias, host.id)
    created++
  }
  for (const e of entries) {
    if (!e.proxyJump) continue
    const id = byAlias.get(e.alias)
    const host = id && store.host(id)
    if (!host || host.jumpHostId) continue
    let jumpId = byAlias.get(e.proxyJump)
    if (!jumpId) {
      const j = parseJump(e.proxyJump)
      const jumpHost =
        findHost(j.host, j.user ?? '', j.port ?? 22) ??
        store.saveHost({
          label: e.proxyJump,
          group: 'ssh config',
          hostname: j.host,
          port: j.port ?? 22,
          username: j.user ?? '',
          protocol: 'ssh',
          hasPassword: false,
          keyId: null,
          identityId: null,
          useAgent: true,
          agentForward: false,
          jumpHostId: null,
          startupSnippetId: null,
          tags: []
        })
      jumpId = jumpHost.id
      byAlias.set(e.proxyJump, jumpId)
    }
    if (jumpId !== host.id) store.saveHost({ ...host, jumpHostId: jumpId })
  }
  return created
}

app.whenReady().then(() => {
  // macOS needs the app and edit menus for Cmd+Q and copy/paste in text fields.
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null
  )
  // Only what the UI uses; Electron grants every permission when no handler is set.
  const ALLOWED_PERMISSIONS = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

  const store = new Store()
  const prompts = new Prompts(send)
  const deps = { store, prompts }
  const logs = new Logs(join(app.getPath('userData'), 'logs'), () => send('logs:changed'))
  const sessions = new Sessions(deps, send, logs)
  const sftp = new Sftp(deps, send, openWith)
  const forwarding = new Forwarding(deps, send)
  const specs = figSpecs()
  store.onChange(() => send('snapshot:changed'))

  /** Program associated with the file's extension in Settings → SFTP ('' = system default). */
  const associatedCommand = (path: string): string => {
    const ext = path.split(/[\\/]/).pop()!.split('.').slice(1).pop()?.toLowerCase() ?? ''
    return store.settings().fileAssociations.find((a) => a.ext.replace(/^\./, '').toLowerCase() === ext)?.command ?? ''
  }

  // Local shell history (bash/zsh/fish) feeds the autocomplete when enabled.
  let shellHistory: string[] = []
  const reloadShellHistory = (): void => {
    if (!store.settings().importShellHistory) shellHistory = []
    else void loadShellHistory().then((h) => (shellHistory = h))
  }
  reloadShellHistory()

  type Handlers = { [K in keyof OpenTermApi]?: (...args: Parameters<OpenTermApi[K]>) => unknown }
  const handlers: Handlers = {
    getSnapshot: () => store.snapshot(),
    saveHost: (input) => {
      const host = store.saveHost(cleanHost(input, store))
      if (input.password !== undefined) store.setSecret(`host:${host.id}:password`, input.password)
      return host
    },
    deleteHost: (id) => store.deleteHost(id),
    saveGroup: (name, previousName, hostIds) => store.saveGroup(name, previousName, hostIds),
    deleteGroup: (name) => store.deleteGroup(name),
    saveIdentity: (input) => {
      const identity = store.saveIdentity(cleanIdentity(input, store))
      if (input.password !== undefined) store.setSecret(`identity:${identity.id}:password`, input.password)
      return identity
    },
    deleteIdentity: (id) => store.deleteIdentity(id),
    saveWorkspace: (input) => store.saveWorkspace(input),
    deleteWorkspace: (id) => store.deleteWorkspace(id),
    importSshConfig: () => importSshConfig(store),
    generateKey: (req) => generateKey(store, req),
    importKey: (req) => importKey(store, req),
    importKeyFile: async () => {
      const res = await dialog.showOpenDialog(win!, { defaultPath: join(homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] })
      return res.canceled ? null : readFileSync(res.filePaths[0], 'utf8')
    },
    exportPrivateKey: async (id) => {
      const key = store.key(id)
      const priv = store.getSecret(`key:${id}:private`)
      if (!key || !priv) throw new Error('Chave não encontrada')
      const res = await dialog.showSaveDialog(win!, { defaultPath: join(homedir(), '.ssh', key.label.replace(/[^\w.-]/g, '_')) })
      if (res.canceled || !res.filePath) return false
      writeFileSync(res.filePath, priv, { mode: 0o600 })
      writeFileSync(`${res.filePath}.pub`, key.publicKey + '\n', { mode: 0o644 })
      return true
    },
    deleteKey: (id) => store.deleteKey(id),
    installKeyOnHost: (keyId, hostId) => installKeyOnHost(deps, keyId, hostId),
    saveSnippet: (s) => {
      if (!s.script.trim()) throw new Error('O snippet está vazio')
      return store.saveSnippet({ ...s, label: s.label.trim() || s.script.split('\n')[0].slice(0, 40) })
    },
    deleteSnippet: (id) => store.deleteSnippet(id),
    saveForward: (r) => {
      const ports = r.kind === 'dynamic' ? [r.bindPort] : [r.bindPort, r.destPort]
      if (ports.some((p) => !Number.isInteger(p) || p < 0 || p > 65535)) throw new Error('Porta inválida')
      if (!store.host(r.hostId)) throw new Error('Escolha um host')
      return store.saveForward({ ...r, bindAddress: r.bindAddress.trim() || '127.0.0.1', destHost: r.destHost.trim() })
    },
    deleteForward: (id) => {
      forwarding.stop(id)
      store.deleteForward(id)
    },
    startForward: (id) => forwarding.start(id),
    stopForward: (id) => forwarding.stop(id),
    forwardStatuses: () => forwarding.list(),
    deleteKnownHost: (host, port) => store.deleteKnownHost(host, port),
    saveSettings: (s) => {
      const before = store.settings().importShellHistory
      const saved = store.saveSettings(s)
      if (saved.importShellHistory !== before) reloadShellHistory()
      return saved
    },
    exportBackup: async () => {
      const res = await dialog.showSaveDialog(win!, { defaultPath: 'openterm-hub-backup.json' })
      if (res.canceled || !res.filePath) return false
      writeFileSync(res.filePath, JSON.stringify(store.exportBackup(), null, 2))
      return true
    },
    importBackup: async () => {
      const res = await dialog.showOpenDialog(win!, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (res.canceled) return null
      const raw: unknown = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
      if (isImportFile(raw)) return store.batch(() => importFile(store, raw))
      store.importBackup(raw)
      return 'backup'
    },
    openSession: (target: SessionTarget, cols, rows) => sessions.open(target, cols, rows),
    writeSession: (id, data) => sessions.write(id, data),
    resizeSession: (id, cols, rows) => sessions.resize(id, cols, rows),
    closeSession: (id) => sessions.close(id),
    listSerialPorts: () => Sessions.serialPorts(),
    sftpOpen: (hostId) => sftp.open(hostId),
    sftpList: (id, path) => sftp.list(id, path),
    sftpMkdir: (id, path) => sftp.mkdir(id, path),
    sftpRename: (id, from, to) => sftp.rename(id, from, to),
    sftpDelete: (id, path) => sftp.delete(id, path),
    sftpUpload: (id, local, remoteDir, destName) => sftp.upload(id, local, remoteDir, destName),
    sftpDownload: (id, remote, localDir, destName) => sftp.download(id, remote, localDir, destName),
    sftpClose: (id) => sftp.close(id),
    localHome: () => localHome(),
    localList: (path) => localList(path),
    sftpOpenFile: (id, remotePath, command) => sftp.openFile(id, remotePath, command ?? associatedCommand(remotePath)),
    sftpChmod: (id, path, mode) => sftp.chmod(id, path, mode),
    sftpCopy: (fromId, fromPath, toId, toDir, destName) => sftp.copy(fromId, fromPath, toId, toDir, destName),
    localCopy: (fromPath, toDir, destName) => {
      const name = destName ?? fromPath.split(/[\\/]/).pop()!
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Nome de destino inválido')
      return fsp.cp(fromPath, join(toDir, name), { recursive: true, errorOnExist: false, force: true })
    },
    localOpen: (path, command) => launch(openWith(path, command ?? associatedCommand(path))),
    localMkdir: (path) => fsp.mkdir(path),
    localRename: (from, to) => fsp.rename(from, to),
    localDelete: (path) => shell.trashItem(path),
    localChmod: (path, mode) => fsp.chmod(path, mode & 0o7777),
    pickProgram: async () => {
      const res = await dialog.showOpenDialog(win!, { properties: ['openFile'] })
      return res.canceled ? null : res.filePaths[0]
    },
    listLogs: () => logs.list(),
    readLog: (id) => logs.read(id),
    deleteLog: (id) => logs.delete(id),
    clearLogs: () => logs.clear(),
    listAgentKeys: () => listAgentKeys(),
    // App history goes last so it ranks above the imported shell history.
    suggest: (line) => suggest(line, specs, [...shellHistory, ...store.history()], store.snippets()),
    recordHistory: (line) => store.recordHistory(line),
    answerHostKey: (promptId, accept) => prompts.answer(promptId, accept),
    answerCredential: (promptId, values) => prompts.answer(promptId, values),
    openExternal: (url) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  }

  const trusted = (e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => !!win && e.sender === win.webContents
  for (const [name, fn] of Object.entries(handlers) as Array<[string, (...a: unknown[]) => unknown]>) {
    ipcMain.handle(`api:${name}`, (e, ...args) => {
      if (!trusted(e)) throw new Error('Origem não autorizada')
      return fn(...args)
    })
    ipcMain.on(`api:${name}`, (e, ...args) => {
      if (trusted(e)) void Promise.resolve(fn(...args)).catch(() => {})
    })
  }

  app.on('before-quit', () => {
    sessions.closeAll()
    sftp.closeAll()
    forwarding.stopAll()
  })

  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
