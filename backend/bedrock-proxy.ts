import {
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseCommandInput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { and, eq } from "drizzle-orm";
import db from "@/db";
import { getBedrockClient, ProviderNotConfiguredError } from "./bedrock";
import { calculateCostBreakdown, checkBalance, deductCredits, type CostBreakdown } from "./credit-service";
import { hasAvailableCredits } from "./credit-settlement";
import { modelsTable } from "./schema";
import { authenticateApiKeyPrincipal, requireProxyScope, type ProxyPrincipal } from "./proxy-auth";
import { addConverseCachePoints } from "./openai-proxy/transform/cache-converse";
import { addInvokeCacheControl, type AnthropicInvokeBody } from "./openai-proxy/transform/cache-invoke";
import {
  emptyCacheUsage,
  extractConverseCacheUsage,
  extractInvokeCacheUsage,
  extractInvokeStreamingCacheUsage,
  extractStreamingCacheUsage,
  mergeCacheUsage,
  type CacheUsage,
} from "./openai-proxy/transform/cache-usage";
import { isControllerClosedError } from "./stream-utils";

export type BedrockProxyEndpoint = "invoke" | "invoke-stream" | "converse" | "converse-stream";

type ProxyBody = { modelId: string; body?: unknown; [key: string]: unknown };
type ModelInfo = {
  modelId: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number | null;
  cacheWrite5mPricePerMTok: number | null;
  cacheWrite1hPricePerMTok: number | null;
  managedCache: boolean;
  region: string | null;
};

function failure(message: string, status: number, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

function mapError(error: unknown): Response {
  if (error instanceof ProviderNotConfiguredError) return failure(error.message, 503, "provider_not_configured");
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "Bedrock request failed";
  const mapped: Record<string, [number, string]> = {
    AccessDeniedException: [403, "access_denied"],
    ThrottlingException: [429, "rate_limit_exceeded"],
    ResourceNotFoundException: [404, "model_not_found"],
    ValidationException: [400, "invalid_request"],
    ModelTimeoutException: [408, "timeout"],
    ServiceUnavailableException: [503, "service_unavailable"],
  };
  const [status, code] = mapped[name] ?? [500, "internal_error"];
  if (status === 500) console.error("Bedrock compatibility proxy error", { name, message });
  return failure(message, status, code);
}

function bodyBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value === undefined || value === null) return new Uint8Array();
  return new TextEncoder().encode(JSON.stringify(value));
}

function cost(model: ModelInfo, inputTokens: number, outputTokens: number, cache: CacheUsage): CostBreakdown {
  return calculateCostBreakdown({
    inputTokens,
    outputTokens,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    cacheReadTokens: cache.cacheReadTokens,
    cacheWrite5mTokens: cache.cacheWrite5mTokens,
    cacheWrite1hTokens: cache.cacheWrite1hTokens,
    cacheReadPricePerMTok: model.cacheReadPricePerMTok ?? undefined,
    cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok ?? undefined,
    cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok ?? undefined,
  });
}

async function settle(params: {
  principal: ProxyPrincipal;
  endpoint: BedrockProxyEndpoint;
  requestId: string;
  model: ModelInfo;
  inputTokens: number;
  outputTokens: number;
  cache: CacheUsage;
}) {
  const breakdown = cost(params.model, params.inputTokens, params.outputTokens, params.cache);
  return deductCredits({
    userId: params.principal.userId,
    amount: breakdown.total,
    type: "api",
    description: `Bedrock ${params.endpoint} call to ${params.model.modelId}`,
    requestId: params.requestId,
    apiKeyId: params.principal.credentialType === "api_key" ? params.principal.credentialId : undefined,
    source: "api",
    modelId: params.model.modelId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cache.cacheReadTokens,
    cacheWrite5mTokens: params.cache.cacheWrite5mTokens,
    cacheWrite1hTokens: params.cache.cacheWrite1hTokens,
    inputCost: breakdown.inputCost,
    outputCost: breakdown.outputCost,
    cacheReadCost: breakdown.cacheReadCost,
    cacheWrite5mCost: breakdown.cacheWrite5mCost,
    cacheWrite1hCost: breakdown.cacheWrite1hCost,
  });
}

