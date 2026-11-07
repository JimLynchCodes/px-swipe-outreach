import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { navigate, ROUTES } from '../router'
import { Header } from './Header'

export function PageShell({ title, subtitle, children, back = ROUTES.home, backLabel = 'Back to outreach', wide }: {
  title: string; subtitle?: ReactNode; children: ReactNode; back?: string; backLabel?: string; wide?: boolean
}) {
  return (
    <div className={`app ${wide ? 'wide' : ''}`}>
      <Header />
      <a className="back-link" href={back} onClick={e => { e.preventDefault(); navigate(back) }}>
        <ArrowLeft size={16} /> {backLabel}
      </a>
      <div className="page-title"><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>
      {children}
    </div>
  )
}
