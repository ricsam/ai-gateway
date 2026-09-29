/**
 * OpenAI-compatible Chat Completions API handler
 * 
 * Translates OpenAI format to AWS Bedrock Converse API and back.
 */
import {
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClient, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import db from "@/db";
import { modelsTable } from "../schema";
import { and, eq } from "drizzle-orm";
import {
  authenticateApiKeyPrincipal,
  authenticateSessionPrincipal,
  requireProxyScope,
  type ProxyPrincipal,
} from "../proxy-auth";
import { deductCredits, calculateCostBreakdown, checkBalance } from "../credit-service";
import { hasAvailableCredits } from "../credit-settlement";
import { getRemoteImageUrlsEnabled } from "../config-service";
import { isReasoningEffort, resolveReasoningProfile } from "@/shared/reasoning";
import { transformRequest } from "./transform/request";
import { transformResponse } from "./transform/response";
import { applyReasoning, ReasoningConfigError } from "./transform/reasoning";
import { collectRemoteImageUrls, RequestValidationError, validateChatCompletionRequest } from "./transform/validate";
import { ImageInputError, type ResolvedImage } from "./images";
import { fetchRemoteImages } from "./remote-image";
import { addConverseCachePoints } from "./transform/cache-converse";
import { extractConverseCacheUsage, extractStreamingCacheUsage, emptyCacheUsage } from "./transform/cache-usage";
import type { CacheUsage } from "./transform/cache-usage";
import type { OpenAIChatCompletionChunk, OpenAICreditUsage, OpenAIToolCallDelta, OpenAIChatCompletionRequest, OpenAIError, OpenAIErrorType } from "./transform/types";
import { generateChatCompletionId, unixTimestamp, mapStopReason } from "./transform/utils";
import { getBedrockClient } from "../bedrock";
import { isControllerClosedError } from "../stream-utils";

interface ModelInfo {
  modelId: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number | null;
  cacheWrite5mPricePerMTok: number | null;
  cacheWrite1hPricePerMTok: number | null;
  managedCache: boolean;
  region: string | null;
}

/**
 * Create an OpenAI-style error response
 */
function errorResponse(
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

/**
 * Map AWS SDK errors to OpenAI error format
 */
function mapAwsError(error: Error): Response {
  const errorName = error.name || "";
  if (errorName === "ProviderNotConfiguredError") {
    return errorResponse("AWS Bedrock is not configured", "server_error", 503, "provider_not_configured");
  }
  console.warn("[OpenAI Proxy] AWS error:", { name: error.name, message: error.message });
  const message = error.message || "Unknown error";
  
  switch (errorName) {
    case "AccessDeniedException":
      return errorResponse(message, "permission_error", 403, "access_denied");
    case "ThrottlingException":
      return errorResponse(message, "rate_limit_error", 429, "rate_limit_exceeded");
    case "ResourceNotFoundException":
      return errorResponse(message, "not_found_error", 404, "model_not_found");
    case "ValidationException":
      return errorResponse(message, "invalid_request_error", 400, "invalid_request");
    case "ModelTimeoutException":
      return errorResponse(message, "timeout_error", 408, "timeout");
    case "ServiceUnavailableException":
      return errorResponse(message, "server_error", 503, "service_unavailable");
    default:
      return errorResponse(message, "server_error", 500, "internal_error");
  }
}

/**
 * Handle OpenAI-compatible /v1/chat/completions requests
 */
export async function handleOpenAIProxy(
  request: Request,
  authMode: "api_key" | "session" = "api_key",
): Promise<Response> {
  // 1. Authenticate to the shared proxy-principal boundary and enforce endpoint scope.
  const authResult = requireProxyScope(
    authMode === "session"
      ? await authenticateSessionPrincipal(request)
      : await authenticateApiKeyPrincipal(request),
    "ai.invoke",
  );
  if (!authResult.ok) {
    return errorResponse(
      authResult.message,
      authResult.status === 401 ? "authentication_error" : "permission_error",
      authResult.status,
      authResult.code,
    );
  }

  const principal: ProxyPrincipal = authResult.principal;
  const { userId } = principal;

  // 2. Credential and user state are enforced by the principal authenticator.
  // Parse, validate, and normalize the OpenAI request body.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", "invalid_request_error", 400, "invalid_json");
  }
  let body: OpenAIChatCompletionRequest;
  try {
    body = validateChatCompletionRequest(rawBody);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return errorResponse(error.message, "invalid_request_error", 400, error.code, error.param);
    }
    throw error;
  }

  // 3. Validate model exists in the single enabled Bedrock catalog.
  const [model] = await db
    .select()
    .from(modelsTable)
    .where(and(
      eq(modelsTable.modelId, body.model),
      eq(modelsTable.enabled, true),
      eq(modelsTable.provider, "bedrock"),
    ))
    .limit(1);

  if (!model) {
    return errorResponse(
      `Model "${body.model}" is not available for API access`,
      "invalid_request_error",
      400,
      "model_not_available"
    );
  }

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

  // 4. Check user has a positive credit balance
  const balance = await checkBalance(userId);
  if (!hasAvailableCredits(balance)) {
    return errorResponse("Insufficient credit balance", "invalid_request_error", 402, "insufficient_credits");
  }

  const suppliedRequestId = request.headers.get("x-request-id")?.trim();
  const requestId = suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : generateChatCompletionId();
  const imageCount = body.messages.reduce((total, message) => total + (
    (message.role === "user" || message.role === "tool") && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url").length
      : 0
  ), 0);
  console.log(`[OpenAI Proxy] request=${requestId} user=${userId.slice(0, 8)} model=${body.model} stream=${body.stream === true} messages=${body.messages.length} tools=${body.tools?.length ?? 0} images=${imageCount} reasoning_effort=${body.reasoning_effort ?? "default"}`);

  // 5. Enforce the configured output limit, resolve images, and transform to Bedrock format.
  if (body.max_tokens !== undefined && body.max_tokens > model.maxOutputTokens) {
    return errorResponse(
      `max_tokens must be a positive integer no greater than ${model.maxOutputTokens}`,
      "invalid_request_error",
      400,
      "invalid_max_tokens",
      "max_tokens",
    );
  }

  let remoteImages: Map<string, ResolvedImage> | undefined;
  const remoteImageUrls = collectRemoteImageUrls(body.messages);
  if (remoteImageUrls.size > 0) {
    if (!(await getRemoteImageUrlsEnabled())) {
      return errorResponse(
        "Image URLs are disabled on this gateway; send images as base64 data URLs",
        "invalid_request_error",
        400,
        "remote_image_urls_disabled",
        remoteImageUrls.values().next().value ?? null,
      );
    }
    try {
      remoteImages = await fetchRemoteImages(remoteImageUrls, { signal: request.signal });
    } catch (error) {
      if (error instanceof ImageInputError) {
        return errorResponse(error.message, "invalid_request_error", 400, error.code, error.param ?? null);
      }
      if (request.signal.aborted) {
        return errorResponse("Client request aborted", "invalid_request_error", 400, "request_aborted");
      }
      throw error;
    }
  }

  let bedrockRequest: ReturnType<typeof transformRequest>;
  try {
    bedrockRequest = transformRequest({
      ...body,
      max_tokens: body.max_tokens ?? model.maxOutputTokens,
    }, { remoteImages });
  } catch (error) {
    if (error instanceof ImageInputError) {
      return errorResponse(error.message, "invalid_request_error", 400, error.code, error.param ?? null);
    }
    throw error;
  }

  // Reasoning: an explicit request value wins over the model's configured default.
  const reasoningEffort = body.reasoning_effort
    ?? (isReasoningEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : undefined);
  if (model.thinking && reasoningEffort) {
    try {
      bedrockRequest = applyReasoning(bedrockRequest, {
        profile: resolveReasoningProfile(model.modelId, model.reasoningMode),
        effort: reasoningEffort,
        maxOutputTokens: model.maxOutputTokens,
      }).request;
    } catch (error) {
      if (error instanceof ReasoningConfigError) {
        return errorResponse(error.message, "invalid_request_error", 400, error.code, "reasoning_effort");
      }
      throw error;
    }
  }

  // 6. Apply managed cache points if enabled
  if (modelInfo.managedCache) {
    bedrockRequest = addConverseCachePoints(bedrockRequest);
  }

  try {
    // Create region-specific Bedrock client lazily inside the mapped error boundary.
    const bedrockClient = await getBedrockClient(modelInfo.region);
    if (body.stream === true) {
      // 7. Streaming request
      return await handleStreamingRequest(bedrockRequest, modelInfo, principal, body.model, requestId, bedrockClient, request.signal);
    } else {
      // 8. Non-streaming request
      return await handleNonStreamingRequest(bedrockRequest, modelInfo, principal, body.model, requestId, bedrockClient);
    }
  } catch (error) {
    console.error("OpenAI proxy error:", error);
    if (error instanceof Error) {
      return mapAwsError(error);
    }
    return errorResponse("Unknown error", "server_error", 500, "internal_error");
  }
}

