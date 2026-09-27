import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const databasePath = `/tmp/opencode/rawroute-model-shares-${crypto.randomUUID()}.db`;
Bun.env.NODE_ENV = "development";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-model-shares-data-${crypto.randomUUID()}`;

const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const routing = await import("./routing");
const shares = await import("./model-shares");
const keys = await import("./gateway-keys");
const accounting = await import("./accounting");
const gateway = await import("./gateway-http");
const runtime = await import("./gateway-runtime");
const codex = await import("./codex");
const management = await import("./cliproxy/management");
let unregisterDeletion: (() => void) | undefined;
let codexFiles: Array<Record<string, unknown>> = [];
const restoreManagement = management.setCliproxyManagementTransportForTesting(async (path) => {
  if (path === "/v0/management/auth-files") return Response.json({ files: codexFiles });
  return Response.json({ error: "unexpected management request" }, { status: 500 });
});

beforeAll(async () => {
  await workspaces.ensureWorkspaceSchema();
  await providers.ensureProviderSchema();
  await routing.ensureRoutingSchema();
  await shares.ensureModelShareSchema();
  await keys.ensureGatewayKeySchema();
  await accounting.ensureAccountingSchema();
  await codex.ensureCodexSchema();
  unregisterDeletion = workspaces.registerWorkspaceDeletionExtension({ name: "model-share-fixture-cleanup", deleteWorkspaceData: async (workspaceId) => { await shares.deleteModelSharesForWorkspace(workspaceId); await routing.deleteRoutingForWorkspace(workspaceId); await accounting.deleteAccountingForWorkspace(workspaceId); await keys.deleteGatewayKeysForWorkspace(workspaceId); await providers.deleteProvidersForWorkspace(workspaceId); } });
});
beforeEach(async () => {
  await db.batch([
    "DELETE FROM model_shares", "DELETE FROM routing_combo_members", "DELETE FROM routing_combos", "DELETE FROM routing_aliases", "DELETE FROM usage_events", "DELETE FROM accounting_attempts", "DELETE FROM accounting_settlement_queue", "DELETE FROM accounting_settlement_fallback", "DELETE FROM model_pricing_tiers", "DELETE FROM model_pricing_versions", "DELETE FROM model_pricing_memberships", "DELETE FROM model_pricing_groups", "DELETE FROM gateway_keys",
    "DELETE FROM provider_credentials", "DELETE FROM provider_models", "DELETE FROM providers", "DELETE FROM codex_quota_cache", "DELETE FROM codex_login_lease", "DELETE FROM codex_logins", "DELETE FROM codex_accounts", "DELETE FROM workspaces WHERE id <> 'default'",
  ], "write");
  codexFiles = [];
});
afterAll(async () => { restoreManagement(); unregisterDeletion?.(); await db.close(); });

test("a recipient can resolve only an explicit active grant and an alias keeps the stable source model binding across a prefix rename", async () => {
  const recipient = await workspaces.createWorkspace("Recipient sharing");
  const provider = await providers.createProvider("default", { name: "Owner", prefix: "owner", baseUrl: "https://owner.test", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel("default", provider.id, { name: "Owned", gatewaySuffix: "model", upstreamModel: "upstream" });
  const [grant] = await shares.setModelShareTargets("default", model.id, [recipient.id]);
  expect(grant.recipientWorkspaceId).toBe(recipient.id);
  const incoming = await shares.listIncomingModelShares(recipient.id);
  expect(incoming).toMatchObject([{ id: grant.id, qualifiedModelId: `default/${model.gatewayModelId}`, status: "active" }]);
  await expect(routing.createRoutingAlias(recipient.id, { alias: "stolen", targetModelId: `default/${model.gatewayModelId}` })).rejects.toMatchObject({ status: 400 });
  const alias = await routing.createRoutingAlias(recipient.id, { alias: "shared", targetModelId: incoming[0]!.qualifiedModelId, shareId: grant.id });
  expect((await routing.resolveRoutingModel(recipient.id, "shared"))?.model?.shared?.grantId).toBe(grant.id);
  await providers.updateProvider("default", provider.id, { prefix: "renamed" });
  const updated = (await routing.listRouting(recipient.id)).aliases.find((entry) => entry.id === alias.id)!;
  expect(updated.targetModelId).toBe(`default/renamed/model`);
  expect((await routing.resolveRoutingModel(recipient.id, "shared"))?.model?.id).toBe("renamed/model");
  await shares.setModelShareTargets("default", model.id, []);
  expect(await routing.resolveRoutingModel(recipient.id, "shared")).toBeUndefined();
  expect(await routing.resolveRoutingModel(recipient.id, `default/renamed/model`)).toBeUndefined();
});

test("grants are recipient-scoped; a disabled source preserves existing selection but cannot add a recipient", async () => {
  const recipient = await workspaces.createWorkspace("Recipient one");
  const attacker = await workspaces.createWorkspace("Recipient two");
  const provider = await providers.createProvider("default", { name: "Owner", prefix: "secure", baseUrl: "https://owner.test", protocol: "openai-chat", authType: "none" });
  const model = await providers.createProviderModel("default", provider.id, { name: "Owned", gatewaySuffix: "model", upstreamModel: "upstream" });
  const [grant] = await shares.setModelShareTargets("default", model.id, [recipient.id]);
  expect(await shares.resolveSharedModelForRecipient(attacker.id, grant.id)).toBeUndefined();
  await providers.updateProviderModel("default", provider.id, model.id, { enabled: false });
  await expect(shares.setModelShareTargets("default", model.id, [recipient.id])).resolves.toHaveLength(1);
  await expect(shares.setModelShareTargets("default", model.id, [recipient.id, attacker.id])).rejects.toMatchObject({ status: 400 });
  expect((await shares.listShareTargets("default", model.id)).find((target) => target.id === recipient.id)).toMatchObject({ shared: true, available: false, status: "unavailable" });
});

test("Default is a valid active recipient and an explicit null shareId retargets an alias locally", async () => {
  const owner = await workspaces.createWorkspace("Retarget owner"); const recipient = await workspaces.createWorkspace("Retarget recipient");
  const provider = await providers.createProvider(owner.id, { name: "Owner", prefix: "retarget-owner", baseUrl: "https://owner.test", protocol: "openai-chat", authType: "none" });
  const source = await providers.createProviderModel(owner.id, provider.id, { name: "Source", gatewaySuffix: "source", upstreamModel: "source" });
  const localProvider = await providers.createProvider(recipient.id, { name: "Local", prefix: "retarget-local", baseUrl: "https://local.test", protocol: "openai-chat", authType: "none" });
  const local = await providers.createProviderModel(recipient.id, localProvider.id, { name: "Local", gatewaySuffix: "local", upstreamModel: "local" });
  await expect(shares.setModelShareTargets(owner.id, source.id, ["default", recipient.id])).resolves.toHaveLength(2);
  const grant = (await shares.listIncomingModelShares(recipient.id))[0]!;
  const alias = await routing.createRoutingAlias(recipient.id, { alias: "retarget", targetModelId: grant.qualifiedModelId, shareId: grant.id });
  const updated = await routing.updateRoutingAlias(recipient.id, alias.id, { targetModelId: local.gatewayModelId, shareId: null });
  expect(updated.shareId).toBeUndefined(); expect((await routing.resolveRoutingModel(recipient.id, "retarget"))?.model?.id).toBe(local.gatewayModelId);
});

test("a recipient key executes through the owner transport and settles a priced owner event plus a zero-cost consumer mirror", async () => {
  const recipient = await workspaces.createWorkspace("Metered recipient");
  const recipientKey = await keys.createGatewayKey(recipient.id, "recipient", "R".repeat(32));
  const provider = await providers.createProvider("default", { name: "Owner", prefix: "bill", baseUrl: "https://owner.test", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel("default", provider.id, { name: "Billable", gatewaySuffix: "model", upstreamModel: "owner-upstream" });
  const [grant] = await shares.setModelShareTargets("default", model.id, [recipient.id]);
  await routing.createRoutingAlias(recipient.id, { alias: "shared", targetModelId: `default/${model.gatewayModelId}`, shareId: grant.id });
  await accounting.saveBudget("default", { keyId: `shared-workspace:${recipient.id}`, limitMicros: 100 });
  await accounting.deleteBudget("default", `shared-workspace:${recipient.id}`);
  const group = await accounting.savePricingGroup("default", { name: "Owner rates", modelIds: [model.id] });
  await accounting.savePricingVersion("default", { groupId: group, rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 } });
  let sent = "";
  const restore = runtime.setGatewayRuntimeDependenciesForTesting({ hooks: accounting.gatewayAccountingHooks(), fetch: (async (_url, init) => { sent = String(JSON.parse(String(init?.body)).model); return Response.json({ id: "ok", output: [], usage: { input_tokens: 2, output_tokens: 3 } }); }) as typeof fetch });
  try {
    const response = await gateway.gatewayRequest(new Request("http://gateway.test/v1/responses", { method: "POST", headers: { authorization: `Bearer ${recipientKey.secret}`, "content-type": "application/json", "x-rawroute-workspace-id": "default" }, body: JSON.stringify({ model: "shared", input: "hi" }) }) as import("bun").BunRequest);
    expect(response.status).toBe(200);
  } finally { restore(); }
  expect(sent).toBe("owner-upstream");
  const owner = await db.execute({ sql: "SELECT gateway_key_id,cost_micros FROM usage_events WHERE workspace_id='default'" });
  const consumer = await db.execute({ sql: "SELECT gateway_key_id,cost_micros FROM usage_events WHERE workspace_id=?", args: [recipient.id] });
  expect(owner.rows).toMatchObject([{ gateway_key_id: `shared-workspace:${recipient.id}`, cost_micros: 5 }]);
  expect(consumer.rows).toMatchObject([{ gateway_key_id: recipientKey.key.id, cost_micros: 0 }]);
});

test("owner deletion waits for a shared snapshot and removes accounting handoff after the admitted request drains", async () => {
  const owner = await workspaces.createWorkspace("Deleting owner"); const recipient = await workspaces.createWorkspace("Deleting recipient");
  const key = await keys.createGatewayKey(recipient.id, "recipient", "D".repeat(32));
  const provider = await providers.createProvider(owner.id, { name: "Owner", prefix: "delete-owner", baseUrl: "https://owner.test", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(owner.id, provider.id, { name: "Model", gatewaySuffix: "model", upstreamModel: "owner-upstream" });
  const [grant] = await shares.setModelShareTargets(owner.id, model.id, [recipient.id]); await routing.createRoutingAlias(recipient.id, { alias: "shared-delete", targetModelId: `${owner.id}/${model.gatewayModelId}`, shareId: grant.id });
  let enter!: () => void; let resume!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }); const paused = new Promise<void>((resolve) => { resume = resolve; }); let fetches = 0;
  const restore = runtime.setGatewayRuntimeDependenciesForTesting({ hooks: accounting.gatewayAccountingHooks(), getProviderSnapshot: async (workspaceId, providerId) => { const snapshot = await providers.getProviderProjectionSnapshot(workspaceId, providerId); enter(); await paused; return snapshot; }, fetch: (async () => { fetches++; return Response.json({ id: "ok", output: [], usage: { input_tokens: 1, output_tokens: 1 } }); }) as unknown as typeof fetch });
  try {
    const request = new Request("http://gateway.test/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "shared-delete", input: "hi" }) });
    const pending = gateway.gatewayRequest(request as import("bun").BunRequest); await entered;
    const deleting = workspaces.deleteWorkspace(owner.id, owner.name); expect(await Promise.race([deleting.then(() => "deleted"), Bun.sleep(30).then(() => "draining")])).toBe("draining");
    resume(); expect((await pending).status).toBe(400); await deleting;
    expect(fetches).toBe(0); expect((await db.execute({ sql: "SELECT attempt_id FROM accounting_attempts WHERE workspace_id=?", args: [owner.id] })).rows).toHaveLength(0);
  } finally { restore(); }
});

test("an enabled built-in Codex model shares only through its live owner prefix, including native and streaming requests", async () => {
  const owner = await workspaces.createWorkspace("Codex owner");
  const recipient = await workspaces.createWorkspace("Codex recipient");
  const recipientKey = await keys.createGatewayKey(recipient.id, "recipient", "C".repeat(32));
  await codex.ensureCodexProvider(owner.id);
  const model = (await codex.listCodexModels(owner.id)).find((item) => item.enabled)!;
  const accountId = crypto.randomUUID(), authFile = "codex-owner.json", prefix = codex.codexWorkspacePrefix(owner.id), now = Date.now();
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [accountId, owner.id, "Owner only", authFile, "owner-index", prefix, 1, 1, now, now] });
  codexFiles = [{ name: authFile, type: "codex", auth_index: "owner-index", prefix }];
  const [grant] = await shares.setModelShareTargets(owner.id, model.id, [recipient.id]);
  const incoming = await shares.listIncomingModelShares(recipient.id);
  expect(incoming).toMatchObject([{ id: grant.id, status: "active", qualifiedModelId: `${owner.id}/${model.gatewayModelId}` }]);
  await routing.createRoutingAlias(recipient.id, { alias: "owner-codex", targetModelId: incoming[0]!.qualifiedModelId, shareId: grant.id });
  const pricing = await accounting.savePricingGroup(owner.id, { name: "Codex owner rates", modelIds: [model.id] });
  await accounting.savePricingVersion(owner.id, { groupId: pricing, rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 } });
  expect(await routing.resolveRoutingModel(recipient.id, model.gatewayModelId)).toBeUndefined();
  const seen: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const restore = runtime.setGatewayRuntimeDependenciesForTesting({
    hooks: accounting.gatewayAccountingHooks(), getStatus: async () => ({ healthy: true } as never), cliproxyKey: () => "private-cliproxy-key",
    fetch: (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ url: String(url), body, authorization: new Headers(init?.headers).get("authorization") });
      if (body.stream) return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}\n\n')); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "response", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 2, output_tokens: 3 } });
    }) as typeof fetch,
  });
  try {
    const chat = await gateway.gatewayRequest(new Request("http://gateway.test/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${recipientKey.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "owner-codex", messages: [{ role: "user", content: "hi" }] }) }) as import("bun").BunRequest);
    const responses = await gateway.gatewayRequest(new Request("http://gateway.test/v1/responses", { method: "POST", headers: { authorization: `Bearer ${recipientKey.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "owner-codex", input: "hi" }) }) as import("bun").BunRequest);
    const messages = await gateway.gatewayRequest(new Request("http://gateway.test/v1/messages", { method: "POST", headers: { authorization: `Bearer ${recipientKey.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "owner-codex", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) }) as import("bun").BunRequest);
    const stream = await gateway.gatewayRequest(new Request("http://gateway.test/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${recipientKey.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "owner-codex", messages: [{ role: "user", content: "hi" }], stream: true }) }) as import("bun").BunRequest);
    expect([chat.status, responses.status, messages.status, stream.status]).toEqual([200, 200, 200, 200]);
    expect(await stream.text()).toContain("[DONE]");
  } finally { restore(); }
  expect(seen).toHaveLength(4);
  for (const request of seen) { expect(request.url).toContain(":8317/v1/responses"); expect(request.body.model).toBe(`${prefix}/${model.gatewayModelId.slice("codex/".length)}`); expect(request.authorization).toBe("Bearer private-cliproxy-key"); }
  await Bun.sleep(20);
  const ownerUsage = await db.execute({ sql: "SELECT cost_micros FROM usage_events WHERE workspace_id=? ORDER BY completed_at", args: [owner.id] });
  const consumerUsage = await db.execute({ sql: "SELECT cost_micros FROM usage_events WHERE workspace_id=? ORDER BY completed_at", args: [recipient.id] });
  expect(ownerUsage.rows).toHaveLength(4); expect(consumerUsage.rows).toHaveLength(4);
  expect(ownerUsage.rows.map((row) => Number(row.cost_micros))).toEqual([5, 5, 5, 5]);
  expect(consumerUsage.rows.map((row) => Number(row.cost_micros))).toEqual([0, 0, 0, 0]);
  await db.execute({ sql: "UPDATE codex_accounts SET enabled=0 WHERE workspace_id=? AND id=?", args: [owner.id, accountId] });
  // A ready recipient mapping cannot be substituted for the owner mapping.
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [crypto.randomUUID(), recipient.id, "Recipient", "codex-recipient.json", "recipient-index", codex.codexWorkspacePrefix(recipient.id), 1, 1, now, now] });
  codexFiles.push({ name: "codex-recipient.json", type: "codex", auth_index: "recipient-index", prefix: codex.codexWorkspacePrefix(recipient.id) });
  expect((await shares.listIncomingModelShares(recipient.id))[0]!.status).toBe("unavailable");
  const unavailable = await gateway.gatewayRequest(new Request("http://gateway.test/v1/responses", { method: "POST", headers: { authorization: `Bearer ${recipientKey.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "owner-codex", input: "hi" }) }) as import("bun").BunRequest);
  expect(unavailable.status).toBe(400);
});

