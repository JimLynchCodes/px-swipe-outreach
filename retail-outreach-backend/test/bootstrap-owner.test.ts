import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEMO_ORG_ID } from "../src/data/seed.js";
import { loadConfig } from "../src/config.js";
import { parseEmailList } from "../src/db/bootstrapOwner.js";
import { MemoryStore } from "../src/store/memory.js";
import { fakeSupabase, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
const JIM = "33333333-3333-4333-8333-333333333333";

async function setup(env: Record<string, string> = { BOOTSTRAP_OWNER_EMAILS: "mrdotjim@gmail.com, other@x.test" }) {
  const sb = await fakeSupabase();
  const store = new MemoryStore();
  ({ app } = await makeApp({ authenticator: sb.authenticator, store, env }));
  const me = async (email: string, verified: boolean) => app.inject({ url: "/api/me", headers: {
    authorization: `Bearer ${await sb.sign(JIM, { claims: { email, user_metadata: { email_verified: verified } } })}` } });
  return { store, me };
}

describe("BOOTSTRAP_OWNER_EMAILS", () => {
  it("parses a comma/space separated, case-insensitive list", () => {
    expect(loadConfig({ NODE_ENV: "test", BOOTSTRAP_OWNER_EMAILS: " MrDotJim@Gmail.com,a@b.co ;a@b.co nope" }).BOOTSTRAP_OWNER_EMAILS)
      .toEqual(["mrdotjim@gmail.com", "a@b.co"]);
    expect(loadConfig({ NODE_ENV: "test" }).BOOTSTRAP_OWNER_EMAILS).toEqual([]);
    expect(parseEmailList("X@Y.z")).toEqual(["x@y.z"]);
  });

  it("approves a listed, verified email on first sign-in as owner of the default org (case-insensitive)", async () => {
    const { me } = await setup();
    const r = await me("MrDotJim@Gmail.com", true);
    expect(r.statusCode).toBe(200);
    expect(r.json().memberships).toEqual([expect.objectContaining({ orgId: DEMO_ORG_ID, role: "owner" })]);
    expect((await me("MrDotJim@Gmail.com", true)).json().memberships).toHaveLength(1); // idempotent
  });

  it("refuses an unverified email and anyone not on the list", async () => {
    let { me } = await setup();
    expect((await me("mrdotjim@gmail.com", false)).json().code).toBe("not_approved");
    expect((await me("someone@gmail.com", true)).json().code).toBe("not_approved");
    await app.close();
    ({ me } = await setup({}));
    expect((await me("mrdotjim@gmail.com", true)).json().code).toBe("not_approved");
  });
});
