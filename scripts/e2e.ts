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
import { createClient } from "@libsql/client";
import { fetchBounded, jsonBounded, textBounded, withSuiteWatchdog } from "./e2e-bounds";
import { runFinancialMatrix } from "./e2e-financial";
import { stopOwnedProcess } from "./e2e-supervisor";

const root = path.resolve(import.meta.dir, "..");
const artifacts = path.join(root, "artifacts", "e2e");
const password = "InitialE2E-password";
const rotatedPassword = "RotatedE2E-password";
const FETCH_TIMEOUT_MS = 10_000;
const BODY_TIMEOUT_MS = 10_000;
const BROWSER_COMMAND_TIMEOUT_MS = 30_000;
const accountingMatrix = process.argv.includes("--accounting");
const financialMatrix = process.argv.includes("--financial");
const adminMatrix = process.argv.includes("--admin") || accountingMatrix || financialMatrix;
const SUITE_TIMEOUT_MS = financialMatrix ? 600_000 : accountingMatrix ? 420_000 : adminMatrix ? 300_000 : 180_000;
const browserSession = `rr-a-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const anonymousBrowserSession = `rr-p-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let server: Bun.Subprocess | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let modelsDev: Bun.Subprocess | undefined;
let dataDir: string | undefined;
let browserHome: string | undefined;
let browserSocketDir: string | undefined;
let browserConfig: string | undefined;
let browserWorkdir: string | undefined;
let expectedServerNonce: string | undefined;
let serverHasExited = false;
let suiteSignal: AbortSignal | undefined;
let cliproxyFixture: ReturnType<typeof Bun.serve> | undefined;
let upstreamAbortCount = 0;

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

