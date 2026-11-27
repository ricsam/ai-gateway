import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpaRoutesManifest } from "@richie-router/server";
import { createIndexHtmlLoader, createServeWrapper, IndexHtmlUnavailableError, injectExportedHtmlHead, ownListenerUrl } from "./serve-wrapper";

const RICHIE_ROUTER_HEAD = '<title data-richie-router-head="true">AI Gateway</title>';
const BUNDLED_SCRIPT = /<script type="module" crossorigin src="\/[^"]+\.js"/;
const manifest: SpaRoutesManifest = {
  spaRoutes: ["/", "/admin", "/profile"],
  hostedRouting: { headBasePath: "/head-api", passthrough: ["/head-api", "/api/$"] },
};

let fixtureDir: string;
let htmlBundle: Bun.HTMLBundle;
let brokenHtmlBundle: Bun.HTMLBundle;
const servers: Bun.Server<unknown>[] = [];

function writeFrontend(dir: string, script: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <!--richie-router-head-->\n    <script type="module" src="./index.ts"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n',
  );
  fs.writeFileSync(path.join(dir, "index.ts"), script);
}

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-serve-wrapper-"));
  writeFrontend(path.join(fixtureDir, "frontend"), 'console.log("spa");\n');
  writeFrontend(path.join(fixtureDir, "broken"), 'console.log("spa";\n');
  htmlBundle = (await import(path.join(fixtureDir, "frontend", "index.html"))).default;
  brokenHtmlBundle = (await import(path.join(fixtureDir, "broken", "index.html"))).default;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

interface ReceivedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

// Recorded while the handler runs: Bun doesn't keep a server request's headers after its response.
function receive(request: Request): ReceivedRequest {
  return { method: request.method, url: new URL(request.url), headers: Object.fromEntries(request.headers) };
}

/** The gateway's server, with a backend that answers the Richie Router head API. */
function startGateway(options: { production: boolean; hostname?: string; htmlBundle?: Bun.HTMLBundle }) {
  const headRequests: ReceivedRequest[] = [];
  const backendRequests: ReceivedRequest[] = [];
  const serve = createServeWrapper({
    htmlBundle: options.htmlBundle ?? htmlBundle,
    publicDir: path.join(fixtureDir, "frontend", "public"),
    baseHref: "/",
    getManifest: () => manifest,
    hostname: options.hostname ?? "127.0.0.1",
    port: 0,
    production: options.production,
  });
  const server = serve({
    fetch(request) {
      if (new URL(request.url).pathname === "/head-api") {
        headRequests.push(receive(request));
        return Response.json({ richieRouterHead: RICHIE_ROUTER_HEAD }, { headers: { "x-richie-router-head": "document" } });
      }
      backendRequests.push(receive(request));
      return Response.json({ error: "Not Found" }, { status: 404 });
    },
  });
  servers.push(server);
  return { server, headRequests, backendRequests };
}

/** A server that records the requests it receives, such as the host a forged Host header names. */
function startRecorder() {
  const received: ReceivedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      received.push(receive(request));
      return new Response("<!doctype html><html><head></head><body>recorder</body></html>", { headers: { "Content-Type": "text/html" } });
    },
  });
  servers.push(server);
  return { server, received };
}

/** A local port that nothing listens on, like the client's port of a `kubectl port-forward` seen from the pod. */
async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  return port;
}

/** A request to `server`'s own listener, connected directly also while a test sets HTTP_PROXY. */
function request(server: Bun.Server<unknown>, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(ownListenerUrl(server, pathname), { ...init, proxy: false } as unknown as RequestInit);
}

