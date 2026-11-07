import { afterEach, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { DEMO_ORG_ID } from "../src/data/seed.js";
import { twilioSignature } from "../src/optout/twilio.js";
import { ConsoleMessageProvider, createMessageProvider, SmtpEmailProvider, TwilioSmsProvider } from "../src/providers/messaging.js";

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
    const env = { EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_FROM: "Cloud 9 <deals@cloud9.test>", PUBLIC_API_URL: API, NODE_ENV: "development",
      INBOUND_EMAIL_DOMAIN: "in.cloud9.test", INBOUND_EMAIL_SECRET: "s".repeat(32) };
    const config = loadConfig(env);
    ({ app } = await makeApp({ env, messenger: createMessageProvider(config) }));
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "email", message: "Hi Sarah, 20% off CBD today", subject: "A deal for you", idempotencyKey: "smtp-key-0001" } });
    expect(r.json()).toMatchObject({ status: "sent" });
    expect(inbox).toHaveLength(1);
    const mail = inbox[0];
    expect(mail.to).toEqual(["sarah@example.com"]);
    expect(header(mail.raw, "Subject")).toBe("A deal for you");
    expect(header(mail.raw, "Reply-To")).toMatch(/^reply\+[\w-]+@in\.cloud9\.test$/);
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

    // A customer reply to the Reply-To address (as an inbound-parse provider would post it) lands in the Replies thread.
    const inbound = (from: string, text: string) => app!.inject({ method: "POST", url: `/webhooks/email/inbound?key=${"s".repeat(32)}`, payload: { to: header(mail.raw, "Reply-To"), from, text, subject: "Re: A deal for you" } });
    const sim = await inbound("sarah@example.com", "Is this still on?");
    expect(sim.json()).toEqual({ ok: true, matched: true });
    const convs = (await app.inject("/api/conversations")).json();
    const sarah = (convs.items ?? convs.conversations).find((c: { channel: string; contactLabel?: string; name?: string; customerName?: string }) => c.channel === "email" && /Sarah/.test(JSON.stringify(c)));
    expect(sarah).toBeTruthy();
    expect(JSON.stringify((await app.inject(`/api/conversations/${sarah.id}`)).json())).toContain("Is this still on?");
    const spoof = await inbound("mallory@example.com", "hi");
    expect(spoof.json()).toMatchObject({ matched: false });
  });
});

describe("SMS_PROVIDER=log", () => {
  it("prints the message clearly instead of sending", async () => {
    const lines: string[] = [];
    const p = createMessageProvider(loadConfig({ NODE_ENV: "test" }), { log: l => lines.push(l) });
    await p.send({ channel: "sms", recipient: "+15555550001", message: "Hi Sarah" });
    expect(lines[0]).toBe('[LOG SMS] to=+15***01 body="Hi Sarah"');
    expect(p.name).toBe("email:console,sms:console");
    expect(new ConsoleMessageProvider(() => {}).name).toBe("console");
  });
});

describe("SMS_PROVIDER=twilio (official SDK)", () => {
  const fake = () => {
    const calls: unknown[] = [];
    return { calls, client: { messages: { create: async (p: unknown) => { calls.push(p); return { sid: "SM123" }; } } } };
  };
  it("sends from the number, or via a Messaging Service when set", async () => {
    const a = fake();
    const p = new TwilioSmsProvider({ accountSid: "AC1", authToken: "t", fromNumber: "+15550001111" }, a.client);
    expect(await p.send({ channel: "sms", recipient: "+15555550001", message: "Hi" })).toEqual({ providerMessageId: "SM123", provider: "twilio", segments: 1, priceUsd: null });
    expect(a.calls[0]).toEqual({ to: "+15555550001", body: "Hi", from: "+15550001111" });
    const b = fake();
    await new TwilioSmsProvider({ accountSid: "AC1", authToken: "t", fromNumber: "+15550001111", messagingServiceSid: "MGx" }, b.client).send({ channel: "sms", recipient: "+1", message: "x" });
    expect(b.calls[0]).toEqual({ to: "+1", body: "x", messagingServiceSid: "MGx" });
    await expect(p.send({ channel: "email", recipient: "a@b.c", message: "x" })).rejects.toThrow(/only sends SMS/);
  });
  it("surfaces SDK errors as a failed delivery (502) without crashing", async () => {
    const client = { messages: { create: async () => { throw Object.assign(new Error("The 'To' number is not a valid phone number."), { code: 21211 }); } } };
    const messenger = new TwilioSmsProvider({ accountSid: "AC1", authToken: "t", fromNumber: "+1555" }, client);
    ({ app } = await makeApp({ messenger }));
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "sms", message: "Hi", idempotencyKey: "tw-key-00001" } });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ status: "failed", code: "provider_error" });
  });
  it("createMessageProvider builds the real SDK client from config", () => {
    const c = loadConfig({ NODE_ENV: "test", SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "t".repeat(32), TWILIO_FROM_NUMBER: "+15551234567" });
    expect(createMessageProvider(c).name).toBe("email:console,sms:twilio");
  });
});

describe("inbound STOP/START through a public tunnel URL", () => {
  it("validates X-Twilio-Signature against PUBLIC_API_URL (not the local host) and updates the Opt-out list", async () => {
    const TUNNEL = "https://cloud9-dev.trycloudflare.com";
    const token = "t".repeat(32);
    ({ app } = await makeApp({ env: { PUBLIC_API_URL: TUNNEL, TWILIO_AUTH_TOKEN: token } }));
    const path = `/webhooks/twilio/sms/${DEMO_ORG_ID}`;
    const post = (Body: string, signUrl: string) => {
      const params = { From: "+15555550001", To: "+15550001111", Body, MessageSid: "SM1", AccountSid: "AC1" };
      return app!.inject({ method: "POST", url: path, payload: new URLSearchParams(params).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, signUrl, params) } });
    };
    expect((await post("STOP", `http://localhost:3000${path}`)).statusCode).toBe(403); // signed for the wrong URL
    const stop = await post("STOP", `${TUNNEL}${path}`);
    expect(stop.statusCode).toBe(200);
    expect(stop.body).toMatch(/<Message>.*unsubscribed/i);
    const sarah = async () => (await optOuts("?channel=sms")).items.find((i: { customerName: string }) => i.customerName === "Sarah Mitchell");
    expect(await sarah()).toMatchObject({ source: "sms_stop" });
    expect((await post("START", `${TUNNEL}${path}`)).body).toMatch(/resubscribed/i);
    expect(await sarah()).toBeUndefined();
  });
});
