#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { matchesPassthroughPath, matchesSpaPath, type SpaRoutesManifest } from "@richie-router/server";
import { generateRoutes, getGeneratedDir, GENERATED_SPA_ROUTES_FILE, readSpaRoutesManifest } from "./route-generator";

const RICHIE_ROUTER_HEAD_PLACEHOLDER = "<!--richie-router-head-->";
const RICHIE_ROUTER_HEAD_RESPONSE_HEADER = "x-richie-router-head";

interface ServeOptions {
  projectRoot: string;
  host: string;
  port: number;
  baseUrl?: string;
  production: boolean;
}

type UserServeFetch = (this: unknown, request: Request, server: unknown) => Response | Promise<Response>;

function parseServeOptions(): ServeOptions {
  const { values } = parseArgs({
    options: {
      path: { type: "string" },
      port: { type: "string", default: "3000" },
      host: { type: "string", default: "localhost" },
      "base-url": { type: "string" },
      production: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log("Usage: bun scripts/serve.ts [--path <projectRoot>] [--port <n>] [--host <host>] [--base-url <url>] [--production]");
    process.exit(0);
  }

  const port = Number.parseInt(values.port ?? "3000", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${values.port}`);
  }

  return {
    projectRoot: path.resolve(values.path ?? process.cwd()),
    host: values.host ?? "localhost",
    port,
    baseUrl: values["base-url"],
    production: values.production ?? false,
  };
}

function fallbackBaseUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${normalizedHost}:${port}`;
}

function resolveServeBaseUrl(options: Pick<ServeOptions, "host" | "port" | "baseUrl">): URL {
  const candidate = options.baseUrl?.trim() || process.env.BASE_URL?.trim() || fallbackBaseUrl(options.host, options.port);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Invalid BASE_URL protocol "${parsed.protocol}". Only http:// or https:// are supported.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid BASE_URL protocol")) {
      throw error;
    }
    throw new Error(`Invalid BASE_URL "${candidate}". Use a full URL like https://proxy.example.com.`);
  }
}

function baseHrefFromUrl(baseUrl: URL): string {
  const pathname = baseUrl.pathname || "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function buildExportedHeadApiPath(baseHref: string, manifest: SpaRoutesManifest | null): string {
  const basePath = baseHref === "/" ? "" : baseHref.replace(/\/$/, "");
  const headBasePath = manifest?.hostedRouting?.headBasePath ?? "/head-api";
  return `${basePath}${headBasePath}`.replace(/\/{2,}/g, "/") || "/";
}

function buildExportedRichieHeadRequest(request: Request, baseHref: string, manifest: SpaRoutesManifest | null): Request {
  const requestUrl = new URL(request.url);
  const headUrl = new URL(request.url);
  headUrl.pathname = buildExportedHeadApiPath(baseHref, manifest);
  headUrl.search = new URLSearchParams({
    href: `${requestUrl.pathname}${requestUrl.search}`,
  }).toString();

  return new Request(headUrl.toString(), {
    method: "GET",
    headers: request.headers,
  });
}

function injectExportedHtmlHead(html: string, baseHref: string, richieRouterHead: string): string {
  const htmlWithBase = /<base\s+[^>]*href=(["'])[^"']*\1[^>]*>/i.test(html)
    ? html.replace(/<base\s+[^>]*href=(["'])[^"']*\1[^>]*>/i, `<base href="${baseHref}">`)
    : html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n  <base href="${baseHref}">`);

  return htmlWithBase.replace(RICHIE_ROUTER_HEAD_PLACEHOLDER, () => richieRouterHead);
}

async function resolveExportedRichieRouterHead(options: {
  request: Request;
  server: unknown;
  fetch?: UserServeFetch;
  thisArg: unknown;
  baseHref: string;
  manifest: SpaRoutesManifest | null;
}): Promise<{ richieRouterHead: string } | { response: Response }> {
  if (!options.fetch) {
    return { richieRouterHead: "" };
  }

  const headResponse = await options.fetch.call(
    options.thisArg,
    buildExportedRichieHeadRequest(options.request, options.baseHref, options.manifest),
    options.server,
  );
  const headResponseKind = headResponse.headers.get(RICHIE_ROUTER_HEAD_RESPONSE_HEADER);

  if (headResponseKind !== "document") {
    return { richieRouterHead: "" };
  }

  if (!headResponse.ok) {
    return { response: headResponse };
  }

  const payload = (await headResponse.json()) as { richieRouterHead?: unknown };
  if (typeof payload.richieRouterHead !== "string") {
    throw new Error("Richie Router head response did not include a richieRouterHead string.");
  }

  return {
    richieRouterHead: payload.richieRouterHead,
  };
}

function resolveSecurePath(basePath: string, relativePath: string): string {
  const sanitized = relativePath.replace(/^\/+/, "");
  const resolved = path.resolve(basePath, sanitized);
  if (!resolved.startsWith(basePath + path.sep) && resolved !== basePath) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}

class LocalFileHandle implements FileSystemFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  readonly fullPath: string;

  constructor(fullPath: string) {
    this.fullPath = fullPath;
    this.name = path.basename(fullPath);
  }

  async getFile(): Promise<File> {
    const bunFile = Bun.file(this.fullPath);
    const buffer = await bunFile.arrayBuffer();
    return new File([buffer], this.name, {
      type: bunFile.type,
      lastModified: fs.statSync(this.fullPath).mtimeMs,
    });
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    const fullPath = this.fullPath;
    let buffer = Buffer.alloc(0);
    const writeChunk = async (data: FileSystemWriteChunkType): Promise<void> => {
      if (data instanceof Blob) {
        buffer = Buffer.concat([buffer, Buffer.from(await data.arrayBuffer())]);
        return;
      }
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        buffer = Buffer.concat([buffer, Buffer.from(data as ArrayBuffer)]);
        return;
      }
      if (typeof data === "string") {
        buffer = Buffer.concat([buffer, Buffer.from(data)]);
        return;
      }
      if (typeof data === "object" && data !== null && "type" in data) {
        const writeParams = data as { type: string; data?: unknown; size?: number };
        if (writeParams.type === "write" && writeParams.data !== undefined) {
          await writeChunk(writeParams.data as FileSystemWriteChunkType);
        } else if (writeParams.type === "truncate" && typeof writeParams.size === "number") {
          buffer = buffer.subarray(0, writeParams.size);
        }
      }
    };

    return {
      async write(data: FileSystemWriteChunkType) {
        await writeChunk(data);
      },
      async close() {
        await Bun.write(fullPath, buffer);
      },
      async abort() {
        buffer = Buffer.alloc(0);
      },
      async seek(_position: number) {},
      async truncate(size: number) {
        buffer = buffer.subarray(0, size);
      },
      locked: false,
    } as unknown as FileSystemWritableFileStream;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof LocalFileHandle && other.fullPath === this.fullPath;
  }
}

class LocalDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  readonly fullPath: string;

  constructor(fullPath: string) {
    this.fullPath = fullPath;
    this.name = path.basename(fullPath) || "/";
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    const filePath = resolveSecurePath(this.fullPath, name);
    if (!fs.existsSync(filePath)) {
      if (options?.create) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "");
      } else {
        throw new DOMException(`File not found: ${name}`, "NotFoundError");
      }
    }

    if (fs.statSync(filePath).isDirectory()) {
      throw new DOMException(`${name} is a directory`, "TypeMismatchError");
    }
    return new LocalFileHandle(filePath);
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    const dirPath = resolveSecurePath(this.fullPath, name);
    if (!fs.existsSync(dirPath)) {
      if (options?.create) {
        fs.mkdirSync(dirPath, { recursive: true });
      } else {
        throw new DOMException(`Directory not found: ${name}`, "NotFoundError");
      }
    }

    if (!fs.statSync(dirPath).isDirectory()) {
      throw new DOMException(`${name} is not a directory`, "TypeMismatchError");
    }
    return new LocalDirectoryHandle(dirPath) as unknown as FileSystemDirectoryHandle;
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const entryPath = resolveSecurePath(this.fullPath, name);
    if (!fs.existsSync(entryPath)) {
      throw new DOMException(`Entry not found: ${name}`, "NotFoundError");
    }

    if (fs.statSync(entryPath).isDirectory()) {
      if (options?.recursive) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else {
        fs.rmdirSync(entryPath);
      }
    } else {
      fs.unlinkSync(entryPath);
    }
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    if (!(possibleDescendant instanceof LocalFileHandle) && !(possibleDescendant instanceof LocalDirectoryHandle)) {
      return null;
    }
    const relativePath = path.relative(this.fullPath, possibleDescendant.fullPath);
    return relativePath ? relativePath.split(path.sep) : [];
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof LocalDirectoryHandle && other.fullPath === this.fullPath;
  }

  async *entries() {
    const entries = fs.readdirSync(this.fullPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(this.fullPath, entry.name);
      yield [entry.name, entry.isDirectory() ? new LocalDirectoryHandle(entryPath) : new LocalFileHandle(entryPath)];
    }
  }

  async *keys() {
    for (const entry of fs.readdirSync(this.fullPath)) {
      yield entry;
    }
  }

  async *values() {
    const entries = fs.readdirSync(this.fullPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(this.fullPath, entry.name);
      yield entry.isDirectory() ? new LocalDirectoryHandle(entryPath) : new LocalFileHandle(entryPath);
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

function setupRouteWatcher(projectRoot: string, onRegenerated: () => void): void {
  const routesDir = path.join(projectRoot, "frontend", "routes");
  if (!fs.existsSync(routesDir)) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const regenerate = async () => {
    try {
      await generateRoutes(projectRoot);
      onRegenerated();
      console.log("[serve] Regenerated route tree");
    } catch (error) {
      console.error("[serve] Failed to regenerate route tree:", error);
    }
  };

  fs.watch(routesDir, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void regenerate();
    }, 150);
  });
}

async function main() {
  const options = parseServeOptions();
  dotenv.config({ path: path.join(options.projectRoot, ".env"), quiet: true });

  const mode = options.production || process.env.NODE_ENV?.trim().toLowerCase() === "production" ? "production" : "development";
  const isProduction = mode === "production";
  process.env.NODE_ENV = mode;

  const resolvedBaseUrl = resolveServeBaseUrl(options);
  const baseUrl = resolvedBaseUrl.toString().replace(/\/$/, "");
  const baseHref = baseHrefFromUrl(resolvedBaseUrl);
  process.env.BASE_URL = baseUrl;
  process.env.BUN_PUBLIC_BASE_URL = baseUrl;

  if (!isProduction) {
    await generateRoutes(options.projectRoot);
  }
  let manifest = readSpaRoutesManifest(options.projectRoot);
  if (!isProduction) {
    setupRouteWatcher(options.projectRoot, () => {
      manifest = readSpaRoutesManifest(options.projectRoot);
    });
  }

  const frontendDir = path.join(options.projectRoot, "frontend");
  const publicDir = path.join(frontendDir, "public");
  const htmlBundle = await import(path.join(frontendDir, "index.html"));

  const redirectToIndexHtml = async (request: Request, richieRouterHead = ""): Promise<Response> => {
    const url = new URL(request.url);
    url.pathname = "/index.html";
    const response = await fetch(
      new Request(url.toString(), {
        headers: request.headers,
        method: request.method,
        body: request.body,
      }),
    );
    if (!response.headers.get("Content-Type")?.includes("text/html")) {
      return response;
    }

    const rewrittenBody = injectExportedHtmlHead(await response.text(), baseHref, richieRouterHead);
    return new Response(rewrittenBody, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      },
    });
  };

  const serveStaticAsset = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const relativePath = url.pathname.replace(/^\/public\//, "");
    const filePath = path.join(publicDir, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(Bun.file(filePath));
  };

  const serveWrapper = ((optionsFromUser: Parameters<typeof Bun.serve>[0]) => {
    return Bun.serve({
      ...optionsFromUser,
      routes: {
        "/index.html": htmlBundle.default,
        "/public/*": serveStaticAsset,
      },
      async fetch(request: Request, server: unknown) {
        const url = new URL(request.url);
        if (url.pathname === "/favicon.ico") {
          return new Response("Not found", { status: 404 });
        }
        if (
          url.pathname === "/" ||
          (manifest &&
            !matchesPassthroughPath(url.pathname, { spaRoutesManifest: manifest }) &&
            matchesSpaPath(url.pathname, { spaRoutesManifest: manifest }))
        ) {
          const richieHead = await resolveExportedRichieRouterHead({
            request,
            server,
            fetch: optionsFromUser.fetch as UserServeFetch | undefined,
            thisArg: this,
            baseHref,
            manifest,
          });
          if ("response" in richieHead) {
            return richieHead.response;
          }
          return redirectToIndexHtml(request, richieHead.richieRouterHead);
        }
        if (optionsFromUser.fetch) {
          return await optionsFromUser.fetch.call(this, request, server as never);
        }
        return new Response("Not found", { status: 404 });
      },
      port: options.port,
      hostname: options.host,
      development: isProduction
        ? false
        : {
            hmr: true,
            console: true,
          },
    });
  }) as typeof Bun.serve;

  globalThis.serve = serveWrapper;
  const { startMonthlyCreditResetScheduler } = await import("../backend/monthly-credit-reset-scheduler");
  const monthlyCreditResetScheduler = startMonthlyCreditResetScheduler();
  const shutdown = () => { monthlyCreditResetScheduler.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await import(path.join(options.projectRoot, "backend", "server.ts"));
  console.log(`[serve] Server running at ${baseUrl} (${mode}); route manifest: ${path.join(getGeneratedDir(options.projectRoot), GENERATED_SPA_ROUTES_FILE)}`);
}

await main();
