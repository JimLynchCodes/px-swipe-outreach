import { maskRecipient } from "../domain.js";
import type { Customer, CustomerSummary } from "../types.js";

/** Campaign for opportunities created by a CSV import or an explicit pick on the Registered users page. */
export const MANUAL_CAMPAIGN = { id: "manual", type: "custom", name: "Manual outreach" } as const;
export const IMPORT_RATIONALE = "Added from a CSV import";
export const PICK_RATIONALE = "Picked from Registered users";

export function toSummary(c: Pick<Customer, "id" | "firstName" | "lastName" | "phone" | "email" | "location" | "lifetimeSpendCents" | "lastSmsAt" | "lastEmailAt">,
  meta: { createdAt: string; source: string | null }): CustomerSummary {
  return {
    id: c.id, name: `${c.firstName} ${c.lastName}`.trim(), phone: c.phone ? maskRecipient(c.phone) : null, email: c.email ? maskRecipient(c.email) : null,
    location: c.location, source: meta.source, createdAt: meta.createdAt, lastSmsAt: c.lastSmsAt ?? null, lastEmailAt: c.lastEmailAt ?? null,
    lifetimeSpendCents: c.lifetimeSpendCents
  };
}
