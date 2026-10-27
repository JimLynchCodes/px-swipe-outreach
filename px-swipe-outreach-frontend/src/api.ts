import type { Channel, OutreachCard, SendResult, Suggestion } from './types'

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export interface Membership { orgId: string; orgName: string; businessName: string; role: 'owner' | 'admin' | 'member' }

interface ApiHooks {
  getToken: () => Promise<string | null>
  getOrgId: () => string | null
  onUnauthorized: () => void
}
let hooks: ApiHooks = { getToken: async () => null, getOrgId: () => null, onUnauthorized: () => {} }
/** Called by AuthProvider so every request carries the session token + selected org. */
export function configureApi(h: ApiHooks): void { hooks = h }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly requestId?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  const token = await hooks.getToken()
  const orgId = hooks.getOrgId()
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(orgId ? { 'X-Org-Id': orgId } : {}),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError('Cannot reach the outreach server. Is the backend running?', 0)
  }
  const text = await res.text()
  const data = text ? safeJson(text) : null
  if (!res.ok) {
    const body = (data && typeof data === 'object' ? data : {}) as { error?: unknown; code?: unknown; requestId?: unknown }
    const msg = typeof body.error === 'string' && body.error ? body.error : `Request failed (${res.status})`
    if (res.status === 401) hooks.onUnauthorized()
    throw new ApiError(msg, res.status, typeof body.code === 'string' ? body.code : undefined,
      typeof body.requestId === 'string' ? body.requestId : undefined)
  }
  return data as T
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export const api = {
  me: () => request<{ user: { id: string; email: string | null }; memberships: Membership[]; authMode: string }>('/api/me'),
  optOut: (id: string, channel: Channel | 'all' = 'all') =>
    request<{ ok: true }>(`/api/outreach/${encodeURIComponent(id)}/opt-out`, { method: 'POST', body: JSON.stringify({ channel }) }),
  queue: (limit = 50) => request<{ items: OutreachCard[]; total: number }>(`/api/outreach/queue?limit=${limit}`),
  suggestion: (id: string, channel: Channel) =>
    request<{ suggestion: Suggestion }>(`/api/outreach/${encodeURIComponent(id)}/suggestion`, {
      method: 'POST', body: JSON.stringify({ channel }),
    }).then(r => r.suggestion),
  skip: (id: string) => request<{ ok: true }>(`/api/outreach/${encodeURIComponent(id)}/skip`, { method: 'POST' }),
  send: (id: string, body: { channel: Channel; message: string; subject?: string | null; idempotencyKey: string }) =>
    request<SendResult>(`/api/outreach/${encodeURIComponent(id)}/send`, {
      method: 'POST', body: JSON.stringify({ ...body, subject: body.subject ?? undefined }),
    }),
  resetDemo: () => request<{ ok: true }>('/api/dev/reset', { method: 'POST' }),
}

export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
