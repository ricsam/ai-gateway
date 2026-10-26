import { describe, expect, spyOn, test } from "bun:test";
import { readClientRequestId, withClientRequestTrace } from "./request-tracing";

const errorResponse = (error: Error) => Response.json({ error: error.message }, { status: 400 });

describe("client request tracing", () => {
  test("absent is opt-out; printable ASCII permits slash suffixes and 512 characters", () => {
    expect(readClientRequestId(new Headers())).toBeUndefined();
    for (const value of ["step/1", "step/2", 'trace with punctuation: []{}()!?"\\', "a".repeat(512)]) {
      expect(readClientRequestId(new Headers({ "X-Client-Request-Id": value }))).toBe(value);
    }
  });

  test("rejects empty, controls, DEL, non-ASCII and overlong IDs", () => {
    for (const value of ["", "a".repeat(513), "café", "a\tb", "a\x1bb", "a\x7fb"]) {
      expect(() => readClientRequestId(new Headers({ "x-client-request-id": value }))).toThrow("printable ASCII");
    }
  });

  test("echoes and safely logs trace and settlement IDs without touching body or other headers", async () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      const trace = 'step/2 "quoted" \\';
      const request = new Request("https://gateway.test/v1/chat/completions?secret=not-logged", {
        headers: { "x-client-request-id": trace, "x-request-id": "logical-step", authorization: "Bearer not-logged" },
      });
      const original = Response.json({ id: "logical-step" }, { headers: { "x-request-id": "logical-step", "x-conversation-id": "thread" } });
      const response = await withClientRequestTrace(request, async () => original, errorResponse);
      expect(response).toBe(original);
      expect(response.headers.get("x-client-request-id")).toBe(trace);
      expect(response.headers.get("x-request-id")).toBe("logical-step");
      expect(response.headers.get("x-conversation-id")).toBe("thread");
      expect(await response.json()).toEqual({ id: "logical-step" });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![1] as string)).toEqual({
        clientRequestId: trace, requestId: "logical-step", method: "GET", endpoint: "/v1/chat/completions", status: 200,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("not-logged");
    } finally { log.mockRestore(); }
  });

  test("valid trace is echoed on errors; invalid trace never dispatches or echoes", async () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      const failed = await withClientRequestTrace(new Request("https://gateway.test", { headers: { "x-client-request-id": "attempt/2" } }),
        async () => Response.json({ error: "Unauthorized" }, { status: 401 }), errorResponse);
      expect(failed.status).toBe(401);
      expect(failed.headers.get("x-client-request-id")).toBe("attempt/2");
      let dispatched = false;
      const invalid = await withClientRequestTrace(new Request("https://gateway.test", { headers: { "x-client-request-id": "é" } }),
        async () => { dispatched = true; return new Response(); }, errorResponse);
      expect(invalid.status).toBe(400);
      expect(invalid.headers.has("x-client-request-id")).toBe(false);
      expect(dispatched).toBe(false);
    } finally { log.mockRestore(); }
  });

  test("missing trace preserves behavior; thrown errors are logged without their contents", async () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      const original = new Response("same");
      expect(await withClientRequestTrace(new Request("https://gateway.test"), async () => original, errorResponse)).toBe(original);
      expect(log).not.toHaveBeenCalled();
      const error = new Error("private error data");
      await expect(withClientRequestTrace(new Request("https://gateway.test", { headers: { "x-client-request-id": "attempt/3" } }),
        async () => { throw error; }, errorResponse)).rejects.toBe(error);
      expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({ clientRequestId: "attempt/3", outcome: "handler_error" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private error data");
    } finally { log.mockRestore(); }
  });

  test("does not buffer streaming response bodies", async () => {
    let finish!: () => void;
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      finish = () => controller.close();
    } }));
    const traced = await withClientRequestTrace(new Request("https://gateway.test", { headers: { "x-client-request-id": "stream/1" } }), async () => response, errorResponse);
    expect(traced.body).toBe(response.body);
    expect(traced.bodyUsed).toBe(false);
    finish();
    expect(await traced.text()).toBe("first");
  });
});
