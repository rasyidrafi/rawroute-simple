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
const { cliproxyStatus } = await import("./cliproxy/http");

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
    sessionToken?: string | null;
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

async function login(password = DEFAULT_PASSWORD): Promise<{ token: string; response: Response }> {
  const request = makeRequest("/api/auth/login", { body: JSON.stringify({ password }) });
  const response = await auth.login(request);
  return { token: request.readSessionToken() ?? "", response };
}

function passwordRequest(
  sessionToken: string,
  currentPassword: string,
  newPassword: string,
  overrides: Parameters<typeof makeRequest>[1] = {},
): TestRequest {
  return makeRequest("/api/auth/password", {
    body: JSON.stringify({ currentPassword, newPassword }),
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

beforeAll(async () => {
  await auth.ensureAuthSchema();
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
  const restore = interceptExecute(async (sql, run) => {
    if (!updatePaused && sql.includes("UPDATE auth_credentials") && sql.includes("is_default = 1")) {
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

test("password can be rotated again after the initial forced change", async () => {
  const initialSession = await login();
  const firstPassword = "A-new-stronger-password-1";
  const firstChange = await auth.changePassword(
    passwordRequest(initialSession.token, DEFAULT_PASSWORD, firstPassword),
  );
  expect(firstChange.status).toBe(200);

  const secondSession = await login(firstPassword);
  const secondPassword = "Another-strong-password-2";
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
