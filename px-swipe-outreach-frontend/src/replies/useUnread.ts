import { useEffect, useState } from 'react'
import { api } from '../api'

export const POLL_MS = 15_000
export const REPLIES_CHANGED = 'replies:changed'
/** Tell badges to refresh now (e.g. after opening a thread). */
export const notifyRepliesChanged = () => window.dispatchEvent(new Event(REPLIES_CHANGED))

/** Polls the unread-conversation count every 15 s while the tab is visible. */
export function useUnreadCount(enabled = true): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () => {
      if (document.visibilityState === 'hidden') return
      api.replies.unread().then(n => { if (alive) setCount(n) }, () => {})
    }
    load()
    const t = setInterval(load, POLL_MS)
    window.addEventListener(REPLIES_CHANGED, load)
    document.addEventListener('visibilitychange', load)
    return () => { alive = false; clearInterval(t); window.removeEventListener(REPLIES_CHANGED, load); document.removeEventListener('visibilitychange', load) }
  }, [enabled])
  return count
}
