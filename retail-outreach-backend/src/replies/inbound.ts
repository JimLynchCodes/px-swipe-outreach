/** Helpers for inbound replies (email parsing). */

const TOKEN_RE = /reply\+([A-Za-z0-9_-]{20,64})@/i;

/** Finds the per-message reply token in To/Cc/envelope recipients. */
export function extractReplyToken(...fields: unknown[]): string | null {
  for (const f of fields) {
    const m = typeof f === "string" ? f.match(TOKEN_RE) : null;
    if (m) return m[1];
  }
  return null;
}

/** "Jane <JANE@x.com>" → "jane@x.com" */
export function parseAddress(from: unknown): string | null {
  if (typeof from !== "string") return null;
  const m = from.match(/<([^>]+)>/) ?? from.match(/([^\s,;]+@[^\s,;]+)/);
  return m ? m[1].trim().toLowerCase() : null;
}

/** Drops quoted history ("On … wrote:", "> …", Outlook headers) so the thread shows only the new text. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim())
      || /^From:\s.+/.test(line.trim()) && out.length > 0) break;
    out.push(line);
  }
  const body = out.join("\n").trim();
  return (body || text.trim()).slice(0, 10_000);
}
