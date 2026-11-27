import { describe, expect, test } from "bun:test";
import type { BetterAuthOptions } from "better-auth";
// Better Auth's own parsing, to check that the gateway accepts exactly what Better Auth applies.
import { findInvalidTrustedProxies, getIP } from "@better-auth/core/utils/ip";
import { clientIpOptions, isIpAddressOrCidr, parseClientIpHeaders, parseTrustedProxies } from "./client-ip";

const client = "203.0.113.7";

function resolve(headers: string[], trustedProxies: string[], request: Record<string, string>): string | null {
  const ipAddress = clientIpOptions(headers, trustedProxies);
  return getIP(new Headers(request), (ipAddress ? { advanced: { ipAddress } } : {}) as BetterAuthOptions);
}

describe("CLIENT_IP_HEADERS", () => {
  test("is empty when unset or blank", () => {
    expect(parseClientIpHeaders("CLIENT_IP_HEADERS", undefined)).toEqual([]);
    expect(parseClientIpHeaders("CLIENT_IP_HEADERS", " , ")).toEqual([]);
  });

  test("lists header names in order, lowercased and without repeats", () => {
    expect(parseClientIpHeaders("CLIENT_IP_HEADERS", " CF-Connecting-IP, x-forwarded-for,cf-connecting-ip ")).toEqual(["cf-connecting-ip", "x-forwarded-for"]);
  });

  test("refuses values that are not header names", () => {
    expect(() => parseClientIpHeaders("CLIENT_IP_HEADERS", "cf-connecting-ip, x real ip, x-ip:")).toThrow("CLIENT_IP_HEADERS must list HTTP header names separated by commas; not a header name: x real ip, x-ip:");
  });
});

describe("TRUSTED_PROXIES", () => {
  test("is empty when unset or blank", () => {
    expect(parseTrustedProxies("TRUSTED_PROXIES", undefined)).toEqual([]);
    expect(parseTrustedProxies("TRUSTED_PROXIES", "")).toEqual([]);
  });

  test("lists addresses and CIDR ranges without repeats", () => {
    expect(parseTrustedProxies("TRUSTED_PROXIES", "10.42.0.0/16, 192.0.2.10 ,2001:db8::/32,10.42.0.0/16")).toEqual(["10.42.0.0/16", "192.0.2.10", "2001:db8::/32"]);
  });

  test("refuses entries that are not addresses or CIDR ranges", () => {
    expect(() => parseTrustedProxies("TRUSTED_PROXIES", "10.42.0.0/16, 10.42.0.0/33, proxy.internal")).toThrow("TRUSTED_PROXIES must list IP addresses or CIDR ranges separated by commas; not an IP address or CIDR range: 10.42.0.0/33, proxy.internal");
  });

  test("accepts exactly the entries Better Auth applies", () => {
    const samples = [
      "10.42.0.0/16", "192.0.2.10", "0.0.0.0/0", "10.0.0.0/08", "10.0.0.0/32", "2001:db8::/32", "::1", "::/0", "2001:db8::1/128", "::ffff:10.0.0.1", "::ffff:10.0.0.0/24",
      "10.0.0.0/33", "10.0.0.256", "10.0.0", "010.0.0.1", "10.0.0.0/", "10.0.0.0/+8", "10.0.0.0/-1", "10.0.0.0/8/8", "2001:db8::/129", "::ffff:10.0.0.0/120", "fe80::1%eth0", "proxy.internal", " ",
    ];
    for (const sample of samples) expect({ sample, accepted: isIpAddressOrCidr(sample) }).toEqual({ sample, accepted: findInvalidTrustedProxies([sample]).length === 0 });
  });
});

describe("client IP resolution", () => {
  test("keeps Better Auth's defaults without settings", () => {
    expect(clientIpOptions([], [])).toBeUndefined();
    expect(resolve([], [], { "x-forwarded-for": client })).toBe(client);
    expect(resolve([], [], { "x-forwarded-for": `${client}, 10.42.0.12` })).not.toBe(client);
  });

  test("walks X-Forwarded-For past trusted proxies to the client", () => {
    expect(clientIpOptions([], ["10.42.0.0/16"])).toEqual({ trustedProxies: ["10.42.0.0/16"] });
    expect(resolve([], ["10.42.0.0/16"], { "x-forwarded-for": `${client}, 10.42.0.12` })).toBe(client);
    expect(resolve([], ["10.42.0.0/16"], { "x-forwarded-for": `${client}, 10.42.3.4, 10.42.0.12` })).toBe(client);
    // Addresses a client puts before its own cannot replace it.
    expect(resolve([], ["10.42.0.0/16"], { "x-forwarded-for": `198.51.100.9, ${client}, 10.42.0.12` })).toBe(client);
  });

  test("reads the configured headers in order", () => {
    expect(clientIpOptions(["cf-connecting-ip"], [])).toEqual({ ipAddressHeaders: ["cf-connecting-ip"] });
    expect(resolve(["cf-connecting-ip"], [], { "cf-connecting-ip": client, "x-forwarded-for": "10.42.0.12" })).toBe(client);
    expect(resolve(["cf-connecting-ip", "x-forwarded-for"], [], { "x-forwarded-for": client })).toBe(client);
    expect(resolve(["cf-connecting-ip"], [], { "x-forwarded-for": client })).not.toBe(client);
    expect(clientIpOptions(["x-forwarded-for"], ["10.42.0.0/16"])).toEqual({ ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["10.42.0.0/16"] });
  });
});
