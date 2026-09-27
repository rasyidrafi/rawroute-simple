import { afterAll, expect, test } from "bun:test";

const databasePath = `/tmp/opencode/rawroute-accounting-${crypto.randomUUID()}.db`;
Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "accounting-reliability-password";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-accounting-${crypto.randomUUID()}`;

const accounting = await import("./accounting");
const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const keys = await import("./gateway-keys");

const rates = (multiplier = 1) => ({ inputMicrosPerMillion: multiplier * 1_000_000, outputMicrosPerMillion: multiplier * 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 });
const hooks = accounting.gatewayAccountingHooks();
type Attempt = Parameters<NonNullable<typeof hooks.beforeAttempt>>[0];

async function setup(name: string, budget = 1_000) {
  const workspace = await workspaces.createWorkspace(`${name} ${crypto.randomUUID()}`);
  const key = await keys.createGatewayKey(workspace.id, "fixture", crypto.randomUUID());
  const provider = await providers.createProvider(workspace.id, { name: "Fixture", prefix: `fixture-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, baseUrl: "https://example.invalid", protocol: "openai-responses", authType: "none" });
  const model = await providers.createProviderModel(workspace.id, provider.id, { name: "Fixture model", gatewaySuffix: "gpt-fixture", upstreamModel: "gpt-fixture" });
  const group = await accounting.savePricingGroup(workspace.id, { name: "Fixture pricing", modelIds: [model.id] });
  await accounting.savePricingVersion(workspace.id, { groupId: group, rates: rates() });
  await accounting.saveBudget(workspace.id, { keyId: key.key.id, limitMicros: budget });
  return { workspace, key, provider, model, group };
}
function attempt(subject: Awaited<ReturnType<typeof setup>>): Attempt {
  return { attemptId: crypto.randomUUID(), requestId: crypto.randomUUID(), workspaceId: subject.workspace.id, gatewayKeyId: subject.key.key.id, requestedModel: subject.model.gatewayModelId, model: { id: subject.model.gatewayModelId, providerId: subject.provider.id, providerPrefix: "fixture", name: "Fixture model", upstreamModel: "gpt-fixture", protocol: "openai-responses", source: "custom" }, providerId: subject.provider.id, protocol: "openai-responses", startedAt: Date.now(), requestBodyBytes: 3, payload: { max_output_tokens: 0 } };
}
async function complete(target: Attempt, usage: Record<string, unknown> | undefined, status = 200) { await hooks.onResult!({ ...target, status, completedAt: Date.now(), streamed: false, terminalStream: true, response: Response.json(usage ? { usage } : {}) }); }

