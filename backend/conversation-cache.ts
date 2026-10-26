import { createHash } from "node:crypto";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ProxyPrincipal } from "./proxy-principal";
import type { ConversationBoundaryStore, StoredConversationBoundary } from "./conversation-cache-types";
import { addConverseCachePoints } from "./openai-proxy/transform/cache-converse";
import { addInvokeBodyCacheControl, type AnthropicInvokeBody } from "./openai-proxy/transform/cache-invoke";
import { finalCacheBoundary, type CacheFormat } from "./openai-proxy/transform/cache-prefix";

export const CONVERSATION_ID_HEADER = "x-conversation-id";

export class ConversationIdError extends Error {
  readonly code = "invalid_conversation_id";
  constructor(
    readonly param = "X-Conversation-ID",
    message = `${param} must be 1–128 characters using letters, digits, '.', '_', ':', or '-'`,
  ) { super(message); }
}

/** Resolve the header and optional Chat Completions body alias. Neither loads history. */
export function readConversationId(headers: Headers, conversation?: unknown): string | undefined {
  const headerId = headers.get(CONVERSATION_ID_HEADER) ?? undefined;
  const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
  if (headerId !== undefined && !valid(headerId)) throw new ConversationIdError();
  let bodyId: string | undefined;
  if (conversation !== undefined && conversation !== null) {
    const object = typeof conversation === "object" && !Array.isArray(conversation);
    const value = object ? (conversation as Record<string, unknown>).id : conversation;
    if (object && Object.keys(conversation).some(key => key !== "id")) {
      throw new ConversationIdError("conversation", "conversation must be a string or an object containing only id");
    }
    if (!valid(value)) throw new ConversationIdError(object ? "conversation.id" : "conversation");
    bodyId = value;
  }
  if (headerId !== undefined && bodyId !== undefined && headerId !== bodyId) {
    throw new ConversationIdError("conversation", "conversation and X-Conversation-ID must identify the same conversation");
  }
  return bodyId ?? headerId;
}

export interface ConversationCacheContext {
  conversationId?: string;
  principal: Pick<ProxyPrincipal, "userId" | "credentialId" | "credentialType">;
  modelId: string;
  region: string | null;
  /** Resolved model row ID prevents sharing hints after a catalog replacement. */
  modelKey: string;
}

export interface PreparedCacheRequest<T> {
  input: T;
  /** Call only once the provider has accepted the request (before settlement). */
  accepted(): Promise<void>;
}

async function defaultStore(): Promise<ConversationBoundaryStore> {
  return (await import("./conversation-cache-store")).conversationBoundaryStore;
}

/** Bound even a slow module import or unavailable metadata backend. */
async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Conversation cache metadata timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Advisory metadata only: storage outages must never block inference. */
export class ConversationCache {
  constructor(
    private readonly store: () => Promise<ConversationBoundaryStore> = defaultStore,
    private readonly now: () => number = Date.now,
    private readonly metadataTimeoutMs = 1_000,
  ) {}

  private async prepare<T>(
    context: ConversationCacheContext | undefined,
    format: CacheFormat,
    inject: (previous?: StoredConversationBoundary["boundary"]) => T,
  ): Promise<PreparedCacheRequest<T>> {
    if (!context?.conversationId) return { input: inject(), accepted: async () => {} };
    const startedAt = this.now();
    let store: ConversationBoundaryStore | undefined;
    let previous: StoredConversationBoundary | undefined;
    let key: string | undefined;
    if (context?.conversationId) {
      key = createHash("sha256").update(JSON.stringify([
        "conversation-cache-v1", context.principal.userId, context.principal.credentialType,
        context.principal.credentialId, context.conversationId, context.modelKey, context.modelId, context.region, format,
      ])).digest("hex");
      try {
        const loaded = await within((async () => {
          const backend = await this.store();
          return { backend, receipt: await backend.get(key!) };
        })(), this.metadataTimeoutMs);
        store = loaded.backend;
        previous = loaded.receipt;
        if (previous && previous.expiresAt <= startedAt) previous = undefined;
      } catch {
        store = undefined;
        console.warn("Conversation cache metadata unavailable; using stateless checkpoints");
      }
    }
    const input = inject(previous?.boundary);
    const boundary = input && typeof input === "object"
      ? finalCacheBoundary(input as ConverseCommandInput | AnthropicInvokeBody, format) : undefined;
    let committed = false;
    return {
      input,
      accepted: async () => {
        if (committed || !store || !key || !context || !boundary) return;
        committed = true;
        // Cache lifetime starts with the request, not when a long response ends.
        const expiresAt = startedAt + (boundary.ttl === "1h" ? 3_600_000 : 300_000);
        if (expiresAt <= this.now()) return;
        try {
          await within(store.put({ key, userId: context.principal.userId, expectedVersion: previous?.version ?? null, boundary, expiresAt }), this.metadataTimeoutMs);
        } catch {
          console.warn("Could not persist conversation cache boundary; inference is unaffected");
        }
      },
    };
  }

  converse(request: ConverseCommandInput, context?: ConversationCacheContext) {
    return this.prepare(context, "converse", previous => addConverseCachePoints(request, previous));
  }

  invoke(request: unknown, modelId: string, context?: ConversationCacheContext) {
    return this.prepare(context, "invoke", previous => addInvokeBodyCacheControl(request, modelId, previous));
  }
}

export const conversationCache = new ConversationCache();
