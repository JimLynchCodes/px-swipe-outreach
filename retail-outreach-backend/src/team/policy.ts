import type { MemberRole } from "../types.js";
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
