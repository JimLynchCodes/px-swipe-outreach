import type { MemberRole, OptOutEntry } from "../types.js";
import { StoreError } from "../store/types.js";

/** Role rules shared by both stores. RLS enforces the same rules in Postgres (defense in depth). */
export const canManageTeam = (role: MemberRole) => role === "owner" || role === "admin";

export function assertCanManage(role: MemberRole | undefined) {
  if (!role || !canManageTeam(role)) throw new StoreError("forbidden", "Only owners and admins can manage the team", "insufficient_role");
}

/** Can `actor` give someone `target` role (by invite or role change)? Only owners grant owner. */
export function assertCanGrant(actor: MemberRole | undefined, target: MemberRole) {
  assertCanManage(actor);
  if (target === "owner" && actor !== "owner") throw new StoreError("forbidden", "Only owners can grant the owner role", "insufficient_role");
}

/** Can `actor` modify/remove a member who currently has `current`? Only owners touch owners. */
export function assertCanModify(actor: MemberRole | undefined, current: MemberRole) {
  assertCanManage(actor);
  if (current === "owner" && actor !== "owner") throw new StoreError("forbidden", "Only owners can change or remove an owner", "insufficient_role");
}

export function assertCanEditDeals(role: MemberRole | undefined) {
  if (!role || !canManageTeam(role)) throw new StoreError("forbidden", "Only owners and admins can edit deals", "insufficient_role");
}

/** Only owners/admins may ask an opted-out customer to re-subscribe. Nobody (staff included) can lift an opt-out directly. */
export function assertCanManageConsent(role: MemberRole | undefined, what = "send re-opt-in requests") {
  if (!role || !canManageTeam(role)) throw new StoreError("forbidden", `Only owners and admins can ${what}`, "insufficient_role");
}

/** One request per customer+channel per 30 days, and never while one is pending. */
export function assertReoptAllowed(latest: OptOutEntry["reoptIn"], now = Date.now()) {
  if (!latest) return;
  if (latest.status === "pending") throw new StoreError("conflict", "A re-opt-in request is already pending for this contact", "reoptin_pending");
  if (Date.parse(latest.nextAllowedAt) > now) throw new StoreError("rate_limited", `Only one re-opt-in request per ${30} days; next allowed ${latest.nextAllowedAt.slice(0, 10)}`, "reoptin_cooldown");
}