export async function handleBedrockProxy(request: Request, endpoint: BedrockProxyEndpoint): Promise<Response> {
  const auth = requireProxyScope(await authenticateApiKeyPrincipal(request), "ai.invoke");
  if (!auth.ok) return failure(auth.message, auth.status, auth.code);

  let body: ProxyBody;
  try {
    body = await request.json() as ProxyBody;
  } catch {
    return failure("Invalid JSON body", 400, "invalid_json");
  }
  if (!body.modelId || typeof body.modelId !== "string") return failure("modelId is required", 400, "missing_model");

  const [model] = await db.select().from(modelsTable).where(and(
    eq(modelsTable.modelId, body.modelId),
    eq(modelsTable.enabled, true),
    eq(modelsTable.provider, "bedrock"),
  )).limit(1);
  if (!model) return failure(`Model "${body.modelId}" is not available for API access`, 400, "model_not_available");
  if (!hasAvailableCredits(await checkBalance(auth.principal.userId))) return failure("Insufficient credit balance", 402, "insufficient_credits");

  const modelInfo: ModelInfo = {
    modelId: model.modelId,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    cacheReadPricePerMTok: model.cacheReadPricePerMTok,
    cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok,
    cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok,
    managedCache: model.managedCache,
    region: model.region,
  };
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();

  try {
    const client = await getBedrockClient(model.region);
    switch (endpoint) {
      case "converse": return handleConverse(body, modelInfo, auth.principal, requestId, client);
      case "converse-stream": return handleConverseStream(body, modelInfo, auth.principal, requestId, client, request.signal);
      case "invoke": return handleInvoke(body, modelInfo, auth.principal, requestId, client);
      case "invoke-stream": return handleInvokeStream(body, modelInfo, auth.principal, requestId, client, request.signal);
    }
  } catch (error) {
    return mapError(error);
  }
}

async function handleConverse(body: ProxyBody, model: ModelInfo, principal: ProxyPrincipal, requestId: string, client: BedrockRuntimeClient): Promise<Response> {
  const { modelId, ...rest } = body;
  let input = { modelId, ...rest } as ConverseCommandInput;
  if (model.managedCache) input = addConverseCachePoints(input);
  const output = await client.send(new ConverseCommand(input));
  const cache = extractConverseCacheUsage(output.usage);
  await settle({
    principal, endpoint: "converse", requestId, model, cache,
    inputTokens: output.usage?.inputTokens ?? 0,
    outputTokens: output.usage?.outputTokens ?? 0,
  });
  return Response.json(output, { headers: { "x-request-id": requestId } });
}

async function handleInvoke(body: ProxyBody, model: ModelInfo, principal: ProxyPrincipal, requestId: string, client: BedrockRuntimeClient): Promise<Response> {
  const { modelId, body: requestBody, ...rest } = body;
  const transformed = model.managedCache && requestBody && typeof requestBody === "object"
    ? addInvokeCacheControl(requestBody as AnthropicInvokeBody)
    : requestBody;
  const requestBytes = bodyBytes(transformed);
  const output = await client.send(new InvokeModelCommand({ modelId, body: requestBytes, ...rest }));
  const responseBytes = output.body ?? new Uint8Array();
  const responseText = new TextDecoder().decode(responseBytes);
  let inputTokens = Math.ceil(requestBytes.length / 4);
  let outputTokens = Math.ceil(responseText.length / 4);
  let cache = emptyCacheUsage();
  try {
    const parsed = JSON.parse(responseText) as { usage?: { input_tokens?: number; output_tokens?: number } };
    inputTokens = parsed.usage?.input_tokens ?? inputTokens;
    outputTokens = parsed.usage?.output_tokens ?? outputTokens;
    cache = extractInvokeCacheUsage(parsed);
  } catch {
    // Non-JSON provider responses retain the historical byte-based estimate.
  }
  await settle({ principal, endpoint: "invoke", requestId, model, inputTokens, outputTokens, cache });
  return new Response(responseBytes, {
    headers: {
      "content-type": output.contentType ?? "application/json",
      "x-request-id": requestId,
    },
  });
}

type StreamState = {
  inputTokens: number;
  outputTokens: number;
  cache: CacheUsage;
  hasUsage: boolean;
  completed: boolean;
  unexpectedError: boolean;
  canceled: boolean;
};

