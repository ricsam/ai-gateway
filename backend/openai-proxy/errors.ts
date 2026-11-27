/**
 * OpenAI-style error responses and the mapping of failed Bedrock calls to
 * them, shared by the OpenAI-compatible endpoints.
 */
import type { OpenAIError, OpenAIErrorType } from "./transform/types";
import {
  describeError,
  isUnreadableUpstreamResponse,
  isUpstreamAnswer,
  isUpstreamConnectionError,
  isUpstreamGatewayStatus,
  UPSTREAM_UNAVAILABLE_MESSAGE,
  upstreamMessage,
} from "../upstream-errors";

/**
 * Create an OpenAI-style error response
 */
export function errorResponse(
  message: string,
  type: OpenAIErrorType,
  status: number,
  code?: string,
  param?: string | null,
): Response {
  const error: OpenAIError = {
    error: {
      message,
      type,
      code: code ?? null,
      ...(param !== undefined && { param }),
    },
  };
  return Response.json(error, { status });
}

/** The OpenAI status, type and code of each Bedrock exception a client can act on. */
export const BEDROCK_ERRORS = new Map<string, { status: number; type: OpenAIErrorType; code: string }>([
  ["AccessDeniedException", { status: 403, type: "permission_error", code: "access_denied" }],
  ["ThrottlingException", { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded" }],
  ["ResourceNotFoundException", { status: 404, type: "not_found_error", code: "model_not_found" }],
  ["ValidationException", { status: 400, type: "invalid_request_error", code: "invalid_request" }],
  ["ModelTimeoutException", { status: 408, type: "timeout_error", code: "timeout" }],
  ["ServiceUnavailableException", { status: 503, type: "server_error", code: "service_unavailable" }],
]);

export interface MappedUpstreamError {
  status: number;
  type: OpenAIErrorType;
  code: string;
  message: string;
  /** provider: an answer from Bedrock; unavailable: Bedrock could not be reached; unexpected: the gateway's own failure. */
  kind: "provider" | "unavailable" | "unexpected";
}

/**
 * Map a failed upstream call to the error a client gets. Bedrock's exceptions
 * keep their message. A connection that could not be opened or broke, a
 * response cut off mid-body, and a 502/503/504 from in front of the upstream
 * become 503 service_unavailable with a neutral message: their own messages
 * name the upstream's address. The gateway's own failures keep their details
 * in the log.
 */
export function mapUpstreamError(error: unknown): MappedUpstreamError {
  const name = error instanceof Error ? error.name : "";
  if (name === "ProviderNotConfiguredError") {
    return { status: 503, type: "server_error", code: "provider_not_configured", message: "AWS Bedrock is not configured", kind: "provider" };
  }
  const known = BEDROCK_ERRORS.get(name);
  if (known) return { ...known, message: upstreamMessage(error) ?? name, kind: "provider" };
  if (isUpstreamConnectionError(error) || isUnreadableUpstreamResponse(error) || isUpstreamGatewayStatus(error)) {
    return { status: 503, type: "server_error", code: "service_unavailable", message: UPSTREAM_UNAVAILABLE_MESSAGE, kind: "unavailable" };
  }
  if (isUpstreamAnswer(error)) {
    return { status: 500, type: "server_error", code: "internal_error", message: upstreamMessage(error) ?? (name || "Internal server error"), kind: "provider" };
  }
  return { status: 500, type: "server_error", code: "internal_error", message: "Internal server error", kind: "unexpected" };
}

/** Log a failed upstream call with the request it belongs to; upstream addresses stay here. */
export function logUpstreamError(mapped: MappedUpstreamError, error: unknown, context: string, label = "[OpenAI Proxy]"): void {
  const where = `${context} status=${mapped.status} code=${mapped.code}`;
  if (mapped.kind === "unexpected") {
    console.error(`${label} Request failed: ${where}`, error);
  } else if (mapped.kind === "unavailable") {
    console.error(`${label} Upstream unavailable: ${where} error=${describeError(error)}`);
  } else {
    (mapped.status >= 500 ? console.error : console.warn)(`${label} Upstream error: ${where} error=${describeError(error)}`);
  }
}
