import { getRuntimeAuth } from "./auth";
import { AccessDeniedError } from "./admin-guard";
import { router, UnauthorizedError } from "./router";
import { handleHeadTagRequest } from "@richie-router/server";
import { RouteNotFoundError, ValidationError } from "@richie-rpc/server";
import { headTags } from "./head-tags";
import env from "@/env";
import { getSetupStatus, handleSetup } from "./setup";
import { handleManagementApi } from "./management-api";
import { handleBrandingAsset } from "./config-service";
import { handleTrustedHeaderSignIn } from "./trusted-header-auth";
import { handleBedrockProxy, type BedrockProxyEndpoint } from "./bedrock-proxy";
import {
  handleCredits,
  handleHealth,
  handleListModels,
  handlePlaygroundChatCompletions,
  handlePublicChatCompletions,
  handlePublicConfig,
  handleReady,
} from "./public-api";

const baseUrl = new URL(env.BASE_URL);

serve({
  idleTimeout: 255,
  async fetch(request: Request, server): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return handleHealth();
    if (url.pathname === "/readyz") return handleReady();
    if (url.pathname === "/api/config" && request.method === "GET") return handlePublicConfig();
    if (url.pathname === "/api/setup") return handleSetup(request);
    if (url.pathname.startsWith("/api/branding/assets/")) return handleBrandingAsset(url.pathname);
    if (url.pathname.startsWith("/management/v1")) return handleManagementApi(request);
    const trustedHeaderMatch = url.pathname.match(/^\/api\/auth\/trusted-header\/([a-z0-9_-]+)$/i);
    if (trustedHeaderMatch && request.method === "POST") {
      const peerIp = server.requestIP(request)?.address;
      const headers = new Headers(request.headers);
      headers.delete("x-ai-gateway-peer-ip");
      if (peerIp) headers.set("x-ai-gateway-peer-ip", peerIp);
      return handleTrustedHeaderSignIn(new Request(request, { headers }), trustedHeaderMatch[1]!);
    }

    const setup = await getSetupStatus();
    const allowedBeforeSetup = url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/head-api") || url.pathname === "/setup";
    if (setup.required && !allowedBeforeSetup) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
        return Response.json({ error: { code: "setup_required", message: "Installation setup is required" } }, { status: 503 });
      }
      return Response.redirect(new URL("/setup", env.BASE_URL), 302);
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handlePublicChatCompletions(request);
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      return handleListModels(request);
    }
    if (url.pathname === "/v1/credits" && request.method === "GET") {
      return handleCredits(request);
    }
    if (url.pathname === "/api/playground/chat/completions" && request.method === "POST") {
      return handlePlaygroundChatCompletions(request);
    }
    const nativeBedrockMatch = url.pathname.match(/^\/api\/gateway\/bedrock\/(invoke|invoke-stream|converse|converse-stream)$/);
    if (nativeBedrockMatch && request.method === "POST") {
      return handleBedrockProxy(request, nativeBedrockMatch[1] as BedrockProxyEndpoint);
    }

    const headRequest = await handleHeadTagRequest(request, {
      headTags,
      basePath: baseUrl.pathname,
    });
    if (headRequest.matched) return headRequest.response;

    if (url.pathname.startsWith("/api/auth/")) {
      if (url.pathname === "/api/auth/sign-up/email") {
        return Response.json({ code: "SIGN_UP_DISABLED", message: "Public registration is disabled" }, { status: 404 });
      }
      const runtimeAuth = await getRuntimeAuth();
      const authResponse = await runtimeAuth.handler(request);
      if (url.pathname === "/api/auth/change-password" && authResponse.ok) {
        const current = await runtimeAuth.api.getSession({ headers: request.headers });
        if (current) {
          const { eq } = await import("drizzle-orm");
          const db = (await import("./db")).default;
          const { userTable } = await import("./schema");
          await db.update(userTable).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(userTable.id, current.user.id));
        }
      }
      return authResponse;
    }

    try {
      return await router.handle(request);
    } catch (error) {
      if (error instanceof ValidationError) {
        return Response.json({
          error: "Validation Error",
          field: error.field,
          issues: error.zodError.issues,
        }, { status: 400 });
      }
      if (error instanceof RouteNotFoundError) {
        return Response.json({ error: "Not Found" }, { status: 404 });
      }
      if (error instanceof UnauthorizedError) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (error instanceof AccessDeniedError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      console.error("Unhandled server error", error);
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
});
