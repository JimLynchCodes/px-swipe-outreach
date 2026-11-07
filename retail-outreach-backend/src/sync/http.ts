/** Fetch with retries: exponential backoff + full jitter, honoring Retry-After on 429/503. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfterMs: number | null = null) { super(message); this.name = "HttpError"; }
}
export type RetryOpts = { retries?: number; baseMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, delayMs: number, err: unknown) => void; random?: () => number };
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export const isRetryable = (e: unknown) =>
  e instanceof HttpError ? e.status === 408 || e.status === 429 || e.status >= 500 : !(e instanceof Error && e.name === "MfaRequiredError") && !(e instanceof Error && e.name === "ConfigError");

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const retries = o.retries ?? 4, base = o.baseMs ?? 500, max = o.maxMs ?? 30_000, sleep = o.sleep ?? defaultSleep, rnd = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); }
    catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const backoff = Math.min(max, base * 2 ** attempt) * rnd();
      const delay = e instanceof HttpError && e.retryAfterMs !== null ? Math.min(max, e.retryAfterMs) : Math.round(backoff);
      o.onRetry?.(attempt + 1, delay, e);
      await sleep(delay);
    }
  }
}

export function parseRetryAfter(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export async function getJson<T = any>(url: string, init: { headers?: Record<string, string>; fetchImpl?: typeof fetch; retry?: RetryOpts } = {}): Promise<T> {
  const f = init.fetchImpl ?? fetch;
  return withRetry(async () => {
    const res = await f(url, { headers: { accept: "application/json", ...init.headers } });
    if (!res.ok) {
      // Never echo the response body: it can include account details. Status + path is enough to debug.
      throw new HttpError(res.status, `GET ${new URL(url).pathname} failed: HTTP ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
    }
    return (await res.json()) as T;
  }, init.retry);
}
