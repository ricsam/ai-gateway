import assert from "node:assert/strict";
import { chromium } from "playwright";
import tailwind from "bun-plugin-tailwind";
import type { PublicConfig } from "../../frontend/config";

// Exercise the real route, RPC hooks, QueryClient, and refresh button. Only the
// HTTP boundary is mocked: no database, login credentials, or AWS calls needed.
const build = await Bun.build({
  entrypoints: ["frontend/index.html"],
  target: "browser",
  tsconfig: "./frontend/tsconfig.json",
  plugins: [tailwind],
});
assert.ok(build.success, build.logs.map(String).join("\n"));
const assets = new Map(build.outputs.map((asset) => [asset.path.replace(/^\./, ""), asset]));
const index = assets.get("/index.html");
assert.ok(index, "Frontend build must produce index.html");
// Production injects the base URL too. Without it /profile becomes the API base.
const html = (await index.text()).replace("<head>", '<head><base href="/">');
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/head-api") return Response.json({ head: [] });
    if (pathname === "/profile") return new Response(html, { headers: { "Content-Type": "text/html" } });
    const asset = assets.get(pathname);
    return asset ? new Response(asset, { headers: { "Content-Type": asset.type } }) : new Response("Not found", { status: 404 });
  },
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let documents = 0;
  page.on("request", (request) => { if (request.resourceType() === "document") documents++; });

  const config: PublicConfig = {
    setup: { required: false, completedAt: "2026-10-01T00:00:00.000Z" },
    brand: { name: "AI Gateway", tagline: "", logoUrl: null, faviconUrl: null, primaryColor: "#2563eb", primaryForegroundColor: "#ffffff" },
    auth: { local: true, providers: [] },
    api: { baseUrl: `${server.url.origin}/v1`, managementBaseUrl: `${server.url.origin}/management/v1` },
  };
  const user = { id: "test-user", name: "Balance tester", email: "balance@example.test", role: "user" };
  const zeroTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, total: 0 };
  let credits = { creditBalance: 56.08, defaultMonthlyCredits: 150 };
  let revision = 0;
  const requests = new Map<string, number>();
  const unexpectedRequests: string[] = [];
  const refreshedPaths = [
    "/profile", "/usage", "/analytics/burndown", "/analytics/consumed",
    "/analytics/by-model", "/analytics/model-summary", "/analytics/tokens-consumed",
  ];

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/config") return route.fulfill({ json: config });
    if (pathname === "/api/auth/get-session") return route.fulfill({ json: {
      user,
      session: { id: "test-session", userId: user.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    } });

    const endpoint = pathname.replace(/^\/api\/router/, "");
    requests.set(endpoint, (requests.get(endpoint) ?? 0) + 1);
    const time = new Date().toISOString();
    const summary = { ...zeroTokens, inputTokens: revision * 100, total: revision * 100 };
    const payloads: Record<string, unknown> = {
      "/profile": { ...user, ...credits },
      "/api-keys": [],
      "/usage": {
        total: revision ? 1 : 0,
        logs: revision ? [{
          id: `usage-${revision}`, time, type: "usage", source: "api", description: `Refreshed usage ${revision}`, model: "test-model",
          ...zeroTokens, inputTokens: revision * 100, creditsAdded: 0, creditsConsumed: 1.96,
          balanceAfter: credits.creditBalance, inputCost: 1.96, outputCost: 0,
          cacheReadCost: 0, cacheWrite5mCost: 0, cacheWrite1hCost: 0,
        }] : [],
      },
      "/analytics/burndown": { data: [{ time, balance: credits.creditBalance }], currentBalance: credits.creditBalance },
      "/analytics/consumed": { data: [{ time, consumed: revision * 1.96 }] },
      "/analytics/by-model": { data: [], models: [] },
      "/analytics/model-summary": { models: [] },
      "/analytics/tokens-consumed": { data: [{ time, ...summary }], summary },
    };
    if (!(endpoint in payloads)) {
      unexpectedRequests.push(pathname);
      return route.fulfill({ status: 500, json: { error: "Unexpected browser test request" } });
    }
    return route.fulfill({ json: payloads[endpoint] });
  });

  await page.goto(`${server.url.origin}/profile`);
  const creditsCard = page.locator('[data-slot="card"]').filter({ has: page.getByText("Current balance", { exact: true }) });
  const tokenCard = page.locator('[data-slot="card"]').filter({ has: page.getByText("Total tokens", { exact: true }) });
  await creditsCard.getByText("$56.08", { exact: true }).waitFor();
  await creditsCard.getByText("$150.00", { exact: true }).waitFor();
  await page.getByText("No usage history yet", { exact: true }).waitFor();
  for (const path of [...refreshedPaths, "/api-keys"]) assert.equal(requests.get(path), 1, `Initial fetch of ${path}`);

  // A fresh query is cached for five minutes. Refresh must bypass that freshness
  // for profile credits as well as plots/usage, without navigating or losing edits.
  const keyName = page.getByPlaceholder("Key name");
  await keyName.fill("Keep this unsaved draft");
  const refresh = page.getByRole("button", { name: "Refresh analytics data" });
  for (const next of [
    { creditBalance: 54.12, defaultMonthlyCredits: 175 },
    { creditBalance: 0, defaultMonthlyCredits: 0 },
  ]) {
    credits = next;
    revision++;
    const responses = refreshedPaths.map((path) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/router${path}` && response.ok())
      .catch((cause) => { throw new Error(`Refresh did not refetch ${path}`, { cause }); }));
    await Promise.all([refresh.click(), ...responses]);
    // Scope to each label so a zero balance cannot be confused with allocation.
    await creditsCard.getByText("Current balance", { exact: true }).locator("..")
      .getByText(`$${next.creditBalance.toFixed(2)}`, { exact: true }).waitFor();
    await creditsCard.getByText("Monthly allocation", { exact: true }).locator("..")
      .getByText(`$${next.defaultMonthlyCredits.toFixed(2)}`, { exact: true }).waitFor();
    await page.getByText(`Refreshed usage ${revision}`, { exact: true }).waitFor();
    await tokenCard.getByText("Total tokens", { exact: true }).locator("..")
      .getByText(String(revision * 100), { exact: true }).waitFor();
    for (const path of refreshedPaths) assert.equal(requests.get(path), revision + 1, `Refresh fetch of ${path}`);
    assert.equal(requests.get("/api-keys"), 1, "Refresh must not fetch unrelated API keys");
    assert.equal(await keyName.inputValue(), "Keep this unsaved draft");
    assert.equal(documents, 1, "Refresh must not reload or navigate");
    assert.equal(page.url(), `${server.url.origin}/profile`);
  }
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(errors, []);
  console.log("PASS: profile balance, allocation, analytics, and usage refresh in place (including zero balances)");
} finally {
  try { await browser?.close(); } finally { await server.stop(true); }
}
