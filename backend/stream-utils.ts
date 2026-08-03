/**
 * Detects the runtime error thrown when writing to a closed ReadableStream controller.
 */
export function isControllerClosedError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }

  return error.message.includes("Controller is already closed");
}
