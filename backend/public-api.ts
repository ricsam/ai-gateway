import { and, eq } from "drizzle-orm";
import db from "@/db";
import env from "@/env";
import { handleOpenAIProxy } from "./openai-proxy/handler";
import {
  authenticateApiKeyPrincipal,
  requireProxyScope,
  type ProxyAuthResult,
} from "./proxy-auth";
import { modelsTable, userTable } from "./schema";

function openAIError(result: Extract<ProxyAuthResult, { ok: false }>): Response {
  return Response.json({
    error: {
      message: result.message,
      type: result.status === 401 ? "authentication_error" : "permission_error",
      code: result.code,
      param: null,
    },
  }, {
    status: result.status,
    headers: result.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined,
  });
}

export async function handlePublicChatCompletions(request: Request): Promise<Response> {
  return handleOpenAIProxy(request, "api_key");
}

export async function handlePlaygroundChatCompletions(request: Request): Promise<Response> {
  return handleOpenAIProxy(request, "session");
}

export async function handleListModels(request: Request): Promise<Response> {
  const auth = requireProxyScope(await authenticateApiKeyPrincipal(request), "models.read");
  if (!auth.ok) return openAIError(auth);

  const models = await db
    .select({ id: modelsTable.modelId, createdAt: modelsTable.createdAt })
    .from(modelsTable)
    .where(and(eq(modelsTable.enabled, true), eq(modelsTable.provider, "bedrock")));

  return Response.json({
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(model.createdAt.getTime() / 1000),
      owned_by: "llm-proxy",
    })),
  });
}

export async function handleCredits(request: Request): Promise<Response> {
  const auth = requireProxyScope(await authenticateApiKeyPrincipal(request), "credits.read");
  if (!auth.ok) return openAIError(auth);
  const [user] = await db
    .select({
      balance: userTable.creditBalance,
      monthlyAllocation: userTable.defaultMonthlyCredits,
    })
    .from(userTable)
    .where(eq(userTable.id, auth.principal.userId))
    .limit(1);
  if (!user) {
    return openAIError({ ok: false, status: 401, message: "User not found", code: "invalid_api_key" });
  }
  return Response.json({
    object: "credit_balance",
    currency: "USD",
    balance: user.balance,
    monthly_allocation: user.monthlyAllocation,
  });
}

export function handlePublicConfig(): Response {
  return Response.json({
    brand: {
      name: env.BRAND_NAME,
      tagline: env.BRAND_TAGLINE,
      logoUrl: env.BRAND_LOGO_URL || null,
      faviconUrl: env.BRAND_FAVICON_URL || null,
      primaryColor: env.BRAND_PRIMARY_COLOR,
      primaryForegroundColor: env.BRAND_PRIMARY_FOREGROUND_COLOR,
    },
    auth: {
      mode: "oidc",
      providerId: env.OIDC_PROVIDER_ID,
      providerLabel: env.OIDC_PROVIDER_LABEL,
    },
    api: {
      baseUrl: `${env.BASE_URL}/v1`,
    },
  });
}

export function handleHealth(): Response {
  return Response.json({ status: "ok" });
}

export async function handleReady(): Promise<Response> {
  try {
    await db.executeRaw("SELECT 1");
    return Response.json({ status: "ready" });
  } catch {
    return Response.json({ status: "not_ready" }, { status: 503 });
  }
}
