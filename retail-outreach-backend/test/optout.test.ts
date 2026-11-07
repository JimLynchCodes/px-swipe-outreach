import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { MemoryStore } from "../src/store/memory.js";
import { ConsoleMessageProvider } from "../src/providers/messaging.js";
import { twilioSignature, parseKeyword } from "../src/optout/twilio.js";
import { unsubscribeToken, verifyUnsubscribeToken } from "../src/optout/unsubscribe.js";
import { processDelivery } from "../src/delivery.js";
import { DEMO_ORG_ID } from "../src/data/seed.js";

const TOKEN = "twilio-auth-token-123456";
const API = "https://api.example.com";
const SECRET = "s".repeat(40);
const env = { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_API_URL: API, UNSUBSCRIBE_SIGNING_SECRET: SECRET };
const SMS_URL = `/webhooks/twilio/sms/${DEMO_ORG_ID}`;
const PRIYA = "+15555550003";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function sms(params: Record<string, string>, sig?: string) {
  return app.inject({
    method: "POST", url: SMS_URL, payload: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig ?? twilioSignature(TOKEN, `${API}${SMS_URL}`, params) }
  });
}
const optOuts = async (q = "") => (await app.inject(`/api/opt-outs${q}`)).json();

describe("keyword parsing", () => {
  it.each([["stop", "stop"], ["  StopAll ", "stop"], ["unsubscribe", "stop"], ["Cancel.", "stop"], ["END", "stop"], ["quit", "stop"],
    ["start", "start"], ["UNSTOP", "start"], ["help", "help"], ["stop texting me please", null], ["", null]])("%j → %j", (body, kw) => {
    expect(parseKeyword(body)).toBe(kw);
  });
});

