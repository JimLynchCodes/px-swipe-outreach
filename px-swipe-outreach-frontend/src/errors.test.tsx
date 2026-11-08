import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { ErrorBubble } from './components/ErrorBubble'
import { friendlyError, NETWORK_MESSAGE, SERVER_MESSAGE, useApiAction } from './lib/errors'
import Root from './Root'

describe('friendlyError', () => {
  it('uses the server message when there is one', () => {
    expect(friendlyError(new ApiError('Daily send limit reached', 429))).toBe('Daily send limit reached')
  })
  it('falls back for network failures and generic 5xx', () => {
    expect(friendlyError(new ApiError('Cannot reach', 0))).toBe(NETWORK_MESSAGE)
    expect(friendlyError(new TypeError('Failed to fetch'))).toBe(NETWORK_MESSAGE)
    expect(friendlyError(new ApiError('Request failed (502)', 502))).toBe(SERVER_MESSAGE)
    expect(friendlyError('weird')).toBe(SERVER_MESSAGE)
  })
})

describe('ErrorBubble', () => {
  it('renders an alert bubble only when there is an error', () => {
    const { rerender } = render(<ErrorBubble error={null} />)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<ErrorBubble error="Nope" />)
    expect(screen.getByRole('alert')).toHaveClass('error-bubble')
    expect(screen.getByRole('alert')).toHaveTextContent('Nope')
  })
})

function Demo({ fn }: { fn: () => Promise<string> }) {
  const a = useApiAction(fn)
  return <div><button onClick={() => void a.run()}>Go</button><ErrorBubble error={a.error} /></div>
}

describe('useApiAction', () => {
  it('shows the error under the button and clears it on a successful retry', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new ApiError('Request failed (500)', 500)).mockResolvedValueOnce('ok')
    render(<Demo fn={fn} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    const bubble = await screen.findByRole('alert')
    expect(bubble).toHaveTextContent(SERVER_MESSAGE)
    expect(screen.getByRole('button', { name: 'Go' }).nextElementSibling).toBe(bubble)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const ORG = { orgId: 'org-1', orgName: 'Cloud 9', businessName: 'Cloud 9', role: 'owner' as const }
const SETTINGS = { storeName: 'Cloud 9', emailSignature: '', smsSignature: '', defaultChannel: null, maxDiscountPercent: 25 }
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })

describe('settings save errors', () => {
  it('shows the server message in a bubble under Save settings, cleared by a successful retry', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const m = init?.method ?? 'GET'; const u = url.split('?')[0]
      if (u === '/api/me') return json({ user: { id: 'u', email: 'me@x.test' }, memberships: [ORG], authMode: 'demo' })
      if (u === '/api/conversations/unread-count') return json({ count: 0 })
      if (u === '/api/settings' && m === 'GET') return json({ settings: SETTINGS })
      if (u === '/api/settings' && m === 'PUT') {
        if (fail) { fail = false; return json({ error: 'Max discount must be 50% or less' }, 400) }
        return json({ settings: JSON.parse(String(init!.body)) })
      }
      if (u === '/api/deals') return json({ deals: [] })
      if (u === '/api/catalog') return json({ products: [], categories: [] })
      return json({ error: 'not found' }, 404)
    }))
    window.history.replaceState(null, '', '/settings')
    render(<Root config={{ mode: 'demo' }} />)
    const save = await screen.findByRole('button', { name: 'Save settings' })
    fireEvent.click(save)
    const bubble = await screen.findByRole('alert')
    expect(bubble).toHaveTextContent('Max discount must be 50% or less')
    expect(bubble).toHaveClass('error-bubble')
    expect(save.nextElementSibling).toBe(bubble)
    fireEvent.click(save)
    expect(await screen.findByText('Settings saved')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
