/**
 * Email tracking: every sent email gets an email_tracking row (message id, status, bounce). The default provider reads
 * the send ledger (message_deliveries); a SendGrid-style event API can be layered on via EmailEventsProvider.
 */
import { getJson } from "../http.js";
import { addDays, isoDay, type JobContext, type JobDef } from "../job.js";
import type { EmailTrackingRow } from "../types.js";

export interface EmailEventsProvider {
  readonly name: string;
  /** Latest known status per message since a time. */
  fetch(ctx: JobContext, sinceIso: string): Promise<EmailTrackingRow[]>;
}

const BOUNCE_RE = /bounce|mailbox|does not exist|undeliverable|rejected/i;

export const ledgerProvider: EmailEventsProvider = {
  name: "ledger",
  async fetch(ctx, sinceIso) {
    const rows = await ctx.repo.listEmailDeliveries(ctx.orgId, sinceIso);
    ctx.read(rows.length);
    const missing = rows.filter(r => !r.providerMessageId && r.status !== "queued" && r.status !== "sending").length;
    if (missing) ctx.log("warn", `${missing} email deliveries have no provider message id (tracked by delivery id)`);
    return rows.map(r => {
      const bounced = r.status === "failed" && BOUNCE_RE.test(r.error ?? "");
      return { messageId: r.providerMessageId ?? `delivery:${r.id}`, deliveryId: r.id, provider: "ledger", status: bounced ? "bounced" : r.status,
        bounceType: bounced ? "hard" : null, sentAt: r.createdAt, lastEventAt: r.updatedAt };
    });
  }
};

/** SendGrid Email Activity API (needs the add-on). Message ids match the X-Message-Id the send path stores. */
export const sendgridProvider = (apiKey: string): EmailEventsProvider => ({
  name: "sendgrid",
  async fetch(ctx, sinceIso) {
    const q = `last_event_time BETWEEN TIMESTAMP "${sinceIso}" AND TIMESTAMP "${ctx.now.toISOString()}"`;
    const body: any = await getJson(`https://api.sendgrid.com/v3/messages?limit=1000&query=${encodeURIComponent(q)}`,
      { headers: { authorization: `Bearer ${apiKey}` }, fetchImpl: ctx.fetchImpl, retry: ctx.retry });
    const msgs: any[] = body.messages ?? [];
    ctx.read(msgs.length);
    return msgs.map(m => ({ messageId: String(m.msg_id).split(".")[0], deliveryId: null, provider: "sendgrid", status: String(m.status ?? "unknown").slice(0, 32),
      bounceType: m.status === "not_delivered" ? "bounce" : null, sentAt: null, lastEventAt: m.last_event_time ?? null }));
  }
});

export const emailJob: JobDef = {
  id: "email",
  label: "Email tracking",
  description: "Makes sure every sent email is tracked: message id, status and bounces.",
  missingEnv: c => (c.EMAIL_EVENTS_PROVIDER === "sendgrid" && !c.SENDGRID_API_KEY ? ["SENDGRID_API_KEY"] : []),
  async run(ctx) {
    const wm = await ctx.repo.getWatermark(ctx.orgId, "email");
    const since = typeof ctx.params.from === "string" ? `${ctx.params.from}T00:00:00.000Z` : wm ?? `${addDays(isoDay(ctx.now), -90)}T00:00:00.000Z`;
    const providers: EmailEventsProvider[] = [ledgerProvider];
    if (ctx.config.EMAIL_EVENTS_PROVIDER === "sendgrid" && ctx.config.SENDGRID_API_KEY) providers.push(sendgridProvider(ctx.config.SENDGRID_API_KEY));
    let written = 0;
    for (const p of providers) {
      ctx.progress({ phase: `Reading ${p.name}` });
      const rows = await p.fetch(ctx, since);
      const r = await ctx.repo.upsertEmailTracking(ctx.orgId, rows);
      written += r.inserted + r.updated;
      ctx.log("info", `${p.name}: ${rows.length} emails (${r.inserted} new, ${r.updated} updated)`);
    }
    ctx.wrote(written);
    // Re-read an hour back next time: statuses change after send.
    if (!ctx.dryRun) await ctx.repo.setWatermark(ctx.orgId, "email", new Date(ctx.now.getTime() - 3_600_000).toISOString());
    ctx.progress({ phase: "Done" });
  }
};
