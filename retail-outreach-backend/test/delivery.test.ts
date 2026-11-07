import { afterEach, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { DEMO_ORG_ID } from "../src/data/seed.js";
import { httpSimulatorSink, simulatorKey, SmsSimulator, twimlMessages } from "../src/dev/simulator.js";
import { createMessageProvider, SmtpEmailProvider, TwilioSmsProvider } from "../src/providers/messaging.js";

let app: FastifyInstance | undefined;
let smtp: SMTPServer | undefined;
afterEach(async () => { await app?.close(); app = undefined; await new Promise<void>(r => (smtp ? smtp.close(() => r()) : r())); smtp = undefined; });

const API = "http://localhost:3000";
const optOuts = async (q = "") => (await app!.inject(`/api/opt-outs${q}`)).json();
const action = (html: string) => /action="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");

/** A real local SMTP server (smtp-server, the library Mailpit-like tools are built on) that captures raw messages. */
async function startSmtp() {
  const inbox: Array<{ from: string; to: string[]; raw: string }> = [];
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", c => (raw += c));
      stream.on("end", () => { inbox.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map(r => r.address), raw }); cb(); });
    }
  });
  await new Promise<void>(r => smtp!.listen(0, "127.0.0.1", () => r()));
  return { port: (smtp.server.address() as AddressInfo).port, inbox };
}
const header = (raw: string, name: string) => {
  const unfolded = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  return new RegExp(`^${name}: (.*)$`, "im").exec(unfolded)?.[1]?.trim();
};

describe("EMAIL_PROVIDER=smtp (Nodemailer)", () => {
  it("passes Reply-To and List-Unsubscribe through as real headers", async () => {
    const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const p = new SmtpEmailProvider({ host: "x", port: 1, secure: false, from: "Cloud 9 <deals@cloud9.test>" }, t);
    const sent: string[] = [];
    const orig = t.sendMail.bind(t);
    t.sendMail = (async (m: Parameters<typeof orig>[0]) => { const info = await orig(m); sent.push(String((info as { message: Buffer }).message)); return info; }) as typeof t.sendMail;
    await p.send({ channel: "email", recipient: "sarah@example.com", subject: "Hi", message: "Body",
      headers: { "List-Unsubscribe": "<https://api/unsub?t=1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "Reply-To": "reply+tok@in.test" } });
    expect(header(sent[0], "List-Unsubscribe")).toBe("<https://api/unsub?t=1>");
    expect(header(sent[0], "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    expect(header(sent[0], "Reply-To")).toBe("reply+tok@in.test");
    expect(header(sent[0], "From")).toBe("Cloud 9 <deals@cloud9.test>");
    await expect(p.send({ channel: "sms", recipient: "+1555", message: "x" })).rejects.toThrow(/only sends email/);
  });

  it("end to end over real SMTP: send from the deck → email arrives → one-click unsubscribe → Opt-out list → resubscribe", async () => {
    const { port, inbox } = await startSmtp();
    const env = { EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_FROM: "Cloud 9 <deals@cloud9.test>", PUBLIC_API_URL: API, NODE_ENV: "development" };
    const config = loadConfig(env);
    ({ app } = await makeApp({ env, messenger: createMessageProvider(config) }));
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "email", message: "Hi Sarah, 20% off CBD today", subject: "A deal for you", idempotencyKey: "smtp-key-0001" } });
    expect(r.json()).toMatchObject({ status: "sent" });
    expect(inbox).toHaveLength(1);
    const mail = inbox[0];
    expect(mail.to).toEqual(["sarah@example.com"]);
    expect(header(mail.raw, "Subject")).toBe("A deal for you");
    expect(header(mail.raw, "Reply-To")).toMatch(/^reply\+[\w-]+@reply\.localhost$/);
    const unsub = header(mail.raw, "List-Unsubscribe")!.slice(1, -1);
    expect(unsub.startsWith(`${API}/unsubscribe?t=`)).toBe(true);
    expect(mail.raw.replace(/=\r?\n/g, "")).toContain("Unsubscribe:");

    const path = unsub.slice(API.length);
    expect((await app.inject(path)).statusCode).toBe(200);
    const done = await app.inject({ method: "POST", url: path, payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(done.statusCode).toBe(200);
    expect((await optOuts("?channel=email")).items.some((i: { customerName: string }) => i.customerName === "Sarah Mitchell")).toBe(true);
    const again = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "email", message: "x", idempotencyKey: "smtp-key-0002" } });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect(inbox).toHaveLength(1); // suppressed: nothing sent

    expect((await app.inject({ method: "POST", url: action(done.body) })).statusCode).toBe(200);
    expect((await optOuts("?channel=email")).items.some((i: { customerName: string }) => i.customerName === "Sarah Mitchell")).toBe(false);

    // Dev "simulate reply": paste the Reply-To address → lands in the Replies thread.
    const sim = await app.inject({ method: "POST", url: "/api/dev/sim/email-reply", payload: { to: header(mail.raw, "Reply-To"), from: "sarah@example.com", text: "Is this still on?" } });
    expect(sim.json()).toEqual({ ok: true, matched: true });
    const convs = (await app.inject("/api/conversations")).json();
    const sarah = (convs.items ?? convs.conversations).find((c: { channel: string; contactLabel?: string; name?: string; customerName?: string }) => c.channel === "email" && /Sarah/.test(JSON.stringify(c)));
    expect(sarah).toBeTruthy();
    expect(JSON.stringify((await app.inject(`/api/conversations/${sarah.id}`)).json())).toContain("Is this still on?");
    const spoof = await app.inject({ method: "POST", url: "/api/dev/sim/email-reply", payload: { to: header(mail.raw, "Reply-To"), from: "mallory@example.com", text: "hi" } });
    expect(spoof.json()).toMatchObject({ matched: false });
  });
});

describe("SMS_PROVIDER=twilio (optional, paid)", () => {
  it("posts to the Messages API with basic auth and surfaces errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }); }) as unknown as typeof fetch;
    const sid = `AC${"a".repeat(32)}`;
    const p = new TwilioSmsProvider({ accountSid: sid, authToken: "tok", from: "+15550001111" }, ok);
    expect(await p.send({ channel: "sms", recipient: "+15555550001", message: "Hi" })).toEqual({ providerMessageId: "SM123" });
    expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${sid}:tok`).toString("base64")}`);
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({ To: "+15555550001", Body: "Hi", From: "+15550001111" });
    const mg = new TwilioSmsProvider({ accountSid: sid, authToken: "tok", from: `MG${"b".repeat(32)}` }, ok);
    await mg.send({ channel: "sms", recipient: "+1", message: "x" });
    expect((calls[1].init.body as URLSearchParams).get("MessagingServiceSid")).toBe(`MG${"b".repeat(32)}`);
    const bad = new TwilioSmsProvider({ accountSid: sid, authToken: "tok", from: "+1" },
      (async () => new Response(JSON.stringify({ code: 21211, message: "Invalid To" }), { status: 400 })) as unknown as typeof fetch);
    await expect(bad.send({ channel: "sms", recipient: "+1", message: "x" })).rejects.toThrow("Twilio send failed (400 21211): Invalid To");
  });
});

