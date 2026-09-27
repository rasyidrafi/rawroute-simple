import { expect } from "bun:test";
import type { BunRequest } from "bun";

Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "public-analytics-fixture-password";
Bun.env.DATABASE_URL = `file:/tmp/opencode/rawroute-public-analytics-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-public-analytics-data-${crypto.randomUUID()}`;

const { db } = await import("./db");
const { ensureWorkspaceSchema, createWorkspace } = await import("./workspaces");
const { createGatewayKey, deleteGatewayKey, ensureGatewayKeySchema, updateGatewayKey } = await import("./gateway-keys");
const { ensureProviderSchema } = await import("./providers");
const { ensureAccountingSchema, savePricingGroup, savePricingVersion } = await import("./accounting");
const { clearPublicAnalyticsCacheForTesting } = await import("./public-analytics-cache");
const { listPublicWorkspaces, publicDashboard } = await import("./public-analytics");
const { getPublicDashboard, getPublicWorkspaces } = await import("./public-analytics-http");

await ensureWorkspaceSchema();
await ensureGatewayKeySchema();
await ensureProviderSchema();
await ensureAccountingSchema();
const first = await createWorkspace("Public first");
const second = await createWorkspace("Public second");
const now = Date.now();

async function insertEvent(workspaceId: string, attemptId: string, costMicros: number, model = "public/model") {
  await db.execute({
    sql: `INSERT INTO usage_events(id,workspace_id,attempt_id,request_id,gateway_key_id,provider_id,model_id,gateway_model_id,protocol,started_at,completed_at,duration_ms,ttft_ms,status,request_body_bytes,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_tokens,input_known,output_known,cache_read_known,cache_creation_known,cost_micros,confidence,completeness,cost_source,prediction_json,price_group_id,price_version_id,price_tier) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [`${workspaceId}:${attemptId}`, workspaceId, attemptId, "request-id-private", "durable-key-id-private", "provider-id-private", "model-id-private", model, "responses", now, now, 1, null, 200, 12, 10, 5, 0, 0, 15, 1, 1, 1, 1, costMicros, "exact", "complete", "configured-pricing", null, null, null, null],
  });
}

await insertEvent(first.id, "attempt-a", 10, "alpha/chat");
await insertEvent(second.id, "attempt-b", 30, "beta/chat");

const firstDashboard = await publicDashboard({ workspaceId: first.id, preset: "all" });
const secondDashboard = await publicDashboard({ workspaceId: second.id, preset: "all" });
expect(firstDashboard.summary.costMicros).toBe(10);
expect(secondDashboard.summary.costMicros).toBe(30);
expect(firstDashboard.models[0]).toEqual({ name: "alpha/chat", requests: 1, tokens: 15, costMicros: 10 });
expect(firstDashboard.keys[0]).toEqual({ name: "Deleted key", requests: 1, tokens: 15, costMicros: 10 });
const serialized = JSON.stringify(firstDashboard);
for (const privateValue of ["request-id-private", "durable-key-id-private", "provider-id-private", "model-id-private", "attempt-a"]) expect(serialized).not.toContain(privateValue);

const workspaces = await listPublicWorkspaces();
expect(workspaces).toContainEqual({ id: first.id, name: first.name });
expect(workspaces).toContainEqual({ id: second.id, name: second.name });
const workspaceResponse = await getPublicWorkspaces();
expect(workspaceResponse.status).toBe(200);
expect(workspaceResponse.headers.get("cache-control")).toBe("no-store");
expect(workspaceResponse.headers.get("set-cookie")).toBeNull();

const dashboardResponse = await getPublicDashboard(new Request(`http://localhost/api/public/dashboard?workspace=${first.id}&preset=all`) as BunRequest);
expect(dashboardResponse.status).toBe(200);
expect(dashboardResponse.headers.get("cache-control")).toBe("public, max-age=30, s-maxage=30");
expect(dashboardResponse.headers.get("set-cookie")).toBeNull();
expect((await dashboardResponse.json() as { summary: { costMicros: number } }).summary.costMicros).toBe(10);
for (const url of [
  "http://localhost/api/public/dashboard",
  `http://localhost/api/public/dashboard?workspace=${first.id}&preset=custom&from=2025-01-01&to=2026-01-02`,
  `http://localhost/api/public/dashboard?workspace=${first.id}&preset=custom&from=2025-02-30&to=2025-03-01`,
]) {
  const response = await getPublicDashboard(new Request(url) as BunRequest);
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

// A price mutation invalidates all cached variants for this workspace. The
// changed event is deliberately not visible until that invalidation occurs.
await db.execute({ sql: "UPDATE usage_events SET cost_micros=20 WHERE workspace_id=?", args: [first.id] });
expect((await publicDashboard({ workspaceId: first.id, preset: "all" })).summary.costMicros).toBe(10);
await db.execute({ sql: "INSERT INTO providers(id,workspace_id,name,prefix,normalized_prefix,base_url,protocol,auth_type,headers_json,support_prompt_cache_key,enabled,status,desired_revision,applied_revision,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)", args: ["provider-a", first.id, "Provider", "alpha", "alpha", "https://example.test", "openai-responses", "none", "{}", 0, 1, "active", 1, 1, now, now] });
await db.execute({ sql: "INSERT INTO provider_models(id,workspace_id,provider_id,name,gateway_suffix,gateway_model_id,upstream_model,enabled,source,reasoning_json,status,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)", args: ["model-a", first.id, "provider-a", "Alpha", "chat", "alpha/chat", "alpha-chat", 1, "custom", null, "active", now, now] });
const groupId = await savePricingGroup(first.id, { name: "Alpha", modelIds: ["model-a"] });
await savePricingVersion(first.id, { groupId, rates: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 1, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 } });
expect((await publicDashboard({ workspaceId: first.id, preset: "all" })).summary.costMicros).toBe(20);

// Key labels are part of the public aggregate only, so every key mutation must
// invalidate a cached workspace variant immediately.
const renamed = await createWorkspace("Renamed key cache");
const created = await createGatewayKey(renamed.id, "Before rename");
await insertEvent(renamed.id, "rename-event", 42);
await db.execute({ sql: "UPDATE usage_events SET gateway_key_id=? WHERE workspace_id=?", args: [created.key.id, renamed.id] });
expect((await publicDashboard({ workspaceId: renamed.id, preset: "all" })).keys[0]?.name).toBe("Before rename");
await updateGatewayKey(renamed.id, created.key.id, { name: "After rename" });
expect((await publicDashboard({ workspaceId: renamed.id, preset: "all" })).keys[0]?.name).toBe("After rename");
await deleteGatewayKey(renamed.id, created.key.id);
expect((await publicDashboard({ workspaceId: renamed.id, preset: "all" })).keys[0]?.name).toBe("Deleted key");

await db.execute({ sql: "UPDATE workspaces SET status='deleting' WHERE id=?", args: [first.id] });
clearPublicAnalyticsCacheForTesting();
const deleted = await getPublicDashboard(new Request(`http://localhost/api/public/dashboard?workspace=${first.id}`) as BunRequest);
expect(deleted.status).toBe(404);
expect((await listPublicWorkspaces()).some((workspace) => workspace.id === first.id)).toBe(false);
