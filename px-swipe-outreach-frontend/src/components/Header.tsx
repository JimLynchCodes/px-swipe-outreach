import { useEffect, useRef, useState } from 'react'
import { Ban, Layers, LogOut, Menu, MessageCircle, Receipt, Settings, Sparkles, TrendingUp, Users, X } from 'lucide-react'
import { navigate, ROUTES, usePathname } from '../router'
import { useOptionalAuth } from '../auth/AuthProvider'
import { useUnreadCount } from '../replies/useUnread'
import { PineappleLogo } from './PineappleLogo'
import { ModelPicker } from '../ai/ModelPicker'

const LINKS = [
  { to: ROUTES.home, label: 'Outreach deck', icon: Layers },
  { to: ROUTES.replies, label: 'Replies', icon: MessageCircle, badge: true },
  { to: ROUTES.performance, label: 'Performance metrics', icon: TrendingUp },
  { to: ROUTES.optOuts, label: 'Opt-out list', icon: Ban },
  { to: ROUTES.team, label: 'Team', icon: Users },
  { to: ROUTES.settings, label: 'Settings', icon: Settings },
  { to: ROUTES.costs, label: 'Cost metrics', icon: Receipt, sub: true, manage: true },
] as const

export function Header() {
  const auth = useOptionalAuth()
  const orgs = auth?.memberships ?? []
  const path = usePathname()
  const [open, setOpen] = useState(false)
  const unread = useUnreadCount(Boolean(auth?.orgId))
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick) }
  }, [open])

  const badge = unread > 99 ? '99+' : String(unread)
  return (
    <header className="header">
      <div className="brand">
        {auth?.orgId && (
          <div className="menu-wrap" ref={menuRef}>
            <button className="icon-btn hamburger" aria-label={unread ? `Menu, ${unread} unread replies` : 'Menu'} aria-expanded={open}
              aria-haspopup="menu" onClick={() => setOpen(o => !o)}>
              {open ? <X size={20} /> : <Menu size={20} />}
              {unread > 0 && <span className="badge" aria-hidden>{badge}</span>}
            </button>
            {open && (
              <nav className="menu" role="menu" aria-label="Main menu">
                {LINKS.filter(l => !('manage' in l) || auth?.role === 'owner' || auth?.role === 'admin').map(l => (
                  <a key={l.to} role="menuitem" href={l.to}
                    className={[path === l.to || (l.to !== '/' && path.startsWith(l.to) && !(l.to === ROUTES.settings && path === ROUTES.costs)) ? 'active' : '', 'sub' in l ? 'sub' : ''].join(' ').trim()}
                    onClick={e => { e.preventDefault(); setOpen(false); navigate(l.to) }}>
                    <l.icon size={17} aria-hidden /> <span>{l.label}</span>
                    {'badge' in l && unread > 0 && <span className="badge inline" aria-label={`${unread} unread`}>{badge}</span>}
                  </a>
                ))}
              </nav>
            )}
          </div>
        )}
        <PineappleLogo size={36} />
        <div>
          <h1>Outreach</h1>
          <p>Turn past customers into future sales</p>
        </div>
      </div>
      <div className="header-right">
        {auth?.orgId ? <ModelPicker /> : <span className="pill"><Sparkles size={14} aria-hidden /> AI suggestions</span>}
        {auth && orgs.length > 1 && (
          <select aria-label="Organization" className="org-select" value={auth.orgId ?? ''} onChange={e => auth.setOrgId(e.target.value)}>
            {orgs.map(m => <option key={m.orgId} value={m.orgId}>{m.orgName}</option>)}
          </select>
        )}
        {auth?.mode === 'supabase' && (
          <button className="icon-btn" onClick={() => void auth.signOut()} aria-label="Sign out" title={auth.email ?? 'Sign out'}>
            <LogOut size={18} />
          </button>
        )}
      </div>
    </header>
  )
}
