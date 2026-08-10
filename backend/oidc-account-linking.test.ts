import { describe, expect, test } from "bun:test";
import { trustedEmailLinkingProviders } from "./oidc-account-linking";

describe("OIDC email account linking", () => {
  test("trusts the sole enabled provider only when explicitly configured", () => {
    expect(trustedEmailLinkingProviders([{ providerKey: "entra", linkExistingUsersByEmail: true }])).toEqual(["entra"]);
  });

  test("remains disabled by default", () => {
    expect(trustedEmailLinkingProviders([{ providerKey: "entra", linkExistingUsersByEmail: false }])).toEqual([]);
    expect(trustedEmailLinkingProviders([])).toEqual([]);
  });

  test("fails closed when multiple providers are enabled", () => {
    expect(trustedEmailLinkingProviders([
      { providerKey: "entra", linkExistingUsersByEmail: true },
      { providerKey: "other", linkExistingUsersByEmail: true },
    ])).toEqual([]);
  });
});
