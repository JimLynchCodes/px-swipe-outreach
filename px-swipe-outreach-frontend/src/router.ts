import { useEffect, useState } from 'react'

/** Minimal pathname router (the app has three screens; no dependency needed). */
const EVENT = 'app:navigate'

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(EVENT))
}

export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    window.addEventListener('popstate', update)
    window.addEventListener(EVENT, update)
    return () => { window.removeEventListener('popstate', update); window.removeEventListener(EVENT, update) }
  }, [])
  return path
}

export const ROUTES = { home: '/', team: '/team', acceptInvite: '/invite/accept' } as const
