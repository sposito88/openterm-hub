import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { OpenTermApi } from '@shared/types'

/** Request/response calls. */
const invoke = [
  'getSnapshot', 'appVersion', 'getHostPassword', 'getIdentityPassword', 'saveHost', 'deleteHost', 'saveGroup', 'deleteGroup', 'saveIdentity', 'deleteIdentity', 'saveWorkspace', 'deleteWorkspace', 'importSshConfig',
  'generateKey', 'importKey', 'importKeyFile', 'exportPrivateKey', 'deleteKey', 'installKeyOnHost',
  'saveSnippet', 'deleteSnippet',
  'saveForward', 'deleteForward', 'startForward', 'stopForward', 'forwardStatuses',
  'deleteKnownHost', 'saveSettings', 'exportBackup', 'importBackup',
  'openSession', 'listSerialPorts',
  'sftpOpen', 'sftpList', 'sftpMkdir', 'sftpRename', 'sftpDelete', 'sftpUpload', 'sftpDownload', 'sftpCancel',
  'localHome', 'localList', 'suggest',
  'listLogs', 'readLog', 'deleteLog', 'clearLogs', 'sftpOpenFile', 'sftpChmod',
  'localOpen', 'localMkdir', 'localRename', 'localDelete', 'localChmod', 'pickProgram', 'listAgentKeys',
  'sftpCopy', 'localCopy', 'runSnippet', 'syncStatus', 'enableSync', 'disableSync', 'syncNow', 'pickFolder'
] as const

/** Fire-and-forget calls (hot paths such as keystrokes). */
const fire = [
  'writeSession', 'resizeSession', 'closeSession', 'sftpClose',
  'recordHistory', 'answerHostKey', 'answerCredential', 'openExternal',
  'touchHost'
] as const

function on(channel: string) {
  return (cb: (...args: never[]) => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => (cb as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: Record<string, unknown> = {
  onSessionData: on('session:data'),
  onSessionExit: on('session:exit'),
  onHostKeyPrompt: on('prompt:hostKey'),
  onCredentialPrompt: on('prompt:credential'),
  onPromptCancel: on('prompt:cancel'),
  onNotice: on('notice'),
  onTransferProgress: on('sftp:progress'),
  onForwardStatus: on('forward:status'),
  onSnapshotChanged: on('snapshot:changed'),
  onLogsChanged: on('logs:changed'),
  onSftpSynced: on('sftp:synced'),
  onSyncStatus: on('sync:status')
}
// Files dropped from the OS file manager: their path is only readable here.
api.pathForFile = (file: File) => webUtils.getPathForFile(file)
for (const name of invoke) api[name] = (...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args)
for (const name of fire) api[name] = (...args: unknown[]) => ipcRenderer.send(`api:${name}`, ...args)

contextBridge.exposeInMainWorld('openterm', api as unknown as OpenTermApi)
