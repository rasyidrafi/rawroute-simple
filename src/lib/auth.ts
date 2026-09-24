import type { BunRequest, CookieInit } from "bun";
import { db } from "./db";
import { env } from "./env";

const SESSION_COOKIE_NAME = "rawroute_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MIN_NEW_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const MAX_LOGIN_ATTEMPT_ENTRIES = 10_000;
const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000];
const FAIL_WINDOW_MS = 60 * 60 * 1000;

type PasswordRow = {
  password_hash: string;
  is_default: number;
};

type LoginAttempt = {
  fails: number;
  lockUntil: number;
  lockLevel: number;
  lastFailAt: number;
};

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const loginAttempts = new Map<string, LoginAttempt>();
const dummyPasswordHash = Bun.password.hash("rawroute-invalid-password");

export async function ensureAuthSchema(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    )
  `);

  const versionResult = await db.execute(
    "SELECT version FROM auth_schema_meta WHERE id = 1 LIMIT 1",
  );
  const versionRow = versionResult.rows[0] as unknown as { version: number } | undefined;
  const version = versionRow ? Number(versionRow.version) : 0;

  if (version < 2) {
    await db.batch(
      [
        { sql: "DROP TABLE IF EXISTS auth_sessions" },
        { sql: "DROP TABLE IF EXISTS auth_users" },
        { sql: "DROP TABLE IF EXISTS auth_credentials" },
        {
          sql: `
            CREATE TABLE auth_credentials (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              password_hash TEXT NOT NULL,
              is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
              updated_at INTEGER NOT NULL
            )
          `,
        },
        {
          sql: `
            CREATE TABLE auth_sessions (
              token_hash TEXT PRIMARY KEY NOT NULL,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            )
          `,
        },
        {
          sql: `
            CREATE INDEX auth_sessions_expires_at_idx
            ON auth_sessions(expires_at)
          `,
        },
        {
          sql: `
            INSERT INTO auth_schema_meta (id, version)
            VALUES (1, 2)
            ON CONFLICT(id) DO UPDATE SET version = excluded.version
          `,
        },
      ],
      "write",
    );
    return;
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT NOT NULL,
      is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
      updated_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
    ON auth_sessions(expires_at)
  `);
}

export async function ensureDefaultPassword(): Promise<void> {
  const password = env.authDefaultPassword;

  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `AUTH_DEFAULT_PASSWORD must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  const result = await db.execute(
    "SELECT password_hash, is_default FROM auth_credentials WHERE id = 1 LIMIT 1",
  );
  const existing = result.rows[0] as unknown as PasswordRow | undefined;

  if (existing) {
    const passwordMatches = await Bun.password.verify(password, existing.password_hash);
    if (passwordMatches || Number(existing.is_default) === 0) return;

    const updatedAt = Date.now();
    const passwordHash = await Bun.password.hash(password);
    await db.batch(
      [
        {
          sql: `
            UPDATE auth_credentials
            SET password_hash = ?, updated_at = ?
            WHERE id = 1 AND password_hash = ? AND is_default = 1
          `,
          args: [passwordHash, updatedAt, existing.password_hash],
        },
        {
          sql: `
            DELETE FROM auth_sessions
            WHERE EXISTS (
              SELECT 1 FROM auth_credentials
              WHERE id = 1 AND password_hash = ? AND updated_at = ?
            )
          `,
          args: [passwordHash, updatedAt],
        },
      ],
      "write",
    );
    return;
  }

  await db.execute({
    sql: `
      INSERT INTO auth_credentials (id, password_hash, is_default, updated_at)
      VALUES (1, ?, 1, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    args: [await Bun.password.hash(password), Date.now()],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPassword(request: BunRequest): Promise<string> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AuthError("Content-Type must be application/json.", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new AuthError("Content-Length is invalid.", 400);
    }
    if (Number(contentLength) > MAX_AUTH_BODY_BYTES) {
      throw new AuthError("Request body is too large.", 413);
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(request)) as unknown;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Request body must be valid JSON.", 400);
  }

  if (!isRecord(body) || typeof body.password !== "string") {
    throw new AuthError("Password is required.", 400);
  }

  if (body.password.length < MIN_PASSWORD_LENGTH || body.password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
      400,
    );
  }

  return body.password;
}

