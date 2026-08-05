import { describe, expect, test } from "bun:test";
import { extractBearerToken, hashApiKey } from "./api-key-utils";
import { PROXY_SCOPES, requireProxyScope, type ProxyAuthResult } from "./proxy-principal";

describe("API key primitives", () => {
  test("parses case-insensitive bearer authorization", () => {
    expect(extractBearerToken(new Request("https://gateway.example/v1/models", {
      headers: { Authorization: "bearer aig_example" },
    }))).toBe("aig_example");
    expect(extractBearerToken(new Request("https://gateway.example/v1/models"))).toBeNull();
  });

  test("uses deterministic SHA-256 key digests", async () => {
    expect(await hashApiKey("aig_example")).toBe(
      "e049e571b241ef24ea3026bd113dff4af69fbc577a6501e75ac1318c6e7d05fc",
    );
  });
});

describe("proxy scope authorization", () => {
  const principal: ProxyAuthResult = {
    ok: true,
    principal: { userId: "user-1", credentialType: "api_key", credentialId: "key-1", scopes: new Set(["models.read"]) },
  };

  test("accepts a granted endpoint scope", () => {
    expect(requireProxyScope(principal, "models.read")).toBe(principal);
  });

  test("returns a forbidden result for a missing endpoint scope", () => {
    expect(requireProxyScope(principal, "ai.invoke")).toEqual({
      ok: false,
      status: 403,
      message: "Missing required scope: ai.invoke",
      code: "insufficient_scope",
    });
  });

  test("defines stable public scopes", () => {
    expect(PROXY_SCOPES).toEqual(["ai.invoke", "models.read", "credits.read"]);
  });
});
