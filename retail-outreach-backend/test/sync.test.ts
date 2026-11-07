import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { MemorySyncRepo } from "../src/sync/memoryRepo.js";
import { SyncRunner } from "../src/sync/runner.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { HttpError, withRetry } from "../src/sync/http.js";
import type { JobDef } from "../src/sync/job.js";
import { reconcile, normalizeOpenAiModel } from "../src/sync/jobs/aiUsage.js";
import { dateWindows } from "../src/sync/quickvee/jobs.js";
import { normalizePhone, parseCsv, toCents, toIso, toOrders, toRewardsMember } from "../src/sync/quickvee/normalize.js";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG, DEMO_ORG_ID } from "../src/data/seed.js";
import { fakeSupabase, makeApp } from "./helpers.js";
import type { SyncService } from "../src/sync/index.js";

const ORG = DEMO_ORG_ID;
const cfg = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", ...env });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };
const fakeJob = (over: Partial<JobDef> = {}): JobDef => ({ id: "email", label: "Fake", description: "", missingEnv: () => [], run: async ctx => { ctx.read(3); ctx.wrote(2); }, ...over });

describe("runner", () => {
  it("runs in the background, records progress/log/rows, and holds a per-job lock", async () => {
    const repo = new MemorySyncRepo();
    const g = gate();
    const runner = new SyncRunner(repo, cfg(), { flushMs: 5, jobs: { email: fakeJob({ run: async ctx => { ctx.progress({ phase: "Working", done: 1, total: 2 }); ctx.log("info", "halfway"); await g.p; ctx.read(5); ctx.wrote(4); } }) } });
    const run = await runner.start({ orgId: ORG, job: "email", trigger: "manual" });
    expect(run.status).toBe("running");
    await expect(runner.start({ orgId: ORG, job: "email", trigger: "manual" })).rejects.toMatchObject({ reason: "already_running" });
    await new Promise(r => setTimeout(r, 30));
    expect((await repo.getRun(ORG, run.id))!.progress).toMatchObject({ phase: "Working", done: 1 });
    g.open();
    await runner.wait(run.id);
    const done = (await repo.getRun(ORG, run.id))!;
    expect(done).toMatchObject({ status: "succeeded", rowsRead: 5, rowsWritten: 4, error: null });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.log!.map(l => l.msg)).toEqual(expect.arrayContaining(["halfway", "Finished: 5 read, 4 written"]));
    // Lock released.
    const again = await runner.start({ orgId: ORG, job: "email", trigger: "manual" });
    await runner.wait(again.id);
  });
  it("records failures with secrets redacted; reaps a stale run", async () => {
    const repo = new MemorySyncRepo();
    const runner = new SyncRunner(repo, cfg({ TWILIO_AUTH_TOKEN: "supersecrettoken123" }), { jobs: { email: fakeJob({ run: async ctx => { ctx.log("info", "auth Bearer abc.def"); throw new Error("401 with token supersecrettoken123"); } }) } });
    const run = await runner.start({ orgId: ORG, job: "email", trigger: "manual" });
    await runner.wait(run.id);
    const done = (await repo.getRun(ORG, run.id))!;
    expect(done.status).toBe("failed");
    expect(done.error).toBe("401 with token [redacted]");
    expect(JSON.stringify(done.log)).not.toMatch(/supersecret|abc\.def/);

    const stale = await repo.claimRun({ orgId: ORG, job: "twilio", trigger: "manual", dryRun: false, params: {}, startedBy: null, staleMs: 1 });
    repo.runs.find(r => r.id === stale!.id)!.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
    const next = await repo.claimRun({ orgId: ORG, job: "twilio", trigger: "manual", dryRun: false, params: {}, startedBy: null, staleMs: 10_000 });
    expect(next).not.toBeNull();
    expect((await repo.getRun(ORG, stale!.id))!.status).toBe("failed");
  });
  it("dry run counts but writes nothing and leaves the watermark", async () => {
    const repo = new MemorySyncRepo();
    repo.emailDeliveries.push({ orgId: ORG, id: "d1", providerMessageId: "m1", status: "sent", error: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
    const runner = new SyncRunner(repo, cfg(), { now: () => new Date("2026-11-07T12:00:00Z") });
    const run = await runner.start({ orgId: ORG, job: "email", trigger: "manual", dryRun: true });
    await runner.wait(run.id);
    expect((await repo.getRun(ORG, run.id))!).toMatchObject({ status: "succeeded", rowsWritten: 1, dryRun: true });
    expect(repo.email.size).toBe(0);
    expect(await repo.getWatermark(ORG, "email")).toBeNull();
  });
  it("refuses unconfigured jobs", async () => {
    await expect(new SyncRunner(new MemorySyncRepo(), cfg()).start({ orgId: ORG, job: "twilio", trigger: "manual" })).rejects.toMatchObject({ reason: "not_configured" });
  });
});

describe("retries", () => {
  it("backs off on 5xx/429, honors Retry-After, stops on 4xx", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await withRetry(async () => { if (n++ < 2) throw new HttpError(n === 1 ? 503 : 429, "x", n === 2 ? 7000 : null); return "ok"; }, { sleep: async ms => { sleeps.push(ms); }, random: () => 1, baseMs: 100 });
    expect(r).toBe("ok");
    expect(sleeps).toEqual([100, 7000]);
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new HttpError(401, "nope"); }, { sleep: async () => {} })).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});

