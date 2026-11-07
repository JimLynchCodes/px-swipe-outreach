import type pg from "pg";
import type { EtlRun, JobId, LogLine, Order, Progress, ReconciledUsageRow, RewardsMember, RunTrigger, Schedule, SyncRepo, UpsertResult } from "./types.js";
import { DEFAULT_TIMEZONE } from "./memoryRepo.js";

const RUN_COLS = `id, org_id, job, trigger, status, dry_run, params, progress, rows_read, rows_written, error, started_at, finished_at, heartbeat_at`;
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
function toRun(r: any, withLog = false): EtlRun {
  const started = new Date(r.started_at).getTime();
  return {
    id: r.id, orgId: r.org_id, job: r.job, trigger: r.trigger, status: r.status, dryRun: r.dry_run, params: r.params ?? {}, progress: r.progress ?? {},
    rowsRead: r.rows_read, rowsWritten: r.rows_written, error: r.error, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), heartbeatAt: iso(r.heartbeat_at)!,
    durationMs: r.finished_at ? new Date(r.finished_at).getTime() - started : null, ...(withLog ? { log: (r.log ?? []) as LogLine[] } : {})
  };
}
const toSchedule = (r: any): Schedule => ({ orgId: r.org_id, job: r.job, frequency: r.frequency, startLocal: localStr(r.start_local), nextRunAt: iso(r.next_run_at) });
/** pg returns `timestamp without time zone` as a Date in the server's local zone; rebuild the wall-clock string. */
function localStr(v: any): string {
  if (typeof v === "string") return v.replace(" ", "T").slice(0, 19);
  const d = v as Date, p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Sync persistence on the privileged pool (system writes; routes check owner/admin first). */
export class PgSyncRepo implements SyncRepo {
  constructor(private pool: pg.Pool) {}

  private async tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query("begin"); const r = await fn(db); await db.query("commit"); return r; }
    catch (e) { await db.query("rollback").catch(() => {}); throw e; }
    finally { db.release(); }
  }

  async getTimezone(orgId: string) {
    const r = await this.pool.query(`select timezone from public.org_settings where org_id = $1`, [orgId]);
    return r.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  }
  async setTimezone(orgId: string, tz: string) {
    await this.pool.query(`insert into public.org_settings (org_id, timezone) values ($1, $2) on conflict (org_id) do update set timezone = excluded.timezone`, [orgId, tz]);
  }
  async listSchedules(orgId: string) {
    return (await this.pool.query(`select * from public.sync_schedules where org_id = $1`, [orgId])).rows.map(toSchedule);
  }
  async upsertSchedule(s: Schedule, userId: string | null) {
    const r = await this.pool.query(`insert into public.sync_schedules (org_id, job, frequency, start_local, next_run_at, updated_by)
      values ($1,$2,$3,$4::timestamp,$5,$6)
      on conflict (org_id, job) do update set frequency = excluded.frequency, start_local = excluded.start_local, next_run_at = excluded.next_run_at,
        updated_by = excluded.updated_by, updated_at = now() returning *`, [s.orgId, s.job, s.frequency, s.startLocal.replace("T", " "), s.nextRunAt, userId]);
    return toSchedule(r.rows[0]);
  }
  async claimDueSchedules(now: Date, next: (s: Schedule, tz: string) => Date | null, limit = 20) {
    return this.tx(async db => {
      const due = await db.query(`select s.*, coalesce(o.timezone, $3) as tz from public.sync_schedules s
          left join public.org_settings o on o.org_id = s.org_id
        where s.frequency <> 'off' and s.next_run_at <= $1 order by s.next_run_at limit $2 for update of s skip locked`, [now, limit, DEFAULT_TIMEZONE]);
      const out: Schedule[] = [];
      for (const row of due.rows) {
        const s = toSchedule(row);
        const n = next(s, row.tz);
        await db.query(`update public.sync_schedules set next_run_at = $3 where org_id = $1 and job = $2`, [s.orgId, s.job, n]);
        out.push(s);
      }
      return out;
    });
  }

  async claimRun(r: { orgId: string; job: JobId; trigger: RunTrigger; dryRun: boolean; params: Record<string, unknown>; startedBy: string | null; staleMs: number }) {
    return this.tx(async db => {
      // Serialize claims for this org+job, then reap a run whose process died (stale heartbeat).
      await db.query(`select pg_advisory_xact_lock(hashtext('etl:' || $1 || ':' || $2))`, [r.orgId, r.job]);
      await db.query(`update public.etl_runs set status = 'failed', finished_at = now(), error = 'Run stopped responding (process restarted?)'
        where org_id = $1 and job = $2 and status = 'running' and heartbeat_at < now() - make_interval(secs => $3)`, [r.orgId, r.job, r.staleMs / 1000]);
      const ins = await db.query(`insert into public.etl_runs (org_id, job, trigger, dry_run, params, started_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (org_id, job) where status = 'running' do nothing returning ${RUN_COLS}`, [r.orgId, r.job, r.trigger, r.dryRun, JSON.stringify(r.params), r.startedBy]);
      return ins.rows[0] ? toRun(ins.rows[0]) : null;
    });
  }
  async updateRun(id: string, p: { progress?: Progress; rowsRead?: number; rowsWritten?: number; appendLog?: LogLine[] }) {
    await this.pool.query(`update public.etl_runs set heartbeat_at = now(), progress = coalesce($2, progress), rows_read = coalesce($3, rows_read),
      rows_written = coalesce($4, rows_written), log = case when $5::jsonb is null then log else log || $5::jsonb end where id = $1 and status = 'running'`,
    [id, p.progress ? JSON.stringify(p.progress) : null, p.rowsRead ?? null, p.rowsWritten ?? null, p.appendLog?.length ? JSON.stringify(p.appendLog) : null]);
  }
  async finishRun(id: string, f: { status: "succeeded" | "failed"; error: string | null; rowsRead: number; rowsWritten: number; progress: Progress; appendLog: LogLine[] }) {
    await this.pool.query(`update public.etl_runs set status = $2, error = $3, rows_read = $4, rows_written = $5, progress = $6, log = log || $7::jsonb,
      finished_at = now(), heartbeat_at = now() where id = $1`, [id, f.status, f.error, f.rowsRead, f.rowsWritten, JSON.stringify(f.progress), JSON.stringify(f.appendLog)]);
  }
  async listRuns(orgId: string, q: { job?: JobId; limit: number }) {
    const r = await this.pool.query(`select ${RUN_COLS} from public.etl_runs where org_id = $1 and ($2::text is null or job = $2) order by started_at desc limit $3`, [orgId, q.job ?? null, q.limit]);
    return r.rows.map(x => toRun(x));
  }
  async getRun(orgId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.pool.query(`select ${RUN_COLS}, log from public.etl_runs where org_id = $1 and id = $2`, [orgId, id]);
    return r.rows[0] ? toRun(r.rows[0], true) : null;
  }
  async latestRuns(orgId: string) {
    const r = await this.pool.query(`select distinct on (job) ${RUN_COLS} from public.etl_runs where org_id = $1 order by job, started_at desc`, [orgId]);
    return r.rows.map(x => toRun(x));
  }

  async getWatermark(orgId: string, job: string) {
    return (await this.pool.query(`select cursor from public.etl_watermarks where org_id = $1 and job = $2`, [orgId, job])).rows[0]?.cursor ?? null;
  }
  async setWatermark(orgId: string, job: string, cursor: string) {
    await this.pool.query(`insert into public.etl_watermarks (org_id, job, cursor) values ($1,$2,$3) on conflict (org_id, job) do update set cursor = excluded.cursor, updated_at = now()`, [orgId, job, cursor]);
  }

  async recordedAiUsage(orgId: string, sinceDay: string) {
    const r = await this.pool.query(`select provider, (created_at at time zone 'UTC')::date::text as day, model, sum(cost_usd)::float8 as cost, count(*)::int as calls
      from public.ai_usage where org_id = $1 and not is_demo and provider <> 'rules' and created_at >= $2::date group by 1, 2, 3`, [orgId, sinceDay]);
    return r.rows.map(x => ({ provider: x.provider, day: x.day, model: x.model, costUsd: x.cost, calls: x.calls }));
  }
  /** Generic multi-row upsert: counts inserts vs updates via xmax. */
  private async upsert(sql: string, rows: unknown[][]): Promise<UpsertResult> {
    let inserted = 0, updated = 0;
    if (!rows.length) return { inserted, updated };
    await this.tx(async db => {
      for (const params of rows) {
        const r = await db.query(sql, params);
        if (r.rows[0]?.inserted) inserted++; else if (r.rowCount) updated++;
      }
    });
    return { inserted, updated };
  }
  async upsertProviderUsage(orgId: string, rows: ReconciledUsageRow[]) {
    return this.upsert(`insert into public.provider_usage_daily (org_id, provider, day, model, requests, input_tokens, output_tokens, cost_usd, recorded_cost_usd, recorded_calls)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (org_id, provider, day, model) do update set requests = excluded.requests, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd, recorded_cost_usd = excluded.recorded_cost_usd, recorded_calls = excluded.recorded_calls, synced_at = now()
      returning (xmax = 0) as inserted`, rows.map(r => [orgId, r.provider, r.day, r.model.slice(0, 100), r.requests, r.inputTokens, r.outputTokens, r.costUsd, r.recordedCostUsd, r.recordedCalls]));
  }
  async upsertTwilioUsage(orgId: string, rows: import("./types.js").TwilioUsageRow[]) {
    return this.upsert(`insert into public.twilio_usage_daily (org_id, day, category, count, usage, price_usd) values ($1,$2,$3,$4,$5,$6)
      on conflict (org_id, day, category) do update set count = excluded.count, usage = excluded.usage, price_usd = excluded.price_usd, synced_at = now()
      returning (xmax = 0) as inserted`, rows.map(r => [orgId, r.day, r.category.slice(0, 64), r.count, r.usage, r.priceUsd]));
  }
  async upsertSmsCosts(orgId: string, rows: import("./types.js").TwilioMessageRow[]) {
    // A known SID (any org: SIDs are global) only gets Twilio's facts; an unknown one is added to this org's ledger.
    return this.upsert(`insert into public.sms_costs (org_id, provider, message_sid, segments, price_usd, estimated, status, created_at)
      values ($1, 'twilio', $2, $3, coalesce($4::numeric, 0), $4::numeric is null, $5, $6)
      on conflict (message_sid) do update set segments = excluded.segments, status = excluded.status,
        price_usd = case when excluded.estimated then sms_costs.price_usd else excluded.price_usd end,
        estimated = sms_costs.estimated and excluded.estimated, updated_at = now()
      returning (xmax = 0) as inserted`, rows.map(r => [orgId, r.sid, r.segments, r.priceUsd, r.status || null, r.sentAt]));
  }
  async listEmailDeliveries(orgId: string, sinceIso: string) {
    const r = await this.pool.query(`select id, provider_message_id, status::text, error, created_at, updated_at from public.message_deliveries
      where org_id = $1 and channel = 'email' and updated_at >= $2 order by updated_at limit 50000`, [orgId, sinceIso]);
    return r.rows.map(x => ({ id: x.id, providerMessageId: x.provider_message_id, status: x.status, error: x.error, createdAt: iso(x.created_at)!, updatedAt: iso(x.updated_at)! }));
  }
  async upsertEmailTracking(orgId: string, rows: import("./types.js").EmailTrackingRow[]) {
    return this.upsert(`insert into public.email_tracking (org_id, message_id, delivery_id, provider, status, bounce_type, sent_at, last_event_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, message_id) do update set delivery_id = coalesce(excluded.delivery_id, email_tracking.delivery_id),
      provider = excluded.provider, status = excluded.status, bounce_type = coalesce(excluded.bounce_type, email_tracking.bounce_type),
      sent_at = coalesce(email_tracking.sent_at, excluded.sent_at), last_event_at = greatest(email_tracking.last_event_at, excluded.last_event_at), synced_at = now()
      returning (xmax = 0) as inserted`, rows.map(r => [orgId, r.messageId.slice(0, 255), r.deliveryId, r.provider, r.status.slice(0, 32), r.bounceType, r.sentAt, r.lastEventAt]));
  }

  /** Customer id for a contact: external id, then phone (last 10 digits), then email. */
  private async findCustomer(db: pg.PoolClient, orgId: string, c: { externalId: string | null; phone: string | null; email: string | null }): Promise<string | null> {
    const r = await db.query(`select id from public.customers where org_id = $1 and (
        ($2::text is not null and external_id = $2) or
        ($3::text is not null and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = right(regexp_replace($3, '\\D', '', 'g'), 10)) or
        ($4::text is not null and lower(email) = $4))
      order by (external_id = $2) desc nulls last, created_at limit 1`, [orgId, c.externalId ? `qv:${c.externalId}` : null, c.phone, c.email]);
    return r.rows[0]?.id ?? null;
  }
  async upsertRewardsMembers(orgId: string, rows: RewardsMember[]) {
    let inserted = 0, updated = 0, matched = 0;
    await this.tx(async db => {
      for (const m of rows) {
        const id = await this.findCustomer(db, orgId, m);
        if (id) {
          matched++; updated++;
          await db.query(`update public.customers set rewards_member = true, rewards_points = $3, rewards_joined_at = coalesce($4, rewards_joined_at),
            external_id = coalesce(external_id, $5), phone = coalesce(phone, $6), email = coalesce(email, $7), updated_at = now() where org_id = $1 and id = $2`,
          [orgId, id, m.points, m.joinedAt, `qv:${m.externalId}`, m.phone, m.email]);
        } else {
          inserted++;
          await db.query(`insert into public.customers (org_id, external_id, first_name, last_name, phone, email, rewards_member, rewards_points, rewards_joined_at, source)
            values ($1,$2,$3,$4,$5,$6,true,$7,$8,'quickvee')`, [orgId, `qv:${m.externalId}`, (m.firstName || "Rewards member").slice(0, 100), (m.lastName ?? "").slice(0, 100), m.phone, m.email, m.points, m.joinedAt]);
        }
      }
    });
    return { inserted, updated, matched };
  }
  async upsertOrders(orgId: string, rows: Order[]) {
    let inserted = 0, updated = 0, skipped = 0;
    const touched = new Set<string>();
    await this.tx(async db => {
      for (const o of rows) {
        let cid = await this.findCustomer(db, orgId, o.customer);
        if (!cid) {
          if (!o.customer.phone && !o.customer.email) { skipped++; continue; } // walk-in sale: nobody to attribute it to
          const [first, ...rest] = (o.customer.name ?? "").trim().split(/\s+/);
          cid = (await db.query(`insert into public.customers (org_id, external_id, first_name, last_name, phone, email, source) values ($1,$2,$3,$4,$5,$6,'quickvee') returning id`,
            [orgId, o.customer.externalId ? `qv:${o.customer.externalId}` : null, (first || "Customer").slice(0, 100), rest.join(" ").slice(0, 100), o.customer.phone, o.customer.email])).rows[0].id;
        }
        touched.add(cid!);
        const p = await db.query(`insert into public.purchases (org_id, customer_id, external_id, purchased_at, total_cents, discount_cents, payment_method, source)
          values ($1,$2,$3,$4,$5,$6,$7,'quickvee') on conflict (org_id, external_id) do update set customer_id = excluded.customer_id, purchased_at = excluded.purchased_at,
          total_cents = excluded.total_cents, discount_cents = excluded.discount_cents, payment_method = excluded.payment_method
          returning id, (xmax = 0) as inserted`, [orgId, cid, `qv:${o.externalId}`, o.at, Math.max(0, o.totalCents), Math.max(0, o.discountCents), o.paymentMethod?.slice(0, 40) ?? null]);
        if (p.rows[0].inserted) inserted++; else updated++;
        const pid = p.rows[0].id;
        await db.query(`delete from public.purchase_items where org_id = $1 and purchase_id = $2`, [orgId, pid]);
        for (const i of o.items) {
          await db.query(`insert into public.purchase_items (org_id, purchase_id, product_id, product_name, quantity, unit_price_cents, category, brand, discount_cents)
            values ($1, $2, (select id from public.products where org_id = $1 and ((sku is not null and sku = $3) or lower(name) = lower($4)) limit 1), $4, $5, $6, $7, $8, $9)`,
          [orgId, pid, i.sku, i.name.slice(0, 200), i.quantity, i.unitPriceCents, i.category?.slice(0, 100) ?? null, i.brand?.slice(0, 100) ?? null, i.discountCents]);
        }
      }
      if (touched.size) await refreshProfiles(db, orgId, [...touched]);
    });
    return { inserted, updated, skipped };
  }
}

