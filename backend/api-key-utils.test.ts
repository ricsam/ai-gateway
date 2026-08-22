import { describe, expect, test } from "bun:test";
import { USER_API_KEY_SCOPES, generateUserApiKey, userApiKeyScopes } from "./api-key-utils";

describe("user API key provisioning helpers", () => {
  test("generates an inference key with the public prefix", () => {
    expect(generateUserApiKey()).toMatch(/^aig_[0-9a-f]{64}$/);
  });

  test("deduplicates and validates scopes", () => {
    expect(USER_API_KEY_SCOPES).toEqual(["ai.invoke", "models.read", "credits.read"]);
    expect(userApiKeyScopes(["ai.invoke", "models.read", "ai.invoke"])).toEqual(["ai.invoke", "models.read"]);
    expect(() => userApiKeyScopes([])).toThrow("Select at least one");
    expect(() => userApiKeyScopes(["users.write"])).toThrow("valid API key scopes");
  });
});
