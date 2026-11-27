import type { ManagementPrincipal } from "../management-auth";
import { apiErrorFromResponse, CliError, UsageError } from "./errors";
import type { Io } from "./io";

/** Query parameters; an array repeats its parameter once per value. */
export type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;

export interface RequestOptions {
  query?: Query;
  /** JSON request body. */
  json?: unknown;
  /** Raw request body, sent with contentType. */
  bytes?: Uint8Array;
  contentType?: string;
}

/**
 * Sends management API requests (paths relative to /management/v1), either
 * in-process against the gateway's database or over HTTP(S) to a gateway.
 */
export interface ManagementClient {
  readonly mode: "local" | "remote";
  /** Where requests go, for messages. */
  readonly target: string;
  send(method: string, path: string, options?: RequestOptions): Promise<Response>;
  close(): Promise<void>;
}

/** Variables the gateway container has and aigctl needs to work on its database directly. */
export const LOCAL_ENVIRONMENT = ["DATABASE_URL", "BASE_URL", "BETTER_AUTH_SECRET", "SETTINGS_ENCRYPTION_KEY"] as const;

export function managementRequest(baseUrl: string, method: string, path: string, options: RequestOptions = {}, headers: Record<string, string> = {}): Request {
  const relative = path.replace(/^\/?(management\/v1)?\/?/, "/");
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/management/v1${relative === "/" ? "" : relative}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, entry);
    else if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const requestHeaders: Record<string, string> = { "user-agent": "aigctl", accept: "application/json", ...headers };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    requestHeaders["content-type"] = "application/json";
  } else if (options.bytes) {
    body = new Uint8Array(options.bytes);
    requestHeaders["content-type"] = options.contentType ?? "application/octet-stream";
  }
  return new Request(url, { method, headers: requestHeaders, body });
}

/** Sends a request and returns its JSON body, or throws the API's error. */
export async function call<T = unknown>(client: ManagementClient, method: string, path: string, options?: RequestOptions): Promise<T> {
  const response = await client.send(method, path, options);
  const payload = await readPayload(response);
  if (!response.ok) throw apiErrorFromResponse(response.status, payload);
  if (payload === null || typeof payload !== "object") {
    // Such as a sign-in page of a proxy in front of the gateway, or a wrong --server path.
    throw new CliError(`Unexpected response from ${client.target} (HTTP ${response.status}, ${response.headers.get("content-type") || "no content type"}) instead of management API JSON; is --server the gateway's base URL?`);
  }
  return payload as T;
}

export async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

/** Who ran aigctl, as recorded in the audit log; the self-reported name comes from --actor or AIGCTL_ACTOR. */
export function localActorId(hostname: string, actor?: string): string {
  const host = `aigctl@${hostname || "localhost"}`;
  return actor ? `${actor} via ${host}` : host;
}

/** The principal of aigctl inside the gateway container: the pod's database access is its authority. */
export function localPrincipal(hostname: string, actor?: string): ManagementPrincipal {
  return { actorType: "cli", actorId: localActorId(hostname, actor), userId: null, scopes: new Set(["*"]) };
}

/** A name for the audit log: 1-64 characters without control characters. */
export function parseActor(value: string | undefined): string | undefined {
  const actor = value?.trim();
  if (!actor) return undefined;
  if (actor.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(actor)) throw new UsageError("--actor must be 1-64 characters without control characters");
  return actor;
}

type ManagementHandler = (request: Request, options: { principal: ManagementPrincipal }) => Promise<Response>;

export class LocalClient implements ManagementClient {
  readonly mode = "local" as const;
  readonly target = "the gateway database";
  constructor(private readonly handle: ManagementHandler, readonly principal: ManagementPrincipal, private readonly end: () => Promise<void>) {}
  send(method: string, path: string, options?: RequestOptions): Promise<Response> {
    return this.handle(managementRequest("http://aigctl.local", method, path, options), { principal: this.principal });
  }
  close(): Promise<void> { return this.end(); }
}