function playgroundCreditUsage(settlement: {
  actualCost: number;
  creditsCharged: number;
  balanceAfter: number;
  partiallyCharged: boolean;
}): OpenAICreditUsage {
  return {
    actual_cost: settlement.actualCost,
    credits_charged: settlement.creditsCharged,
    balance_after: settlement.balanceAfter,
    partially_charged: settlement.partiallyCharged,
  };
}

/**
 * Handle non-streaming chat completion request
 */
async function handleNonStreamingRequest(
  bedrockRequest: ReturnType<typeof transformRequest>,
  model: ModelInfo,
  principal: ProxyPrincipal,
  requestedModel: string,
  requestId: string,
  bedrockClient: BedrockRuntimeClient
): Promise<Response> {
  const userId = principal.userId;
  const command = new ConverseCommand(bedrockRequest);
  const response = await bedrockClient.send(command);

  // Log abnormal stop reasons
  if (response.stopReason && response.stopReason !== "end_turn") {
    console.warn(`[OpenAI Proxy] Non-streaming stop reason: ${response.stopReason} model=${model.modelId}`);
  }

  // Extract token usage
  const inputTokens = response.usage?.inputTokens ?? 0;
  const outputTokens = response.usage?.outputTokens ?? 0;

  // Extract cache usage
  const cacheUsage = extractConverseCacheUsage(response.usage);

  // Calculate and deduct credits with cache pricing
  const costBreakdown = calculateCostBreakdown({
    inputTokens,
    outputTokens,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    cacheReadTokens: cacheUsage.cacheReadTokens,
    cacheWrite5mTokens: cacheUsage.cacheWrite5mTokens,
    cacheWrite1hTokens: cacheUsage.cacheWrite1hTokens,
    cacheReadPricePerMTok: model.cacheReadPricePerMTok ?? undefined,
    cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok ?? undefined,
    cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok ?? undefined,
  });

  const settlement = await deductCredits({
    userId,
    amount: costBreakdown.total,
    type: principal.credentialType === "session" ? "chat" : "api",
    description: `Chat completion using ${model.modelId}`,
    requestId,
    apiKeyId: principal.credentialType === "api_key" ? principal.credentialId : undefined,
    source: principal.credentialType === "session" ? "playground" : "api",
    modelId: model.modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheUsage.cacheReadTokens,
    cacheWrite5mTokens: cacheUsage.cacheWrite5mTokens,
    cacheWrite1hTokens: cacheUsage.cacheWrite1hTokens,
    inputCost: costBreakdown.inputCost,
    outputCost: costBreakdown.outputCost,
    cacheReadCost: costBreakdown.cacheReadCost,
    cacheWrite5mCost: costBreakdown.cacheWrite5mCost,
    cacheWrite1hCost: costBreakdown.cacheWrite1hCost,
  });

  // Log completion
  console.log(
    `[OpenAI Proxy] Complete: model=${model.modelId} input=${inputTokens} output=${outputTokens} actualCost=${costBreakdown.total.toFixed(6)} charged=${(settlement?.creditsCharged ?? 0).toFixed(6)} balanceAfter=${settlement?.balanceAfter.toFixed(6) ?? "unchanged"} partial=${settlement?.partiallyCharged ?? false}`,
  );

  // Transform response to OpenAI format
  const openaiResponse = transformResponse(response, requestedModel, requestId);
  if (principal.credentialType === "session" && settlement) {
    openaiResponse.credit_usage = playgroundCreditUsage(settlement);
  }
  return Response.json(openaiResponse);
}

