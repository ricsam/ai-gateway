import { describe, expect, test } from "bun:test";
import { describeError, isServiceException, isUpstreamConnectionError, isUpstreamGatewayStatus } from "./upstream-errors";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
const serviceException = (name: string, httpStatusCode: number, message = name) =>
  Object.assign(new Error(message), { name, $fault: httpStatusCode >= 500 ? "server" : "client", $metadata: { httpStatusCode } });

describe("upstream connection failures", () => {
  test("recognize refused, reset and timed-out connections, DNS and HTTP/2 failures", () => {
    for (const error of [
      withCode("connect ECONNREFUSED 10.103.57.41:8080", "ECONNREFUSED"),
      withCode("read ECONNRESET", "ECONNRESET"),
      withCode("connect ETIMEDOUT 10.103.57.41:8080", "ETIMEDOUT"),
      withCode("write EPIPE", "EPIPE"),
      withCode("connect EHOSTUNREACH 10.103.57.41:8080", "EHOSTUNREACH"),
      withCode("getaddrinfo ENOTFOUND bedrock-runtime.eu-west-1.amazonaws.com", "ENOTFOUND"),
      withCode("getaddrinfo EAI_AGAIN shim", "EAI_AGAIN"),
      withCode("Stream closed with error code NGHTTP2_INTERNAL_ERROR", "ERR_HTTP2_STREAM_ERROR"),
      withCode("Session closed with error code 2", "ERR_HTTP2_SESSION_ERROR"),
      withCode("Premature close", "ERR_STREAM_PREMATURE_CLOSE"),
      Object.assign(new Error("Socket timed out without establishing a connection within 1000 ms"), { name: "TimeoutError" }),
      Object.assign(new Error("Stream timed out because of no activity for 60000 ms"), { name: "TimeoutError" }),
      // The AWS SDK's HTTP/2 handler and event stream decoder raise these without a code.
      new Error("HTTP/2 stream is abnormally aborted in mid-communication with result code 2."),
      new Error("Unexpected error: http2 request did not get a response"),
      new Error("Frame type id 1 in stream id 3 has failed with code 7."),
      new Error("Truncated event message received."),
      new Error("socket hang up"),
    ]) {
      expect(isUpstreamConnectionError(error)).toBe(true);
    }
  });

  test("follow causes, like the SDK's pending-stream wrapper around the socket error", () => {
    const refused = withCode("connect ECONNREFUSED 10.103.57.41:8080", "ECONNREFUSED");
    expect(isUpstreamConnectionError(new Error("The pending stream has been canceled (caused by: connect ECONNREFUSED 10.103.57.41:8080)", { cause: refused }))).toBe(true);
    expect(isUpstreamConnectionError(new Error("request failed", { cause: new Error("wrapped", { cause: refused }) }))).toBe(true);
    // Without a code the wrapper's own message still counts.
    expect(isUpstreamConnectionError(new Error("The pending stream has been canceled (caused by: connect ECONNREFUSED 10.103.57.41:8080)"))).toBe(true);
  });

  test("leave out answers from the upstream, cancellations and the gateway's own errors", () => {
    for (const error of [
      serviceException("ThrottlingException", 429),
      serviceException("ServiceUnavailableException", 503),
      serviceException("InternalServerException", 500),
      // A service exception can name a connection problem in its message; it is still an answer.
      serviceException("ValidationException", 400, "socket hang up"),
      Object.assign(new Error("Request aborted"), { name: "AbortError", cause: new Error("Client request aborted") }),
      new TypeError("Cannot read properties of undefined (reading 'usage')"),
      { message: "Too many requests, please wait before trying again." },
      "ECONNREFUSED",
      undefined,
      null,
    ]) {
      expect(isUpstreamConnectionError(error)).toBe(false);
    }
  });

  test("a gateway status counts only as an unrecognized upstream answer", () => {
    for (const status of [502, 503, 504]) expect(isUpstreamGatewayStatus(serviceException("UnknownError", status))).toBe(true);
    expect(isUpstreamGatewayStatus(serviceException("InternalServerException", 500))).toBe(false);
    expect(isUpstreamGatewayStatus(Object.assign(new Error("bad gateway"), { $metadata: { httpStatusCode: 502 } }))).toBe(false);
    expect(isServiceException(serviceException("ThrottlingException", 429))).toBe(true);
    expect(isServiceException(new Error("x"))).toBe(false);
  });
});

describe("describeError", () => {
  test("names the error, its code, its causes and the SDK's attempts", () => {
    const error = Object.assign(new Error("The pending stream has been canceled (caused by: connect ECONNREFUSED 10.103.57.41:8080)", {
      cause: withCode("connect ECONNREFUSED 10.103.57.41:8080", "ECONNREFUSED"),
    }), { code: "ERR_HTTP2_STREAM_CANCEL", $metadata: { attempts: 3, totalRetryDelay: 184 } });
    expect(describeError(error)).toBe(
      "Error(ERR_HTTP2_STREAM_CANCEL): The pending stream has been canceled (caused by: connect ECONNREFUSED 10.103.57.41:8080)"
      + " <- Error(ECONNREFUSED): connect ECONNREFUSED 10.103.57.41:8080 attempts=3",
    );
  });

  test("describes service exceptions, thrown objects and other values", () => {
    expect(describeError(serviceException("ThrottlingException", 429, "Too many requests"))).toBe("ThrottlingException status=429: Too many requests");
    expect(describeError({ message: "Too many requests" })).toBe("Object: Too many requests");
    expect(describeError({ reason: "unknown" })).toBe('Object: {"reason":"unknown"}');
    expect(describeError("boom")).toBe("boom");
  });
});
