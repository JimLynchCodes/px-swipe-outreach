/**
 * Approve an owner by email without waiting for sign-in:
 *   npm run bootstrap:owner -- mrdotjim@gmail.com [more@emails] [--org-name "Cloud 9"]
 * With no emails, uses BOOTSTRAP_OWNER_EMAILS. The person must have signed up / signed in once (so a Supabase Auth
 * user exists) and confirmed their email. Needs DATABASE_URL (privileged connection).
 */
import "dotenv/config";
import { createPool } from "./pool.js";
import { bootstrapOwner, parseEmailList } from "./bootstrapOwner.js";

const args = process.argv.slice(2);
const nameAt = args.indexOf("--org-name");
const orgName = nameAt >= 0 ? args.splice(nameAt, 2)[1] : process.env.BOOTSTRAP_ORG_NAME || "My Store";
const emails = parseEmailList(args.join(",") || process.env.BOOTSTRAP_OWNER_EMAILS);
if (!emails.length) { console.error("Usage: npm run bootstrap:owner -- you@example.com [--org-name \"Store\"]"); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL (e.g. --env-file=.env.supabase.local)."); process.exit(2); }

const pool = createPool(process.env.DATABASE_URL, { max: 1 });
let failed = false;
for (const email of emails) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const r = await bootstrapOwner(db, { email, orgName });
    await db.query("commit");
    if (r.status === "added") console.log(`${email}: now an owner of org ${r.orgId}${r.orgCreated ? ` (created "${orgName}")` : ""}`);
    else if (r.status === "already_member") console.log(`${email}: already an owner of org ${r.orgId}`);
    else {
      failed = true;
      console.error(r.status === "no_user"
        ? `${email}: no Supabase Auth user yet. Sign in once at the app (magic link or sign-up), then re-run.`
        : `${email}: email not confirmed yet. Click the confirmation link Supabase sent, then re-run.`);
    }
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
}
await pool.end();
process.exit(failed ? 1 : 0);
