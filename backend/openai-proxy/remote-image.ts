/**
 * SSRF-hardened download of `image_url` http(s) URLs.
 *
 * - Only http/https on the scheme's default port, without URL credentials.
 * - Every resolved address must be public unicast. The check runs inside the
 *   socket's DNS lookup, so the validated address is the one connected to
 *   (no DNS-rebinding window). IP-literal hosts are checked directly.
 * - Redirects are followed manually (bounded) and each hop is re-validated.
 * - Downloads are bounded by time and size, and the image format comes from
 *   the bytes, not the response Content-Type.
 * - Client-facing errors are deliberately coarse to avoid a network oracle.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ImageInputError, sniffImageFormat, SUPPORTED_IMAGE_FORMATS_TEXT, type ResolvedImage } from "./images";

export const REMOTE_IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024);
export const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
export const REMOTE_IMAGE_MAX_REDIRECTS = 3;
export const REMOTE_IMAGE_MAX_PER_REQUEST = 20;
const FETCH_CONCURRENCY = 4;
const USER_AGENT = "AI-Gateway-Image-Fetcher/1.0";

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
type LookupFunction = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;
type BaseLookup = (hostname: string, options: dns.LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

export interface RemoteImageFetchOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test seam: decide whether a resolved address may be contacted. Defaults to public unicast only. */
  isAllowedAddress?: (address: string) => boolean;
  /** Test seam: permit explicit non-default ports. */
  allowNonDefaultPorts?: boolean;
  /** Test seam: replace system DNS resolution. */
  resolve?: BaseLookup;
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(address: string): number[] | null {
  if (!net.isIPv4(address)) return null;
  return address.split(".").map(Number);
}

const BLOCKED_IPV4: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function inPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const index = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

function isPublicIPv4(bytes: number[]): boolean {
  return !BLOCKED_IPV4.some(([prefix, bits]) => inPrefix(bytes, prefix, bits));
}

function parseIPv6(address: string): number[] | null {
  let text = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!net.isIPv6(text)) return null;
  let embedded: number[] | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    embedded = parseIPv4(text.slice(lastColon + 1));
    if (!embedded) return null;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
  if (embedded) bytes.splice(12, 4, ...embedded);
  return bytes;
}

const BLOCKED_IPV6_GLOBAL: Array<[number[], number]> = [
  [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments, including Teredo
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x02], 16], // 6to4
  [[0x3f, 0xff], 20], // documentation
];

/** True only for globally routable unicast addresses. */
export function isPublicIpAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(address);
  if (!v6) return false;
  // IPv4-mapped (::ffff:0:0/96) and NAT64 well-known prefix (64:ff9b::/96) reach the embedded IPv4 address.
  if (inPrefix(v6, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96) || inPrefix(v6, [0, 0x64, 0xff, 0x9b], 96)) {
    return isPublicIPv4(v6.slice(12));
  }
  if (!inPrefix(v6, [0x20], 3)) return false; // outside global unicast 2000::/3
  return !BLOCKED_IPV6_GLOBAL.some(([prefix, bits]) => inPrefix(v6, prefix, bits));
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

class BlockedAddressError extends Error {
  code = "EBLOCKEDADDRESS";
}

const notAllowed = () => new ImageInputError("Image URL is not allowed. Only public http(s) URLs on default ports can be fetched", "invalid_image_url");
const unresolvable = () => new ImageInputError("Image URL host could not be resolved to a public address", "invalid_image_url");
const unreachable = (detail?: string) => new ImageInputError(`Image URL could not be fetched${detail ? ` (${detail})` : ""}`, "invalid_image_url");

function validatedUrl(raw: string, base: URL | undefined, options: RemoteImageFetchOptions): URL {
  let url: URL;
  try { url = base ? new URL(raw, base) : new URL(raw); } catch { throw new ImageInputError("Image URL is invalid", "invalid_image_url"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw notAllowed();
  if (url.username || url.password) throw notAllowed();
  if (url.port && !options.allowNonDefaultPorts) throw notAllowed();
  if (!url.hostname) throw notAllowed();
  return url;
}

function validatingLookup(isAllowed: (address: string) => boolean, resolve: BaseLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const family = typeof options?.family === "number" && options.family !== 0 ? options.family : undefined;
      const candidates = family ? addresses.filter((entry) => entry.family === family) : addresses;
      if (!candidates.length || addresses.some((entry) => !isAllowed(entry.address))) {
        return callback(new BlockedAddressError(`Blocked address for ${hostname}`), []);
      }
      if (options?.all) return callback(null, candidates);
      callback(null, candidates[0]!.address, candidates[0]!.family);
    });
  };
}