/**
 * Handle streaming chat completion request
 */
/**
 * Handles a streaming OpenAI-compatible chat completion request by proxying to
 * Bedrock's ConverseStream API and transforming events to SSE chunks.
 *
 * Timeout chain (client → proxy → Bedrock):
 *   - Bun serve idleTimeout (server.ts): 255s - prevents the server from closing
 *     idle connections before Bedrock responds.
 *   - SSE heartbeat (below): sends `: heartbeat\n\n` comments every 15s to keep
 *     the connection alive through intermediate proxies and client read timeouts.
 *   - Client-side: clients (e.g. OpenCode) must set their HTTP read/idle timeout
 *     to at least 120s. Large-context requests to Claude Opus can have a
 *     time-to-first-token of 10-30s+. If the client timeout is too short, it will
 *     disconnect before Bedrock starts streaming, causing "consumer canceled stream"
 *     errors and infinite retry loops.
 */
async function handleStreamingRequest(
  bedrockRequest: ReturnType<typeof transformRequest>,
  model: ModelInfo,
  principal: ProxyPrincipal,
  requestedModel: string,
  requestId: string,
  bedrockClient: BedrockRuntimeClient,
  requestSignal: AbortSignal
): Promise<Response> {
  const userId = principal.userId;
  const command = new ConverseStreamCommand(bedrockRequest);
  const upstreamAbortController = new AbortController();
  const abortUpstream = (reason: unknown): void => {
    if (!upstreamAbortController.signal.aborted) {
      upstreamAbortController.abort(reason);
    }
  };

  const onRequestAbort = () => {
    abortUpstream(new Error("Client request aborted"));
  };

  if (requestSignal.aborted) {
    onRequestAbort();
  } else {
    requestSignal.addEventListener("abort", onRequestAbort);
  }

  const response = await bedrockClient.send(command, { abortSignal: upstreamAbortController.signal }).catch((error) => {
    requestSignal.removeEventListener("abort", onRequestAbort);
    throw error;
  });

  if (!response.stream) {
    requestSignal.removeEventListener("abort", onRequestAbort);
    return errorResponse("No stream in response", "server_error", 500, "no_stream");
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheUsage = emptyCacheUsage();
  let hasUsageMetadata = false;
  let sawUnexpectedError = false;
  let streamCompleted = false;
  let isCanceled = false;
  let isControllerClosed = false;
  let cancellationLogged = false;
  let streamIterator: AsyncIterator<ConverseStreamOutput> | null = null;

  // SSE formatting
  const id = requestId;
  const created = unixTimestamp();
  
  // Map Bedrock contentBlockIndex to OpenAI tool_calls array index
  const blockToToolIndex = new Map<number, number>();
  let nextToolIndex = 0;

  const isStreamCanceled = (): boolean =>
    isCanceled || isControllerClosed || requestSignal.aborted || upstreamAbortController.signal.aborted;

  const logCancellationOnce = (reason: string): void => {
    if (cancellationLogged) {
      return;
    }
    cancellationLogged = true;
    console.info(`[OpenAI Proxy] Stream canceled: ${reason}`);
  };

  const cancelStream = (reason: unknown): void => {
    if (isCanceled) {
      return;
    }
    isCanceled = true;
    abortUpstream(reason);
    if (streamIterator && typeof streamIterator.return === "function") {
      void streamIterator.return();
    }
  };

  // Create a readable stream that transforms Bedrock events to OpenAI SSE
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const safeEnqueue = (chunkBytes: Uint8Array): boolean => {
        if (isStreamCanceled()) {
          return false;
        }
        try {
          controller.enqueue(chunkBytes);
          return true;
        } catch (error) {
          if (isControllerClosedError(error)) {
            isControllerClosed = true;
            cancelStream(error);
            return false;
          }
          throw error;
        }
      };

      const safeClose = (): boolean => {
        if (isStreamCanceled()) {
          return false;
        }
        try {
          controller.close();
          isControllerClosed = true;
          return true;
        } catch (error) {
          if (isControllerClosedError(error)) {
            isControllerClosed = true;
            return false;
          }
          throw error;
        }
      };

      const safeError = (error: unknown): boolean => {
        if (isStreamCanceled()) {
          return false;
        }
        try {
          controller.error(error);
          isControllerClosed = true;
          return true;
        } catch (controllerError) {
          if (isControllerClosedError(controllerError)) {
            isControllerClosed = true;
            return false;
          }
          throw controllerError;
        }
      };

      const sendChunk = (chunk: OpenAIChatCompletionChunk): boolean =>
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

      // Send an immediate SSE comment to keep the connection alive while Bedrock
      // processes the prompt. SSE comments (lines starting with ':') are ignored
      // by compliant SSE parsers but flush the first byte to the client, preventing
      // read timeouts during Bedrock's time-to-first-token (which can be 10-30s+
      // for large contexts on models like Claude Opus).
      const heartbeatBytes = encoder.encode(": heartbeat\n\n");
      safeEnqueue(heartbeatBytes);

      // Send periodic heartbeats every 5s while waiting for Bedrock events.
      // This prevents intermediate proxies and clients from timing out on idle
      // connections during long prompt processing.
      const heartbeatInterval = setInterval(() => {
        if (isStreamCanceled()) {
          clearInterval(heartbeatInterval);
          return;
        }
        safeEnqueue(heartbeatBytes);
      }, 5_000);

      try {
        streamIterator = response.stream![Symbol.asyncIterator]();
        while (true) {
          if (isStreamCanceled()) {
            break;
          }

          const { value: event, done } = await streamIterator.next();
          if (done) {
            streamCompleted = true;
            break;
          }

          // Handle messageStart event
          if (event.messageStart) {
            const enqueued = sendChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [{
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
                logprobs: null,
              }],
            });
            if (!enqueued) {
              break;
            }
          }

          // Handle contentBlockStart event
          if (event.contentBlockStart) {
            const start = event.contentBlockStart.start;
            const blockIndex = event.contentBlockStart.contentBlockIndex ?? 0;
            
            // Check if this is a toolUse start
            if (start && "toolUse" in start && start.toolUse) {
              const toolUse = start.toolUse;
              const toolIndex = nextToolIndex++;
              blockToToolIndex.set(blockIndex, toolIndex);
              
              const toolCallDelta: OpenAIToolCallDelta = {
                index: toolIndex,
                id: toolUse.toolUseId ?? `call_${crypto.randomUUID()}`,
                type: "function",
                function: {
                  name: toolUse.name ?? "",
                  arguments: "",
                },
              };
              
              const enqueued = sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: { tool_calls: [toolCallDelta] },
                  finish_reason: null,
                  logprobs: null,
                }],
              });
              if (!enqueued) {
                break;
              }
            }
          }

          // Handle contentBlockDelta event
          if (event.contentBlockDelta) {
            const delta = event.contentBlockDelta.delta;
            const blockIndex = event.contentBlockDelta.contentBlockIndex ?? 0;
            
            // Bedrock thinking-capable models can emit reasoning blocks. Keep
            // them separate from visible answer text for the model playground.
            if (delta && "reasoningContent" in delta && delta.reasoningContent) {
              const reasoning = "text" in delta.reasoningContent ? delta.reasoningContent.text : undefined;
              if (reasoning) {
                const enqueued = sendChunk({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null, logprobs: null }],
                });
                if (!enqueued) break;
              }
            }

            // Handle text delta
            if (delta && "text" in delta && delta.text !== undefined) {
              const enqueued = sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: { content: delta.text },
                  finish_reason: null,
                  logprobs: null,
                }],
              });
              if (!enqueued) {
                break;
              }
            }
            
            // Handle toolUse delta (arguments)
            if (delta && "toolUse" in delta && delta.toolUse) {
              const toolIndex = blockToToolIndex.get(blockIndex) ?? 0;
              const input = delta.toolUse.input ?? "";
              
              const enqueued = sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: toolIndex,
                      function: { arguments: input },
                    }],
                  },
                  finish_reason: null,
                  logprobs: null,
                }],
              });
              if (!enqueued) {
                break;
              }
            }
          }

          // Handle messageStop event
          if (event.messageStop) {
            const finishReason = mapStopReason(event.messageStop.stopReason);
            
            const enqueued = sendChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason,
                logprobs: null,
              }],
            });
            if (!enqueued) {
              break;
            }
          }

          // Handle metadata event (contains usage info)
          if (event.metadata?.usage) {
            inputTokens = event.metadata.usage.inputTokens ?? 0;
            outputTokens = event.metadata.usage.outputTokens ?? 0;
            cacheUsage = extractStreamingCacheUsage(event.metadata);
            hasUsageMetadata = true;
            
            const enqueued = sendChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            });
            if (!enqueued) {
              break;
            }
          }
        }
      } catch (error) {
        if (isStreamCanceled() || isControllerClosedError(error)) {
          logCancellationOnce("downstream closed");
        } else {
          sawUnexpectedError = true;
          console.error("[OpenAI Proxy] Stream error:", error instanceof Error ? { name: error.name, message: error.message } : error);
          safeError(error);
        }
      } finally {
        clearInterval(heartbeatInterval);
        const streamCanceled = isStreamCanceled() && !streamCompleted;
        requestSignal.removeEventListener("abort", onRequestAbort);

        if (streamCompleted && !streamCanceled) {
          // Warn if stream completed without any usage metadata
          if (inputTokens === 0 && outputTokens === 0) {
            console.warn("[OpenAI Proxy] Stream completed with no usage metadata");
          }
        } else if (streamCanceled) {
          logCancellationOnce(hasUsageMetadata ? "billed using metadata" : "no usage metadata, not billed");
        }

        const shouldBill = !sawUnexpectedError && (streamCompleted || (streamCanceled && hasUsageMetadata));
        if (shouldBill) {
          try {
            const costBreakdown = calculateCostBreakdown({
              inputTokens,
              outputTokens,
              inputPricePerMTok: model.inputPricePerMTok,
              outputPricePerMTok: model.outputPricePerMTok,
              cacheReadTokens: cacheUsage.cacheReadTokens,
              cacheWrite5mTokens: cacheUsage.cacheWrite5mTokens,
              cacheWrite1hTokens: cacheUsage.cacheWrite1hTokens,
              cacheReadPricePerMTok: model.cacheReadPricePerMTok ?? undefined,
              cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok ?? undefined,
              cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok ?? undefined,
            });

            const settlement = await deductCredits({
              userId,
              amount: costBreakdown.total,
              type: principal.credentialType === "session" ? "chat" : "api",
              description: `Streaming chat completion using ${model.modelId}`,
              requestId,
              apiKeyId: principal.credentialType === "api_key" ? principal.credentialId : undefined,
              source: principal.credentialType === "session" ? "playground" : "api",
              modelId: model.modelId,
              inputTokens,
              outputTokens,
              cacheReadTokens: cacheUsage.cacheReadTokens,
              cacheWrite5mTokens: cacheUsage.cacheWrite5mTokens,
              cacheWrite1hTokens: cacheUsage.cacheWrite1hTokens,
              inputCost: costBreakdown.inputCost,
              outputCost: costBreakdown.outputCost,
              cacheReadCost: costBreakdown.cacheReadCost,
              cacheWrite5mCost: costBreakdown.cacheWrite5mCost,
              cacheWrite1hCost: costBreakdown.cacheWrite1hCost,
            });

            if (principal.credentialType === "session" && settlement && !isStreamCanceled()) {
              sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [],
                credit_usage: playgroundCreditUsage(settlement),
              });
            }

            // Log completion/cost for billed streams
            console.log(
              `[OpenAI Proxy] Complete: model=${model.modelId} input=${inputTokens} output=${outputTokens} actualCost=${costBreakdown.total.toFixed(6)} charged=${(settlement?.creditsCharged ?? 0).toFixed(6)} balanceAfter=${settlement?.balanceAfter.toFixed(6) ?? "unchanged"} partial=${settlement?.partiallyCharged ?? false}`,
            );
          } catch (billingError) {
            console.error(
              "[OpenAI Proxy] Stream billing error:",
              billingError instanceof Error ? { name: billingError.name, message: billingError.message } : billingError
            );
            if (principal.credentialType === "session" && !isStreamCanceled()) {
              sawUnexpectedError = true;
              safeError(new Error("The response completed, but playground credits could not be settled"));
            }
          }
        }

        if (!sawUnexpectedError) {
          // Playground billing settles before DONE so the UI receives the final,
          // authoritative charge and balance. API streams keep the historical
          // behavior of completing even if asynchronous ledger settlement fails.
          if (streamCompleted && !isStreamCanceled()) {
            safeEnqueue(encoder.encode("data: [DONE]\n\n"));
          }
          safeClose();
        }
      }
    },
    cancel(reason) {
      logCancellationOnce(typeof reason === "string" ? reason : "consumer canceled stream");
      cancelStream(reason);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