export class RemoteClient implements ManagementClient {
  readonly mode = "remote" as const;
  constructor(readonly target: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  async send(method: string, path: string, options?: RequestOptions): Promise<Response> {
    const request = managementRequest(this.target, method, path, options, { authorization: `Bearer ${this.key}` });
    let response: Response;
    try {
      // Never follow a redirect with the management key.
      response = await this.fetcher(request, { redirect: "manual" });
    } catch (error) {
      throw new CliError(`Could not reach ${this.target}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CliError(`${this.target} redirected the request to ${response.headers.get("location") ?? "another location"}; pass the gateway's base URL with --server`);
    }
    return response;
  }
  async close(): Promise<void> {}
}

export function parseServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError(`--server must be an absolute http:// or https:// URL, such as https://gateway.example.com`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliError("--server must be an absolute http:// or https:// URL, such as https://gateway.example.com");
  if (url.username || url.password) throw new CliError("--server must not contain credentials; aigctl authenticates with AI_GATEWAY_MANAGEMENT_KEY");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export interface ClientOptions {
  /** --server, else AI_GATEWAY_URL: use that gateway's management API. */
  server?: string;
  /** --actor, else AIGCTL_ACTOR: the name recorded for local changes. */
  actor?: string;
}

export async function createClient(io: Io, options: ClientOptions = {}): Promise<ManagementClient> {
  const target = options.server?.trim() || io.env.AI_GATEWAY_URL?.trim();
  if (target) {
    const key = io.env.AI_GATEWAY_MANAGEMENT_KEY?.trim();
    if (!key) throw new CliError("Set AI_GATEWAY_MANAGEMENT_KEY to a management key (aigm_...) to use a gateway's management API; create one in Admin → Security or with 'aigctl management-keys create' inside the gateway container");
    if (!key.startsWith("aigm_")) throw new CliError("AI_GATEWAY_MANAGEMENT_KEY must be a management key (aigm_...); inference keys (aig_...) cannot use the management API");
    const server = new URL(parseServerUrl(target));
    if (server.protocol === "http:" && !isLoopback(server)) io.err(`aigctl: warning: ${server.origin} is plain HTTP, so the management key and any password are sent unencrypted\n`);
    if (options.actor) io.err("aigctl: warning: --actor only applies inside the gateway container; the management key is the audited actor\n");
    return new RemoteClient(parseServerUrl(target), key);
  }
  const actor = parseActor(options.actor ?? io.env.AIGCTL_ACTOR);
  const missing = LOCAL_ENVIRONMENT.filter((name) => !io.env[name]?.trim());
  if (missing.length) {
    throw new CliError(`Without --server, aigctl works directly on the gateway's database and needs the gateway's environment, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.
Run it in the gateway container, for example: kubectl exec -it deploy/<release>-ai-gateway -- aigctl ...
Or use a gateway's management API: AI_GATEWAY_MANAGEMENT_KEY=aigm_... aigctl --server https://gateway.example.com ...`);
  }
  let modules: [typeof import("../management-api"), typeof import("../db")];
  try {
    modules = await Promise.all([import("../management-api"), import("../db")]);
  } catch (error) {
    throw new CliError(`Could not load the gateway: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [{ handleManagementApi }, { pool }] = modules;
  let schema: string | null | undefined;
  try {
    schema = (await pool.query<{ installation: string | null }>("SELECT to_regclass('public.installation')::text AS installation")).rows[0]?.installation;
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new CliError(`Could not connect to the gateway database (DATABASE_URL): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!schema) {
    await pool.end().catch(() => undefined);
    throw new CliError("The gateway database has no tables yet: run the migrations first (bun run db:migrate; the Helm chart runs them in a pre-install and pre-upgrade Job)");
  }
  return new LocalClient(handleManagementApi, localPrincipal(io.hostname, actor), () => pool.end());
}
