import { and, eq } from "drizzle-orm";
import db from "@/db";
import { getPublicConfig } from "./config-service";
import { handleOpenAIProxy } from "./openai-proxy/handler";
import {
  authenticateApiKeyPrincipal,
  requireProxyScope,
  type ProxyAuthResult,
} from "./proxy-auth";
import { modelsTable, userTable } from "./schema";
import { UsageValidationError } from "./usage-contract";
import { getLiteLLMDailyActivity, getNativeMonthlyUsage } from "./usage-service";

function openAIError(result: Extract<ProxyAuthResult, { ok: false }>): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (result.status === 401) headers.set("WWW-Authenticate", "Bearer");
  return Response.json({
    error: {
      message: result.message,
      type: result.status === 401 ? "authentication_error" : "permission_error",
      code: result.code,
      param: null,
    },
  }, { status: result.status, headers });
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
      owned_by: "ai-gateway",
    })),
  });
}

async function authenticatedCreditUser(request: Request) {
  const auth = requireProxyScope(await authenticateApiKeyPrincipal(request), "credits.read");
  if (!auth.ok) return { ok: false, response: openAIError(auth) } as const;
  const [user] = await db
    .select({
      balance: userTable.creditBalance,
      monthlyAllocation: userTable.defaultMonthlyCredits,
    })
    .from(userTable)
    .where(eq(userTable.id, auth.principal.userId))
    .limit(1);
  if (!user) {
    return { ok: false, response: openAIError({ ok: false, status: 401, message: "User not found", code: "invalid_api_key" }) } as const;
  }
  return { ok: true, principal: auth.principal, user } as const;
}

function usageError(error: UsageValidationError): Response {
  return Response.json({
    error: {
      message: error.message,
      type: "invalid_request_error",
      code: "invalid_usage_range",
      param: error.param,
    },
  }, { status: 400, headers: { "cache-control": "no-store" } });
}

export async function handleCredits(request: Request): Promise<Response> {
  const result = await authenticatedCreditUser(request);
  if (!result.ok) return result.response;
  return Response.json({
    object: "credit_balance",
    currency: "USD",
    balance: result.user.balance,
    monthly_allocation: result.user.monthlyAllocation,
  });
}

export async function handleUsage(request: Request): Promise<Response> {
  const result = await authenticatedCreditUser(request);
  if (!result.ok) return result.response;
  return Response.json(await getNativeMonthlyUsage({
    userId: result.principal.userId,
    balance: result.user.balance,
    monthlyAllocation: result.user.monthlyAllocation,
  }), { headers: { "cache-control": "no-store" } });
}

export async function handleLiteLLMDailyActivity(request: Request): Promise<Response> {
  const result = await authenticatedCreditUser(request);
  if (!result.ok) return result.response;
  const url = new URL(request.url);
  try {
    return Response.json(await getLiteLLMDailyActivity({
      userId: result.principal.userId,
      startDate: url.searchParams.get("start_date"),
      endDate: url.searchParams.get("end_date"),
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof UsageValidationError) return usageError(error);
    throw error;
  }
}

export async function handlePublicConfig(): Promise<Response> {
  return Response.json(await getPublicConfig(), { headers: { "cache-control": "no-store" } });
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
