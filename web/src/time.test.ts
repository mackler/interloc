import { describe, expect, test } from "vitest";
import { clockTime, fullTime } from "./time.ts";

// Issue #1, decision Q4: local time to the second; the full date and time for the title. The locale and the time zone
// are given here so that the test does not depend on the machine.
const ISO = "2026-09-27T14:03:27.000Z";

describe("the time of a message", () => {
  test("the clock time is HH:MM:SS", () => {
    expect(clockTime(ISO, "en-GB", "UTC")).toBe("14:03:27");
    expect(clockTime(ISO, "en-GB", "Europe/Berlin")).toBe("16:03:27");
  });
  test("the full time has the date and the seconds", () => {
    const full = fullTime(ISO, "en-GB", "UTC");
    expect(full).toContain("27 September 2026");
    expect(full).toContain("14:03:27");
  });
  test("a time that cannot be read is shown as it is, not thrown on", () => {
    expect(clockTime("not a time", "en-GB", "UTC")).toBe("not a time");
    expect(fullTime("not a time", "en-GB", "UTC")).toBe("not a time");
  });
});
