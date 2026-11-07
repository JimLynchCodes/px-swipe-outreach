import { describe, expect, it } from "vitest";
import { assembleSms, checkCopy, isGsm7, type CopyCheckContext } from "../src/ai/compliance.js";

const promo = { id: "p1", title: "Mellow Monday", discountType: "percent" as const, discountValue: 15, endsOn: null };
const ctx = (o: Partial<CopyCheckContext> = {}): CopyCheckContext => ({
  channel: "sms", firstName: "Sarah", lastName: "Mitchell", promotion: promo, offerPercent: null, maxDiscountPercent: 25, smsSignature: "-Cloud 9", now: new Date("2026-11-09T12:00:00"), ...o
});
const codes = (smsText: string, o?: Partial<CopyCheckContext>) => checkCopy({ smsText }, ctx(o)).violations.map(v => v.code);
const OK = "Hi Sarah! Mellow Monday: 15% off CBD this Monday. 21+ w/ ID.";

describe("compliance validator", () => {
  it("accepts compliant copy", () => expect(codes(OK)).toEqual([]));

  it.each([
    ["health_claim", "Hi Sarah! Mellow Monday: 15% off CBD to help with anxiety. 21+"],
    ["health_claim", "Hi Sarah! Mellow Monday: 15% off our therapeutic CBD. 21+"],
    ["safety_claim", "Hi Sarah! Mellow Monday: 15% off, a safer alternative to smoking. 21+"],
    ["safety_claim", "Hi Sarah! Mellow Monday 15% off. Ready to quit smoking? 21+"],
    ["youth_appeal", "Hi Sarah! Mellow Monday: 15% off candy flavors. 21+"],
    ["youth_appeal", "Hi Sarah! Back to school? Mellow Monday 15% off. 21+"],
    ["free_tobacco", "Hi Sarah! Mellow Monday 15% off plus a free vape with any purchase. 21+"],
    ["free_tobacco", "Hi Sarah! Mellow Monday 15% off and a giveaway. 21+"],
    ["intoxication", "Hi Sarah! Mellow Monday 15% off, time to get high. 21+"],
    ["fake_urgency", "Hi Sarah! Hurry, Mellow Monday 15% off. 21+"],
    ["over_cap", "Hi Sarah! Mellow Monday: 30% off CBD. 21+"],
    ["invented_discount", "Hi Sarah! Mellow Monday: 20% off CBD. 21+"],
    ["invented_discount", "Hi Sarah! Mellow Monday: buy one get one CBD. 21+"],
    ["ungrounded", "Hi Sarah! Something nice for you this week. 21+"],
    ["no_name", "Hey there! Mellow Monday: 15% off CBD. 21+"],
    ["last_name", "Hi Sarah Mitchell! Mellow Monday: 15% off CBD. 21+"],
    ["self_opt_out", "Hi Sarah! Mellow Monday: 15% off CBD. 21+ Reply STOP to opt out"],
    ["sms_too_long", `${OK} ${"We restocked everything on the CBD shelf. ".repeat(3)}`]
  ])("rejects %s: %s", (code, text) => expect(codes(text)).toContain(code));

  it("allows mentioning a real end date within 2 days, but not urgency otherwise", () => {
    const text = "Hi Sarah! Last chance: Mellow Monday 15% off ends today. 21+";
    expect(codes(text, { promotion: { ...promo, endsOn: "2026-11-10" } })).not.toContain("fake_urgency");
    expect(codes(text, { promotion: { ...promo, endsOn: "2026-12-31" } })).toContain("fake_urgency");
  });

  it("grounds the standing offer when there is no promotion", () => {
    expect(codes("Hi Sarah, here's 10% off your next visit. 21+", { promotion: null, offerPercent: 10 })).toEqual([]);
    expect(codes("Hi Sarah, here's 15% off your next visit. 21+", { promotion: null, offerPercent: 10 })).toContain("invented_discount");
  });

  it("checks amount deals in dollars", () => {
    const amt = { id: "p2", title: "Glass Hump Day", discountType: "amount" as const, discountValue: 1500, endsOn: null };
    expect(codes("Hi Sarah! Glass Hump Day: $15 off glass. 21+", { promotion: amt })).toEqual([]);
    expect(codes("Hi Sarah! Glass Hump Day: $25 off glass. 21+", { promotion: amt })).toContain("invented_discount");
  });

  it("counts the signature and opt-out line toward 160 and warns on non-GSM-7", () => {
    const final = assembleSms(OK, "-Cloud 9");
    expect(final).toBe(`${OK} -Cloud 9\nReply STOP to opt out.`);
    const budget = 160 - final.length + OK.length;
    expect(codes("Hi Sarah! Mellow Monday 15% off. 21+".padEnd(budget, "."))).not.toContain("sms_too_long");
    expect(codes("Hi Sarah! Mellow Monday 15% off. 21+".padEnd(budget + 1, "."))).toContain("sms_too_long");
    expect(isGsm7(final)).toBe(true);
    expect(checkCopy({ smsText: `${OK} 🔥` }, ctx()).warnings[0]).toMatch(/UCS-2/);
  });

  it("enforces email subject and body length", () => {
    const v = checkCopy({ emailSubject: "x".repeat(51) + " Sarah Mellow Monday", emailBody: "Hi Sarah, Mellow Monday 15% off. " + "y".repeat(700) }, ctx({ channel: "email" })).violations.map(x => x.code);
    expect(v).toEqual(expect.arrayContaining(["subject_too_long", "body_too_long"]));
    expect(checkCopy({ emailSubject: "Mellow Monday: 15% off, Sarah", emailBody: "Hi Sarah,\n\nMellow Monday is 15% off CBD.\n\n21+ with ID." }, ctx({ channel: "email" })).violations).toEqual([]);
  });
});
