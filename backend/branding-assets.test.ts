import { describe, expect, test } from "bun:test";
import { inspectImage, validateBrandingImage } from "./branding-assets";

describe("branding image validation", () => {
  test("sniffs PNG content and dimensions", () => {
    const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer); view.setUint32(16, 64); view.setUint32(20, 32);
    expect(inspectImage(bytes)).toEqual({ mimeType: "image/png", width: 64, height: 32 });
    expect(validateBrandingImage(bytes, "image/png", "logo").width).toBe(64);
  });
  test("rejects MIME mismatches and excessive dimensions", () => {
    const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer); view.setUint32(16, 4096); view.setUint32(20, 32);
    expect(() => validateBrandingImage(bytes, "image/jpeg", "logo")).toThrow("does not match");
    expect(() => validateBrandingImage(bytes, "image/png", "logo")).toThrow("dimensions");
  });
});
