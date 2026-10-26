import type { Channel, OutreachCard, SendResult, Suggestion } from './types'

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch {
    throw new ApiError('Cannot reach the outreach server. Is the backend running?', 0)
  }
  const text = await res.text()
  const data = text ? safeJson(text) : null
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : null
    const msg = typeof err === 'string' && err ? err : `Request failed (${res.status})`
    throw new ApiError(msg, res.status)
  }
  return data as T
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export const api = {
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