test.serial("durably retries the original successful outcome and preserves partial assumptions through repricing", async () => {
  await workspaces.ensureWorkspaceSchema(); await providers.ensureProviderSchema(); await keys.ensureGatewayKeySchema(); await accounting.ensureAccountingSchema();
  const subject = await setup("retry"); const target = attempt(subject); await hooks.beforeAttempt!(target);
  const originalTransaction = db.transaction.bind(db); let failOnce = true;
  (db as any).transaction = async (...args: any[]) => {
    const tx = await originalTransaction(...args);
    return new Proxy(tx, { get(value, property) { if (property === "execute") return async (query: any) => { if (failOnce && query.sql?.startsWith("INSERT INTO usage_events")) { failOnce = false; throw new Error("injected settlement write failure"); } return value.execute(query); }; const member = Reflect.get(value, property); return typeof member === "function" ? member.bind(value) : member; } });
  };
  await complete(target, { input_tokens: 10 });
  (db as any).transaction = originalTransaction;
  await accounting.recoverAccountingJobs();
  const event = await db.execute({ sql: "SELECT status,cost_micros,confidence,input_known,output_known,cache_read_known,cache_creation_known FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, target.attemptId] });
  expect(event.rows[0]).toMatchObject({ status: 200, confidence: "assumed", input_known: 1, output_known: 0, cache_read_known: 0, cache_creation_known: 0 });
  const originalCost = Number(event.rows[0]!.cost_micros);
  await accounting.savePricingVersion(subject.workspace.id, { groupId: subject.group, rates: rates(2), mode: "replace" }); await accounting.runPricingJobs();
  const repriced = await db.execute({ sql: "SELECT cost_micros,confidence FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, target.attemptId] });
  expect(repriced.rows[0]).toMatchObject({ cost_micros: originalCost, confidence: "assumed" });
});

test.serial("accounts successful unlimited and disabled requests, and recognizes valid terminal stream variants", async () => {
  const subject = await setup("authoritative", 5);
  await accounting.setUnlimited(subject.workspace.id, true, false); const unlimited = attempt(subject); await hooks.beforeAttempt!(unlimited); await complete(unlimited, { input_tokens: 10, output_tokens: 0 });
  await accounting.setUnlimited(subject.workspace.id, false, false); const denied = await hooks.beforeAttempt!(attempt(subject)); expect(denied?.status).toBe(429);
  await accounting.saveBudget(subject.workspace.id, { keyId: subject.key.key.id, limitMicros: 100, enabled: false }); const disabled = attempt(subject); await hooks.beforeAttempt!(disabled); await complete(disabled, { input_tokens: 2, output_tokens: 0 });
  const counter = await db.execute({ sql: "SELECT spent_micros FROM budget_counters WHERE workspace_id=? AND gateway_key_id=?", args: [subject.workspace.id, subject.key.key.id] }); expect(Number(counter.rows[0]!.spent_micros)).toBeGreaterThanOrEqual(12);
  const encoder = new TextEncoder();
  for (const frame of ['data: {"type":"response.incomplete","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', 'data: {"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n']) { const streamed = attempt(subject); await hooks.beforeAttempt!(streamed); await hooks.onStream!(streamed.attemptId, new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frame)); controller.close(); } })); const event = await db.execute({ sql: "SELECT status FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, streamed.attemptId] }); expect(event.rows[0]!.status).toBe(200); }
  const failed = attempt(subject); await hooks.beforeAttempt!(failed); await hooks.onStream!(failed.attemptId, new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('event: response.done\ndata: {"response":{"status":"failed","usage":{"input_tokens":10,"output_tokens":1}}}\n\ndata: [DONE]\n\n')); controller.close(); } })); const failedEvent = await db.execute({ sql: "SELECT status,cost_micros FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, failed.attemptId] }); expect(failedEvent.rows[0]).toMatchObject({ status: 502, cost_micros: 0 });
  const incomplete = attempt(subject); await hooks.beforeAttempt!(incomplete); await hooks.onStream!(incomplete.attemptId, new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":1}}\n\n')); controller.close(); } })); const event = await db.execute({ sql: "SELECT status FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, incomplete.attemptId] }); expect(event.rows[0]!.status).toBe(502);
});

test.serial("serializes concurrent settlement rollups with the ledger write", async () => {
  const subject = await setup("rollup"); const first = attempt(subject), second = attempt(subject); await hooks.beforeAttempt!(first); await hooks.beforeAttempt!(second);
  const originalTransaction = db.transaction.bind(db); let pause!: () => void, arrived!: () => void; const gate = new Promise<void>((resolve) => { pause = resolve; }), reached = new Promise<void>((resolve) => { arrived = resolve; }); let armed = true;
  (db as any).transaction = async (...args: any[]) => { const tx = await originalTransaction(...args); return new Proxy(tx, { get(value, property) { if (property === "execute") return async (query: any) => { const result = await value.execute(query); if (armed && query.sql?.startsWith("INSERT INTO usage_events")) { armed = false; arrived(); await gate; } return result; }; const member = Reflect.get(value, property); return typeof member === "function" ? member.bind(value) : member; } }); };
  const settlingFirst = complete(first, { input_tokens: 1, output_tokens: 0 }); await reached; const settlingSecond = complete(second, { input_tokens: 2, output_tokens: 0 }); pause(); await Promise.all([settlingFirst, settlingSecond]); (db as any).transaction = originalTransaction;
  const rollups = await db.execute({ sql: "SELECT SUM(requests) requests,SUM(cost_micros) cost_micros FROM usage_rollups WHERE workspace_id=? AND granularity='daily'", args: [subject.workspace.id] }); expect(rollups.rows[0]).toMatchObject({ requests: 2, cost_micros: 3 });
});

