#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { generateRoutes, getGeneratedDir, GENERATED_SPA_ROUTES_FILE, readSpaRoutesManifest } from "./route-generator";
import { createServeWrapper } from "./serve-wrapper";

interface ServeOptions {
  projectRoot: string;
  host: string;
  port: number;
  baseUrl?: string;
  production: boolean;
}

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
    throw new Error(`Invalid BASE_URL "${candidate}". Use a full URL like https://gateway.example.com.`);
  }
}

function baseHrefFromUrl(baseUrl: URL): string {
  const pathname = baseUrl.pathname || "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
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
  const htmlBundle = await import(path.join(frontendDir, "index.html"));

  globalThis.serve = createServeWrapper({
    htmlBundle: htmlBundle.default,
    publicDir: path.join(frontendDir, "public"),
    baseHref,
    getManifest: () => manifest,
    hostname: options.host,
    port: options.port,
    production: isProduction,
  });
  const { startMonthlyCreditResetScheduler } = await import("../backend/monthly-credit-reset-scheduler");
  const monthlyCreditResetScheduler = startMonthlyCreditResetScheduler();
  const { startReasoningReplayCleanup } = await import("../backend/reasoning-replay-store");
  const reasoningReplayCleanup = startReasoningReplayCleanup();
  const shutdown = () => { monthlyCreditResetScheduler.stop(); reasoningReplayCleanup.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await import(path.join(options.projectRoot, "backend", "server.ts"));
  console.log(`[serve] Server running at ${baseUrl} (${mode}); route manifest: ${path.join(getGeneratedDir(options.projectRoot), GENERATED_SPA_ROUTES_FILE)}`);
}

await main();
