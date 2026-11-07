import {
  CalendarDays, ChevronRight, CircleDollarSign, Clock, Mail, MapPin, MessageCircle, MessageSquareText,
  Pencil, Phone, ShieldAlert, ShieldCheck, ShoppingBag, Sparkles, Store, Tag, Check, Repeat, X,
} from 'lucide-react'
import type { Channel, OutreachCard, Suggestion } from '../types'
import { charCount, daysAgo, money, SMS_MAX } from '../lib/format'
import { categoryLabel, DAYS, SEGMENT_LABEL } from '../lib/week'

export interface CardDraft {
  channel: Channel
  suggestion: Suggestion | null
  loading: boolean
  error: string | null
  message: string
  subject: string
  editing: boolean
  /** Snapshot taken when editing starts; Cancel restores it. */
  saved?: { message: string; subject: string }
}

interface Props {
  card: OutreachCard
  position: number
  total: number
  draft: CardDraft
  onChannel: (c: Channel) => void
  onMessage: (m: string) => void
  onSubject: (s: string) => void
  onEdit: () => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onRetry: () => void
}

const TIME_LABEL = { morning: 'mornings', afternoon: 'afternoons', evening: 'evenings' } as const

export function CustomerCard({ card, position, total, draft, onChannel, onMessage, onSubject, onEdit, onSaveEdit, onCancelEdit, onRetry }: Props) {
  const { customer: c, lastPurchase: lp } = card
  const { contact, profile } = c
  const channelOk = draft.channel === 'sms' ? contact.sms : contact.email
  const s = draft.suggestion
  const count = charCount(draft.message)
  const habit = [
    profile.preferredDay != null ? DAYS[profile.preferredDay] + 's' : null,
    profile.preferredTime ? TIME_LABEL[profile.preferredTime] : null,
  ].filter(Boolean).join(', ')

  return (
    <article className="card" aria-label={`Outreach for ${c.displayName}`}>
      <span className="counter">{position} / {total}</span>
      <h2 className="name">
        {c.displayName}{c.age != null && <span className="age">Age {c.age}</span>}
        <span className={`segment seg-${card.segment}`}>{SEGMENT_LABEL[card.segment]}</span>
      </h2>
      <ul className="facts">
        {c.ageVerified
          ? <li className="green"><ShieldCheck size={16} aria-hidden />21+ verified</li>
          : <li className="warn"><ShieldAlert size={16} aria-hidden />Age not verified: can't send age-restricted offers</li>}
        {c.location && <li><MapPin size={16} aria-hidden />{c.location}</li>}
        {c.storesShopped.length > 0 && <li><Store size={16} aria-hidden />Shops at: {c.storesShopped.join(', ')}</li>}
      </ul>

      <div className="stats">
        <Stat icon={<CircleDollarSign size={18} />} label="Lifetime Spend" value={money(c.lifetimeSpendCents)} />
        <Stat icon={<CalendarDays size={18} />} label="Last Purchase" value={daysAgo(c.daysSinceLastPurchase)} />
        <Stat icon={<ShoppingBag size={18} />} label="Items Purchased" value={`${c.itemsPurchased} total`} />
      </div>

      <section aria-label="Buying patterns">
        <h3 className="eyebrow">Buying patterns</h3>
        <ul className="patterns">
          {profile.favoriteCategories.length > 0 && (
            <li><Tag size={14} aria-hidden />Buys: {profile.favoriteCategories.map(categoryLabel).join(', ')}
              {profile.favoriteBrands.length > 0 && <span className="muted"> · {profile.favoriteBrands.join(', ')}</span>}</li>
          )}
          <li><Repeat size={14} aria-hidden />{profile.visitsPerMonth} visit{profile.visitsPerMonth === 1 ? '' : 's'}/month · avg basket {money(profile.avgBasketCents)}</li>
          {habit && <li><Clock size={14} aria-hidden />Usually shops {habit}</li>}
        </ul>
      </section>

      {lp && (
        <section>
          <h3 className="eyebrow">Last purchased</h3>
          <div className="purchase">
            <div className="thumb">
              {lp.imageUrl ? <img src={lp.imageUrl} alt={lp.name} /> : <ShoppingBag size={34} aria-label={lp.name} />}
            </div>
            <div className="purchase-body">
              <strong>{lp.name}</strong>
              <span className="muted">{[lp.brand, money(lp.priceCents), daysAgo(lp.daysAgo)].filter(Boolean).join(' · ')}</span>
              {card.recentItems.length > 1 && (
                <span className="muted small">Recently: {card.recentItems.slice(1, 4).map(i => i.name).join(', ')}</span>
              )}
            </div>
            <ChevronRight size={18} className="muted" aria-hidden />
          </div>
        </section>
      )}

      <section className="ai" aria-live="polite">
        <h3 className="eyebrow green"><Sparkles size={14} aria-hidden /> AI Suggestion</h3>
        {draft.loading && !s && <p className="skeleton">Thinking up the best offer…</p>}
        {draft.error && <p className="error">{draft.error} <button className="link" onClick={onRetry}>Retry</button></p>}
        {s && (
          <>
            <h4>{s.title}</h4>
            {s.deal && (
              <p className="deal-chip" aria-label="Chosen deal">
                <Tag size={13} aria-hidden /> {s.deal.title} · {s.deal.discountLabel} · {DAYS[s.deal.day]}
              </p>
            )}
            <p>{s.reasoning}</p>
            {s.reasons.length > 0 && (
              <ul className="reasons" aria-label="Why this deal">{s.reasons.map(r => <li key={r}>{r}</li>)}</ul>
            )}
            {s.sendAt && <p className="muted small"><Clock size={12} aria-hidden /> Best time to send: {s.sendAt.label}</p>}
          </>
        )}
      </section>

      <section className="message">
        <div className="message-head">
          <h3 className="eyebrow"><MessageSquareText size={14} aria-hidden /> Suggested message</h3>
          {draft.editing ? (
            <span className="edit-actions">
              <button className="edit cancel" onClick={onCancelEdit}><X size={14} aria-hidden /> Cancel</button>
              <button className="edit save" onClick={onSaveEdit} disabled={!draft.message.trim()}><Check size={14} aria-hidden /> Done</button>
            </span>
          ) : (
            <button className="edit" onClick={onEdit} disabled={!s}><Pencil size={14} aria-hidden /> Edit</button>
          )}
        </div>
        {draft.channel === 'email' && (draft.editing
          ? <input className="subject-input" aria-label="Email subject" value={draft.subject} onChange={e => onSubject(e.target.value)} />
          : draft.subject && <p className="subject">Subject: {draft.subject}</p>)}
        {draft.editing
          ? <textarea aria-label="Message" value={draft.message} onChange={e => onMessage(e.target.value)} rows={5} autoFocus />
          : <p className="message-text">{draft.message || (draft.loading ? '…' : '')}</p>}
        {draft.editing && <p className="edit-hint" role="status">Click Done or Cancel to send</p>}
        <span className={`muted small ${draft.channel === 'sms' && count > SMS_MAX ? 'error' : ''}`}>
          {draft.channel === 'sms' ? `SMS · ${count}/${SMS_MAX} characters · includes signature and “Reply STOP to opt out.”` : `Email · ${count} characters · unsubscribe link added`}
        </span>
      </section>

      <div className="toggle" role="radiogroup" aria-label="Channel">
        <button role="radio" aria-checked={draft.channel === 'sms'} className={draft.channel === 'sms' ? 'on' : ''}
          disabled={!contact.sms || draft.editing} onClick={() => onChannel('sms')}><MessageCircle size={16} aria-hidden /> Text</button>
        <button role="radio" aria-checked={draft.channel === 'email'} className={draft.channel === 'email' ? 'on' : ''}
          disabled={!contact.email || draft.editing} onClick={() => onChannel('email')}><Mail size={16} aria-hidden /> Email</button>
      </div>
      <p className={`contact-note ${channelOk ? '' : 'warn'}`}>
        {draft.channel === 'sms' ? <Phone size={13} aria-hidden /> : <Mail size={13} aria-hidden />}
        {channelOk
          ? `Customer has a valid ${draft.channel === 'sms' ? 'phone number' : 'email address'}`
          : `No ${draft.channel === 'sms' ? 'phone number' : 'email address'} we can use (missing or opted out)`}
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
