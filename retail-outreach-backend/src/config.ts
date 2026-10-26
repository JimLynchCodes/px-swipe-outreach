import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Comma-separated list of allowed browser origins. "*" allows any (dev only). */
  CORS_ORIGIN: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  /** memory = seeded in-process data (no infra needed); postgres = DATABASE_URL. */
  DATA_STORE: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().default("postgres://outreach:outreach@localhost:5432/outreach"),
  /** inline = send immediately in the request; queue = BullMQ + `npm run worker` (needs Redis). */
  DELIVERY_MODE: z.enum(["inline", "queue"]).default("inline"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  SMS_PROVIDER: z.enum(["console"]).default("console"),
  EMAIL_PROVIDER: z.enum(["console"]).default("console"),
  BUSINESS_NAME: z.string().default("our store"),
  DEV_USER_ID: z.string().default("demo-user"),
  DEV_TENANT_ID: z.string().default("demo-retailer")
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings from .env as "unset" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  return schema.parse(cleaned);
}

export const config = loadConfig();
