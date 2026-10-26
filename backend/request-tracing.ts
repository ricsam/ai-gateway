/** Client-controlled tracing only; never use this value as a settlement/cache key. */
export const CLIENT_REQUEST_ID_HEADER = "x-client-request-id";

export class ClientRequestIdError extends Error {
  readonly code = "invalid_client_request_id";
  readonly param = "X-Client-Request-Id";
  constructor() { super("X-Client-Request-Id must contain 1–512 printable ASCII characters"); }
}

export function readClientRequestId(headers: Headers): string | undefined {
  const value = headers.get(CLIENT_REQUEST_ID_HEADER);
  if (value === null) return undefined;
  // Printable ASCII permits attempt suffixes and punctuation without allowing
  // control characters into response headers or terminal logs.
  if (!/^[\x20-\x7e]{1,512}$/.test(value)) throw new ClientRequestIdError();
  return value;
}

/** Echo valid trace IDs on success and error responses, without touching bodies. */
export async function withClientRequestTrace(
  request: Request,
  handle: () => Promise<Response>,
  invalid: (error: ClientRequestIdError) => Response,
): Promise<Response> {
  let clientRequestId: string | undefined;
  try { clientRequestId = readClientRequestId(request.headers); }
  catch (error) {
    if (error instanceof ClientRequestIdError) return invalid(error);
    throw error;
  }
  if (clientRequestId === undefined) return handle();

  const fields = { clientRequestId, method: request.method, endpoint: new URL(request.url).pathname };
  try {
    const response = await handle();
    response.headers.set(CLIENT_REQUEST_ID_HEADER, clientRequestId);
    // JSON serialization keeps caller-controlled punctuation safely quoted.
    // Correlate with the existing settlement ID; do not derive it from this ID.
    console.info("[Inference request trace]", JSON.stringify({
      ...fields, status: response.status, requestId: response.headers.get("x-request-id") ?? undefined,
    }));
    return response;
  } catch (error) {
    console.info("[Inference request trace]", JSON.stringify({ ...fields, outcome: "handler_error" }));
    throw error;
  }
}
