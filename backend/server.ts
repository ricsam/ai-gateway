import { auth } from "./auth";
import { AccessDeniedError } from "./admin-guard";
import { router, UnauthorizedError } from "./router";
import { handleHeadTagRequest } from "@richie-router/server";
import { RouteNotFoundError, ValidationError } from "@richie-rpc/server";
import { headTags } from "./head-tags";
import env from "@/env";
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
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return handleHealth();
    if (url.pathname === "/readyz") return handleReady();
    if (url.pathname === "/api/config" && request.method === "GET") return handlePublicConfig();

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

    const headRequest = await handleHeadTagRequest(request, {
      headTags,
      basePath: baseUrl.pathname,
    });
    if (headRequest.matched) return headRequest.response;

    if (url.pathname.startsWith("/api/auth/")) {
      return auth.handler(request);
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
