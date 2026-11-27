import fs from "node:fs";
import path from "node:path";
import { matchesPassthroughPath, matchesSpaPath, type SpaRoutesManifest } from "@richie-router/server";

const RICHIE_ROUTER_HEAD_PLACEHOLDER = "<!--richie-router-head-->";
const RICHIE_ROUTER_HEAD_RESPONSE_HEADER = "x-richie-router-head";
/** Where Bun serves the HTML bundle, which SPA documents are made from. */
const INDEX_HTML_PATH = "/index.html";

type UserServeFetch = (this: unknown, request: Request, server: unknown) => Response | Promise<Response>;
type ListeningServer = Pick<Bun.Server<unknown>, "url">;

export interface ServeWrapperOptions {
  /** The frontend's HTML bundle: the default export of `frontend/index.html`. */
  htmlBundle: Bun.HTMLBundle;
  /** Served at /public/*. */
  publicDir: string;
  /** The `<base href>` of SPA documents. */
  baseHref: string;
  /** The current SPA routes manifest. Development regenerates it while the server runs. */
  getManifest: () => SpaRoutesManifest | null;
  hostname: string;
  port: number;
  production: boolean;
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

export function injectExportedHtmlHead(html: string, baseHref: string, richieRouterHead: string): string {
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

/**
 * The URL of `pathname` on the server's own listener, from the address the server is bound to.
 * Never use `request.url` for this: Bun builds it from the client's Host header, which names the
 * client's local port behind `kubectl port-forward`, and can name any host at all.
 */
export function ownListenerUrl(server: ListeningServer, pathname: string): URL {
  const url = new URL(pathname, server.url);
  // A wildcard bind address, such as the image's 0.0.0.0, is reached through loopback.
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  else if (url.hostname === "[::]") url.hostname = "[::1]";
  return url;
}

/** The server's own listener did not answer /index.html with an HTML document. */
export class IndexHtmlUnavailableError extends Error {
  constructor(
    url: URL,
    readonly status: number,
    readonly contentType: string,
    readonly body: string,
  ) {
    super(`GET ${url.href} answered ${status}${contentType ? ` (${contentType})` : ""}`);
    this.name = "IndexHtmlUnavailableError";
  }
}

/**
 * Loads the HTML bundle for SPA documents. Bun serves the bundle only through `routes` (its
 * `server.fetch()` reaches the fetch handler alone), so it is read from the server's own listener:
 * a GET without the client's headers or body, connected directly. With `cache`, the first document
 * read is kept, since Bun's production bundle doesn't change while the server runs; a failed read is
 * tried again by the next request.
 */
export function createIndexHtmlLoader(options: { cache: boolean; fetch?: typeof fetch }): (server: ListeningServer) => Promise<string> {
  const fetchFromServer = options.fetch ?? fetch;
  let cached: Promise<string> | undefined;

  const load = async (server: ListeningServer): Promise<string> => {
    const url = ownListenerUrl(server, INDEX_HTML_PATH);
    // `proxy: false` (a Bun extension that @types/bun 1.3 doesn't declare yet) connects directly:
    // Bun would otherwise send even this loopback request through HTTP_PROXY or ALL_PROXY.
    const init = { headers: { Accept: "text/html" }, redirect: "manual", proxy: false };
    const response = await fetchFromServer(url, init as unknown as RequestInit);
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status !== 200 || !contentType.includes("text/html")) {
      throw new IndexHtmlUnavailableError(url, response.status, contentType, await response.text());
    }
    return await response.text();
  };

  return (server) => {
    if (!options.cache) return load(server);
    if (!cached) {
      const loading = load(server);
      cached = loading;
      loading.catch(() => {
        if (cached === loading) cached = undefined;
      });
    }
    return cached;
  };
}

/**
 * Wraps `Bun.serve` for the backend: SPA routes get the HTML bundle with the route's Richie Router
 * head, /index.html and /public/* serve the frontend's files, and other requests reach the backend's
 * fetch handler.
 */
export function createServeWrapper(options: ServeWrapperOptions): typeof Bun.serve {
  const loadIndexHtml = createIndexHtmlLoader({ cache: options.production });

  const serveSpaDocument = async (server: ListeningServer, richieRouterHead: string): Promise<Response> => {
    let html: string;
    try {
      html = await loadIndexHtml(server);
    } catch (error) {
      console.error("[serve] Could not load the HTML bundle:", error);
      if (!options.production && error instanceof IndexHtmlUnavailableError && error.contentType.includes("text/html")) {
        // Bun's "Build Failed" page, which reloads itself once the frontend builds again.
        return new Response(error.body, {
          status: error.status,
          headers: { "Content-Type": error.contentType, "Cache-Control": "no-cache" },
        });
      }
      return new Response("Internal Server Error", { status: 500 });
    }

    return new Response(injectExportedHtmlHead(html, options.baseHref, richieRouterHead), {
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  };

  const serveStaticAsset = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const relativePath = url.pathname.replace(/^\/public\//, "");
    const filePath = path.join(options.publicDir, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(Bun.file(filePath));
  };

  return ((optionsFromUser: Parameters<typeof Bun.serve>[0]) => {
    return Bun.serve({
      ...optionsFromUser,
      // The server listens on `options.hostname` and `options.port` (set below), never on a Unix socket.
      unix: undefined,
      routes: {
        [INDEX_HTML_PATH]: options.htmlBundle,
        "/public/*": serveStaticAsset,
      },
      async fetch(request: Request, server: Bun.Server<unknown>) {
        const url = new URL(request.url);
        if (url.pathname === "/favicon.ico") {
          return new Response("Not found", { status: 404 });
        }
        const manifest = options.getManifest();
        if (
          url.pathname === "/" ||
          (manifest &&
            !matchesPassthroughPath(url.pathname, { spaRoutesManifest: manifest }) &&
            matchesSpaPath(url.pathname, { spaRoutesManifest: manifest }))
        ) {
          if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
          }
          const richieHead = await resolveExportedRichieRouterHead({
            request,
            server,
            fetch: optionsFromUser.fetch as UserServeFetch | undefined,
            thisArg: this,
            baseHref: options.baseHref,
            manifest,
          });
          if ("response" in richieHead) {
            return richieHead.response;
          }
          return serveSpaDocument(server, richieHead.richieRouterHead);
        }
        if (optionsFromUser.fetch) {
          // After a WebSocket upgrade the backend answers undefined, which goes back to Bun as it is.
          return (await optionsFromUser.fetch.call(this, request, server as never)) as Response;
        }
        return new Response("Not found", { status: 404 });
      },
      port: options.port,
      hostname: options.hostname,
      development: options.production
        ? false
        : {
            hmr: true,
            console: true,
          },
    });
  }) as typeof Bun.serve;
}
