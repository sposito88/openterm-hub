import type { OpenTermApi } from '@shared/types'

export const api = (window as unknown as { openterm: OpenTermApi }).openterm

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Errors thrown in the main process arrive wrapped by Electron's IPC layer.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
