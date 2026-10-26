import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AppConfig } from "./config.js";
import type { Membership, MemberRole } from "./types.js";

/** Authenticated principal, derived only from a verified token (never from client-supplied ids). */
export type AuthUser = { id: string; email: string | null };

/** Org context for a request, resolved from the user's memberships. */
export type OrgContext = { orgId: string; role: MemberRole; businessName: string | null };

export class AuthError extends Error {
  constructor(public status: 400 | 401 | 403, public code: string, message: string) { super(message); this.name = "AuthError"; }
}

export interface Authenticator {
  readonly mode: "supabase" | "demo";
  authenticate(authorizationHeader: string | undefined): Promise<AuthUser>;
}

/**
 * DEMO ONLY. Every request is the configured demo user. Config validation refuses AUTH_MODE=demo when
 * NODE_ENV=production, and this constructor double-checks.
 */
export class DemoAuthenticator implements Authenticator {
  readonly mode = "demo" as const;
  constructor(private userId: string, nodeEnv: string) {
    if (nodeEnv === "production") throw new Error("Demo authentication cannot be used in production");
  }
  async authenticate(): Promise<AuthUser> { return { id: this.userId, email: "demo@px-outreach.local" }; }
}

/**
 * Verifies Supabase Auth access tokens (the `Authorization: Bearer <jwt>` the frontend sends).
 * - Projects using asymmetric signing keys: verified against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (cached).
 * - Projects on the legacy shared secret: set SUPABASE_JWT_SECRET (HS256).
 * Checks signature, expiry, issuer, audience and that `sub` is a uuid.
 */
export class SupabaseJwtAuthenticator implements Authenticator {
  readonly mode = "supabase" as const;
  private readonly key: JWTVerifyGetKey | Uint8Array;
  private readonly issuer: string;

  constructor(private opts: { supabaseUrl: string; jwtSecret?: string; audience: string; jwks?: JWTVerifyGetKey }) {
    this.issuer = `${opts.supabaseUrl}/auth/v1`;
    this.key = opts.jwks
      ?? (opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret)
        : createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 }));
  }

  async authenticate(header: string | undefined): Promise<AuthUser> {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header ?? "");
    if (!m) throw new AuthError(401, "unauthenticated", "Missing bearer token");
    try {
      const { payload } = await jwtVerify(m[1], this.key as any, {
        issuer: this.issuer,
        audience: this.opts.audience,
        algorithms: this.opts.jwtSecret && !this.opts.jwks ? ["HS256"] : ["RS256", "ES256", "EdDSA"],
        clockTolerance: 5
      });
      if (typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub)) {
        throw new AuthError(401, "invalid_token", "Token has no valid subject");
      }
      if (payload.role !== "authenticated") throw new AuthError(401, "invalid_token", "Token is not for an authenticated user");
      return { id: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e instanceof joseErrors.JWTExpired) throw new AuthError(401, "token_expired", "Session expired");
      throw new AuthError(401, "invalid_token", "Invalid access token");
    }
  }
}

export function createAuthenticator(config: AppConfig): Authenticator {
  if (config.AUTH_MODE === "demo") return new DemoAuthenticator(config.DEMO_USER_ID, config.NODE_ENV);
  return new SupabaseJwtAuthenticator({
    supabaseUrl: config.SUPABASE_URL!, jwtSecret: config.SUPABASE_JWT_SECRET, audience: config.SUPABASE_JWT_AUDIENCE
  });
}

/**
 * Picks the org for this request. The client may *ask* for one via `X-Org-Id`, but it is only honored
 * if the user is a member; otherwise a user with exactly one membership gets that org.
 */
export function resolveOrg(memberships: Membership[], requested: string | undefined): OrgContext {
  if (requested) {
    const m = memberships.find(x => x.orgId === requested);
    if (!m) throw new AuthError(403, "not_a_member", "You are not a member of this organization");
    return { orgId: m.orgId, role: m.role, businessName: m.businessName };
  }
  if (memberships.length === 1) {
    const [m] = memberships;
    return { orgId: m.orgId, role: m.role, businessName: m.businessName };
  }
  if (memberships.length === 0) throw new AuthError(403, "no_membership", "Your account is not a member of any organization yet");
  throw new AuthError(400, "org_required", "Select an organization (X-Org-Id header)");
}
