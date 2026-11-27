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

describe("model catalog endpoints", () => {
  test("reads need models.read and writes models.write", async () => {
    for (const [method, path] of [["POST", "/models"], ["PATCH", "/model-aliases/x"], ["DELETE", "/model-apps/x"]] as const) {
      const response = await handleManagementApi(request(method, path, {}), { principal: operator(["models.read"]) });
      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toBe("Required scope: models.write");
    }
    const read = await handleManagementApi(request("GET", "/model-aliases"), { principal: operator(["users.read"]) });
    expect((await read.json()).error.message).toBe("Required scope: models.read");
  });

  test("refuses unknown and invalid fields before touching the database", async () => {
    const model = await handleManagementApi(request("POST", "/models", { modelId: "x", name: "X", inputPrice: 1, outputPricePerMTok: -1 }), { principal: operator(["*"]) });
    expect(model.status).toBe(400);
    const { error } = await model.json();
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("inputPricePerMTok: Invalid input: expected number, received undefined");
    expect(error.message).toContain("outputPricePerMTok: Too small");
    expect(error.message).toContain("Unrecognized key: \"inputPrice\"");
    const alias = await handleManagementApi(request("PATCH", "/model-aliases/x", { effort: "none" }), { principal: operator(["*"]) });
    expect((await alias.json()).error.message).toStartWith("effort: Invalid option");
    const app = await handleManagementApi(request("POST", "/model-apps", { name: "Chat App" }), { principal: operator(["*"]) });
    expect((await app.json()).error.message).toBe("name: must be lowercase kebab-case, such as chat-app");
  });

  test("refuses values the database cannot hold and duplicate tier names", async () => {
    const send = async (method: string, path: string, body: unknown) => (await (await handleManagementApi(request(method, path, body), { principal: operator(["*"]) })).json()).error;
    const tooExpensive = await send("POST", "/models", { modelId: "x", name: "X", inputPricePerMTok: 1e15, outputPricePerMTok: 1 });
    expect(tooExpensive).toMatchObject({ code: "validation_error" });
    expect(tooExpensive.message).toStartWith("inputPricePerMTok: Too big");
    expect((await send("PATCH", "/models/x", { contextWindow: 3e9 })).message).toStartWith("contextWindow: Too big");
    expect((await send("PATCH", "/models/x", { maxOutputTokens: 1.5 })).message).toStartWith("maxOutputTokens: Invalid input: expected int");
    const tiers = [{ name: "max", aliasId: null }, { name: "max", aliasId: null }];
    expect(await send("POST", "/model-apps", { name: "chat-app", tiers })).toMatchObject({ code: "validation_error", message: "tiers: tier names must be unique" });
  });

  test("answers 400 for a path that isn't valid percent-encoding", async () => {
    const response = await handleManagementApi(request("GET", "/models/%E0%A4%A"), { principal: operator(["*"]) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_path");
  });

  test("documents the request bodies from the validation schemas", async () => {
    const document = await (await handleManagementApi(request("GET", "/openapi.json"))).json();
    const schema = (path: string, method: string) => document.paths[path][method].requestBody.content["application/json"].schema;
    expect(schema("/models", "post").required).toEqual(["modelId", "name", "inputPricePerMTok", "outputPricePerMTok"]);
    expect(schema("/models", "post").additionalProperties).toBe(false);
    expect(schema("/models/{id}", "patch").required).toBeUndefined();
    expect(schema("/model-aliases", "post").required).toEqual(["modelId", "name", "upstreamModelId"]);
    expect(Object.keys(schema("/model-apps", "post").properties)).toEqual(["name", "description", "enabled", "tiers"]);
    expect(Object.keys(document.paths["/model-apps/{id}"])).toEqual(["get", "patch", "delete"]);
  });
});

describe("analytics endpoints", () => {
  const get = async (path: string) => {
    const response = await handleManagementApi(request("GET", path), { principal: operator(["usage.read"]) });
    return { status: response.status, error: (await response.json()).error };
  };

  test.each([
    ["/analytics/consumed?timeRange=decade", 'Invalid time range "decade"'],
    ["/analytics/consumed?timeRange=constructor", 'Invalid time range "constructor"'],
    ["/analytics/consumed?timeRange=custom", "A custom time range requires both start and end"],
    ["/analytics/consumed?start=2026-10-01", "A custom time range requires both start and end"],
    ["/analytics/consumed?timeRange=week&start=2026-10-01&end=2026-10-08", "Use either timeRange or start and end, not both"],
    ["/analytics/consumed?start=2026-10-08&end=2026-10-01", "start must be before end"],
    ["/analytics/consumed?start=2026-10-01T09:30&end=2026-10-08", "start must be an ISO 8601 date"],
    ["/analytics/consumed?start=2016-01-01&end=2026-10-08", "A custom time range can span at most 10 years"],
    ["/analytics/consumed?start=2026-10-01&end=2026-10-04&bucketSize=5m", 'Invalid bucket size "5m" for this custom time range. Allowed: 30m, 1h, 1d'],
    ["/analytics/throughput?start=2026-10-01T00:00:00Z&end=2026-10-01T00:00:30Z", "A custom time range must span at least 1 minute"],
    [`/analytics/users?timeRange=day${Array.from({ length: 101 }, (_, index) => `&userId=u${index}`).join("")}`, "Select at most 100 users and groups together"],
  ])("refuses %s before touching the database", async (path, message) => {
    const { status, error } = await get(path);
    expect(status).toBe(400);
    expect(error.code).toBe("validation_error");
    expect(error.message).toStartWith(message);
  });

  test("documents custom windows and selections of several users and groups", async () => {
    const document = await (await handleManagementApi(request("GET", "/openapi.json"))).json();
    const names = (path: string) => document.paths[path].get.parameters.map((parameter: { $ref?: string; name?: string }) => parameter.$ref?.split("/").at(-1) ?? parameter.name);
    for (const path of ["/analytics/burndown", "/analytics/consumed", "/analytics/by-model", "/analytics/model-summary", "/analytics/tokens"])
      expect(names(path)).toEqual(expect.arrayContaining(["TimeRange", "Start", "End", "BucketSize", "UserId", "GroupId"]));
    for (const path of ["/analytics/throughput", "/analytics/users", "/analytics/groups"])
      expect(names(path)).toEqual(["TimeRange", "Start", "End", "UserId", "GroupId"]);
    const { UserId, GroupId, TimeRange } = document.components.parameters;
    for (const parameter of [UserId, GroupId]) expect(parameter).toMatchObject({ style: "form", explode: true, schema: { type: "array", items: { type: "string" } } });
    expect(TimeRange.schema.enum).toContain("custom");
    expect(document.components.schemas.ThroughputStats.properties.activeHours.type).toBe("number");
  });
});
