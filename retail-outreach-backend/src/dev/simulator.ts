/**
 * DEV-ONLY delivery tools (never registered in production):
 *  - SMS simulator: SMS_PROVIDER=simulator stores outbound texts here instead of sending; /dev/phone shows them per number
 *    and lets you reply. Replies go through the real Twilio webhook route (same code path, signed if TWILIO_AUTH_TOKEN is set).
 *  - Email "simulate reply": threads a reply by its Reply-To address through the same code as the inbound email webhook.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { DEMO_ORG_ID } from "../data/seed.js";
import { TWILIO_WEBHOOK_PREFIX } from "../optout/routes.js";
import { twilioSignature } from "../optout/twilio.js";
import { ingestInboundEmail } from "../replies/routes.js";
import type { SimulatorSink } from "../providers/messaging.js";
import type { OutreachStore } from "../store/types.js";
import { PHONE_HTML, PHONE_JS } from "./phonePage.js";

export const DEV_PHONE_PATH = "/dev/phone";
export const DEV_API_PREFIX = "/api/dev/sim/";
export const isDevToolPath = (p: string) => p === DEV_PHONE_PATH || p === `${DEV_PHONE_PATH}.js` || p.startsWith(DEV_API_PREFIX);

export type SimMessage = { id: string; direction: "outbound" | "inbound"; body: string; at: string; auto?: boolean };
export type SimThread = { phone: string; orgId: string; messages: SimMessage[] };

export class SmsSimulator {
  private threads = new Map<string, SimThread>();
  private thread(phone: string, orgId: string | null) {
    const t = this.threads.get(phone) ?? { phone, orgId: orgId ?? DEMO_ORG_ID, messages: [] };
    if (orgId) t.orgId = orgId;
    this.threads.set(phone, t);
    return t;
  }
  add(phone: string, orgId: string | null, m: Omit<SimMessage, "id" | "at">) {
    const msg = { ...m, id: randomUUID(), at: new Date().toISOString() };
    const t = this.thread(phone, orgId);
    t.messages.push(msg);
    if (t.messages.length > 200) t.messages.shift();
    return msg;
  }
  get(phone: string) { return this.threads.get(phone); }
  list() {
    return [...this.threads.values()].sort((a, b) => (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? ""));
  }
  /** In-process sink for the API's SimulatorSmsProvider. */
  sink: SimulatorSink = async m => this.add(m.to, m.orgId, { direction: "outbound", body: m.body }).id;
}

/** Key the worker uses to post simulator texts to the API (derived from a backend secret both processes share). */
export const simulatorKey = (config: AppConfig) => createHmac("sha256", config.UNSUBSCRIBE_SIGNING_SECRET).update("sms-simulator").digest("hex");

/** Sink for the worker process: posts each text to the API that serves /dev/phone. */
export function httpSimulatorSink(config: AppConfig, fetchImpl: typeof fetch = fetch): SimulatorSink {
  const base = (config.SMS_SIMULATOR_URL ?? config.PUBLIC_API_URL).replace(/\/+$/, "");
  return async m => {
    const res = await fetchImpl(`${base}${DEV_API_PREFIX}outbound`, {
      method: "POST", headers: { "content-type": "application/json", "x-simulator-key": simulatorKey(config) }, body: JSON.stringify(m)
    });
    if (!res.ok) throw new Error(`SMS simulator rejected the message (${res.status})`);
    return ((await res.json()) as { id: string }).id;
  };
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
export const twimlMessages = (xml: string) => [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map(m => unescapeXml(m[1]));

export function devToolRoutes(app: FastifyInstance, deps: { config: AppConfig; store: OutreachStore; simulator: SmsSimulator }) {
  const { config, store, simulator } = deps;
  if (config.NODE_ENV === "production") return; // belt and braces: config already refuses log/simulator in production

  app.get(DEV_PHONE_PATH, async (_req, reply) => reply.type("text/html; charset=utf-8").send(PHONE_HTML));
  app.get(`${DEV_PHONE_PATH}.js`, async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(PHONE_JS));

  app.get(`${DEV_API_PREFIX}status`, async () => ({ smsProvider: config.SMS_PROVIDER, emailProvider: config.EMAIL_PROVIDER, inboundEmailDomain: config.INBOUND_EMAIL_DOMAIN ?? null }));
  app.get(`${DEV_API_PREFIX}threads`, async () => ({ threads: simulator.list() }));

  app.post(`${DEV_API_PREFIX}outbound`, async (request, reply) => {
    if (request.headers["x-simulator-key"] !== simulatorKey(config)) return reply.code(403).send({ error: "Bad simulator key", code: "forbidden" });
    const m = z.object({ orgId: z.string().uuid().nullable(), to: z.string().min(3).max(40), body: z.string().max(2000) }).parse(request.body);
    return { id: await simulator.sink(m) };
  });

  /** "Customer" replies from the dev phone → the real Twilio webhook route → TwiML auto-reply shown back on the phone. */
  app.post(`${DEV_API_PREFIX}sms-reply`, { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async request => {
    const b = z.object({ from: z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone number"), body: z.string().trim().min(1).max(1600), orgId: z.string().uuid().optional() }).parse(request.body);
    const orgId = b.orgId ?? simulator.get(b.from)?.orgId ?? DEMO_ORG_ID;
    simulator.add(b.from, orgId, { direction: "inbound", body: b.body });
    const path = `${TWILIO_WEBHOOK_PREFIX}${orgId}`;
    const params = { From: b.from, To: "+15550000000", Body: b.body, MessageSid: `SMsim${randomUUID().replace(/-/g, "")}`, AccountSid: "ACsimulator" };
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (config.TWILIO_AUTH_TOKEN) headers["x-twilio-signature"] = twilioSignature(config.TWILIO_AUTH_TOKEN, `${config.PUBLIC_API_URL}${path}`, params);
    const res = await app.inject({ method: "POST", url: path, headers, payload: new URLSearchParams(params).toString() });
    const replies = res.statusCode === 200 ? twimlMessages(res.body) : [];
    for (const r of replies) simulator.add(b.from, orgId, { direction: "outbound", body: r, auto: true });
    return { status: res.statusCode, replies };
  });

  /** Dev stand-in for an inbound email provider: paste the Reply-To address from Mailpit, the customer's email and a reply. */
  app.post(`${DEV_API_PREFIX}email-reply`, { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async request => {
    const b = z.object({ to: z.string().min(3).max(320), from: z.string().email(), text: z.string().trim().min(1).max(20_000), subject: z.string().max(300).optional() }).parse(request.body);
    return ingestInboundEmail(store, { to: b.to, from: b.from, text: b.text, subject: b.subject ?? "Re: your message" }, m => request.log.warn(m));
  });
}