test("a pending owner Codex reauthorization makes an otherwise live shared alias unavailable", async () => {
  const owner = await workspaces.createWorkspace("Codex reauth owner"); const recipient = await workspaces.createWorkspace("Codex reauth recipient");
  await codex.ensureCodexProvider(owner.id);
  const model = (await codex.listCodexModels(owner.id))[0]!, accountId = crypto.randomUUID(), prefix = codex.codexWorkspacePrefix(owner.id), now = Date.now();
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [accountId, owner.id, "Owner", "reauth-owner.json", "reauth-index", prefix, 1, 1, now, now] });
  codexFiles = [{ name: "reauth-owner.json", type: "codex", auth_index: "reauth-index", prefix }];
  await shares.setModelShareTargets(owner.id, model.id, [recipient.id]);
  expect((await shares.listIncomingModelShares(recipient.id))[0]!.status).toBe("active");
  await db.execute({ sql: "INSERT INTO codex_logins(id,workspace_id,state,auth_files_json,expires_at,created_at) VALUES(?,?,?,?,?,?)", args: [crypto.randomUUID(), owner.id, "reauth-pending", "{}", now + 60_000, now] });
  expect((await shares.listIncomingModelShares(recipient.id))[0]!.status).toBe("unavailable");
});

test("an unavailable owner Codex mapping does not clear a persisted target during a no-edit save", async () => {
  const owner = await workspaces.createWorkspace("Codex retained owner"); const recipient = await workspaces.createWorkspace("Codex retained recipient"); const additional = await workspaces.createWorkspace("Codex retained additional");
  await codex.ensureCodexProvider(owner.id);
  const model = (await codex.listCodexModels(owner.id))[0]!, prefix = codex.codexWorkspacePrefix(owner.id), now = Date.now();
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [crypto.randomUUID(), owner.id, "Owner", "retained-owner.json", "retained-index", prefix, 1, 1, now, now] });
  codexFiles = [{ name: "retained-owner.json", type: "codex", auth_index: "retained-index", prefix }];
  const [grant] = await shares.setModelShareTargets(owner.id, model.id, [recipient.id]);
  await routing.createRoutingAlias(recipient.id, { alias: "retained-codex", targetModelId: `${owner.id}/${model.gatewayModelId}`, shareId: grant.id });
  codexFiles = [];
  const targets = await shares.listShareTargets(owner.id, model.id);
  expect(targets.find((target) => target.id === recipient.id)).toMatchObject({ shared: true, available: false, status: "unavailable" });
  expect(targets.find((target) => target.id === additional.id)).toMatchObject({ shared: false, available: false, status: "unavailable" });
  await shares.setModelShareTargets(owner.id, model.id, targets.filter((target) => target.shared).map((target) => target.id));
  await expect(shares.setModelShareTargets(owner.id, model.id, [recipient.id, additional.id])).rejects.toMatchObject({ status: 400 });
  expect(await shares.resolveSharedModelForRecipient(recipient.id, grant.id)).toBeUndefined();
  expect((await routing.listRouting(recipient.id)).aliases.find((alias) => alias.id)).toMatchObject({ shareId: grant.id });
  expect((await db.execute({ sql: "SELECT id FROM model_shares WHERE id=?", args: [grant.id] })).rows).toHaveLength(1);
});