/** Recomputes the buying-pattern columns the suggestion engine reads, from real purchase history (store timezone). */
export async function refreshProfiles(db: pg.PoolClient, orgId: string, customerIds: string[]) {
  await db.query(`
    with tz as (select coalesce((select timezone from public.org_settings where org_id = $1), 'America/New_York') as z),
    p as (select pu.customer_id, pu.purchased_at, pu.total_cents, pu.purchased_at at time zone (select z from tz) as local
          from public.purchases pu where pu.org_id = $1 and pu.customer_id = any($2::uuid[]) and not pu.is_demo),
    s as (select customer_id, sum(total_cents) as total, max(purchased_at) as last, avg(total_cents)::int as avg,
            count(*) filter (where purchased_at >= now() - interval '90 days') as recent,
            mode() within group (order by (extract(isodow from local)::int - 1)) as dow,
            mode() within group (order by case when extract(hour from local) < 12 then 'morning' when extract(hour from local) < 17 then 'afternoon' else 'evening' end) as tod
          from p group by customer_id),
    cats as (select pu.customer_id, array_agg(category order by n desc, category) filter (where rk <= 3) as top from (
               select pu.customer_id, i.category, sum(i.quantity) as n, row_number() over (partition by pu.customer_id order by sum(i.quantity) desc, i.category) as rk
               from public.purchase_items i join public.purchases pu on pu.org_id = i.org_id and pu.id = i.purchase_id
               where i.org_id = $1 and pu.customer_id = any($2::uuid[]) and i.category is not null group by pu.customer_id, i.category) pu group by pu.customer_id),
    brands as (select pu.customer_id, array_agg(brand order by n desc, brand) filter (where rk <= 3) as top from (
               select pu.customer_id, coalesce(i.brand, pr.brand) as brand, sum(i.quantity) as n,
                 row_number() over (partition by pu.customer_id order by sum(i.quantity) desc, coalesce(i.brand, pr.brand)) as rk
               from public.purchase_items i join public.purchases pu on pu.org_id = i.org_id and pu.id = i.purchase_id
               left join public.products pr on pr.org_id = i.org_id and pr.id = i.product_id
               where i.org_id = $1 and pu.customer_id = any($2::uuid[]) and coalesce(i.brand, pr.brand) is not null group by 1, 2) pu group by pu.customer_id)
    update public.customers c set lifetime_spend_cents = s.total, last_purchase_at = s.last, avg_basket_cents = greatest(0, s.avg),
      visits_per_month = least(999, round(s.recent / 3.0, 2)), preferred_day = s.dow, preferred_time = s.tod,
      favorite_categories = coalesce(cats.top, c.favorite_categories), favorite_brands = coalesce(brands.top, c.favorite_brands), updated_at = now()
    from s left join cats on cats.customer_id = s.customer_id left join brands on brands.customer_id = s.customer_id
    where c.org_id = $1 and c.id = s.customer_id`, [orgId, customerIds]);
}
