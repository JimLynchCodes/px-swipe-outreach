import { LogOut, Sparkles } from 'lucide-react'
import { useOptionalAuth } from '../auth/AuthProvider'

export function Header() {
  const auth = useOptionalAuth()
  const orgs = auth?.memberships ?? []
  return (
    <header className="header">
      <div className="brand">
        <img src="/flame.svg" alt="" className="brand-logo" width={36} height={36} />
        <div>
          <h1>Outreach</h1>
          <p>Turn past customers into future sales</p>
        </div>
      </div>
      <div className="header-right">
        <span className="pill"><Sparkles size={14} aria-hidden /> AI Powered</span>
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