test("a healthy Codex source advertises new recipients and adds them without changing an existing grant", async () => {
  const owner = await workspaces.createWorkspace("Codex add owner"); const recipient = await workspaces.createWorkspace("Codex add recipient"); const additional = await workspaces.createWorkspace("Codex add additional");
  await codex.ensureCodexProvider(owner.id);
  const model = (await codex.listCodexModels(owner.id))[0]!, prefix = codex.codexWorkspacePrefix(owner.id), now = Date.now();
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [crypto.randomUUID(), owner.id, "Owner", "add-owner.json", "add-index", prefix, 1, 1, now, now] });
  codexFiles = [{ name: "add-owner.json", type: "codex", auth_index: "add-index", prefix }];
  await shares.setModelShareTargets(owner.id, model.id, [recipient.id]);
  const targets = await shares.listShareTargets(owner.id, model.id);
  expect(targets.find((target) => target.id === recipient.id)).toMatchObject({ shared: true, available: true, status: "active" });
  expect(targets.find((target) => target.id === additional.id)).toMatchObject({ shared: false, available: true, status: "active" });
  await shares.setModelShareTargets(owner.id, model.id, targets.filter((target) => target.shared || target.id === additional.id).map((target) => target.id));
  expect(await shares.listOutgoingModelShares(owner.id, model.id)).toHaveLength(2);
});

