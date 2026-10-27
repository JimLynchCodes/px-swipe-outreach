import { RotateCcw } from 'lucide-react'
import App from './App'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import { LoginPage } from './auth/LoginPage'
import type { AuthConfig } from './auth/supabase'

function Gate() {
  const auth = useAuth()
  if (auth.status === 'error') {
    return (
      <div className="state full" role="alert">
        <h2>Can't start</h2><p>{auth.error}</p>
        {auth.mode === 'supabase' && <button className="btn-secondary" onClick={() => void auth.signOut()}>Sign out</button>}
        {auth.mode !== 'misconfigured' && <button className="btn-secondary" onClick={() => window.location.reload()}><RotateCcw size={16} /> Retry</button>}
      </div>
    )
  }
  if (auth.status === 'signedOut' && auth.client) return <LoginPage client={auth.client} />
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
  return <App key={auth.orgId} />
}

export default function Root({ config }: { config: AuthConfig }) {
  return <AuthProvider config={config}><Gate /></AuthProvider>
}
