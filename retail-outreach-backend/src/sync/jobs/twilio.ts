/**
 * Twilio: daily usage records (SMS category) and per-message prices backfilled into the send ledger (sms_costs, by SID).
 * Idempotent upserts; watermark = last synced day (re-reads 1 day back since Twilio prices messages late).
 */
import { getJson } from "../http.js";
import { addDays, isoDay, type JobContext, type JobDef } from "../job.js";
import type { TwilioMessageRow, TwilioUsageRow } from "../types.js";

const API = "https://api.twilio.com";

async function pages<T>(ctx: JobContext, path: string, key: string, auth: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < 200; i++) {
    const body: any = await getJson(`${API}${next}`, { headers: { authorization: auth }, fetchImpl: ctx.fetchImpl, retry: ctx.retry });
    out.push(...(body[key] ?? []));
    next = body.next_page_uri ?? null;
    ctx.progress({ phase: key === "messages" ? "Messages" : "Usage records", done: out.length });
  }
  return out;
}

export const twilioJob: JobDef = {
  id: "twilio",
  label: "Twilio",
  description: "Daily SMS usage and each message's actual price, backfilled into the send ledger.",
  missingEnv: c => [!c.TWILIO_ACCOUNT_SID && "TWILIO_ACCOUNT_SID", !c.TWILIO_AUTH_TOKEN && "TWILIO_AUTH_TOKEN"].filter(Boolean) as string[],
  async run(ctx) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = ctx.config;
    const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
    const today = isoDay(ctx.now);
    const wm = await ctx.repo.getWatermark(ctx.orgId, "twilio");
    const since = typeof ctx.params.from === "string" ? ctx.params.from : wm ? addDays(wm, -1) : addDays(today, -30);
    const base = `/2010-04-01/Accounts/${sid}`;

    const records = await pages<any>(ctx, `${base}/Usage/Records/Daily.json?Category=sms&StartDate=${since}&EndDate=${today}&PageSize=1000`, "usage_records", auth);
    const usage: TwilioUsageRow[] = records.map(r => ({ day: String(r.start_date).slice(0, 10), category: String(r.category), count: Number(r.count) || 0, usage: Number(r.usage) || 0, priceUsd: Math.abs(Number(r.price) || 0) }));
    const u = await ctx.repo.upsertTwilioUsage(ctx.orgId, usage);

    const msgs = await pages<any>(ctx, `${base}/Messages.json?${encodeURIComponent("DateSent>")}=${since}&PageSize=1000`, "messages", auth);
    const outbound: TwilioMessageRow[] = msgs.filter(m => String(m.direction ?? "").startsWith("outbound")).map(m => ({
      sid: m.sid, priceUsd: m.price === null || m.price === undefined || m.price === "" ? null : Math.abs(Number(m.price)),
      segments: Math.min(20, Math.max(1, Number(m.num_segments) || 1)), status: String(m.status ?? "").slice(0, 32), sentAt: new Date(m.date_sent ?? m.date_created ?? ctx.now).toISOString()
    }));
    ctx.read(records.length + msgs.length);
    ctx.progress({ phase: "Saving", done: 0, total: outbound.length });
    const s = await ctx.repo.upsertSmsCosts(ctx.orgId, outbound);
    ctx.wrote(u.inserted + u.updated + s.inserted + s.updated);
    const unpriced = outbound.filter(m => m.priceUsd === null).length;
    ctx.log("info", `Usage: ${usage.length} day rows. Messages: ${outbound.length} outbound (${s.updated} matched the ledger, ${s.inserted} new, ${unpriced} not priced yet)`, { since });
    if (!ctx.dryRun) await ctx.repo.setWatermark(ctx.orgId, "twilio", today);
    ctx.progress({ phase: "Done", done: outbound.length, total: outbound.length });
  }
};
