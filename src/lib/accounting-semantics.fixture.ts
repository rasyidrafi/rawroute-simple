Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "accounting-semantics-password";
Bun.env.DATABASE_URL = `file:/tmp/opencode/accounting-semantics-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/accounting-semantics-data-${crypto.randomUUID()}`;
export {};

const accounting = await import("./accounting");
const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const keys = await import("./gateway-keys");
const routing = await import("./routing");
await workspaces.ensureWorkspaceSchema(); await providers.ensureProviderSchema(); await keys.ensureGatewayKeySchema(); await routing.ensureRoutingSchema(); await accounting.ensureAccountingSchema();
const workspace = await workspaces.createWorkspace("Accounting semantics");
const key = await keys.createGatewayKey(workspace.id, "key", crypto.randomUUID());
const provider = await providers.createProvider(workspace.id, { name: "native", prefix: "native", baseUrl: "http://127.0.0.1:9", protocol: "openai-responses", authType: "none" });
const model = await providers.createProviderModel(workspace.id, provider.id, { name: "GPT", gatewaySuffix: "gpt-predict", upstreamModel: "gpt-predict" });
const group = await accounting.savePricingGroup(workspace.id, { name: "Custom", modelIds: [model.id] });
await accounting.savePricingVersion(workspace.id, { groupId: group, rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 } });
const hooks = accounting.gatewayAccountingHooks();
function attempt(bytes: number, requestedModel = model.gatewayModelId, comboMember = false) { return { attemptId: crypto.randomUUID(), requestId: crypto.randomUUID(), workspaceId: workspace.id, gatewayKeyId: key.key.id, requestedModel, providerId: provider.id, model: { id: model.gatewayModelId, providerId: provider.id, providerPrefix: "native", name: "GPT", upstreamModel: "gpt-predict", protocol: "openai-responses", source: "configured" }, protocol: "openai-responses" as const, startedAt: Date.now(), requestBodyBytes: bytes, payload: { max_output_tokens: 1_000 }, comboMember }; }
async function settle(value: ReturnType<typeof attempt>, usage?: { input_tokens: number; output_tokens: number }) { await hooks.beforeAttempt!(value); await hooks.onResult!({ ...value, status: 200, completedAt: Date.now(), streamed: false, terminalStream: true, response: Response.json(usage ? { usage } : {}) }); }
// Seed exact payload samples without any enabled budget, then ensure a no-usage
// success is p50 priced rather than being silently recorded as zero.
for (const [bytes, input, output] of [[1_000, 100, 10], [2_000, 200, 20], [3_000, 300, 30]] as const) await settle(attempt(bytes), { input_tokens: input, output_tokens: output });
const missing = attempt(2_000); await settle(missing);
const prediction = await db.execute({ sql: "SELECT cost_micros,confidence,cost_source,prediction_json FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [workspace.id, missing.attemptId] });
if (Number(prediction.rows[0]?.cost_micros) !== 220 || prediction.rows[0]?.confidence !== "assumed" || !String(prediction.rows[0]?.cost_source).includes("p50-settlement:key-model-protocol") || !String(prediction.rows[0]?.prediction_json).includes("sampleCount")) throw new Error(`p50 settlement prediction failed: ${JSON.stringify(prediction.rows)}`);
await accounting.saveBudget(workspace.id, { keyId: key.key.id, limitMicros: 1_000_000 }); const reserved = attempt(2_000); await settle(reserved);
const reservation = await db.execute({ sql: "SELECT cost_source,prediction_json FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [workspace.id, reserved.attemptId] });
if (!String(reservation.rows[0]?.cost_source).includes("p75-reservation") || !String(reservation.rows[0]?.prediction_json).includes("reservation")) throw new Error(`p75 reservation provenance was lost: ${JSON.stringify(reservation.rows)}`);
await accounting.deleteBudget(workspace.id, key.key.id);
// Policy can name the resolved model even when the public request used an alias.
await accounting.setUnlimited(workspace.id, true, false); await accounting.saveBudgetSettings(workspace.id, { exclusions: [model.gatewayModelId] });
const excluded = await hooks.beforeAttempt!(attempt(10, "friendly-alias"));
const memberExcluded = await hooks.beforeAttempt!(attempt(10, "combo-route", true));
if (excluded?.status !== 403 || memberExcluded?.headers.get("x-rawroute-combo-member-unavailable") !== "1") throw new Error("resolved exclusion policy did not reject alias/combo member");
await accounting.setUnlimited(workspace.id, false, false); await accounting.setUnlimited(workspace.id, true, false); await accounting.setUnlimited(workspace.id, true, true);
const admin = await accounting.getBudgetAdmin(workspace.id);
if (!admin.window.autoEnd || !admin.window.activeSessionId || !admin.unlimited.autoEnd) throw new Error("active unlimited auto-end was not persisted");
await accounting.setUnlimited(workspace.id, false, false);
const second = await providers.createProviderModel(workspace.id, provider.id, { name: "Second", gatewaySuffix: "second", upstreamModel: "second" });
await routing.createRoutingAlias(workspace.id, { alias: "excluded-alias", targetModelId: model.gatewayModelId });
await routing.createRoutingCombo(workspace.id, { combo: "chain", name: "Chain", members: [{ target: "excluded-alias" }, { target: second.gatewayModelId }] });
await accounting.setUnlimited(workspace.id, true, false); await accounting.saveBudgetSettings(workspace.id, { exclusions: ["excluded-alias"] });
const runtime = await import("./gateway-runtime"); let sent: string[] = [];
const restore = runtime.setGatewayRuntimeDependenciesForTesting({ hooks, fetch: (async (_url, init) => { sent.push(String(JSON.parse(String(init?.body)).model)); return Response.json({ id: "ok", output: [], usage: { input_tokens: 1, output_tokens: 1 } }); }) as typeof fetch });
const comboResponse = await runtime.proxyGatewayInference(new Request("http://gateway/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chain", input: "hi" }) }), workspace.id, key.key.id);
restore(); if (comboResponse.status !== 200 || sent.length !== 1 || sent[0] !== "second") throw new Error(`excluded alias combo member was not skipped: ${comboResponse.status} ${sent}`);
await accounting.setUnlimited(workspace.id, false, false);
const projected = await providers.createProvider(workspace.id, { name: "projected", prefix: "p", baseUrl: "https://example.invalid", protocol: "openai-chat", authType: "none" }); const projectedModel = await providers.createProviderModel(workspace.id, projected.id, { name: "Projected", gatewaySuffix: "x", upstreamModel: "x" }); let measured = 0, wire = 0;
const restoreProjected = runtime.setGatewayRuntimeDependenciesForTesting({ getStatus: async () => ({ healthy: true } as never), getProviderSync: async () => ({ state: "applied", appliedRevision: (await providers.getProviderDetail(workspace.id, projected.id))!.desiredRevision } as never), cliproxyKey: () => "test", hooks: { beforeAttempt: async (value) => { measured = value.requestBodyBytes; return undefined; } }, fetch: (async (_url, init) => { wire = new TextEncoder().encode(String(init?.body)).byteLength; return Response.json({ choices: [] }); }) as typeof fetch });
await runtime.proxyGatewayInference(new Request("http://gateway/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: projectedModel.gatewayModelId, messages: [{ role: "user", content: "hi" }] }) }), workspace.id, key.key.id); restoreProjected();
if (measured !== wire) throw new Error(`accounting measured ${measured} bytes but provider received ${wire}`);
// Budget reporting must respect its exact instant endpoints rather than expand
// either side to calendar days.
const base = Date.now() + 10_000; const before = attempt(100); await settle(before, { input_tokens: 1, output_tokens: 0 }); const inside = attempt(100); await settle(inside, { input_tokens: 2, output_tokens: 0 });
await db.execute({ sql: "UPDATE usage_events SET completed_at=? WHERE workspace_id=? AND attempt_id=?", args: [base - 1, workspace.id, before.attemptId] });
await db.execute({ sql: "UPDATE usage_events SET completed_at=? WHERE workspace_id=? AND attempt_id=?", args: [base + 1, workspace.id, inside.attemptId] });
await accounting.saveBudgetWindow(workspace.id, { startAt: base, endAt: base + 2 });
const budgetUsage = await accounting.budgetUsageDashboard(workspace.id);
if (budgetUsage.summary.requests !== 1 || budgetUsage.summary.tokens !== 2) throw new Error(`budget instant window leaked events: ${JSON.stringify(budgetUsage.summary)}`);
await db.execute({ sql: "INSERT INTO routing_aliases(id,workspace_id,alias,normalized_alias,target_model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", args: [crypto.randomUUID(), workspace.id, "friendly-alias", "friendly-alias", model.id, Date.now(), Date.now()] });
await db.execute({ sql: "INSERT INTO routing_combos(id,workspace_id,combo,normalized_combo,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", args: [crypto.randomUUID(), workspace.id, "friendly-combo", "friendly-combo", "Friendly combo", Date.now(), Date.now()] });
const options = await accounting.getBudgetAdminDetail(workspace.id);
if (!options.modelOptions.some((option) => option.id === "friendly-alias" && option.type === "alias") || !options.modelOptions.some((option) => option.id === "friendly-combo" && option.type === "combo")) throw new Error("budget policy options omitted enabled routes");
await accounting.beginAccountingShutdown(); db.close();
