import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, PartyPopper, RotateCcw } from 'lucide-react'
import { api, ApiError, newIdempotencyKey } from './api'
import { Header } from './components/Header'
import { CustomerCard, type CardDraft } from './components/CustomerCard'
import type { Channel, OutreachCard } from './types'

const SWIPE_THRESHOLD = 110

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready' }

function initialDraft(card: OutreachCard): CardDraft {
  const channel: Channel = card.customer.contact.preferredChannel ?? 'sms'
  return { channel, suggestion: null, loading: true, error: null, message: '', subject: '', editing: false }
}

export default function App() {
  const [cards, setCards] = useState<OutreachCard[]>([])
  const [total, setTotal] = useState(0)
  const [done, setDone] = useState(0)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [draft, setDraft] = useState<CardDraft | null>(null)
  const [busy, setBusy] = useState<'skip' | 'send' | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dragX, setDragX] = useState(0)
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null)
  const drag = useRef<{ x: number; id: number } | null>(null)
  const sendKey = useRef<string>(newIdempotencyKey())

  const current = cards[0]

  const loadQueue = useCallback(async () => {
    setLoad({ state: 'loading' })
    try {
      const q = await api.queue(50)
      setCards(q.items)
      setTotal(q.total)
      setDone(0)
      setLoad({ state: 'ready' })
    } catch (e) {
      setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => { void loadQueue() }, [loadQueue])

  const suggestionSeq = useRef(0)
  const fetchSuggestion = useCallback(async (card: OutreachCard, channel: Channel) => {
    const seq = ++suggestionSeq.current // ignore responses from superseded requests
    setDraft(d => d && { ...d, channel, loading: true, error: null })
    try {
      const s = await api.suggestion(card.id, channel)
      if (seq !== suggestionSeq.current) return
      setDraft(d => d && { ...d, suggestion: s, message: s.message, subject: s.subject ?? '', loading: false, error: null, editing: false })
    } catch (e) {
      if (seq !== suggestionSeq.current) return
      setDraft(d => d && { ...d, loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  // New top card → fresh draft + suggestion + idempotency key.
  useEffect(() => {
    if (!current) { setDraft(null); return }
    const d = initialDraft(current)
    setDraft(d)
    sendKey.current = newIdempotencyKey()
    void fetchSuggestion(current, d.channel)
  }, [current, fetchSuggestion])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const advance = useCallback((dir: 'left' | 'right') => {
    setLeaving(dir)
    setTimeout(() => {
      setCards(cs => cs.slice(1))
      setDone(n => n + 1)
      setLeaving(null)
      setDragX(0)
    }, 220)
  }, [])

  const skip = useCallback(async () => {
    if (!current || busy) return
    setBusy('skip')
    try {
      await api.skip(current.id)
      advance('left')
    } catch (e) {
      setDragX(0)
      setToast({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(null) }
  }, [current, busy, advance])

  const send = useCallback(async () => {
    if (!current || !draft || busy) return
    const reachable = draft.channel === 'sms' ? current.customer.contact.sms : current.customer.contact.email
    if (!reachable || !draft.message.trim()) {
      setDragX(0)
      setToast({ kind: 'err', text: !reachable ? 'Customer cannot be reached on this channel' : 'Message is empty' })
      return
    }
    setBusy('send')
    try {
      const r = await api.send(current.id, {
        channel: draft.channel, message: draft.message.trim(),
        subject: draft.channel === 'email' ? draft.subject.trim() || null : null,
        idempotencyKey: sendKey.current,
      })
      setToast({ kind: 'ok', text: r.status === 'queued' ? `Queued for ${current.customer.firstName}` : `Sent to ${current.customer.firstName}` })
      advance('right')
    } catch (e) {
      setDragX(0)
      const already = e instanceof ApiError && e.status === 409
      setToast({ kind: 'err', text: already ? 'This customer was already contacted' : e instanceof Error ? e.message : String(e) })
      if (already) advance('right')
    } finally { setBusy(null) }
  }, [current, draft, busy, advance])

  const optOut = useCallback(async () => {
    if (!current || busy) return
    if (!window.confirm(`Stop all outreach to ${current.customer.firstName}? They will be added to the do-not-contact list.`)) return
    setBusy('skip')
    try {
      await api.optOut(current.id, 'all')
      setToast({ kind: 'ok', text: `${current.customer.firstName} won't be contacted again` })
      advance('left')
    } catch (e) {
      setToast({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(null) }
  }, [current, busy, advance])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') void skip()
      if (e.key === 'ArrowRight') void send()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skip, send])

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement
    if (busy || draft?.editing || t.closest('button, textarea, input')) return
    drag.current = { x: e.clientX, id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) setDragX(e.clientX - drag.current.x)
  }
  const onPointerUp = () => {
    if (!drag.current) return
    drag.current = null
    if (dragX > SWIPE_THRESHOLD) void send()
    else if (dragX < -SWIPE_THRESHOLD) void skip()
    else setDragX(0)
  }

  const position = done + 1
  const offset = leaving === 'left' ? -600 : leaving === 'right' ? 600 : dragX

  return (
    <div className="app">
      <Header />
      <main className="deck-area">
        {load.state === 'loading' && <div className="state">Loading customers…</div>}
        {load.state === 'error' && (
          <div className="state" role="alert">
            <p>{load.message}</p>
            <button className="btn-secondary" onClick={() => void loadQueue()}><RotateCcw size={16} /> Try again</button>
          </div>
        )}
        {load.state === 'ready' && !current && (
          <div className="state">
            <PartyPopper size={40} className="green" />
            <h2>All caught up!</h2>
            <p className="muted">You reviewed {done} customer{done === 1 ? '' : 's'}.</p>
            <button className="btn-secondary" onClick={async () => { await api.resetDemo().catch(() => {}); await loadQueue() }}>
              <RotateCcw size={16} /> Reset demo data
            </button>
          </div>
        )}
        {load.state === 'ready' && current && draft && (
          <div className="stack">
            {cards.length > 2 && <div className="ghost ghost-2" aria-hidden />}
            {cards.length > 1 && <div className="ghost ghost-1" aria-hidden />}
            <div
              className={`swipe ${dragX === 0 || leaving ? 'animate' : ''}`}
              style={{ transform: `translateX(${offset}px) rotate(${offset / 30}deg)` }}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            >
              {dragX > 40 && <span className="stamp stamp-send">SEND</span>}
              {dragX < -40 && <span className="stamp stamp-skip">SKIP</span>}
              <CustomerCard
                card={current} position={position} total={total} draft={draft}
                onChannel={ch => { if (ch !== draft.channel) void fetchSuggestion(current, ch) }}
                onMessage={m => setDraft(d => d && { ...d, message: m })}
                onSubject={s => setDraft(d => d && { ...d, subject: s })}
                onToggleEdit={() => setDraft(d => d && { ...d, editing: !d.editing })}
                onRetry={() => void fetchSuggestion(current, draft.channel)}
              />
            </div>
          </div>
        )}
      </main>

      {load.state === 'ready' && current && (
        <footer className="actions">
          <button className="action skip" onClick={() => void skip()} disabled={!!busy} aria-label="Skip customer">
            <span className="circle"><ArrowLeft size={22} /></span><span>{busy === 'skip' ? 'Skipping…' : 'Skip'}</span>
          </button>
          <button className="action send" onClick={() => void send()} disabled={!!busy || !draft?.suggestion} aria-label="Send message">
            <span>{busy === 'send' ? 'Sending…' : 'Send'}</span><span className="circle"><ArrowRight size={22} /></span>
          </button>
        </footer>
      )}
      {load.state === 'ready' && current && (
        <button className="link optout" onClick={() => void optOut()} disabled={!!busy}>Customer opted out? Stop contacting them</button>
      )}
      {load.state === 'ready' && current && (
        <div className="dots" aria-hidden>
          {[0, 1, 2].map(i => <span key={i} className={i === done % 3 ? 'on' : ''} />)}
        </div>
      )}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  )
}