describe("SMS_PROVIDER=simulator (dev phone)", () => {
  async function simApp(extra: Record<string, string> = {}) {
    const env = { SMS_PROVIDER: "simulator", NODE_ENV: "development", PUBLIC_API_URL: API, ...extra };
    const simulator = new SmsSimulator();
    const messenger = createMessageProvider(loadConfig(env), { simulatorSink: simulator.sink });
    const made = await makeApp({ env, messenger });
    // makeApp builds its own simulator; rebuild with ours so the page and the provider share it.
    await made.app.close();
    const { buildApp } = await import("../src/app.js");
    const { RulesSuggestionProvider } = await import("../src/providers/ai.js");
    app = await buildApp({ config: made.config, store: made.store, suggestions: new RulesSuggestionProvider(), messenger, simulator, logger: false });
    return { simulator, store: made.store };
  }
  const threads = async () => (await app!.inject("/api/dev/sim/threads")).json().threads as Array<{ phone: string; orgId: string; messages: Array<{ direction: string; body: string; auto?: boolean }> }>;
  const reply = (body: string, from = "+15555550001") => app!.inject({ method: "POST", url: "/api/dev/sim/sms-reply", payload: { from, body } });

  it("deck send shows on the phone; STOP opts out through the real webhook; START opts back in; HELP/text answered", async () => {
    await simApp();
    const page = await app!.inject("/dev/phone");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Dev phone");
    expect((await app!.inject("/dev/phone.js")).headers["content-type"]).toContain("javascript");

    const r = await app!.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "sms", message: "Hi Sarah! 20% off CBD", idempotencyKey: "sim-key-0001" } });
    expect(r.json()).toMatchObject({ status: "sent" });
    const [t] = await threads();
    expect(t).toMatchObject({ phone: "+15555550001", orgId: DEMO_ORG_ID });
    expect(t.messages[0]).toMatchObject({ direction: "outbound", body: "Hi Sarah! 20% off CBD\nReply STOP to opt out." });

    const stop = (await reply("STOP")).json();
    expect(stop.status).toBe(200);
    expect(stop.replies[0]).toMatch(/unsubscribed/i);
    expect((await optOuts("?channel=sms")).items.some((i: { customerName: string }) => i.customerName === "Sarah Mitchell")).toBe(true);
    const blocked = await app!.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "sms", message: "again", idempotencyKey: "sim-key-0002" } });
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);

    expect((await reply("START")).json().replies[0]).toMatch(/subscribed|welcome|back/i);
    expect((await optOuts("?channel=sms")).items.some((i: { customerName: string }) => i.customerName === "Sarah Mitchell")).toBe(false);
    expect((await reply("HELP")).json().replies[0]).toMatch(/STOP/);
    expect((await reply("Is the CBD deal on today?")).json()).toEqual({ status: 200, replies: [] });

    const msgs = (await threads())[0].messages;
    expect(msgs.filter(m => m.direction === "inbound").map(m => m.body)).toEqual(["STOP", "START", "HELP", "Is the CBD deal on today?"]);
    expect(msgs.filter(m => m.auto).length).toBe(3);
    // The free-text reply also lands in the Replies inbox (same webhook code path).
    expect(JSON.stringify((await app!.inject("/api/conversations")).json())).toContain("Is the CBD deal on today?");
  });

  it("works when the webhook enforces X-Twilio-Signature (the simulator signs like Twilio)", async () => {
    await simApp({ TWILIO_AUTH_TOKEN: "t".repeat(32) });
    expect((await reply("STOP")).json().status).toBe(200);
    expect((await optOuts("?channel=sms")).items.length).toBeGreaterThan(0);
    const unsigned = await app!.inject({ method: "POST", url: `/webhooks/twilio/sms/${DEMO_ORG_ID}`, payload: "From=%2B15555550001&Body=START", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(unsigned.statusCode).toBe(403);
  });

  it("the worker's HTTP sink needs the simulator key", async () => {
    const { simulator } = await simApp();
    const config = loadConfig({ NODE_ENV: "test", SMS_PROVIDER: "simulator", PUBLIC_API_URL: API });
    const viaInject = (async (url: string, init: RequestInit) => {
      const res = await app!.inject({ method: "POST", url: url.slice(API.length), headers: init.headers as Record<string, string>, payload: String(init.body) });
      return new Response(res.body, { status: res.statusCode });
    }) as unknown as typeof fetch;
    await httpSimulatorSink(config, viaInject)({ orgId: DEMO_ORG_ID, to: "+15555550009", body: "from the worker" });
    expect(simulator.get("+15555550009")!.messages[0].body).toBe("from the worker");
    const bad = await app!.inject({ method: "POST", url: "/api/dev/sim/outbound", payload: { orgId: null, to: "+1555", body: "x" }, headers: { "x-simulator-key": "nope" } });
    expect(bad.statusCode).toBe(403);
    expect(simulatorKey(config)).toMatch(/^[0-9a-f]{64}$/);
    await expect(httpSimulatorSink(config, (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch)({ orgId: null, to: "+1", body: "x" })).rejects.toThrow(/rejected/);
  });

  it("parses TwiML replies", () => {
    expect(twimlMessages("<Response><Message>a &amp; b &lt;3</Message></Response>")).toEqual(["a & b <3"]);
    expect(twimlMessages("<Response/>")).toEqual([]);
  });
});

describe("dev tools are never exposed in production", () => {
  it("404s /dev/phone and the simulator API", async () => {
    const env = {
      NODE_ENV: "production", AUTH_MODE: "supabase", SUPABASE_URL: "https://abc.supabase.co", DATA_STORE: "postgres", DATABASE_URL: "postgres://u:p@db/x",
      CORS_ORIGIN: "https://app.example.com", APP_URL: "https://app.example.com", INVITE_MAILER: "supabase", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests-only",
      UNSUBSCRIBE_SIGNING_SECRET: "x".repeat(40), PUBLIC_API_URL: "https://api.example.com",
      EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.gmail.com", SMTP_USER: "a@gmail.com", SMTP_PASS: "p", SMTP_FROM: "a@gmail.com",
      SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "t".repeat(32), TWILIO_FROM: "+15551234567"
    };
    ({ app } = await makeApp({ env }));
    expect((await app.inject("/dev/phone")).statusCode).not.toBe(200);
    const r = await app.inject({ method: "POST", url: "/api/dev/sim/sms-reply", payload: { from: "+15555550001", body: "STOP" } });
    expect(r.statusCode).not.toBe(200);
  });
});
