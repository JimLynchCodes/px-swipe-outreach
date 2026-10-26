import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("postgres://outreach:outreach@localhost:5432/outreach"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  DEV_USER_ID: z.string().default("demo-user"),
  DEV_TENANT_ID: z.string().default("demo-retailer")
});

export const config = schema.parse(process.env);
