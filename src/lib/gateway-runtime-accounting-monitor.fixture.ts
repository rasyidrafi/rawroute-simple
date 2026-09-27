import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbFile = `/tmp/rawroute-native-monitor-${crypto.randomUUID()}.db`;
const dataDir = `/tmp/rawroute-native-monitor-${crypto.randomUUID()}`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "native-monitor-password";
Bun.env.DATABASE_URL = `file:${dbFile}`;
Bun.env.RAWROUTE_DATA_DIR = dataDir;

const accounting = await import("./accounting");
const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const keys = await import("./gateway-keys");
const routing = await import("./routing");
const runtime = await import("./gateway-runtime");
const gateway = await import("./gateway-http");
const { logs } = await import("./logging/store");

async function eventually(operation: () => Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await operation()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function pausedNativeFetch() {
  return async (_url: unknown, init: { signal?: AbortSignal }) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
      init.signal?.addEventListener("abort", () => controller.error(new DOMException("client cancelled", "AbortError")), { once: true });
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function requestThenCancel(secret: string, model: string, beforeCancel?: () => void): Promise<void> {
  const response = await gateway.gatewayRequest(new Request("http://fixture/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: "fixture", stream: true }),
  }) as never);
  if (response.status !== 200) throw new Error(`native fixture response was ${response.status}: ${await response.text()}`);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  beforeCancel?.();
  await reader.cancel();
  reader.releaseLock();
}

test("native monitor logs durable settlement failures after a client abort but not normal 499 transport cancellation", async () => {
  await workspaces.ensureWorkspaceSchema();
  await providers.ensureProviderSchema();
  await keys.ensureGatewayKeySchema();
  await routing.ensureRoutingSchema();
  await accounting.ensureAccountingSchema();
  const workspace = await workspaces.createWorkspace("Native monitor fixture");
  const key = await keys.createGatewayKey(workspace.id, "native monitor", crypto.randomUUID());
  const provider = await providers.createProvider(workspace.id, { name: "Native monitor", prefix: "monitor", baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Native monitor", gatewaySuffix: "monitor", upstreamModel: "monitor" });
  expect(await routing.resolveRoutingModel(workspace.id, model.gatewayModelId)).toMatchObject({ kind: "model" });
  const originalError = console.error;
  const consoleMessages: string[] = [];
  console.error = (...values: unknown[]) => { consoleMessages.push(values.map(String).join(" ")); };
  const originalTransaction = db.transaction.bind(db);
  try {
    const hooks = accounting.gatewayAccountingHooks();
    let monitorError: unknown;
    const restoreFailureFixture = runtime.setGatewayRuntimeDependenciesForTesting({
      hooks: {
        ...hooks,
        onStream: async (...args: [string, ReadableStream<Uint8Array>, AbortSignal?]) => {
          try { await hooks.onStream!(...args); } catch (error) { monitorError = error; throw error; }
        },
      },
      fetch: pausedNativeFetch() as unknown as typeof fetch,
    });
    const secret = "not-a-loggable-secret";
    let faults = 0;
    await requestThenCancel(key.secret, model.gatewayModelId, () => {
      db.transaction = async () => {
        faults++;
        throw new Error(`Injected ledger storage outage ${secret}`);
      };
    });
    await eventually(async () => Boolean(monitorError), "the six queue/fallback settlement failures");
    expect(faults).toBe(6);
    expect(monitorError).toMatchObject({ code: "accounting_persistence_unavailable" });
    const failure = logs.snapshot().entries.find((entry) => entry.event === "gateway.accounting.monitor.accounting_persistence_unavailable");
    expect(failure).toMatchObject({ source: "gateway", message: "Accounting stream monitor failed", level: "ERROR" });
    expect(JSON.stringify({ failure, consoleMessages })).not.toContain(secret);
    expect(consoleMessages).toEqual(["Accounting stream monitor failed [accounting_persistence_unavailable]"]);
    db.transaction = originalTransaction;
    restoreFailureFixture();

    // Normal transport cancellation settles the 499 inside accounting and never
    // rejects its monitor, so it must not produce an operational error log.
    logs.clear();
    consoleMessages.length = 0;
    const restoreNormalFixture = runtime.setGatewayRuntimeDependenciesForTesting({ hooks: accounting.gatewayAccountingHooks(), fetch: pausedNativeFetch() as unknown as typeof fetch });
    try {
      await requestThenCancel(key.secret, model.gatewayModelId);
      await eventually(async () => {
        const result = await db.execute({ sql: "SELECT 1 FROM usage_events WHERE workspace_id=? AND status=499 LIMIT 1", args: [workspace.id] });
        return result.rows.length > 0;
      }, "normal 499 settlement");
      expect(logs.snapshot().entries).toEqual([]);
      expect(consoleMessages).toEqual([]);
    } finally {
      restoreNormalFixture();
    }
  } finally {
    db.transaction = originalTransaction;
    console.error = originalError;
    await accounting.beginAccountingShutdown();
    db.close();
    rmSync(dbFile, { force: true });
    rmSync(`${dbFile}-wal`, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
