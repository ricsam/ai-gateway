import { describe, expect, test } from "bun:test";
import { checkAuthorizationResponseIssuer, oidcAccountSubject } from "./oidc-identity";

const issuer = "https://idp.example.com/tenant/v2.0";

describe("OIDC authorization-response issuer (RFC 9207)", () => {
  test("accepts the configured issuer", () => {
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: true }, issuer)).toBe("ok");
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: false }, issuer)).toBe("ok");
  });

  test("rejects a different issuer even when the provider does not advertise iss support", () => {
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: false }, "https://evil.example.com")).toBe("issuer_mismatch");
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: true }, `${issuer}/`)).toBe("issuer_mismatch");
  });

  test("requires iss only from providers that advertise it", () => {
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: true }, undefined)).toBe("issuer_missing");
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: true }, "")).toBe("issuer_missing");
    expect(checkAuthorizationResponseIssuer({ providerKey: "idp", issuer, requireAuthorizationResponseIssuer: false }, undefined)).toBe("ok");
  });
});

describe("OIDC account subject", () => {
  test("uses Better Auth's verified sub by default", () => {
    expect(oidcAccountSubject("sub")).toBeUndefined();
  });

  test("reads a custom immutable claim", () => {
    const resolve = oidcAccountSubject("oid")!;
    expect(resolve({ profile: { sub: "pairwise", oid: "00000000-0000-0000-0000-000000000001" } })).toBe("00000000-0000-0000-0000-000000000001");
    expect(resolve({ profile: { oid: 42 } })).toBe("42");
  });

  test("fails closed instead of falling back to another claim", () => {
    const resolve = oidcAccountSubject("oid")!;
    expect(resolve({ profile: { sub: "pairwise" } })).toBe("");
    expect(resolve({ profile: { oid: { nested: true } } })).toBe("");
  });
});
