/** Data sync API (owners/admins only): sources with status + schedule, force re-sync / backfill, run history with logs. */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Actor } from "../types.js";
import { StoreError } from "../store/types.js";
import { FREQUENCIES, isValidTimeZone, nextRunAfter, parseLocal, formatLocal, toLocal } from "./schedule.js";
import { JOB_IDS, type JobId, type Schedule } from "./types.js";
import type { SyncService } from "./index.js";

type Deps = { sync: SyncService; actorOf: (req: any) => Actor; schedulerEnabled: boolean;
  sendError: (reply: FastifyReply, status: number, code: string, error: string, details?: string[]) => unknown };

const jobParam = z.object({ job: z.enum(JOB_IDS) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/** Default schedule shown for a never-configured source: off, starting tomorrow 03:00 store time. */
function defaultSchedule(orgId: string, job: JobId, tz: string, now: Date): Schedule {
  const t = toLocal(now.getTime() + 86_400_000, tz);
  return { orgId, job, frequency: "off", startLocal: formatLocal({ ...t, h: 3, mi: 0, s: 0 }), nextRunAt: null };
}

export async function syncRoutes(app: FastifyInstance, { sync, actorOf, sendError, schedulerEnabled }: Deps) {
  const { repo, runner } = sync;
  /** Owner/admin gate (sync data is management-only; RLS mirrors it for direct Supabase reads). */
  const manager = (request: any): Actor => {
    const actor = actorOf(request);
    const role = request.auth?.org?.role;
    if (role !== "owner" && role !== "admin") throw new StoreError("forbidden", "Only owners and admins can manage data sync", "insufficient_role");
    return actor;
  };

  app.get("/api/sync", async request => {
    const { orgId } = manager(request);
    const now = new Date();
    const [tz, schedules, latest] = await Promise.all([repo.getTimezone(orgId), repo.listSchedules(orgId), repo.latestRuns(orgId)]);
    return {
      timezone: tz, schedulerEnabled, now: now.toISOString(),
      sources: JOB_IDS.map(id => {
        const def = runner.job(id);
        const missing = def.missingEnv(app.syncConfig);
        return { id, label: def.label, description: def.description, supportsBackfill: !!def.supportsBackfill, configured: !missing.length, missing,
          schedule: schedules.find(s => s.job === id) ?? defaultSchedule(orgId, id, tz, now), lastRun: latest.find(r => r.job === id) ?? null };
      })
    };
  });

  app.put("/api/sync/timezone", async request => {
    const actor = manager(request);
    const { timezone } = z.object({ timezone: z.string().min(1).max(64).refine(isValidTimeZone, "unknown IANA timezone") }).strict().parse(request.body ?? {});
    await repo.setTimezone(actor.orgId, timezone);
    const now = Date.now();
    for (const s of await repo.listSchedules(actor.orgId)) {
      await repo.upsertSchedule({ ...s, nextRunAt: nextRunAfter(s.startLocal, s.frequency, timezone, now)?.toISOString() ?? null }, actor.userId);
    }
    return { timezone };
  });

  app.put("/api/sync/:job/schedule", async request => {
    const actor = manager(request);
    const { job } = jobParam.parse(request.params);
    const body = z.object({
      frequency: z.enum(FREQUENCIES),
      startLocal: z.string().refine(s => parseLocal(s) !== null, "must be a local date-time like 2026-11-15T10:00:00")
    }).strict().parse(request.body ?? {});
    const tz = await repo.getTimezone(actor.orgId);
    const startLocal = formatLocal(parseLocal(body.startLocal)!);
    const nextRunAt = nextRunAfter(startLocal, body.frequency, tz, Date.now())?.toISOString() ?? null;
    return { schedule: await repo.upsertSchedule({ orgId: actor.orgId, job, frequency: body.frequency, startLocal, nextRunAt }, actor.userId) };
  });

  app.post("/api/sync/:job/run", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const actor = manager(request);
    const { job } = jobParam.parse(request.params);
    const body = z.object({ dryRun: z.boolean().default(false), from: day.optional(), to: day.optional() }).strict().parse(request.body ?? {});
    const def = runner.job(job);
    if ((body.from || body.to) && !def.supportsBackfill) return sendError(reply, 400, "invalid_request", `${def.label} doesn't support a date range`);
    if (body.to && !body.from) return sendError(reply, 400, "invalid_request", "A backfill needs a start date");
    if (body.from) {
      const to = body.to ?? new Date().toISOString().slice(0, 10);
      if (body.from > to) return sendError(reply, 400, "invalid_request", "Start date must be on or before the end date");
      if (to > new Date().toISOString().slice(0, 10)) return sendError(reply, 400, "invalid_request", "End date can't be in the future");
      if (Date.parse(to) - Date.parse(body.from) > 10 * 366 * 86_400_000) return sendError(reply, 400, "invalid_request", "Backfill at most 10 years at a time");
    }
    const missing = def.missingEnv(app.syncConfig);
    if (missing.length) return sendError(reply, 422, "not_configured", `${def.label} isn't configured. Set ${missing.join(", ")} on the server.`);
    try {
      const run = await runner.start({ orgId: actor.orgId, job, trigger: body.from ? "backfill" : "manual", dryRun: body.dryRun,
        params: body.from ? { from: body.from, to: body.to ?? new Date().toISOString().slice(0, 10) } : {}, startedBy: actor.userId });
      return reply.code(202).send({ run });
    } catch (e) {
      if (e instanceof StoreError && e.reason === "already_running") return sendError(reply, 409, "already_running", e.message);
      throw e;
    }
  });

  app.get("/api/sync/runs", async request => {
    const { orgId } = manager(request);
    const q = z.object({ job: z.enum(JOB_IDS).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    return { runs: await repo.listRuns(orgId, q) };
  });

  app.get("/api/sync/runs/:id", async (request, reply) => {
    const { orgId } = manager(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const run = await repo.getRun(orgId, id);
    if (!run) return sendError(reply, 404, "not_found", "Run not found");
    return { run };
  });
}

declare module "fastify" { interface FastifyInstance { syncConfig: import("../config.js").AppConfig } }
