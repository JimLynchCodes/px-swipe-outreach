import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type KeyLike } from "jose";
import { buildApp } from "../src/app.js";
import { SupabaseJwtAuthenticator, type Authenticator } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { RulesSuggestionProvider, type SuggestionProvider } from "../src/providers/ai.js";
import { ConsoleMessageProvider, type MessageProvider } from "../src/providers/messaging.js";
import { MemoryStore } from "../src/store/memory.js";
import type { OutreachStore } from "../src/store/types.js";
import type { InviteEmail, InviteMailer } from "../src/team/mailer.js";

/** Records invite emails; set `fail` to simulate a provider outage. */
export class FakeInviteMailer implements InviteMailer {
  readonly name = "supabase" as const;
  sent: InviteEmail[] = [];
  fail = false;
  async send(m: InviteEmail) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(m);
    return { method: "invite" as const };
  }
  /** Raw token from the most recent email's link. */
  lastToken() { return new URL(this.sent.at(-1)!.acceptUrl).searchParams.get("token")!; }
}

export async function makeApp(overrides: {
  suggestions?: SuggestionProvider; messenger?: MessageProvider; authenticator?: Authenticator;
  store?: OutreachStore; env?: Record<string, string>; inviteMailer?: InviteMailer;
} = {}) {
  const config = loadConfig({ NODE_ENV: "test", ...overrides.env });
  const store = overrides.store ?? new MemoryStore();
  const messenger = overrides.messenger ?? new ConsoleMessageProvider(() => {});
  const app = await buildApp({
    config, store, suggestions: overrides.suggestions ?? new RulesSuggestionProvider(), messenger,
    authenticator: overrides.authenticator, inviteMailer: overrides.inviteMailer, logger: false
  });
  return { app, store, messenger, config };
}

export const SUPABASE_URL = "https://test-project.supabase.co";
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

/** A fake Supabase project: an ES256 key pair exposed as a local JWKS, plus a token minting helper. */
export async function fakeSupabase() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const authenticator = new SupabaseJwtAuthenticator({ supabaseUrl: SUPABASE_URL, audience: "authenticated", jwks });
  const sign = (sub: string, opts: { exp?: string | number; aud?: string; iss?: string; claims?: JWTPayload; key?: KeyLike } = {}) =>
    new SignJWT({ role: "authenticated", email: `${sub.slice(0, 4)}@example.com`, ...opts.claims })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setSubject(sub).setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? "authenticated")
      .setIssuedAt().setExpirationTime(opts.exp ?? "5m")
      .sign(opts.key ?? privateKey);
  return { authenticator, sign };
}
