import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { NODE_ENV: "test" };

describe("config: Quickvee login", () => {
  it("reads store name and username", () => {
    const c = loadConfig({ ...base, QUICKVEE_STORE_NAME: "cloud9", QUICKVEE_USERNAME: "jim", QUICKVEE_PASSWORD: "pw" });
    expect([c.QUICKVEE_STORE_NAME, c.QUICKVEE_USERNAME]).toEqual(["cloud9", "jim"]);
  });
  it("keeps QUICKVEE_EMAIL as a deprecated alias for the username", () => {
    expect(loadConfig({ ...base, QUICKVEE_EMAIL: "jim@store.test" }).QUICKVEE_USERNAME).toBe("jim@store.test");
    expect(loadConfig({ ...base, QUICKVEE_EMAIL: "old@store.test", QUICKVEE_USERNAME: "jim" }).QUICKVEE_USERNAME).toBe("jim");
  });
});

describe("config: Supabase key formats", () => {
  const invites = { ...base, INVITE_MAILER: "supabase", SUPABASE_URL: "https://abc.supabase.co" };
  it("accepts a new sb_secret_ key as SUPABASE_SERVICE_ROLE_KEY", () => {
    expect(loadConfig({ ...invites, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abcdefghijklmnopqrstuvwxyz012345" }).SUPABASE_SERVICE_ROLE_KEY)
      .toBe("sb_secret_abcdefghijklmnopqrstuvwxyz012345");
  });
  it("accepts SUPABASE_SECRET_KEY as an alias", () => {
    expect(loadConfig({ ...invites, SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnopqrstuvwxyz012345" }).SUPABASE_SERVICE_ROLE_KEY)
      .toBe("sb_secret_abcdefghijklmnopqrstuvwxyz012345");
  });
  it("still requires a key for Supabase invites", () => {
    expect(() => loadConfig(invites)).toThrow(/SUPABASE_SECRET_KEY/);
  });
  it("does not require DATABASE_CA_CERT", () => {
    expect(loadConfig({ ...base, DATA_STORE: "postgres", DATABASE_URL: "postgres://u:p@localhost:5432/db" }).DATABASE_CA_CERT).toBeUndefined();
  });
});