test("only enabled built-in Codex models are eligible for a grant", async () => {
  const owner = await workspaces.createWorkspace("Codex grant owner"); const recipient = await workspaces.createWorkspace("Codex grant recipient");
  await codex.ensureCodexProvider(owner.id);
  const model = (await codex.listCodexModels(owner.id))[0]!;
  await codex.setCodexModelEnabled(owner.id, model.id, false);
  await expect(shares.setModelShareTargets(owner.id, model.id, [recipient.id])).rejects.toMatchObject({ status: 400 });
});

test("Default is an eligible recipient for a live built-in Codex grant", async () => {
  const owner = await workspaces.createWorkspace("Codex Default owner");
  await codex.ensureCodexProvider(owner.id);
  const model = (await codex.listCodexModels(owner.id))[0]!, prefix = codex.codexWorkspacePrefix(owner.id), now = Date.now();
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [crypto.randomUUID(), owner.id, "Owner", "default-recipient-owner.json", "default-recipient-index", prefix, 1, 1, now, now] });
  codexFiles = [{ name: "default-recipient-owner.json", type: "codex", auth_index: "default-recipient-index", prefix }];
  await shares.setModelShareTargets(owner.id, model.id, ["default"]);
  expect((await shares.listIncomingModelShares("default")).at(0)).toMatchObject({ ownerWorkspaceId: owner.id, status: "active" });
});
