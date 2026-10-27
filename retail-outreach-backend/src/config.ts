import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEMO_ORG_ID, DEMO_USER_ID } from "./data/seed.js";

const bool = z.enum(["true", "false", "1", "0"]).transform(v => v === "true" || v === "1");
const csv = z.string().transform(s => s.split(",").map(x => x.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Set when running behind a load balancer / reverse proxy so client IPs come from X-Forwarded-For. */
  TRUST_PROXY: bool.default("false"),
  /** Comma-separated list of allowed browser origins. "*" is rejected in production. */
  CORS_ORIGIN: csv.default("http://localhost:5173,http://127.0.0.1:5173"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  SEND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),

  /** supabase = verify Supabase access tokens; demo = everyone is the demo user (local dev only). */
  AUTH_MODE: z.enum(["supabase", "demo"]).default("demo"),
  SUPABASE_URL: z.string().url().optional(),
  /** Legacy HS256 JWT secret. If unset, tokens are verified against the project's JWKS (asymmetric keys). */
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default("authenticated"),
  DEMO_USER_ID: z.string().uuid().default(DEMO_USER_ID),
  DEMO_ORG_ID: z.string().uuid().default(DEMO_ORG_ID),
  /** Exposes POST /api/dev/reset. Never enabled in production. */
  ENABLE_DEMO_RESET: bool.optional(),

  /** memory = seeded in-process data (no infra needed); postgres = DATABASE_URL (Supabase or local). */
  DATA_STORE: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** PEM CA certificate (or path to one) for verified TLS to Postgres, e.g. Supabase's prod-ca-2021.crt. */
  DATABASE_CA_CERT: z.string().optional(),

  /** inline = send in the request; queue = BullMQ + `npm run worker` (needs Redis). */
  DELIVERY_MODE: z.enum(["inline", "queue"]).default("inline"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  SMS_PROVIDER: z.enum(["console"]).default("console"),
  EMAIL_PROVIDER: z.enum(["console"]).default("console"),
  BUSINESS_NAME: z.string().default("our store"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000)
}).superRefine((c, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (c.AUTH_MODE === "supabase" && !c.SUPABASE_URL) issue("SUPABASE_URL", "required when AUTH_MODE=supabase");
  if (c.DATA_STORE === "postgres" && !c.DATABASE_URL) issue("DATABASE_URL", "required when DATA_STORE=postgres");
  if (c.NODE_ENV === "production") {
    if (c.AUTH_MODE !== "supabase") issue("AUTH_MODE", "must be 'supabase' in production (demo auth is dev-only)");
    if (c.DATA_STORE !== "postgres") issue("DATA_STORE", "must be 'postgres' in production");
    if (c.ENABLE_DEMO_RESET) issue("ENABLE_DEMO_RESET", "must not be enabled in production");
    if (c.CORS_ORIGIN.includes("*")) issue("CORS_ORIGIN", "wildcard origins are not allowed in production");
    if (c.CORS_ORIGIN.some(o => !/^https:\/\//.test(o))) issue("CORS_ORIGIN", "production origins must be https://");
  }
}).transform(c => ({
  ...c,
  ENABLE_DEMO_RESET: c.ENABLE_DEMO_RESET ?? c.NODE_ENV !== "production",
  SUPABASE_URL: c.SUPABASE_URL?.replace(/\/+$/, ""),
  DATABASE_CA_CERT: c.DATABASE_CA_CERT && !c.DATABASE_CA_CERT.includes("BEGIN CERTIFICATE")
    ? readFileSync(c.DATABASE_CA_CERT, "utf8") : c.DATABASE_CA_CERT
}));

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings from .env as "unset" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Load config or exit(1) with a readable message. Used by entrypoints (fail fast on boot). */
export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return loadConfig(env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