for (const production of [true, false]) {
  describe(production ? "production" : "development", () => {
    test("serves SPA documents whatever port the Host header names, as behind kubectl port-forward", async () => {
      const { server, headRequests } = startGateway({ production });
      const port = await closedPort();

      for (const pathname of ["/", "/admin", "/profile"]) {
        const response = await request(server, pathname, { headers: { Host: `localhost:${port}` } });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/html;charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        const html = await response.text();
        expect(html).toContain(`<head>\n  <base href="/">`);
        expect(html).toContain(RICHIE_ROUTER_HEAD);
        expect(html).not.toContain("<!--richie-router-head-->");
        expect(html).toMatch(BUNDLED_SCRIPT);
      }
      expect(headRequests.map((headRequest) => headRequest.url.searchParams.get("href"))).toEqual(["/", "/admin", "/profile"]);
    });

    test("sends no request, and none of the client's headers, to the host the Host header names", async () => {
      const recorder = startRecorder();
      const { server } = startGateway({ production });

      for (const pathname of ["/", "/admin", "/profile"]) {
        const response = await request(server, pathname, {
          headers: { Host: `127.0.0.1:${recorder.server.port}`, Cookie: "better-auth.session_token=secret", Authorization: "Bearer aig_secret" },
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(RICHIE_ROUTER_HEAD);
        expect(html).not.toContain("recorder");
      }
      expect(recorder.received).toHaveLength(0);
    });

    test("answers HEAD like GET, without a body", async () => {
      const { server } = startGateway({ production });
      const response = await request(server, "/admin", { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html;charset=utf-8");
      expect(await response.text()).toBe("");
    });
  });
}

test("serves SPA documents when bound to the wildcard address, as in the container image", async () => {
  const { server } = startGateway({ production: true, hostname: "0.0.0.0" });
  const response = await request(server, "/admin", { headers: { Host: `localhost:${await closedPort()}` } });
  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(BUNDLED_SCRIPT);
});

test("reads the HTML bundle directly even when HTTP_PROXY and ALL_PROXY name a proxy", async () => {
  const proxy = startRecorder();
  const proxyUrl = `http://127.0.0.1:${proxy.server.port}`;
  const names = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.HTTP_PROXY = process.env.http_proxy = process.env.ALL_PROXY = process.env.all_proxy = proxyUrl;
    const { server } = startGateway({ production: true });

    const response = await request(server, "/admin");
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(BUNDLED_SCRIPT);
    expect(proxy.received).toHaveLength(0);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("answers other methods on SPA routes with 405, without resolving the head", async () => {
  const { server, headRequests, backendRequests } = startGateway({ production: true });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await request(server, "/admin", { method, body: method === "OPTIONS" ? undefined : "name=value" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  }
  expect(headRequests).toHaveLength(0);
  expect(backendRequests).toHaveLength(0);
});

test("passes other requests to the backend", async () => {
  const { server, backendRequests } = startGateway({ production: true });
  const response = await request(server, "/api/config", { headers: { Cookie: "a=b" } });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not Found" });
  expect(backendRequests.map((backendRequest) => backendRequest.url.pathname)).toEqual(["/api/config"]);
  expect(backendRequests[0]!.headers.cookie).toBe("a=b");
});

describe("a frontend that doesn't build", () => {
  test("development shows Bun's Build Failed page", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { server } = startGateway({ production: false, htmlBundle: brokenHtmlBundle });
      const response = await request(server, "/admin");
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Build Failed");
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("production answers 500", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { server } = startGateway({ production: true, htmlBundle: brokenHtmlBundle });
      const response = await request(server, "/admin");
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("ownListenerUrl", () => {
  test.each([
    ["http://0.0.0.0:3000/", "http://127.0.0.1:3000/index.html"],
    ["http://[::]:3000/", "http://[::1]:3000/index.html"],
    ["http://localhost:3000/", "http://localhost:3000/index.html"],
    ["http://127.0.0.1:18431/", "http://127.0.0.1:18431/index.html"],
    ["http://10.42.0.7:3000/", "http://10.42.0.7:3000/index.html"],
    ["http://[::1]:3000/", "http://[::1]:3000/index.html"],
  ])("%s", (serverUrl, expected) => {
    expect(ownListenerUrl({ url: new URL(serverUrl) }, "/index.html").href).toBe(expected);
  });
});

describe("createIndexHtmlLoader", () => {
  const server = { url: new URL("http://0.0.0.0:3000/") };
  const html = "<!doctype html><html><head><!--richie-router-head--></head><body></body></html>";
  const htmlResponse = () => new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });

  function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected fetch");
      return await next();
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  test("reads /index.html from the server's own listener with a bare GET that bypasses proxies", async () => {
    const { fetchFn, calls } = fakeFetch([htmlResponse]);
    const load = createIndexHtmlLoader({ cache: false, fetch: fetchFn });
    expect(await load(server)).toBe(html);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:3000/index.html", init: { headers: { Accept: "text/html" }, redirect: "manual", proxy: false } },
    ]);
  });

  test("without cache, reads the bundle for every document", async () => {
    const { fetchFn, calls } = fakeFetch([htmlResponse, htmlResponse]);
    const load = createIndexHtmlLoader({ cache: false, fetch: fetchFn });
    await load(server);
    await load(server);
    expect(calls).toHaveLength(2);
  });

  test("with cache, reads the bundle once, also for concurrent documents", async () => {
    const { fetchFn, calls } = fakeFetch([htmlResponse]);
    const load = createIndexHtmlLoader({ cache: true, fetch: fetchFn });
    expect(await Promise.all([load(server), load(server), load(server)])).toEqual([html, html, html]);
    expect(await load(server)).toBe(html);
    expect(calls).toHaveLength(1);
  });

  test("with cache, reads again after a failed read", async () => {
    const { fetchFn, calls } = fakeFetch([
      () => Promise.reject(new TypeError("ECONNREFUSED")),
      () => new Response(null, { status: 500 }),
      htmlResponse,
    ]);
    const load = createIndexHtmlLoader({ cache: true, fetch: fetchFn });
    await expect(load(server)).rejects.toThrow("ECONNREFUSED");
    await expect(load(server)).rejects.toBeInstanceOf(IndexHtmlUnavailableError);
    expect(await load(server)).toBe(html);
    expect(await load(server)).toBe(html);
    expect(calls).toHaveLength(3);
  });

  test("rejects anything but a 200 HTML document", async () => {
    const { fetchFn } = fakeFetch([
      () => new Response("Build failed", { status: 500, headers: { "Content-Type": "text/html;charset=utf-8" } }),
      () => new Response(null, { status: 302, headers: { Location: "http://example.com/" } }),
      () => Response.json({ html }),
    ]);
    const load = createIndexHtmlLoader({ cache: false, fetch: fetchFn });

    const buildFailed = await load(server).catch((error: unknown) => error);
    expect(buildFailed).toBeInstanceOf(IndexHtmlUnavailableError);
    expect(buildFailed).toMatchObject({ status: 500, contentType: "text/html;charset=utf-8", body: "Build failed" });
    expect((buildFailed as Error).message).toBe("GET http://127.0.0.1:3000/index.html answered 500 (text/html;charset=utf-8)");
    await expect(load(server)).rejects.toMatchObject({ status: 302 });
    await expect(load(server)).rejects.toMatchObject({ status: 200, contentType: "application/json;charset=utf-8" });
  });
});

describe("injectExportedHtmlHead", () => {
  test("adds the base element and replaces the head placeholder", () => {
    expect(injectExportedHtmlHead("<html><head><!--richie-router-head--></head></html>", "/gateway/", "<title>$& $1</title>")).toBe(
      '<html><head>\n  <base href="/gateway/"><title>$& $1</title></head></html>',
    );
  });

  test("replaces an existing base element", () => {
    expect(injectExportedHtmlHead('<html><head lang="en"><base href="./"></head></html>', "/", "")).toBe(
      '<html><head lang="en"><base href="/"></head></html>',
    );
  });
});
