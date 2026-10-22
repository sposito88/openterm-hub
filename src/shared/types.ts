export type Protocol = 'ssh' | 'mosh' | 'telnet'

export type OsId =
  | 'ubuntu'
  | 'debian'
  | 'redhat'
  | 'rocky'
  | 'alma'
  | 'centos'
  | 'fedora'
  | 'alpine'
  | 'amazon'
  | 'arch'
  | 'suse'
  | 'raspbian'
  | 'freebsd'
  | 'openbsd'
  | 'netbsd'
  | 'gentoo'
  | 'mageia'
  | 'linux'
  | 'windows'
  | 'macos'
  | 'apple'
  | 'routeros'
  | 'cisco'

export interface Host {
  id: string
  label: string
  group: string
  hostname: string
  port: number
  username: string
  protocol: Protocol
  /** Operating system icon identifier (detected automatically on SSH connect or chosen manually). */
  os?: OsId | null
  /** Optional terminal theme override for this host (e.g. for PRD vs HML visual distinction). */
  theme?: string | null
  /** Saved password, stored encrypted on disk. Never sent back to the renderer. */
  hasPassword: boolean
  keyId: string | null
  /** Reusable login: when set, its username, password and key replace the host's own. */
  identityId: string | null
  useAgent: boolean
  agentForward: boolean
  jumpHostId: string | null
  startupSnippetId: string | null
  tags: string[]
}

export interface HostInput extends Omit<Host, 'id' | 'hasPassword'> {
  id?: string
  /** undefined = keep the stored password, '' = remove it */
  password?: string
}

/** A login (username + password and/or key) shared by many hosts. */
export interface Identity {
  id: string
  label: string
  username: string
  /** The password is stored encrypted and never sent to the renderer. */
  hasPassword: boolean
  keyId: string | null
}

export interface IdentityInput extends Omit<Identity, 'id' | 'hasPassword'> {
  id?: string
  /** undefined = keep the stored password, '' = remove it */
  password?: string
}

export interface SshKey {
  id: string
  label: string
  type: string
  publicKey: string
  fingerprint: string
  hasPassphrase: boolean
}

export interface Snippet {
  id: string
  label: string
  script: string
}

export type ForwardKind = 'local' | 'remote' | 'dynamic'

export interface ForwardRule {
  id: string
  label: string
  hostId: string
  kind: ForwardKind
  bindAddress: string
  bindPort: number
  /** Unused for dynamic (SOCKS5) forwarding. */
  destHost: string
  destPort: number
}

export interface KnownHost {
  host: string
  port: number
  keyType: string
  fingerprint: string
  addedAt: string
}

/** Double-click word separators: xterm.js default and the PuTTY style. */
export const WORD_SEPARATORS = {
  default: ' ()[]{}\',"`',
  putty: ' ()[]{}\',"`@:=;|<>'
} as const

export const TERM_TYPES = ['xterm-256color', 'xterm', 'xterm-color', 'screen-256color', 'tmux-256color', 'vt220', 'vt100', 'linux'] as const

export interface FileAssociation {
  /** Extension without the dot, lower case (e.g. "json"). */
  ext: string
  /** Program and arguments; the file path is appended. Empty = system default app. */
  command: string
}

export interface Settings {
  language: 'pt' | 'en'
  theme: 'dark' | 'light' | 'system'
  terminalTheme: string
  /** A family name (bundled or installed) or, with commas, a raw CSS font stack. */
  fontFamily: string
  fontSize: number
  /** Characters that end a word when double-clicking to select (PuTTY also splits on @ and :). */
  wordSeparator: string
  cursorStyle: 'block' | 'bar' | 'underline'
  scrollback: number
  keepaliveSeconds: number
  termType: (typeof TERM_TYPES)[number]
  autocomplete: boolean
  autoReconnect: boolean
  importShellHistory: boolean
  /** Select text to copy and right click to paste. */
  copyOnSelect: boolean
  bellSound: boolean
  boldBright: boolean
  sessionLogging: boolean
  sftpShowHidden: boolean
  fileAssociations: FileAssociation[]
  /** Action id → key combination ("Ctrl+Shift+W"); '' disables the shortcut. */
  shortcuts: Record<string, string>
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'pt',
  theme: 'dark',
  terminalTheme: 'auto',
  fontFamily: 'JetBrains Mono',
  fontSize: 14,
  wordSeparator: WORD_SEPARATORS.default,
  cursorStyle: 'block',
  scrollback: 10000,
  keepaliveSeconds: 30,
  termType: 'xterm-256color',
  autocomplete: true,
  autoReconnect: true,
  importShellHistory: true,
  copyOnSelect: true,
  bellSound: false,
  boldBright: false,
  sessionLogging: false,
  sftpShowHidden: true,
  fileAssociations: [],
  shortcuts: {}
}

