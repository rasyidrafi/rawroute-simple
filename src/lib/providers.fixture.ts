import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import type { BunRequest } from "bun";
import * as fs from "node:fs";

const DEFAULT_PASSWORD = "provider-test-default-password";
const CHANGED_PASSWORD = "Provider-test-strong-password-1";
const databasePath = `/tmp/opencode/rawroute-providers-${crypto.randomUUID()}.db`;
const dataDir = `/tmp/opencode/rawroute-providers-data-${crypto.randomUUID()}`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = DEFAULT_PASSWORD;
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = dataDir;

const { db } = await import("./db");
const auth = await import("./auth");
const providers = await import("./providers");
const providerHttp = await import("./providers-http");
const scopes = await import("./request-scope");
const workspaces = await import("./workspaces");

type TestRequest = BunRequest & { readSessionToken: () => string | null };
function request(
  path: string,
  options: {
    method?: string;
    body?: string;
    sessionToken?: string | null;
    workspaceId?: string;
    origin?: string | null;
  } = {},
): TestRequest {
  const headers = new Headers();
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  if (options.origin !== null)
    headers.set("origin", options.origin ?? "http://localhost:3001");
  if (options.workspaceId)
    headers.set(scopes.WORKSPACE_ID_HEADER, options.workspaceId);
  const result = new Request(`http://localhost:3001${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body,
  }) as TestRequest;
  let token = options.sessionToken ?? null;
  Object.defineProperty(result, "cookies", {
    value: {
      get: (name: string) =>
        name === "rawroute_session" ? (token ?? undefined) : undefined,
      set: (name: string, value: string) => {
        if (name === "rawroute_session") token = value;
      },
      delete: (name: string) => {
        if (name === "rawroute_session") token = null;
      },
    },
  });
  result.readSessionToken = () => token;
  return result;
}
async function administrator(): Promise<string> {
  const login = request("/api/auth/login", {
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  });
  await auth.login(login);
  await auth.changePassword(
    request("/api/auth/password", {
      body: JSON.stringify({ newPassword: CHANGED_PASSWORD }),
      sessionToken: login.readSessionToken(),
    }),
  );
  const relogin = request("/api/auth/login", {
    body: JSON.stringify({ password: CHANGED_PASSWORD }),
  });
  await auth.login(relogin);
  return relogin.readSessionToken() ?? "";
}
function statementSql(statement: unknown): string {
  return typeof statement === "string"
    ? statement
    : typeof statement === "object" &&
        statement !== null &&
        "sql" in statement &&
        typeof statement.sql === "string"
      ? statement.sql
      : "";
}

beforeAll(async () => {
  await auth.ensureAuthSchema();
  await workspaces.ensureWorkspaceSchema();
  await providers.ensureProviderSchema();
});

beforeEach(async () => {
  await db.execute("DELETE FROM auth_sessions");
  await db.execute("DELETE FROM auth_credentials");
  await db.execute("DELETE FROM provider_credentials");
  await db.execute("DELETE FROM provider_models");
  await db.execute("DELETE FROM providers");
  await db.execute("DELETE FROM provider_sync_state");
  await db.execute("DELETE FROM provider_projection_ownership");
  await db.execute("DELETE FROM provider_projection_tombstones");
  await db.execute("DELETE FROM workspaces WHERE id <> 'default'");
  await auth.ensureDefaultPassword();
});

afterAll(async () => {
  await db.execute("DELETE FROM provider_credentials");
  await db.execute("DELETE FROM provider_models");
  await db.execute("DELETE FROM providers");
  await db.execute("DELETE FROM provider_sync_state");
  await db.execute("DELETE FROM provider_projection_ownership");
  await db.execute("DELETE FROM provider_projection_tombstones");
  await db.execute("DELETE FROM auth_sessions");
  await db.execute("DELETE FROM auth_credentials");
});

test("providers have stable workspace-owned IDs, encrypted credentials, scoped model mappings, and computed counts", async () => {
  const alpha = await workspaces.createWorkspace("Provider alpha");
  const beta = await workspaces.createWorkspace("Provider beta");
  const provider = await providers.createProvider(alpha.id, {
    name: "Anthropic",
    prefix: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/",
    protocol: "anthropic-messages",
    authType: "x-api-key",
    headers: { "x-client-version": "one" },
  });
  expect(provider).toMatchObject({
    workspaceId: alpha.id,
    prefix: "anthropic",
    baseUrl: "https://api.anthropic.com",
  });
  expect(provider).toMatchObject({
    apiKeyCount: 0,
    modelCount: 0,
    desiredRevision: 1,
    appliedRevision: null,
  });
  await expect(
    providers.createProvider(beta.id, { ...provider, name: "Other Anthropic" }),
  ).resolves.toMatchObject({ workspaceId: beta.id });
  await expect(
    providers.createProvider(alpha.id, { ...provider, name: "Duplicate" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    providers.createProvider(alpha.id, { ...provider, prefix: "codex" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    providers.createProvider(alpha.id, { ...provider, authType: "none" }),
  ).rejects.toMatchObject({ status: 400 });

  const credential = await providers.createProviderCredential(
    alpha.id,
    provider.id,
    {
      name: "primary",
      key: "upstream-secret-value",
    },
  );
  expect(credential).toMatchObject({
    providerId: provider.id,
    key: "__unchanged__",
    enabled: true,
  });
  const stored = await db.execute({
    sql: "SELECT encrypted_secret FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND id = ?",
    args: [alpha.id, provider.id, credential.id],
  });
  expect(String(stored.rows[0]?.encrypted_secret)).not.toContain(
    "upstream-secret-value",
  );
  expect(
    await providers.readProviderCredentialSecret(
      alpha.id,
      provider.id,
      credential.id,
    ),
  ).toBe("upstream-secret-value");
  const renamedCredential = await providers.updateProviderCredential(
    alpha.id,
    provider.id,
    credential.id,
    { name: "primary renamed" },
  );
  expect(renamedCredential).toMatchObject({
    id: credential.id,
    key: "__unchanged__",
    name: "primary renamed",
  });
  expect(
    await providers.readProviderCredentialSecret(
      alpha.id,
      provider.id,
      credential.id,
    ),
  ).toBe("upstream-secret-value");
  await expect(
    providers.getProviderDetail(beta.id, provider.id),
  ).resolves.toBeUndefined();

  const model = await providers.createProviderModel(alpha.id, provider.id, {
    name: "Claude Sonnet",
    gatewaySuffix: "sonnet",
    upstreamModel: "claude-sonnet-4",
  });
  const modelId = model.id;
  expect(typeof modelId).toBe("string");
  expect(
    await providers.updateProviderModel(alpha.id, provider.id, modelId, {
      enabled: false,
    }),
  ).toMatchObject({ id: modelId, enabled: false });
  expect(model).toMatchObject({
    id: expect.any(String),
    gatewayModelId: "anthropic/sonnet",
    gatewaySuffix: "sonnet",
  });
  const updated = await providers.updateProvider(alpha.id, provider.id, {
    prefix: "claude",
  });
  expect(updated.id).toBe(provider.id);
  expect(
    (await providers.getProviderDetail(alpha.id, provider.id))?.models[0],
  ).toMatchObject({ id: modelId, gatewayModelId: "claude/sonnet" });
  expect((await providers.listProviders(alpha.id))[0]).toMatchObject({
    apiKeyCount: 1,
    enabledApiKeyCount: 1,
    modelCount: 1,
    enabledModelCount: 0,
  });
});

test("full credential ordering is atomic and provider deletion leaves a projection tombstone until workspace cleanup", async () => {
  const provider = await providers.createProvider("default", {
    name: "OpenAI",
    prefix: "openai",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat",
    authType: "bearer",
  });
  const first = await providers.createProviderCredential(
    "default",
    provider.id,
    { name: "one", key: "one-secret" },
  );
  const second = await providers.createProviderCredential(
    "default",
    provider.id,
    { name: "two", key: "two-secret" },
  );
  await providers.reorderProviderCredentials("default", provider.id, [
    second.id,
    first.id,
  ]);
  expect(
    (
      await providers.getProviderDetail("default", provider.id)
    )?.credentials.map((credential) => credential.id),
  ).toEqual([second.id, first.id]);
  await expect(
    providers.reorderProviderCredentials("default", provider.id, [first.id]),
  ).rejects.toMatchObject({ status: 409 });
  await providers.deleteProvider("default", provider.id);
  expect(
    await providers.getProviderDetail("default", provider.id),
  ).toBeUndefined();
  const tombstone = await db.execute({
    sql: "SELECT status, desired_revision, applied_revision FROM providers WHERE workspace_id = ? AND id = ?",
    args: ["default", provider.id],
  });
  expect(tombstone.rows[0]).toMatchObject({
    status: "deleted",
    applied_revision: null,
  });
  await providers.deleteProvidersForWorkspace("default");
  expect(
    (
      await db.execute({
        sql: "SELECT 1 FROM providers WHERE workspace_id = ?",
        args: ["default"],
      })
    ).rows,
  ).toHaveLength(0);
});

test("workspace deletion extension purges provider tombstones and active resources", async () => {
  const workspace = await workspaces.createWorkspace("Provider cleanup");
  const provider = await providers.createProvider(workspace.id, {
    name: "Cleanup",
    prefix: "cleanup",
    baseUrl: "https://example.test/v1",
    protocol: "openai-chat",
    authType: "none",
  });
  await providers.deleteProvider(workspace.id, provider.id);
  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "provider-cleanup-fixture",
    deleteWorkspaceData: providers.deleteProvidersForWorkspace,
  });
  try {
    await workspaces.deleteWorkspace(workspace.id, workspace.name);
    expect(await workspaces.getWorkspace(workspace.id)).toBeUndefined();
    expect(
      (
        await db.execute({
          sql: "SELECT 1 FROM providers WHERE workspace_id = ?",
          args: [workspace.id],
        })
      ).rows,
    ).toHaveLength(0);
  } finally {
    unregister();
  }
});

test("concurrent provider patches and model writes retain the committed prefix", async () => {
  const provider = await providers.createProvider("default", {
    name: "Original",
    prefix: "old",
    baseUrl: "https://example.test/v1",
    protocol: "openai-chat",
  });
  await providers.createProviderModel("default", provider.id, {
    name: "Model",
    gatewaySuffix: "model",
    upstreamModel: "model",
  });
  const modelId = (await providers.getProviderDetail("default", provider.id))!
    .models[0].id;
  const outcomes = await Promise.allSettled([
    providers.updateProvider("default", provider.id, { prefix: "new" }),
    providers.updateProvider("default", provider.id, { name: "Renamed" }),
    providers.updateProviderModel("default", provider.id, modelId, {
      name: "Renamed model",
    }),
    providers.createProviderModel("default", provider.id, {
      name: "Late model",
      gatewaySuffix: "late",
      upstreamModel: "late",
    }),
  ]);
  expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
    true,
  );
  const detail = await providers.getProviderDetail("default", provider.id);
  expect(detail).toMatchObject({ prefix: "new", name: "Renamed" });
  expect(detail?.models.map((model) => model.gatewayModelId)).toEqual([
    "new/late",
    "new/model",
  ]);
});

test("concurrent provider deletion cannot leave active orphan credentials or models", async () => {
  const provider = await providers.createProvider("default", {
    name: "Delete race",
    prefix: "delete-race",
    baseUrl: "https://example.test/v1",
    protocol: "openai-chat",
  });
  const outcomes = await Promise.allSettled([
    providers.deleteProvider("default", provider.id),
    providers.createProviderCredential("default", provider.id, {
      name: "orphan credential",
      key: "orphan-secret",
    }),
    providers.createProviderModel("default", provider.id, {
      name: "Orphan model",
      gatewaySuffix: "orphan",
      upstreamModel: "orphan",
    }),
  ]);
  expect(outcomes[0].status).toBe("fulfilled");
  const rows = await db.execute({
    sql: "SELECT status FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? UNION ALL SELECT status FROM provider_models WHERE workspace_id = ? AND provider_id = ?",
    args: ["default", provider.id, "default", provider.id],
  });
  expect(rows.rows.map((row) => String(row.status))).not.toContain("active");
  const replacement = await providers.createProvider("default", {
    name: "Replacement",
    prefix: "delete-race",
    baseUrl: "https://example.test/v1",
    protocol: "openai-chat",
  });
  await expect(
    providers.createProviderModel("default", replacement.id, {
      name: "Replacement model",
      gatewaySuffix: "orphan",
      upstreamModel: "orphan",
    }),
  ).resolves.toMatchObject({ gatewayModelId: "delete-race/orphan" });
});

test("child deletion rolls back when its desired-revision update fails", async () => {
  const provider = await providers.createProvider("default", {
    name: "Revision",
    prefix: "revision",
    baseUrl: "https://example.test/v1",
    protocol: "openai-chat",
  });
  const model = await providers.createProviderModel("default", provider.id, {
    name: "Model",
    gatewaySuffix: "model",
    upstreamModel: "model",
  });
  const descriptor = Object.getOwnPropertyDescriptor(db, "transaction");
  const originalTransaction = db.transaction;
  let failed = false;
  Object.defineProperty(db, "transaction", {
    configurable: true,
    writable: true,
    value: new Proxy(originalTransaction, {
      async apply(target, thisArg, args) {
        const transaction = await Reflect.apply(target, thisArg, args);
        const originalExecute = transaction.execute;
        transaction.execute = new Proxy(originalExecute, {
          async apply(executeTarget, executeThisArg, executeArgs) {
            if (
              !failed &&
              statementSql(executeArgs[0]).startsWith(
                "UPDATE providers SET desired_revision",
              )
            ) {
              failed = true;
              throw new Error("injected revision failure");
            }
            return await Reflect.apply(
              executeTarget,
              executeThisArg,
              executeArgs,
            );
          },
        });
        return transaction;
      },
    }),
  });
  try {
    await expect(
      providers.deleteProviderModel("default", provider.id, model.id),
    ).rejects.toThrow("injected revision failure");
  } finally {
    if (descriptor) Object.defineProperty(db, "transaction", descriptor);
    else Reflect.deleteProperty(db, "transaction");
  }
  expect(
    (await providers.getProviderDetail("default", provider.id))?.models,
  ).toHaveLength(1);
  expect(
    (await providers.getProviderDetail("default", provider.id))
      ?.desiredRevision,
  ).toBe(2);
  await providers.deleteProviderModel("default", provider.id, model.id);
  expect(
    (await providers.getProviderDetail("default", provider.id))
      ?.desiredRevision,
  ).toBe(3);
});

test("provider credential master fails closed when ciphertext exists but its persisted key is missing", async () => {
  const provider = await providers.createProvider("default", {
    name: "Fail closed",
    prefix: "closed",
    baseUrl: "https://example.test/v1",
    protocol: "openai-chat",
    authType: "bearer",
  });
  await providers.createProviderCredential("default", provider.id, {
    name: "secret",
    key: "never-return-this",
  });
  const raw = createClient({ url: `file:${databasePath}` });
  const rows = await raw.execute(
    "SELECT encrypted_secret FROM provider_credentials LIMIT 1",
  );
  expect(String(rows.rows[0]?.encrypted_secret)).toMatch(/^v1\./);
  raw.close();
  const master = providers.providerCredentialMasterPath();
  const saved = `${master}.saved`;
  fs.renameSync(master, saved);
  try {
    const child = Bun.spawn([process.execPath, "./providers.master-child.ts"], {
      cwd: import.meta.dir,
      env: {
        ...Bun.env,
        NODE_ENV: "development",
        APP_ORIGIN: "",
        AUTH_DEFAULT_PASSWORD: DEFAULT_PASSWORD,
        DATABASE_URL: `file:${databasePath}`,
        RAWROUTE_DATA_DIR: dataDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("master key is missing");
  } finally {
    fs.renameSync(saved, master);
  }
});

test("scoped provider HTTP APIs are no-store, redact credentials, and reject cross-workspace IDs", async () => {
  const token = await administrator();
  expect(
    (
      await providerHttp.postProvider(
        request("/api/providers", {
          body: JSON.stringify({
            provider: {
              name: "Denied",
              prefix: "denied",
              baseUrl: "https://example.test",
              protocol: "openai-chat",
            },
          }),
          workspaceId: "default",
        }),
      )
    ).status,
  ).toBe(401);
  const created = await providerHttp.postProvider(
    request("/api/providers", {
      body: JSON.stringify({
        provider: {
          name: "HTTP OpenAI",
          prefix: "http-openai",
          baseUrl: "https://example.test/v1",
          protocol: "openai-chat",
          authType: "bearer",
          headers: { "x-region": "test" },
        },
      }),
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("no-store");
  const provider = ((await created.json()) as { provider: { id: string } })
    .provider;
  const projectionStatus = await providerHttp.getProviderSync(
    request(`/api/providers/${provider.id}/sync`, {
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(projectionStatus.status).toBe(200);
  expect(await projectionStatus.json()).toMatchObject({
    sync: {
      providerId: provider.id,
      desiredRevision: 1,
      state: "error",
      error: "CLIProxy management is unavailable.",
    },
  });
  const credential = await providerHttp.postProviderCredential(
    request(`/api/providers/${provider.id}/credentials`, {
      body: JSON.stringify({
        credential: { name: "HTTP secret", key: "not-in-a-response" },
      }),
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(credential.status).toBe(201);
  expect(JSON.stringify(await credential.json())).not.toContain(
    "not-in-a-response",
  );
  const detail = await providerHttp.getProvider(
    request(`/api/providers/${provider.id}`, {
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(JSON.stringify(await detail.json())).toContain("__unchanged__");
  const other = await workspaces.createWorkspace("HTTP other");
  expect(
    (
      await providerHttp.getProvider(
        request(`/api/providers/${provider.id}`, {
          sessionToken: token,
          workspaceId: other.id,
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await providerHttp.postProviderModel(
        request(`/api/providers/${provider.id}/models`, {
          body: JSON.stringify({
            model: {
              name: "Test",
              gatewaySuffix: "test",
              upstreamModel: "upstream-test",
            },
          }),
          sessionToken: token,
          workspaceId: "default",
        }),
      )
    ).status,
  ).toBe(201);
  const aggregateModels = await providerHttp.getProviderModels(
    request("/api/providers/models", {
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(aggregateModels.status).toBe(200);
  expect(await aggregateModels.json()).toMatchObject({
    models: [{ providerId: provider.id, gatewayModelId: "http-openai/test" }],
  });
  expect(
    (
      await providerHttp.postProviderCredentialReorder(
        request(`/api/providers/${provider.id}/credentials/reorder`, {
          body: JSON.stringify({ orderedIds: [] }),
          sessionToken: token,
          workspaceId: "default",
        }),
      )
    ).status,
  ).toBe(409);
  const deleted = await providerHttp.deleteProviderHttp(
    request(`/api/providers/${provider.id}`, {
      method: "DELETE",
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({
    deleted: true,
    sync: {
      providerId: provider.id,
      deleted: true,
      state: "cleanup-error",
      error: "CLIProxy management is unavailable.",
    },
  });
  const tombstoneStatus = await providerHttp.getProviderSync(
    request(`/api/providers/${provider.id}/sync`, {
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(await tombstoneStatus.json()).toMatchObject({
    sync: { providerId: provider.id, deleted: true, state: "cleanup-error" },
  });
  const cleanup = await providerHttp.getProviderCleanup(
    request("/api/providers/cleanup", {
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(cleanup.status).toBe(200);
  expect(await cleanup.json()).toMatchObject({
    cleanup: [
      { providerId: provider.id, deleted: true, state: "cleanup-error" },
    ],
  });
  const otherCleanup = await providerHttp.getProviderCleanup(
    request("/api/providers/cleanup", {
      sessionToken: token,
      workspaceId: other.id,
    }),
  );
  expect(otherCleanup.status).toBe(200);
  expect(await otherCleanup.json()).toEqual({ cleanup: [] });
  const retried = await providerHttp.postProviderSyncRetry(
    request(`/api/providers/${provider.id}/sync`, {
      method: "POST",
      sessionToken: token,
      workspaceId: "default",
    }),
  );
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({
    sync: { providerId: provider.id, deleted: true, state: "cleanup-error" },
  });
});
