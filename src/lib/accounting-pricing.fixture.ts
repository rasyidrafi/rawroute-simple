import { expect, test } from "bun:test";

const databasePath = `/tmp/opencode/rawroute-pricing-${crypto.randomUUID()}.db`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "pricing-fixture-password";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-pricing-${crypto.randomUUID()}`;

const workspaces = await import("./workspaces");
const providers = await import("./providers");
const accounting = await import("./accounting");
const keys = await import("./gateway-keys");
const { db } = await import("./db");

test("pricing detail returns persisted cache rates, tiers, canonical links, and a replacement job", async () => {
  await workspaces.ensureWorkspaceSchema();
  await providers.ensureProviderSchema();
  await accounting.ensureAccountingSchema();
  const workspace = await workspaces.createWorkspace(`Pricing ${crypto.randomUUID()}`);
  const provider = await providers.createProvider(workspace.id, { name: "Native", prefix: `native${Date.now()}`, baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Model", gatewaySuffix: "model", upstreamModel: "model" });
  const groupId = await accounting.savePricingGroup(workspace.id, { name: "Custom", modelIds: [model.id], canonical: { id: "openai/gpt-test", name: "GPT Test", provider: "openai" } });
  const rates = { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2, cacheReadMicrosPerMillion: 3, cacheCreationMicrosPerMillion: 4 };
  await accounting.savePricingVersion(workspace.id, { groupId, rates, tiers: [{ thresholdTokens: 128, ...rates }] });
  const replacement = await accounting.savePricingVersion(workspace.id, { groupId, rates: { ...rates, inputMicrosPerMillion: 9 }, tiers: [{ thresholdTokens: 256, ...rates }], mode: "replace" });
  const detail = await accounting.pricingAdminDetail(workspace.id);
  const group = detail.groups.find((item) => item.id === groupId)!;
  expect(group.canonical).toMatchObject({ id: "openai/gpt-test" });
  expect(group.versions[0]).toMatchObject({ cacheReadMicrosPerMillion: 3, cacheCreationMicrosPerMillion: 4 });
  expect(group.versions.some((version) => version.tiers.some((tier) => tier.thresholdTokens === 128))).toBe(true);
  expect(detail.jobs.some((job) => job.id === replacement.jobId && job.state === "queued")).toBe(true);
});

test("pricing UI sequence can move custom membership, persist fixed overrides, and apply catalog rates", async () => {
  const workspace = await workspaces.createWorkspace(`Pricing sequence ${crypto.randomUUID()}`);
  const provider = await providers.createProvider(workspace.id, { name: "Native", prefix: `sequence${Date.now()}`, baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Model", gatewaySuffix: "model", upstreamModel: "model" });
  const first = await accounting.savePricingGroup(workspace.id, { name: "First", modelIds: [model.id] });
  const second = await accounting.savePricingGroup(workspace.id, { name: "Second", modelIds: [model.id] });
  expect((await accounting.pricingAdminDetail(workspace.id)).groups.find((group) => group.id === first)?.models).toEqual([]);
  expect((await accounting.pricingAdminDetail(workspace.id)).groups.find((group) => group.id === second)?.models).toEqual([model.id]);
  const fixed = (await accounting.pricingAdminDetail(workspace.id)).groups.find((group) => group.kind === "fixed")!;
  const catalog = { id: "openai/catalog", name: "Catalog", provider: "openai", contextLimit: 128000, rates: { inputMicrosPerMillion: 11, outputMicrosPerMillion: 22, cacheReadMicrosPerMillion: 3, cacheCreationMicrosPerMillion: 4 } };
  await accounting.savePricingGroup(workspace.id, { id: fixed.id, name: "Pinned fixed", modelIds: [], canonical: catalog });
  const refreshed = (await accounting.pricingAdminDetail(workspace.id)).groups.find((group) => group.id === fixed.id)!;
  expect(refreshed.name).toBe("Pinned fixed"); expect(refreshed.models).toEqual([]); expect(refreshed.canonical).toMatchObject({ id: "openai/catalog" });
  expect(refreshed.versions[0]).toMatchObject(catalog.rates);
});

test("renaming a group with the same persisted catalog link never replaces a confirmed manual rate", async () => {
  const workspace = await workspaces.createWorkspace(`Pricing provenance ${crypto.randomUUID()}`);
  const provider = await providers.createProvider(workspace.id, { name: "Native", prefix: `provenance${Date.now()}`, baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Model", gatewaySuffix: "model", upstreamModel: "model" });
  const catalog = { id: "openai/catalog", name: "Catalog", provider: "openai", contextLimit: 128000, rates: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2, cacheReadMicrosPerMillion: 3, cacheCreationMicrosPerMillion: 4 } };
  const group = await accounting.savePricingGroup(workspace.id, { name: "Catalog group", modelIds: [model.id], canonical: catalog });
  await accounting.savePricingVersion(workspace.id, { groupId: group, rates: { ...catalog.rates, inputMicrosPerMillion: 9_000_000 } });
  await accounting.savePricingGroup(workspace.id, { id: group, name: "Renamed group", modelIds: [model.id], canonical: catalog });
  const versions = (await accounting.pricingAdminDetail(workspace.id)).groups.find((item) => item.id === group)!.versions;
  expect(versions).toHaveLength(2); expect(versions[0]).toMatchObject({ inputMicrosPerMillion: 9_000_000 });
});

test("usage DTO resolves gateway-key and model labels instead of exposing UUID-only rows", async () => {
  await keys.ensureGatewayKeySchema();
  const workspace = await workspaces.createWorkspace(`Usage labels ${crypto.randomUUID()}`);
  const key = await keys.createGatewayKey(workspace.id, "Named usage key", crypto.randomUUID());
  const provider = await providers.createProvider(workspace.id, { name: "Usage provider", prefix: `usage${Date.now()}`, baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Readable model", gatewaySuffix: "readable", upstreamModel: "readable" });
  const group = await accounting.savePricingGroup(workspace.id, { name: "Usage", modelIds: [model.id] });
  await accounting.savePricingVersion(workspace.id, { groupId: group, rates: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 1, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 } });
  await accounting.saveBudget(workspace.id, { keyId: key.key.id, limitMicros: 100 });
  const hooks = accounting.gatewayAccountingHooks(); const attempt = { attemptId: crypto.randomUUID(), requestId: crypto.randomUUID(), workspaceId: workspace.id, gatewayKeyId: key.key.id, requestedModel: model.gatewayModelId, model: { id: model.gatewayModelId, providerId: provider.id, providerPrefix: provider.prefix, name: model.name, upstreamModel: model.upstreamModel, protocol: "openai-responses", source: "custom" }, providerId: provider.id, protocol: "openai-responses", startedAt: Date.now(), requestBodyBytes: 3, payload: { max_output_tokens: 0 } } as Parameters<NonNullable<typeof hooks.beforeAttempt>>[0];
  await hooks.beforeAttempt!(attempt); await hooks.onResult!({ ...attempt, status: 200, completedAt: Date.now(), streamed: false, terminalStream: true, response: Response.json({ usage: { input_tokens: 3, output_tokens: 0 } }) });
  const usage = await accounting.usageDashboard(workspace.id, { preset: "all" });
  expect(usage.keys[0]).toMatchObject({ name: "Named usage key", budget: { limitMicros: 100, enabled: true, spentMicros: 0, remainingMicros: 100, utilization: 0 } }); expect(usage.models[0]).toMatchObject({ name: "Readable model" });
});

test("repricing updates observed input/output usage while retaining assumed cache provenance", async () => {
  const workspace = await workspaces.createWorkspace(`Reprice assumed ${crypto.randomUUID()}`);
  const provider = await providers.createProvider(workspace.id, { name: "Native", prefix: `reprice${Date.now()}`, baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Model", gatewaySuffix: "model", upstreamModel: "model" });
  const group = await accounting.savePricingGroup(workspace.id, { name: "Reprice", modelIds: [model.id] });
  const oldRates = { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 1_000_000, cacheCreationMicrosPerMillion: 1_000_000 };
  await accounting.savePricingVersion(workspace.id, { groupId: group, rates: oldRates });
  const attempt = { attemptId: crypto.randomUUID(), requestId: crypto.randomUUID(), workspaceId: workspace.id, gatewayKeyId: "unbudgeted", requestedModel: model.gatewayModelId, model: { id: model.gatewayModelId, providerId: provider.id, providerPrefix: provider.prefix, name: model.name, upstreamModel: model.upstreamModel, protocol: "openai-responses", source: "custom" }, providerId: provider.id, protocol: "openai-responses", startedAt: Date.now(), requestBodyBytes: 3, payload: { max_output_tokens: 0 } } as Parameters<NonNullable<ReturnType<typeof accounting.gatewayAccountingHooks>["beforeAttempt"]>>[0];
  const hooks = accounting.gatewayAccountingHooks(); await hooks.beforeAttempt!(attempt); await hooks.onResult!({ ...attempt, status: 200, completedAt: Date.now(), streamed: false, terminalStream: true, response: Response.json({ usage: { input_tokens: 100, output_tokens: 20 } }) });
  const before = await db.execute({ sql: "SELECT cost_micros,confidence FROM usage_events WHERE workspace_id=?", args: [workspace.id] }); expect(before.rows[0]).toMatchObject({ cost_micros: 120, confidence: "assumed" });
  const replacement = await accounting.savePricingVersion(workspace.id, { groupId: group, rates: { inputMicrosPerMillion: 10_000_000, outputMicrosPerMillion: 10_000_000, cacheReadMicrosPerMillion: 10_000_000, cacheCreationMicrosPerMillion: 10_000_000 }, mode: "replace" }); for (let index = 0; index < 8; index++) { await accounting.runPricingJobs(); const job = await db.execute({ sql: "SELECT state FROM pricing_jobs WHERE workspace_id=? AND id=?", args: [workspace.id, replacement.jobId!] }); if (job.rows[0]?.state === "completed") break; }
  const after = await db.execute({ sql: "SELECT cost_micros,confidence,cost_source FROM usage_events WHERE workspace_id=?", args: [workspace.id] }); expect(after.rows[0]).toMatchObject({ cost_micros: 1200, confidence: "assumed", cost_source: "configured-pricing" });
});
