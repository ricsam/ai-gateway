/** A failure to report as `aigctl: <message>`, without a stack trace. */
export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1) { super(message); }
}

/** Wrong arguments or options: exit code 2. */
export class UsageError extends CliError {
  constructor(message: string, public readonly helpCommand?: string) { super(message, 2); }
}

/** An error response from the management API. */
export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly body?: unknown,
  ) { super(message); }
}

export function apiErrorFromResponse(status: number, body: unknown): ApiError {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === "object") {
      const { code, message, requestId } = error as { code?: unknown; message?: unknown; requestId?: unknown };
      return new ApiError(status, typeof code === "string" ? code : "error", typeof message === "string" ? message : `Request failed with HTTP ${status}`,
        typeof requestId === "string" ? requestId : undefined, body);
    }
    if (typeof error === "string") return new ApiError(status, "error", error, undefined, body);
  }
  if (body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string") {
    return new ApiError(status, `http_${status}`, (body as { message: string }).message, undefined, body);
  }
  const text = typeof body === "string" ? body.trim().slice(0, 300) : "";
  return new ApiError(status, `http_${status}`, `Request failed with HTTP ${status}${text ? `: ${text}` : ""}`, undefined, body);
}
