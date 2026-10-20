import { randomUUID } from 'node:crypto'
import type { CredentialPrompt, HostKeyPrompt } from '@shared/types'

type Send = (channel: string, payload: unknown) => void

/**
 * Questions the main process needs the user to answer (unknown host keys,
 * passwords, keyboard-interactive challenges). Each one is sent to the
 * renderer and resolved when the matching answer comes back over IPC.
 * Aborting the signal (the connection died) withdraws the question from the
 * UI, so a stale dialog can never be answered.
 */
export class Prompts {
  private pending = new Map<string, (answer: unknown) => void>()

  constructor(private send: Send) {}

  private ask<T>(channel: string, payload: object, fallback: T, signal?: AbortSignal): Promise<T> {
    const promptId = randomUUID()
    return new Promise<T>((resolve) => {
      if (signal?.aborted) return resolve(fallback)
      const onAbort = (): void => {
        if (!this.pending.delete(promptId)) return
        this.send('prompt:cancel', promptId)
        resolve(fallback)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(promptId, (answer) => {
        signal?.removeEventListener('abort', onAbort)
        resolve((answer ?? fallback) as T)
      })
      this.send(channel, { ...payload, promptId })
    })
  }

  hostKey(p: Omit<HostKeyPrompt, 'promptId'>, signal?: AbortSignal): Promise<boolean> {
    return this.ask('prompt:hostKey', p, false, signal)
  }

  credentials(p: Omit<CredentialPrompt, 'promptId'>, signal?: AbortSignal): Promise<string[] | null> {
    return this.ask<string[] | null>('prompt:credential', p, null, signal)
  }

  /** Information that needs no answer. */
  notice(text: string): void {
    this.send('notice', text)
  }

  answer(promptId: string, value: unknown): void {
    const resolve = this.pending.get(promptId)
    if (!resolve) return
    this.pending.delete(promptId)
    resolve(value)
  }
}