interface HopResult { redirect?: string; body?: Uint8Array }

function requestHop(url: URL, options: Required<Pick<RemoteImageFetchOptions, "maxBytes">> & { signal: AbortSignal; lookup: LookupFunction }): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      finish(new Error("Image download aborted"));
      request.destroy();
    };
    const finish = (error: Error | null, value?: HopResult) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      agent: false,
      lookup: options.lookup as unknown as net.LookupFunction,
      headers: {
        "user-agent": USER_AGENT,
        accept: "image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        finish(null, { redirect: response.headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(unreachable(`HTTP ${status}`));
        return;
      }
      const declared = Number(response.headers["content-length"]);
      const tooLarge = () => new ImageInputError(`Image at URL exceeds the ${(options.maxBytes / (1024 * 1024)).toFixed(2)} MB limit`, "invalid_image_url");
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.destroy();
        finish(tooLarge());
        return;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Uint8Array) => {
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          response.destroy();
          finish(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        finish(null, { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) });
      });
      response.on("error", (error) => finish(error));
      response.on("close", () => finish(new Error("Image download closed before completion")));
    });
    request.on("error", (error) => finish(error));
    if (options.signal.aborted) return onAbort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

function mapFetchError(error: unknown, signal: AbortSignal, parent?: AbortSignal): Error {
  if (error instanceof ImageInputError) return error;
  if (parent?.aborted) return parent.reason instanceof Error ? parent.reason : new Error("Request aborted");
  if (signal.aborted) return unreachable("timed out");
  if (error instanceof BlockedAddressError) return unresolvable();
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return unresolvable();
  return unreachable();
}

/** Download one image URL under the gateway's SSRF policy. */
export async function fetchRemoteImage(rawUrl: string, options: RemoteImageFetchOptions = {}): Promise<ResolvedImage> {
  const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? REMOTE_IMAGE_MAX_REDIRECTS;
  const isAllowed = options.isAllowedAddress ?? isPublicIpAddress;
  const lookup = validatingLookup(isAllowed, options.resolve ?? (dns.lookup as unknown as BaseLookup));
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let url = validatedUrl(rawUrl, undefined, options);
  for (let hop = 0; ; hop++) {
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal) && !isAllowed(literal)) throw notAllowed();
    let result: HopResult;
    try {
      result = await requestHop(url, { maxBytes, signal, lookup });
    } catch (error) {
      throw mapFetchError(error, signal, options.signal);
    }
    if (result.redirect !== undefined) {
      if (hop >= maxRedirects) throw unreachable("too many redirects");
      url = validatedUrl(result.redirect, url, options);
      continue;
    }
    const bytes = result.body ?? new Uint8Array();
    const format = sniffImageFormat(bytes);
    if (!format) throw new ImageInputError(`Image URL did not return a ${SUPPORTED_IMAGE_FORMATS_TEXT} image`, "invalid_image_url");
    return { format, bytes };
  }
}

/**
 * Download distinct image URLs with bounded concurrency. The first failure
 * aborts outstanding downloads and is rethrown with its request parameter path.
 */
export async function fetchRemoteImages(
  urls: ReadonlyMap<string, string>,
  options: RemoteImageFetchOptions & { fetchImage?: typeof fetchRemoteImage } = {},
): Promise<Map<string, ResolvedImage>> {
  if (urls.size > REMOTE_IMAGE_MAX_PER_REQUEST) {
    throw new ImageInputError(`A request can reference at most ${REMOTE_IMAGE_MAX_PER_REQUEST} image URLs; send additional images as base64 data URLs`, "invalid_image_url");
  }
  const fetchImage = options.fetchImage ?? fetchRemoteImage;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const entries = [...urls.entries()];
  const resolved = new Map<string, ResolvedImage>();
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [url, param] = entries[next++]!;
      try {
        resolved.set(url, await fetchImage(url, { ...options, signal }));
      } catch (error) {
        if (error instanceof ImageInputError) error.param ??= param;
        controller.abort(error);
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(FETCH_CONCURRENCY, entries.length) }, worker));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw controller.signal.reason instanceof Error ? controller.signal.reason : failure.reason;
  return resolved;
}
