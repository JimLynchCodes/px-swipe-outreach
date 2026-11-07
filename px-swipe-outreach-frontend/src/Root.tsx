import { RotateCcw } from 'lucide-react'
import App from './App'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import { LoginPage } from './auth/LoginPage'
import type { AuthConfig } from './auth/supabase'
import { useEffect } from 'react'
import { navigate, ROUTES, usePathname } from './router'
import { AcceptInvitePage } from './team/AcceptInvitePage'
import { TeamPage } from './team/TeamPage'
import { SettingsPage } from './settings/SettingsPage'
import { OptOutsPage } from './settings/OptOutsPage'
import { RepliesPage } from './replies/RepliesPage'
import { CostMetricsPage } from './metrics/CostMetricsPage'
import { DataSyncPage } from './sync/DataSyncPage'
import { RegisteredUsersPage } from './customers/RegisteredUsersPage'
import { PerformancePage } from './metrics/PerformancePage'

function Gate() {
  const auth = useAuth()
  const path = usePathname()
  if (auth.status === 'error') {
    return (
      <div className="state full" role="alert">
        <h2>Can't start</h2><p>{auth.error}</p>
        {auth.mode === 'supabase' && <button className="btn-secondary" onClick={() => void auth.signOut()}>Sign out</button>}
        {auth.mode !== 'misconfigured' && <button className="btn-secondary" onClick={() => window.location.reload()}><RotateCcw size={16} /> Retry</button>}
      </div>
    )
  }
  // The invite page handles signed-out and no-org users itself (that's who it's for).
  if (path === ROUTES.acceptInvite) return <AcceptInvitePage />
  if (auth.status === 'signedOut' && auth.client) return <LoginPage client={auth.client} />
  if (auth.status === 'notApproved') {
    return (
      <div className="state full" role="alert">
        <p>{auth.error}</p>
        <button className="btn-secondary" onClick={() => void auth.signOut()}>Sign out</button>
      </div>
    )
  }
  if (auth.status !== 'signedIn') return <div className="state full">Loading…</div>
  if (!auth.orgId) {
    return (
      <div className="state full">
        <h2>No store access yet</h2>
        <p className="muted">{auth.email ?? 'Your account'} isn't a member of any organization. Ask an owner to invite you.</p>
        <button className="btn-secondary" onClick={() => void auth.signOut()}>Sign out</button>
      </div>
    )
  }
  if (path === ROUTES.legacyCosts) return <Redirect to={ROUTES.costs} />
  if (path === ROUTES.team) return <TeamPage key={auth.orgId} />
  if (path === ROUTES.costs) return <CostMetricsPage key={auth.orgId} />
  if (path === ROUTES.performance) return <PerformancePage key={auth.orgId} />
  if (path === ROUTES.customers) return <RegisteredUsersPage key={auth.orgId} />
  if (path === ROUTES.dataSync) return <DataSyncPage key={auth.orgId} />
  if (path === ROUTES.settings) return <SettingsPage key={auth.orgId} />
  if (path === ROUTES.optOuts) return <OptOutsPage key={auth.orgId} />
  if (path === ROUTES.replies || path.startsWith(`${ROUTES.replies}/`)) return <RepliesPage key={auth.orgId} />
  return <App key={auth.orgId} />
}

export default function Root({ config }: { config: AuthConfig }) {
  return <AuthProvider config={config}><Gate /></AuthProvider>
}

/** Replaces the current history entry (old bookmarks keep working, Back skips the old URL). */
function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }) }, [to])
  return null
}
