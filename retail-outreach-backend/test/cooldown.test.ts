import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { cooldownUntil, inDeck } from "../src/domain.js";
import { buildSeedOpportunities } from "../src/store/memory.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

const DAY = 86_400_000;
const setCooldown = async (sms: number, email: number) => {
  const { settings } = (await app.inject("/api/settings")).json();
  return app.inject({ method: "PUT", url: "/api/settings", payload: { ...settings, smsCooldownDays: sms, emailCooldownDays: email } });
};
const deck = async () => (await app.inject("/api/outreach/queue?limit=100")).json();
const card = async (id: string) => (await deck()).items.find((i: any) => i.id === id);

describe("contact cooldown (domain)", () => {
  const now = Date.now();
  const base = buildSeedOpportunities(now)[0].customer; // Sarah: reachable on both
  it("is off at 0 days and when never contacted", () => {
    expect(cooldownUntil({ ...base, lastSmsAt: new Date(now - DAY).toISOString() }, "sms", { sms: 0, email: 0 }, now)).toBeNull();
    expect(cooldownUntil({ ...base, lastSmsAt: null }, "sms", { sms: 30, email: 0 }, now)).toBeNull();
  });
  it("ends exactly N days after the last send", () => {
    const c = { ...base, lastSmsAt: new Date(now - 2 * DAY).toISOString() };
    expect(cooldownUntil(c, "sms", { sms: 3, email: 0 }, now)).toBe(new Date(now + DAY).toISOString());
    expect(cooldownUntil(c, "sms", { sms: 2, email: 0 }, now)).toBeNull();
  });
  it("drops a customer only when no channel is reachable outside its window", () => {
    const c = { ...base, lastSmsAt: new Date(now - DAY).toISOString(), lastEmailAt: new Date(now - DAY).toISOString() };
    expect(inDeck(c, { sms: 7, email: 0 }, now)).toBe(true);
    expect(inDeck(c, { sms: 7, email: 7 }, now)).toBe(false);
    expect(inDeck({ ...c, emailConsent: false }, { sms: 7, email: 0 }, now)).toBe(false);
  });
});

describe("contact cooldown (API)", () => {
  it("shows last-sent dates on cards and defaults to no cooldown", async () => {
    ({ app } = await makeApp());
    const body = await deck();
    expect(body.total).toBe(20);
    expect(body.cooldown).toEqual({ sms: 0, email: 0 });
    const jamal = body.items.find((i: any) => i.id === "opp_0002");
    expect(jamal.customer.contact.lastSent).toEqual({ sms: expect.any(String), email: expect.any(String) });
    expect(jamal.customer.contact.cooldownUntil).toEqual({ sms: null, email: null });
    expect(body.items.find((i: any) => i.id === "opp_0005").customer.contact.lastSent).toEqual({ sms: null, email: null });
  });

  it("validates and persists the setting", async () => {
    ({ app } = await makeApp());
    expect((await setCooldown(-1, 0)).statusCode).toBe(400);
    expect((await setCooldown(1.5, 0)).statusCode).toBe(400);
    const r = await setCooldown(7, 14);
    expect(r.statusCode).toBe(200);
    expect(r.json().settings).toMatchObject({ smsCooldownDays: 7, emailCooldownDays: 14 });
    expect((await app.inject("/api/settings")).json().settings).toMatchObject({ smsCooldownDays: 7, emailCooldownDays: 14 });
  });

  it("hides the cooling channel, then the customer when both cool down", async () => {
    ({ app } = await makeApp());
    // Jamal: texted 3 days ago, emailed 40 days ago.
    await setCooldown(7, 0);
    const jamal = await card("opp_0002");
    expect(jamal.customer.contact).toMatchObject({ sms: false, email: true, preferredChannel: "email" });
    expect(jamal.customer.contact.cooldownUntil.sms).toEqual(expect.any(String));
    const blocked = await app.inject({ method: "POST", url: "/api/outreach/opp_0002/suggestion", payload: { channel: "sms" } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ code: "cooldown" });
    expect((await app.inject({ method: "POST", url: "/api/outreach/opp_0002/suggestion", payload: { channel: "email" } })).statusCode).toBe(200);
    const send = await app.inject({ method: "POST", url: "/api/outreach/opp_0002/send", payload: { channel: "sms", message: "Hi", idempotencyKey: "cool-1234" } });
    expect(send.statusCode).toBe(422);

    await setCooldown(7, 60);
    const body = await deck();
    expect(body.items.map((i: any) => i.id)).not.toContain("opp_0002");
    expect(body.total).toBe(19);
  });

  it("stamps the channel on a successful send", async () => {
    ({ app } = await makeApp());
    const before = await card("opp_0005");
    const channel = before.customer.contact.preferredChannel;
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0005/send", payload: { channel, message: "Hi there", subject: "Hi", idempotencyKey: "stamp-1234" } });
    expect(r.statusCode).toBeLessThan(300);
    const after = (await app.inject("/api/outreach/opp_0005")).json();
    expect(after.customer.contact.lastSent[channel]).toEqual(expect.any(String));
    expect(after.customer.contact.lastSent[channel === "sms" ? "email" : "sms"]).toBeNull();
  });
});