export interface LogEntry {
  id: string
  title: string
  /** user@host:port, local shell or serial device. */
  target: string
  protocol: string
  startedAt: string
  endedAt?: string
  /** Why the session ended, or the connection error. */
  result?: string
  ok: boolean
  hasTranscript: boolean
}

export interface WorkspacePane {
  id: string
  target: SessionTarget
  title?: string
}

export interface Workspace {
  id: string
  label: string
  layout: 'horizontal' | 'vertical'
  panes: WorkspacePane[]
}

export interface Snapshot {
  hosts: Host[]
  groups: string[]
  identities: Identity[]
  workspaces: Workspace[]
  keys: SshKey[]
  snippets: Snippet[]
  forwards: ForwardRule[]
  knownHosts: KnownHost[]
  settings: Settings
  secureStorage: boolean
}

export type SessionTarget =
  | { kind: 'host'; hostId: string }
  | { kind: 'local' }
  | { kind: 'serial'; path: string; baudRate: number }

export interface SessionInfo {
  id: string
  title: string
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number
  mode: number
}

export interface TransferProgress {
  transferId: string
  name: string
  /** copy = between two servers, streamed through this computer without a temp file. */
  direction: 'upload' | 'download' | 'copy'
  transferred: number
  total: number
  done: boolean
  error?: string
}

export interface ForwardStatus {
  ruleId: string
  state: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
}

export interface HostKeyPrompt {
  promptId: string
  host: string
  port: number
  keyType: string
  fingerprint: string
  /** Fingerprint previously stored for this host, when the key changed. */
  previous?: string
}

/** A key loaded in the system ssh-agent. */
export interface AgentKey {
  type: string
  comment: string
  fingerprint: string
  /** FIDO2 security key (sk-*): signing needs a touch on the device. */
  securityKey: boolean
}

export interface ImportSummary {
  hosts: number
  identities: number
  /** Existing hosts linked to an identity from the file instead of being duplicated. */
  linked: number
  keys: number
  snippets: number
  knownHosts: number
  skipped: number
  errors: string[]
}

export interface CredentialPrompt {
  promptId: string
  title: string
  instructions?: string
  fields: { label: string; secret: boolean }[]
}

export interface Suggestion {
  /** Text inserted in place of the token being typed. */
  insert: string
  /** Characters to delete before inserting (length of the partial token). */
  replaceLength: number
  label: string
  description?: string
  source: 'history' | 'snippet' | 'command' | 'subcommand' | 'option'
}

export interface GeneratedKeyRequest {
  label: string
  type: 'ed25519' | 'rsa' | 'ecdsa'
  bits?: number
  passphrase?: string
}

export interface ImportKeyRequest {
  label: string
  privateKey: string
  passphrase?: string
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
}

export interface OpenTermApi {
  getSnapshot(): Promise<Snapshot>
  saveHost(host: HostInput): Promise<Host>
  deleteHost(id: string): Promise<void>
  saveGroup(name: string, previousName?: string, hostIds?: string[]): Promise<void>
  deleteGroup(name: string): Promise<void>
  saveIdentity(identity: IdentityInput): Promise<Identity>
  /** Hosts that used it keep working with the identity's username copied in. */
  deleteIdentity(id: string): Promise<void>
  saveWorkspace(workspace: Omit<Workspace, 'id'> & { id?: string }): Promise<Workspace>
  deleteWorkspace(id: string): Promise<void>
  importSshConfig(): Promise<number>
  generateKey(req: GeneratedKeyRequest): Promise<SshKey>
  importKey(req: ImportKeyRequest): Promise<SshKey>
  importKeyFile(): Promise<string | null>
  exportPrivateKey(id: string): Promise<boolean>
  deleteKey(id: string): Promise<void>
  installKeyOnHost(keyId: string, hostId: string): Promise<void>
  saveSnippet(s: Omit<Snippet, 'id'> & { id?: string }): Promise<Snippet>
  deleteSnippet(id: string): Promise<void>
  saveForward(r: Omit<ForwardRule, 'id'> & { id?: string }): Promise<ForwardRule>
  deleteForward(id: string): Promise<void>
  startForward(id: string): Promise<void>
  stopForward(id: string): Promise<void>
  forwardStatuses(): Promise<ForwardStatus[]>
  deleteKnownHost(host: string, port: number): Promise<void>
  saveSettings(s: Partial<Settings>): Promise<Settings>
  exportBackup(): Promise<boolean>
  /** A backup ('backup') or a migration file with secrets (summary); null when cancelled. */
  importBackup(): Promise<ImportSummary | 'backup' | null>

