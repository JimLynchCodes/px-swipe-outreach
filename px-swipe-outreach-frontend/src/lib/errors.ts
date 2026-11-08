import { useCallback, useRef, useState } from 'react'
import { ApiError } from '../api'

export const NETWORK_MESSAGE = "Can't reach the server. Check your connection and try again."
export const SERVER_MESSAGE = 'Something went wrong on our end. Please try again in a moment.'
const GENERIC = /^Request failed \(\d+\)$/

/** Human message for a failed API call: the server's message when it sent one, friendly fallbacks otherwise. */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return NETWORK_MESSAGE
    if (e.status >= 500 && (GENERIC.test(e.message) || !e.message)) return SERVER_MESSAGE
    if (e.status === 429 && GENERIC.test(e.message)) return 'Too many requests. Wait a moment and try again.'
    if (e.status === 403 && GENERIC.test(e.message)) return "You don't have permission to do that."
    return e.message || SERVER_MESSAGE
  }
  if (e instanceof TypeError) return NETWORK_MESSAGE // fetch network failure
  if (e instanceof Error && e.message) return e.message
  return SERVER_MESSAGE
}

/**
 * Wraps one API-calling action: `run` clears the previous error, tracks busy, and stores a friendly error on failure
 * (rendered with <ErrorBubble error={action.error} /> right under the button). Resolves to the result, or undefined on error.
 */
export function useApiAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setError(null); setBusy(true)
    try { return await fnRef.current(...args) } catch (e) { setError(friendlyError(e)); return undefined } finally { setBusy(false) }
  }, [])
  const clear = useCallback(() => setError(null), [])
  return { run, error, busy, clear, setError }
}
