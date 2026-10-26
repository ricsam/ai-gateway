import type { CacheTtl } from "./openai-proxy/transform/cache-policy";

/** Indices refer to the provider request with cache markers removed. */
export interface MessageCacheBoundary {
  messageIndex: number;
  contentIndex: number;
  prefixHash: string;
  ttl: CacheTtl;
}

export interface StoredConversationBoundary {
  version: string;
  boundary: MessageCacheBoundary;
  expiresAt: number;
}

export interface ConversationBoundaryStore {
  get(key: string): Promise<StoredConversationBoundary | undefined>;
  /** Compare-and-set: a slower request must not overwrite a newer receipt. */
  put(input: {
    key: string;
    userId: string;
    expectedVersion: string | null;
    boundary: MessageCacheBoundary;
    expiresAt: number;
  }): Promise<void>;
}