function streamResponse(params: {
  source: AsyncIterable<unknown>;
  signal: AbortSignal;
  abort: AbortController;
  contentType: string;
  serialize: (event: unknown, state: StreamState) => Uint8Array | null;
  onFinish: (state: StreamState) => Promise<void>;
  requestId: string;
}): Response {
  const state: StreamState = { inputTokens: 0, outputTokens: 0, cache: emptyCacheUsage(), hasUsage: false, completed: false, unexpectedError: false, canceled: false };
  let iterator: AsyncIterator<unknown> | null = null;
  const cancel = (reason: unknown) => {
    if (state.canceled) return;
    state.canceled = true;
    if (!params.abort.signal.aborted) params.abort.abort(reason);
    if (iterator?.return) void iterator.return();
  };
  const onAbort = () => cancel(new Error("Client request aborted"));
  if (params.signal.aborted) onAbort(); else params.signal.addEventListener("abort", onAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (value: Uint8Array) => {
        if (state.canceled) return false;
        try { controller.enqueue(value); return true; }
        catch (error) { if (isControllerClosedError(error)) { cancel(error); return false; } throw error; }
      };
      try {
        iterator = params.source[Symbol.asyncIterator]();
        while (!state.canceled) {
          const next = await iterator.next();
          if (next.done) { state.completed = true; break; }
          const bytes = params.serialize(next.value, state);
          if (bytes && !safeEnqueue(bytes)) break;
        }
      } catch (error) {
        if (!state.canceled && !isControllerClosedError(error)) {
          state.unexpectedError = true;
          try { controller.error(error); } catch { /* downstream is already closed */ }
        }
      } finally {
        params.signal.removeEventListener("abort", onAbort);
        try { await params.onFinish(state); } catch (error) { console.error("Bedrock stream settlement failed", error); }
        if (!state.unexpectedError && !state.canceled) {
          try { controller.close(); } catch { /* downstream is already closed */ }
        }
      }
    },
    cancel,
  });
  return new Response(stream, {
    headers: {
      "content-type": params.contentType,
      "cache-control": "no-cache",
      "x-request-id": params.requestId,
    },
  });
}

async function handleConverseStream(body: ProxyBody, model: ModelInfo, principal: ProxyPrincipal, requestId: string, client: BedrockRuntimeClient, signal: AbortSignal): Promise<Response> {
  const { modelId, ...rest } = body;
  let input = { modelId, ...rest } as ConverseCommandInput;
  if (model.managedCache) input = addConverseCachePoints(input);
  const abort = new AbortController();
  const output = await client.send(new ConverseStreamCommand(input), { abortSignal: abort.signal });
  if (!output.stream) return failure("No stream in response", 500, "no_stream");
  const encoder = new TextEncoder();
  return streamResponse({
    source: output.stream as AsyncIterable<ConverseStreamOutput>, signal, abort, requestId,
    contentType: "application/x-ndjson",
    serialize(event, state) {
      const value = event as ConverseStreamOutput;
      if (value.metadata?.usage) {
        state.inputTokens = value.metadata.usage.inputTokens ?? state.inputTokens;
        state.outputTokens = value.metadata.usage.outputTokens ?? state.outputTokens;
        state.cache = extractStreamingCacheUsage(value.metadata);
        state.hasUsage = true;
      }
      return encoder.encode(`${JSON.stringify(value)}\n`);
    },
    async onFinish(state) {
      if (!state.unexpectedError && (state.completed || (state.canceled && state.hasUsage))) {
        await settle({ principal, endpoint: "converse-stream", requestId, model, inputTokens: state.inputTokens, outputTokens: state.outputTokens, cache: state.cache });
      }
    },
  });
}

async function handleInvokeStream(body: ProxyBody, model: ModelInfo, principal: ProxyPrincipal, requestId: string, client: BedrockRuntimeClient, signal: AbortSignal): Promise<Response> {
  const { modelId, body: requestBody, ...rest } = body;
  const transformed = model.managedCache && requestBody && typeof requestBody === "object"
    ? addInvokeCacheControl(requestBody as AnthropicInvokeBody)
    : requestBody;
  const requestBytes = bodyBytes(transformed);
  const abort = new AbortController();
  const output = await client.send(new InvokeModelWithResponseStreamCommand({ modelId, body: requestBytes, ...rest }), { abortSignal: abort.signal });
  if (!output.body) return failure("No stream in response", 500, "no_stream");
  let streamedBytes = 0;
  return streamResponse({
    source: output.body as AsyncIterable<unknown>, signal, abort, requestId,
    contentType: "application/octet-stream",
    serialize(event, state) {
      const bytes = (event as { chunk?: { bytes?: Uint8Array } }).chunk?.bytes;
      if (!bytes) return null;
      streamedBytes += bytes.length;
      try {
        const usage = extractInvokeStreamingCacheUsage(new TextDecoder().decode(bytes));
        if (usage) {
          state.hasUsage = true;
          if (usage.inputTokens > 0) state.inputTokens = usage.inputTokens;
          if (usage.outputTokens > 0) state.outputTokens += usage.outputTokens;
          state.cache = mergeCacheUsage(state.cache, usage.cacheUsage);
        }
      } catch {
        // Individual event payloads need not be complete JSON documents.
      }
      return bytes;
    },
    async onFinish(state) {
      if (state.completed) {
        if (!state.inputTokens) state.inputTokens = Math.ceil(requestBytes.length / 4);
        if (!state.outputTokens) state.outputTokens = Math.ceil(streamedBytes / 4);
      }
      if (!state.unexpectedError && (state.completed || (state.canceled && state.hasUsage))) {
        await settle({ principal, endpoint: "invoke-stream", requestId, model, inputTokens: state.inputTokens, outputTokens: state.outputTokens, cache: state.cache });
      }
    },
  });
}
