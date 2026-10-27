import type { Channel, OutreachCard, SendResult, Suggestion } from './types'

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export type Role = 'owner' | 'admin' | 'staff'
export interface Membership { orgId: string; orgName: string; businessName: string | null; role: Role }
export interface TeamMember { userId: string; email: string | null; role: Role; joinedAt: string }
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked'
export interface Invitation {
  id: string; orgId: string; email: string; role: Role; status: InvitationStatus; invitedBy: string | null
  createdAt: string; expiresAt: string; lastSentAt: string; sendCount: number
}
export interface InvitationPreview { orgName: string; email: string; role: Role; status: InvitationStatus; expiresAt: string }
/** emailSent=false means the invite exists but the email didn't go out; acceptUrl is only present in dev (console mailer). */
export interface InviteResult { invitation: Invitation; emailSent: boolean; acceptUrl?: string }

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

async function request<T>(path: string, opts: RequestInit & { noOrg?: boolean; anonymous?: boolean } = {}): Promise<T> {
  const { noOrg, anonymous, ...init } = opts
  let res: Response
  const token = anonymous ? null : await hooks.getToken()
  const orgId = noOrg || anonymous ? null : hooks.getOrgId()
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
  team: {
    members: () => request<{ members: TeamMember[]; me: { userId: string; role: Role } }>('/api/team/members'),
    invitations: () => request<{ invitations: Invitation[] }>('/api/team/invitations').then(r => r.invitations),
    invite: (email: string, role: Role) =>
      request<InviteResult>('/api/team/invitations', { method: 'POST', body: JSON.stringify({ email, role }) }),
    resend: (id: string) => request<InviteResult>(`/api/team/invitations/${encodeURIComponent(id)}/resend`, { method: 'POST' }),
    revoke: (id: string) => request<{ ok: true }>(`/api/team/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    changeRole: (userId: string, role: Role) =>
      request<{ ok: true }>(`/api/team/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    remove: (userId: string) => request<{ ok: true }>(`/api/team/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  },
  invitations: {
    preview: (token: string) =>
      request<{ invitation: InvitationPreview }>(`/api/invitations/preview?token=${encodeURIComponent(token)}`, { anonymous: true }).then(r => r.invitation),
    accept: (token: string) =>
      request<{ ok: true; orgId: string; role: Role; alreadyMember: boolean; memberships: Membership[] }>('/api/invitations/accept', {
        method: 'POST', body: JSON.stringify({ token }), noOrg: true,
      }),
  },
  resetDemo: () => request<{ ok: true }>('/api/dev/reset', { method: 'POST' }),
}

export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
