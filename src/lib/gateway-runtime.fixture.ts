import { afterAll, beforeAll, expect, test } from "bun:test";

const databasePath = `/tmp/opencode/rawroute-gateway-runtime-${crypto.randomUUID()}.db`;
const dataDir = `/tmp/opencode/rawroute-gateway-runtime-data-${crypto.randomUUID()}`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "gateway-runtime-password";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = dataDir;

const upstreamRequests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    upstreamRequests.push({ headers: request.headers, body });
    if (body.model === "first-upstream") return Response.json({ error: { code: "model_cooldown", message: "cooldown is still active" } }, { status: 429, headers: { "retry-after": "999" } });
    if (body.model === "stream-upstream") return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n")); setTimeout(() => { controller.enqueue(new TextEncoder().encode("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")); controller.close(); }, 5); } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ id: "resp_fixture", output: [{ content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 2, output_tokens: 1 } });
  },
});
const upstreamUrl = `http://127.0.0.1:${upstream.port}`;

// Import the real modules only after the isolated DATABASE_URL is installed.
const workspaces = await import("./workspaces");
const keys = await import("./gateway-keys");
const providers = await import("./providers");
const routing = await import("./routing");
const gateway = await import("./gateway-http");

beforeAll(async () => {
  // Workspace schema creates the default active workspace without auth setup.
  await workspaces.ensureWorkspaceSchema();
  await keys.ensureGatewayKeySchema();
  await providers.ensureProviderSchema();
  await routing.ensureRoutingSchema();
});
afterAll(() => upstream.stop(true));

function request(path: string, key: string, body?: Record<string, unknown>, extra: HeadersInit = {}): Request {
  return new Request(`http://gateway.test${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}`, "x-rawroute-workspace-id": "attacker-controlled", ...(body ? { "content-type": "application/json" } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("native execution stays available without CLIProxy and never forwards the gateway key", async () => {
  const workspace = await workspaces.createWorkspace(`Gateway ${crypto.randomUUID()}`);
  const key = await keys.createGatewayKey(workspace.id, "gateway", "K".repeat(32));
  const first = await providers.createProvider(workspace.id, { name: "First", prefix: `first${Date.now()}`, baseUrl: upstreamUrl, protocol: "openai-responses", authType: "bearer", headers: { "x-static": "fixture" }, supportPromptCacheKey: true });
  await providers.createProviderCredential(workspace.id, first.id, { name: "provider", key: "provider-secret" });
  const firstModel = await providers.createProviderModel(workspace.id, first.id, { name: "First", gatewaySuffix: "first", upstreamModel: "first-upstream" });
  const second = await providers.createProvider(workspace.id, { name: "Second", prefix: `second${Date.now()}`, baseUrl: upstreamUrl, protocol: "openai-responses", authType: "bearer" });
  await providers.createProviderCredential(workspace.id, second.id, { name: "provider", key: "second-secret" });
  const secondModel = await providers.createProviderModel(workspace.id, second.id, { name: "Second", gatewaySuffix: "second", upstreamModel: "second-upstream" });
  const stream = await providers.createProviderModel(workspace.id, second.id, { name: "Stream", gatewaySuffix: "stream", upstreamModel: "stream-upstream" });
  await routing.createRoutingAlias(workspace.id, { alias: "friendly", targetModelId: secondModel.gatewayModelId });
  await routing.createRoutingCombo(workspace.id, { combo: "fallback", name: "Fallback", members: [{ target: firstModel.gatewayModelId }, { target: "friendly" }] });

  const catalog = await gateway.gatewayRequest(request("/v1/models", key.secret) as import("bun").BunRequest);
  expect(catalog.status).toBe(200);
  expect((await catalog.json() as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual(expect.arrayContaining([firstModel.gatewayModelId, "friendly", "fallback"]));

  const response = await gateway.gatewayRequest(request("/v1/chat/completions", key.secret, { model: "friendly", messages: [{ role: "user", content: "hi" }], max_tokens: 9 }) as import("bun").BunRequest);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "OK" } }] });
  const native = upstreamRequests.at(-1)!;
  expect(native.body).toMatchObject({ model: "second-upstream", input: [{ role: "user", content: "hi" }], max_output_tokens: 9 });
  expect(native.headers.get("authorization")).toBe("Bearer second-secret");
  expect(native.headers.get("x-api-key")).toBeNull();
  expect(JSON.stringify([...native.headers])).not.toContain(key.secret);

  const fallback = await gateway.gatewayRequest(request("/v1/responses", key.secret, { model: "fallback", input: "hi" }) as import("bun").BunRequest);
  expect(fallback.status).toBe(200);
  expect(upstreamRequests.slice(-2).map((entry) => entry.body.model)).toEqual(["first-upstream", "second-upstream"]);

  const streamed = await gateway.gatewayRequest(request("/v1/chat/completions", key.secret, { model: stream.gatewayModelId, messages: [{ role: "user", content: "hi" }], stream: true }) as import("bun").BunRequest);
  expect(streamed.headers.get("content-type")).toContain("text/event-stream");
  const reader = streamed.body!.getReader();
  const firstChunk = await reader.read();
  expect(new TextDecoder().decode(firstChunk.value)).toContain("chat.completion.chunk");
  await reader.cancel();

  const projected = await providers.createProvider(workspace.id, { name: "Projected", prefix: `projected${Date.now()}`, baseUrl: "https://projected.invalid/v1", protocol: "openai-chat", authType: "none" });
  const projectedModel = await providers.createProviderModel(workspace.id, projected.id, { name: "Projected", gatewaySuffix: "gemini", upstreamModel: "gemini-upstream" });
  let forwardedUrl = "";
  const restore = (await import("./gateway-runtime")).setGatewayRuntimeDependenciesForTesting({ getStatus: async () => ({ healthy: true } as never), getProviderSync: async () => ({ state: "applied", appliedRevision: (await providers.getProviderDetail(workspace.id, projected.id))!.desiredRevision } as never), cliproxyKey: () => "private-cliproxy", fetch: (async (url) => { forwardedUrl = String(url); return Response.json({ ok: true }); }) as typeof fetch });
  try {
    const foreignPath = encodeURIComponent("rr-ws-foreign/secret");
    const denied = await gateway.gatewayRequest(request(`/v1beta/models/${foreignPath}:generateContent`, key.secret, { contents: [{ role: "user", parts: [{ text: "hi" }] }] }) as import("bun").BunRequest);
    expect(denied.status).toBe(400);
    const gemini = await gateway.gatewayRequest(request(`/v1beta/models/${encodeURIComponent(projectedModel.gatewayModelId)}:generateContent`, key.secret, { contents: [{ role: "user", parts: [{ text: "hi" }] }] }) as import("bun").BunRequest);
    expect(gemini.status).toBe(200);
    expect(forwardedUrl).toContain(encodeURIComponent(`rr-ws-`));
    expect(forwardedUrl).not.toContain(encodeURIComponent(projectedModel.gatewayModelId));
  } finally { restore(); }
});