async function readPasswordChange(request: BunRequest): Promise<{ currentPassword?: string; newPassword: string }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AuthError("Content-Type must be application/json.", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new AuthError("Content-Length is invalid.", 400);
    }
    if (Number(contentLength) > MAX_AUTH_BODY_BYTES) {
      throw new AuthError("Request body is too large.", 413);
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(request)) as unknown;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Request body must be valid JSON.", 400);
  }

  if (
    !isRecord(body) ||
    typeof body.newPassword !== "string" ||
    Object.keys(body).some((key) => key !== "currentPassword" && key !== "newPassword") ||
    ("currentPassword" in body && typeof body.currentPassword !== "string")
  ) {
    throw new AuthError("Body must contain newPassword and optionally currentPassword.", 400);
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : undefined;
  if (currentPassword !== undefined && currentPassword.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError("Current password is invalid.", 400);
  }

  const normalizedNewPassword = body.newPassword.toLowerCase();
  if (
    body.newPassword.length < MIN_NEW_PASSWORD_LENGTH ||
    body.newPassword.length > MAX_PASSWORD_LENGTH ||
    /\s/u.test(body.newPassword) ||
    /^(.)\1+$/u.test(normalizedNewPassword) ||
    /^(.{1,8})\1+$/u.test(normalizedNewPassword) ||
    "abcdefghijklmnopqrstuvwxyz".includes(normalizedNewPassword) ||
    ["password123456", "123456789012", "qwertyuiop12", "letmeinplease"].includes(normalizedNewPassword)
  ) {
    throw new AuthError(
      `New password must be ${MIN_NEW_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters and not trivial or contain whitespace.`,
      400,
    );
  }

  return { currentPassword, newPassword: body.newPassword };
}

async function readBodyText(request: BunRequest): Promise<string> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_AUTH_BODY_BYTES) {
        await reader.cancel();
        throw new AuthError("Request body is too large.", 413);
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function assertSameOrigin(request: BunRequest, requireOrigin = false): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const expectedOrigin = env.appOrigin ?? new URL(request.url).origin;

  if (fetchSite === "cross-site" || (requireOrigin && !origin) || (origin && origin !== expectedOrigin)) {
    throw new AuthError("Invalid request origin.", 403);
  }
}

function getClientAddress(request: BunRequest): string {
  if (!env.trustProxyHeaders) return "unknown";

  return (
    request.headers.get("cf-connecting-ip")?.trim() ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    "unknown"
  );
}

function cleanupLoginAttempts(now: number): void {
  for (const [key, attempt] of loginAttempts) {
    if (attempt.lastFailAt + FAIL_WINDOW_MS <= now && attempt.lockUntil <= now) {
      loginAttempts.delete(key);
    }
  }

  if (loginAttempts.size <= MAX_LOGIN_ATTEMPT_ENTRIES) return;

  const oldestKey = loginAttempts.keys().next().value;
  if (oldestKey) loginAttempts.delete(oldestKey);
}

function checkLoginRateLimit(key: string): void {
  const now = Date.now();
  cleanupLoginAttempts(now);
  const attempt = loginAttempts.get(key);

  if (!attempt || attempt.lockUntil <= now) return;

  throw new AuthError(
    "Too many failed attempts. Try again later.",
    429,
    Math.ceil((attempt.lockUntil - now) / 1000),
  );
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt =
    current && current.lastFailAt + FAIL_WINDOW_MS > now
      ? current
      : { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };

  attempt.fails += 1;
  attempt.lastFailAt = now;

  if (attempt.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(attempt.lockLevel, LOCK_STEPS_MS.length - 1)];
    attempt.lockUntil = now + step;
    attempt.lockLevel += 1;
    attempt.fails = 0;
  }

  loginAttempts.set(key, attempt);
}

function clearFailedLogin(key: string): void {
  loginAttempts.delete(key);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

type SessionRecord = {
  token: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
};

async function buildSession(): Promise<SessionRecord> {
  const token = crypto.randomUUID();
  const createdAt = Date.now();

  return {
    token,
    tokenHash: await hashToken(token),
    createdAt,
    expiresAt: createdAt + SESSION_MAX_AGE_MS,
  };
}

async function saveSession(session: SessionRecord, passwordHash: string): Promise<void> {
  const results = await db.batch(
    [
      {
        sql: "DELETE FROM auth_sessions WHERE expires_at <= ?",
        args: [session.createdAt],
      },
      {
        sql: `
          INSERT INTO auth_sessions (token_hash, expires_at, created_at)
          SELECT ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM auth_credentials WHERE id = 1 AND password_hash = ?
          )
        `,
        args: [session.tokenHash, session.expiresAt, session.createdAt, passwordHash],
      },
    ],
    "write",
  );

  if (results[1]?.rowsAffected !== 1) {
    throw new AuthError("Invalid password.", 401);
  }
}

async function createSession(passwordHash: string): Promise<string> {
  const session = await buildSession();
  await saveSession(session, passwordHash);
  return session.token;
}

async function deleteSession(token: string | null): Promise<void> {
  if (!token) return;

  await db.execute({
    sql: "DELETE FROM auth_sessions WHERE token_hash = ?",
    args: [await hashToken(token)],
  });
}

async function getPasswordRecord(): Promise<PasswordRow | null> {
  const result = await db.execute(
    "SELECT password_hash, is_default FROM auth_credentials WHERE id = 1 LIMIT 1",
  );
  const row = result.rows[0] as unknown as PasswordRow | undefined;
  return row
    ? { password_hash: String(row.password_hash), is_default: Number(row.is_default) }
    : null;
}

function defaultPasswordHint(passwordRecord: PasswordRow | null): string | null {
  if (
    env.nodeEnv !== "development" ||
    Bun.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT === "false" ||
    passwordRecord?.is_default !== 1
  ) return null;
  return env.authDefaultPassword;
}

async function getCurrentSession(request: BunRequest): Promise<{ isDefaultPassword: boolean } | null> {
  const token = request.cookies.get(SESSION_COOKIE_NAME);
  if (!token) return null;

  // The session and password gate share one snapshot; revocation does not cancel checks already in flight.
  const result = await db.execute({
    sql: `
      SELECT credentials.is_default
      FROM auth_sessions AS sessions
      JOIN auth_credentials AS credentials ON credentials.id = 1
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
      LIMIT 1
    `,
    args: [await hashToken(token), Date.now()],
  });

  const row = result.rows[0] as unknown as { is_default: number } | undefined;
  return row ? { isDefaultPassword: Number(row.is_default) === 1 } : null;
}

function setSessionCookie(request: BunRequest, token: string): void {
  const options: CookieInit = {
    httpOnly: true,
    secure: env.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };

  request.cookies.set(SESSION_COOKIE_NAME, token, options);
}

function clearSessionCookie(request: BunRequest): void {
  request.cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    const headers = error.retryAfterSeconds
      ? { "Retry-After": String(error.retryAfterSeconds) }
      : undefined;

    return jsonResponse({ error: error.message }, { status: error.status, headers });
  }

  console.error("Authentication request failed:", error);
  return jsonResponse(
    { error: "Unable to complete authentication request." },
    { status: 500 },
  );
}