  openSession(target: SessionTarget, cols: number, rows: number): Promise<SessionInfo>
  writeSession(id: string, data: string): void
  resizeSession(id: string, cols: number, rows: number): void
  closeSession(id: string): void
  listSerialPorts(): Promise<SerialPortInfo[]>

  sftpOpen(hostId: string): Promise<{ sftpId: string; home: string }>
  sftpList(sftpId: string, path: string): Promise<FileEntry[]>
  sftpMkdir(sftpId: string, path: string): Promise<void>
  sftpRename(sftpId: string, from: string, to: string): Promise<void>
  sftpDelete(sftpId: string, path: string): Promise<void>
  /** destName: name in the destination folder (default: the source's name). */
  sftpUpload(sftpId: string, localPath: string, remoteDir: string, destName?: string): Promise<string>
  sftpDownload(sftpId: string, remotePath: string, localDir: string, destName?: string): Promise<string>
  sftpClose(sftpId: string): void
  localHome(): Promise<string>
  localList(path: string): Promise<FileEntry[]>

  listLogs(): Promise<LogEntry[]>
  readLog(id: string): Promise<string>
  deleteLog(id: string): Promise<void>
  clearLogs(): Promise<void>
  /** command: program to open with; omitted = the file association or the system default. */
  sftpOpenFile(sftpId: string, remotePath: string, command?: string): Promise<void>
  sftpChmod(sftpId: string, path: string, mode: number): Promise<void>
  /** Server to server copy (recursive); returns a transfer id like uploads. */
  sftpCopy(fromSftpId: string, fromPath: string, toSftpId: string, toDir: string, destName?: string): Promise<string>
  /** Local to local copy (recursive). */
  localCopy(fromPath: string, toDir: string, destName?: string): Promise<void>
  localOpen(path: string, command?: string): Promise<void>
  localMkdir(path: string): Promise<void>
  localRename(from: string, to: string): Promise<void>
  /** Moves to the system trash. */
  localDelete(path: string): Promise<void>
  localChmod(path: string, mode: number): Promise<void>
  /** Local path of a file dropped from the OS file manager. */
  pathForFile(file: File): string
  /** File picker for "Open with…"; returns the program path. */
  pickProgram(): Promise<string | null>

  /** Keys in the system ssh-agent; empty when no agent is running. */
  listAgentKeys(): Promise<AgentKey[]>

  suggest(line: string): Promise<Suggestion[]>
  recordHistory(line: string): void

  answerHostKey(promptId: string, accept: boolean): void
  answerCredential(promptId: string, values: string[] | null): void
  openExternal(url: string): void

  onSessionData(cb: (id: string, data: string) => void): () => void
  onSessionExit(cb: (id: string, reason: string) => void): () => void
  onHostKeyPrompt(cb: (p: HostKeyPrompt) => void): () => void
  onCredentialPrompt(cb: (p: CredentialPrompt) => void): () => void
  /** Short information for the user, e.g. "touch your security key". */
  onNotice(cb: (text: string) => void): () => void
  onPromptCancel(cb: (promptId: string) => void): () => void
  onTransferProgress(cb: (p: TransferProgress) => void): () => void
  onForwardStatus(cb: (s: ForwardStatus) => void): () => void
  onSnapshotChanged(cb: () => void): () => void
  onLogsChanged(cb: () => void): () => void
  /** A remote file opened with "Open with" was saved and uploaded again. */
  onSftpSynced(cb: (name: string, error?: string) => void): () => void
}
