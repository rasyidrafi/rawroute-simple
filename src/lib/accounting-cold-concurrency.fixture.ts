import { expect, test } from "bun:test";

Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "cold-concurrency-password";
Bun.env.DATABASE_URL = `file:/tmp/opencode/accounting-cold-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/accounting-cold-data-${crypto.randomUUID()}`;

const accounting = await import("./accounting");
const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const keys = await import("./gateway-keys");
const routing = await import("./routing");

test("cold fixed pricing sync allows one of eight budget admissions", async () => {
  await workspaces.ensureWorkspaceSchema(); await providers.ensureProviderSchema(); await keys.ensureGatewayKeySchema(); await routing.ensureRoutingSchema(); await accounting.ensureAccountingSchema();
  const workspace = await workspaces.createWorkspace(`cold ${crypto.randomUUID()}`); const key = await keys.createGatewayKey(workspace.id, "key", crypto.randomUUID()); const provider = await providers.createProvider(workspace.id, { name: "native", prefix: `p${crypto.randomUUID().slice(0, 6)}`, baseUrl: "http://127.0.0.1:9", protocol: "openai-responses", authType: "none" }); const model = await providers.createProviderModel(workspace.id, provider.id, { name: "GPT", gatewaySuffix: "gpt-cold", upstreamModel: "gpt-cold" }); const group = await accounting.savePricingGroup(workspace.id, { name: "Rates", modelIds: [model.id] }); await accounting.savePricingVersion(workspace.id, { groupId: group, rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 } }); await accounting.saveBudget(workspace.id, { keyId: key.key.id, limitMicros: 1_500 });
  const hooks = accounting.gatewayAccountingHooks(); const make = () => ({ attemptId: crypto.randomUUID(), requestId: crypto.randomUUID(), workspaceId: workspace.id, gatewayKeyId: key.key.id, requestedModel: model.gatewayModelId, providerId: provider.id, model: { id: model.gatewayModelId, providerId: provider.id, providerPrefix: "p", name: "GPT", upstreamModel: "gpt-cold", protocol: "openai-responses", source: "configured" }, protocol: "openai-responses" as const, startedAt: Date.now(), requestBodyBytes: 10, payload: { max_output_tokens: 1_000 } });
  const attempts = Array.from({ length: 8 }, make); const admissions = await Promise.all(attempts.map((attempt) => hooks.beforeAttempt!(attempt)));
  expect(admissions.filter((value) => value === undefined)).toHaveLength(1); expect(admissions.filter((value) => value?.status === 429)).toHaveLength(7);
  const held = await db.execute({ sql: "SELECT reserved_micros FROM budget_counters WHERE workspace_id=?", args: [workspace.id] }); expect(Number(held.rows[0]?.reserved_micros)).toBe(1004);
  await Promise.all(attempts.map((attempt, index) => hooks.onResult!({ ...attempt, status: admissions[index]?.status ?? 200, completedAt: Date.now(), streamed: false, terminalStream: true, response: admissions[index] ?? Response.json({ usage: { input_tokens: 10, output_tokens: 1 } }) })));
  const events = await db.execute({ sql: "SELECT status FROM usage_events WHERE workspace_id=?", args: [workspace.id] }); expect(events.rows).toHaveLength(8); expect(events.rows.filter((row) => Number(row.status) === 429)).toHaveLength(7); await accounting.beginAccountingShutdown(); db.close();
});
