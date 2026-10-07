/** RPC errors carry the useful server explanation in payload, not Error.message. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "payload" in error) {
    const payload = error.payload;
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  }
  return error instanceof Error ? error.message : fallback;
}
