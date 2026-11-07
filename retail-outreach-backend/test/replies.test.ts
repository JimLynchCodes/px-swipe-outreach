import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { ConsoleMessageProvider } from "../src/providers/messaging.js";
import { extractReplyToken, parseAddress, stripQuoted } from "../src/replies/inbound.js";
import { withSignature } from "../src/replies/routes.js";

const SECRET = "inbound-secret-0123456789abcdef";
const env = { INBOUND_EMAIL_DOMAIN: "reply.cloud9.test", INBOUND_EMAIL_SECRET: SECRET };
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

const list = async () => (await app.inject("/api/conversations")).json().conversations;
const byName = async (n: string) => (await list()).find((c: any) => c.customerName?.startsWith(n));

describe("replies", () => {
  it("lists seeded threads newest first with unread counts, masked contacts and channel", async () => {
    ({ app } = await makeApp());
    const convs = await list();
    expect(convs[0]).toMatchObject({ customerName: "Jamal Carter", channel: "sms", unreadCount: 1, lastDirection: "inbound", contact: "+15***02" });
    const times = convs.map((c: any) => c.lastMessageAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await app.inject("/api/conversations/unread-count")).json()).toEqual({ count: 4 });
    expect(convs.find((c: any) => c.customerName === "Chris Ortiz")).toMatchObject({ optedOut: true });
  });

  it("opening a thread and marking it read clears the unread count", async () => {
    ({ app } = await makeApp());
    const priya = await byName("Priya");
    expect(priya.unreadCount).toBe(2);
    const thread = (await app.inject(`/api/conversations/${priya.id}`)).json();
    expect(thread.messages.map((m: any) => m.direction)).toEqual(["outbound", "inbound", "inbound"]);
    expect((await app.inject({ method: "POST", url: `/api/conversations/${priya.id}/read` })).statusCode).toBe(200);
    expect((await byName("Priya")).unreadCount).toBe(0);
    expect((await app.inject("/api/conversations/unread-count")).json().count).toBe(3);
    expect((await app.inject("/api/conversations/nope")).statusCode).toBe(404);
  });

  it("sends an SMS reply with the signature on the same channel", async () => {
    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ messenger }));
    const jamal = await byName("Jamal");
    const r = await app.inject({ method: "POST", url: `/api/conversations/${jamal.id}/messages`, payload: { body: "Yep, 3 left. Want me to hold them?" } });
    expect(r.statusCode).toBe(201);
    expect(r.json().message).toMatchObject({ direction: "outbound", status: "sent", body: "Yep, 3 left. Want me to hold them? -Cloud 9" });
    expect(messenger.sent.at(-1)).toMatchObject({ channel: "sms", recipient: "+15555550002", message: "Yep, 3 left. Want me to hold them? -Cloud 9" });
    expect((await byName("Jamal")).lastMessagePreview).toBe("Yep, 3 left. Want me to hold them? -Cloud 9");
  });

  it("blocks replies to customers who opted out of that channel", async () => {
    ({ app } = await makeApp());
    const chris = await byName("Chris");
    const r = await app.inject({ method: "POST", url: `/api/conversations/${chris.id}/messages`, payload: { body: "hi" } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: "suppressed", error: "This customer opted out of text messages" });
  });

  it("email replies get Re: subject, signature, Reply-To token and unsubscribe; inbound email lands in the thread", async () => {
    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ messenger, env }));
    const elena = await byName("Elena");
    const r = await app.inject({ method: "POST", url: `/api/conversations/${elena.id}/messages`, payload: { body: "Yes! Restock lands Thursday." } });
    expect(r.statusCode).toBe(201);
    const sent = messenger.sent.at(-1)!;
    expect(sent).toMatchObject({ channel: "email", recipient: "elena@example.com", subject: "Re: Hookah night" });
    expect(sent.message).toMatch(/^Yes! Restock lands Thursday\.\n\nCloud 9 Smoke Shop\n123 Main St/);
    expect(sent.headers?.["List-Unsubscribe"]).toMatch(/\/unsubscribe\?t=/);
    const replyTo = sent.headers!["Reply-To"];
    expect(replyTo).toMatch(/^reply\+[A-Za-z0-9_-]{24}@reply\.cloud9\.test$/);

    const inbound = (payload: object, key = SECRET) => app.inject({ method: "POST", url: `/webhooks/email/inbound?key=${key}`, payload });
    expect((await inbound({ to: replyTo, from: "elena@example.com", text: "x" }, "wrong-secret-wrong-secret")).statusCode).toBe(403);
    expect((await inbound({ to: replyTo, from: "Mallory <mallory@evil.test>", text: "spoof" })).json()).toEqual({ ok: true, matched: false });
    const ok = await inbound({ to: `Cloud 9 <${replyTo}>`, from: "Elena Garcia <Elena@Example.com>", subject: "Re: Hookah night",
      text: "Perfect, save me two!\n\nOn Sat, Nov 7, 2026 Cloud 9 wrote:\n> Yes! Restock lands Thursday." });
    expect(ok.json()).toEqual({ ok: true, matched: true });
    const thread = (await app.inject(`/api/conversations/${elena.id}`)).json();
    expect(thread.messages.at(-1)).toMatchObject({ direction: "inbound", body: "Perfect, save me two!", subject: "Re: Hookah night" });
    expect(thread.conversation.unreadCount).toBe(2);
  });

  it("deck sends are recorded into the thread", async () => {
    ({ app } = await makeApp());
    await app.inject({ method: "POST", url: "/api/outreach/opp_0006/send", payload: { channel: "sms", message: "Hi Tyler", idempotencyKey: "key-12345678" } });
    const tyler = await byName("Tyler");
    expect(tyler).toMatchObject({ lastDirection: "outbound", unreadCount: 0, lastMessagePreview: "Hi Tyler Reply STOP to opt out." });
    const t = (await app.inject(`/api/conversations/${tyler.id}`)).json();
    expect(t.messages[0]).toMatchObject({ status: "sent", kind: "message" });
  });

  it("inbound email webhook is disabled without a secret and accepts multipart (SendGrid)", async () => {
    ({ app } = await makeApp());
    expect((await app.inject({ method: "POST", url: "/webhooks/email/inbound?key=x", payload: {} })).statusCode).toBe(503);
    await app.close();
    ({ app } = await makeApp({ env }));
    const boundary = "----b";
    const body = [["to", "reply+unknowntoken1234567890@reply.cloud9.test"], ["from", "a@b.test"], ["text", "hi"]]
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;
    const r = await app.inject({ method: "POST", url: `/webhooks/email/inbound?key=${SECRET}`, payload: body,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, matched: false });
  });
});

describe("inbound helpers", () => {
  it("parses tokens, addresses, quotes and signatures", () => {
    expect(extractReplyToken(null, "x <reply+abcdefghijklmnopqrstuvwx@d.test>")).toBe("abcdefghijklmnopqrstuvwx");
    expect(parseAddress("Jane <JANE@X.com>")).toBe("jane@x.com");
    expect(stripQuoted("New text\n> old")).toBe("New text");
    expect(withSignature("Hi", "-C9", "sms")).toBe("Hi -C9");
    expect(withSignature("Hi -C9", "-C9", "sms")).toBe("Hi -C9");
    expect(withSignature("Hi", "", "email")).toBe("Hi");
  });
});
