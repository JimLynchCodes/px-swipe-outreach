import type { CostReport, PerformanceReport,
  AiModelOption, CatalogProduct, Channel, ConsentEvent, ConversationMessage, ConversationSummary, Deal, DealInput, OptOutEntry, OrgSettings, OutreachCard,
  SendResult, Suggestion,
} from './types'

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
  me: () => request<{ user: { id: string; email: string | null }; memberships: Membership[]; authMode: string; dataStore?: 'memory' | 'postgres' }>('/api/me'),
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
  deals: {
    list: () => request<{ deals: Deal[] }>('/api/deals').then(r => r.deals),
    create: (d: DealInput) => request<{ deal: Deal }>('/api/deals', { method: 'POST', body: JSON.stringify(d) }).then(r => r.deal),
    update: (id: string, d: DealInput) =>
      request<{ deal: Deal }>(`/api/deals/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(d) }).then(r => r.deal),
    remove: (id: string) => request<{ ok: true }>(`/api/deals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  catalog: () => request<{ products: CatalogProduct[]; categories: string[] }>('/api/catalog'),
  settings: {
    get: () => request<{ settings: OrgSettings }>('/api/settings').then(r => r.settings),
    save: (s: OrgSettings) => request<{ settings: OrgSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }).then(r => r.settings),
  },
  optOuts: (q: { channel?: Channel; q?: string; page: number; pageSize: number }) => {
    const p = new URLSearchParams({ page: String(q.page), pageSize: String(q.pageSize) })
    if (q.channel) p.set('channel', q.channel)
    if (q.q) p.set('q', q.q)
    return request<{ items: OptOutEntry[]; total: number; page: number; pageSize: number }>(`/api/opt-outs?${p}`)
  },
  optOutHistory: (id: string) => request<{ events: ConsentEvent[] }>(`/api/opt-outs/${encodeURIComponent(id)}/history`).then(r => r.events),
  requestReoptIn: (id: string) =>
    request<{ ok: true; channel: Channel; status: string; requestedAt: string; expiresAt: string }>(`/api/opt-outs/${encodeURIComponent(id)}/reopt-in`, { method: 'POST' }),
  replies: {
    list: () => request<{ conversations: ConversationSummary[] }>('/api/conversations').then(r => r.conversations),
    unread: () => request<{ count: number }>('/api/conversations/unread-count').then(r => r.count),
    thread: (id: string) => request<{ conversation: ConversationSummary; messages: ConversationMessage[] }>(`/api/conversations/${encodeURIComponent(id)}`),
    markRead: (id: string) => request<{ ok: true }>(`/api/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    send: (id: string, body: string, subject?: string | null) =>
      request<{ message: ConversationMessage }>(`/api/conversations/${encodeURIComponent(id)}/messages`, {
        method: 'POST', body: JSON.stringify({ body, ...(subject ? { subject } : {}) }),
      }).then(r => r.message),
  },
  aiModels: () => request<{ models: AiModelOption[]; selected: string; effective: string; priceTableVersion: string }>('/api/ai/models'),
  metrics: {
    costs: () => request<CostReport>('/api/metrics/costs'),
    performance: (days?: number) => request<PerformanceReport>(`/api/metrics/performance${days ? `?days=${days}` : ''}`),
  },
  resetDemo: () => request<{ ok: true }>('/api/dev/reset', { method: 'POST' }),
}

export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
