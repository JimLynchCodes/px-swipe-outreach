import type { FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.js";

/** Paths scrubbed from every log line: credentials and customer PII. */
export const REDACT_PATHS = [
  "req.headers.authorization", "req.headers.cookie", "req.headers[\"x-api-key\"]", "res.headers[\"set-cookie\"]",
  "*.phone", "*.email", "*.recipient", "*.message", "*.subject", "*.password", "*.token", "*.access_token",
  "*.refresh_token", "*.apiKey", "*.DATABASE_URL", "*.SUPABASE_JWT_SECRET"
];

export function loggerOptions(config: Pick<AppConfig, "LOG_LEVEL" | "NODE_ENV">): FastifyServerOptions["logger"] {
  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "px-outreach-backend", env: config.NODE_ENV },
    // Never log query strings verbatim: magic-link style tokens can show up there.
    serializers: {
      req: (req: any) => ({ method: req.method, url: String(req.url).split("?")[0], requestId: req.id, remoteAddress: req.ip }),
      res: (res: any) => ({ statusCode: res.statusCode })
    }
  };
}
