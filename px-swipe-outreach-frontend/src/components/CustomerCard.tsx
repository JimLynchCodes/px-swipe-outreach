import {
  CalendarDays, ChevronRight, CircleDollarSign, Mail, MapPin, MessageCircle, MessageSquareText,
  Pencil, Phone, ShoppingBag, Sparkles, Store, User, Check,
} from 'lucide-react'
import type { Channel, OutreachCard, Suggestion } from '../types'
import { charCount, daysAgo, money } from '../lib/format'

export interface CardDraft {
  channel: Channel
  suggestion: Suggestion | null
  loading: boolean
  error: string | null
  message: string
  subject: string
  editing: boolean
}

interface Props {
  card: OutreachCard
  position: number
  total: number
  draft: CardDraft
  onChannel: (c: Channel) => void
  onMessage: (m: string) => void
  onSubject: (s: string) => void
  onToggleEdit: () => void
  onRetry: () => void
}

export function CustomerCard({ card, position, total, draft, onChannel, onMessage, onSubject, onToggleEdit, onRetry }: Props) {
  const { customer: c, lastPurchase: lp } = card
  const { contact } = c
  const channelOk = draft.channel === 'sms' ? contact.sms : contact.email

  return (
    <article className="card" aria-label={`Outreach for ${c.displayName}`}>
      <span className="counter">{position} / {total}</span>
      <h2 className="name">{c.displayName}{c.age != null && <span className="age">Age {c.age}</span>}</h2>
      <ul className="facts">
        {c.gender && <li><User size={16} aria-hidden />{c.gender}</li>}
        {c.location && <li><MapPin size={16} aria-hidden />{c.location}</li>}
        {c.storesShopped.length > 0 && <li><Store size={16} aria-hidden />Shops at: {c.storesShopped.join(', ')}</li>}
      </ul>

      <div className="stats">
        <Stat icon={<CircleDollarSign size={18} />} label="Lifetime Spend" value={money(c.lifetimeSpendCents)} />
        <Stat icon={<CalendarDays size={18} />} label="Last Purchase" value={daysAgo(c.daysSinceLastPurchase)} />
        <Stat icon={<ShoppingBag size={18} />} label="Items Purchased" value={`${c.itemsPurchased} total`} />
      </div>

      {lp && (
        <section>
          <h3 className="eyebrow">Last purchased</h3>
          <div className="purchase">
            <div className="thumb">
              {lp.imageUrl ? <img src={lp.imageUrl} alt={lp.name} /> : <ShoppingBag size={34} aria-label={lp.name} />}
            </div>
            <div className="purchase-body">
              <strong>{lp.name}</strong>
              <span className="muted">{money(lp.priceCents)} · {daysAgo(lp.daysAgo)}</span>
              {lp.alsoPurchased.length > 0 && <span className="muted small">Also purchased: {lp.alsoPurchased.join(', ')}</span>}
            </div>
            <ChevronRight size={18} className="muted" aria-hidden />
          </div>
        </section>
      )}

      <section className="ai" aria-live="polite">
        <h3 className="eyebrow green"><Sparkles size={14} aria-hidden /> AI Suggestion</h3>
        {draft.loading && !draft.suggestion && <p className="skeleton">Thinking up the best offer…</p>}
        {draft.error && <p className="error">{draft.error} <button className="link" onClick={onRetry}>Retry</button></p>}
        {draft.suggestion && (
          <>
            <h4>{draft.suggestion.title}</h4>
            <p>{draft.suggestion.reasoning}</p>
          </>
        )}
      </section>

      <section className="message">
        <div className="message-head">
          <h3 className="eyebrow"><MessageSquareText size={14} aria-hidden /> Suggested message</h3>
          <button className="edit" onClick={onToggleEdit} disabled={!draft.suggestion} aria-pressed={draft.editing}>
            {draft.editing ? <><Check size={14} aria-hidden /> Done</> : <><Pencil size={14} aria-hidden /> Edit</>}
          </button>
        </div>
        {draft.channel === 'email' && (draft.editing
          ? <input className="subject-input" aria-label="Email subject" value={draft.subject} onChange={e => onSubject(e.target.value)} />
          : draft.subject && <p className="subject">Subject: {draft.subject}</p>)}
        {draft.editing
          ? <textarea aria-label="Message" value={draft.message} onChange={e => onMessage(e.target.value)} rows={4} autoFocus />
          : <p className="message-text">{draft.message || (draft.loading ? '…' : '')}</p>}
        <span className="muted small">{draft.channel === 'sms' ? 'SMS' : 'Email'} · {charCount(draft.message)} characters</span>
      </section>

      <div className="toggle" role="radiogroup" aria-label="Channel">
        <button role="radio" aria-checked={draft.channel === 'sms'} className={draft.channel === 'sms' ? 'on' : ''}
          disabled={!contact.sms} onClick={() => onChannel('sms')}><MessageCircle size={16} aria-hidden /> Text</button>
        <button role="radio" aria-checked={draft.channel === 'email'} className={draft.channel === 'email' ? 'on' : ''}
          disabled={!contact.email} onClick={() => onChannel('email')}><Mail size={16} aria-hidden /> Email</button>
      </div>
      <p className={`contact-note ${channelOk ? '' : 'warn'}`}>
        {draft.channel === 'sms' ? <Phone size={13} aria-hidden /> : <Mail size={13} aria-hidden />}
        {channelOk
          ? `Customer has a valid ${draft.channel === 'sms' ? 'phone number' : 'email address'}`
          : `No valid ${draft.channel === 'sms' ? 'phone number' : 'email address'} on file`}
      </p>
    </article>
  )
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-icon" aria-hidden>{icon}</span>
      <div><span className="stat-label">{label}</span><strong>{value}</strong></div>
    </div>
  )
}
