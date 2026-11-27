/**
 * Upstream failures that are not answers from the model provider: the gateway
 * could not reach it, or the connection broke before the response was complete.
 *
 * Their messages name the upstream's address (`connect ECONNREFUSED
 * 10.0.0.1:8080`), so clients get a neutral message and the details stay in the
 * gateway log, keyed by the request ID.
 */

/** Shown to clients when the upstream cannot be reached. Names no address. */
export const UPSTREAM_UNAVAILABLE_MESSAGE = "The upstream model provider is unavailable; try again shortly";

/** Socket, DNS and HTTP/2 error codes of a connection that could not be opened or broke. */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTCONN",
  "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN", "ENETRESET",
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL",
  // The Bedrock client sends every request over HTTP/2.
  "ERR_HTTP2_STREAM_CANCEL", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION", "ERR_HTTP2_INVALID_SESSION", "ERR_HTTP2_ERROR",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CONNECTION_TIMEOUT", "ERR_SOCKET_CLOSED",
]);

/**
 * Messages of connection failures that carry no code: the AWS SDK's HTTP/2
 * handler and event stream decoder raise plain errors, and runtimes differ in
 * which codes they set.
 */
const CONNECTION_ERROR_MESSAGES = [
  /^The pending stream has been canceled\b/,
  /^HTTP\/2 stream is abnormally aborted\b/,
  /^Unexpected error: http2 request did not get a response\b/,
  /^Frame type id \d+ in stream id \d+ has failed\b/,
  /^Truncated event message received\b/,
  /^socket hang up\b/,
  /^Client network socket disconnected\b/,
];

type ErrorFields = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; $fault?: unknown; $metadata?: { httpStatusCode?: unknown; attempts?: unknown } };

/** The hint the AWS SDK appends to the message of an error it raised while reading a response. */
const SDK_DESERIALIZATION_HINT = /\n\s*Deserialization error: to see the raw response[\s\S]*$/;

function fields(value: unknown): ErrorFields | undefined {
  return value !== null && typeof value === "object" ? value as ErrorFields : undefined;
}

function json(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 500);
  } catch {
    return "[unserializable]";
  }
}

/** Whether the upstream answered with an error response of its own (an AWS service exception). */
export function isServiceException(error: unknown): boolean {
  return fields(error)?.$fault !== undefined;
}

/**
 * Whether an error came from the upstream's answer: an AWS service exception,
 * or an error the SDK raised from a response it received, such as an
 * exception event that opened a stream. The SDK records the response's HTTP
 * status on both.
 */
export function isUpstreamAnswer(error: unknown): boolean {
  const value = fields(error);
  return value?.$fault !== undefined || typeof value?.$metadata?.httpStatusCode === "number";
}

/** An upstream error's message without the hint the SDK appends; undefined when it has none. */
export function upstreamMessage(error: unknown): string | undefined {
  const message = fields(error)?.message;
  return typeof message === "string" ? message.replace(SDK_DESERIALIZATION_HINT, "").trim() || undefined : undefined;
}

/**
 * Whether an error means the upstream could not be reached or the connection
 * to it broke: refused, reset or timed-out connections, DNS failures, failed
 * HTTP/2 sessions and streams, and an event stream cut off inside a message.
 * Follows `cause`, so the SDK's "pending stream has been canceled (caused by
 * …)" wrapper counts. An error response from the upstream never does.
 */
export function isUpstreamConnectionError(error: unknown): boolean {
  let current = fields(error);
  for (let depth = 0; current && depth < 6; depth++, current = fields(current.cause)) {
    if (current.$fault !== undefined) return false;
    if (typeof current.code === "string" && CONNECTION_ERROR_CODES.has(current.code)) return true;
    // The SDK's connection, socket and stream timeouts.
    if (current.name === "TimeoutError") return true;
    const message = current.message;
    if (typeof message === "string" && CONNECTION_ERROR_MESSAGES.some((pattern) => pattern.test(message))) return true;
  }
  return false;
}

/**
 * Whether the upstream, or a proxy in front of it, answered 502, 503 or 504
 * without an error the SDK recognizes: the provider is temporarily unavailable.
 */
export function isUpstreamGatewayStatus(error: unknown): boolean {
  const status = fields(error)?.$metadata?.httpStatusCode;
  return isServiceException(error) && (status === 502 || status === 503 || status === 504);
}

/**
 * Whether the SDK could not parse a response the upstream had begun to send.
 * When the connection drops mid-body, the HTTP/2 stream can end without an
 * error, and the cut-off JSON is what fails.
 */
export function isUnreadableUpstreamResponse(error: unknown): boolean {
  const value = fields(error);
  return value?.name === "SyntaxError" && value.$fault === undefined && typeof value.$metadata?.httpStatusCode === "number";
}

/**
 * One line describing an error and its causes for the gateway log, such as
 * `Error(ERR_HTTP2_STREAM_CANCEL): The pending stream has been canceled (caused by:
 * connect ECONNREFUSED 10.0.0.1:8080) <- Error(ECONNREFUSED): connect ECONNREFUSED
 * 10.0.0.1:8080 attempts=3`. For operators only: it keeps upstream addresses.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
    const value = fields(current);
    if (!value) {
      parts.push(String(current));
      break;
    }
    const name = typeof value.name === "string" && value.name ? value.name : value instanceof Error ? "Error" : "Object";
    const code = typeof value.code === "string" || typeof value.code === "number" ? `(${value.code})` : "";
    const status = typeof value.$metadata?.httpStatusCode === "number" ? ` status=${value.$metadata.httpStatusCode}` : "";
    const message = typeof value.message === "string" ? value.message.replace(SDK_DESERIALIZATION_HINT, "") : value instanceof Error ? "" : json(value);
    parts.push(`${name}${code}${status}: ${message}`);
    current = value.cause;
  }
  const attempts = fields(error)?.$metadata?.attempts;
  return parts.join(" <- ") + (typeof attempts === "number" ? ` attempts=${attempts}` : "");
}
