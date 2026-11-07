/** Registered users (customer list), CSV import (preview → confirm) and opening a specific customer's card. */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Actor } from "../types.js";
import type { OutreachStore } from "../store/types.js";
import { StoreError } from "../store/types.js";
import { ImportError, isExisting, parseCustomerCsv, toPreview } from "./csvImport.js";

type Deps = { store: OutreachStore; actorOf: (req: any) => Actor; timezone?: string;
  sendError: (reply: FastifyReply, status: number, code: string, error: string, details?: string[]) => unknown };

/** 5 MB of CSV ≈ tens of thousands of rows; the row cap in csvImport applies too. */
export const IMPORT_BODY_LIMIT = 5 * 1024 * 1024;
const csvBody = z.object({ csv: z.string().min(1, "the file is empty").max(IMPORT_BODY_LIMIT) });

export async function customerRoutes(app: FastifyInstance, { store, actorOf, sendError, timezone }: Deps) {
  const manager = (request: any): Actor => {
    const actor = actorOf(request);
    const role = request.auth?.org?.role;
    if (role !== "owner" && role !== "admin") throw new StoreError("forbidden", "Only owners and admins can import customers", "insufficient_role");
    return actor;
  };
  const parse = (csv: string, reply: FastifyReply) => {
    try { return parseCustomerCsv(csv, { tz: timezone }); } catch (e) {
      if (e instanceof ImportError) { sendError(reply, 422, "invalid_csv", e.message); return null; }
      throw e;
    }
  };

  /** Dry run: which rows would be added (only customers not already in the org), plus skipped/invalid counts. */
  app.post("/api/customers/import/preview", { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    const actor = manager(request);
    const { csv } = csvBody.parse(request.body ?? {});
    const parsed = parse(csv, reply);
    if (!parsed) return reply;
    const keys = await store.customerKeys(actor);
    const fresh = parsed.customers.filter(c => !isExisting(c, keys));
    return {
      newCustomers: fresh.map(toPreview), existing: parsed.customers.length - fresh.length,
      duplicatesInFile: parsed.duplicatesInFile, invalid: parsed.invalid, totalRows: parsed.customers.length + parsed.invalid.length + parsed.duplicatesInFile
    };
  });

  /** Writes the new customers. The server re-parses and re-dedupes (never trusts the preview). */
  app.post("/api/customers/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    const actor = manager(request);
    const body = csvBody.extend({
      smsConsent: z.boolean().default(false), emailConsent: z.boolean().default(false), ageVerified: z.boolean().default(false)
    }).strict().parse(request.body ?? {});
    const parsed = parse(body.csv, reply);
    if (!parsed) return reply;
    if (!parsed.customers.length) return sendError(reply, 422, "nothing_to_import", "No valid customer rows in this file.");
    const r = await store.importCustomers(actor, parsed.customers, { smsConsent: body.smsConsent, emailConsent: body.emailConsent, ageVerified: body.ageVerified });
    return reply.code(201).send({ ...r, invalid: parsed.invalid.length, duplicatesInFile: parsed.duplicatesInFile });
  });

  app.get("/api/customers", async request => {
    const q = z.object({
      search: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50)
    }).parse(request.query);
    const { items, total } = await store.listCustomers(actorOf(request), { search: q.search, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  /** Explicit pick: the customer's open card (created if needed). The deck shows it first, regardless of cooldowns. */
  app.post("/api/customers/:id/open", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    const opportunityId = await store.openCustomerCard(actorOf(request), id);
    if (!opportunityId) return sendError(reply, 404, "not_found", "Customer not found");
    return { opportunityId };
  });
}
