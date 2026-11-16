import { describe, expect, test } from "bun:test";
import { handleManagementApi } from "./management-api";
import type { ManagementPrincipal } from "./management-auth";

// None of these requests reach the database: they stop at authorization or validation.
const operator = (scopes: string[]): ManagementPrincipal => ({ actorType: "cli", actorId: "aigctl@test-pod", userId: null, scopes: new Set(scopes) });
const request = (method: string, path: string, body?: unknown) => new Request(`http://gateway.test/management/v1${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});

describe("management API principals", () => {
  test("an in-process principal needs no key, session or origin", async () => {
    const response = await handleManagementApi(request("POST", "/groups", {}), { principal: operator(["*"]) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "validation_error", message: "Group name is required" });
  });

  test("an in-process principal is limited to its scopes", async () => {
    const response = await handleManagementApi(request("POST", "/groups", { name: "ops" }), { principal: operator(["groups.read"]) });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatchObject({ code: "insufficient_scope", message: "Required scope: groups.write" });
  });

  test("HTTP requests still need a key or a same-origin administrator session", async () => {
    const response = await handleManagementApi(request("POST", "/groups", { name: "ops" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("invalid_origin");
  });

  test("documents the user search", async () => {
    const response = await handleManagementApi(request("GET", "/openapi.json"));
    const document = await response.json();
    expect(document.paths["/users"].get.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(["search", "limit", "offset"]);
  });
});
