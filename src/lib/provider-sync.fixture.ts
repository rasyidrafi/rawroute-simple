import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const databasePath = `/tmp/opencode/rawroute-provider-sync-${crypto.randomUUID()}.db`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "provider-sync-default-password";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-provider-sync-data-${crypto.randomUUID()}`;

const { db } = await import("./db");
const providers = await import("./providers");
const sync = await import("./provider-sync");
const cliproxy = await import("./cliproxy");
const workspaces = await import("./workspaces");

type Entries = Record<string, unknown>[];
function managementFixture() {
  let openai: Entries = [];
  let claude: Entries = [];
  let strategy = "random";
  let fail: "none" | "claude-put" | "offline" = "none";
  let failStrategy = false;
  let failStrategyOnce = false;
  let strategyBarrier: ReturnType<typeof deferred> | undefined;
  let strategyReached: (() => void) | undefined;
  const restore = cliproxy.setCliproxyManagementTransportForTesting(async (path, init = {}) => {
    if (fail === "offline") throw new Error("connection refused");
    if (path.endsWith("/openai-compatibility") && init.method !== "PUT") return Response.json({ "openai-compatibility": openai });
    if (path.endsWith("/claude-api-key") && init.method !== "PUT") return Response.json({ "claude-api-key": claude });
    if (path.endsWith("/routing/strategy") && init.method !== "PUT") {
      strategyReached?.();
      if (strategyBarrier) await strategyBarrier.promise;
      if (failStrategy || failStrategyOnce) {
        failStrategyOnce = false;
        return new Response(null, { status: 503 });
      }
      return Response.json({ strategy });
    }
    if (path.endsWith("/openai-compatibility")) { openai = JSON.parse(String(init.body)) as Entries; return new Response(null, { status: 204 }); }
    if (path.endsWith("/claude-api-key")) {
      if (fail === "claude-put") return new Response(null, { status: 503 });
      claude = (JSON.parse(String(init.body)) as Entries).map((entry) => {
        const { name: _name, ...persisted } = entry;
        const headers = persisted.headers && typeof persisted.headers === "object" && !Array.isArray(persisted.headers)
          ? Object.fromEntries(Object.entries(persisted.headers as Record<string, unknown>).flatMap(([name, value]) => typeof value === "string" && value.trim() ? [[name, value.trim()]] : []))
          : undefined;
        return { ...persisted, "api-key": typeof persisted["api-key"] === "string" ? persisted["api-key"].trim() : persisted["api-key"], ...(headers ? { headers } : {}), "proxy-url": "" };
      });
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/routing/strategy")) { strategy = "fill-first"; return new Response(null, { status: 204 }); }
    return new Response(null, { status: 404 });
  });
  return {
    restore,
    get openai() { return openai; }, set openai(value: Entries) { openai = value; },
    get claude() { return claude; }, set claude(value: Entries) { claude = value; }, get strategy() { return strategy; },
    setFailure(value: typeof fail) { fail = value; },
    setStrategyFailure(value: boolean) { failStrategy = value; },
    failNextStrategyRead() { failStrategyOnce = true; },
    pauseStrategy() {
      strategyBarrier = deferred();
      return new Promise<void>((resolve) => { strategyReached = resolve; });
    },
    resumeStrategy() { strategyBarrier?.resolve(); strategyBarrier = undefined; strategyReached = undefined; },
  };
}

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function anonymousProvider(workspaceId: string, prefix: string) {
  const provider = await providers.createProvider(workspaceId, { name: prefix, prefix, baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "none" });
  await providers.createProviderModel(workspaceId, provider.id, { name: "M", gatewaySuffix: "m", upstreamModel: "upstream" });
  return provider;
}

beforeAll(async () => {
  await workspaces.ensureWorkspaceSchema();
  await providers.ensureProviderSchema();
  await sync.ensureProviderSyncSchema();
});
beforeEach(async () => {
  await db.execute("DELETE FROM provider_projection_tombstones");
  await db.execute("DELETE FROM provider_projection_ownership");
  await db.execute("DELETE FROM provider_sync_state");
  await db.execute("DELETE FROM provider_credentials");
  await db.execute("DELETE FROM provider_models");
  await db.execute("DELETE FROM providers");
  await db.execute("DELETE FROM workspaces WHERE id <> 'default'");
});
afterAll(() => db.close());

test.serial("offline saves remain durable and report a sanitised pending error", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Offline", prefix: "offline", baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "none" });
    await providers.createProviderModel("default", provider.id, { name: "M", gatewaySuffix: "m", upstreamModel: "upstream" });
    remote.setFailure("offline");
    const result = await sync.reconcileProvider(provider.workspaceId, provider.id);
    expect(result).toMatchObject({ state: "error", desiredRevision: 2, error: "CLIProxy management is unavailable." });
    expect(await providers.getProviderDetail("default", provider.id)).toMatchObject({ id: provider.id, desiredRevision: 2, appliedRevision: null });
  } finally { remote.restore(); }
});

test.serial("one locked read-modify-write preserves unmanaged entries and both workspaces", async () => {
  const remote = managementFixture();
  try {
    remote.openai = [{ name: "user-entry", prefix: "user", models: [] }];
    const [left, right] = await Promise.all([workspaces.createWorkspace("Left"), workspaces.createWorkspace("Right")]);
    const create = async (workspaceId: string, prefix: string) => {
      const provider = await providers.createProvider(workspaceId, { name: prefix, prefix, baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "none" });
      await providers.createProviderModel(workspaceId, provider.id, { name: "M", gatewaySuffix: "m", upstreamModel: `${prefix}-upstream` });
      return provider;
    };
    const one = await create(left.id, "left");
    const two = await create(right.id, "right");
    await Promise.all([sync.reconcileProvider(left.id, one.id), sync.reconcileProvider(right.id, two.id)]);
    expect(remote.openai).toHaveLength(3);
    expect(remote.openai.map((entry) => entry.prefix)).toContain("user");
    expect(new Set(remote.openai.filter((entry) => String(entry.name).startsWith("rr-managed-")).map((entry) => entry.prefix)).size).toBe(2);
  } finally { remote.restore(); }
});

test.serial("projection uses qualified namespaces, enabled models and ordered fill-first keys", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Keys", prefix: "public-prefix", baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "bearer" });
    const first = await providers.createProviderCredential("default", provider.id, { name: "first", key: "first-secret" });
    const second = await providers.createProviderCredential("default", provider.id, { name: "second", key: "second-secret" });
    await providers.reorderProviderCredentials("default", provider.id, [second.id, first.id]);
    await providers.createProviderModel("default", provider.id, { name: "Enabled", gatewaySuffix: "on", upstreamModel: "on-upstream" });
    await providers.createProviderModel("default", provider.id, { name: "Disabled", gatewaySuffix: "off", upstreamModel: "off-upstream", enabled: false });
    await sync.reconcileProvider("default", provider.id);
    expect(remote.strategy).toBe("fill-first");
    expect(remote.openai).toHaveLength(2);
    expect(remote.openai[0]).toMatchObject({ priority: 1, "api-key-entries": [{ "api-key": "second-secret" }], models: [{ alias: "on", name: "on-upstream" }] });
    expect(String(remote.openai[0].prefix)).not.toBe("public-prefix");
  } finally { remote.restore(); }
});

test.serial("upstream model names are significant in OpenAI-compatible comparisons", async () => {
  const remote = managementFixture();
  try {
    const provider = await anonymousProvider("default", "model-name");
    await sync.reconcileProvider("default", provider.id);
    const model = (await providers.getProviderDetail("default", provider.id))!.models[0];
    await providers.updateProviderModel("default", provider.id, model.id, { upstreamModel: "renamed-upstream" });
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied", desiredRevision: 3 });
    expect(remote.openai[0].models).toMatchObject([{ name: "renamed-upstream", alias: "m" }]);
  } finally { remote.restore(); }
});

test.serial("responses are recorded as native execution pending and never projected", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Responses", prefix: "responses", baseUrl: "https://example.test/v1", protocol: "openai-responses", authType: "none" });
    await providers.createProviderModel("default", provider.id, { name: "R", gatewaySuffix: "r", upstreamModel: "r-upstream" });
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "native-execution-pending" });
    expect(remote.openai).toHaveLength(0);
  } finally { remote.restore(); }
});

test.serial("unmanaged namespace collisions are preserved and disable/protocol changes remove managed entries", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Collision", prefix: "collision", baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "none" });
    await providers.createProviderModel("default", provider.id, { name: "M", gatewaySuffix: "m", upstreamModel: "upstream" });
    remote.openai = [{ name: "operator-entry", prefix: sync.providerManagedNamespace("default", provider.id), models: [] }];
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "error" });
    expect(remote.openai).toHaveLength(1);
    remote.openai = [];
    await sync.reconcileProvider("default", provider.id);
    expect(remote.openai).toHaveLength(1);
    await providers.updateProvider("default", provider.id, { enabled: false });
    await sync.reconcileProvider("default", provider.id);
    expect(remote.openai).toHaveLength(0);
    await providers.updateProvider("default", provider.id, { enabled: true, protocol: "openai-responses" });
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "native-execution-pending" });
    expect(remote.openai).toHaveLength(0);
  } finally { remote.restore(); }
});

test.serial("namespace collisions reject writes, partial endpoint failures retry idempotently, and tombstones clean deleted providers", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Anthropic", prefix: "anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential("default", provider.id, { name: "key", key: "anthropic-secret" });
    await providers.createProviderModel("default", provider.id, { name: "C", gatewaySuffix: "c", upstreamModel: "claude" });
    remote.setFailure("claude-put");
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "error" });
    remote.setFailure("none");
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
    expect(remote.claude).toHaveLength(1);
    await providers.deleteProvider("default", provider.id);
    await sync.reconcilePendingProviderProjections();
    expect(remote.claude).toHaveLength(0);
  } finally { remote.restore(); }
});

test.serial("Claude ownership survives the schema stripping name and deletion retains cleanup intent until verified", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Anthropic", prefix: "anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential("default", provider.id, { name: "key", key: "anthropic-secret" });
    await providers.createProviderModel("default", provider.id, { name: "C", gatewaySuffix: "c", upstreamModel: "claude" });
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
    expect(remote.claude[0]).not.toHaveProperty("name");
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
    await providers.deleteProvider("default", provider.id);
    expect(await sync.reconcileDeletedProvider("default", provider.id)).toMatchObject({ state: "cleaned", deleted: true });
    expect(remote.claude).toHaveLength(0);
    expect((await db.execute({ sql: "SELECT 1 FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ?", args: ["default", provider.id] })).rows).toHaveLength(0);
  } finally { remote.restore(); }
});

test.serial("write-ahead Claude ownership survives a PUT followed by routing failure", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Partial", prefix: "partial", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential("default", provider.id, { name: "key", key: "partial-secret" });
    await providers.createProviderModel("default", provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude" });
    remote.setStrategyFailure(true);
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "error" });
    expect(remote.claude).toHaveLength(1);
    expect((await db.execute({ sql: "SELECT claude_fingerprints_json FROM provider_projection_ownership WHERE workspace_id = ? AND provider_id = ?", args: ["default", provider.id] })).rows[0]?.claude_fingerprints_json).not.toBe("[]");
    remote.setStrategyFailure(false);
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
    await providers.deleteProvider("default", provider.id);
    expect(await sync.reconcileDeletedProvider("default", provider.id)).toMatchObject({ state: "cleaned" });
    expect(remote.claude).toHaveLength(0);
  } finally { remote.restore(); }
});

test.serial("Claude API keys are canonicalized to the endpoint's trimmed retained representation", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Trimmed key", prefix: "trimmed-key", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential("default", provider.id, { name: "key", key: " padded-key " });
    await providers.createProviderModel("default", provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude" });
    await providers.updateProvider("default", provider.id, { headers: { "X-Review": " padded " } });
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
    expect(remote.claude[0]).toMatchObject({ "api-key": "padded-key", headers: { "X-Review": "padded" } });
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
    await providers.deleteProvider("default", provider.id);
    expect(await sync.reconcileDeletedProvider("default", provider.id)).toMatchObject({ state: "cleaned" });
  } finally { remote.restore(); }
});

test.serial("one transient routing failure is recovered inside the bounded apply retry", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Transient", prefix: "transient", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential("default", provider.id, { name: "key", key: "transient-key" });
    await providers.createProviderModel("default", provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude" });
    remote.failNextStrategyRead();
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied", appliedRevision: 3 });
    expect(remote.claude).toHaveLength(1);
  } finally { remote.restore(); }
});

test.serial("a deleted provider's Claude cleanup proof survives later offline workspace deletion", async () => {
  const remote = managementFixture();
  const workspace = await workspaces.createWorkspace("Delete twice");
  const unregister = workspaces.registerWorkspaceDeletionExtension({ name: "provider-sync-double-delete", deleteWorkspaceData: async (workspaceId) => {
    await providers.deleteProvidersForWorkspace(workspaceId);
    await sync.reconcilePendingProviderProjections();
  } });
  try {
    const provider = await providers.createProvider(workspace.id, { name: "Anthropic", prefix: "double-delete", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential(workspace.id, provider.id, { name: "key", key: "double-delete-secret" });
    await providers.createProviderModel(workspace.id, provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude" });
    await sync.reconcileProvider(workspace.id, provider.id);
    remote.setFailure("offline");
    await providers.deleteProvider(workspace.id, provider.id);
    expect(await sync.reconcileDeletedProvider(workspace.id, provider.id)).toMatchObject({ state: "cleanup-error" });
    const before = (await db.execute({ sql: "SELECT claude_fingerprints_json FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ?", args: [workspace.id, provider.id] })).rows[0]?.claude_fingerprints_json;
    expect(before).not.toBe("[]");
    await workspaces.deleteWorkspace(workspace.id, workspace.name);
    const after = (await db.execute({ sql: "SELECT claude_fingerprints_json FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ?", args: [workspace.id, provider.id] })).rows[0]?.claude_fingerprints_json;
    expect(after).toBe(before);
    remote.setFailure("none");
    expect(await sync.reconcileDeletedProvider(workspace.id, provider.id)).toMatchObject({ state: "cleaned" });
    expect(remote.claude).toHaveLength(0);
  } finally { unregister(); remote.restore(); }
});

test.serial("an unowned Claude entry equal to desired configuration is never adopted", async () => {
  const remote = managementFixture();
  try {
    const provider = await providers.createProvider("default", { name: "Foreign", prefix: "foreign", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential("default", provider.id, { name: "key", key: "foreign-secret" });
    await providers.createProviderModel("default", provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude" });
    const namespace = sync.providerManagedNamespace("default", provider.id);
    remote.claude = [{ prefix: namespace, "base-url": "https://api.anthropic.com", "api-key": "foreign-secret", models: [{ name: "claude", alias: "c", "force-mapping": true }], "proxy-url": "http://operator-proxy.example:8080" }];
    expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "error" });
    expect((await db.execute({ sql: "SELECT 1 FROM provider_projection_ownership WHERE workspace_id = ? AND provider_id = ?", args: ["default", provider.id] })).rows).toHaveLength(0);
    await providers.deleteProvider("default", provider.id);
    expect(await sync.reconcileDeletedProvider("default", provider.id)).toMatchObject({ state: "cleanup-error" });
    expect(remote.claude).toHaveLength(1);
  } finally { remote.restore(); }
});

test.serial("a requested newer revision drains after an older blocked projection and inactive workspaces never project", async () => {
  let barrier: ReturnType<typeof deferred> | undefined;
  let reached: ReturnType<typeof deferred> | undefined;
  const remote = managementFixture();
  const restore = cliproxy.setCliproxyManagementTransportForTesting(async (path, init = {}) => {
    if (path.endsWith("/openai-compatibility") && init.method !== "PUT" && barrier) { reached!.resolve(); await barrier.promise; }
    return await (async () => {
      // Delegate after the snapshot barrier without exposing fixture internals.
      if (path.endsWith("/openai-compatibility") && init.method === "PUT") { remote.openai = JSON.parse(String(init.body)) as Entries; return new Response(null, { status: 204 }); }
      if (path.endsWith("/claude-api-key") && init.method === "PUT") return new Response(null, { status: 204 });
      if (path.endsWith("/openai-compatibility")) return Response.json({ "openai-compatibility": remote.openai });
      if (path.endsWith("/claude-api-key")) return Response.json({ "claude-api-key": remote.claude });
      return Response.json({ strategy: "fill-first" });
    })();
  });
  try {
    const provider = await anonymousProvider("default", "race");
    barrier = deferred(); reached = deferred();
    const old = sync.reconcileProvider("default", provider.id);
    await reached.promise;
    await providers.updateProvider("default", provider.id, { enabled: false });
    const latest = sync.reconcileProvider("default", provider.id);
    barrier.resolve();
    expect(await latest).toMatchObject({ desiredRevision: 3, state: "applied" });
    await old;
    expect(remote.openai).toHaveLength(0);

    const workspace = await workspaces.createWorkspace("Inactive sync");
    const inactive = await anonymousProvider(workspace.id, "inactive");
    await db.execute({ sql: "UPDATE workspaces SET status = 'deleting' WHERE id = ?", args: [workspace.id] });
    expect(await sync.reconcileProvider(workspace.id, inactive.id)).toMatchObject({ state: "pending" });
    expect(remote.openai.some((entry) => entry.prefix === sync.providerManagedNamespace(workspace.id, inactive.id))).toBe(false);
  } finally { restore(); remote.restore(); }
});

test.serial("a provider deleted while queued behind another projection terminates and leaves the queue drainable", async () => {
  let barrier: ReturnType<typeof deferred> | undefined;
  let reached: ReturnType<typeof deferred> | undefined;
  const remote = managementFixture();
  const restore = cliproxy.setCliproxyManagementTransportForTesting(async (requestPath, init = {}) => {
    if (requestPath.endsWith("/openai-compatibility") && init.method !== "PUT" && barrier) { reached!.resolve(); await barrier.promise; }
    if (requestPath.endsWith("/openai-compatibility") && init.method === "PUT") { remote.openai = JSON.parse(String(init.body)) as Entries; return new Response(null, { status: 204 }); }
    if (requestPath.endsWith("/claude-api-key")) return Response.json({ "claude-api-key": remote.claude });
    if (requestPath.endsWith("/openai-compatibility")) return Response.json({ "openai-compatibility": remote.openai });
    return Response.json({ strategy: "fill-first" });
  });
  try {
    const blocker = await anonymousProvider("default", "queue-blocker");
    const removed = await anonymousProvider("default", "queue-removed");
    barrier = deferred(); reached = deferred();
    const block = sync.reconcileProvider("default", blocker.id);
    await reached.promise;
    const queued = sync.reconcileProvider("default", removed.id);
    await providers.deleteProvider("default", removed.id);
    const cleanup = sync.reconcileDeletedProvider("default", removed.id);
    barrier.resolve(); barrier = undefined;
    expect(await Promise.race([Promise.all([block, queued, cleanup]), Bun.sleep(500).then(() => "timeout")])).not.toBe("timeout");
    expect(await Promise.race([sync.beginProviderSyncShutdown().then(() => "drained"), Bun.sleep(500).then(() => "timeout")])).toBe("drained");
  } finally { restore(); remote.restore(); sync.startProviderSync(); }
});

test.serial("workspace deletion copies an admitted write-ahead Claude proof before draining cleanup", async () => {
  const remote = managementFixture();
  const workspace = await workspaces.createWorkspace("Deleting admitted projection");
  const unregister = workspaces.registerWorkspaceDeletionExtension({ name: "provider-sync-delete-proof", deleteWorkspaceData: async (workspaceId) => {
    await providers.deleteProvidersForWorkspace(workspaceId);
    await sync.reconcilePendingProviderProjections();
  } });
  try {
    const provider = await providers.createProvider(workspace.id, { name: "Anthropic", prefix: "deleting-anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
    await providers.createProviderCredential(workspace.id, provider.id, { name: "key", key: "deleting-secret" });
    await providers.createProviderModel(workspace.id, provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude" });
    const strategyReached = remote.pauseStrategy();
    const running = sync.reconcileProvider(workspace.id, provider.id);
    await strategyReached;
    const deleting = workspaces.deleteWorkspace(workspace.id, workspace.name);
    while ((await workspaces.getWorkspace(workspace.id))?.status !== "deleting") await Bun.sleep(2);
    remote.resumeStrategy();
    await running;
    await deleting;
    expect(await workspaces.getWorkspace(workspace.id)).toBeUndefined();
    expect(remote.claude.some((entry) => entry.prefix === sync.providerManagedNamespace(workspace.id, provider.id))).toBe(false);
    expect((await db.execute({ sql: "SELECT 1 FROM provider_projection_tombstones WHERE workspace_id = ?", args: [workspace.id] })).rows).toHaveLength(0);
  } finally { unregister(); remote.resumeStrategy(); remote.restore(); }
});

test.skipIf(!Bun.env.RAWROUTE_CLIPROXY_INTEGRATION_BINARY)("configured CLIProxy round-trip strips Claude name without losing durable ownership", async () => {
  const executable = Bun.env.RAWROUTE_CLIPROXY_INTEGRATION_BINARY!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-claude-roundtrip-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  await probe.stop(true);
  fs.mkdirSync(path.join(root, "auth"));
  fs.writeFileSync(path.join(root, "proxy.yaml"), `host: "127.0.0.1"\nport: ${port}\nauth-dir: ${JSON.stringify(path.join(root, "auth"))}\nremote-management:\n  allow-remote: false\n  secret-key: "roundtrip-management-secret"\n  disable-control-panel: true\napi-keys:\n  - "roundtrip-public-key"\n`);
  const child = Bun.spawn([executable, "-config", path.join(root, "proxy.yaml")], { cwd: root, stdout: "ignore", stderr: "ignore" });
  const transport = async (requestPath: string, init: RequestInit = {}) => await fetch(`http://127.0.0.1:${port}${requestPath}`, { ...init, headers: { ...init.headers, "x-management-key": "roundtrip-management-secret" } });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await transport("/v0/management/claude-api-key")).ok) break; } catch { /* process is still booting */ }
      if (attempt === 99) throw new Error("Ephemeral CLIProxy did not become ready.");
      await Bun.sleep(50);
    }
    const restore = cliproxy.setCliproxyManagementTransportForTesting(transport);
    try {
      const provider = await providers.createProvider("default", { name: "Real Anthropic", prefix: "real-anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authType: "x-api-key" });
      await providers.createProviderCredential("default", provider.id, { name: "key", key: "real-roundtrip-secret" });
      await providers.createProviderModel("default", provider.id, { name: "Claude", gatewaySuffix: "c", upstreamModel: "claude-test" });
      expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
      const persisted = await (await transport("/v0/management/claude-api-key")).json() as { "claude-api-key": Array<Record<string, unknown>> };
      expect(persisted["claude-api-key"][0]).not.toHaveProperty("name");
      expect(await sync.reconcileProvider("default", provider.id)).toMatchObject({ state: "applied" });
      await providers.deleteProvider("default", provider.id);
      expect(await sync.reconcileDeletedProvider("default", provider.id)).toMatchObject({ state: "cleaned", deleted: true });
      expect((await (await transport("/v0/management/claude-api-key")).json() as { "claude-api-key": unknown[] })["claude-api-key"]).toHaveLength(0);
    } finally { restore(); }
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