export async function login(request: BunRequest): Promise<Response> {
  try {
    assertSameOrigin(request);
    const password = await readPassword(request);
    const loginKey = `ip:${getClientAddress(request)}`;
    checkLoginRateLimit(loginKey);

    const passwordRecord = await getPasswordRecord();
    const passwordHash = passwordRecord?.password_hash ?? (await dummyPasswordHash);
    const passwordMatches = await Bun.password.verify(password, passwordHash);

    if (!passwordMatches) {
      recordFailedLogin(loginKey);
      throw new AuthError("Invalid password.", 401);
    }

    clearFailedLogin(loginKey);
    setSessionCookie(request, await createSession(passwordHash));
    return jsonResponse({
      success: true,
      authenticated: true,
      isDefaultPassword: passwordRecord?.is_default === 1,
      defaultPasswordHint: defaultPasswordHint(passwordRecord),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function logout(request: BunRequest): Promise<Response> {
  try {
    assertSameOrigin(request);
    await deleteSession(request.cookies.get(SESSION_COOKIE_NAME));
    clearSessionCookie(request);
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function changePassword(request: BunRequest): Promise<Response> {
  try {
    assertSameOrigin(request, true);

    const currentSession = await getCurrentSession(request);
    if (!currentSession) {
      throw new AuthError("Authentication is required.", 401);
    }

    const token = request.cookies.get(SESSION_COOKIE_NAME);
    const passwordRecord = await getPasswordRecord();
    if (!token || !passwordRecord) {
      throw new AuthError("Authentication is required.", 401);
    }

    const { currentPassword, newPassword } = await readPasswordChange(request);
    if (currentPassword === undefined && !currentSession.isDefaultPassword) {
      throw new AuthError("Current password is required.", 400);
    }
    if (
      currentPassword !== undefined &&
      !(await Bun.password.verify(currentPassword, passwordRecord.password_hash))
    ) {
      throw new AuthError("Current password is incorrect.", 401);
    }
    if (await Bun.password.verify(newPassword, passwordRecord.password_hash)) {
      throw new AuthError("New password must be different from the current password.", 400);
    }

    const updatedAt = Date.now();
    const newPasswordHash = await Bun.password.hash(newPassword);
    const sessionTokenHash = await hashToken(token);
    const results = await db.batch(
      [
        {
          sql: `
            UPDATE auth_credentials
            SET password_hash = ?, is_default = 0, updated_at = ?
            WHERE id = 1 AND password_hash = ?
              AND EXISTS (
                SELECT 1 FROM auth_sessions
                WHERE token_hash = ? AND expires_at > ?
              )
          `,
          args: [
            newPasswordHash,
            updatedAt,
            passwordRecord.password_hash,
            sessionTokenHash,
            updatedAt,
          ],
        },
        {
          sql: `
            DELETE FROM auth_sessions
            WHERE EXISTS (
              SELECT 1 FROM auth_credentials
              WHERE id = 1 AND password_hash = ? AND updated_at = ?
            )
          `,
          args: [newPasswordHash, updatedAt],
        },
      ],
      "write",
    );

    if (results[0]?.rowsAffected !== 1) {
      throw new AuthError("Password or session changed. Please log in and try again.", 409);
    }

    clearSessionCookie(request);
    return jsonResponse({ success: true, authenticated: false, requiresLogin: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function status(request: BunRequest): Promise<Response> {
  try {
    const passwordRecord = await getPasswordRecord();
    const session = await getCurrentSession(request);

    return jsonResponse({
      authenticated: session !== null,
      hasPassword: passwordRecord !== null,
      isDefaultPassword: session?.isDefaultPassword ?? passwordRecord?.is_default === 1,
      defaultPasswordHint: defaultPasswordHint(passwordRecord),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export { getCurrentSession };
