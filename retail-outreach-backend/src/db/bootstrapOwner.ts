import type pg from "pg";

export type BootstrapResult =
  | { status: "added"; orgId: string; orgCreated: boolean }
  | { status: "already_member"; orgId: string }
  | { status: "no_user" | "unverified" };

/** Lowercased, de-duplicated list from a comma/space separated string. */
export function parseEmailList(v: string | undefined): string[] {
  return [...new Set((v ?? "").split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes("@")))];
}

const slugify = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "store").padEnd(2, "0");

/**
 * Makes the Supabase Auth user with this email (case-insensitive) an owner of the default organization: the oldest
 * org, or a new one named `orgName` when none exists. Requires a confirmed email (auth.users.email_confirmed_at).
 * Runs on a privileged connection (bypasses RLS) inside the caller's transaction; serialized with an advisory lock
 * so two first sign-ins can't create two default orgs.
 */
export async function bootstrapOwner(db: pg.PoolClient | pg.Client, opts: { email: string; userId?: string; orgName: string }): Promise<BootstrapResult> {
  const email = opts.email.trim().toLowerCase();
  const u = await db.query<{ id: string; confirmed: boolean }>(
    `select id, email_confirmed_at is not null as confirmed from auth.users
     where lower(email) = $1 and ($2::uuid is null or id = $2::uuid) order by created_at limit 1`, [email, opts.userId ?? null]);
  const user = u.rows[0];
  if (!user) return { status: "no_user" };
  if (!user.confirmed) return { status: "unverified" };

  await db.query(`select pg_advisory_xact_lock(hashtext('px_outreach_bootstrap_owner'))`);
  const existing = await db.query<{ org_id: string; role: string }>(`select org_id, role from public.memberships where user_id = $1 order by created_at limit 1`, [user.id]);
  const org = await db.query<{ id: string }>(`select id from public.organizations order by created_at, id limit 1`);
  let orgId = org.rows[0]?.id;
  let orgCreated = false;
  if (!orgId) {
    const slug = `${slugify(opts.orgName)}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = (await db.query<{ id: string }>(`insert into public.organizations (name, slug, business_name, created_by) values ($1, $2, $1, $3) returning id`,
      [opts.orgName, slug, user.id])).rows[0].id;
    orgCreated = true;
  }
  if (existing.rows.some(r => r.org_id === orgId && r.role === "owner")) return { status: "already_member", orgId };
  await db.query(`insert into public.memberships (org_id, user_id, role, created_by) values ($1, $2, 'owner', $2)
    on conflict (org_id, user_id) do update set role = 'owner', updated_at = now()`, [orgId, user.id]);
  return { status: "added", orgId, orgCreated };
}
