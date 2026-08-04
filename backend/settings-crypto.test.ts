import { describe, expect, test } from "bun:test";
import { applySecretWrite, decryptSetting, encryptSetting, secretStatus } from "./settings-crypto";

describe("encrypted settings", () => {
  test("uses authenticated context-bound versioned envelopes", async () => {
    const envelope = await encryptSetting("sensitive-value", "oidc:test");
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain("sensitive-value");
    expect(await decryptSetting(envelope, "oidc:test")).toBe("sensitive-value");
    await expect(decryptSetting(envelope, "aws:test")).rejects.toThrow("Could not decrypt setting");
  });

  test("supports preserve, replace, and clear without returning plaintext", async () => {
    const original = await encryptSetting("first", "aws:secret");
    expect(await applySecretWrite(original, { operation: "preserve" }, "aws:secret")).toBe(original);
    const replacement = await applySecretWrite(original, { operation: "replace", value: "second" }, "aws:secret");
    expect(await decryptSetting(replacement!, "aws:secret")).toBe("second");
    expect(await applySecretWrite(replacement, { operation: "clear" }, "aws:secret")).toBeNull();
    expect(secretStatus(replacement)).toEqual({ configured: true });
  });
});
