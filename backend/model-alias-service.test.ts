import { describe, expect, test } from "bun:test";
import { aliasInputSchema, appInputSchema } from "../shared/alias-contract";
import { assertPublicNamespace, appResponse } from "./model-alias-service";
import type { loadModelCatalog } from "./model-alias-service";

type Catalog = Awaited<ReturnType<typeof loadModelCatalog>>;
function catalog(models: string[], aliases: string[], apps: Array<{ name: string; tiers: Array<{ name: string; aliasId: string | null }> }>): Catalog {
  return {
    models: models.map((modelId, index) => ({ id: `model-${index}`, modelId })),
    aliases: aliases.map((modelId, index) => ({ id: `alias-${index}`, modelId, enabled: false })),
    apps: apps.map((app, index) => ({ ...app, id: `app-${index}`, enabled: false })),
  } as Catalog;
}
describe("catalog public namespace", () => {
  test("rejects model/alias collisions even when alias disabled", () => {
    expect(() => assertPublicNamespace(catalog(["fast"], ["fast"], []))).toThrow("already in use");
  });
  test("reserves disabled and unmapped app tiers", () => {
    expect(() => assertPublicNamespace(catalog(["editor-fast"], [], [{ name: "editor", tiers: [{ name: "fast", aliasId: null }] }]))).toThrow("already in use");
  });
  test("rejects ambiguous concatenations across apps and duplicate tier names", () => {
    expect(() => assertPublicNamespace(catalog([], [], [
      { name: "a-b", tiers: [{ name: "c", aliasId: null }] },
      { name: "a", tiers: [{ name: "b-c", aliasId: null }] },
    ]))).toThrow("already in use");
    expect(() => assertPublicNamespace(catalog([], [], [{ name: "a", tiers: [{ name: "b", aliasId: null }, { name: "b", aliasId: null }] }]))).toThrow("already in use");
  });
  test("rejects duplicate app names without tiers", () => {
    expect(() => assertPublicNamespace(catalog([], [], [{ name: "a", tiers: [] }, { name: "a", tiers: [] }]))).toThrow("already exists");
  });
  test("accepts disjoint IDs", () => {
    expect(() => assertPublicNamespace(catalog(["upstream"], ["fast"], [{ name: "editor", tiers: [{ name: "fast", aliasId: null }] }]))).not.toThrow();
  });
});
test("complete alias bodies and strict slug/effort vocabulary", () => {
  const input = { modelId: "fast.v1_test", name: "Fast", description: null, upstreamModelId: crypto.randomUUID(), thinking: false, effort: null, enabled: true };
  expect(aliasInputSchema.safeParse(input).success).toBe(true);
  for (const patch of [{ modelId: "A" }, { modelId: "a/b" }, { modelId: "x".repeat(129) }, { effort: "none" }, { upstreamModelId: "alias" }]) {
    expect(aliasInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
  expect(aliasInputSchema.safeParse({ modelId: "a" }).success).toBe(false);
});
test("app slugs and generated tier output", () => {
  const input = { name: "my-app", description: null, enabled: false, tiers: [{ name: "fast", aliasId: null }] };
  expect(appInputSchema.safeParse(input).success).toBe(true);
  expect(appInputSchema.safeParse({ ...input, name: "my_app" }).success).toBe(false);
  const now = new Date();
  const output = appResponse({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now });
  expect(output.tiers[0]?.modelId).toBe("my-app-fast");
  expect(output.createdAt).toBe(now.toISOString());
});
