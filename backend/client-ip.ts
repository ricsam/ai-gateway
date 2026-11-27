import { isIP } from "node:net";

/**
 * Where Better Auth reads a request's client IP from, for its rate limits and session records:
 * its `advanced.ipAddress` options. Better Auth's defaults apply to whatever is left out: the
 * `X-Forwarded-For` header, trusted only when it holds a single address.
 */
export type ClientIpOptions = { ipAddressHeaders?: string[]; trustedProxies?: string[] };

// An HTTP header name is an RFC 9110 token.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

function entries(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** CLIENT_IP_HEADERS: request headers that hold the client's address, read in order. */
export function parseClientIpHeaders(name: string, value: string | undefined): string[] {
  const headers = entries(value).map((header) => header.toLowerCase());
  const invalid = headers.filter((header) => !HEADER_NAME.test(header));
  if (invalid.length) throw new Error(`${name} must list HTTP header names separated by commas; not a header name: ${invalid.join(", ")}`);
  return [...new Set(headers)];
}

// Better Auth reads an IPv4-mapped IPv6 address (::ffff:192.0.2.1) as the IPv4 address, so its
// prefix counts IPv4 bits. The URL parser writes every IPv6 address in its canonical form.
function addressBits(address: string): number | null {
  const family = isIP(address);
  if (family === 4) return 32;
  if (family !== 6 || address.includes("%")) return null;
  let canonical: string;
  try { canonical = new URL(`http://[${address}]`).hostname; } catch { return null; }
  return /^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(canonical) ? 32 : 128;
}

/** Whether `value` is an IPv4 or IPv6 address, optionally followed by a /prefix of its family. */
export function isIpAddressOrCidr(value: string): boolean {
  const slash = value.lastIndexOf("/");
  const bits = addressBits(slash === -1 ? value : value.slice(0, slash));
  if (bits === null) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  return /^\d+$/.test(prefix) && Number(prefix) <= bits;
}

/** TRUSTED_PROXIES: addresses or CIDR ranges of the proxies that append to forwarded-address headers. */
export function parseTrustedProxies(name: string, value: string | undefined): string[] {
  const proxies = entries(value);
  const invalid = proxies.filter((proxy) => !isIpAddressOrCidr(proxy));
  if (invalid.length) throw new Error(`${name} must list IP addresses or CIDR ranges separated by commas; not an IP address or CIDR range: ${invalid.join(", ")}`);
  return [...new Set(proxies)];
}

/** Better Auth's `advanced.ipAddress` options for the configured headers and proxies. */
export function clientIpOptions(headers: string[], trustedProxies: string[]): ClientIpOptions | undefined {
  if (!headers.length && !trustedProxies.length) return undefined;
  return {
    ...(headers.length ? { ipAddressHeaders: headers } : {}),
    ...(trustedProxies.length ? { trustedProxies } : {}),
  };
}
