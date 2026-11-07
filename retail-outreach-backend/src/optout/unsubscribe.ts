import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, non-guessable unsubscribe tokens: `<deliveryId>.<HMAC-SHA256>`. The token carries no PII;
 * the recipient is resolved server-side from the delivery, so every email gets its own link.
 */
const sig = (secret: string, deliveryId: string) =>
  createHmac("sha256", secret).update(`unsubscribe:v1:${deliveryId}`).digest("base64url");

export function unsubscribeToken(secret: string, deliveryId: string): string {
  return `${deliveryId}.${sig(secret, deliveryId)}`;
}

/** Returns the delivery id for a valid token, else null (constant-time comparison). */
export function verifyUnsubscribeToken(secret: string, token: unknown): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sig(secret, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

export function unsubscribeLink(publicApiUrl: string, secret: string, deliveryId: string) {
  const url = `${publicApiUrl}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(secret, deliveryId))}`;
  return {
    url,
    /** RFC 2369 + RFC 8058 one-click unsubscribe. */
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
  };
}

/** Purpose-bound signatures: an unsubscribe token can't be replayed as a resubscribe/re-opt-in token and vice versa. */
const purposeSig = (secret: string, purpose: "resubscribe" | "reoptin", id: string) =>
  createHmac("sha256", secret).update(`${purpose}:v1:${id}`).digest("base64url");
export const purposeToken = (secret: string, purpose: "resubscribe" | "reoptin", id: string) => `${id}.${purposeSig(secret, purpose, id)}`;
export function verifyPurposeToken(secret: string, purpose: "resubscribe" | "reoptin", token: unknown): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(purposeSig(secret, purpose, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}
