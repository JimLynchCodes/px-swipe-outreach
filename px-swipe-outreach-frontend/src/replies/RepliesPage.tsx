import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Ban, Mail, MessageCircle, Send } from 'lucide-react'
import { api } from '../api'
import { PageShell } from '../components/PageShell'
import { charCount, initials, SMS_MAX } from '../lib/format'
import { relativeTime } from '../lib/week'
import { navigate, ROUTES, usePathname } from '../router'
import type { ConversationMessage, ConversationSummary, OrgSettings } from '../types'
import { notifyRepliesChanged, POLL_MS } from './useUnread'

const ChannelIcon = ({ channel }: { channel: 'sms' | 'email' }) =>
  channel === 'sms' ? <MessageCircle size={13} aria-label="Text" /> : <Mail size={13} aria-label="Email" />

/** Re-runs `fn` every 15 s while the tab is visible. */
function usePoll(fn: () => void, deps: unknown[]) {
  useEffect(() => {
    fn()
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') fn() }, POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export function RepliesPage() {
  const path = usePathname()
  const id = path.startsWith(`${ROUTES.replies}/`) ? decodeURIComponent(path.slice(ROUTES.replies.length + 1)) : null
  return id ? <ThreadView id={id} /> : <ConversationList />
}

function ConversationList() {
  const [items, setItems] = useState<ConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  usePoll(() => { api.replies.list().then(c => { setItems(c); setError(null) }, e => setError(e.message)) }, [])

  return (
    <PageShell title="Replies" subtitle="Texts and emails from customers. Updates every 15 seconds.">
      {error && <p className="error" role="alert">{error}</p>}
      {!items ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted panel">No conversations yet.</p> : (
        <ul className="convos" aria-label="Conversations">
          {items.map(c => {
            const name = c.customerName ?? c.contact
            const unread = c.unreadCount > 0
            return (
              <li key={c.id}>
                <a href={`${ROUTES.replies}/${c.id}`} className={`convo ${unread ? 'unread' : ''}`}
                  onClick={e => { e.preventDefault(); navigate(`${ROUTES.replies}/${encodeURIComponent(c.id)}`) }}>
                  <span className="dot" aria-label={unread ? 'Unread' : undefined}>{unread ? '' : null}</span>
                  <span className="avatar" aria-hidden>{initials(name)}</span>
                  <span className="convo-body">
                    <span className="convo-top">
                      <strong className="convo-name">{name}</strong>
                      <span className="muted small"><time dateTime={c.lastMessageAt}>{relativeTime(c.lastMessageAt)}</time></span>
                    </span>
                    <span className="convo-preview">
                      <ChannelIcon channel={c.channel} />
                      {c.lastDirection === 'outbound' && <span className="muted">You: </span>}
                      {c.lastMessagePreview}
                    </span>
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </PageShell>
  )
}

function ThreadView({ id }: { id: string }) {
  const [data, setData] = useState<{ conversation: ConversationSummary; messages: ConversationMessage[] } | null>(null)
  const [settings, setSettings] = useState<OrgSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)

  const load = useCallback(() => {
    api.replies.thread(id).then(d => {
      setData(d); setError(null)
      if (d.conversation.unreadCount > 0) api.replies.markRead(id).then(notifyRepliesChanged, () => {})
    }, e => setError(e.message))
  }, [id])
  usePoll(load, [load])
  useEffect(() => { api.settings.get().then(setSettings, () => {}) }, [])
  useEffect(() => {
    const n = data?.messages.length ?? 0
    if (n !== lastCount.current) { lastCount.current = n; endRef.current?.scrollIntoView?.({ block: 'end' }) }
  }, [data])

  const c = data?.conversation
  const channel = c?.channel ?? 'sms'
  const sig = settings ? (channel === 'sms' ? settings.smsSignature : settings.emailSignature).trim() : ''
  const preview = text.trim() ? (sig && !text.trim().endsWith(sig) ? (channel === 'sms' ? `${text.trim()} ${sig}` : `${text.trim()}\n\n${sig}`) : text.trim()) : ''
  const count = charCount(preview)
  const tooLong = channel === 'sms' && count > SMS_MAX

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || tooLong || c?.optedOut) return
    setSending(true); setError(null)
    try {
      await api.replies.send(id, text.trim())
      setText('')
      load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSending(false) }
  }

  const name = c ? c.customerName ?? c.contact : '…'
  return (
    <PageShell title={name} back={ROUTES.replies} backLabel="All replies"
      subtitle={c && <><ChannelIcon channel={c.channel} /> {c.channel === 'sms' ? 'Text' : 'Email'} · {c.contact}</>}>
      {error && <p className="error" role="alert">{error}</p>}
      {!data ? <p className="muted">Loading…</p> : (
        <div className="thread">
          <div className="bubbles" aria-label="Messages" aria-live="polite">
            {data.messages.map(m => (
              <div key={m.id} className={`bubble-row ${m.direction}`}>
                <div className={`bubble ${m.direction} ${m.kind !== 'message' ? 'system' : ''} ${m.status === 'failed' ? 'failed' : ''}`}>
                  {m.subject && m.direction === 'outbound' && <div className="bubble-subject">{m.subject}</div>}
                  <div className="bubble-text">{m.body}</div>
                </div>
                <div className="bubble-meta muted small">
                  <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</time>
                  {m.kind === 'opt_out' && ' · opted out'}{m.kind === 'opt_in' && ' · re-subscribed'}
                  {m.status === 'failed' && ' · failed to send'}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          {c!.optedOut ? (
            <p className="notice" role="note"><Ban size={15} aria-hidden /> {name} opted out of {channel === 'sms' ? 'texts' : 'email'}. You can't reply on this channel.</p>
          ) : (
            <form className="composer" onSubmit={send} aria-label="Reply">
              <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={`Reply by ${channel === 'sms' ? 'text' : 'email'}…`}
                aria-label="Reply message" onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e) }} />
              <div className="composer-foot">
                <span className={`muted small ${tooLong ? 'error' : ''}`}>
                  {sig ? 'Signature added' : 'No signature'}{channel === 'sms' && ` · ${count}/${SMS_MAX} characters`}
                </span>
                <button className="btn-send" disabled={sending || !text.trim() || tooLong}><Send size={16} /> {sending ? 'Sending…' : 'Send'}</button>
              </div>
            </form>
          )}
        </div>
      )}
    </PageShell>
  )
}
