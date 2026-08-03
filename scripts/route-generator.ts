import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateRouteTree as generateRichieRouteTree } from "@richie-router/tooling";
import type { SpaRoutesManifest } from "@richie-router/server";

export const GENERATED_ROUTE_TREE_FILE = "route-tree.gen.ts";
export const GENERATED_ROUTE_MANIFEST_FILE = "route-manifest.gen.ts";
export const GENERATED_SPA_ROUTES_FILE = "spa-routes.gen.json";

const GENERATED_ROUTE_ARTIFACT_FILES = [
  GENERATED_ROUTE_TREE_FILE,
  GENERATED_ROUTE_MANIFEST_FILE,
  GENERATED_SPA_ROUTES_FILE,
] as const;

export function getGeneratedDir(projectRoot: string): string {
  return path.join(projectRoot, "generated");
}

function getGeneratedRouteArtifactPaths(generatedDir: string): string[] {
  return GENERATED_ROUTE_ARTIFACT_FILES.map((fileName) => path.join(generatedDir, fileName));
}

function loadSpaRoutesManifestFromPath(manifestPath: string): SpaRoutesManifest | null {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SpaRoutesManifest;
  } catch {
    return null;
  }
}

function rewriteRouterSchemaImports(content: string): string {
  return content
    .replace(
      /import\s+\{\s*routerSchema\s*\}\s+from\s+["'][^"']*shared\/router-schema\.ts["'];?/g,
      'import { routerSchema } from "@/shared/router-schema.ts";',
    )
    .replace(
      /import\s+type\s+\{\s*RouterSchema\s*\}\s+from\s+["'][^"']*shared\/router-schema\.ts["'];?/g,
      'import type { RouterSchema } from "@/shared/router-schema.ts";',
    );
}

async function rewriteGeneratedFile(filePath: string, rewriteImportRegex?: RegExp): Promise<void> {
  if (!fs.existsSync(filePath)) {
    return;
  }

  let content = await Bun.file(filePath).text();
  if (rewriteImportRegex) {
    content = content.replace(rewriteImportRegex, "@/frontend/");
  }
  content = rewriteRouterSchemaImports(content);
  await Bun.write(filePath, content);
}

function validateGeneratedRouteFile(filePath: string, content: string): void {
  const frontendImport = content.match(/from\s+["'](?!@\/frontend\/)[^"']*frontend\/routes\/[^"']*["']/);
  if (frontendImport) {
    throw new Error(`Generated route artifact ${path.basename(filePath)} contains an unresolved frontend import: ${frontendImport[0]}`);
  }

  const routerSchemaImport = content.match(/from\s+["'](?!@\/shared\/router-schema\.ts["'])[^"']*shared\/router-schema\.ts["']/);
  if (routerSchemaImport) {
    throw new Error(
      `Generated route artifact ${path.basename(filePath)} contains an unresolved router schema import: ${routerSchemaImport[0]}`,
    );
  }
}

async function validateGeneratedRouteArtifacts(paths: Record<(typeof GENERATED_ROUTE_ARTIFACT_FILES)[number], string>): Promise<void> {
  for (const [fileName, filePath] of Object.entries(paths)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Richie Router tooling did not emit ${fileName} at ${filePath}.`);
    }
  }

  for (const fileName of [GENERATED_ROUTE_TREE_FILE, GENERATED_ROUTE_MANIFEST_FILE] as const) {
    const filePath = paths[fileName];
    validateGeneratedRouteFile(filePath, await Bun.file(filePath).text());
  }

  const spaRoutesManifest = loadSpaRoutesManifestFromPath(paths[GENERATED_SPA_ROUTES_FILE]);
  if (!spaRoutesManifest) {
    throw new Error(`Richie Router tooling emitted invalid ${GENERATED_SPA_ROUTES_FILE} at ${paths[GENERATED_SPA_ROUTES_FILE]}.`);
  }
}

async function deleteGeneratedRouteArtifacts(generatedDir: string): Promise<void> {
  await Promise.all(getGeneratedRouteArtifactPaths(generatedDir).map((artifactPath) => fs.promises.rm(artifactPath, { force: true })));
}

export async function generateRoutes(projectRoot = process.cwd()): Promise<SpaRoutesManifest | null> {
  const frontendPath = path.join(projectRoot, "frontend");
  const routesDir = path.join(frontendPath, "routes");
  const rootRoute = path.join(routesDir, "__root.tsx");
  const sharedPath = path.join(projectRoot, "shared");
  const generatedDir = getGeneratedDir(projectRoot);

  if (!fs.existsSync(routesDir) || !fs.existsSync(rootRoute)) {
    await deleteGeneratedRouteArtifacts(generatedDir);
    console.log("[routes] No frontend route tree found; generated artifacts removed.");
    return null;
  }

  fs.mkdirSync(generatedDir, { recursive: true });

  const generationId = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const tempPaths = Object.fromEntries(
    GENERATED_ROUTE_ARTIFACT_FILES.map((fileName) => {
      const extension = path.extname(fileName);
      const basename = fileName.slice(0, -extension.length);
      return [fileName, path.join(generatedDir, `.${basename}.${generationId}.tmp${extension}`)];
    }),
  ) as Record<(typeof GENERATED_ROUTE_ARTIFACT_FILES)[number], string>;

  try {
    await generateRichieRouteTree({
      routesDir,
      routerSchema: path.join(sharedPath, "router-schema.ts"),
      output: tempPaths[GENERATED_ROUTE_TREE_FILE],
      manifestOutput: tempPaths[GENERATED_ROUTE_MANIFEST_FILE],
      jsonOutput: tempPaths[GENERATED_SPA_ROUTES_FILE],
      quoteStyle: "double",
      semicolons: true,
    });

    await rewriteGeneratedFile(tempPaths[GENERATED_ROUTE_TREE_FILE], /(?:\.\/)?(?:\.\.\/)+frontend\//g);
    await rewriteGeneratedFile(tempPaths[GENERATED_ROUTE_MANIFEST_FILE]);
    await validateGeneratedRouteArtifacts(tempPaths);

    for (const fileName of GENERATED_ROUTE_ARTIFACT_FILES) {
      await fs.promises.rename(tempPaths[fileName], path.join(generatedDir, fileName));
    }

    console.log(`[routes] Generated Richie Router artifacts in ${path.relative(projectRoot, generatedDir)}`);
    return loadSpaRoutesManifestFromPath(path.join(generatedDir, GENERATED_SPA_ROUTES_FILE));
  } catch (error) {
    await Promise.all(Object.values(tempPaths).map((artifactPath) => fs.promises.rm(artifactPath, { force: true }))).catch(() => {});
    throw error;
  }
}

export function readSpaRoutesManifest(projectRoot = process.cwd()): SpaRoutesManifest | null {
  return loadSpaRoutesManifestFromPath(path.join(getGeneratedDir(projectRoot), GENERATED_SPA_ROUTES_FILE));
}
