import { useOptionalAuth } from '../auth/AuthProvider'
import { navigate, ROUTES } from '../router'

/** General | Cost metrics (cost metrics are owner/admin only, so staff get no tab bar). */
export function SettingsTabs({ current }: { current: 'general' | 'costs' }) {
  const auth = useOptionalAuth()
  if (auth?.role !== 'owner' && auth?.role !== 'admin') return null
  const tabs = [{ id: 'general', label: 'General', to: ROUTES.settings }, { id: 'costs', label: 'Cost metrics', to: ROUTES.costs }] as const
  return (
    <nav className="tabs" aria-label="Settings sections">
      {tabs.map(t => (
        <a key={t.id} href={t.to} aria-current={current === t.id ? 'page' : undefined} className={current === t.id ? 'active' : ''}
          onClick={e => { e.preventDefault(); navigate(t.to) }}>{t.label}</a>
      ))}
    </nav>
  )
}
