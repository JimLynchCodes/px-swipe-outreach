/** Manual order-history import (Data sync → Manually add → Order history): preview new orders, then write them. */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Actor } from "../types.js";
import { StoreError, type OutreachStore } from "../store/types.js";
import { ImportError } from "../customers/csvImport.js";
import { IMPORT_BODY_LIMIT } from "../customers/routes.js";
import { linkOf, parseOrderCsv, toOrderPreview } from "./csvImport.js";
import { beginProgressStream, wantsProgressStream } from "../importProgress.js";

type Deps = { store: OutreachStore; actorOf: (req: any) => Actor; timezone?: string;
  sendError: (reply: FastifyReply, status: number, code: string, error: string, details?: string[]) => unknown };

const PREVIEW_LIMIT = 500;
const csvBody = z.object({ csv: z.string().min(1, "the file is empty").max(IMPORT_BODY_LIMIT) }).strict();

export async function orderRoutes(app: FastifyInstance, { store, actorOf, sendError, timezone }: Deps) {
  const manager = (request: any): Actor => {
    const actor = actorOf(request);
    const role = request.auth?.org?.role;
    if (role !== "owner" && role !== "admin") throw new StoreError("forbidden", "Only owners and admins can import order history", "insufficient_role");
    return actor;
  };
  const parse = (csv: string, reply: FastifyReply) => {
    try { return parseOrderCsv(csv, { tz: timezone }); } catch (e) {
      if (e instanceof ImportError) { sendError(reply, 422, "invalid_csv", e.message); return null; }
      throw e;
    }
  };

  app.post("/api/orders/import/preview", { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    const actor = manager(request);
    const parsed = parse(csvBody.parse(request.body ?? {}).csv, reply);
    if (!parsed) return reply;
    const [have, keys] = await Promise.all([store.existingOrderIds(actor, parsed.orders.map(o => o.externalId)), store.customerKeys(actor)]);
    const fresh = parsed.orders.filter(o => !have.has(o.externalId)).sort((a, b) => b.at.localeCompare(a.at));
    const rows = fresh.map(o => toOrderPreview(o, linkOf(o, keys)));
    const count = (l: string) => rows.filter(r => r.link === l).length;
    return {
      newOrders: rows.slice(0, PREVIEW_LIMIT), newOrderCount: rows.length, existing: parsed.orders.length - fresh.length, invalid: parsed.invalid,
      links: { existing: count("existing"), new: count("new"), unlinked: count("unlinked") },
      totalCents: fresh.filter(o => linkOf(o, keys) !== "unlinked").reduce((s, o) => s + Math.max(0, o.totalCents), 0)
    };
  });

  app.post("/api/orders/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    const actor = manager(request);
    const parsed = parse(csvBody.parse(request.body ?? {}).csv, reply);
    if (!parsed) return reply;
    if (!parsed.orders.length) return sendError(reply, 422, "nothing_to_import", "No valid orders in this file.");
    const invalid = parsed.invalid.length;
    if (wantsProgressStream(request)) {
      const stream = beginProgressStream(reply);
      try {
        const r = await store.importOrders(actor, parsed.orders, (done, total) => {
          stream.write({ type: "progress", phase: "writing", done, total });
        });
        stream.write({ type: "done", ...r, invalid });
      } catch (e) {
        stream.write({ type: "error", code: "import_failed", error: e instanceof Error ? e.message : "Import failed" });
      }
      stream.end();
      return;
    }
    const r = await store.importOrders(actor, parsed.orders);
    return reply.code(201).send({ ...r, invalid });
  });
}
