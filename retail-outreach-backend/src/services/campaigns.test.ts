import { describe, it, expect } from "vitest";

describe("starter behavior", () => {
  it("documents supported channels", () => {
    const channels = ["sms", "email"];
    expect(channels).toContain("sms");
    expect(channels).toContain("email");
  });
});
