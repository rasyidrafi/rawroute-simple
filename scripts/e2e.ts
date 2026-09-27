/**
 * Release browser/API verification against the compiled server, not Vite/HMR.
 *
 * This intentionally owns every dependency it starts: a temporary libSQL data
 * directory, a loopback-only fake upstream, and a test-only CLIProxy port. The
 * fake upstream is the only external boundary replaced in this suite; browser,
 * auth, management handlers, database, resolver, gateway and accounting run in
 * the compiled RawRoute application.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const artifacts = path.join(root, "artifacts", "e2e");
const password = "InitialE2E-password";
const rotatedPassword = "RotatedE2E-password";
const browserSession = `rawroute-e2e-${process.pid}`;
let server: Bun.Subprocess | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let dataDir: string | undefined;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function eventually(operation: () => Promise<boolean>, description: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function availablePort(): number {
  const listener = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function browser(...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["agent-browser", "--session", browserSession, ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`agent-browser ${args.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`);
  }
  return result.stdout.toString();
}

async function screenshot(name: string) {
  fs.mkdirSync(artifacts, { recursive: true });
  try { browser("screenshot", path.join(artifacts, `${name}.png`)); } catch { /* Preserve the original failure. */ }
}

async function request<T>(
  origin: string,
  cookie: string | undefined,
  pathname: string,
  options: { method?: string; body?: unknown; workspace?: string } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(options.workspace ? { "x-rawroute-workspace-id": options.workspace } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({})) as T;
  return { status: response.status, body, headers: response.headers };
}

