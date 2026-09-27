import { afterAll, beforeAll, expect, test } from "bun:test";

Bun.env.NODE_ENV = "development";
Bun.env.DATABASE_URL = `file:/tmp/opencode/rawroute-anchor-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-anchor-data-${crypto.randomUUID()}`;

const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const gatewayKeys = await import("./gateway-keys");
const codex = await import("./codex");
const accounting = await import("./accounting");
const management = await import("./cliproxy/management");
const resetAt = new Date(Date.now() + 4 * 86_400_000).toISOString();
const restore = management.setCliproxyManagementTransportForTesting(async (path) => {
  if (path === "/v0/management/auth-files") return Response.json({ files: [{ name: "owned.json", type: "codex", auth_index: "owned-index", prefix: codex.codexWorkspacePrefix("default") }] });
  if (path === "/v0/management/api-call") return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: { secondary_window: { used_percent: 12, reset_at: resetAt, window_seconds: 604800 } } }) });
  return Response.json({ error: "unexpected" }, { status: 500 });
});

beforeAll(async () => {
  await workspaces.ensureWorkspaceSchema(); await gatewayKeys.ensureGatewayKeySchema(); await providers.ensureProviderSchema(); await codex.ensureCodexSchema(); await accounting.ensureAccountingSchema();
  const now = Date.now(); await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: ["owned-account", "default", "Owned", "owned.json", "owned-index", codex.codexWorkspacePrefix("default"), 1, 0, now, now] });
});
afterAll(async () => { restore(); await db.close(); });

test("Codex anchor accepts only a fresh owned weekly reset and custom windows clear it", async () => {
  await accounting.saveCodexBudgetAnchor("default", "owned-account");
  const anchored = await accounting.getBudgetAdmin("default");
  expect(anchored.window.anchor?.accountId).toBe("owned-account");
  expect(anchored.window.endAt).toBe(Date.parse(resetAt));
  expect(anchored.window.startAt).toBe(Date.parse(resetAt) - 7 * 86_400_000);
  await accounting.saveBudgetWindow("default", { startAt: Date.now() - 1_000, endAt: Date.now() + 1_000 });
  expect((await accounting.getBudgetAdmin("default")).window.anchor).toBeNull();
});