describe("scheduler", () => {
  it("claims due jobs once, advances to the next slot after now (one catch-up run), skips unconfigured", async () => {
    const repo = new MemorySyncRepo();
    const ran: string[] = [];
    const runner = new SyncRunner(repo, cfg(), { jobs: { email: fakeJob({ run: async () => { ran.push("email"); } }) } });
    const now = new Date("2026-12-09T05:00:00Z");
    // Weekly since Nov 15, last advanced to Nov 22: three slots were missed while down.
    await repo.upsertSchedule({ orgId: ORG, job: "email", frequency: "weekly", startLocal: "2026-11-15T10:00:00", nextRunAt: "2026-11-22T15:00:00.000Z" });
    await repo.upsertSchedule({ orgId: ORG, job: "twilio", frequency: "daily", startLocal: "2026-11-15T10:00:00", nextRunAt: "2026-11-22T15:00:00.000Z" });
    await repo.upsertSchedule({ orgId: ORG, job: "ai-usage", frequency: "off", startLocal: "2026-11-15T10:00:00", nextRunAt: null });
    const s = new SyncScheduler(repo, runner, { now: () => now });
    const started = await s.tick();
    expect(started).toHaveLength(1);
    await runner.drain();
    expect(ran).toEqual(["email"]);
    expect((await repo.listSchedules(ORG)).find(x => x.job === "email")!.nextRunAt).toBe("2026-12-13T15:00:00.000Z");
    expect(await s.tick()).toEqual([]); // nothing due any more
    expect((await repo.listRuns(ORG, { limit: 10 }))[0].trigger).toBe("schedule");
  });
  it("doesn't overlap a running manual run", async () => {
    const repo = new MemorySyncRepo();
    const g = gate();
    const runner = new SyncRunner(repo, cfg(), { jobs: { email: fakeJob({ run: () => g.p }) } });
    await runner.start({ orgId: ORG, job: "email", trigger: "manual" });
    await repo.upsertSchedule({ orgId: ORG, job: "email", frequency: "daily", startLocal: "2026-01-01T00:00:00", nextRunAt: "2026-01-01T05:00:00.000Z" });
    expect(await new SyncScheduler(repo, runner).tick()).toEqual([]);
    g.open(); await runner.drain();
  });
});

