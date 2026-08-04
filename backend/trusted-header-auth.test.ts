import { describe, expect, test } from "bun:test";
import { ipMatchesCidr } from "./trusted-header-auth";

describe("trusted-header source restrictions", () => {
  test("matches exact addresses and IPv4 CIDRs", () => {
    expect(ipMatchesCidr("10.20.1.9", "10.20.0.0/16")).toBe(true);
    expect(ipMatchesCidr("10.21.1.9", "10.20.0.0/16")).toBe(false);
    expect(ipMatchesCidr("192.0.2.1", "192.0.2.1")).toBe(true);
  });
  test("rejects malformed source ranges", () => {
    expect(ipMatchesCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(ipMatchesCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
  });
});
