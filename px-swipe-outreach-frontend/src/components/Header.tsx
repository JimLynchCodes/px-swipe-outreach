import { Sparkles } from 'lucide-react'

export function Header() {
  return (
    <header className="header">
      <div className="brand">
        <img src="/flame.svg" alt="" className="brand-logo" width={36} height={36} />
        <div>
          <h1>Outreach</h1>
          <p>Turn past customers into future sales</p>
        </div>
      </div>
      <span className="pill"><Sparkles size={14} aria-hidden /> AI Powered</span>
    </header>
  )
}