async function startApp(origin: string, cliproxyPort: number) {
  dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-e2e-"));
  server = Bun.spawn({
    cmd: [process.execPath, "index.js"],
    cwd: path.join(root, "dist"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: new URL(origin).port,
      APP_ORIGIN: origin,
      AUTH_COOKIE_SECURE: "false",
      AUTH_DEFAULT_PASSWORD: password,
      DATABASE_URL: `file:${path.join(dataDir, "rawroute.db")}`,
      RAWROUTE_DATA_DIR: dataDir,
      RAWROUTE_CLIPROXY_TEST_PORT: String(cliproxyPort),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await eventually(async () => {
    const response = await fetch(`${origin}/api/health`).catch(() => undefined);
    if (!response) return false;
    const health = await response.json().catch(() => undefined) as { executors?: { native?: string } } | undefined;
    // A fresh install has no managed CLIProxy binary. Native execution is still
    // deliberately eligible, so readiness is not coupled to projected health.
    return health?.executors?.native === "available";
  }, "compiled native executor readiness");
}

async function stopApp() {
  if (!server) return;
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(10_000)]);
  server = undefined;
}

async function main() {
  // Do not present an old debugging failure as evidence for this run.
  fs.rmSync(artifacts, { recursive: true, force: true });
  const build = Bun.spawnSync({ cmd: [process.execPath, "scripts/build.ts"], cwd: root, stdout: "inherit", stderr: "inherit" });
  check(build.exitCode === 0, "production bundle build failed");
  const cliproxyPort = availablePort();
  check(cliproxyPort !== 8317, "E2E CLIProxy port must not be the production port");
  const upstreamRequests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(input) {
      const url = new URL(input.url);
      const body = await input.json().catch(() => null);
      upstreamRequests.push({ path: url.pathname, authorization: input.headers.get("authorization"), body });
      if (url.pathname.endsWith("/responses")) {
        return Response.json({ id: "resp_e2e", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }], usage: { input_tokens: 3, output_tokens: 5 } });
      }
      if (url.pathname.endsWith("/stream")) {
        return new Response("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "unexpected fake upstream path" }, { status: 404 });
    },
  });
  let appPort = availablePort();
  while (appPort === upstream.port || appPort === cliproxyPort) appPort = availablePort();
  const origin = `http://127.0.0.1:${appPort}`;

  // A loopback fixture reserves the test-only CLIProxy address. The app must
  // never touch the documented external/private deployment port during E2E.
  const cliproxyFixture = Bun.serve({ hostname: "127.0.0.1", port: cliproxyPort, fetch: () => Response.json({ status: "fixture" }) });
  try {
    await startApp(origin, cliproxyPort);
    // Browser: initial sign-in, forced initial-password rotation, sign-in again,
    // one-time key reveal and reload. These prove the compiled client and real
    // cookie/origin-protected handlers work together.
    browser("open", `${origin}/dashboard/ai/endpoint`);
    browser("wait", "#auth-password");
    browser("fill", "#auth-password", password);
    browser("click", "button[type=submit]");
    browser("wait", "input[id$='-new-password']");
    browser("fill", "input[id$='-new-password']", rotatedPassword);
    browser("fill", "input[id$='-confirm-password']", rotatedPassword);
    browser("click", "[role=dialog] button[type=submit]");
    browser("wait", "#auth-password");
    browser("fill", "#auth-password", rotatedPassword);
    browser("click", "button[type=submit]");
    browser("wait", "--text", "Gateway API keys");
    browser("find", "role", "button", "click", "--name", "Create key");
    browser("fill", "#gateway-key-name", "browser-visible-key");
    browser("fill", "#gateway-key-custom-value", "rr-browser-e2e-key-0123456789abcdef");
    browser("click", "[role=dialog] button[type=submit]");
    browser("wait", "--text", "API key created");
    check(browser("get", "text", "body").includes("rr-browser-e2e-key-0123456789abcdef"), "browser did not render the one-time key value");
    browser("find", "role", "button", "click", "--name", "Done");
    browser("reload");
    browser("wait", "--text", "browser-visible-key");

    const login = await request<{ authenticated: boolean }>(origin, undefined, "/api/auth/login", { method: "POST", body: { password: rotatedPassword } });
    check(login.status === 200 && login.body.authenticated, "programmatic administrator login failed after rotation");
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    check(cookie, "login did not issue a session cookie");
    const listed = await request<{ workspaces: Array<{ id: string; name: string }> }>(origin, cookie, "/api/workspaces");
    check(listed.status === 200 && listed.body.workspaces.length === 1, "fresh install should contain exactly one workspace");
    const owner = listed.body.workspaces[0]!;
    const createdWorkspace = await request<{ workspace: { id: string; name: string } }>(origin, cookie, "/api/workspaces", { method: "POST", body: { name: "Consumer E2E" } });
    check(createdWorkspace.status === 201, "second workspace creation failed");
    const consumer = createdWorkspace.body.workspace;

    const provider = await request<{ provider: { id: string } }>(origin, cookie, "/api/providers", {
      method: "POST", workspace: owner.id,
      body: { provider: { name: "Native fixture", prefix: "native", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, protocol: "openai-responses", authType: "bearer", headers: {}, enabled: true, supportPromptCacheKey: false } },
    });
    check(provider.status === 201, "native provider creation failed");
    const providerId = provider.body.provider.id;
    const credential = await request(origin, cookie, `/api/providers/${providerId}/credentials`, { method: "POST", workspace: owner.id, body: { credential: { name: "fixture", key: "upstream-secret", enabled: true, rpmLimit: 60, maxConcurrency: 2 } } });
    check(credential.status === 201, "provider credential creation failed");
    const model = await request<{ model: { id: string; gatewayModelId: string } }>(origin, cookie, `/api/providers/${providerId}/models`, { method: "POST", workspace: owner.id, body: { model: { name: "Native test", gatewaySuffix: "chat", upstreamModel: "fixture-chat", enabled: true, source: "custom", reasoningCapability: { mode: "enabled", supportedEfforts: ["low", "high"] } } } });
    check(model.status === 201, "provider model creation failed");

    const keySecret = "rr-native-e2e-key-0123456789abcdef";
    const key = await request<{ key: { id: string }; secret: string }>(origin, cookie, "/api/gateway-keys", { method: "POST", workspace: owner.id, body: { name: "native E2E", value: keySecret } });
    check(key.status === 201 && key.body.secret === keySecret, "gateway key create-once contract failed");
    const crossScope = await request<{ providers: unknown[] }>(origin, cookie, "/api/providers", { workspace: consumer.id });
    check(crossScope.status === 200 && crossScope.body.providers.length === 0, "second workspace observed owner providers");

    const group = await request<{ id: string }>(origin, cookie, "/api/model-pricing/groups", { method: "POST", workspace: owner.id, body: { name: "native rates", modelIds: [model.body.model.id] } });
    check(group.status === 200, "pricing group creation failed");
    const version = await request(origin, cookie, "/api/model-pricing/versions", { method: "POST", workspace: owner.id, body: { groupId: group.body.id, mode: "replace", rates: { inputMicrosPerMillion: 1000000, outputMicrosPerMillion: 2000000, cacheReadMicrosPerMillion: 100000, cacheCreationMicrosPerMillion: 100000 }, tiers: [] } });
    check(version.status === 200, "pricing version creation failed");
    const budget = await request(origin, cookie, "/api/budgets", { method: "POST", workspace: owner.id, body: { keyId: key.body.key.id, limitMicros: 1_000_000, enabled: true } });
    check(budget.status === 200, "budget creation failed");
    check((await request(origin, cookie, "/api/budgets/window", { method: "PATCH", workspace: owner.id, body: { startAt: Date.now() - 1_000, endAt: Date.now() + 86_400_000 } })).status === 200, "custom budget window failed");

    const gateway = await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key.body.secret}`, "content-type": "application/json", "x-rawroute-workspace-id": consumer.id }, body: JSON.stringify({ model: model.body.model.gatewayModelId, messages: [{ role: "user", content: "do not persist this prompt" }] }) });
    const gatewayBody = await gateway.json() as { choices?: Array<{ message?: { content?: string } }> };
    check(gateway.status === 200 && gatewayBody.choices?.[0]?.message?.content === "native e2e ok", "native chat ingress did not translate the real fake response");
    check(upstreamRequests.length === 1 && upstreamRequests[0]!.path.endsWith("/responses"), "gateway used the wrong native upstream endpoint");
    check(upstreamRequests[0]!.authorization === "Bearer upstream-secret", "gateway leaked or failed to replace its credential");
    check(!JSON.stringify(upstreamRequests[0]!.body).includes(key.body.secret), "gateway credential reached upstream");
    const embedding = await fetch(`${origin}/v1/embeddings`, { method: "POST", headers: { authorization: `Bearer ${key.body.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: model.body.model.gatewayModelId, input: "test" }) });
    check(embedding.status === 400, "unsupported native embeddings must fail instead of fabricating a response");
    const usage = await request<{ summary: { requests: number } }>(origin, cookie, "/api/usage?preset=all", { workspace: owner.id });
    check(usage.status === 200 && usage.body.summary.requests >= 1, "successful inference was not recorded in the durable usage ledger");

    // Persisted data survives a real compiled-server process restart.
    await stopApp();
    await startApp(origin, cliproxyPort);
    const catalog = await fetch(`${origin}/v1/models`, { headers: { "x-api-key": key.body.secret } });
    const catalogBody = await catalog.json() as { data?: Array<{ id: string }> };
    check(catalog.status === 200 && catalogBody.data?.some((entry) => entry.id === model.body.model.gatewayModelId), "gateway catalog did not recover after restart");

    // Public landing is a real browser page and does not use an administrator
    // cookie. It must select a live workspace on a narrow mobile viewport.
    browser("set", "viewport", "390", "844");
    browser("open", origin);
    browser("wait", "--text", "RawRoute usage");
    browser("wait", "--text", "Usage filters");
    await screenshot("public-mobile");
    const publicResponse = await fetch(`${origin}/api/public/dashboard?workspace=${owner.id}&preset=all`);
    const publicBody = await publicResponse.text();
    check(publicResponse.status === 200 && !/upstream-secret|rr-native-e2e-key|do not persist/.test(publicBody), "public analytics disclosed a secret or request content");

    const revoke = await request(origin, cookie, `/api/gateway-keys/${key.body.key.id}`, { method: "PATCH", workspace: owner.id, body: { revoked: true } });
    check(revoke.status === 200, "gateway key revocation failed");
    const revoked = await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${key.body.secret}` } });
    check(revoked.status === 401, "revoked gateway key retained public access");
    console.log("E2E PASS: compiled browser/auth/key workspace/native-gateway/accounting/restart/public-mobile scenarios");
  } catch (error) {
    await screenshot("failure");
    throw error;
  } finally {
    try { browser("close", "--all"); } catch { /* browser may not have started */ }
    await stopApp();
    upstream?.stop(true);
    cliproxyFixture.stop(true);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
