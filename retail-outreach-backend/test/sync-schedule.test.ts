import { describe, expect, it } from "vitest";
import { nextRunAfter, occurrenceLocal, parseLocal, toLocal, zonedToUtc, formatLocal } from "../src/sync/schedule.js";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const local = (ms: number, tz = NY) => formatLocal(toLocal(ms, tz));

describe("schedule math", () => {
  it("first run is the start itself when it's in the future", () => {
    expect(nextRunAfter("2026-11-15T10:00:00", "daily", NY, at("2026-11-07T12:00:00Z"))!.toISOString()).toBe("2026-11-15T15:00:00.000Z");
  });
  it("daily keeps 10:00 local across DST (UTC hour shifts)", () => {
    const before = nextRunAfter("2026-03-01T10:00:00", "daily", NY, at("2026-03-07T16:00:00Z"))!; // after Mar 7 10:00 EST
    expect(before.toISOString()).toBe("2026-03-08T14:00:00.000Z"); // Mar 8 is spring-forward: 10:00 EDT = 14:00Z
    expect(local(before.getTime())).toBe("2026-03-08T10:00:00");
    const fall = nextRunAfter("2026-10-01T10:00:00", "daily", NY, at("2026-11-01T13:00:00Z"))!;
    expect(fall.toISOString()).toBe("2026-11-01T15:00:00.000Z"); // Nov 1 fall-back: 10:00 EST = 15:00Z
  });
  it("DST gap moves forward; ambiguous fall-back time uses the first occurrence", () => {
    expect(new Date(zonedToUtc(parseLocal("2026-03-08T02:30:00")!, NY)).toISOString()).toBe("2026-03-08T07:30:00.000Z"); // = 03:30 EDT
    expect(local(zonedToUtc(parseLocal("2026-03-08T02:30:00")!, NY))).toBe("2026-03-08T03:30:00");
    expect(new Date(zonedToUtc(parseLocal("2026-11-01T01:30:00")!, NY)).toISOString()).toBe("2026-11-01T05:30:00.000Z"); // EDT instance
  });
  it("monthly clamps to month end without drifting", () => {
    const s = parseLocal("2026-01-31T09:00:00")!;
    expect([1, 2, 3, 4].map(n => formatLocal(occurrenceLocal(s, "monthly", n)).slice(0, 10))).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(formatLocal(occurrenceLocal(parseLocal("2027-12-31T09:00:00")!, "monthly", 2)).slice(0, 10)).toBe("2028-02-29");
  });
  it("yearly from Feb 29 clamps to Feb 28, back to 29 in leap years", () => {
    const s = parseLocal("2028-02-29T08:00:00")!;
    expect([1, 4].map(n => formatLocal(occurrenceLocal(s, "yearly", n)).slice(0, 10))).toEqual(["2029-02-28", "2032-02-29"]);
  });
  it("weekly and missed runs: next is the first slot after now (catch-up runs once, not N times)", () => {
    // Started Sunday Nov 15 2026 10:00; the server was down for 3 weeks.
    const next = nextRunAfter("2026-11-15T10:00:00", "weekly", NY, at("2026-12-09T00:00:00Z"))!;
    expect(local(next.getTime())).toBe("2026-12-13T10:00:00");
    const m = nextRunAfter("2026-01-31T09:00:00", "monthly", NY, at("2026-11-07T12:00:00Z"))!;
    expect(local(m.getTime())).toBe("2026-11-30T09:00:00");
    expect(nextRunAfter("2026-11-15T10:00:00", "off", NY, 0)).toBeNull();
  });
  it("is exact at the boundary (strictly after)", () => {
    const t = at("2026-11-15T15:00:00Z");
    expect(nextRunAfter("2026-11-15T10:00:00", "daily", NY, t)!.toISOString()).toBe("2026-11-16T15:00:00.000Z");
    expect(nextRunAfter("2026-11-15T10:00:00", "daily", NY, t - 1)!.toISOString()).toBe("2026-11-15T15:00:00.000Z");
  });
  it("other timezones", () => {
    expect(nextRunAfter("2026-11-15T10:00:00", "daily", "Asia/Kolkata", 0)!.toISOString()).toBe("2026-11-15T04:30:00.000Z");
    expect(local(nextRunAfter("2026-03-29T01:30:00", "daily", "Europe/London", at("2026-03-28T12:00:00Z"))!.getTime(), "Europe/London")).toBe("2026-03-29T02:30:00");
  });
  it("rejects bad input", () => {
    expect(parseLocal("2026-02-30T10:00:00")).toBeNull();
    expect(parseLocal("11/15/2026 10:00")).toBeNull();
    expect(parseLocal("2026-11-15T10:00")).toMatchObject({ s: 0 });
  });
});
