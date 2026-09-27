import { afterAll, beforeAll, expect, test } from "bun:test";

const databasePath = `/tmp/opencode/rawroute-codex-${crypto.randomUUID()}.db`;
Bun.env.NODE_ENV = "development";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-codex-data-${crypto.randomUUID()}`;
const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const codex = await import("./codex");
const management = await import("./cliproxy/management");

let files: Array<Record<string, unknown>> = [];
let status = "wait";
let patchedPrefix = "";
let failPriority = false;
let usageGets = 0;
let resetConsumes = 0;
let usageStatus = 200;
let cleanupDeleteEntered: (() => void) | undefined;
let cleanupDeleteWait: Promise<void> | undefined;
const restore = management.setCliproxyManagementTransportForTesting(async (path, init) => {
  if (path === "/v0/management/auth-files") return Response.json({ files });
  if (path === "/v0/management/codex-auth-url?is_webui=true") return Response.json({ url: "https://login.test", state: "state-a" });
  if (path === "/v0/management/get-auth-status?state=state-a") return Response.json({ status });
  if (path === "/v0/management/auth-files/fields") { const input = JSON.parse(String(init?.body)); if (failPriority && input.priority !== undefined) { failPriority = false; return Response.json({ error: "injected" }, { status: 503 }); } if (typeof input.prefix === "string") patchedPrefix = input.prefix; const file = files.find((item) => item.name === input.name); if (file) Object.assign(file, input); return Response.json({ ok: true }); }
  if (path.startsWith("/v0/management/auth-files?")) { cleanupDeleteEntered?.(); if (cleanupDeleteWait) await cleanupDeleteWait; const name = new URL(path, "http://private").searchParams.get("name"); files = files.filter((file) => file.name !== name); return Response.json({ ok: true }); }
  if (path === "/v0/management/api-call") { const input = JSON.parse(String(init?.body)); if (input.method === "POST") { resetConsumes++; return Response.json({ status_code: 200, body: "{}" }); } usageGets++; return Response.json({ status_code: usageStatus, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 }, secondary_window: { used_percent: 100 } }, rate_limit_reset_credits: { available_count: 3 } }) }); }
  if (path.startsWith("/v0/management/oauth-session")) return Response.json({ ok: true });
  return Response.json({ error: "unexpected" }, { status: 500 });
});

beforeAll(async () => { await workspaces.ensureWorkspaceSchema(); await providers.ensureProviderSchema(); await codex.ensureCodexSchema(); });
afterAll(async () => { restore(); await db.close(); });

test("maps exactly one changed private auth file and persists no OAuth token", async () => {
  const login = await codex.startCodexLogin("default");
  expect(login.authorizationUrl).toBe("https://login.test");
  await expect(codex.pollCodexLogin("other-workspace", login.loginId)).rejects.toMatchObject({ status: 410 });
  files = [{ name: "codex-private.json", type: "codex", auth_index: "private-index", email: "person@example.test", id_token: "must-not-persist" }]; status = "ok";
  const done = await codex.pollCodexLogin("default", login.loginId);
  expect(done.status).toBe("authorized");
  expect(patchedPrefix).toBe(codex.codexWorkspacePrefix("default"));
  const stored = await db.execute("SELECT auth_file,auth_index,email FROM codex_accounts");
  expect(stored.rows[0]).toMatchObject({ auth_file: "codex-private.json", auth_index: "private-index", email: "person@example.test" });
  const columns = await db.execute("PRAGMA table_info(codex_accounts)");
  expect(columns.rows.map((row) => String(row.name))).not.toContain("access_token");
  expect(columns.rows.map((row) => String(row.name))).not.toContain("refresh_token");
});

test("reorders the complete account order with higher remote priority first", async () => {
  const first = (await codex.listCodexAccounts("default"))[0]!;
  const now = Date.now();
  files.push({ name: "second-priority.json", type: "codex", auth_index: "second-index", prefix: codex.codexWorkspacePrefix("default") });
  await db.execute({ sql: "INSERT INTO codex_accounts(id,workspace_id,name,auth_file,auth_index,auth_prefix,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: ["second-priority", "default", "Second", "second-priority.json", "second-index", codex.codexWorkspacePrefix("default"), 1, 0, now, now] });
  await db.execute({ sql: "UPDATE codex_accounts SET priority=1 WHERE workspace_id=? AND id=?", args: ["default", first.id] });
  const firstFile = files.find((file) => file.name === first.authFile)!; firstFile.priority = 1;
  await codex.reorderCodexAccounts("default", ["second-priority", first.id]);
  const ordered = await codex.listCodexAccounts("default");
  expect(ordered.slice(0, 2).map((account) => account.id)).toEqual(["second-priority", first.id]);
  expect(files.find((file) => file.name === "second-priority.json")?.priority).toBe(2);
});

test("normalizes limit-id quota windows and remaining reset credits", () => {
  const quota = codex.parseCodexQuota({ rate_limits_by_limit_id: { codex: { primary_window: { used_percent: 75, limit_window_seconds: 604800 }, secondary_window: { used_percent: 10, limit_window_seconds: 18000 } } }, rate_limit_reset_credits: { remaining_count: 2 } }) as { weekly: { usedPercent?: number }; fiveHour: { remainingPercent?: number }; unusedResetCredits?: number };
  expect(quota.weekly.usedPercent).toBe(75);
  expect(quota.fiveHour.remainingPercent).toBe(90);
  expect(quota.unusedResetCredits).toBe(2);
});

test("normalizes nested usage envelopes and ISO reset timestamps", () => {
  const quota = codex.parseCodexQuota({ rate_limit: { rate_limit: { primary_window: { used_percent: 80 }, secondary_window: { used_percent: 100, reset_at: "2026-10-01T12:00:00Z" }, rate_limit_reset_credits: { available_count: 2 } } } }) as { fiveHour: { usedPercent?: number }; weekly: { resetAt?: string }; unusedResetCredits?: number };
  expect(quota.fiveHour.usedPercent).toBe(80);
  expect(quota.weekly.resetAt).toBe("2026-10-01T12:00:00.000Z");
  expect(quota.unusedResetCredits).toBe(2);
});

test("redeems a fresh exhausted quota once across concurrent requests", async () => {
  const account = (await codex.listCodexAccounts("default"))[0]!;
  usageGets = 0; resetConsumes = 0;
  await Promise.all([codex.redeemCodexCredit("default", account.id, "use my codex reset"), codex.redeemCodexCredit("default", account.id, "use my codex reset")]);
  expect(usageGets).toBe(1);
  expect(resetConsumes).toBe(1);
});

test("never redeems against stale quota after a failed fresh read", async () => {
  const login = await codex.startCodexLogin("default"); files.push({ name: "stale-quota.json", type: "codex", auth_index: "stale-index" }); status = "ok";
  const completed = await codex.pollCodexLogin("default", login.loginId); if (completed.status !== "authorized") throw new Error("Expected stale quota test login to complete.");
  const account = completed.account;
  usageStatus = 503; resetConsumes = 0;
  await expect(codex.redeemCodexCredit("default", account.id, "use my codex reset")).rejects.toMatchObject({ status: 502 });
  usageStatus = 200;
  expect(resetConsumes).toBe(0);
});

test("does not commit a mapping when the final remote priority update fails", async () => {
  const login = await codex.startCodexLogin("default");
  files.push({ name: "failed-priority.json", type: "codex", auth_index: "failed-index" }); status = "ok"; failPriority = true;
  await expect(codex.pollCodexLogin("default", login.loginId)).rejects.toMatchObject({ status: 502 });
  const stored = await db.execute({ sql: "SELECT id FROM codex_accounts WHERE auth_file=?", args: ["failed-priority.json"] });
  expect(stored.rows).toHaveLength(0);
  expect(files.find((file) => file.name === "failed-priority.json")?.prefix).toBe("");
});

test("scopes workspace cleanup and rejects reauthorization while its delete is claimed", async () => {
  const account = (await codex.listCodexAccounts("default"))[0]!;
  const file = files.find((item) => item.name === account.authFile)!;
  await db.batch([{ sql: "UPDATE codex_accounts SET state='deleting' WHERE workspace_id=? AND id=?", args: ["default", account.id] }, { sql: "INSERT INTO codex_cleanup_tombstones(workspace_id,account_id,auth_file,state,updated_at) VALUES(?,?,?,'pending',?)", args: ["default", account.id, account.authFile, Date.now()] }], "write");
  const other = await workspaces.createWorkspace(`other ${crypto.randomUUID()}`);
  await codex.deleteCodexForWorkspace(other.id);
  expect(files.some((item) => item.name === account.authFile)).toBe(true);
  let releaseDelete!: () => void; cleanupDeleteWait = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const entered = new Promise<void>((resolve) => { cleanupDeleteEntered = resolve; });
  const cleanup = codex.reconcileCodexCleanup(); await entered;
  const login = await codex.startCodexLogin("default"); file.last_refresh = "fresh";
  await expect(codex.pollCodexLogin("default", login.loginId)).rejects.toMatchObject({ status: 409 });
  releaseDelete(); cleanupDeleteWait = undefined; cleanupDeleteEntered = undefined; await cleanup;
  const local = await db.execute({ sql: "SELECT state FROM codex_accounts WHERE workspace_id=? AND id=?", args: ["default", account.id] });
  expect(local.rows).toHaveLength(0);
});