test.serial("shutdown drains a queued successful settlement without changing its outcome", async () => {
  const subject = await setup("shutdown"); const target = attempt(subject); await hooks.beforeAttempt!(target);
  const originalTransaction = db.transaction.bind(db); let failOnce = true;
  (db as any).transaction = async (...args: any[]) => { const tx = await originalTransaction(...args); return new Proxy(tx, { get(value, property) { if (property === "execute") return async (query: any) => { if (failOnce && query.sql?.startsWith("INSERT INTO usage_events")) { failOnce = false; throw new Error("injected shutdown retry failure"); } return value.execute(query); }; const member = Reflect.get(value, property); return typeof member === "function" ? member.bind(value) : member; } }); };
  await complete(target, { input_tokens: 4, output_tokens: 0 }); (db as any).transaction = originalTransaction;
  await accounting.beginAccountingShutdown();
  const event = await db.execute({ sql: "SELECT status,cost_micros FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, target.attemptId] }); expect(event.rows[0]).toMatchObject({ status: 200, cost_micros: 4 });
});

test.serial("retries queue-write failures without replacing the original non-stream or stream outcome", async () => {
  const subject = await setup("queue retry"); const originalTransaction = db.transaction.bind(db);
  async function injectQueueFailure(run: () => Promise<void>) { let failOnce = true; (db as any).transaction = async (...args: any[]) => { const tx = await originalTransaction(...args); return new Proxy(tx, { get(value, property) { if (property === "execute") return async (query: any) => { if (failOnce && query.sql?.startsWith("INSERT INTO accounting_settlement_queue")) { failOnce = false; throw new Error("injected queue persistence failure"); } return value.execute(query); }; const member = Reflect.get(value, property); return typeof member === "function" ? member.bind(value) : member; } }); }; try { await run(); } finally { (db as any).transaction = originalTransaction; } }
  const nonstream = attempt(subject); await hooks.beforeAttempt!(nonstream); await injectQueueFailure(() => complete(nonstream, { input_tokens: 3, output_tokens: 0 })); await Bun.sleep(100);
  const nonstreamEvent = await db.execute({ sql: "SELECT status,cost_micros FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, nonstream.attemptId] }); expect(nonstreamEvent.rows[0]).toMatchObject({ status: 200, cost_micros: 3 });
  const streamed = attempt(subject); await hooks.beforeAttempt!(streamed); await injectQueueFailure(async () => { await hooks.onStream!(streamed.attemptId, new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n')); controller.close(); } })); });
  const streamEvent = await db.execute({ sql: "SELECT status,cost_micros FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, streamed.attemptId] }); expect(streamEvent.rows[0]).toMatchObject({ status: 200, cost_micros: 3 });
});

test.serial("returns a bounded explicit error only when neither durable handoff table is writable", async () => {
  const subject = await setup("queue unavailable"); const target = attempt(subject); await hooks.beforeAttempt!(target); const originalTransaction = db.transaction.bind(db);
  (db as any).transaction = async (...args: any[]) => { const tx = await originalTransaction(...args); return new Proxy(tx, { get(value, property) { if (property === "execute") return async (query: any) => { if (query.sql?.startsWith("INSERT INTO accounting_settlement_")) throw new Error("injected persistent handoff failure"); return value.execute(query); }; const member = Reflect.get(value, property); return typeof member === "function" ? member.bind(value) : member; } }); };
  let failure: unknown; try { await complete(target, { input_tokens: 2, output_tokens: 0 }); } catch (error) { failure = error; } finally { (db as any).transaction = originalTransaction; }
  expect(failure).toMatchObject({ code: "accounting_persistence_unavailable", status: 503 }); await accounting.recoverAccountingJobs(); const event = await db.execute({ sql: "SELECT status,cost_micros FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [subject.workspace.id, target.attemptId] }); expect(event.rows[0]).toMatchObject({ status: 200, cost_micros: 2 });
});

afterAll(async () => { await accounting.beginAccountingShutdown(); db.close(); });
