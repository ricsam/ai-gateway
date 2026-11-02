import { describe, expect, test } from "bun:test";
import { formatActiveHours, formatPeakMinute, formatThroughput } from "./throughput-format";

describe("throughput formatting", () => {
  test.each([
    [0, "0"], [-1, "0"], [Number.NaN, "0"], [Number.POSITIVE_INFINITY, "0"],
    [1 / 60, "0.0167"], [0.5, "0.5"], [4.256, "4.26"], [9.994, "9.99"],
    [12.345, "12.3"], [99.94, "99.9"], [123.6, "124"], [1_234_567.4, "1,234,567"],
  ])("%p is shown as %p", (value, expected) => {
    expect(formatThroughput(value, "en-US")).toBe(expected);
  });

  test("shows the peak minute in the requested time zone", () => {
    expect(formatPeakMinute("2026-11-02T09:41:00.000Z", "en-US", "UTC")).toBe("Nov 2, 09:41 AM");
    expect(formatPeakMinute("2026-11-02T09:41:00.000Z", "en-US", "Europe/Stockholm")).toBe("Nov 2, 10:41 AM");
    expect(formatPeakMinute(null)).toBeNull();
    expect(formatPeakMinute("invalid")).toBeNull();
  });

  test("describes the steady-state basis", () => {
    expect(formatActiveHours(0)).toBe("No requests in this range");
    expect(formatActiveHours(1, "en-US")).toBe("Average over 1 active hour");
    expect(formatActiveHours(8760, "en-US")).toBe("Average over 8,760 active hours");
  });
});
