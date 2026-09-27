import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunRequest } from "bun";

const DEFAULT_PASSWORD = "phase2a-http-test-password";
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = DEFAULT_PASSWORD;
Bun.env.DATABASE_URL = `file:/tmp/opencode/rawroute-auth-test-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-auth-data-${crypto.randomUUID()}`;

const { db: testDb } = await import("./db");
const auth = await import("./auth");
const { env } = await import("./env");
const { cliproxyStatus } = await import("./cliproxy/http");
const { clearGlobalLogs, readGlobalLogs, reportBrowserEvent } = await import("./logging/http");
const { logs } = await import("./logging/store");
const { ensureWorkspaceSchema } = await import("./workspaces");

type TestRequest = BunRequest & {
  readSessionToken: () => string | null;
  sessionWasCleared: () => boolean;
};

function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string | null;
    origin?: string | null;
    fetchSite?: string;
    forwardedFor?: string;
    connectingIp?: string;
    sessionToken?: string | null;
    workspaceId?: string;
  } = {},
): TestRequest {
  const headers = new Headers();
  if (options.contentType !== null && (options.body !== undefined || options.contentType)) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "http://localhost:3001");
  }
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  if (options.forwardedFor) headers.set("x-forwarded-for", options.forwardedFor);
  if (options.connectingIp) headers.set("cf-connecting-ip", options.connectingIp);
  if (options.workspaceId) headers.set("x-rawroute-workspace-id", options.workspaceId);

  const request = new Request(`http://localhost:3001${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body,
  }) as TestRequest;
  let sessionToken = options.sessionToken ?? null;
  let cleared = false;

  Object.defineProperty(request, "cookies", {
    value: {
      get: (name: string) => (name === "rawroute_session" ? sessionToken ?? undefined : undefined),
      set: (name: string, value: string) => {
        if (name === "rawroute_session") sessionToken = value;
      },
      delete: (name: string) => {
        if (name === "rawroute_session") {
          sessionToken = null;
          cleared = true;
        }
      },
    },
  });
  request.readSessionToken = () => sessionToken;
  request.sessionWasCleared = () => cleared;
  return request;
}

async function login(
  password = DEFAULT_PASSWORD,
  peerAddress?: string | null,
): Promise<{ token: string; response: Response }> {
  const request = makeRequest("/api/auth/login", { body: JSON.stringify({ password }) });
  const response = peerAddress === undefined
    ? await auth.login(request)
    : await auth.loginFromPeer(request, peerAddress);
  return { token: request.readSessionToken() ?? "", response };
}

function passwordRequest(
  sessionToken: string,
  currentPassword: string | undefined,
  newPassword: string,
  overrides: Parameters<typeof makeRequest>[1] = {},
): TestRequest {
  return makeRequest("/api/auth/password", {
    body: JSON.stringify({
      ...(currentPassword === undefined ? {} : { currentPassword }),
      newPassword,
    }),
    sessionToken,
    ...overrides,
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
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
  const descriptor = Object.getOwnPropertyDescriptor(testDb, "execute");
  const original = testDb.execute;
  const wrapped = new Proxy(original, {
    apply(target, thisArg, args) {
      return intercept(statementSql(args[0]), async () => await Reflect.apply(target, thisArg, args));
    },
  });

  Object.defineProperty(testDb, "execute", {
    configurable: true,
    writable: true,
    value: wrapped,
  });

  return () => {
    if (descriptor) Object.defineProperty(testDb, "execute", descriptor);
    else Reflect.deleteProperty(testDb, "execute");
  };
}

function interceptBatch(
  intercept: (statements: unknown[], run: () => Promise<unknown>) => Promise<unknown>,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(testDb, "batch");
  const original = testDb.batch;
  const wrapped = new Proxy(original, {
    apply(target, thisArg, args) {
      const statements = Array.isArray(args[0]) ? args[0] : [];
      return intercept(statements, async () => await Reflect.apply(target, thisArg, args));
    },
  });

  Object.defineProperty(testDb, "batch", {
    configurable: true,
    writable: true,
    value: wrapped,
  });

  return () => {
    if (descriptor) Object.defineProperty(testDb, "batch", descriptor);
    else Reflect.deleteProperty(testDb, "batch");
  };
}

beforeAll(async () => {
  await auth.ensureAuthSchema();
  await ensureWorkspaceSchema();
});

beforeEach(async () => {
  await testDb.execute("DELETE FROM auth_sessions");
  await testDb.execute("DELETE FROM auth_credentials");
  await auth.ensureDefaultPassword();
});

afterAll(async () => {
  await testDb.execute("DELETE FROM auth_sessions");
  await testDb.execute("DELETE FROM auth_credentials");
});

test("concurrent first-start initialization inserts one default credential", async () => {
  await testDb.execute("DELETE FROM auth_sessions");
  await testDb.execute("DELETE FROM auth_credentials");

  let selects = 0;
  let bothSelected!: () => void;
  let releaseSelects!: () => void;
  const bothSelectedPromise = new Promise<void>((resolve) => {
    bothSelected = resolve;
  });
  const selectGate = new Promise<void>((resolve) => {
    releaseSelects = resolve;
  });
  const restore = interceptExecute(async (sql, run) => {
    const result = await run();
    if (sql.includes("SELECT password_hash, is_default FROM auth_credentials")) {
      selects += 1;
      if (selects === 2) bothSelected();
      await selectGate;
    }
    return result;
  });

  try {
    const first = auth.ensureDefaultPassword();
    const second = auth.ensureDefaultPassword();
    await bothSelectedPromise;
    releaseSelects();
    await Promise.all([first, second]);
  } finally {
    releaseSelects();
    restore();
  }

  const credentials = await testDb.execute("SELECT id FROM auth_credentials");
  expect(credentials.rows).toHaveLength(1);
  expect((await login()).response.status).toBe(200);
});

test("login limits use socket peers by default and trusted forwarding headers when enabled", async () => {
  const wrongPassword = "not-the-default-password";
  const spoofedForwardedFor = "203.0.113.8";
  const requestFor = (forwardedFor = spoofedForwardedFor) =>
    makeRequest("/api/auth/login", {
      body: JSON.stringify({ password: wrongPassword }),
      forwardedFor,
    });

  for (let index = 0; index < 5; index++) {
    expect((await auth.loginFromPeer(requestFor(), "198.51.100.10")).status).toBe(401);
  }
  // With proxy headers untrusted, a spoofed shared header cannot merge socket clients.
  expect((await auth.loginFromPeer(requestFor(), "198.51.100.11")).status).toBe(401);

  const mutableEnv = env as { trustProxyHeaders: boolean };
  const originalTrustProxyHeaders = mutableEnv.trustProxyHeaders;
  mutableEnv.trustProxyHeaders = true;
  try {
    for (let index = 0; index < 5; index++) {
      expect((await auth.loginFromPeer(requestFor("203.0.113.9"), "198.51.100.12")).status).toBe(401);
    }
    // Once explicitly trusted, the forwarded client is the limiter key across proxies.
    expect((await auth.loginFromPeer(requestFor("203.0.113.9"), "198.51.100.13")).status).toBe(429);
  } finally {
    mutableEnv.trustProxyHeaders = originalTrustProxyHeaders;
  }
});

test("concurrent invalid logins reserve the per-client failure budget before verification", async () => {
  let passwordRecordReads = 0;
  let fifthRead!: () => void;
  let releaseReads!: () => void;
  const fifthReadPromise = new Promise<void>((resolve) => {
    fifthRead = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const restore = interceptExecute(async (sql, run) => {
    if (sql.includes("SELECT password_hash, is_default FROM auth_credentials")) {
      passwordRecordReads += 1;
      if (passwordRecordReads === 5) fifthRead();
      await readGate;
    }
    return await run();
  });

  try {
    const attempts = Array.from({ length: 12 }, () =>
      auth.loginFromPeer(
        makeRequest("/api/auth/login", { body: JSON.stringify({ password: "not-the-default-password" }) }),
        "198.51.100.20",
      ),
    );
    await fifthReadPromise;
    releaseReads();
    const statuses = (await Promise.all(attempts)).map((response) => response.status).sort();
    expect(passwordRecordReads).toBe(5);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);
  } finally {
    releaseReads();
    restore();
  }
});

test("startup password synchronization cannot overwrite a concurrent rotation", async () => {
  const previousDefaultPassword = "PreviousDefaultPassword!123";
  await testDb.execute({
    sql: "UPDATE auth_credentials SET password_hash = ?, is_default = 1, updated_at = ? WHERE id = 1",
    args: [await Bun.password.hash(previousDefaultPassword), Date.now()],
  });

  let updateReached!: () => void;
  let releaseUpdate!: () => void;
  const updateReachedPromise = new Promise<void>((resolve) => {
    updateReached = resolve;
  });
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  let updatePaused = false;
  const restore = interceptBatch(async (statements, run) => {
    if (
      !updatePaused &&
      statements.some((statement) => {
        const sql = statementSql(statement);
        return sql.includes("UPDATE auth_credentials") && sql.includes("is_default = 1");
      })
    ) {
      updatePaused = true;
      updateReached();
      await updateGate;
    }
    return run();
  });

  try {
    const startup = auth.ensureDefaultPassword();
    await updateReachedPromise;
    const session = await login(previousDefaultPassword);
    expect(session.response.status).toBe(200);
    const changed = await auth.changePassword(
      passwordRequest(session.token, previousDefaultPassword, "A-new-stronger-password-1"),
    );
    expect(changed.status).toBe(200);

    releaseUpdate();
    await startup;
  } finally {
    releaseUpdate();
    restore();
  }

  expect((await login()).response.status).toBe(401);
  expect((await login("A-new-stronger-password-1")).response.status).toBe(200);
});

test("configured default rotation revokes sessions issued for the previous default", async () => {
  const previousDefaultPassword = "PreviousDefaultPassword!123";
  await testDb.execute({
    sql: "UPDATE auth_credentials SET password_hash = ?, is_default = 1, updated_at = ? WHERE id = 1",
    args: [await Bun.password.hash(previousDefaultPassword), Date.now()],
  });
  const oldSession = await login(previousDefaultPassword);
  expect(oldSession.response.status).toBe(200);

  await auth.ensureDefaultPassword();

  const status = await responseBody(await auth.status(makeRequest("/api/auth/status", {
    sessionToken: oldSession.token,
  })));
  expect(status).toMatchObject({ authenticated: false, isDefaultPassword: true });

  const changed = await auth.changePassword(
    passwordRequest(oldSession.token, undefined, "A-new-stronger-password-1"),
  );
  expect(changed.status).toBe(401);
  expect((await login(previousDefaultPassword)).response.status).toBe(401);
  expect((await login()).response.status).toBe(200);
});

test("management gate reads session and default state from one snapshot during rotation", async () => {
  const session = await login();
  let sessionRead!: () => void;
  let releaseSessionRead!: () => void;
  const sessionReadPromise = new Promise<void>((resolve) => {
    sessionRead = resolve;
  });
  const sessionReadGate = new Promise<void>((resolve) => {
    releaseSessionRead = resolve;
  });
  let queryPaused = false;
  let sessionQuery = "";
  const restore = interceptExecute(async (sql, run) => {
    const result = await run();
    if (!queryPaused && sql.includes("FROM auth_sessions")) {
      queryPaused = true;
      sessionQuery = sql;
      sessionRead();
      await sessionReadGate;
    }
    return result;
  });

  try {
    const managementRequest = cliproxyStatus(makeRequest("/api/cliproxy/status", {
      sessionToken: session.token,
    }));
    await sessionReadPromise;

    const changed = await auth.changePassword(
      passwordRequest(session.token, DEFAULT_PASSWORD, "A-new-stronger-password-1"),
    );
    expect(changed.status).toBe(200);

    releaseSessionRead();
    const response = await managementRequest;
    expect(sessionQuery).toContain("JOIN auth_credentials");
    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({ error: "Change password required" });
  } finally {
    releaseSessionRead();
    restore();
  }
});

test("development hint remains until the initial password is changed", async () => {
  const status = await responseBody(await auth.status(makeRequest("/api/auth/status")));
  expect(status).toMatchObject({
    authenticated: false,
    hasPassword: true,
    isDefaultPassword: true,
    defaultPasswordHint: DEFAULT_PASSWORD,
  });

  const session = await login();
  expect(session.response.status).toBe(200);
  expect(await responseBody(session.response)).toMatchObject({
    authenticated: true,
    isDefaultPassword: true,
    defaultPasswordHint: DEFAULT_PASSWORD,
  });

  const blocked = await cliproxyStatus(makeRequest("/api/cliproxy/status", {
    sessionToken: session.token,
  }));
  expect(blocked.status).toBe(403);
  expect(await responseBody(blocked)).toEqual({ error: "Change password required" });
});

test("development preview can hide the initial password value without losing the hint state", async () => {
  Bun.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT = "false";
  try {
    const response = await responseBody(await auth.status(makeRequest("/api/auth/status")));
    expect(response).toMatchObject({ isDefaultPassword: true, defaultPasswordHint: null });
  } finally {
    delete Bun.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT;
  }
});

test("wrong current password does not rotate or invalidate the session", async () => {
  const session = await login();
  const response = await auth.changePassword(
    passwordRequest(session.token, "not-the-current-password", "A-new-stronger-password-1"),
  );

  expect(response.status).toBe(401);
  expect((await responseBody(response)).error).toBe("Current password is incorrect.");
  const status = await responseBody(await auth.status(makeRequest("/api/auth/status", {
    sessionToken: session.token,
  })));
  expect(status).toMatchObject({ authenticated: true, isDefaultPassword: true });
});

test("password rotation revokes every session and survives default-password initialization", async () => {
  const firstSession = await login();
  const secondSession = await login();
  const changedRequest = passwordRequest(
    firstSession.token,
    DEFAULT_PASSWORD,
    "A-new-stronger-password-1",
  );
  const changed = await auth.changePassword(changedRequest);

  expect(changed.status).toBe(200);
  expect(await responseBody(changed)).toEqual({
    success: true,
    authenticated: false,
    requiresLogin: true,
  });
  expect(changedRequest.sessionWasCleared()).toBe(true);

  for (const token of [firstSession.token, secondSession.token]) {
    const status = await responseBody(await auth.status(makeRequest("/api/auth/status", {
      sessionToken: token,
    })));
    expect(status).toMatchObject({ authenticated: false, isDefaultPassword: false, defaultPasswordHint: null });
  }

  await auth.ensureDefaultPassword();
  expect((await login()).response.status).toBe(401);
  const newLogin = await login("A-new-stronger-password-1");
  expect(newLogin.response.status).toBe(200);
  expect((await responseBody(newLogin.response)).isDefaultPassword).toBe(false);

  const management = await cliproxyStatus(makeRequest("/api/cliproxy/status", {
    sessionToken: newLogin.token,
  }));
  expect(management.status).toBe(200);
});

test("initial default-password change does not require submitting the current password", async () => {
  const session = await login();
  const newPassword = "A-new-stronger-password-1";
  const request = passwordRequest(session.token, undefined, newPassword);
  const changed = await auth.changePassword(request);

  expect(changed.status).toBe(200);
  expect(await responseBody(changed)).toEqual({
    success: true,
    authenticated: false,
    requiresLogin: true,
  });
  expect(request.sessionWasCleared()).toBe(true);
  expect((await login()).response.status).toBe(401);
  expect((await login(newPassword)).response.status).toBe(200);
});

test("password can be rotated again after the initial forced change", async () => {
  const initialSession = await login();
  const firstPassword = "A-new-stronger-password-1";
  const firstChange = await auth.changePassword(
    passwordRequest(initialSession.token, DEFAULT_PASSWORD, firstPassword),
  );
  expect(firstChange.status).toBe(200);

  const secondSession = await login(firstPassword);
  const secondPassword = "Another-strong-password-2";
  const missingCurrentPassword = await auth.changePassword(
    passwordRequest(secondSession.token, undefined, secondPassword),
  );
  expect(missingCurrentPassword.status).toBe(400);
  expect((await responseBody(missingCurrentPassword)).error).toBe("Current password is required.");

  const secondChange = await auth.changePassword(
    passwordRequest(secondSession.token, firstPassword, secondPassword),
  );
  expect(secondChange.status).toBe(200);
  expect((await responseBody(await auth.status(makeRequest("/api/auth/status")))).isDefaultPassword).toBe(false);

  expect((await login(firstPassword)).response.status).toBe(401);
  expect((await login(secondPassword)).response.status).toBe(200);
});

test("password endpoint enforces origin, JSON, bounded bodies, and new-password validation", async () => {
  const session = await login();
  const options = {
    sessionToken: session.token,
    currentPassword: DEFAULT_PASSWORD,
    newPassword: "A-new-stronger-password-1",
  };
  const cases: Array<[Parameters<typeof makeRequest>[1], number]> = [
    [{ origin: null }, 403],
    [{ origin: "https://other.example" }, 403],
    [{ fetchSite: "cross-site" }, 403],
    [{ contentType: "text/plain" }, 415],
    [{ body: "{", contentType: "application/json" }, 400],
    [{ body: JSON.stringify({ currentPassword: DEFAULT_PASSWORD }) }, 400],
    [{ body: "x".repeat(16 * 1024 + 1) }, 413],
    [{ body: JSON.stringify({ currentPassword: DEFAULT_PASSWORD, newPassword: "short" }) }, 400],
    [{ body: JSON.stringify({ currentPassword: DEFAULT_PASSWORD, newPassword: "contains whitespace 1" }) }, 400],
    [{ body: JSON.stringify({ currentPassword: DEFAULT_PASSWORD, newPassword: "aaaaaaaaaaaaaaaa" }) }, 400],
    [{ body: JSON.stringify({ currentPassword: DEFAULT_PASSWORD, newPassword: "abcdefghijkl" }) }, 400],
    [{ body: JSON.stringify({ currentPassword: DEFAULT_PASSWORD, newPassword: DEFAULT_PASSWORD }) }, 400],
  ];

  for (const [override, expectedStatus] of cases) {
    const request = makeRequest("/api/auth/password", {
      body: JSON.stringify({ currentPassword: options.currentPassword, newPassword: options.newPassword }),
      sessionToken: options.sessionToken,
      ...override,
    });
    expect((await auth.changePassword(request)).status).toBe(expectedStatus);
  }
});

test("password change requires an authenticated session", async () => {
  const response = await auth.changePassword(
    passwordRequest("missing-session", DEFAULT_PASSWORD, "A-new-stronger-password-1"),
  );
  expect(response.status).toBe(401);
});

test("console history requires a non-default session and same-origin mutations", async () => {
  logs.clear();
  logs.record({ source: "test", event: "test.private", message: "Private administrator event" });
  expect((await readGlobalLogs(makeRequest("/api/logs/global"))).status).toBe(401);
  const initial = await login();
  expect((await readGlobalLogs(makeRequest("/api/logs/global", { sessionToken: initial.token }))).status).toBe(403);
  await auth.changePassword(passwordRequest(initial.token, DEFAULT_PASSWORD, "Log-test-strong-password-1"));
  const session = await login("Log-test-strong-password-1");
  const response = await readGlobalLogs(makeRequest("/api/logs/global", { sessionToken: session.token }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await responseBody(response))).toContain("Private administrator event");
  for (const origin of [null, "https://other.example"]) {
    expect((await clearGlobalLogs(makeRequest("/api/logs/global", { method: "DELETE", origin, sessionToken: session.token }))).status).toBe(403);
  }
  expect(logs.snapshot().entries).toHaveLength(1);
  const cleared = await clearGlobalLogs(makeRequest("/api/logs/global", { method: "DELETE", sessionToken: session.token }));
  expect(cleared.status).toBe(200);
  expect(logs.snapshot().entries.map((entry) => entry.event)).toEqual(["logs.cleared"]);
  await auth.logout(makeRequest("/api/auth/logout", { method: "POST", sessionToken: session.token }));
  expect((await readGlobalLogs(makeRequest("/api/logs/global", { sessionToken: session.token }))).status).toBe(401);
});

test("browser event intake rejects forged messages, secrets, invalid types and oversized bodies", async () => {
  const initial = await login();
  await auth.changePassword(passwordRequest(initial.token, DEFAULT_PASSWORD, "Log-test-strong-password-1"));
  const session = await login("Log-test-strong-password-1");
  logs.clear();
  for (const body of [
    "{", "x".repeat(1025),
    JSON.stringify({ event: "auth.login" }),
    JSON.stringify({ event: "toString" }),
    JSON.stringify({ event: "providers.changed", message: "secret" }),
    JSON.stringify({ event: "providers.changed", added: "secret" }),
    JSON.stringify({ event: "providers.changed", added: -1 }),
    JSON.stringify({ event: "providers.changed", page: "secret" }),
  ]) {
    expect((await reportBrowserEvent(makeRequest("/api/logs/events", { sessionToken: session.token, body }))).status).toBe(400);
  }
  expect(logs.snapshot().entries).toHaveLength(0);
  const report = () => makeRequest("/api/logs/events", {
    sessionToken: session.token,
    workspaceId: "default",
    body: JSON.stringify({ event: "gateway-key.copied", page: "endpoint", added: 1 }),
  });
  expect((await reportBrowserEvent(report())).status).toBe(200);
  expect(logs.snapshot({ kind: "workspace", workspaceId: "default" }).entries[0]).toMatchObject({ event: "gateway-key.copied", origin: "browser", scope: "workspace", workspaceId: "default", details: { added: 1 } });
  for (let index = 0; index < 120; index++) await reportBrowserEvent(report());
  expect((await reportBrowserEvent(report())).status).toBe(429);
});
