import { createHmac, timingSafeEqual } from "node:crypto";

/** Twilio request validation: base64(HMAC-SHA1(authToken, url + sorted(key + value)...)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: unknown): boolean {
  if (typeof header !== "string" || !header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"] as const;
export const START_KEYWORDS = ["START", "UNSTOP", "JOIN"] as const;
export const HELP_KEYWORDS = ["HELP"] as const;

export type SmsKeyword = "stop" | "start" | "help" | null;

/** Whole-message keyword match, case-insensitive and trimmed (trailing punctuation ignored). */
export function parseKeyword(body: unknown): SmsKeyword {
  if (typeof body !== "string") return null;
  const word = body.trim().replace(/[.!]+$/, "").toUpperCase();
  if ((STOP_KEYWORDS as readonly string[]).includes(word)) return "stop";
  if ((START_KEYWORDS as readonly string[]).includes(word)) return "start";
  if ((HELP_KEYWORDS as readonly string[]).includes(word)) return "help";
  return null;
}

const xml = (s: string) => s.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export function twiml(message: string | null): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${xml(message)}</Message>` : ""}</Response>`;
}

export function keywordReply(keyword: Exclude<SmsKeyword, null>, storeName: string): string {
  switch (keyword) {
    case "stop": return `${storeName}: You have been unsubscribed and will not receive any more messages. Reply START to resubscribe.`;
    case "start": return `${storeName}: You have been resubscribed to messages. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
    case "help": return `${storeName}: Offers for customers 21+. Msg & data rates may apply. Reply STOP to opt out, START to resubscribe.`;
  }
}

/** The single re-permission text: no offer content, says how to opt back in, and that silence keeps them opted out. */
export function reoptInSms(storeName: string, firstName: string | null): string {
  return `${storeName}: Hi${firstName ? ` ${firstName}` : ""}, you opted out of our texts. Want deals again? Reply START to resubscribe. No reply = no more texts.`;
}