describe("jobs", () => {
  const ctxRun = async (job: "ai-usage" | "twilio" | "email", env: Record<string, string>, fetchImpl: typeof fetch, repo = new MemorySyncRepo()) => {
    const runner = new SyncRunner(repo, cfg(env), { fetchImpl, retry: { sleep: async () => {} }, now: () => new Date("2026-11-07T12:00:00Z") });
    const run = await runner.start({ orgId: ORG, job, trigger: "manual" });
    await runner.wait(run.id);
    return { repo, run: (await repo.getRun(ORG, run.id))! };
  };

  it("ai-usage: OpenRouter activity + OpenAI usage/costs, keyed by provider and reconciled with ai_usage", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      if (u.includes("openrouter.ai/api/v1/activity")) return json({ data: [
        { date: "2026-11-05", model: "openai/gpt-4o-mini", usage: 0.012, requests: 40, prompt_tokens: 36000, completion_tokens: 3200 },
        { date: "2026-10-01", model: "openai/gpt-4o-mini", usage: 9, requests: 1 }] });
      if (u.includes("openrouter.ai/api/v1/credits")) return json({ data: { total_credits: 10, total_usage: 1.5 } });
      if (u.includes("/usage/completions") && !u.includes("page=")) return json({ data: [{ start_time: Date.parse("2026-11-05T00:00:00Z") / 1000, results: [{ model: "gpt-4o-mini-2024-07-18", input_tokens: 1000, output_tokens: 100, num_model_requests: 3 }] }], has_more: true, next_page: "p2" });
      if (u.includes("/usage/completions")) return json({ data: [{ start_time: Date.parse("2026-11-06T00:00:00Z") / 1000, results: [{ model: "gpt-4o-mini", input_tokens: 10, output_tokens: 1, num_model_requests: 1 }] }], has_more: false });
      if (u.includes("/costs")) return json({ data: [{ start_time: Date.parse("2026-11-05T00:00:00Z") / 1000, results: [{ line_item: "gpt-4o-mini-2024-07-18, input", amount: { value: 0.00015 } }, { line_item: "gpt-4o-mini-2024-07-18, output", amount: { value: 0.00006 } }] }], has_more: false });
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const repo = new MemorySyncRepo();
    repo.aiUsage.push({ orgId: ORG, provider: "openrouter", day: "2026-11-05", model: "openai/gpt-4o-mini", costUsd: 0.011 }, { orgId: ORG, provider: "openai", day: "2026-11-04", model: "gpt-4o-mini", costUsd: 0.001 });
    const { run } = await ctxRun("ai-usage", { OPENROUTER_API_KEY: "sk-or-1234567890", OPENAI_ADMIN_KEY: "sk-admin-1234567890" }, f, repo);
    expect(run.status).toBe("succeeded");
    const rows = [...repo.providerUsage.values()];
    expect(rows.find(r => r.provider === "openrouter")).toMatchObject({ day: "2026-11-05", model: "openai/gpt-4o-mini", costUsd: 0.012, requests: 40, recordedCostUsd: 0.011, recordedCalls: 1 });
    expect(rows.find(r => r.provider === "openai" && r.day === "2026-11-05")).toMatchObject({ model: "gpt-4o-mini", requests: 3, inputTokens: 1000 });
    expect(rows.find(r => r.provider === "openai" && r.day === "2026-11-05")!.costUsd).toBeCloseTo(0.00021, 9);
    expect(rows.find(r => r.provider === "openai" && r.day === "2026-11-04")).toMatchObject({ costUsd: 0, recordedCostUsd: 0.001 }); // app-only row surfaces
    expect(rows.some(r => r.day === "2026-10-01")).toBe(false); // older than the window
    expect(urls.some(u => u.includes("page=p2"))).toBe(true);
    expect(await repo.getWatermark(ORG, "ai-usage")).toBe("2026-11-06");
    // Idempotent: a re-run updates, doesn't duplicate.
    const before = repo.providerUsage.size;
    await ctxRun("ai-usage", { OPENROUTER_API_KEY: "sk-or-1234567890", OPENAI_ADMIN_KEY: "sk-admin-1234567890" }, f, repo);
    expect(repo.providerUsage.size).toBe(before);
  });

  it("ai-usage: retries a 429 then succeeds; a 401 fails the run without leaking the key", async () => {
    let n = 0;
    const f = (async (u: string) => {
      if (u.includes("/activity")) return n++ === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : json({ data: [] });
      return json({ data: {} });
    }) as unknown as typeof fetch;
    const ok = await ctxRun("ai-usage", { OPENROUTER_API_KEY: "sk-or-1234567890" }, f);
    expect(ok.run.status).toBe("succeeded");
    expect(ok.run.log ?? []).toBeDefined();
    const bad = await ctxRun("ai-usage", { OPENROUTER_API_KEY: "sk-or-1234567890" }, (async () => new Response("bad key sk-or-1234567890", { status: 401 })) as unknown as typeof fetch);
    expect(bad.run).toMatchObject({ status: "failed", error: "GET /api/v1/activity failed: HTTP 401" });
  });

  it("twilio: pages usage records + messages and backfills prices into the ledger by SID", async () => {
    const f = (async (u: string) => {
      if (u.includes("/Usage/Records/Daily.json")) return json({ usage_records: [{ start_date: "2026-11-05", category: "sms", count: "12", usage: "14", price: "-0.17" }], next_page_uri: null });
      if (u.includes("Page=1")) return json({ messages: [{ sid: "SM2", direction: "outbound-api", price: null, num_segments: "1", status: "sent", date_sent: "Thu, 05 Nov 2026 15:00:00 +0000" }], next_page_uri: null });
      if (u.includes("/Messages.json")) return json({ messages: [
        { sid: "SM1", direction: "outbound-api", price: "-0.0083", num_segments: "1", status: "delivered", date_sent: "Thu, 05 Nov 2026 14:00:00 +0000" },
        { sid: "SM9", direction: "inbound", price: "-0.0079", num_segments: "1", status: "received" }], next_page_uri: "/2010-04-01/Accounts/x/Messages.json?Page=1" });
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const { repo, run } = await ctxRun("twilio", { TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_AUTH_TOKEN: "t".repeat(32) }, f);
    expect(run.status).toBe("succeeded");
    expect([...repo.twilioUsage.values()][0]).toMatchObject({ day: "2026-11-05", count: 12, priceUsd: 0.17 });
    expect(repo.smsCosts.get("SM1")).toMatchObject({ priceUsd: 0.0083, status: "delivered" });
    expect(repo.smsCosts.get("SM2")).toMatchObject({ priceUsd: null });
    expect(repo.smsCosts.has("SM9")).toBe(false);
  });

  it("email: tracks every sent email from the ledger, flags bounces and missing message ids", async () => {
    const repo = new MemorySyncRepo();
    repo.emailDeliveries.push(
      { orgId: ORG, id: "d1", providerMessageId: "<a@mail>", status: "sent", error: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" },
      { orgId: ORG, id: "d2", providerMessageId: null, status: "failed", error: "550 mailbox does not exist", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" });
    const { run } = await ctxRun("email", {}, fetch, repo);
    expect(run.status).toBe("succeeded");
    expect(repo.email.get(`${ORG}|<a@mail>`)).toMatchObject({ status: "sent", deliveryId: "d1" });
    expect(repo.email.get(`${ORG}|delivery:d2`)).toMatchObject({ status: "bounced", bounceType: "hard" });
    expect((await repo.getRun(ORG, run.id))!.log!.some(l => /no provider message id/.test(l.msg))).toBe(true);
  });

  it("helpers: model normalization, reconcile, windows", () => {
    expect(normalizeOpenAiModel("gpt-4o-mini-2024-07-18, output")).toBe("gpt-4o-mini");
    expect(reconcile([], [{ provider: "rules", day: "d", model: "rules", costUsd: 0, calls: 1 }], ["openai"])).toEqual([]);
    expect(dateWindows("2026-01-01", "2026-01-16", 7)).toEqual([["2026-01-01", "2026-01-07"], ["2026-01-08", "2026-01-14"], ["2026-01-15", "2026-01-16"]]);
  });
});

describe("Quickvee normalization", () => {
  it("maps export headers, money, phones and store-local dates", () => {
    expect(toCents("$1,234.56")).toBe(123456);
    expect(toCents("(3.00)")).toBe(-300);
    expect(normalizePhone("(555) 010-0001")).toBe("+15550100001");
    expect(normalizePhone("12")).toBeNull();
    expect(toIso("11/05/2026 3:04 PM")).toBe("2026-11-05T20:04:00.000Z"); // EST
    expect(toIso("2026-07-05 09:00", "America/Los_Angeles")).toBe("2026-07-05T16:00:00.000Z");
    const m = toRewardsMember({ "Customer ID": "R1", "Customer Name": "Jamal Carter", "Phone Number": "555.010.0001", Email: "J@X.COM", "Reward Points": "1,200", "Signup Date": "03/14/2025" });
    expect(m).toEqual({ externalId: "R1", firstName: "Jamal", lastName: "Carter", phone: "+15550100001", email: "j@x.com", points: 1200, joinedAt: "2025-03-14" });
    const orders = toOrders(parseCsv(`Order ID,Order Date,Customer Name,Phone,Item Name,Category,Brand,Qty,Unit Price,Item Discount,Order Discount,Total,Payment Type
O1,11/02/2026 10:15 AM,Jamal Carter,5550100001,Cigar,Cigars,AF,2,$9.50,0,$1.00,$20.00,Card
O1,11/02/2026 10:15 AM,Jamal Carter,5550100001,Papers,Papers,ZZ,1,2.00,0,$1.00,$20.00,Card
O2,bad date,X,,Lighter,,,1,1,0,0,1,Cash`));
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ externalId: "O1", totalCents: 2000, discountCents: 100, subtotalCents: 2100, paymentMethod: "Card", customer: { phone: "+15550100001" } });
    expect(orders[0].items.map(i => [i.name, i.category, i.brand, i.quantity, i.unitPriceCents])).toEqual([["Cigar", "Cigars", "AF", 2, 950], ["Papers", "Papers", "ZZ", 1, 200]]);
  });
});

describe("data sync API", () => {
  const OWNER = "11111111-1111-4111-8111-111111111111", STAFF = "33333333-3333-4333-8333-333333333333";
  async function setup(env: Record<string, string> = {}, jobs: Partial<Record<string, JobDef>> = {}) {
    const store = new MemoryStore();
    store.addMembership(OWNER, { orgId: ORG, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName, role: "owner" });
    store.addMembership(STAFF, { orgId: ORG, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName, role: "staff" });
    const fake = await fakeSupabase();
    const repo = new MemorySyncRepo();
    const config = cfg(env);
    const runner = new SyncRunner(repo, config, { jobs, flushMs: 5 });
    const sync: SyncService = { repo, runner, scheduler: new SyncScheduler(repo, runner) };
    const { app } = await makeApp({ store, authenticator: fake.authenticator, env, sync });
    const h = async (u: string) => ({ authorization: `Bearer ${await fake.sign(u)}`, "x-org-id": ORG });
    return { app, repo, runner, h };
  }

  it("is owner/admin only", async () => {
    const { app, h } = await setup();
    for (const [method, url] of [["GET", "/api/sync"], ["POST", "/api/sync/email/run"], ["PUT", "/api/sync/email/schedule"], ["GET", "/api/sync/runs"]] as const) {
      expect((await app.inject({ method, url, headers: await h(STAFF), payload: method === "GET" ? undefined : {} })).statusCode).toBe(403);
    }
  });

  it("lists sources with configured state (env names only), schedule defaults and timezone", async () => {
    const { app, h } = await setup({ QUICKVEE_PASSWORD: "hunter2-secret" });
    const r = (await app.inject({ url: "/api/sync", headers: await h(OWNER) })).json();
    expect(r.timezone).toBe("America/New_York");
    const by = Object.fromEntries(r.sources.map((s: any) => [s.id, s]));
    expect(Object.keys(by)).toEqual(["ai-usage", "twilio", "email", "quickvee-rewards", "quickvee-orders"]);
    expect(by.twilio).toMatchObject({ configured: false, missing: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], lastRun: null, schedule: { frequency: "off" } });
    expect(by["quickvee-orders"]).toMatchObject({ configured: false, missing: ["QUICKVEE_EMAIL"], supportsBackfill: true });
    expect(by.email.configured).toBe(true);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(by.email.schedule.startLocal).toMatch(/T03:00:00$/);
  });

  it("saves schedules (next run in store timezone) and recomputes them when the timezone changes", async () => {
    const { app, h } = await setup();
    const put = await app.inject({ method: "PUT", url: "/api/sync/email/schedule", headers: await h(OWNER), payload: { frequency: "daily", startLocal: "2099-11-15T10:00:00" } });
    expect(put.json().schedule).toMatchObject({ frequency: "daily", startLocal: "2099-11-15T10:00:00", nextRunAt: "2099-11-15T15:00:00.000Z" });
    expect((await app.inject({ method: "PUT", url: "/api/sync/email/schedule", headers: await h(OWNER), payload: { frequency: "hourly", startLocal: "2099-11-15T10:00:00" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/sync/timezone", headers: await h(OWNER), payload: { timezone: "Mars/Olympus" } })).statusCode).toBe(400);
    await app.inject({ method: "PUT", url: "/api/sync/timezone", headers: await h(OWNER), payload: { timezone: "America/Los_Angeles" } });
    const r = (await app.inject({ url: "/api/sync", headers: await h(OWNER) })).json();
    expect(r.timezone).toBe("America/Los_Angeles");
    expect(r.sources.find((s: any) => s.id === "email").schedule.nextRunAt).toBe("2099-11-15T18:00:00.000Z");
  });

  it("force re-sync: 202, live progress via polling, 409 while running, history with expandable log", async () => {
    const g = gate();
    const { app, h } = await setup({}, { email: fakeJob({ run: async ctx => { ctx.progress({ phase: "Reading", done: 1, total: 4 }); ctx.log("info", "step one"); await g.p; ctx.wrote(4); } }) });
    const start = await app.inject({ method: "POST", url: "/api/sync/email/run", headers: await h(OWNER), payload: {} });
    expect(start.statusCode).toBe(202);
    const id = start.json().run.id;
    expect((await app.inject({ method: "POST", url: "/api/sync/email/run", headers: await h(OWNER), payload: {} })).json()).toMatchObject({ code: "already_running" });
    await vi.waitFor(async () => {
      const s = (await app.inject({ url: "/api/sync", headers: await h(OWNER) })).json().sources.find((x: any) => x.id === "email");
      expect(s.lastRun).toMatchObject({ status: "running", progress: { phase: "Reading", done: 1, total: 4 } });
    });
    g.open();
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/sync/runs/${id}`, headers: await h(OWNER) })).json().run.status).toBe("succeeded"));
    const detail = (await app.inject({ url: `/api/sync/runs/${id}`, headers: await h(OWNER) })).json().run;
    expect(detail).toMatchObject({ trigger: "manual", rowsWritten: 4 });
    expect(detail.log.map((l: any) => l.msg)).toContain("step one");
    const list = (await app.inject({ url: "/api/sync/runs?job=email", headers: await h(OWNER) })).json().runs;
    expect(list).toHaveLength(1);
    expect(list[0].log).toBeUndefined();
  });

  it("validates backfill ranges and refuses unconfigured sources", async () => {
    const ran: unknown[] = [];
    const { app, h } = await setup({ QUICKVEE_EMAIL: "a@b.co", QUICKVEE_PASSWORD: "pw" }, { "quickvee-orders": { ...fakeJob(), id: "quickvee-orders", supportsBackfill: true, run: async ctx => { ran.push(ctx.params); } } });
    const post = async (job: string, payload: object) => app.inject({ method: "POST", url: `/api/sync/${job}/run`, headers: await h(OWNER), payload });
    expect((await post("twilio", {})).json()).toMatchObject({ code: "not_configured" });
    expect((await post("email", { from: "2026-01-01" })).statusCode).toBe(400);
    expect((await post("quickvee-orders", { from: "2026-02-01", to: "2026-01-01" })).statusCode).toBe(400);
    expect((await post("quickvee-orders", { from: "2026-01-01", to: "2999-01-01" })).statusCode).toBe(400);
    const ok = await post("quickvee-orders", { from: "2024-01-01", to: "2024-12-31" });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().run).toMatchObject({ trigger: "backfill", params: { from: "2024-01-01", to: "2024-12-31" } });
    await vi.waitFor(() => expect(ran).toEqual([{ from: "2024-01-01", to: "2024-12-31" }]));
  });
});
