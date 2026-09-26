import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createClient } from "@libsql/client";
import type { BunRequest } from "bun";

const DEFAULT_PASSWORD = "gateway-key-test-default-password";
const CHANGED_PASSWORD = "Gateway-key-test-strong-password-1";
const databasePath = `/tmp/opencode/rawroute-gateway-keys-${crypto.randomUUID()}.db`;
const dataDir = `/tmp/opencode/rawroute-gateway-keys-data-${crypto.randomUUID()}`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = DEFAULT_PASSWORD;
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = dataDir;

const { db } = await import("./db");
const auth = await import("./auth");
const gateway = await import("./gateway-keys");
const gatewayHttp = await import("./gateway-keys-http");
const publicGateway = await import("./gateway-http");
const { logs } = await import("./logging/store");
const scopes = await import("./request-scope");
const workspaces = await import("./workspaces");

type TestRequest = BunRequest & { readSessionToken: () => string | null };

function request(
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string | null;
    origin?: string | null;
    sessionToken?: string | null;
    workspaceId?: string;
  } = {},
): TestRequest {
  const headers = new Headers();
  if (options.body !== undefined && options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.origin !== null) headers.set("origin", options.origin ?? "http://localhost:3001");
  if (options.workspaceId) headers.set(scopes.WORKSPACE_ID_HEADER, options.workspaceId);
  const result = new Request(`http://localhost:3001${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body,
  }) as TestRequest;
  let token = options.sessionToken ?? null;
  Object.defineProperty(result, "cookies", {
    value: {
      get: (name: string) => name === "rawroute_session" ? token ?? undefined : undefined,
      set: (name: string, value: string) => { if (name === "rawroute_session") token = value; },
      delete: (name: string) => { if (name === "rawroute_session") token = null; },
    },
  });
  result.readSessionToken = () => token;
  return result;
}

async function administrator(): Promise<string> {
  const login = request("/api/auth/login", { body: JSON.stringify({ password: DEFAULT_PASSWORD }) });
  expect((await auth.login(login)).status).toBe(200);
  const change = request("/api/auth/password", {
    body: JSON.stringify({ newPassword: CHANGED_PASSWORD }),
    sessionToken: login.readSessionToken(),
  });
  expect((await auth.changePassword(change)).status).toBe(200);
  const relogin = request("/api/auth/login", { body: JSON.stringify({ password: CHANGED_PASSWORD }) });
  expect((await auth.login(relogin)).status).toBe(200);
  return relogin.readSessionToken() ?? "";
}

function statementSql(statement: unknown): string {
  return typeof statement === "string"
    ? statement
    : typeof statement === "object" && statement !== null && "sql" in statement && typeof statement.sql === "string"
      ? statement.sql
      : "";
}

function interceptExecute(intercept: (sql: string, run: () => Promise<unknown>) => Promise<unknown>): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(db, "execute");
  const original = db.execute;
  Object.defineProperty(db, "execute", {
    configurable: true,
    writable: true,
    value: new Proxy(original, {
      apply(target, thisArg, args) {
        return intercept(statementSql(args[0]), async () => await Reflect.apply(target, thisArg, args));
      },
    }),
  });
  return () => {
    if (descriptor) Object.defineProperty(db, "execute", descriptor);
    else Reflect.deleteProperty(db, "execute");
  };
}

type MasterChildAction = "fail-publish" | "fail-write" | "fail-write-and-cleanup" | "initialize" | "initialize-master-only" | "reveal";

async function child(
  action: MasterChildAction,
  options: { childDatabasePath?: string; childDataDir?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const childDatabasePath = options.childDatabasePath ?? databasePath;
  const childDataDir = options.childDataDir ?? dataDir;
  const childProcess = Bun.spawn([process.execPath, "./gateway-keys.master-child.ts", action], {
    cwd: import.meta.dir,
    env: {
      ...Bun.env,
      NODE_ENV: "development",
      APP_ORIGIN: "",
      AUTH_DEFAULT_PASSWORD: DEFAULT_PASSWORD,
      DATABASE_URL: `file:${childDatabasePath}`,
      RAWROUTE_DATA_DIR: childDataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await childProcess.exited,
    stdout: await new Response(childProcess.stdout).text(),
    stderr: await new Response(childProcess.stderr).text(),
  };
}

beforeAll(async () => {
  await auth.ensureAuthSchema();
  await workspaces.ensureWorkspaceSchema();
  await gateway.ensureGatewayKeySchema();
});

beforeEach(async () => {
  await db.execute("DELETE FROM auth_sessions");
  await db.execute("DELETE FROM auth_credentials");
  await db.execute("DELETE FROM gateway_keys");
  await db.execute("DELETE FROM workspaces WHERE id <> 'default'");
  await db.execute({
    sql: "UPDATE workspaces SET status = 'active', deletion_token = NULL, updated_at = ? WHERE id = 'default'",
    args: [Date.now()],
  });
  await auth.ensureDefaultPassword();
  logs.clear();
  logs.deleteWorkspace("default");
});

afterAll(async () => {
  await db.execute("DELETE FROM gateway_keys");
  await db.execute("DELETE FROM auth_sessions");
  await db.execute("DELETE FROM auth_credentials");
});

test("stores only hashes/ciphertext, supports a persisted master-key restart, and rejects a missing master", async () => {
  const created = await gateway.createGatewayKey("default", "Restart key", "A".repeat(32));
  const stored = await db.execute({
    sql: "SELECT secret_hash, encrypted_secret FROM gateway_keys WHERE id = ? AND workspace_id = ?",
    args: [created.key.id, "default"],
  });
  expect(String(stored.rows[0]?.secret_hash)).not.toBe(created.secret);
  expect(String(stored.rows[0]?.encrypted_secret)).not.toContain(created.secret);
  expect(fs.statSync(gateway.gatewayKeyMasterPath()).mode & 0o777).toBe(0o600);
  expect(fs.statSync(fs.realpathSync(`${dataDir}/gateway-keys`)).mode & 0o777).toBe(0o700);

  const restarted = await child("reveal");
  expect(restarted.exitCode).toBe(0);
  expect(restarted.stdout.trim()).toBe(created.secret);

  const master = gateway.gatewayKeyMasterPath();
  const saved = `${master}.saved`;
  fs.renameSync(master, saved);
  try {
    const missing = await child("initialize");
    expect(missing.exitCode).not.toBe(0);
    expect(`${missing.stdout}\n${missing.stderr}`).toContain("master key is missing");
  } finally {
    fs.renameSync(saved, master);
  }
});

test("master key publication is atomic under failures and concurrent initializers", async () => {
  for (const action of ["fail-write", "fail-publish"] as const) {
    const failedDatabasePath = `/tmp/opencode/rawroute-gateway-key-${action}-${crypto.randomUUID()}.db`;
    const failedDataDir = `/tmp/opencode/rawroute-gateway-key-${action}-data-${crypto.randomUUID()}`;
    const failed = await child(action, { childDatabasePath: failedDatabasePath, childDataDir: failedDataDir });
    expect(failed.exitCode).not.toBe(0);
    const keyDirectory = `${failedDataDir}/gateway-keys`;
    expect(fs.existsSync(`${keyDirectory}/master-key`)).toBe(false);
    expect(fs.readdirSync(keyDirectory)).toEqual([]);
    const retry = await child("initialize", { childDatabasePath: failedDatabasePath, childDataDir: failedDataDir });
    expect(retry.exitCode).toBe(0);
    expect(fs.statSync(`${keyDirectory}/master-key`).mode & 0o777).toBe(0o600);
  }

  const failClosedDatabasePath = `/tmp/opencode/rawroute-gateway-key-fail-closed-${crypto.randomUUID()}.db`;
  const failClosedDataDir = `/tmp/opencode/rawroute-gateway-key-fail-closed-data-${crypto.randomUUID()}`;
  const cleanupFailure = await child("fail-write-and-cleanup", {
    childDatabasePath: failClosedDatabasePath,
    childDataDir: failClosedDataDir,
  });
  expect(cleanupFailure.exitCode).not.toBe(0);
  expect(fs.existsSync(`${failClosedDataDir}/gateway-keys/master-key`)).toBe(false);
  expect(fs.readdirSync(`${failClosedDataDir}/gateway-keys`).some((entry) => entry.endsWith(".tmp"))).toBe(true);
  const failClosedDb = createClient({ url: `file:${failClosedDatabasePath}` });
  await failClosedDb.execute({
    sql: `
      INSERT INTO gateway_keys (
        id, workspace_id, name, secret_hash, encrypted_secret, status,
        created_at, updated_at, revoked_at, deleted_at
      ) VALUES (?, 'default', 'orphan', ?, 'v1.invalid', 'active', ?, ?, NULL, NULL)
    `,
    args: [crypto.randomUUID(), "a".repeat(64), Date.now(), Date.now()],
  });
  failClosedDb.close();
  const failClosed = await child("initialize", { childDatabasePath: failClosedDatabasePath, childDataDir: failClosedDataDir });
  expect(failClosed.exitCode).not.toBe(0);
  expect(`${failClosed.stdout}\n${failClosed.stderr}`).toContain("master key is missing");

  const concurrentDatabasePath = `/tmp/opencode/rawroute-gateway-key-concurrent-${crypto.randomUUID()}.db`;
  const concurrentDataDir = `/tmp/opencode/rawroute-gateway-key-concurrent-data-${crypto.randomUUID()}`;
  const prepared = await child("fail-write", { childDatabasePath: concurrentDatabasePath, childDataDir: concurrentDataDir });
  expect(prepared.exitCode).not.toBe(0);
  const [first, second] = await Promise.all([
    child("initialize-master-only", { childDatabasePath: concurrentDatabasePath, childDataDir: concurrentDataDir }),
    child("initialize-master-only", { childDatabasePath: concurrentDatabasePath, childDataDir: concurrentDataDir }),
  ]);
  expect(`${first.stdout}\n${first.stderr}`.trim()).toBe("");
  expect(`${second.stdout}\n${second.stderr}`.trim()).toBe("");
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  const encoded = fs.readFileSync(`${concurrentDataDir}/gateway-keys/master-key`, "utf8").trim();
  expect(Buffer.from(encoded, "base64url")).toHaveLength(32);
  expect(fs.readdirSync(`${concurrentDataDir}/gateway-keys`).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("enforces global hashes across workspaces atomically and authenticates only active workspace keys", async () => {
  const alpha = await workspaces.createWorkspace("Alpha keys");
  const beta = await workspaces.createWorkspace("Beta keys");
  const value = "B".repeat(32);
  const outcomes = await Promise.allSettled([
    gateway.createGatewayKey(alpha.id, "Alpha", value),
    gateway.createGatewayKey(beta.id, "Beta", value),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  const winner = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof gateway.createGatewayKey>>> => outcome.status === "fulfilled");
  if (!winner) throw new Error("Expected a created key");
  const authentication = await gateway.authenticateGatewayKey(value);
  expect(authentication).toMatchObject({ workspace: { id: winner.value.key.workspaceId, status: "active" }, key: { id: winner.value.key.id, name: winner.value.key.name } });
  await gateway.updateGatewayKey(winner.value.key.workspaceId, winner.value.key.id, { revoked: true });
  expect(await gateway.authenticateGatewayKey(value)).toBeUndefined();
  expect(await gateway.revealGatewayKey(winner.value.key.workspaceId, winner.value.key.id)).toBe(value);
});

test("rejects tampered ciphertext and keeps deleted tombstones out of reveal and authentication", async () => {
  const created = await gateway.createGatewayKey("default", "Tamper key", "C".repeat(32));
  await db.execute({
    sql: "UPDATE gateway_keys SET encrypted_secret = ? WHERE workspace_id = ? AND id = ?",
    args: ["v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA", "default", created.key.id],
  });
  await expect(gateway.revealGatewayKey("default", created.key.id)).rejects.toThrow("could not be authenticated");

  const deleted = await gateway.createGatewayKey("default", "Delete key", "D".repeat(32));
  await gateway.deleteGatewayKey("default", deleted.key.id);
  expect(await gateway.authenticateGatewayKey(deleted.secret)).toBeUndefined();
  await expect(gateway.revealGatewayKey("default", deleted.key.id)).rejects.toMatchObject({ status: 404 });
  const tombstone = await db.execute({ sql: "SELECT status, deleted_at FROM gateway_keys WHERE id = ? AND workspace_id = ?", args: [deleted.key.id, "default"] });
  expect(tombstone.rows[0]).toMatchObject({ status: "deleted" });
  expect(Number(tombstone.rows[0]?.deleted_at)).toBeGreaterThan(0);
});

test("scoped admin API requires a changed password/origin, never lists plaintext, and explicitly reveals", async () => {
  const defaultPassword = await gatewayHttp.postGatewayKey(request("/api/gateway-keys", {
    body: JSON.stringify({ name: "Denied" }), workspaceId: "default",
  }));
  expect(defaultPassword.status).toBe(401);

  const initialLogin = request("/api/auth/login", { body: JSON.stringify({ password: DEFAULT_PASSWORD }) });
  await auth.login(initialLogin);
  const blockedDefault = await gatewayHttp.postGatewayKey(request("/api/gateway-keys", {
    body: JSON.stringify({ name: "Denied" }), sessionToken: initialLogin.readSessionToken(), workspaceId: "default",
  }));
  expect(blockedDefault.status).toBe(403);

  const token = await administrator();
  const missingScope = await gatewayHttp.getGatewayKeys(request("/api/gateway-keys", { sessionToken: token }));
  expect(missingScope.status).toBe(400);
  const badOrigin = await gatewayHttp.postGatewayKey(request("/api/gateway-keys", {
    body: JSON.stringify({ name: "Denied" }), origin: "https://outside.example", sessionToken: token, workspaceId: "default",
  }));
  expect(badOrigin.status).toBe(403);

  const created = await gatewayHttp.postGatewayKey(request("/api/gateway-keys", {
    body: JSON.stringify({ name: "HTTP key", value: "E".repeat(32) }), sessionToken: token, workspaceId: "default",
  }));
  expect(created.status).toBe(201);
  const createdBody = await created.json() as { key: { id: string }; secret: string };
  expect(created.headers.get("cache-control")).toBe("no-store");
  const listed = await gatewayHttp.getGatewayKeys(request("/api/gateway-keys", { sessionToken: token, workspaceId: "default" }));
  const listBody = await listed.json() as { keys: Array<Record<string, unknown>> };
  expect(listBody.keys[0]).not.toHaveProperty("secret");
  const revealed = await gatewayHttp.revealGatewayKeyHttp(request(`/api/gateway-keys/${createdBody.key.id}/reveal`, {
    body: "{}", sessionToken: token, workspaceId: "default",
  }));
  expect((await revealed.json() as { secret: string }).secret).toBe(createdBody.secret);

  const other = await workspaces.createWorkspace("Wrong key workspace");
  const wrongWorkspaceReveal = await gatewayHttp.revealGatewayKeyHttp(request(`/api/gateway-keys/${createdBody.key.id}/reveal`, {
    body: "{}", sessionToken: token, workspaceId: other.id,
  }));
  expect(wrongWorkspaceReveal.status).toBe(404);
  const oversized = await gatewayHttp.postGatewayKey(request("/api/gateway-keys", {
    body: JSON.stringify({ name: "Oversized", value: "F".repeat(4_096) }), sessionToken: token, workspaceId: "default",
  }));
  expect(oversized.status).toBe(400);
});

test("workspace deletion drains an admitted key creation then idempotently purges its keys", async () => {
  const token = await administrator();
  const workspace = await workspaces.createWorkspace("Deletion key race");
  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "gateway-key-deletion-fixture",
    deleteWorkspaceData: gateway.deleteGatewayKeysForWorkspace,
  });
  let insertReached!: () => void;
  let releaseInsert!: () => void;
  const reached = new Promise<void>((resolve) => { insertReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseInsert = resolve; });
  let paused = false;
  const restore = interceptExecute(async (sql, run) => {
    if (!paused && /INSERT INTO gateway_keys/i.test(sql)) {
      paused = true;
      insertReached();
      await release;
    }
    return await run();
  });
  try {
    const creating = gatewayHttp.postGatewayKey(request("/api/gateway-keys", {
      body: JSON.stringify({ name: "Race key" }), sessionToken: token, workspaceId: workspace.id,
    }));
    await reached;
    let deleted = false;
    const deleting = workspaces.deleteWorkspace(workspace.id, workspace.name).then(() => { deleted = true; });
    await Promise.resolve();
    expect(deleted).toBe(false);
    releaseInsert();
    expect((await creating).status).toBe(201);
    await deleting;
    expect(await workspaces.getWorkspace(workspace.id)).toBeUndefined();
    expect(await gateway.listGatewayKeys(workspace.id)).toEqual([]);
  } finally {
    releaseInsert();
    restore();
    unregister();
  }
});

function gatewayRequest(
  path: string,
  options: { method?: string; bearer?: string; apiKey?: string; workspaceId?: string } = {},
): BunRequest {
  const headers = new Headers();
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.apiKey !== undefined) headers.set("x-api-key", options.apiKey);
  if (options.workspaceId !== undefined) headers.set(scopes.WORKSPACE_ID_HEADER, options.workspaceId);
  return new Request(`http://localhost:3001${path}`, { method: options.method ?? "POST", headers }) as BunRequest;
}

test("public gateway keys derive workspace ownership, reject stale credentials, and never proxy", async () => {
  const alpha = await workspaces.createWorkspace("Gateway alpha");
  const beta = await workspaces.createWorkspace("Gateway beta");
  const alphaKey = await gateway.createGatewayKey(alpha.id, "Alpha key", "G".repeat(32));
  const betaKey = await gateway.createGatewayKey(beta.id, "Beta key", "H".repeat(32));
  let upstreamCalls = 0;
  const nativeFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async () => {
      upstreamCalls++;
      return new Response();
    },
  });
  try {
    const authenticated = await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/chat/completions", { bearer: alphaKey.secret, workspaceId: beta.id }),
      "chat-completions",
      "POST",
    );
    expect(authenticated.status).toBe(503);
    expect(await authenticated.json()).toMatchObject({ error: { code: "workspace_routing_not_ready" } });
    expect(logs.snapshot({ kind: "workspace", workspaceId: alpha.id }).entries[0]).toMatchObject({
      event: "gateway.chat-completions.post", workspaceId: alpha.id,
    });
    expect(logs.snapshot({ kind: "workspace", workspaceId: beta.id }).entries).toHaveLength(0);
    expect(upstreamCalls).toBe(0);

    const xApiKey = await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/models", { method: "GET", apiKey: betaKey.secret, workspaceId: alpha.id }),
      "models",
      "GET",
    );
    expect(xApiKey.status).toBe(503);
    expect(logs.snapshot({ kind: "workspace", workspaceId: beta.id }).entries[0]?.event).toBe("gateway.models.get");

    const conflicting = await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/chat/completions", { bearer: alphaKey.secret, apiKey: betaKey.secret }),
      "chat-completions",
      "POST",
    );
    expect(conflicting.status).toBe(401);
    expect(logs.snapshot().entries[0]).toMatchObject({ event: "gateway.authentication.rejected", workspaceId: null });

    const nativeOnly = await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/chat/completions", { bearer: "N".repeat(32) }),
      "chat-completions",
      "POST",
    );
    expect(nativeOnly.status).toBe(401);

    await gateway.updateGatewayKey(alpha.id, alphaKey.key.id, { revoked: true });
    expect((await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/chat/completions", { bearer: alphaKey.secret }), "chat-completions", "POST",
    )).status).toBe(401);
    await gateway.deleteGatewayKey(beta.id, betaKey.key.id);
    expect((await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/models", { method: "GET", apiKey: betaKey.secret }), "models", "GET",
    )).status).toBe(401);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: nativeFetch });
  }
});

