import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODEL_IDS } from "../ai/models.js";
import type { OutreachStore } from "../store/types.js";
import type { Actor } from "../types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = z.string().regex(ISO_DATE, "must be YYYY-MM-DD").refine(s => !Number.isNaN(Date.parse(s)), "invalid date").nullable();
const text = (max: number) => z.string().trim().max(max);

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const dealInput = z.object({
  schedule: z.enum(["weekly", "range"]).default("weekly"),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]).transform(d => [...new Set(d)].sort()),
  title: text(80).min(1),
  description: text(300).default(""),
  discountType: z.enum(["percent", "amount", "bogo", "freebie"]),
  discountValue: z.number().int().positive().nullable().default(null),
  categories: z.array(text(40).min(1).toLowerCase()).max(20).default([]).transform(c => [...new Set(c)]),
  productIds: z.array(z.string().min(1).max(100)).max(50).default([]).transform(p => [...new Set(p)]),
  startsOn: date.default(null),
  endsOn: date.default(null),
  active: z.boolean().default(true)
}).strict().superRefine((d, ctx) => {
  if (d.discountType === "percent" && (d.discountValue === null || d.discountValue > 100)) ctx.addIssue({ code: "custom", path: ["discountValue"], message: "percent must be 1-100" });
  if (d.discountType === "amount" && (d.discountValue === null || d.discountValue > 100_000)) ctx.addIssue({ code: "custom", path: ["discountValue"], message: "amount (cents) must be 1-100000" });
  if ((d.discountType === "bogo" || d.discountType === "freebie") && d.discountValue !== null) ctx.addIssue({ code: "custom", path: ["discountValue"], message: "must be null for this discount type" });
  if (d.startsOn && d.endsOn && d.endsOn < d.startsOn) ctx.addIssue({ code: "custom", path: ["endsOn"], message: "must be on or after startsOn" });
  if (d.schedule === "weekly" && d.days.length === 0) ctx.addIssue({ code: "custom", path: ["days"], message: "pick at least one day" });
  if (d.schedule === "range" && (!d.startsOn || !d.endsOn)) ctx.addIssue({ code: "custom", path: [d.startsOn ? "endsOn" : "startsOn"], message: "a date-range promotion needs a start and end date" });
}).transform(d => (d.schedule === "range" ? { ...d, days: ALL_DAYS } : d));

export const settingsInput = z.object({
  storeName: text(100).nullable().transform(s => s || null),
  emailSignature: z.string().max(1000).transform(s => s.replace(/\r\n/g, "\n").trimEnd()),
  smsSignature: text(60).refine(s => !/[\r\n]/.test(s), "must be a single line"),
  defaultChannel: z.enum(["sms", "email"]).nullable(),
  maxDiscountPercent: z.number().int().min(0).max(100),
  /** Optional so older clients keep the current model. Allowlisted. */
  aiModel: z.enum(MODEL_IDS).optional(),
  /** Optional so older clients keep the current voice. */
  brandVoice: z.object({
    preset: z.enum(["friendly", "chill", "premium"]),
    emoji: z.boolean(),
    signOff: z.string().trim().max(40).refine(s => !/[\r\n]/.test(s), "must be a single line"),
    about: z.string().trim().max(500)
  }).strict().optional()
}).strict();

type Deps = { store: OutreachStore; actorOf: (req: any) => Actor };

/** Promotions (weekly deals), the product catalog they can target, and org outreach settings. */
export async function dealRoutes(app: FastifyInstance, { store, actorOf }: Deps) {
  const idParam = z.object({ id: z.string().min(1).max(100) });

  async function validated(actor: Actor, body: unknown) {
    const input = dealInput.parse(body);
    if (input.productIds.length) {
      const known = new Set((await store.listCatalog(actor)).map(p => p.id));
      const unknown = input.productIds.filter(id => !known.has(id));
      if (unknown.length) throw new z.ZodError([{ code: "custom", path: ["productIds"], message: `unknown product(s): ${unknown.join(", ")}` }]);
    }
    return input;
  }

  app.get("/api/deals", async request => ({ deals: await store.listDeals(actorOf(request)) }));
  app.post("/api/deals", async (request, reply) => {
    const actor = actorOf(request);
    return reply.code(201).send({ deal: await store.createDeal(actor, await validated(actor, request.body ?? {})) });
  });
  app.put("/api/deals/:id", async request => {
    const { id } = idParam.parse(request.params);
    const actor = actorOf(request);
    return { deal: await store.updateDeal(actor, id, await validated(actor, request.body ?? {})) };
  });
  app.delete("/api/deals/:id", async request => {
    const { id } = idParam.parse(request.params);
    await store.deleteDeal(actorOf(request), id);
    return { ok: true };
  });
  app.get("/api/catalog", async request => {
    const products = await store.listCatalog(actorOf(request));
    return { products, categories: [...new Set(products.map(p => p.category).filter(Boolean))].sort() };
  });

  app.get("/api/settings", async request => ({ settings: await store.getSettings(actorOf(request)) }));
  app.put("/api/settings", async request => {
    const actor = actorOf(request);
    const input = settingsInput.parse(request.body ?? {});
    const current = await store.getSettings(actor);
    const aiModel = input.aiModel ?? current.aiModel;
    const brandVoice = input.brandVoice ?? current.brandVoice;
    return { settings: await store.updateSettings(actor, { ...input, aiModel, brandVoice }) };
  });
}
