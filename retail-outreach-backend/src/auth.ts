import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

export type RequestUser = { id: string; tenantId: string; roles: string[] };

declare module "fastify" {
  interface FastifyRequest { user: RequestUser }
}

/**
 * DEMO ONLY. Every request is treated as the configured dev user/tenant.
 * Replace with verified OIDC/JWT/session auth before production; never trust
 * tenant IDs supplied by the browser.
 */
export function resolveUser(_request: FastifyRequest, config: AppConfig): RequestUser {
  if (config.NODE_ENV === "production") {
    throw new Error("Production authentication is not configured");
  }
  return { id: config.DEV_USER_ID, tenantId: config.DEV_TENANT_ID, roles: ["outreach:read", "outreach:send"] };
}