function browserCommand(session: string | undefined, cleanupOnly: boolean, ...args: string[]) {
  check(browserHome, "browser home was not initialized");
  check(browserSocketDir, "browser socket directory was not initialized");
  check(browserConfig && browserWorkdir, "browser configuration was not initialized");
  if (!cleanupOnly && suiteSignal?.aborted) throw suiteSignal.reason;
  // Do not inherit AGENT_BROWSER_* configuration, cookies, profiles, or a
  // previous session name from the developer/CI environment.
  const result = Bun.spawnSync({
    cmd: ["agent-browser", "--config", browserConfig, "--executable-path", "/usr/bin/chromium", ...(session ? ["--session", session] : []), ...args],
    cwd: browserWorkdir,
    env: { PATH: process.env.PATH ?? "", HOME: browserHome, AGENT_BROWSER_SOCKET_DIR: browserSocketDir },
    stdout: "pipe",
    stderr: "pipe",
    timeout: BROWSER_COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout || result.exitCode !== 0) {
    throw new Error(`agent-browser ${args.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`);
  }
  if (!cleanupOnly && suiteSignal?.aborted) throw suiteSignal.reason;
  return result.stdout.toString();
}
function browser(session: string, ...args: string[]) { return browserCommand(session, false, ...args); }
/** Cleanup must remain runnable after the suite watchdog has aborted work. */
async function closeBrowserSession(session: string) {
  browserCommand(session, true, "close");
  for (let attempt = 0; attempt < 40; attempt++) {
    const active = browserCommand(undefined, true, "session", "list");
    if (!active.includes(session)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Owned agent-browser session did not terminate: ${session}`);
}

async function screenshot(name: string) {
  fs.mkdirSync(artifacts, { recursive: true });
  try { browser(name === "public-mobile" ? anonymousBrowserSession : browserSession, "screenshot", path.join(artifacts, `${name}.png`)); } catch { /* Preserve the original failure. */ }
}
async function failureScreenshots() {
  fs.mkdirSync(artifacts, { recursive: true });
  for (const [session, name] of [[browserSession, "failure-admin"], [anonymousBrowserSession, "failure-public"]] as const) {
    try { browser(session, "screenshot", path.join(artifacts, `${name}.png`)); } catch { /* A session may not exist yet. */ }
  }
}

async function request<T>(
  origin: string,
  cookie: string | undefined,
  pathname: string,
  options: { method?: string; body?: unknown; workspace?: string } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetchBounded(`${origin}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(options.workspace ? { "x-rawroute-workspace-id": options.workspace } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }, FETCH_TIMEOUT_MS, suiteSignal);
  const body = await jsonBounded<T>(response, BODY_TIMEOUT_MS, suiteSignal).catch(() => ({} as T));
  return { status: response.status, body, headers: response.headers };
}

async function startApp(origin: string, cliproxyPort: number, modelsDevOrigin: string) {
  dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-e2e-"));
  fs.mkdirSync(path.join(dataDir, "home"), { recursive: true, mode: 0o700 });
  const preexisting = await fetchBounded(`${origin}/api/health`, {}, 250, suiteSignal).catch(() => undefined);
  check(!preexisting, `refusing to reuse an existing server at ${origin}`);
  expectedServerNonce = crypto.randomUUID();
  server = Bun.spawn({
    cmd: [process.execPath, "index.js"],
    cwd: path.join(root, "dist"),
    // This is deliberately a narrow environment. In particular it does not
    // inherit deployment URLs, provider tokens, proxy settings, or browser
    // configuration from a developer shell.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(dataDir, "home"),
      NODE_ENV: "test",
      PORT: new URL(origin).port,
      APP_ORIGIN: origin,
      AUTH_COOKIE_SECURE: "false",
      AUTH_DEFAULT_PASSWORD: password,
      DATABASE_URL: `file:${path.join(dataDir, "rawroute.db")}`,
      RAWROUTE_DATA_DIR: dataDir,
      RAWROUTE_CLIPROXY_TEST_PORT: String(cliproxyPort),
      RAWROUTE_E2E_RUN_NONCE: expectedServerNonce,
      // models.dev is a deterministic loopback fixture only in NODE_ENV=test;
      // production ignores this variable in src/lib/models-dev.ts.
      RAWROUTE_MODELS_DEV_URL: `${modelsDevOrigin}/api.json`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  serverHasExited = false;
  void server.exited.then(() => { serverHasExited = true; });
  await eventually(async () => {
    const response = await fetchBounded(`${origin}/api/health`, {}, FETCH_TIMEOUT_MS, suiteSignal).catch(() => undefined);
    if (!response) return false;
    const health = await jsonBounded<{ executors?: { native?: string } }>(response, BODY_TIMEOUT_MS, suiteSignal).catch(() => undefined);
    // A fresh install has no managed CLIProxy binary. Native execution is still
    // deliberately eligible, so readiness is not coupled to projected health.
    return !serverHasExited && response.headers.get("x-rawroute-e2e-nonce") === expectedServerNonce && health?.executors?.native === "available";
  }, "compiled native executor readiness");
}

async function stopApp() {
  if (!server) return;
  await stopOwnedProcess(server);
  server = undefined;
}

/** Read only the isolated compiled-server database to verify durable terminal
 * status, which the aggregate usage API intentionally does not expose. */
type LedgerEvent = { attemptId: string; keyId: string; modelId: string; completedAt: number; status: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number; inputKnown: boolean; outputKnown: boolean; cacheReadKnown: boolean; cacheCreationKnown: boolean; costMicros: number; confidence: string; costSource: string | null; priceGroupId: string | null; priceVersionId: string | null; priceTier: string | null };

async function usageEventsAfter(workspaceId: string, keyId: string, after: number): Promise<LedgerEvent[]> {
  check(dataDir, "E2E data directory was not initialized");
  const client = createClient({ url: `file:${path.join(dataDir, "rawroute.db")}` });
  try {
    const result = await client.execute({ sql: "SELECT attempt_id,gateway_key_id,model_id,completed_at,status,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_tokens,input_known,output_known,cache_read_known,cache_creation_known,cost_micros,confidence,cost_source,price_group_id,price_version_id,price_tier FROM usage_events WHERE workspace_id=? AND gateway_key_id=? AND completed_at>=? ORDER BY completed_at,attempt_id", args: [workspaceId, keyId, after] });
    return result.rows.map(ledgerEvent);
  } finally {
    client.close();
  }
}

async function usageLedger(workspaceId: string): Promise<LedgerEvent[]> {
  check(dataDir, "E2E data directory was not initialized");
  const client = createClient({ url: `file:${path.join(dataDir, "rawroute.db")}` });
  try {
    const result = await client.execute({ sql: "SELECT attempt_id,gateway_key_id,model_id,completed_at,status,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_tokens,input_known,output_known,cache_read_known,cache_creation_known,cost_micros,confidence,cost_source,price_group_id,price_version_id,price_tier FROM usage_events WHERE workspace_id=? ORDER BY attempt_id", args: [workspaceId] });
    return result.rows.map(ledgerEvent);
  } finally {
    client.close();
  }
}

function ledgerEvent(row: Record<string, unknown>): LedgerEvent {
  return { attemptId: String(row.attempt_id), keyId: String(row.gateway_key_id), modelId: String(row.model_id), completedAt: Number(row.completed_at), status: Number(row.status), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), cacheReadTokens: Number(row.cache_read_tokens), cacheCreationTokens: Number(row.cache_creation_tokens), totalTokens: Number(row.total_tokens), inputKnown: Number(row.input_known) === 1, outputKnown: Number(row.output_known) === 1, cacheReadKnown: Number(row.cache_read_known) === 1, cacheCreationKnown: Number(row.cache_creation_known) === 1, costMicros: Number(row.cost_micros), confidence: String(row.confidence), costSource: row.cost_source === null ? null : String(row.cost_source), priceGroupId: row.price_group_id === null ? null : String(row.price_group_id), priceVersionId: row.price_version_id === null ? null : String(row.price_version_id), priceTier: row.price_tier === null ? null : String(row.price_tier) };
}

function clickMenuItem(name: string) {
  browser(browserSession, "find", "role", "menuitem", "click", "--name", name);
}

function clickButton(name: string) {
  browser(browserSession, "find", "role", "button", "click", "--name", name);
}

function submitDialog() {
  browser(browserSession, "eval", "document.querySelector('[role=dialog] form')?.requestSubmit()");
}

/**
 * Admin mutations are intentionally driven through the compiled browser. API
 * reads below merely capture opaque IDs for the gateway assertion; they never
 * provision the UI scenario's resources.
 */
async function runAdminBrowserMatrix(origin: string) {
  // Workspace creation selects the new workspace. Rename it, switch back to
  // Default, then return and delete it. This exercises localStorage selection,
  // all workspace dialogs, and the protected Default workspace path.
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Default · AI Gateway'))?.click()");
  clickMenuItem("Add New Workspace");
  browser(browserSession, "fill", "#workspace-name", "Browser matrix");
  submitDialog();
  browser(browserSession, "wait", "--text", "Browser matrix");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Browser matrix · AI Gateway'))?.click()");
  clickMenuItem("Rename Workspace");
  browser(browserSession, "fill", "#workspace-name", "Browser matrix renamed");
  submitDialog();
  browser(browserSession, "wait", "--text", "Browser matrix renamed");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Browser matrix renamed · AI Gateway'))?.click()");
  browser(browserSession, "click", "[role=menuitemradio]");
  browser(browserSession, "wait", "--text", "Gateway API keys");

  // Key mutation remains browser-only. The key secret was revealed once by the
  // base flow and must remain absent from the rename view.
  browser(browserSession, "eval", "document.querySelector(\"button[aria-label='Edit browser-visible-key']\")?.click()");
  browser(browserSession, "wait", "#gateway-key-rename");
  browser(browserSession, "fill", "#gateway-key-rename", "browser-renamed-key");
  submitDialog();
  browser(browserSession, "wait", "--text", "browser-renamed-key");
  check(!browser(browserSession, "get", "text", "body").includes("rr-browser-e2e-key-0123456789abcdef"), "renaming a gateway key revealed its existing secret");

  // Ordinary-provider CRUD: the provider and its first credential/model are
  // retained for the remainder of this browser matrix. Disposable children
  // cover deletion without invalidating later routing/catalog UI assertions.
  browser(browserSession, "open", `${origin}/dashboard/ai/providers`);
  browser(browserSession, "wait", "--text", "Providers");
  clickButton("Add provider");
  browser(browserSession, "fill", "#provider-name", "Browser fixture");
  browser(browserSession, "fill", "#provider-prefix", "browser");
  check(upstream, "upstream fixture was not initialized");
  browser(browserSession, "fill", "#provider-url", `http://127.0.0.1:${upstream.port}/v1`);
  browser(browserSession, "eval", "document.querySelector('[role=dialog] [role=combobox]')?.click()");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('[role=option]')).find((item) => item.textContent?.includes('OpenAI Responses'))?.click()");
  browser(browserSession, "eval", "document.querySelector('form')?.requestSubmit()");
  browser(browserSession, "reload");
  browser(browserSession, "wait", "--text", "Browser fixture");
  browser(browserSession, "click", "a[href*='/dashboard/ai/providers/']");
  browser(browserSession, "wait", "--text", "Provider details");

  clickButton("Add key");
  browser(browserSession, "fill", "#credential-name", "browser-primary");
  browser(browserSession, "fill", "#credential-secret", "upstream-secret");
  browser(browserSession, "fill", "#credential-rpm", "77");
  browser(browserSession, "fill", "#credential-concurrency", "3");
  submitDialog();
  browser(browserSession, "wait", "--text", "browser-primary");
  clickButton("Add key");
  browser(browserSession, "fill", "#credential-name", "browser-disposable");
  browser(browserSession, "fill", "#credential-secret", "browser-upstream-disposable");
  submitDialog();
  browser(browserSession, "wait", "--text", "browser-disposable");
  clickButton("Move browser-disposable up");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).filter((item) => item.textContent === 'Edit').at(1)?.click()");
  browser(browserSession, "wait", "#credential-name");
  browser(browserSession, "fill", "#credential-name", "browser-secondary-edited");
  submitDialog();
  browser(browserSession, "wait", "--text", "browser-secondary-edited");
  check(!browser(browserSession, "get", "text", "body").includes("upstream-secret"), "provider credential was readable after editing without a replacement secret");

  browser(browserSession, "scroll", "down", "1000");
  for (const [name, suffix, upstreamModel] of [["Browser chat", "chat", "fixture-chat"], ["Browser backup", "backup", "fixture-backup"], ["Browser disposable", "discard", "fixture-discard"]] as const) {
    browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Add model'))?.click()");
    browser(browserSession, "wait", "#model-name");
    browser(browserSession, "fill", "#model-name", name);
    browser(browserSession, "fill", "#model-suffix", suffix);
    browser(browserSession, "fill", "#model-upstream", upstreamModel);
    browser(browserSession, "fill", "#model-reasoning-efforts", "low, high");
    submitDialog();
    browser(browserSession, "wait", "--text", name);
  }
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).filter((item) => item.textContent === 'Edit').at(3)?.click()");
  browser(browserSession, "wait", "#model-name");
  browser(browserSession, "fill", "#model-name", "Browser chat renamed");
  submitDialog();
  browser(browserSession, "wait", "--text", "Browser chat renamed");
  clickButton("Delete Browser disposable");
  clickButton("Delete");
  browser(browserSession, "wait", "--text", "Browser disposable");

  // Switch to the disposable workspace with keyboard navigation (the menu
  // owns its selection through a Base UI radio group), then delete it. The
  // client must atomically return to Default rather than retain its old ID.
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Default · AI Gateway'))?.click()");
  browser(browserSession, "press", "ArrowDown");
  browser(browserSession, "press", "Enter");
  browser(browserSession, "wait", "--text", "Browser matrix renamed");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Browser matrix renamed'))?.click()");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Browser matrix renamed · AI Gateway'))?.click()");
  clickMenuItem("Delete Workspace");
  browser(browserSession, "fill", "#workspace-delete-confirmation", "Browser matrix renamed");
  clickButton("Delete permanently");
  browser(browserSession, "open", `${origin}/dashboard/ai/endpoint`);
  browser(browserSession, "wait", "--text", "Gateway API keys");
  check(browser(browserSession, "get", "text", "body").includes("browser-renamed-key"), "workspace deletion did not return to the isolated Default workspace");
}

