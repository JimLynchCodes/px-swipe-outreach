import type { FastifyRequest } from "fastify";
import { config } from "./config.js";

export type RequestUser = { id: string; tenantId: string; roles: string[] };

/**
 * DEMO ONLY. Replace with verified OIDC/JWT/session auth.
 * Never trust tenant IDs supplied by the browser.
 */
export function getUser(_request: FastifyRequest): RequestUser {
  if (config.NODE_ENV === "production") {
    throw new Error("Production authentication is not configured");
  }
  return {
    id: config.DEV_USER_ID,
    tenantId: config.DEV_TENANT_ID,
    roles: ["outreach:read", "outreach:send"]
  };
}
