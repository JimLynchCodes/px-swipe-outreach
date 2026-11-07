/**
 * Dev CLI (thin wrapper over the same jobs the API runs):
 *   npm run sync -- <job|all> [--org <uuid>] [--dry-run] [--from YYYY-MM-DD --to YYYY-MM-DD]
 * Uses DATA_STORE/DATABASE_URL from the environment (use --env-file). Exit code 1 if any job failed.
 */
import { loadConfigOrExit } from "../config.js";
import { createStore } from "../store/index.js";
import { DEMO_ORG_ID } from "../data/seed.js";
import { createSync } from "./index.js";
import { JOB_IDS, type JobId } from "./types.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const which = args.find(a => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "";
if (which !== "all" && !JOB_IDS.includes(which as JobId)) {
  console.error(`Usage: npm run sync -- <${[...JOB_IDS, "all"].join("|")}> [--org <uuid>] [--dry-run] [--from YYYY-MM-DD] [--to YYYY-MM-DD]`);
  process.exit(2);
}
const config = loadConfigOrExit();
const store = await createStore(config);
const log = { info: (o: object, m?: string) => console.log(m, JSON.stringify(o)), warn: (o: object, m?: string) => console.warn(m, JSON.stringify(o)), error: (o: object, m?: string) => console.error(m, JSON.stringify(o)) };
const sync = await createSync(config, store, log);
const orgId = flag("org") ?? process.env.SYNC_ORG_ID ?? DEMO_ORG_ID;
const jobs = which === "all" ? JOB_IDS.filter(j => !sync.runner.missingEnv(j).length) : [which as JobId];
if (which === "all") for (const j of JOB_IDS.filter(j => !jobs.includes(j))) console.log(`skip ${j}: not configured (${sync.runner.missingEnv(j).join(", ")})`);
let failed = 0;
for (const job of jobs) {
  const from = flag("from");
  try {
    const run = await sync.runner.start({ orgId, job, trigger: "cli", dryRun: args.includes("--dry-run"), params: from ? { from, to: flag("to") ?? new Date().toISOString().slice(0, 10) } : {} });
    await sync.runner.wait(run.id);
    const done = await sync.repo.getRun(orgId, run.id);
    console.log(`${job}: ${done?.status} (${done?.rowsRead} read, ${done?.rowsWritten} written${done?.error ? `, error: ${done.error}` : ""})`);
    if (done?.status !== "succeeded") failed++;
  } catch (e) { failed++; console.error(`${job}: ${(e as Error).message}`); }
}
await store.close();
process.exit(failed ? 1 : 0);