describe("opt-out list", () => {
  it("lists seeded per-channel opt-outs with masked contact, filters, search and pagination", async () => {
    ({ app } = await makeApp());
    const all = await optOuts();
    expect(all.total).toBe(3);
    expect(all.items[0]).toMatchObject({ customerName: "Chris Ortiz", channel: "sms", source: "sms_stop", contact: "+15***08" });
    expect(JSON.stringify(all)).not.toMatch(/\+1555555|hannah@/);
    expect((await optOuts("?channel=email")).items.map((i: any) => i.source)).toEqual(["email_unsubscribe"]);
    expect((await optOuts("?q=fisch")).items.map((i: any) => i.customerName)).toEqual(["Ben Fischer"]);
    const p2 = await optOuts("?pageSize=2&page=2");
    expect(p2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(p2.items).toHaveLength(1);
    expect((await app.inject("/api/opt-outs?pageSize=1000")).statusCode).toBe(400);
  });

  it("opt-outs are per channel: Hannah unsubscribed from email can still get texts", async () => {
    ({ app } = await makeApp());
    const hannah = (await app.inject("/api/outreach/queue?limit=50")).json().items.find((i: any) => i.customer.firstName === "Hannah");
    expect(hannah.customer.contact).toMatchObject({ sms: true, email: false });
    const r = await app.inject({ method: "POST", url: `/api/outreach/${hannah.id}/send`, payload: { channel: "email", message: "Hi", idempotencyKey: "key-12345678" } });
    expect(r.statusCode).toBe(422);
    const ok = await app.inject({ method: "POST", url: `/api/outreach/${hannah.id}/send`, payload: { channel: "sms", message: "Hi", idempotencyKey: "key-12345679" } });
    expect(ok.statusCode).toBe(200);
  });

  it("the worker path re-checks only the delivery's channel", async () => {
    const store = new MemoryStore();
    const messenger = new ConsoleMessageProvider(() => {});
    const actor = { userId: "00000000-0000-4000-8000-000000000001", orgId: DEMO_ORG_ID };
    const { delivery } = await store.createDelivery(actor, "opp_0003", { channel: "sms", recipient: PRIYA, message: "Hi", subject: null, idempotencyKey: "k-123456789" });
    await store.addOptOut(DEMO_ORG_ID, "email", "priya@example.com", "email_unsubscribe");
    expect((await processDelivery(store, messenger, delivery.id)).status).toBe("sent");
    const { delivery: d2 } = await store.createDelivery(actor, "opp_0014", { channel: "sms", recipient: "+15555550014", message: "Hi", subject: null, idempotencyKey: "k-223456789" });
    await store.addOptOut(DEMO_ORG_ID, "sms", "+1 (555) 555-0014", "sms_stop");
    expect(await processDelivery(store, messenger, d2.id)).toMatchObject({ status: "failed", error: "recipient_suppressed" });
  });
});

describe("Twilio inbound SMS webhook", () => {
  it("rejects bad signatures when TWILIO_AUTH_TOKEN is set", async () => {
    ({ app } = await makeApp({ env }));
    expect((await sms({ From: PRIYA, Body: "STOP" }, "bogus")).statusCode).toBe(403);
    expect((await sms({ From: PRIYA, Body: "STOP" }, twilioSignature("wrong-token-1234567", `${API}${SMS_URL}`, { From: PRIYA, Body: "STOP" }))).statusCode).toBe(403);
  });

  it("STOP opts out SMS only, idempotently, logs to the thread and replies with compliant TwiML", async () => {
    ({ app } = await makeApp({ env }));
    const r = await sms({ From: PRIYA, Body: " stop ", MessageSid: "SM1" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/xml/);
    expect(r.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Cloud 9 Smoke Shop: You have been unsubscribed and will not receive any more messages. Reply START to resubscribe.</Message></Response>');
    await sms({ From: PRIYA, Body: "STOPALL" });
    const list = await optOuts("?q=Priya");
    expect(list.items).toEqual([expect.objectContaining({ channel: "sms", source: "sms_stop", customerName: "Priya Shah" })]);
    const card = (await app.inject("/api/outreach/opp_0003")).json();
    expect(card.customer.contact).toMatchObject({ sms: false, email: true });
    const conv = (await app.inject("/api/conversations")).json().conversations.find((c: any) => c.customerName === "Priya Shah");
    const thread = (await app.inject(`/api/conversations/${conv.id}`)).json();
    expect(thread.messages.slice(-4).map((m: any) => [m.direction, m.kind])).toEqual([["inbound", "opt_out"], ["outbound", "auto"], ["inbound", "opt_out"], ["outbound", "auto"]]);
    expect(thread.conversation.optedOut).toBe(true);
  });

  it("START re-subscribes, HELP answers, other text is stored as a reply with an empty TwiML response", async () => {
    ({ app } = await makeApp({ env }));
    await sms({ From: "+15555550008", Body: "UNSTOP" });
    expect((await optOuts("?q=Chris")).total).toBe(0);
    expect((await sms({ From: PRIYA, Body: "help" })).body).toContain("Reply STOP to opt out");
    const plain = await sms({ From: PRIYA, Body: "do you have blue razz?" });
    expect(plain.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const conv = (await app.inject("/api/conversations")).json().conversations[0];
    expect(conv).toMatchObject({ customerName: "Priya Shah", lastMessagePreview: "do you have blue razz?", lastDirection: "inbound" });
  });
});

describe("email unsubscribe", () => {
  it("tokens are signed and tamper-evident", () => {
    const t = unsubscribeToken(SECRET, "abc");
    expect(verifyUnsubscribeToken(SECRET, t)).toBe("abc");
    expect(verifyUnsubscribeToken(SECRET, t.replace("abc", "abd"))).toBeNull();
    expect(verifyUnsubscribeToken("other".repeat(10), t)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, "garbage")).toBeNull();
  });

  it("every email carries a unique link and RFC 8058 headers; GET confirms, POST opts out idempotently without leaking PII", async () => {
    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ env, messenger }));
    await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "email", message: "Hi Sarah", idempotencyKey: "key-12345678" } });
    await app.inject({ method: "POST", url: "/api/outreach/opp_0003/send", payload: { channel: "email", message: "Hi Priya", idempotencyKey: "key-22345678" } });
    const [a, b] = messenger.sent;
    expect(a.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const urlA = a.headers!["List-Unsubscribe"].slice(1, -1);
    expect(urlA.startsWith(`${API}/unsubscribe?t=`)).toBe(true);
    expect(urlA).not.toBe(b.headers!["List-Unsubscribe"].slice(1, -1));
    expect(a.message).toContain(`Unsubscribe: ${urlA}`);
    const path = urlA.slice(API.length);

    const get = await app.inject(path);
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain("Cloud 9 Smoke Shop");
    expect(get.body).not.toMatch(/sarah@example\.com/i);
    expect((await optOuts("?channel=email")).total).toBe(1); // GET alone never opts out (link scanners)

    for (let i = 0; i < 2; i++) {
      const post = await app.inject({ method: "POST", url: path, payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(post.statusCode).toBe(200);
      expect(post.body).toContain("unsubscribed");
    }
    const emails = await optOuts("?channel=email");
    expect(emails.total).toBe(2);
    expect(emails.items[0]).toMatchObject({ customerName: "Sarah Mitchell", source: "email_unsubscribe" });
    expect((await app.inject(`/api/outreach/opp_0001`)).json().customer.contact).toMatchObject({ email: false });
  });

  it("invalid tokens get a generic page", async () => {
    ({ app } = await makeApp({ env }));
    const r = await app.inject("/unsubscribe?t=00000000-0000-4000-8000-000000000000.nope");
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("invalid");
  });
});
