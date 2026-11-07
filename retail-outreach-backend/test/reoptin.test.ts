import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { fakeSupabase, makeApp } from "./helpers.js";
import { MemoryStore } from "../src/store/memory.js";
import { ConsoleMessageProvider, type MessageProvider } from "../src/providers/messaging.js";
import { twilioSignature, parseKeyword } from "../src/optout/twilio.js";
import { purposeToken, unsubscribeToken } from "../src/optout/unsubscribe.js";
import { DEMO_ORG, DEMO_ORG_ID } from "../src/data/seed.js";

const TOKEN = "twilio-auth-token-123456";
const API = "https://api.example.com";
const SECRET = "s".repeat(40);
const env = { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_API_URL: API, UNSUBSCRIBE_SIGNING_SECRET: SECRET };
const SMS_URL = `/webhooks/twilio/sms/${DEMO_ORG_ID}`;
const form = { "content-type": "application/x-www-form-urlencoded" };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

const sms = (params: Record<string, string>) => app.inject({
  method: "POST", url: SMS_URL, payload: new URLSearchParams(params).toString(),
  headers: { ...form, "x-twilio-signature": twilioSignature(TOKEN, `${API}${SMS_URL}`, params) }
});
const optOuts = async (q = "") => (await app.inject(`/api/opt-outs${q}`)).json();
const entry = async (name: string) => (await optOuts()).items.find((i: any) => i.customerName?.startsWith(name));
const history = async (id: string) => (await app.inject(`/api/opt-outs/${id}/history`)).json().events;
const action = (html: string) => html.match(/action="([^"]+)"/)![1].replace(/&amp;/g, "&");

describe("email: resubscribe from the unsubscribe confirmation", () => {
  it("POST-only, purpose-signed, idempotent, no PII; recorded in consent history", async () => {
    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ env, messenger }));
    await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "email", message: "Hi Sarah", idempotencyKey: "key-12345678" } });
    const path = messenger.sent[0].headers!["List-Unsubscribe"].slice(1, -1).slice(API.length);
    const done = await app.inject({ method: "POST", url: path });
    expect(done.body).toContain("Changed your mind?");
    expect(done.body).toContain("Resubscribe");
    expect(done.body).not.toMatch(/sarah@example\.com/i);
    const sarah = await entry("Sarah");
    expect(sarah).toBeTruthy();
    const ev = await history(sarah.id);
    expect(ev[0]).toMatchObject({ event: "opt_out", source: "email_unsubscribe", channel: "email" });
    expect(ev[0].requestId).toBeTruthy();

    const resub = action(done.body);
    expect(resub.startsWith("/resubscribe?t=")).toBe(true);
    expect((await app.inject(resub)).statusCode).toBe(404); // no GET handler: link scanners can't resubscribe
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: "POST", url: resub });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("resubscribed");
      expect(r.body).not.toMatch(/sarah@example\.com/i);
    }
    expect(await entry("Sarah")).toBeUndefined(); // resubscribed customers drop off the list
    expect((await app.inject("/api/outreach/opp_0001")).json().customer.contact.email).toBe(true);
  });

  it("an unsubscribe token can't be replayed as a resubscribe token", async () => {
    ({ app } = await makeApp({ env }));
    const r = await app.inject({ method: "POST", url: `/resubscribe?t=${encodeURIComponent(unsubscribeToken(SECRET, "abc"))}` });
    expect(r.statusCode).toBe(400);
  });
});

describe("SMS: START / UNSTOP / JOIN", () => {
  it("JOIN resubscribes and the consent log carries the MessageSid", async () => {
    expect(parseKeyword(" join ")).toBe("start");
    ({ app } = await makeApp({ env }));
    const chris = await entry("Chris");
    const r = await sms({ From: "+15555550008", Body: "JOIN", MessageSid: "SM123" });
    expect(r.body).toContain("resubscribed");
    expect(await entry("Chris")).toBeUndefined();
    await sms({ From: "+15555550008", Body: "stop", MessageSid: "SM124" });
    const again = await entry("Chris");
    const ev = await history(again.id);
    expect(ev.map((e: any) => `${e.event}:${e.source}:${e.requestId}`)).toEqual(["opt_out:sms_stop:SM124", "opt_in:sms_start:SM123", "opt_out:sms_stop:null"]);
    expect(chris.id).not.toBe(again.id);
  });
});

