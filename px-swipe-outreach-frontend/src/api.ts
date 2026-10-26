/**
 * Small typed API boundary. Confirm actual backend route names and payloads
 * before enabling these calls in the UI.
 */
export type OutreachDecision = 'interested' | 'skip'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) throw new Error('Set VITE_API_BASE_URL before calling the backend.')
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) throw new Error(`API request failed (${response.status})`)
  return response.json() as Promise<T>
}

// Adapt paths and DTOs to the backend's real contract.
export async function getLeads<T>(): Promise<T[]> {
  return request<T[]>('/api/leads')
}

export async function recordDecision<T>(
  leadId: string,
  decision: OutreachDecision,
): Promise<T> {
  return request<T>(`/api/leads/${encodeURIComponent(leadId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  })
}