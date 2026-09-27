import { expect, test } from "bun:test";

Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "phase2a-http-test-password";
Bun.env.DATABASE_URL = `file:/tmp/opencode/cliproxy-http-test-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/cliproxy-http-test-data-${crypto.randomUUID()}`;

const [{ cliproxyStart, cliproxyStatus, createMutationGate, isManagementOriginAllowed }, auth] =
  await Promise.all([import("./http"), import("../auth")]);

test("management origin allows Origin-less GETs but requires exact Origin for mutations", () => {
  const expectedOrigin = "https://dashboard.example";
  const getWithoutOrigin = new Request(`${expectedOrigin}/api/cliproxy/status`);
  const postWithoutOrigin = new Request(`${expectedOrigin}/api/cliproxy/start`, { method: "POST" });
  const wrongOriginPost = new Request(`${expectedOrigin}/api/cliproxy/start`, {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  const matchingOriginPost = new Request(`${expectedOrigin}/api/cliproxy/start`, {
    method: "POST",
    headers: { Origin: expectedOrigin },
  });

  expect(isManagementOriginAllowed(getWithoutOrigin, expectedOrigin, false)).toBe(true);
  expect(isManagementOriginAllowed(getWithoutOrigin, expectedOrigin, true)).toBe(false);
  expect(isManagementOriginAllowed(postWithoutOrigin, expectedOrigin, true)).toBe(false);
  expect(isManagementOriginAllowed(wrongOriginPost, expectedOrigin, true)).toBe(false);
  expect(isManagementOriginAllowed(matchingOriginPost, expectedOrigin, true)).toBe(true);
  expect(isManagementOriginAllowed(getWithoutOrigin, undefined, false)).toBe(false);
});

test("default-password sessions are gated until rotation and mutations require Origin", async () => {
  await auth.ensureAuthSchema();
  await auth.ensureDefaultPassword();
  const server = Bun.serve({
    port: 0,
    routes: {
      "/api/auth/login": { POST: auth.login },
      "/api/auth/password": { POST: auth.changePassword },
      "/api/cliproxy/status": { GET: cliproxyStatus },
      "/api/cliproxy/start": { POST: cliproxyStart },
    },
  });

  try {
    const origin = server.url.origin;
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "phase2a-http-test-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeDefined();

    const restrictedStatus = await fetch(`${origin}/api/cliproxy/status`, {
      headers: { Cookie: cookie! },
    });
    const restrictedPayload = await restrictedStatus.json() as Record<string, unknown>;
    expect(restrictedStatus.status).toBe(403);
    expect(restrictedStatus.headers.get("cache-control")).toBe("no-store");
    expect(restrictedPayload.error).toBe("Change password required");

    const newPassword = "phase2a-test-new-password-strong";
    const passwordChange = await fetch(`${origin}/api/auth/password`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ currentPassword: "phase2a-http-test-password", newPassword }),
    });
    expect(passwordChange.status).toBe(200);
    const clearedCookie = passwordChange.headers.get("set-cookie")?.toLowerCase();
    expect(clearedCookie).toContain("rawroute_session=");
    expect(clearedCookie).toContain("expires=");

    const relogin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    expect(relogin.status).toBe(200);
    const newCookie = relogin.headers.get("set-cookie")?.split(";", 1)[0];
    expect(newCookie).toBeDefined();

    const status = await fetch(`${origin}/api/cliproxy/status`, {
      headers: { Cookie: newCookie! },
    });
    const payload = await status.json() as Record<string, unknown>;
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(payload).not.toHaveProperty("apiKey");

    const mutation = await fetch(`${origin}/api/cliproxy/start`, {
      method: "POST",
      headers: { Cookie: newCookie! },
    });
    expect(mutation.status).toBe(403);
    expect(mutation.headers.get("cache-control")).toBe("no-store");
  } finally {
    await server.stop(true);
  }
});

test("shutdown drains accepted mutations and rejects later mutations", async () => {
  const gate = createMutationGate();
  let releaseMutation!: () => void;
  let drained = false;
  const mutationFinished = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });

  const mutation = gate.run(async (assertCanStart) => {
    assertCanStart();
    await mutationFinished;
    return "finished";
  });
  const drain = gate.beginShutdown().then(() => {
    drained = true;
  });

  await Promise.resolve();
  expect(drained).toBe(false);

  let laterMutationRan = false;
  let laterMutationRejected = false;
  try {
    await gate.run(async () => {
      laterMutationRan = true;
    });
  } catch {
    laterMutationRejected = true;
  }
  expect(laterMutationRejected).toBe(true);
  expect(laterMutationRan).toBe(false);

  releaseMutation();
  expect(await mutation).toBe("finished");
  await drain;
  expect(drained).toBe(true);
});

test("shutdown during preflight prevents the service operation from starting", async () => {
  const gate = createMutationGate();
  let finishPreflight!: () => void;
  let serviceOperationStarted = false;
  const preflight = new Promise<void>((resolve) => {
    finishPreflight = resolve;
  });

  const mutation = gate.run(async (assertCanStart) => {
    await preflight;
    assertCanStart();
    serviceOperationStarted = true;
  });
  const drain = gate.beginShutdown();
  finishPreflight();

  let mutationRejected = false;
  try {
    await mutation;
  } catch {
    mutationRejected = true;
  }
  await drain;

  expect(mutationRejected).toBe(true);
  expect(serviceOperationStarted).toBe(false);
});