describe("re-opt-in requests", () => {
  it("email: sends one signed confirmation link; GET confirms only, POST resubscribes; pending blocks a second request", async () => {
    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ env, messenger }));
    const hannah = await entry("Hannah");
    const r = await app.inject({ method: "POST", url: `/api/opt-outs/${hannah.id}/reopt-in` });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ channel: "email", status: "pending" });
    expect(messenger.sent).toHaveLength(1);
    const mail = messenger.sent[0];
    expect(mail).toMatchObject({ channel: "email" });
    expect(mail.message).toMatch(/stay unsubscribed/);
    const link = mail.message.match(/https:\/\/api\.example\.com(\/reopt-in\?t=\S+)/)![1];

    const dup = await app.inject({ method: "POST", url: `/api/opt-outs/${hannah.id}/reopt-in` });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("reoptin_pending");
    expect((await entry("Hannah")).reoptIn).toMatchObject({ status: "pending" });
    expect((await history(hannah.id))[0]).toMatchObject({ event: "reoptin_requested", source: "store_request" });

    const page = await app.inject(link);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Resubscribe?");
    expect(await entry("Hannah")).toBeTruthy(); // GET alone never resubscribes
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: link })).statusCode).toBe(200);
    expect(await entry("Hannah")).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/reopt-in?t=${encodeURIComponent(purposeToken(SECRET, "resubscribe", "x"))}` })).statusCode).toBe(400);
  });

  it("one request per customer per channel per 30 days", async () => {
    const store = new MemoryStore();
    ({ app } = await makeApp({ env, store }));
    const hannah = await entry("Hannah");
    expect((await app.inject({ method: "POST", url: `/api/opt-outs/${hannah.id}/reopt-in` })).statusCode).toBe(201);
    // Customer resubscribes then unsubscribes again: still inside the 30-day window.
    await store.removeOptOut(DEMO_ORG_ID, "email", "hannah@example.com", "email_resubscribe");
    await store.addOptOut(DEMO_ORG_ID, "email", "hannah@example.com", "email_unsubscribe");
    const again = await entry("Hannah");
    const r = await app.inject({ method: "POST", url: `/api/opt-outs/${again.id}/reopt-in` });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("reoptin_cooldown");
  });

  it("SMS requests are off by default (compliance); when enabled, one START prompt is sent and START confirms it", async () => {
    ({ app } = await makeApp({ env }));
    const chris = await entry("Chris");
    const off = await app.inject({ method: "POST", url: `/api/opt-outs/${chris.id}/reopt-in` });
    expect(off.statusCode).toBe(403);
    expect(off.json().code).toBe("sms_reoptin_disabled");
    expect((await entry("Chris")).reoptIn).toBeNull();
    await app.close();

    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ env: { ...env, ALLOW_SMS_REOPTIN_REQUEST: "true" }, messenger }));
    const c2 = await entry("Chris");
    expect((await app.inject({ method: "POST", url: `/api/opt-outs/${c2.id}/reopt-in` })).statusCode).toBe(201);
    expect(messenger.sent[0]).toMatchObject({ channel: "sms" });
    expect(messenger.sent[0].message).toMatch(/Reply START to resubscribe\. No reply = no more texts\./);
    await sms({ From: "+15555550008", Body: "START", MessageSid: "SM9" });
    expect(await entry("Chris")).toBeUndefined();
  });

  it("a provider failure cancels the request so it can be retried", async () => {
    const failing: MessageProvider = { name: "fail", send: async () => { throw new Error("down"); } };
    ({ app } = await makeApp({ env, messenger: failing }));
    const hannah = await entry("Hannah");
    expect((await app.inject({ method: "POST", url: `/api/opt-outs/${hannah.id}/reopt-in` })).statusCode).toBe(502);
    expect((await entry("Hannah")).reoptIn).toBeNull();
  });

  it("staff can't request re-opt-in, and nobody can delete an opt-out directly", async () => {
    const store = new MemoryStore();
    const STAFF = "33333333-3333-4333-8333-333333333333";
    store.addMembership(STAFF, { orgId: DEMO_ORG_ID, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName, role: "staff" });
    const fake = await fakeSupabase();
    ({ app } = await makeApp({ env, store, authenticator: fake.authenticator }));
    const headers = { authorization: `Bearer ${await fake.sign(STAFF)}`, "x-org-id": DEMO_ORG_ID };
    const list = (await app.inject({ url: "/api/opt-outs", headers })).json();
    const id = list.items[0].id;
    const r = await app.inject({ method: "POST", url: `/api/opt-outs/${id}/reopt-in`, headers });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("insufficient_role");
    expect((await app.inject({ url: `/api/opt-outs/${id}/history`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/opt-outs/${id}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/opt-outs", headers })).json().total).toBe(list.total);
  });
});
