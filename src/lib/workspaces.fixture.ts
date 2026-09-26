import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunRequest } from "bun";

const DEFAULT_PASSWORD = "workspace-test-default-password";
const CHANGED_PASSWORD = "Workspace-test-strong-password-1";
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = DEFAULT_PASSWORD;
Bun.env.DATABASE_URL = `file:/tmp/opencode/rawroute-workspaces-test-${crypto.randomUUID()}.db`;

const { db } = await import("./db");
const auth = await import("./auth");
const scopes = await import("./request-scope");
const workspaceHttp = await import("./workspaces-http");
const workspaces = await import("./workspaces");
const logHttp = await import("./logging/http");
const { logs } = await import("./logging/store");

type TestRequest = BunRequest & { readSessionToken: () => string | null };

function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: string;
    origin?: string | null;
    fetchSite?: string;
    sessionToken?: string | null;
    workspaceId?: string;
  } = {},
): TestRequest {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.origin !== null) headers.set("origin", options.origin ?? "http://localhost:3001");
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  if (options.workspaceId !== undefined) headers.set(scopes.WORKSPACE_ID_HEADER, options.workspaceId);
  const request = new Request(`http://localhost:3001${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body,
  }) as TestRequest;
  let sessionToken = options.sessionToken ?? null;
  Object.defineProperty(request, "cookies", {
    value: {
      get: (name: string) => (name === "rawroute_session" ? sessionToken ?? undefined : undefined),
      set: (name: string, value: string) => {
        if (name === "rawroute_session") sessionToken = value;
      },
      delete: (name: string) => {
        if (name === "rawroute_session") sessionToken = null;
      },
    },
  });
  request.readSessionToken = () => sessionToken;
  return request;
}

async function login(password = DEFAULT_PASSWORD): Promise<string> {
  const request = makeRequest("/api/auth/login", { body: JSON.stringify({ password }) });
  expect((await auth.login(request)).status).toBe(200);
  return request.readSessionToken() ?? "";
}

async function changedPasswordSession(): Promise<string> {
  const initialToken = await login();
  const changed = await auth.changePassword(makeRequest("/api/auth/password", {
    body: JSON.stringify({ newPassword: CHANGED_PASSWORD }),
    sessionToken: initialToken,
  }));
  expect(changed.status).toBe(200);
  return await login(CHANGED_PASSWORD);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function statementSql(statement: unknown): string {
  if (typeof statement === "string") return statement;
  if (typeof statement === "object" && statement !== null && "sql" in statement) {
    return typeof statement.sql === "string" ? statement.sql : "";
  }
  return "";
}

function interceptExecute(
  intercept: (sql: string, run: () => Promise<unknown>) => Promise<unknown>,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(db, "execute");
  const original = db.execute;
  const wrapped = new Proxy(original, {
    apply(target, thisArg, args) {
      return intercept(statementSql(args[0]), async () => await Reflect.apply(target, thisArg, args));
    },
  });
  Object.defineProperty(db, "execute", { configurable: true, writable: true, value: wrapped });
  return () => {
    if (descriptor) Object.defineProperty(db, "execute", descriptor);
    else Reflect.deleteProperty(db, "execute");
  };
}

beforeAll(async () => {
  await auth.ensureAuthSchema();
  await workspaces.ensureWorkspaceSchema();
});

beforeEach(async () => {
  await db.execute("DELETE FROM auth_sessions");
  await db.execute("DELETE FROM auth_credentials");
  await db.execute("DELETE FROM workspaces WHERE id <> 'default'");
  await db.execute({
    sql: `
      UPDATE workspaces
      SET name = 'Default', normalized_name = 'default', is_default = 1,
          status = 'active', deletion_token = NULL, updated_at = ?
      WHERE id = 'default'
    `,
    args: [Date.now()],
  });
  logs.clear();
  await auth.ensureDefaultPassword();
});

afterAll(async () => {
  await db.execute("DELETE FROM auth_sessions");
  await db.execute("DELETE FROM auth_credentials");
  await db.execute("DELETE FROM workspaces WHERE id <> 'default'");
});

test("workspace schema persists an immutable Default and normalized unique names", async () => {
  const initial = await workspaces.listWorkspaces();
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({ id: "default", name: "Default", isDefault: true, status: "active" });

  const created = await workspaces.createWorkspace("  Research  ");
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  await workspaces.ensureWorkspaceSchema();
  expect(await workspaces.getWorkspace(created.id)).toMatchObject({ name: "Research", isDefault: false });
  await expect(workspaces.createWorkspace("research")).rejects.toMatchObject({ status: 409 });
  await expect(workspaces.renameWorkspace("default", "Primary")).rejects.toMatchObject({ status: 409 });
  await expect(workspaces.deleteWorkspace("default", "Default")).rejects.toMatchObject({ status: 409 });
  await expect(workspaces.createWorkspace("invalid\nname")).rejects.toMatchObject({ status: 400 });
});

test("workspace request scope requires an explicit active header and never implies Default", async () => {
  const token = await changedPasswordSession();
  expect(scopes.currentWorkspaceScope()).toBeUndefined();

  await expect(scopes.requireWorkspaceRequestScope(makeRequest("/api/future", { sessionToken: token })))
    .rejects.toMatchObject({ status: 400, message: "Workspace scope is required." });
  await expect(scopes.requireWorkspaceRequestScope(makeRequest("/api/future", {
    sessionToken: token,
    workspaceId: "not-a-workspace",
  }))).rejects.toMatchObject({ status: 400, message: "Workspace scope is invalid." });
  await expect(scopes.requireWorkspaceRequestScope(makeRequest("/api/future", {
    sessionToken: token,
    workspaceId: crypto.randomUUID(),
  }))).rejects.toMatchObject({ status: 404, message: "Workspace not found." });

  const workspace = await workspaces.createWorkspace("Scoped");
  await db.execute({
    sql: "UPDATE workspaces SET status = 'deleting', deletion_token = ? WHERE id = ?",
    args: [crypto.randomUUID(), workspace.id],
  });
  await expect(scopes.requireWorkspaceRequestScope(makeRequest("/api/future", {
    sessionToken: token,
    workspaceId: workspace.id,
  }))).rejects.toMatchObject({ status: 409, message: "Workspace is unavailable." });
  expect(await workspaces.recoverInterruptedWorkspaceDeletions()).toBe(1);

  const scope = await scopes.requireWorkspaceRequestScope(makeRequest("/api/future", {
    sessionToken: token,
    workspaceId: workspace.id,
  }));
  expect(scope.workspace.id).toBe(workspace.id);
  await scopes.runWithWorkspaceScope(scope, async () => {
    expect(scopes.currentWorkspaceScope()?.workspace.id).toBe(workspace.id);
  });
  expect(scopes.currentWorkspaceScope()).toBeUndefined();
});

test("workspace management has global scope protections and ignores workspace headers", async () => {
  const unauthenticated = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "Denied" }),
  }));
  expect(unauthenticated.status).toBe(401);

  const initialToken = await login();
  const defaultPassword = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "Denied" }),
    sessionToken: initialToken,
  }));
  expect(defaultPassword.status).toBe(403);

  const token = await changedPasswordSession();
  const missingOrigin = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "Denied" }),
    origin: null,
    sessionToken: token,
  }));
  expect(missingOrigin.status).toBe(403);
  const wrongOrigin = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "Denied" }),
    origin: "https://other.example",
    sessionToken: token,
  }));
  expect(wrongOrigin.status).toBe(403);
  const crossSite = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "Denied" }),
    fetchSite: "cross-site",
    sessionToken: token,
  }));
  expect(crossSite.status).toBe(403);
  const oversized = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "a".repeat(4_096) }),
    sessionToken: token,
  }));
  expect(oversized.status).toBe(400);

  const created = await workspaceHttp.postWorkspace(makeRequest("/api/workspaces", {
    body: JSON.stringify({ name: "Console" }),
    sessionToken: token,
  }));
  expect(created.status).toBe(201);
  const createdWorkspace = (await body(created)).workspace as Record<string, unknown>;
  expect(createdWorkspace).toMatchObject({ name: "Console" });
  const workspaceId = String(createdWorkspace.id);

  const listed = await workspaceHttp.getWorkspaces(makeRequest("/api/workspaces", {
    sessionToken: token,
    workspaceId: "not-a-workspace",
  }));
  expect(listed.status).toBe(200);
  expect((await body(listed)).workspaces).toHaveLength(2);

  const renamed = await workspaceHttp.patchWorkspace(makeRequest(`/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Console Two" }),
    sessionToken: token,
  }));
  expect(renamed.status).toBe(200);
  expect((await body(renamed)).workspace).toMatchObject({ id: workspaceId, name: "Console Two" });

  const deleted = await workspaceHttp.deleteWorkspaceHttp(makeRequest(`/api/workspaces/${workspaceId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "Console Two" }),
    sessionToken: token,
  }));
  expect(deleted.status).toBe(204);
});

test("workspace console HTTP isolates snapshots, rejects spoofed scope, clears locally, and cleans deleted buffers", async () => {
  const token = await changedPasswordSession();
  const alpha = await workspaces.createWorkspace("Alpha logs");
  const beta = await workspaces.createWorkspace("Beta logs");
  const browserEvent = (workspaceId: string, event = "providers.changed") => makeRequest("/api/logs/events", {
    sessionToken: token,
    workspaceId,
    body: JSON.stringify({ event, added: 1 }),
  });

  expect((await logHttp.readLogs(makeRequest("/api/logs", { sessionToken: token }))).status).toBe(400);
  expect((await logHttp.readLogs(makeRequest("/api/logs", { sessionToken: token, workspaceId: crypto.randomUUID() }))).status).toBe(404);
  expect((await logHttp.reportBrowserEvent(makeRequest("/api/logs/events", {
    sessionToken: token, workspaceId: alpha.id, body: JSON.stringify({ event: "providers.changed", page: "endpoint" }),
  }))).status).toBe(400);
  expect((await logHttp.reportBrowserEvent(browserEvent(alpha.id))).status).toBe(200);
  expect((await logHttp.reportBrowserEvent(browserEvent(beta.id))).status).toBe(200);
  // A global-only event cannot be forced into a workspace merely by sending its header.
  expect((await logHttp.reportBrowserEvent(browserEvent(alpha.id, "gateway-key.copied"))).status).toBe(200);
  // Browser-global runtime errors have unknown provenance, while an explicit
  // page/header pair retains workspace attribution.
  expect((await logHttp.reportBrowserEvent(makeRequest("/api/logs/events", {
    sessionToken: token, body: JSON.stringify({ event: "dashboard.error" }),
  }))).status).toBe(200);
  expect((await logHttp.reportBrowserEvent(makeRequest("/api/logs/events", {
    sessionToken: token, workspaceId: alpha.id, body: JSON.stringify({ event: "dashboard.error", page: "providers" }),
  }))).status).toBe(200);

  const alphaSnapshot = await (await logHttp.readLogs(makeRequest("/api/logs", { sessionToken: token, workspaceId: alpha.id }))).json() as { entries: Array<{ workspaceId: string; event: string }> };
  const betaSnapshot = await (await logHttp.readLogs(makeRequest("/api/logs", { sessionToken: token, workspaceId: beta.id }))).json() as { entries: Array<{ workspaceId: string; event: string }> };
  expect(alphaSnapshot.entries).toHaveLength(2);
  expect(alphaSnapshot.entries.map((entry) => entry.event)).toEqual(["dashboard.error", "providers.changed"]);
  expect(alphaSnapshot.entries[0]).toMatchObject({ workspaceId: alpha.id });
  expect(betaSnapshot.entries).toHaveLength(1);
  expect(betaSnapshot.entries[0]).toMatchObject({ workspaceId: beta.id, event: "providers.changed" });
  expect(logs.snapshot().entries.map((entry) => entry.event)).toEqual(["dashboard.error", "gateway-key.copied"]);

  expect((await logHttp.clearLogs(makeRequest("/api/logs", { method: "DELETE", sessionToken: token, workspaceId: alpha.id }))).status).toBe(200);
  expect(logs.snapshot({ kind: "workspace", workspaceId: alpha.id }).entries.map((entry) => entry.event)).toEqual(["logs.cleared"]);
  expect(logs.snapshot({ kind: "workspace", workspaceId: beta.id }).entries).toHaveLength(1);

  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "workspace-logging-fixture",
    deleteWorkspaceData: (workspaceId) => logs.deleteWorkspace(workspaceId),
  });
  try {
    await workspaces.deleteWorkspace(beta.id, beta.name);
    expect(logs.snapshot({ kind: "workspace", workspaceId: beta.id }).entries).toHaveLength(0);
    expect((await logHttp.reportBrowserEvent(browserEvent(beta.id))).status).toBe(404);
  } finally {
    unregister();
  }
});

test("stale workspace lookup cannot recreate a cleared console after deletion", async () => {
  const token = await changedPasswordSession();
  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "workspace-logging-race-fixture",
    deleteWorkspaceData: (workspaceId) => logs.deleteWorkspace(workspaceId),
  });
  try {
    for (const operation of ["report", "clear"] as const) {
      const workspace = await workspaces.createWorkspace(`Stale ${operation}`);
      let lookupReached!: () => void;
      let releaseLookup!: () => void;
      const lookupPaused = new Promise<void>((resolve) => { lookupReached = resolve; });
      const lookupRelease = new Promise<void>((resolve) => { releaseLookup = resolve; });
      let paused = false;
      const restore = interceptExecute(async (sql, run) => {
        const result = await run();
        if (!paused && /FROM workspaces/i.test(sql) && /WHERE id = \?/i.test(sql)) {
          paused = true;
          lookupReached();
          await lookupRelease;
        }
        return result;
      });
      try {
        const pending = operation === "report"
          ? logHttp.reportBrowserEvent(makeRequest("/api/logs/events", {
            sessionToken: token, workspaceId: workspace.id, body: JSON.stringify({ event: "providers.changed", added: 1 }),
          }))
          : logHttp.clearLogs(makeRequest("/api/logs", { method: "DELETE", sessionToken: token, workspaceId: workspace.id }));
        await lookupPaused;
        await workspaces.deleteWorkspace(workspace.id, workspace.name);
        releaseLookup();
        expect((await pending).status).toBe(409);
        expect(logs.snapshot({ kind: "workspace", workspaceId: workspace.id }).entries).toHaveLength(0);
      } finally {
        releaseLookup();
        restore();
      }
    }
  } finally {
    unregister();
  }
});

test("a reserved admission rejects a stale second validation lookup while deletion drains it", async () => {
  const token = await changedPasswordSession();
  let cleanupRuns = 0;
  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "workspace-logging-second-lookup-fixture",
    deleteWorkspaceData: (workspaceId) => { cleanupRuns++; logs.deleteWorkspace(workspaceId); },
  });
  try {
    for (const operation of ["report", "clear"] as const) {
      const workspace = await workspaces.createWorkspace(`Second lookup ${operation}`);
      let releaseValidation!: () => void;
      let validationReached!: () => void;
      let deletionClaimed!: () => void;
      const validationPaused = new Promise<void>((resolve) => { validationReached = resolve; });
      const validationRelease = new Promise<void>((resolve) => { releaseValidation = resolve; });
      const deletionClaim = new Promise<void>((resolve) => { deletionClaimed = resolve; });
      let workspaceLookups = 0;
      const cleanupBefore = cleanupRuns;
      const restore = interceptExecute(async (sql, run) => {
        const result = await run();
        if (/UPDATE workspaces\s+SET status = 'deleting'/i.test(sql)) deletionClaimed();
        if (/FROM workspaces/i.test(sql) && /WHERE id = \?/i.test(sql) && ++workspaceLookups === 2) {
          validationReached();
          await validationRelease;
        }
        return result;
      });
      try {
        const pending = operation === "report"
          ? logHttp.reportBrowserEvent(makeRequest("/api/logs/events", {
            sessionToken: token, workspaceId: workspace.id, body: JSON.stringify({ event: "providers.changed", added: 1 }),
          }))
          : logHttp.clearLogs(makeRequest("/api/logs", { method: "DELETE", sessionToken: token, workspaceId: workspace.id }));
        await validationPaused;
        let deletionFinished = false;
        const deleting = workspaces.deleteWorkspace(workspace.id, workspace.name).then(() => { deletionFinished = true; });
        // The deletion has claimed the row and is waiting for this reservation;
        // release the gated validation instead of awaiting deletion first.
        await deletionClaim;
        await Promise.resolve();
        expect(deletionFinished).toBe(false);
        expect(cleanupRuns).toBe(cleanupBefore);
        releaseValidation();
        expect((await pending).status).toBe(409);
        await deleting;
        expect(logs.snapshot({ kind: "workspace", workspaceId: workspace.id }).entries).toHaveLength(0);
      } finally {
        releaseValidation();
        restore();
      }
    }
  } finally {
    unregister();
  }
});

test("deletion atomically excludes concurrent deletes and later removes the workspace", async () => {
  const workspace = await workspaces.createWorkspace("Concurrent");
  let cleanupStarted!: () => void;
  let releaseCleanup!: () => void;
  const cleanupStartedPromise = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const unregister = workspaces.registerWorkspaceDeletionExtension({
    name: "concurrent-test",
    deleteWorkspaceData: async () => {
      cleanupStarted();
      await cleanupGate;
    },
  });

  try {
    const firstDelete = workspaces.deleteWorkspace(workspace.id, workspace.name);
    await cleanupStartedPromise;
    expect((await workspaces.getWorkspace(workspace.id))?.status).toBe("deleting");
    await expect(workspaces.renameWorkspace(workspace.id, "Renamed")).rejects.toMatchObject({ status: 409 });
    await expect(workspaces.deleteWorkspace(workspace.id, workspace.name)).rejects.toMatchObject({ status: 409 });
    releaseCleanup();
    await firstDelete;
  } finally {
    releaseCleanup();
    unregister();
  }
  expect(await workspaces.getWorkspace(workspace.id)).toBeUndefined();
});

test("cleanup callbacks settle before a failed delete claim is released and can be retried", async () => {
  const workspace = await workspaces.createWorkspace("Cleanup retry");
  let cleanupStarted!: () => void;
  let releaseCleanup!: () => void;
  let slowCleanupFinished = false;
  const cleanupStartedPromise = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const unregisterSlow = workspaces.registerWorkspaceDeletionExtension({
    name: "slow-cleanup-test",
    deleteWorkspaceData: async () => {
      cleanupStarted();
      await cleanupGate;
      slowCleanupFinished = true;
    },
  });
  const unregisterSyncFailure = workspaces.registerWorkspaceDeletionExtension({
    name: "sync-cleanup-failure-test",
    deleteWorkspaceData: () => {
      throw new Error("sync cleanup failure");
    },
  });

  try {
    const deleting = workspaces.deleteWorkspace(workspace.id, workspace.name);
    await cleanupStartedPromise;
    await Promise.resolve();
    expect((await workspaces.getWorkspace(workspace.id))?.status).toBe("deleting");
    releaseCleanup();
    await expect(deleting).rejects.toMatchObject({ status: 503 });
    expect(slowCleanupFinished).toBe(true);
    expect((await workspaces.getWorkspace(workspace.id))?.status).toBe("active");
  } finally {
    releaseCleanup();
    unregisterSyncFailure();
    unregisterSlow();
  }

  await workspaces.deleteWorkspace(workspace.id, workspace.name);
  expect(await workspaces.getWorkspace(workspace.id)).toBeUndefined();
});

test("final delete failures release only their claim and support a later retry", async () => {
  const workspace = await workspaces.createWorkspace("Final retry");
  let failed = false;
  const restore = interceptExecute(async (sql, run) => {
    if (!failed && sql.includes("DELETE FROM workspaces WHERE id = ?")) {
      failed = true;
      throw new Error("temporary database failure");
    }
    return await run();
  });
  try {
    await expect(workspaces.deleteWorkspace(workspace.id, workspace.name)).rejects.toMatchObject({ status: 503 });
    expect((await workspaces.getWorkspace(workspace.id))?.status).toBe("active");
  } finally {
    restore();
  }

  await workspaces.deleteWorkspace(workspace.id, workspace.name);
  expect(await workspaces.getWorkspace(workspace.id)).toBeUndefined();
});