test("gateway allowlist, root, deletion, and database failures are closed", async () => {
  expect(publicGateway.gatewayEndpoints).toEqual({
    "/v1/chat/completions": { endpoint: "chat-completions", method: "POST" },
    "/v1/completions": { endpoint: "completions", method: "POST" },
    "/v1/responses": { endpoint: "responses", method: "POST" },
    "/v1/messages": { endpoint: "messages", method: "POST" },
    "/v1/models": { endpoint: "models", method: "GET" },
    "/v1/embeddings": { endpoint: "embeddings", method: "POST" },
    "/v1/images/generations": { endpoint: "images", method: "POST" },
    "/v1/audio/transcriptions": { endpoint: "audio-transcriptions", method: "POST" },
  });
  expect(publicGateway.gatewayRoot().status).toBe(404);

  const workspace = await workspaces.createWorkspace("Gateway deletion");
  const created = await gateway.createGatewayKey(workspace.id, "Deletion key", "I".repeat(32));
  const methodDenied = await publicGateway.gatewayUnavailable(
    gatewayRequest("/v1/models", { method: "POST", bearer: created.secret }), "models", "GET",
  );
  expect(methodDenied.status).toBe(405);
  expect(methodDenied.headers.get("allow")).toBe("GET");
  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "gateway-http-deletion-fixture",
    deleteWorkspaceData: gateway.deleteGatewayKeysForWorkspace,
  });
  try {
    await workspaces.deleteWorkspace(workspace.id, workspace.name);
    expect((await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/models", { method: "GET", bearer: created.secret }), "models", "GET",
    )).status).toBe(401);
  } finally {
    unregister();
  }

  const restore = interceptExecute(async (sql, run) => {
    if (/FROM gateway_keys AS keys/i.test(sql)) throw new Error("database unavailable");
    return await run();
  });
  try {
    const unavailable = await publicGateway.gatewayUnavailable(
      gatewayRequest("/v1/models", { method: "GET", bearer: "J".repeat(32) }), "models", "GET",
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "gateway_authentication_unavailable" } });
  } finally {
    restore();
  }
});
