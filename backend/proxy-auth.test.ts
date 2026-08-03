import { describe, expect, test } from "bun:test";
import { extractBearerToken, hashApiKey } from "./api-key-utils";
import { PROXY_SCOPES, requireProxyScope, type ProxyAuthResult } from "./proxy-principal";

describe("API key primitives", () => {
  test("parses case-insensitive bearer authorization", () => {
    expect(extractBearerToken(new Request("https://proxy.example/v1/models", {
      headers: { Authorization: "bearer llmp_example" },
    }))).toBe("llmp_example");
    expect(extractBearerToken(new Request("https://proxy.example/v1/models"))).toBeNull();
  });

  test("uses deterministic SHA-256 key digests", async () => {
    expect(await hashApiKey("llmp_example")).toBe(
      "63f380cdd99052c817c36c106ff535a3a043249e756bdc5737cceaf9fe96057a",
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
    expect(requireProxyScope(principal, "llm.invoke")).toEqual({
      ok: false,
      status: 403,
      message: "Missing required scope: llm.invoke",
      code: "insufficient_scope",
    });
  });

  test("defines stable public scopes", () => {
    expect(PROXY_SCOPES).toEqual(["llm.invoke", "models.read", "credits.read"]);
  });
});
