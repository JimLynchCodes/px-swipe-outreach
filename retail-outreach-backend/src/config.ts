import { MODEL_IDS } from "./ai/models.js";
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
  /** BACKEND SECRET. OpenRouter (default AI provider when set): OpenAI-compatible API at https://openrouter.ai/api/v1. */
  OPENROUTER_API_KEY: z.string().min(10).optional(),
  /** BACKEND SECRET. Direct OpenAI: optional fallback provider (or primary with AI_PROVIDER=openai). */
  OPENAI_API_KEY: z.string().optional(),
  /** openrouter | openai. Default: openrouter when OPENROUTER_API_KEY is set, else openai when OPENAI_API_KEY is set, else rules only. */
  AI_PROVIDER: z.enum(["openrouter", "openai"]).optional(),
  /** Fallback model when an org has none set (orgs pick theirs in Settings / the header). */
  OPENAI_MODEL: z.string().default("openai/gpt-4o-mini"),
  /** OpenRouter attribution (HTTP-Referer / X-Title headers). HTTP-Referer defaults to APP_URL. */
  OPENROUTER_APP_NAME: z.string().max(100).default("PX Swipe Outreach"),
  /** log = print only (dev); smtp = real email via Nodemailer. "console" is accepted as an alias for log. */
  EMAIL_PROVIDER: z.preprocess(v => (v === "console" ? "log" : v), z.enum(["log", "smtp"]).default("log")),
  /** log = print to the console/log only; twilio = real SMS via the official Twilio SDK. "console" is an alias for log. */
  SMS_PROVIDER: z.preprocess(v => (v === "console" ? "log" : v), z.enum(["log", "twilio"]).default("log")),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** TLS from the first byte (port 465). Defaults to true only for port 465; 587/1025 use STARTTLS/plain. */
  SMTP_SECURE: z.enum(["true", "false"]).optional(),
  SMTP_USER: z.string().optional(),
  /** BACKEND SECRET. SMTP password (e.g. a Gmail app password). */
  SMTP_PASS: z.string().optional(),
  /** From header, e.g. "Cloud 9 Smoke Shop <deals@example.com>". With Gmail it must be your Gmail address (or a verified alias). */
  SMTP_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/i, "must look like AC…").optional(),
  /** Twilio sender number in E.164 (+15551234567). Set this or TWILIO_MESSAGING_SERVICE_SID. */
  TWILIO_FROM_NUMBER: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be an E.164 number like +15551234567").optional(),
  /** Twilio Messaging Service SID (MG…); takes precedence over TWILIO_FROM_NUMBER. */
  TWILIO_MESSAGING_SERVICE_SID: z.string().regex(/^MG[0-9a-f]{32}$/i, "must look like MG…").optional(),
  /** Per-segment USD estimate used until Twilio reports the actual price ($0.0083 Twilio + ~$0.0042 carrier fee, US long code, Oct 2026). */
  TWILIO_SMS_PRICE_ESTIMATE: z.coerce.number().min(0).max(1).default(0.0125),
  /** Optional flat monthly phone-number fee (USD) added to each month with Twilio sends. 0 = off. Long code ≈ $1.15. */
  TWILIO_NUMBER_MONTHLY_FEE: z.coerce.number().min(0).max(1000).default(0),
  /** Ask Twilio to POST status callbacks (we then fetch the final price). Needs a public PUBLIC_API_URL. */
  TWILIO_STATUS_CALLBACKS: z.preprocess(v => v === undefined ? undefined : !["false", "0", "no", ""].includes(String(v).toLowerCase()), z.boolean().default(true)),
  /** Minutes between price reconcile runs (fetches prices still on an estimate). 0 = off. */
  TWILIO_RECONCILE_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
  BUSINESS_NAME: z.string().default("our store"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /** Public URL of the frontend; invite links point at `${APP_URL}/invite/accept?token=...`. */
  APP_URL: z.string().url().default("http://localhost:5173"),
  /** console = log the invite link (dev); supabase = Supabase Auth sends the email (needs the service role key). */
  INVITE_MAILER: z.enum(["console", "supabase"]).default("console"),
  /** BACKEND SECRET. Only used to call the Supabase Auth admin API for invites. Never expose to the frontend. */
  /** The secret key (sb_secret_…). SUPABASE_SERVICE_ROLE_KEY is the legacy alias (old service_role JWT); this one wins. */
  SUPABASE_SECRET_KEY: z.string().min(20).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /**
   * Comma-separated emails that are approved as owners on first sign-in (case-insensitive, confirmed email only).
   * With no membership yet they're added as owner of the default org (the oldest one, or BOOTSTRAP_ORG_NAME if none).
   */
  BOOTSTRAP_OWNER_EMAILS: z.string().optional().transform(v => [...new Set((v ?? "").split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes("@")))]),
  BOOTSTRAP_ORG_NAME: z.string().trim().min(1).max(200).default("My Store"),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
  INVITE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
  INVITE_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),

  /** Public base URL of this API (unsubscribe links, Twilio signature validation). */
  PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
  /** BACKEND SECRET. HMAC key for email unsubscribe links. Required in production. */
  UNSUBSCRIBE_SIGNING_SECRET: z.string().min(32).optional(),
  /** BACKEND SECRET. When set, inbound SMS webhooks must carry a valid X-Twilio-Signature. */
  TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
  /**
   * Texting a number that replied STOP is restricted (TCPA/CTIA): off by default, so SMS re-opt-in requests are refused.
   * Only enable after confirming with counsel that a one-time re-permission text is acceptable for your program.
   */
  ALLOW_SMS_REOPTIN_REQUEST: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  /** Domain whose mail is routed to the inbound email webhook; outbound email uses Reply-To: reply+<token>@domain. */
  INBOUND_EMAIL_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "must be a domain name").optional(),
  /** BACKEND SECRET. Required by the inbound email webhook (?key= or X-Inbound-Secret). */
  INBOUND_EMAIL_SECRET: z.string().min(24).optional(),

  // ── Data sync (src/sync). All BACKEND SECRETS; the UI only shows which names are missing. ──
  /** OpenAI admin key (Usage + Costs APIs) for the ai-usage sync. */
  OPENAI_ADMIN_KEY: z.string().min(10).optional(),
  /** OpenRouter provisioning key for /api/v1/activity (falls back to OPENROUTER_API_KEY). */
  OPENROUTER_PROVISIONING_KEY: z.string().min(10).optional(),
  /** Email tracking source beyond the send ledger. */
  EMAIL_EVENTS_PROVIDER: z.enum(["ledger", "sendgrid"]).default("ledger"),
  SENDGRID_API_KEY: z.string().min(10).optional(),
  /** Quickvee merchant portal login (the merchant's own account only). Never logged. */
  /** The "Store name" field on the Quickvee login page. */
  QUICKVEE_STORE_NAME: z.string().min(1).optional(),
  /** The "Username" field on the Quickvee login page. */
  QUICKVEE_USERNAME: z.string().min(1).optional(),
  /** @deprecated alias for QUICKVEE_USERNAME (older setups signed in with an email). */
  QUICKVEE_EMAIL: z.string().min(3).optional(),
  QUICKVEE_PASSWORD: z.string().min(1).optional(),
  QUICKVEE_BASE_URL: z.string().url().default("https://quickvee.com"),
  /** Scheduled orders sync: stop after this many orders per run (0/empty = all). The CLI uses --limit. */
  QUICKVEE_ORDER_LIMIT: z.preprocess(v => (v === "" ? undefined : v), z.coerce.number().int().min(0).default(0)),
  /** in-store (default), online, or both: which Orders Management tab(s) to crawl. */
  QUICKVEE_ORDER_CHANNEL: z.enum(["in-store", "online", "both"]).default("in-store"),
  /** Stop scrolling when no new order blocks appear for this long. */
  QUICKVEE_STALL_SECONDS: z.coerce.number().int().min(3).max(600).default(30),
  /** Session cookies + raw snapshots (gitignored; contains PII). */
  QUICKVEE_STATE_DIR: z.string().default(".quickvee"),
  QUICKVEE_HEADLESS: z.preprocess(v => v === undefined || v === "" ? undefined : !["false", "0", "no"].includes(String(v).toLowerCase()), z.boolean().default(true)),
  QUICKVEE_SAVE_RAW: z.preprocess(v => v === undefined || v === "" ? undefined : !["false", "0", "no"].includes(String(v).toLowerCase()), z.boolean().default(true)),
  /** Minimum gap between portal requests. */
  QUICKVEE_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1500),
  /** Days per orders window (export/crawl). */
  QUICKVEE_CHUNK_DAYS: z.coerce.number().int().min(1).max(366).default(7),
  /** Chromium binary for Playwright (Docker: /usr/bin/chromium-browser). Auto-detected when unset. */
  QUICKVEE_CHROMIUM_PATH: z.string().optional(),
  /** Run the DB-backed sync scheduler in this process (safe on several instances). */
  SYNC_SCHEDULER: z.preprocess(v => v === undefined || v === "" ? undefined : !["false", "0", "no"].includes(String(v).toLowerCase()), z.boolean().default(true)),
  SYNC_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60)
}).superRefine((c, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (c.AUTH_MODE === "supabase" && !c.SUPABASE_URL) issue("SUPABASE_URL", "required when AUTH_MODE=supabase");
  if (c.DATA_STORE === "postgres" && !c.DATABASE_URL) issue("DATABASE_URL", "required when DATA_STORE=postgres");
  if (c.INVITE_MAILER === "supabase") {
    if (!c.SUPABASE_URL) issue("SUPABASE_URL", "required when INVITE_MAILER=supabase");
    if (!c.SUPABASE_SERVICE_ROLE_KEY && !c.SUPABASE_SECRET_KEY) issue("SUPABASE_SECRET_KEY", "required when INVITE_MAILER=supabase (or the legacy SUPABASE_SERVICE_ROLE_KEY)");
  }
  if (c.EMAIL_PROVIDER === "smtp") {
    if (!c.SMTP_HOST) issue("SMTP_HOST", "required when EMAIL_PROVIDER=smtp");
    if (!c.SMTP_FROM) issue("SMTP_FROM", "required when EMAIL_PROVIDER=smtp");
    if (c.SMTP_USER && !c.SMTP_PASS) issue("SMTP_PASS", "required when SMTP_USER is set");
  }
  if (c.AI_PROVIDER === "openrouter" && !c.OPENROUTER_API_KEY) issue("OPENROUTER_API_KEY", "required when AI_PROVIDER=openrouter");
  if (c.AI_PROVIDER === "openai" && !c.OPENAI_API_KEY) issue("OPENAI_API_KEY", "required when AI_PROVIDER=openai");
  if (!MODEL_IDS.includes(c.OPENAI_MODEL)) issue("OPENAI_MODEL", `must be one of: ${MODEL_IDS.join(", ")}`);
  if (c.SMS_PROVIDER === "twilio") {
    if (!c.TWILIO_ACCOUNT_SID) issue("TWILIO_ACCOUNT_SID", "required when SMS_PROVIDER=twilio");
    if (!c.TWILIO_AUTH_TOKEN) issue("TWILIO_AUTH_TOKEN", "required when SMS_PROVIDER=twilio");
    if (!c.TWILIO_FROM_NUMBER && !c.TWILIO_MESSAGING_SERVICE_SID) issue("TWILIO_FROM_NUMBER", "set TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID when SMS_PROVIDER=twilio");
  }
  if (c.NODE_ENV === "production") {
    if (c.EMAIL_PROVIDER === "log") issue("EMAIL_PROVIDER", "must be 'smtp' in production ('log' sends nothing)");
    if (c.SMS_PROVIDER !== "twilio") issue("SMS_PROVIDER", "must be 'twilio' in production ('log' sends nothing)");
    if (c.EMAIL_PROVIDER === "smtp" && c.SMTP_HOST && /^(localhost|127\.|mailpit$)/i.test(c.SMTP_HOST)) issue("SMTP_HOST", "points at a local test server (Mailpit) in production");
    if (!c.UNSUBSCRIBE_SIGNING_SECRET) issue("UNSUBSCRIBE_SIGNING_SECRET", "required in production (signs email unsubscribe links)");
    if (!/^https:\/\//.test(c.PUBLIC_API_URL)) issue("PUBLIC_API_URL", "must be an https:// URL in production");
    if (c.INVITE_MAILER !== "supabase") issue("INVITE_MAILER", "must be 'supabase' in production (console logs invite links)");
    if (!/^https:\/\//.test(c.APP_URL)) issue("APP_URL", "must be an https:// URL in production");
    if (c.AUTH_MODE !== "supabase") issue("AUTH_MODE", "must be 'supabase' in production (demo auth is dev-only)");
    if (c.DATA_STORE !== "postgres") issue("DATA_STORE", "must be 'postgres' in production");
    if (c.ENABLE_DEMO_RESET) issue("ENABLE_DEMO_RESET", "must not be enabled in production");
    if (c.CORS_ORIGIN.includes("*")) issue("CORS_ORIGIN", "wildcard origins are not allowed in production");
    if (c.CORS_ORIGIN.some(o => !/^https:\/\//.test(o))) issue("CORS_ORIGIN", "production origins must be https://");
  }
}).transform(c => ({
  ...c,
  ENABLE_DEMO_RESET: c.ENABLE_DEMO_RESET ?? c.NODE_ENV !== "production",
  SUPABASE_SERVICE_ROLE_KEY: c.SUPABASE_SECRET_KEY ?? c.SUPABASE_SERVICE_ROLE_KEY,
  QUICKVEE_USERNAME: c.QUICKVEE_USERNAME ?? c.QUICKVEE_EMAIL,
  SUPABASE_URL: c.SUPABASE_URL?.replace(/\/+$/, ""),
  APP_URL: c.APP_URL.replace(/\/+$/, ""),
  PUBLIC_API_URL: c.PUBLIC_API_URL.replace(/\/+$/, ""),
  SMTP_SECURE: c.SMTP_SECURE ? c.SMTP_SECURE === "true" : c.SMTP_PORT === 465,
  // Dev/test only (production requires a real secret, enforced above).
  UNSUBSCRIBE_SIGNING_SECRET: c.UNSUBSCRIBE_SIGNING_SECRET ?? "dev-only-insecure-unsubscribe-signing-secret",
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