/** Browser mutations for persisted routing and accounting fixtures. */
async function runRoutingAccountingBrowserMatrix(origin: string, gatewayModelId: string) {
  browser(browserSession, "open", `${origin}/dashboard/ai/routing`);
  browser(browserSession, "wait", "--text", "Aliases");
  clickButton("Add alias");
  browser(browserSession, "fill", "#alias-id", "browser-alias");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Create')?.click()");
  browser(browserSession, "wait", "--text", "browser-alias");

  // Two direct models are present before this UI operation, so the combo editor
  // starts with two distinct members. Reordering is persisted by the editor.
  clickButton("Add combo");
  browser(browserSession, "fill", "#combo-id", "browser-combo");
  browser(browserSession, "fill", "#combo-name", "Browser ordered fallback");
  clickButton("Move member 2 up");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Create')?.click()");
  browser(browserSession, "wait", "--text", "browser-combo");

  browser(browserSession, "open", `${origin}/dashboard/ai/pricing`);
  browser(browserSession, "wait", "--text", "Model pricing");
  clickButton("New group");
  browser(browserSession, "fill", "#pricing-group-name", "Browser custom rates");
  // Select the fixture model in the rendered group-members list and persist a
  // custom group through the dialog rather than provisioning it over HTTP.
  browser(browserSession, "eval", `Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes(${JSON.stringify(gatewayModelId)}))?.querySelector('button,input')?.click()`);
  clickButton("Save group");
  browser(browserSession, "wait", "--text", "Browser custom rates");

  browser(browserSession, "open", `${origin}/dashboard/ai/budgets`);
  browser(browserSession, "wait", "--text", "Budget window");
  clickButton("Custom window");
  browser(browserSession, "wait", "#window-start");
  const windowDraft = JSON.parse(JSON.parse(browser(browserSession, "eval", `(() => {
    const start = document.querySelector('#window-start')?.value;
    const end = document.querySelector('#window-end')?.value;
    if (!start || !end) return JSON.stringify(null);
    const nextStart = new Date(start); nextStart.setMinutes(nextStart.getMinutes() - 90);
    const nextEnd = new Date(end); nextEnd.setMinutes(nextEnd.getMinutes() - 30);
    const format = (value) => value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0') + 'T' + String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0');
    return JSON.stringify({ start: format(nextStart), end: format(nextEnd), startAt: nextStart.getTime(), endAt: nextEnd.getTime() });
  })()`))) as { start: string; end: string; startAt: number; endAt: number };
  check(windowDraft.endAt > windowDraft.startAt, "budget dialog did not expose a mutable local interval");
  browser(browserSession, "eval", `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; for (const [selector, value] of [['#window-start', ${JSON.stringify(windowDraft.start)}], ['#window-end', ${JSON.stringify(windowDraft.end)}]]) { const input = document.querySelector(selector); if (!(input instanceof HTMLInputElement) || !set) throw new Error('budget datetime input unavailable'); set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  const browserWindowValues = JSON.parse(JSON.parse(browser(browserSession, "eval", "JSON.stringify({start:document.querySelector('#window-start')?.value,end:document.querySelector('#window-end')?.value})"))) as { start: string; end: string };
  check(browserWindowValues.start === windowDraft.start && browserWindowValues.end === windowDraft.end, `browser did not retain the exact custom-window datetime values before saving: ${JSON.stringify({ windowDraft, browserWindowValues })}`);
  clickButton("Save window");
  browser(browserSession, "wait", "--text", "Budget window");
  clickButton("Custom window");
  browser(browserSession, "wait", "#window-start");
  const persistedWindow = JSON.parse(JSON.parse(browser(browserSession, "eval", "JSON.stringify({start:document.querySelector('#window-start')?.value,end:document.querySelector('#window-end')?.value})"))) as { start: string; end: string };
  check(persistedWindow.start === windowDraft.start && persistedWindow.end === windowDraft.end, `custom window reload changed the exact timezone-local instants saved by the browser: ${JSON.stringify({ windowDraft, persistedWindow })}`);
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent === 'Cancel')?.click()");

  browser(browserSession, "open", `${origin}/dashboard/ai/usage`);
  browser(browserSession, "wait", "--text", "Usage dashboard");
  browser(browserSession, "click", "[aria-label='Range']");
  browser(browserSession, "eval", "Array.from(document.querySelectorAll('[role=option]')).find((item) => item.textContent === 'All time')?.click()");
  browser(browserSession, "wait", "--text", "Pricing confidence");
}

async function main(signal: AbortSignal) {
  suiteSignal = signal;
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
      if (input.method === "GET" && url.pathname === "/models-dev/api.json") {
        return Response.json({ fixture: { models: { canonical: { name: "Canonical Fixture", limit: { context: 123456 }, cost: { input: 1, output: 2, cache_read: 0.25, cache_write: 0.5 } } } } });
      }
      const body = await textBounded(input, BODY_TIMEOUT_MS, suiteSignal).then((text) => JSON.parse(text) as unknown).catch(() => null);
      upstreamRequests.push({ path: url.pathname, authorization: input.headers.get("authorization"), body });
      const payload = body as Record<string, unknown>;
       const invalid = input.method !== "POST" || url.pathname !== "/v1/responses" || !["Bearer upstream-secret", "Bearer browser-upstream-disposable"].includes(input.headers.get("authorization") ?? "") || !body || typeof body !== "object" || Array.isArray(body) || !["fixture-chat", "fixture-backup", "fixture-discard"].includes(String(payload.model)) || "messages" in payload || "max_tokens" in payload || "max_completion_tokens" in payload || "reasoning_effort" in payload;
      if (invalid) return Response.json({ error: "strict fake rejected endpoint, auth, or normalized payload" }, { status: 422 });
       // Policy probes clamp to eight output tokens. They verify the model's
       // accepted override without changing the normal fallback fixture.
       if (payload.model === "fixture-backup" && payload.max_output_tokens === 8) return Response.json({ id: "resp_probe", output: [], usage: { input_tokens: 1, output_tokens: 1 } });
       if (payload.model === "fixture-backup" && payload.input === "unpriced model price") return Response.json({ id: "resp_unpriced_model", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }], usage: { input_tokens: 3, output_tokens: 5 } });
       if (payload.model === "fixture-backup") return Response.json({ error: { message: "fixture fallback failure" } }, { status: 503 });
      if (payload.input === "e2e-upstream-failed") return Response.json({ id: "resp_failed", status: "failed", error: { code: "upstream_failed", message: "fixture failed" } });
      if (payload.stream === true && payload.input === "e2e-stream-failed") return new Response("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream_failed\"}}\n\nevent: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"upstream_failed\",\"message\":\"fixture stream failed\"},\"usage\":{\"input_tokens\":3,\"output_tokens\":5}}}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      if (payload.stream === true && ["e2e-cancel", "e2e-client-abort"].includes(String(payload.input))) return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_client_abort\"}}\n\n"));
          // Deliberately never sends a terminal frame. The only legal way out is
          // the compiled gateway propagating its real client disconnect.
          input.signal.addEventListener("abort", () => {
            upstreamAbortCount++;
            controller.error(input.signal.reason ?? new DOMException("Upstream request cancelled.", "AbortError"));
          }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
       if (payload.input === "e2e-tiered-price") return Response.json({ id: "resp_tier", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }], usage: { input_tokens: 15, output_tokens: 5, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } });
       if (payload.input === "canonical fixture price") return Response.json({ id: "resp_canonical", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }], usage: { input_tokens: 3, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
       if (payload.input === "e2e-assumed") return Response.json({ id: "resp_assumed", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }], usage: { input_tokens: 15, output_tokens: 5 } });
       if (payload.input === "e2e-unpriced") return Response.json({ id: "resp_unpriced", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }] });
      if (payload.stream === true && payload.input === "e2e-incomplete") {
        return new Response("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_incomplete\"}}\n\nevent: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"usage\":{\"input_tokens\":3,\"output_tokens\":5}}}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      if (payload.stream === true) {
        return new Response("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_e2e\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"native e2e ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":5}}}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "resp_e2e", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native e2e ok" }] }], usage: { input_tokens: 3, output_tokens: 5 } });
    },
    });
    let appPort = availablePort();
    const modelsDevPort = availablePort();
    while (appPort === upstream.port || appPort === cliproxyPort || appPort === modelsDevPort) appPort = availablePort();
    // agent-browser commands are intentionally synchronous so a fake catalog
    // hosted in this process would be unable to answer the browser's request.
    // Keep this tiny deterministic fixture in an owned child instead.
    modelsDev = Bun.spawn({
      cmd: [process.execPath, "-e", `Bun.serve({hostname:'127.0.0.1',port:${modelsDevPort},fetch:()=>Response.json({fixture:{models:{canonical:{name:'Canonical Fixture',limit:{context:123456},cost:{input:1,output:2,cache_read:.25,cache_write:.5}}}}})}); setInterval(()=>{}, 1 << 30);`],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "ignore",
      stderr: "inherit",
    });
    await eventually(async () => Boolean(await fetchBounded(`http://127.0.0.1:${modelsDevPort}/api.json`, {}, FETCH_TIMEOUT_MS, suiteSignal).catch(() => undefined)), "models.dev fixture readiness");
  const origin = `http://127.0.0.1:${appPort}`;
  browserWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-e2e-browser-"));
  browserHome = path.join(browserWorkdir, "home");
  fs.mkdirSync(browserHome, { recursive: true, mode: 0o700 });
  browserSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-ab-"));
  browserConfig = path.join(browserWorkdir, "agent-browser.e2e.json");
  fs.writeFileSync(browserConfig, JSON.stringify({ headed: false }), { mode: 0o600 });

  // A loopback fixture reserves the test-only CLIProxy address. The app must
  // never touch the documented external/private deployment port during E2E.
  cliproxyFixture = Bun.serve({ hostname: "127.0.0.1", port: cliproxyPort, fetch: () => Response.json({ status: "fixture" }) });
  try {
    await startApp(origin, cliproxyPort, `http://127.0.0.1:${modelsDevPort}`);
    // Browser: initial sign-in, forced initial-password rotation, sign-in again,
    // one-time key reveal and reload. These prove the compiled client and real
    // cookie/origin-protected handlers work together.
    browser(browserSession, "open", `${origin}/dashboard/ai/endpoint`);
    browser(browserSession, "wait", "#auth-password");
    browser(browserSession, "fill", "#auth-password", password);
    browser(browserSession, "click", "button[type=submit]");
    browser(browserSession, "wait", "input[id$='-new-password']");
    browser(browserSession, "fill", "input[id$='-new-password']", rotatedPassword);
    browser(browserSession, "fill", "input[id$='-confirm-password']", rotatedPassword);
    browser(browserSession, "click", "[role=dialog] button[type=submit]");
    browser(browserSession, "wait", "#auth-password");
    browser(browserSession, "fill", "#auth-password", rotatedPassword);
    browser(browserSession, "click", "button[type=submit]");
    browser(browserSession, "wait", "--text", "Gateway API keys");
    browser(browserSession, "find", "role", "button", "click", "--name", "Create key");
    browser(browserSession, "fill", "#gateway-key-name", "browser-visible-key");
    browser(browserSession, "fill", "#gateway-key-custom-value", "rr-browser-e2e-key-0123456789abcdef");
    browser(browserSession, "click", "[role=dialog] button[type=submit]");
    browser(browserSession, "wait", "--text", "API key created");
    check(browser(browserSession, "get", "text", "body").includes("rr-browser-e2e-key-0123456789abcdef"), "browser did not render the one-time key value");
    browser(browserSession, "find", "role", "button", "click", "--name", "Done");
    browser(browserSession, "reload");
    browser(browserSession, "wait", "--text", "browser-visible-key");
    check(!browser(browserSession, "get", "text", "body").includes("rr-browser-e2e-key-0123456789abcdef"), "one-time browser key remained visible after reload");
    if (adminMatrix) await runAdminBrowserMatrix(origin);

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

    const provider = await request<{ provider: { id: string } }>(origin, cookie, "/api/providers", { method: "POST", workspace: owner.id, body: { provider: { name: "Native fixture", prefix: "native", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, protocol: "openai-responses", authType: "bearer", headers: {}, enabled: true, supportPromptCacheKey: false } } });
    check(provider.status === 201, "native provider creation failed");
    const credential = await request(origin, cookie, `/api/providers/${provider.body.provider.id}/credentials`, { method: "POST", workspace: owner.id, body: { credential: { name: "fixture", key: "upstream-secret", enabled: true, rpmLimit: 60, maxConcurrency: 2 } } });
    check(credential.status === 201, "provider credential creation failed");
    const model = await request<{ model: { id: string; gatewayModelId: string } }>(origin, cookie, `/api/providers/${provider.body.provider.id}/models`, { method: "POST", workspace: owner.id, body: { model: { name: "Native test", gatewaySuffix: "chat", upstreamModel: "fixture-chat", enabled: true, source: "custom", reasoningCapability: { mode: "enabled", supportedEfforts: ["low", "high"] } } } });
    check(model.status === 201, "provider model creation failed");
    if (accountingMatrix || financialMatrix) {
      const backup = await request(origin, cookie, `/api/providers/${provider.body.provider.id}/models`, { method: "POST", workspace: owner.id, body: { model: { name: "Native backup", gatewaySuffix: "backup", upstreamModel: "fixture-backup", enabled: true, source: "custom", reasoningCapability: { mode: "enabled", supportedEfforts: ["low", "high"] } } } });
      check(backup.status === 201, "routing backup model creation failed");
      await runRoutingAccountingBrowserMatrix(origin, model.body.model.gatewayModelId);
    }
    const keySecret = "rr-native-e2e-key-0123456789abcdef";
    const key = await request<{ key: { id: string }; secret: string }>(origin, cookie, "/api/gateway-keys", { method: "POST", workspace: owner.id, body: { name: "native E2E", value: keySecret } });
    check(key.status === 201 && key.body.secret === keySecret, "gateway key create-once contract failed");
    const crossScope = await request<{ providers: unknown[] }>(origin, cookie, "/api/providers", { workspace: consumer.id });
    check(crossScope.status === 200 && crossScope.body.providers.length === 0, "second workspace observed owner providers");

    const group = await request<{ id: string }>(origin, cookie, "/api/model-pricing/groups", { method: "POST", workspace: owner.id, body: { name: "native rates", modelIds: [model.body.model.id] } });
    check(group.status === 200, "pricing group creation failed");
    const version = await request(origin, cookie, "/api/model-pricing/versions", { method: "POST", workspace: owner.id, body: { groupId: group.body.id, mode: "replace", rates: { inputMicrosPerMillion: 1000000, outputMicrosPerMillion: 2000000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, tiers: [] } });
    check(version.status === 200, "pricing version creation failed");
    const budget = await request(origin, cookie, "/api/budgets", { method: "POST", workspace: owner.id, body: { keyId: key.body.key.id, limitMicros: 1_000_000, enabled: true } });
    check(budget.status === 200, "budget creation failed");
    check((await request(origin, cookie, "/api/budgets/window", { method: "PATCH", workspace: owner.id, body: { startAt: Date.now() - 1_000, endAt: Date.now() + 86_400_000 } })).status === 200, "custom budget window failed");

    const gatewayModelId = model.body.model.gatewayModelId;
    const gateway = await fetchBounded(`${origin}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${key.body.secret}`, "content-type": "application/json", "x-rawroute-workspace-id": consumer.id }, body: JSON.stringify({ model: gatewayModelId, input: "do not persist this prompt", stream: true }) }, FETCH_TIMEOUT_MS, suiteSignal);
    const gatewayBody = await textBounded(gateway, BODY_TIMEOUT_MS, suiteSignal);
    check(gateway.status === 200 && gatewayBody.includes("response.output_text.delta") && gatewayBody.includes("native e2e ok"), "native streamed Responses ingress did not preserve the real fake response");
    check(upstreamRequests.length === 1 && upstreamRequests.every((item) => item.path === "/v1/responses"), "gateway used the wrong native upstream endpoint");
    check(upstreamRequests.every((item) => item.authorization === "Bearer upstream-secret"), "gateway leaked or failed to replace its credential");
    check(upstreamRequests.every((item) => !JSON.stringify(item.body).includes(key.body.secret)), "gateway credential reached upstream");
    const normalized = upstreamRequests[0]!.body as Record<string, unknown>;
    check(normalized.model === "fixture-chat" && normalized.stream === true && normalized.input === "do not persist this prompt", "native request was not normalized to the owned Responses payload");
    check(!["messages", "max_tokens", "max_completion_tokens", "reasoning_effort"].some((field) => field in normalized), "source protocol fields reached the native provider");
    let usage: { status: number; body: { summary: { requests: number; tokens: number; costMicros: number } } } | undefined;
    await eventually(async () => {
      usage = await request<{ summary: { requests: number; tokens: number; costMicros: number } }>(origin, cookie, "/api/usage?preset=all", { workspace: owner.id });
      return usage.status === 200 && usage.body.summary.requests === 1;
    }, "single streamed usage settlement");
    check(usage?.body.summary.tokens === 8 && usage.body.summary.costMicros === 13, `streamed usage did not persist the exact 3-input/5-output/13-micro cost: ${JSON.stringify(usage?.body.summary)}`);
    const embedding = await fetchBounded(`${origin}/v1/embeddings`, { method: "POST", headers: { authorization: `Bearer ${key.body.secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: model.body.model.gatewayModelId, input: "test" }) }, FETCH_TIMEOUT_MS, suiteSignal);
    check(embedding.status === 400, "unsupported native embeddings must fail instead of fabricating a response");

    // Persisted data survives a real compiled-server process restart.
    await stopApp();
    await startApp(origin, cliproxyPort, `http://127.0.0.1:${modelsDevPort}`);
    const catalog = await fetchBounded(`${origin}/v1/models`, { headers: { "x-api-key": key.body.secret } }, FETCH_TIMEOUT_MS, suiteSignal);
    const catalogBody = await jsonBounded<{ data?: Array<{ id: string }> }>(catalog, BODY_TIMEOUT_MS, suiteSignal);
    check(catalog.status === 200 && catalogBody.data?.some((entry) => entry.id === model.body.model.gatewayModelId), "gateway catalog did not recover after restart");
    const recoveredUsage = await request<{ summary: { requests: number; tokens: number; costMicros: number; exactRequests: number } }>(origin, cookie, "/api/usage?preset=all", { workspace: owner.id });
    // The unsupported embeddings request above is intentionally recorded as a
    // non-success outcome. The native stream remains the one successful event.
    check(recoveredUsage.status === 200 && recoveredUsage.body.summary.exactRequests === 1 && recoveredUsage.body.summary.tokens === 8 && recoveredUsage.body.summary.costMicros === 13, `ledger event or exact cost was not durable across restart: ${JSON.stringify(recoveredUsage)}`);
    if (financialMatrix) {
      const transportKey = await request<{ key: { id: string }; secret: string }>(origin, cookie, "/api/gateway-keys", { method: "POST", workspace: owner.id, body: { name: "financial transport", value: "rr-financial-transport-key-0123456789" } });
      check(transportKey.status === 201 && transportKey.body.secret, "unbudgeted financial gateway key creation failed");
       const financial = await runFinancialMatrix({
         origin, cookie, workspaceId: owner.id, key: { id: key.body.key.id, secret: key.body.secret }, transportKey: { id: transportKey.body.key.id, secret: transportKey.body.secret }, nativeModel: { id: model.body.model.id, gatewayModelId },
         request, browser: (...args) => browser(browserSession, ...args), check, eventually, upstreamRequests,
         upstreamAbortCount: () => upstreamAbortCount,
         usageEventsAfter,
         usageLedger,
       });
      // Financial configuration is exercised again after a compiled-process
      // restart, not merely held in the browser's local state.
      await stopApp();
      await startApp(origin, cliproxyPort, `http://127.0.0.1:${modelsDevPort}`);
       const persistedFinancialBudget = await request<{ window: { unlimited: boolean }; budgets: Array<{ keyId: string; enabled: boolean }> }>(origin, cookie, "/api/budgets", { workspace: owner.id });
       check(persistedFinancialBudget.status === 200 && !persistedFinancialBudget.body.window.unlimited && persistedFinancialBudget.body.budgets.some((item) => item.keyId === key.body.key.id && item.enabled), "financial budget configuration did not survive restart");
       const restartedSummary = await request<typeof financial.summary>(origin, cookie, "/api/usage?preset=all", { workspace: owner.id });
       const restartedLedger = await usageLedger(owner.id);
       const restartedPricing = await request<{ groups: Array<{ id: string; models: string[]; versions: Array<typeof financial.pricing.version> }> }>(origin, cookie, "/api/model-pricing", { workspace: owner.id });
       const restartedGroup = restartedPricing.body.groups.find((item) => item.id === financial.pricing.groupId);
       check(restartedSummary.status === 200 && JSON.stringify(restartedSummary.body.summary) === JSON.stringify(financial.summary.summary), `financial summary changed after replacement restart: ${JSON.stringify({ before: financial.summary.summary, after: restartedSummary.body.summary })}`);
       check(JSON.stringify(restartedLedger) === JSON.stringify(financial.ledger), "financial ledger totals or pinned price versions changed after restart");
       check(Boolean(restartedGroup) && JSON.stringify({ models: restartedGroup!.models, version: restartedGroup!.versions.find((item) => item.id === financial.pricing.version.id) }) === JSON.stringify({ models: financial.pricing.models, version: financial.pricing.version }), `replacement pricing group or current version did not survive restart: ${JSON.stringify({ expected: financial.pricing, actual: restartedGroup })}`);
    }

    // Public landing is a real browser page and does not use an administrator
    // cookie. It must select a live workspace on a narrow mobile viewport.
    await closeBrowserSession(browserSession);
    browser(anonymousBrowserSession, "set", "viewport", "390", "844");
    browser(anonymousBrowserSession, "open", origin);
    browser(anonymousBrowserSession, "wait", "--text", "RawRoute usage");
    browser(anonymousBrowserSession, "wait", "--text", "Usage filters");
    check(!browser(anonymousBrowserSession, "cookies", "get").includes("rawroute_session"), "public landing did not use a fresh anonymous browser session");
    await screenshot("public-mobile");
    const mobileArtifact = path.join(artifacts, "public-mobile.png");
    check(fs.statSync(mobileArtifact).size > 1_000, "public mobile screenshot is empty");
    const mobileLayout = browser(anonymousBrowserSession, "eval", "JSON.stringify({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,width:document.documentElement.clientWidth})");
    const mobileOverflow = JSON.parse(JSON.parse(mobileLayout)) as { overflow?: unknown };
    check(typeof mobileOverflow.overflow === "number" && mobileOverflow.overflow <= 1, `public landing overflows the required mobile viewport: ${mobileLayout}`);
    const publicResponse = await fetchBounded(`${origin}/api/public/dashboard?workspace=${owner.id}&preset=all`, {}, FETCH_TIMEOUT_MS, suiteSignal);
    const publicBody = await textBounded(publicResponse, BODY_TIMEOUT_MS, suiteSignal);
    check(publicResponse.status === 200 && !/upstream-secret|rr-native-e2e-key|do not persist/.test(publicBody), "public analytics disclosed a secret or request content");

    const revoke = await request(origin, cookie, `/api/gateway-keys/${key.body.key.id}`, { method: "PATCH", workspace: owner.id, body: { revoked: true } });
    check(revoke.status === 200, "gateway key revocation failed");
    const revoked = await fetchBounded(`${origin}/v1/models`, { headers: { authorization: `Bearer ${key.body.secret}` } }, FETCH_TIMEOUT_MS, suiteSignal);
    check(revoked.status === 401, "revoked gateway key retained public access");
    console.log(`E2E PASS: compiled browser/auth/key workspace/native-gateway/accounting/restart/public-mobile${adminMatrix ? "/admin-browser-crud" : ""} scenarios`);
  } catch (error) {
    await failureScreenshots();
    throw error;
  } finally {
    try { await closeBrowserSession(browserSession); } catch { /* browser may not have started */ }
    try { await closeBrowserSession(anonymousBrowserSession); } catch { /* browser may not have started */ }
    await stopApp();
    upstream?.stop(true);
    if (modelsDev) await stopOwnedProcess(modelsDev);
    modelsDev = undefined;
    cliproxyFixture?.stop(true);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (browserSocketDir) fs.rmSync(browserSocketDir, { recursive: true, force: true });
    if (browserWorkdir) fs.rmSync(browserWorkdir, { recursive: true, force: true });
  }
}

await withSuiteWatchdog(
  main,
  async () => {
    // The watchdog runs this even if a future awaited operation ignores its
    // abort signal. It owns only this run's named sessions and child process.
    if (browserConfig) {
      try { await closeBrowserSession(browserSession); } catch { /* no session */ }
      try { await closeBrowserSession(anonymousBrowserSession); } catch { /* no session */ }
    }
    await stopApp();
    upstream?.stop(true);
    if (modelsDev) await stopOwnedProcess(modelsDev);
    modelsDev = undefined;
    cliproxyFixture?.stop(true);
  },
  SUITE_TIMEOUT_MS,
);
