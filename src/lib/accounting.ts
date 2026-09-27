import type { Transaction } from "@libsql/client";
import { db } from "./db";
import { appDateStart, startOfAppDay, startOfAppHour, startOfAppMonth, startOfAppYear, mondayInAppTimeZone, addAppDays, appTimeZone, formatAppBucket } from "./timezone";
import type { GatewayAccountingHooks, GatewayAttempt } from "./gateway-runtime";
import { admitWorkspaceWrite, getWorkspace, isWorkspaceId } from "./workspaces";
import { quotaForAccount } from "./codex";
import { invalidatePublicAnalytics } from "./public-analytics-cache";
import { parseSseFrame, sseFrameOutcome } from "./sse";

const SCHEMA_VERSION = 7;
const MILLION = 1_000_000;
const MAX_SAFE_COST = Number.MAX_SAFE_INTEGER;
const MAX_PREDICTION_ROWS = 256;
const MAX_BEYOND_MODELS = 100;
const OUTCOME_PERSIST_ATTEMPTS = 3;
export type UsageMetrics = { input?: number; output?: number; cached?: number; cacheCreation?: number };
export type NormalizedUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number; completeness: "complete" | "partial" | "missing"; inputKnown: boolean; outputKnown: boolean; cacheReadKnown: boolean; cacheCreationKnown: boolean };
export type PricingRates = { inputMicrosPerMillion: number; outputMicrosPerMillion: number; cacheReadMicrosPerMillion: number; cacheCreationMicrosPerMillion: number };
export type PricingTier = PricingRates & { thresholdTokens: number };
export type Pricing = PricingRates & { groupId: string; versionId: string; tiers: PricingTier[] };
type Prediction = { cost: number; source: string; sampleCount: number; reservation: boolean };
type PredictionContext = { settlement?: Prediction; reservation?: Prediction };
type AttemptState = { attemptId: string; attempt: GatewayAttempt; pricing?: Pricing; reservation?: { amount: number; windowStart: number }; windowStart?: number; estimate?: number; prediction?: PredictionContext; requestBodyBytes: number; settled: boolean };
const attempts = new Map<string, AttemptState>();
const deletingAccountingWorkspaces = new Set<string>();
const activePricingJobs = new Map<string, Promise<void>>();
const fixedGroupSyncs = new Map<string, Promise<void>>();
const activeSettlementJobs = new Map<string, Promise<void>>();
const pendingSettlementOutcomes = new Map<string, { status: number; metrics?: UsageMetrics; completedAt: number; ttftMs?: number; terminal: boolean }>();
const persistingSettlementOutcomes = new Map<string, Promise<void>>();
const activePricingRuns = new Set<Promise<void>>();
let settlementRetryTimer: ReturnType<typeof setTimeout> | undefined;
let lastCodexAnchorSweep = 0;
const activeCodexAnchorRefreshes = new Set<Promise<void>>();
const shutdownFinalizers = new Set<() => Promise<void>>();
/** Runtime-owned transports register draining work without importing the
 * gateway module here (which would create an accounting/runtime cycle). */
export function registerAccountingShutdownFinalizer(finalizer: () => Promise<void>): () => void { shutdownFinalizers.add(finalizer); return () => shutdownFinalizers.delete(finalizer); }

function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function first(object: Record<string, unknown> | undefined, names: string[]): number | undefined { for (const name of names) { const value = number(object?.[name]); if (value !== undefined) return value; } return undefined; }
export function extractUsageMetrics(payload: unknown): UsageMetrics | undefined {
  const root = record(payload); if (!root) return undefined;
  const response = record(root.response) ?? root; const message = record(root.message); const metadata = record(root.metadata); const meta = record(root.meta);
  let result: UsageMetrics | undefined;
  for (const source of [record(response.usage), record(root.usage), record(message?.usage), record(response.usageMetadata), record(response.usage_metadata), record(root.metrics), record(metadata?.usage), record(meta?.billed_units), record(root["amazon-bedrock-invocationMetrics"])] .filter(Boolean) as Record<string, unknown>[]) {
    let input = first(source, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount", "inputTokenCount", "input_token_count"]);
    const output = first(source, ["output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount", "outputTokenCount", "output_token_count"]);
    const details = record(source.input_tokens_details) ?? record(source.prompt_tokens_details);
    const cached = first(details, ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"]) ?? first(source, ["cache_read_input_tokens", "cacheReadInputTokens", "cacheReadInputTokenCount", "cached_content_token_count", "cachedContentTokenCount", "cached_tokens"]);
    const cacheCreation = first(details, ["cache_write_tokens", "cacheWriteTokens"]) ?? first(source, ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_tokens", "cacheWriteInputTokens"]);
    const anthropicRead = first(source, ["cache_read_input_tokens", "cacheReadInputTokens"]); const anthropicWrite = first(source, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    if (input !== undefined && (anthropicRead !== undefined || anthropicWrite !== undefined)) input += (anthropicRead ?? 0) + (anthropicWrite ?? 0);
    if (input !== undefined || output !== undefined || cached !== undefined || cacheCreation !== undefined) result = { ...result, ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}), ...(cached !== undefined ? { cached } : {}), ...(cacheCreation !== undefined ? { cacheCreation } : {}) };
  }
  return result;
}
export function normalizeUsageMetrics(metrics?: UsageMetrics): NormalizedUsage {
  const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const inputKnown = valid(metrics?.input), outputKnown = valid(metrics?.output), cacheReadKnown = valid(metrics?.cached), cacheCreationKnown = valid(metrics?.cacheCreation);
  const token = (value: unknown) => valid(value) ? Math.min(MAX_SAFE_COST, Math.floor(value as number)) : 0;
  const inputTokens = token(metrics?.input), outputTokens = token(metrics?.output), cacheReadTokens = token(metrics?.cached), cacheCreationTokens = token(metrics?.cacheCreation);
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens: Math.min(MAX_SAFE_COST, inputTokens + outputTokens), completeness: inputKnown && outputKnown ? "complete" : inputKnown || outputKnown || cacheReadKnown || cacheCreationKnown ? "partial" : "missing", inputKnown, outputKnown, cacheReadKnown, cacheCreationKnown };
}
export function calculateUsageCost(usage: NormalizedUsage, pricing?: Pricing): { costMicros: number; confidence: "exact" | "assumed" | "unpriced"; tier?: string } {
  if (!pricing || usage.completeness === "missing") return { costMicros: 0, confidence: "unpriced" };
  let tier: PricingRates | undefined; let tierName = "standard";
  for (const candidate of pricing.tiers ?? []) if (usage.inputTokens >= candidate.thresholdTokens && (!tier || candidate.thresholdTokens > (tier as PricingTier).thresholdTokens)) { tier = candidate; tierName = `context-${candidate.thresholdTokens}`; }
  const rates = tier ?? pricing;
  if (![rates.inputMicrosPerMillion, rates.outputMicrosPerMillion, rates.cacheReadMicrosPerMillion, rates.cacheCreationMicrosPerMillion].every((value) => Number.isSafeInteger(value) && value >= 0)) return { costMicros: 0, confidence: "unpriced" };
  const billableInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens);
  const cost = Math.round((billableInput * rates.inputMicrosPerMillion + usage.outputTokens * rates.outputMicrosPerMillion + usage.cacheReadTokens * rates.cacheReadMicrosPerMillion + usage.cacheCreationTokens * rates.cacheCreationMicrosPerMillion) / MILLION);
  return { costMicros: Math.min(MAX_SAFE_COST, Math.max(0, cost)), confidence: usage.completeness === "complete" && (usage.cacheReadKnown || rates.cacheReadMicrosPerMillion === 0) && (usage.cacheCreationKnown || rates.cacheCreationMicrosPerMillion === 0) ? "exact" : "assumed", tier: tierName };
}
let accountingWriteTail: Promise<void> = Promise.resolve();
/** SQLite does not queue `BEGIN write`; serialize accounting writers in-process
 * before retaining the bounded cross-module busy retry. */
async function writeTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> { const previous = accountingWriteTail; let release!: () => void; accountingWriteTail = new Promise<void>((resolve) => { release = resolve; }); await previous.catch(() => undefined); try { let failure: unknown; for (let retry = 0; retry < 12; retry++) { let tx: Transaction | undefined; try { tx = await db.transaction("write"); const value = await fn(tx); await tx.commit(); return value; } catch (error) { failure = error; if (tx && !tx.closed) await tx.rollback().catch(() => undefined); if (!/busy|locked/i.test(String(error)) || retry === 11) throw error; await Bun.sleep(12 * (retry + 1)); } finally { tx?.close(); } } throw failure; } finally { release(); } }
function checkedRate(value: unknown): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AccountingError("Pricing rates must be non-negative integer micros per million.", 400); return parsed; }
function json<T>(value: T): string { return JSON.stringify(value); }
function parse<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
function durableAttempt(attempt: GatewayAttempt): Pick<GatewayAttempt, "attemptId" | "requestId" | "workspaceId" | "gatewayKeyId" | "requestedModel" | "memberRequestedModel" | "providerId" | "protocol" | "startedAt" | "requestBodyBytes" | "comboMember" | "consumerWorkspaceId" | "consumerGatewayKeyId" | "consumerModelId"> & { model: { id: string } } { return { attemptId: attempt.attemptId, requestId: attempt.requestId, workspaceId: attempt.workspaceId, gatewayKeyId: attempt.gatewayKeyId, requestedModel: attempt.requestedModel, ...(attempt.memberRequestedModel ? { memberRequestedModel: attempt.memberRequestedModel } : {}), providerId: attempt.providerId, protocol: attempt.protocol, startedAt: attempt.startedAt, requestBodyBytes: attempt.requestBodyBytes, ...(attempt.comboMember ? { comboMember: true } : {}), ...(attempt.consumerWorkspaceId ? { consumerWorkspaceId: attempt.consumerWorkspaceId, consumerGatewayKeyId: attempt.consumerGatewayKeyId, consumerModelId: attempt.consumerModelId } : {}), model: { id: attempt.model.id } }; }
export class AccountingError extends Error { constructor(message: string, readonly status = 400, readonly code?: string) { super(message); this.name = "AccountingError"; } }

export async function ensureAccountingSchema(): Promise<void> { await db.batch([
  { sql: "CREATE TABLE IF NOT EXISTS accounting_schema_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)" },
  { sql: "CREATE TABLE IF NOT EXISTS accounting_deleted_workspaces (workspace_id TEXT PRIMARY KEY NOT NULL)" },
  { sql: "CREATE TABLE IF NOT EXISTS model_pricing_groups (id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('fixed','custom')), group_key TEXT NOT NULL, canonical_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,kind,group_key))" },
  { sql: "CREATE TABLE IF NOT EXISTS model_pricing_memberships (workspace_id TEXT NOT NULL, group_id TEXT NOT NULL, model_id TEXT NOT NULL, PRIMARY KEY(workspace_id,model_id), FOREIGN KEY(workspace_id,group_id) REFERENCES model_pricing_groups(workspace_id,id) ON DELETE CASCADE)" },
  { sql: "CREATE TABLE IF NOT EXISTS pricing_fixed_membership_overrides (workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, group_id TEXT, PRIMARY KEY(workspace_id,model_id))" },
  { sql: "CREATE TABLE IF NOT EXISTS model_pricing_versions (id TEXT NOT NULL, workspace_id TEXT NOT NULL, group_id TEXT NOT NULL, version INTEGER NOT NULL, effective_at INTEGER NOT NULL, input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL, cache_read_rate INTEGER NOT NULL, cache_creation_rate INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,group_id,version))" },
  { sql: "CREATE TABLE IF NOT EXISTS model_pricing_tiers (workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, threshold_tokens INTEGER NOT NULL, input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL, cache_read_rate INTEGER NOT NULL, cache_creation_rate INTEGER NOT NULL, PRIMARY KEY(workspace_id,version_id,threshold_tokens))" },
  { sql: "CREATE TABLE IF NOT EXISTS pricing_jobs (id TEXT NOT NULL, workspace_id TEXT NOT NULL, group_id TEXT NOT NULL, version_id TEXT NOT NULL, state TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, error TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id))" },
    { sql: "CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_id TEXT NOT NULL, gateway_key_id TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, gateway_model_id TEXT NOT NULL, protocol TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ttft_ms INTEGER, status INTEGER NOT NULL, request_body_bytes INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, input_known INTEGER NOT NULL DEFAULT 1, output_known INTEGER NOT NULL DEFAULT 1, cache_read_known INTEGER NOT NULL DEFAULT 1, cache_creation_known INTEGER NOT NULL DEFAULT 1, cost_micros INTEGER NOT NULL, confidence TEXT NOT NULL, completeness TEXT NOT NULL, cost_source TEXT, prediction_json TEXT, price_group_id TEXT, price_version_id TEXT, price_tier TEXT, UNIQUE(workspace_id,attempt_id))" },
  { sql: "CREATE INDEX IF NOT EXISTS usage_events_workspace_completed ON usage_events(workspace_id,completed_at)" }, { sql: "CREATE INDEX IF NOT EXISTS usage_events_prediction ON usage_events(workspace_id,gateway_key_id,model_id,completed_at)" },
  { sql: "CREATE TABLE IF NOT EXISTS usage_rollups (workspace_id TEXT NOT NULL, granularity TEXT NOT NULL, bucket_start INTEGER NOT NULL, gateway_key_id TEXT NOT NULL, gateway_model_id TEXT NOT NULL, requests INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, cost_micros INTEGER NOT NULL, exact_requests INTEGER NOT NULL, assumed_requests INTEGER NOT NULL, unpriced_requests INTEGER NOT NULL, failed_requests INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,granularity,bucket_start,gateway_key_id,gateway_model_id))" },
  { sql: "CREATE TRIGGER IF NOT EXISTS accounting_prevent_deleted_rollups BEFORE INSERT ON usage_rollups WHEN EXISTS(SELECT 1 FROM accounting_deleted_workspaces WHERE workspace_id=NEW.workspace_id) BEGIN SELECT RAISE(IGNORE); END" },
  { sql: "CREATE TABLE IF NOT EXISTS gateway_budgets (workspace_id TEXT NOT NULL, gateway_key_id TEXT NOT NULL, limit_micros INTEGER NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,gateway_key_id))" },
   { sql: "CREATE TABLE IF NOT EXISTS budget_windows (workspace_id TEXT PRIMARY KEY NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, bypass INTEGER NOT NULL DEFAULT 0, bypass_session_id TEXT, auto_end INTEGER NOT NULL DEFAULT 0, anchor_account_id TEXT, anchor_reset_at INTEGER, anchor_checked_at INTEGER, anchor_attempted_at INTEGER, anchor_error TEXT, updated_at INTEGER NOT NULL)" },
  { sql: "CREATE TABLE IF NOT EXISTS budget_counters (workspace_id TEXT NOT NULL, gateway_key_id TEXT NOT NULL, window_start INTEGER NOT NULL, spent_micros INTEGER NOT NULL DEFAULT 0, reserved_micros INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,gateway_key_id,window_start))" },
   { sql: "CREATE TABLE IF NOT EXISTS budget_reservations (workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, gateway_key_id TEXT NOT NULL, window_start INTEGER NOT NULL, amount_micros INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,attempt_id))" },
    { sql: "CREATE TABLE IF NOT EXISTS accounting_attempts (workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_json TEXT NOT NULL, pricing_json TEXT, estimate_micros INTEGER, prediction_json TEXT, window_start INTEGER, request_body_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,attempt_id))" },
   { sql: "CREATE TABLE IF NOT EXISTS accounting_settlement_queue (workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, status INTEGER NOT NULL, terminal INTEGER NOT NULL, metrics_json TEXT, completed_at INTEGER NOT NULL, ttft_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,attempt_id))" },
   { sql: "CREATE TABLE IF NOT EXISTS accounting_settlement_fallback (workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, status INTEGER NOT NULL, terminal INTEGER NOT NULL, metrics_json TEXT, completed_at INTEGER NOT NULL, ttft_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,attempt_id))" },
  { sql: "CREATE TABLE IF NOT EXISTS budget_settings (workspace_id TEXT PRIMARY KEY NOT NULL, unlimited_exclusions_json TEXT NOT NULL DEFAULT '[]', beyond_enabled INTEGER NOT NULL DEFAULT 0, beyond_models_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)" },
  { sql: "CREATE TABLE IF NOT EXISTS budget_bypass_sessions (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT)" },
  { sql: "INSERT INTO accounting_schema_meta(id,version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=MAX(version,excluded.version)", args: [SCHEMA_VERSION] },
 ], "write");
  // Existing installations predate usage-presence fields. SQLite has no
  // portable ADD COLUMN IF NOT EXISTS, so inspect before adding them.
  const columns = await db.execute("PRAGMA table_info(usage_events)");
  for (const name of ["input_known", "output_known", "cache_read_known", "cache_creation_known"]) if (!columns.rows.some((column) => String(column.name) === name)) await db.execute(`ALTER TABLE usage_events ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 1`);
   const attemptColumns = await db.execute("PRAGMA table_info(accounting_attempts)");
  if (!attemptColumns.rows.some((column) => String(column.name) === "prediction_json")) await db.execute("ALTER TABLE accounting_attempts ADD COLUMN prediction_json TEXT");
   if (!columns.rows.some((column) => String(column.name) === "prediction_json")) await db.execute("ALTER TABLE usage_events ADD COLUMN prediction_json TEXT");
   const windowColumns = await db.execute("PRAGMA table_info(budget_windows)");
    for (const [name, definition] of [["anchor_account_id", "TEXT"], ["anchor_reset_at", "INTEGER"], ["anchor_checked_at", "INTEGER"], ["anchor_attempted_at", "INTEGER"], ["anchor_error", "TEXT"]] as const) if (!windowColumns.rows.some((column) => String(column.name) === name)) await db.execute(`ALTER TABLE budget_windows ADD COLUMN ${name} ${definition}`);
   const groupColumns = await db.execute("PRAGMA table_info(model_pricing_groups)");
   for (const [name, definition] of [["name_overridden", "INTEGER NOT NULL DEFAULT 0"], ["canonical_overridden", "INTEGER NOT NULL DEFAULT 0"]] as const) if (!groupColumns.rows.some((column) => String(column.name) === name)) await db.execute(`ALTER TABLE model_pricing_groups ADD COLUMN ${name} ${definition}`);
}

async function pricingForModel(workspaceId: string, modelId: string, at = Date.now()): Promise<Pricing | undefined> {
  const lookup = async () => { let failure: unknown; for (let attempt = 0; attempt < 8; attempt++) try { return await db.execute({ sql: `SELECT v.id,v.input_rate,v.output_rate,v.cache_read_rate,v.cache_creation_rate,g.id AS group_id FROM model_pricing_memberships m JOIN provider_models pm ON pm.workspace_id=m.workspace_id AND pm.id=m.model_id JOIN model_pricing_groups g ON g.workspace_id=m.workspace_id AND g.id=m.group_id JOIN model_pricing_versions v ON v.workspace_id=g.workspace_id AND v.group_id=g.id WHERE m.workspace_id=? AND pm.gateway_model_id=? AND v.effective_at<=? ORDER BY v.effective_at DESC,v.version DESC LIMIT 1`, args: [workspaceId, modelId, at] }); } catch (error) { failure = error; if (!/busy|locked/i.test(String(error)) || attempt === 7) throw error; await Bun.sleep(8 * (attempt + 1)); } throw failure; };
  // A configured custom rate is already authoritative; avoid an unrelated
  // fixed-group write on the hot admission path. Only derive a fixed group when
  // no configured membership can price this model.
  let current = await lookup();
  if (!current.rows.length) { await syncFixedGroups(workspaceId); current = await lookup(); }
  const row = current.rows[0]; if (!row) return undefined; const versionId = String(row.id);
  const tiers = await db.execute({ sql: "SELECT threshold_tokens,input_rate,output_rate,cache_read_rate,cache_creation_rate FROM model_pricing_tiers WHERE workspace_id=? AND version_id=? ORDER BY threshold_tokens", args: [workspaceId, versionId] });
  return { groupId: String(row.group_id), versionId, inputMicrosPerMillion: Number(row.input_rate), outputMicrosPerMillion: Number(row.output_rate), cacheReadMicrosPerMillion: Number(row.cache_read_rate), cacheCreationMicrosPerMillion: Number(row.cache_creation_rate), tiers: tiers.rows.map((tier) => ({ thresholdTokens: Number(tier.threshold_tokens), inputMicrosPerMillion: Number(tier.input_rate), outputMicrosPerMillion: Number(tier.output_rate), cacheReadMicrosPerMillion: Number(tier.cache_read_rate), cacheCreationMicrosPerMillion: Number(tier.cache_creation_rate) })) };
}
function outputLimit(payload: Record<string, unknown> | undefined): number { for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens"]) { const value = number(payload?.[key]); if (value !== undefined) return Math.min(value, 1_000_000); } return 4096; }
function quantile(values: number[], probability: number): number { const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right); if (!sorted.length) return 0; const position = (sorted.length - 1) * probability; const lower = Math.floor(position), upper = Math.ceil(position); return lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower); }
/** Predicts from exact observations only. The increasingly broad pools make the
 * provenance explicit without mixing a protocol-specific sample with a random
 * global history row. */
async function estimate(workspaceId: string, keyId: string, modelId: string, _gatewayModelId: string, protocol: string, bytes: number, pricing: Pricing, payload: Record<string, unknown> | undefined, reservation: boolean): Promise<Prediction> {
  const pools: Array<{ where: string; args: (string | number)[]; source: string }> = [
    { where: "gateway_key_id=? AND model_id=? AND protocol=?", args: [keyId, modelId, protocol], source: "key-model-protocol" },
    { where: "gateway_key_id=? AND model_id=?", args: [keyId, modelId], source: "key-model" },
    { where: "model_id=? AND protocol=?", args: [modelId, protocol], source: "model-protocol" },
    { where: "model_id=?", args: [modelId], source: "model" },
  ];
  // All priced models benefit from their own exact payload history. The model
  // and protocol hierarchy prevents crossing tokenizer/transport boundaries.
  if (bytes > 0) for (const pool of pools) {
    const history = await db.execute({ sql: `SELECT request_body_bytes,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens FROM usage_events WHERE workspace_id=? AND confidence='exact' AND completeness='complete' AND request_body_bytes>0 AND ${pool.where} ORDER BY ABS(request_body_bytes-?) ASC, completed_at DESC LIMIT ?`, args: [workspaceId, ...pool.args, bytes, MAX_PREDICTION_ROWS] });
    if (history.rows.length < 3) continue;
    const neighbors = history.rows.slice(0, Math.min(31, history.rows.length)); const percentile = reservation ? .75 : .5;
    const scaled = (column: string) => quantile(neighbors.map((row) => Number(row[column]) / Number(row.request_body_bytes) * bytes), percentile);
    const input = Math.max(1, Math.round(scaled("input_tokens")));
    const cacheRead = Math.min(input, Math.max(0, Math.floor(input * quantile(neighbors.map((row) => Number(row.cache_read_tokens) / Math.max(1, Number(row.input_tokens))), reservation ? .25 : .5))));
    const cacheCreation = Math.min(input - cacheRead, Math.max(0, Math.floor(input * quantile(neighbors.map((row) => Number(row.cache_creation_tokens) / Math.max(1, Number(row.input_tokens))), percentile))));
    const output = Math.min(outputLimit(payload), Math.max(0, Math.round(quantile(neighbors.map((row) => Number(row.output_tokens)), percentile))));
    return { cost: calculateUsageCost(normalizeUsageMetrics({ input, output, cached: cacheRead, cacheCreation }), pricing).costMicros, source: `payload-calibrated-${reservation ? "p75-reservation" : "p50-settlement"}:${pool.source}`, sampleCount: neighbors.length, reservation };
  }
  const usage = normalizeUsageMetrics({ input: Math.max(1, Math.ceil(bytes / 3)), output: outputLimit(payload), cached: 0, cacheCreation: 0 });
  return { cost: calculateUsageCost(usage, pricing).costMicros, source: `bounded-formula:${reservation ? "p75-reservation" : "p50-settlement"}`, sampleCount: 0, reservation };
}
async function currentWindow(tx: Transaction, workspaceId: string, now: number): Promise<{ start: number; end: number; bypass: boolean; exclusions: string[]; beyond: string[]; beyondEnabled: boolean }> {
  const defaultStart = mondayInAppTimeZone(now).getTime(); const defaultEnd = addAppDays(defaultStart, 7).getTime(); const existing = await tx.execute({ sql: "SELECT start_at,end_at,duration_ms,bypass,auto_end,bypass_session_id FROM budget_windows WHERE workspace_id=?", args: [workspaceId] }); let row = existing.rows[0];
  if (!row) { await tx.execute({ sql: "INSERT INTO budget_windows(workspace_id,start_at,end_at,duration_ms,bypass,auto_end,updated_at) VALUES(?,?,?,?,0,0,?)", args: [workspaceId, defaultStart, defaultEnd, defaultEnd - defaultStart, now] }); row = { start_at: defaultStart, end_at: defaultEnd, duration_ms: defaultEnd - defaultStart, bypass: 0, auto_end: 0 } as typeof row; }
  let start = Number(row.start_at), end = Number(row.end_at), bypass = Number(row.bypass) === 1; const duration = Number(row.duration_ms);
  if (end <= now && duration > 0) {
    const previousEnd = end; const sessionId = row.bypass_session_id ? String(row.bypass_session_id) : undefined;
    const steps = Math.max(1, Math.floor((now - start) / duration)); start += steps * duration; end += steps * duration;
    const autoEnded = bypass && Number(row.auto_end) === 1; if (autoEnded) bypass = false;
    if (autoEnded && sessionId) await tx.execute({ sql: "UPDATE budget_bypass_sessions SET ended_at=?,end_reason='window_end' WHERE id=? AND workspace_id=? AND ended_at IS NULL", args: [previousEnd, sessionId, workspaceId] });
    await tx.execute({ sql: "UPDATE budget_windows SET start_at=?,end_at=?,bypass=?,bypass_session_id=CASE WHEN ?=0 THEN NULL ELSE bypass_session_id END,auto_end=CASE WHEN ?=0 THEN 0 ELSE auto_end END,updated_at=? WHERE workspace_id=?", args: [start, end, bypass ? 1 : 0, bypass ? 1 : 0, bypass ? 1 : 0, now, workspaceId] });
  }
  const settings = await tx.execute({ sql: "SELECT unlimited_exclusions_json,beyond_enabled,beyond_models_json FROM budget_settings WHERE workspace_id=?", args: [workspaceId] }); const setting = settings.rows[0]; return { start, end, bypass, exclusions: parse(String(setting?.unlimited_exclusions_json ?? "[]"), []), beyond: parse(String(setting?.beyond_models_json ?? "[]"), []), beyondEnabled: Number(setting?.beyond_enabled ?? 0) === 1 };
}

type CodexWeeklyWindow = { resetAt?: unknown };

/**
 * A Codex anchor is an owned-account observation, never a client-supplied date.
 * The provider's weekly reset is an absolute instant, so its seven-day period is
 * immune to ledger-timezone DST changes. A custom interval remains intact when
 * a refresh is unavailable; it is the explicit fallback rather than fabricated
 * quota data.
 */
export async function refreshCodexBudgetAnchor(workspaceId: string): Promise<void> {
  const configured = await db.execute({ sql: "SELECT anchor_account_id,anchor_reset_at,anchor_checked_at,anchor_attempted_at FROM budget_windows WHERE workspace_id=?", args: [workspaceId] });
  const row = configured.rows[0]; const accountId = row?.anchor_account_id ? String(row.anchor_account_id) : "";
  if (!accountId) return;
  const now = Date.now();
  // A bounded refresh makes admission cheap while still immediately observing a
  // changed provider window on the next explicit budget read/anchor save.
  if (Number(row?.anchor_attempted_at ?? row?.anchor_checked_at ?? 0) > now - 5 * 60_000) return;
  const admission = await admitWorkspaceWrite(workspaceId);
  if (!admission) return;
  try {
    const quota = await quotaForAccount(workspaceId, accountId, true);
    const resetAt = Date.parse(String((quota.weekly as CodexWeeklyWindow | undefined)?.resetAt ?? ""));
    if (quota.stale === true || quota.reauthRequired === true || typeof quota.error === "string" || !Number.isFinite(resetAt) || resetAt <= now) throw new AccountingError(typeof quota.error === "string" ? quota.error : "Codex weekly reset is unavailable.", 502);
    const startAt = resetAt - 7 * 86_400_000;
    await writeTransaction(async (tx) => {
      const latest = await tx.execute({ sql: "SELECT anchor_account_id,end_at,bypass,auto_end,bypass_session_id FROM budget_windows WHERE workspace_id=?", args: [workspaceId] });
      if (String(latest.rows[0]?.anchor_account_id ?? "") !== accountId) return;
      const previous = latest.rows[0]; const autoEnded = Number(previous?.end_at ?? Infinity) <= now && Number(previous?.bypass) === 1 && Number(previous?.auto_end) === 1; const sessionId = previous?.bypass_session_id ? String(previous.bypass_session_id) : undefined;
      // Settle the old period/session before replacing the anchor period. This
      // makes a delayed provider refresh behave exactly like normal rollover.
      if (autoEnded && sessionId) await tx.execute({ sql: "UPDATE budget_bypass_sessions SET ended_at=?,end_reason='window_end' WHERE id=? AND workspace_id=? AND ended_at IS NULL", args: [Number(previous?.end_at), sessionId, workspaceId] });
      await tx.execute({ sql: "UPDATE budget_windows SET start_at=?,end_at=?,duration_ms=?,bypass=CASE WHEN ? THEN 0 ELSE bypass END,bypass_session_id=CASE WHEN ? THEN NULL ELSE bypass_session_id END,auto_end=CASE WHEN ? THEN 0 ELSE auto_end END,anchor_reset_at=?,anchor_checked_at=?,anchor_attempted_at=?,anchor_error=NULL,updated_at=? WHERE workspace_id=? AND anchor_account_id=?", args: [startAt, resetAt, 7 * 86_400_000, autoEnded ? 1 : 0, autoEnded ? 1 : 0, autoEnded ? 1 : 0, resetAt, now, now, now, workspaceId, accountId] });
    });
  } catch (error) {
    await db.execute({ sql: "UPDATE budget_windows SET anchor_attempted_at=?,anchor_error=?,updated_at=? WHERE workspace_id=? AND anchor_account_id=?", args: [now, error instanceof Error ? error.message.slice(0, 256) : "Codex weekly reset is unavailable.", now, workspaceId, accountId] }).catch(() => undefined);
  } finally { admission.release(); }
}

/** Bounded, workspace-qualified background refresh; inactive/deleted rows are never recreated. */
export function refreshCodexBudgetAnchors(): Promise<void> {
  const work = (async () => {
    const now = Date.now(); if (now - lastCodexAnchorSweep < 60_000) return;
    lastCodexAnchorSweep = now;
    const anchors = await db.execute({ sql: "SELECT w.workspace_id FROM budget_windows w JOIN workspaces p ON p.id=w.workspace_id AND p.status='active' WHERE w.anchor_account_id IS NOT NULL LIMIT 32" }).catch(() => ({ rows: [] }));
    await Promise.all(anchors.rows.map((row) => refreshCodexBudgetAnchor(String(row.workspace_id))));
  })();
  activeCodexAnchorRefreshes.add(work);
  void work.finally(() => activeCodexAnchorRefreshes.delete(work));
  return work;
}
function admissionResponse(status: number, message: string, code: string, retryAfter?: number): Response { return Response.json({ error: { message, code } }, { status, headers: { "cache-control": "no-store", "x-rawroute-combo-terminal": "1", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) } }); }
/** Shared traffic is governed by the owner's resolved model only. Consumer
 * aliases and combo names are display metadata and must never widen an owner
 * exclusion or Beyond Limits allowlist. */
function policyMatches(values: string[], attempt: GatewayAttempt): boolean { return attempt.consumerWorkspaceId ? values.includes(attempt.model.id) : values.includes(attempt.requestedModel) || values.includes(attempt.memberRequestedModel ?? "") || values.includes(attempt.model.id); }
async function reserve(attempt: GatewayAttempt, bytes = 0, payload?: Record<string, unknown>): Promise<Response | undefined> {
  let pricing: Pricing | undefined;
  try { pricing = await pricingForModel(attempt.workspaceId, attempt.model.id); } catch (error) {
    // Direct gateway-runtime fixtures deliberately do not initialize the
    // accounting migration. A real server initializes it before listening;
    // all other database failures remain fail-closed below.
    if (/no such table/i.test(String(error))) return undefined;
    return admissionResponse(503, "Budget state is unavailable.", "budget_unavailable");
  }
  const state: AttemptState = { attemptId: attempt.attemptId, attempt, pricing, requestBodyBytes: bytes, settled: false };
  const settlementPrediction = pricing ? await estimate(attempt.workspaceId, attempt.gatewayKeyId, attempt.model.id, attempt.model.id, attempt.protocol, bytes, pricing, payload, false) : undefined;
  const reservationPrediction = pricing ? await estimate(attempt.workspaceId, attempt.gatewayKeyId, attempt.model.id, attempt.model.id, attempt.protocol, bytes, pricing, payload, true) : undefined;
  if (settlementPrediction) state.prediction = { settlement: settlementPrediction };
  let persisted = false;
  try { const now = Date.now(); const decision = await writeTransaction(async (tx) => {
    const window = await currentWindow(tx, attempt.workspaceId, now); state.windowStart = window.start;
    const persist = async () => { await tx.execute({ sql: "INSERT INTO accounting_attempts(workspace_id,attempt_id,attempt_json,pricing_json,estimate_micros,prediction_json,window_start,request_body_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,attempt_id) DO NOTHING", args: [attempt.workspaceId, attempt.attemptId, json(durableAttempt(attempt)), pricing ? json(pricing) : null, state.estimate ?? null, state.prediction ? json(state.prediction) : null, window.start, bytes, now] }); persisted = true; };
    if (window.bypass && policyMatches(window.exclusions, attempt)) return attempt.comboMember ? new Response(JSON.stringify({ error: { message: "This combo member is excluded while Unlimited Mode is active.", code: "model_excluded_in_unlimited_mode" } }), { status: 403, headers: { "content-type": "application/json", "x-rawroute-combo-member-unavailable": "1" } }) : admissionResponse(403, "This model is excluded while Unlimited Mode is active.", "model_excluded_in_unlimited_mode");
    const budgetResult = await tx.execute({ sql: "SELECT limit_micros,enabled FROM gateway_budgets WHERE workspace_id=? AND gateway_key_id=?", args: [attempt.workspaceId, attempt.gatewayKeyId] }); const [budget] = [...budgetResult.rows];
    if (budget && Number(budget.enabled) === 1 && !window.bypass) {
      if (!pricing || !reservationPrediction) return admissionResponse(503, "Budget pricing is unavailable.", "budget_pricing_unavailable");
      const reservation = reservationPrediction, limit = Number(budget.limit_micros); const hold = reservation.cost <= limit ? await tx.execute({ sql: "INSERT INTO budget_counters(workspace_id,gateway_key_id,window_start,spent_micros,reserved_micros,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,gateway_key_id,window_start) DO UPDATE SET reserved_micros=budget_counters.reserved_micros+excluded.reserved_micros,updated_at=excluded.updated_at WHERE budget_counters.spent_micros+budget_counters.reserved_micros+excluded.reserved_micros<=? RETURNING reserved_micros", args: [attempt.workspaceId, attempt.gatewayKeyId, window.start, 0, reservation.cost, now, limit] }) : undefined;
      if (!hold || ![...hold.rows].length) { if (!(window.beyondEnabled && policyMatches(window.beyond, attempt))) { await persist(); return admissionResponse(429, "Budget limit exceeded.", "budget_exceeded", Math.max(1, Math.ceil((window.end - now) / 1000))); } } else { state.estimate = reservation.cost; state.prediction = { ...state.prediction, reservation }; state.reservation = { amount: reservation.cost, windowStart: window.start }; }
    }
    await persist(); if (state.reservation) await tx.execute({ sql: "INSERT INTO budget_reservations(workspace_id,attempt_id,gateway_key_id,window_start,amount_micros,state,created_at) VALUES(?,?,?,?,?,'reserved',?) ON CONFLICT(workspace_id,attempt_id) DO NOTHING", args: [attempt.workspaceId, attempt.attemptId, attempt.gatewayKeyId, window.start, state.reservation.amount, now] }); return undefined;
  }); if (persisted) attempts.set(attempt.attemptId, state); return decision;
  } catch { attempts.delete(attempt.attemptId); return admissionResponse(503, "Budget state is unavailable.", "budget_unavailable"); }
}
function storedState(row: Record<string, unknown>): AttemptState | undefined {
  const attempt = parse<GatewayAttempt | null>(row.attempt_json, null);
  if (!attempt || typeof attempt.attemptId !== "string" || typeof attempt.workspaceId !== "string") return undefined;
  const rawPrediction = parse<PredictionContext | Prediction | undefined>(row.prediction_json, undefined); const prediction = rawPrediction && "cost" in rawPrediction ? { settlement: rawPrediction } : rawPrediction;
  return { attemptId: attempt.attemptId, attempt, pricing: parse<Pricing | undefined>(row.pricing_json, undefined), estimate: row.estimate_micros === null ? undefined : Number(row.estimate_micros), prediction, windowStart: row.window_start === null ? undefined : Number(row.window_start), requestBodyBytes: Number(row.request_body_bytes), settled: false };
}
async function addRollups(tx: Transaction, workspaceId: string, row: { completedAt: number; gatewayKeyId: string; modelId: string; usage: NormalizedUsage; cost: number; confidence: string; succeeded: boolean }, now: number): Promise<void> {
  for (const [granularity, start] of [["hourly", startOfAppHour(row.completedAt).getTime()], ["daily", startOfAppDay(row.completedAt).getTime()], ["monthly", startOfAppMonth(row.completedAt).getTime()]] as const) await tx.execute({ sql: "INSERT INTO usage_rollups(workspace_id,granularity,bucket_start,gateway_key_id,gateway_model_id,requests,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_tokens,cost_micros,exact_requests,assumed_requests,unpriced_requests,failed_requests,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,granularity,bucket_start,gateway_key_id,gateway_model_id) DO UPDATE SET requests=requests+1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,cache_creation_tokens=cache_creation_tokens+excluded.cache_creation_tokens,total_tokens=total_tokens+excluded.total_tokens,cost_micros=cost_micros+excluded.cost_micros,exact_requests=exact_requests+excluded.exact_requests,assumed_requests=assumed_requests+excluded.assumed_requests,unpriced_requests=unpriced_requests+excluded.unpriced_requests,failed_requests=failed_requests+excluded.failed_requests,updated_at=excluded.updated_at", args: [workspaceId, granularity, start, row.gatewayKeyId, row.modelId, row.usage.inputTokens, row.usage.outputTokens, row.usage.cacheReadTokens, row.usage.cacheCreationTokens, row.usage.totalTokens, row.cost, row.confidence === "exact" ? 1 : 0, row.confidence === "assumed" ? 1 : 0, row.confidence === "unpriced" ? 1 : 0, row.succeeded ? 0 : 1, now] });
}
async function processSettlement(attemptId: string): Promise<void> {
  if (activeSettlementJobs.has(attemptId)) return await activeSettlementJobs.get(attemptId)!;
  const work = (async () => {
    try {
      let completedAttempt: GatewayAttempt | undefined;
      await writeTransaction(async (tx) => {
        const queue = await tx.execute({ sql: "SELECT * FROM accounting_settlement_queue WHERE attempt_id=?", args: [attemptId] }); const queued = queue.rows[0]; if (!queued) return;
        const deleted = await tx.execute({ sql: "SELECT 1 FROM accounting_deleted_workspaces WHERE workspace_id=?", args: [String(queued.workspace_id)] });
        if (deleted.rows.length) { await tx.execute({ sql: "DELETE FROM accounting_settlement_queue WHERE workspace_id=? AND attempt_id=?", args: [String(queued.workspace_id), attemptId] }); return; }
        const context = await tx.execute({ sql: "SELECT * FROM accounting_attempts WHERE workspace_id=? AND attempt_id=?", args: [String(queued.workspace_id), attemptId] }); const state = context.rows[0] ? storedState(context.rows[0] as Record<string, unknown>) : undefined;
        if (!state) return;
        completedAttempt = state.attempt;
        const existing = await tx.execute({ sql: "SELECT id FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] });
        if (existing.rows.length) { await tx.execute({ sql: "DELETE FROM accounting_settlement_queue WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] }); await tx.execute({ sql: "DELETE FROM accounting_attempts WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] }); return; }
        const usage = normalizeUsageMetrics(parse<UsageMetrics | undefined>(queued.metrics_json, undefined)); const calculated = calculateUsageCost(usage, state.pricing);
        const status = Number(queued.status), terminal = Number(queued.terminal) === 1, succeeded = status >= 200 && status < 300 && terminal;
        // Exact usage always wins. Partial or absent usage is priced from the
        // p50 settlement prediction, never zero; an enabled budget's p75 hold
        // remains a conservative floor until the observation is complete.
        const assumed = succeeded && calculated.confidence !== "exact" && state.pricing ? Math.max(calculated.costMicros, state.prediction?.settlement?.cost ?? 0, state.prediction?.reservation?.cost ?? state.estimate ?? 0) : undefined;
        const cost = succeeded ? assumed ?? calculated.costMicros : 0; const confidence = assumed !== undefined ? "assumed" : calculated.confidence; const now = Date.now();
        const predictionSource = state.prediction?.reservation && state.prediction.reservation.cost >= (state.prediction.settlement?.cost ?? 0) ? state.prediction.reservation.source : state.prediction?.settlement?.source;
        await tx.execute({ sql: `INSERT INTO usage_events(id,workspace_id,attempt_id,request_id,gateway_key_id,provider_id,model_id,gateway_model_id,protocol,started_at,completed_at,duration_ms,ttft_ms,status,request_body_bytes,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_tokens,input_known,output_known,cache_read_known,cache_creation_known,cost_micros,confidence,completeness,cost_source,prediction_json,price_group_id,price_version_id,price_tier) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [`${state.attempt.workspaceId}:${attemptId}`, state.attempt.workspaceId, attemptId, state.attempt.requestId, state.attempt.gatewayKeyId, state.attempt.providerId, state.attempt.model.id, state.attempt.model.id, state.attempt.protocol, state.attempt.startedAt, Number(queued.completed_at), Math.max(0, Number(queued.completed_at) - state.attempt.startedAt), queued.ttft_ms === null ? null : Number(queued.ttft_ms), status, state.requestBodyBytes, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.totalTokens, usage.inputKnown ? 1 : 0, usage.outputKnown ? 1 : 0, usage.cacheReadKnown ? 1 : 0, usage.cacheCreationKnown ? 1 : 0, cost, confidence, usage.completeness, assumed !== undefined ? predictionSource ?? "prediction" : confidence === "exact" ? "configured-pricing" : null, state.prediction ? json(state.prediction) : null, state.pricing?.groupId ?? null, state.pricing?.versionId ?? null, calculated.tier ?? null] });
        // A shared request has exactly one priced owner event and one zero-cost
        // consumer counterpart. Both use the stable request/attempt identity;
        // INSERT OR IGNORE makes replay and settlement handoff idempotent.
        if (state.attempt.consumerWorkspaceId && state.attempt.consumerGatewayKeyId) {
          const removedConsumer = await tx.execute({ sql: "SELECT 1 FROM accounting_deleted_workspaces WHERE workspace_id=?", args: [state.attempt.consumerWorkspaceId] });
          if (!removedConsumer.rows.length) {
            const consumerModel = state.attempt.consumerModelId ?? state.attempt.requestedModel;
            await tx.execute({ sql: `INSERT OR IGNORE INTO usage_events(id,workspace_id,attempt_id,request_id,gateway_key_id,provider_id,model_id,gateway_model_id,protocol,started_at,completed_at,duration_ms,ttft_ms,status,request_body_bytes,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_tokens,input_known,output_known,cache_read_known,cache_creation_known,cost_micros,confidence,completeness,cost_source,prediction_json,price_group_id,price_version_id,price_tier) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [`${state.attempt.consumerWorkspaceId}:${attemptId}`, state.attempt.consumerWorkspaceId, attemptId, state.attempt.requestId, state.attempt.consumerGatewayKeyId, state.attempt.providerId, consumerModel, consumerModel, state.attempt.protocol, state.attempt.startedAt, Number(queued.completed_at), Math.max(0, Number(queued.completed_at) - state.attempt.startedAt), queued.ttft_ms === null ? null : Number(queued.ttft_ms), status, state.requestBodyBytes, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.totalTokens, usage.inputKnown ? 1 : 0, usage.outputKnown ? 1 : 0, usage.cacheReadKnown ? 1 : 0, usage.cacheCreationKnown ? 1 : 0, 0, "exact", usage.completeness, "shared-owner-mirror", null, null, null, null] });
            await addRollups(tx, state.attempt.consumerWorkspaceId, { completedAt: Number(queued.completed_at), gatewayKeyId: state.attempt.consumerGatewayKeyId, modelId: consumerModel, usage, cost: 0, confidence: "exact", succeeded }, now);
          }
        }
        const reservation = await tx.execute({ sql: "SELECT amount_micros,window_start,state FROM budget_reservations WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] }); const held = reservation.rows[0]; const windowStart = held ? Number(held.window_start) : state.windowStart;
        if (windowStart !== undefined && succeeded) await tx.execute({ sql: "INSERT INTO budget_counters(workspace_id,gateway_key_id,window_start,spent_micros,reserved_micros,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(workspace_id,gateway_key_id,window_start) DO UPDATE SET spent_micros=spent_micros+excluded.spent_micros,updated_at=excluded.updated_at", args: [state.attempt.workspaceId, state.attempt.gatewayKeyId, windowStart, cost, now] });
        if (held && String(held.state) === "reserved") { await tx.execute({ sql: "UPDATE budget_counters SET reserved_micros=MAX(0,reserved_micros-?),updated_at=? WHERE workspace_id=? AND gateway_key_id=? AND window_start=?", args: [Number(held.amount_micros), now, state.attempt.workspaceId, state.attempt.gatewayKeyId, Number(held.window_start)] }); await tx.execute({ sql: "UPDATE budget_reservations SET state='settled' WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] }); }
        await addRollups(tx, state.attempt.workspaceId, { completedAt: Number(queued.completed_at), gatewayKeyId: state.attempt.gatewayKeyId, modelId: state.attempt.model.id, usage, cost, confidence, succeeded }, now);
        await tx.execute({ sql: "DELETE FROM accounting_settlement_queue WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] }); await tx.execute({ sql: "DELETE FROM accounting_attempts WHERE workspace_id=? AND attempt_id=?", args: [state.attempt.workspaceId, attemptId] });
      });
      if (completedAttempt) {
        invalidatePublicAnalytics(completedAttempt.workspaceId);
        if (completedAttempt.consumerWorkspaceId) invalidatePublicAnalytics(completedAttempt.consumerWorkspaceId);
      }
      attempts.delete(attemptId);
    } catch { scheduleSettlementRetry(); }
  })(); activeSettlementJobs.set(attemptId, work); try { await work; } finally { if (activeSettlementJobs.get(attemptId) === work) activeSettlementJobs.delete(attemptId); }
}
function scheduleSettlementRetry(): void { if (!settlementRetryTimer) settlementRetryTimer = setTimeout(() => { settlementRetryTimer = undefined; void retryQueuedSettlements(); }, 50); }
type PendingSettlementOutcome = { status: number; metrics?: UsageMetrics; completedAt: number; ttftMs?: number; terminal: boolean };
async function insertSettlementOutcome(table: "accounting_settlement_queue" | "accounting_settlement_fallback", state: AttemptState, attemptId: string, outcome: PendingSettlementOutcome): Promise<void> { await writeTransaction(async (tx) => { await tx.execute({ sql: `INSERT INTO ${table}(workspace_id,attempt_id,status,terminal,metrics_json,completed_at,ttft_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,attempt_id) DO NOTHING`, args: [state.attempt.workspaceId, attemptId, outcome.status, outcome.terminal ? 1 : 0, outcome.metrics ? json(outcome.metrics) : null, outcome.completedAt, outcome.ttftMs ?? null, Date.now(), Date.now()] }); }); }
async function durableSettlementHandoff(state: AttemptState, attemptId: string, outcome: PendingSettlementOutcome): Promise<"queue" | "fallback"> {
  let queueFailure: unknown;
  for (let retry = 0; retry < OUTCOME_PERSIST_ATTEMPTS; retry++) try { await insertSettlementOutcome("accounting_settlement_queue", state, attemptId, outcome); return "queue"; } catch (error) { queueFailure = error; await Bun.sleep(8 * (retry + 1)); }
  for (let retry = 0; retry < OUTCOME_PERSIST_ATTEMPTS; retry++) try { await insertSettlementOutcome("accounting_settlement_fallback", state, attemptId, outcome); return "fallback"; } catch { await Bun.sleep(8 * (retry + 1)); }
  void queueFailure; throw new AccountingError("Accounting outcome could not be durably recorded.", 503, "accounting_persistence_unavailable");
}
async function promoteSettlementFallbacks(attemptId?: string): Promise<void> { await writeTransaction(async (tx) => { const pending = await tx.execute({ sql: `SELECT * FROM accounting_settlement_fallback${attemptId ? " WHERE attempt_id=?" : ""}`, ...(attemptId ? { args: [attemptId] } : {}) }); for (const row of pending.rows) { await tx.execute({ sql: "INSERT INTO accounting_settlement_queue(workspace_id,attempt_id,status,terminal,metrics_json,completed_at,ttft_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,attempt_id) DO NOTHING", args: [String(row.workspace_id), String(row.attempt_id), Number(row.status), Number(row.terminal), row.metrics_json === null ? null : String(row.metrics_json), Number(row.completed_at), row.ttft_ms === null ? null : Number(row.ttft_ms), Number(row.created_at), Date.now()] }); await tx.execute({ sql: "DELETE FROM accounting_settlement_fallback WHERE workspace_id=? AND attempt_id=?", args: [String(row.workspace_id), String(row.attempt_id)] }); } }); }
async function persistPendingSettlement(attemptId: string): Promise<void> {
  if (persistingSettlementOutcomes.has(attemptId)) return await persistingSettlementOutcomes.get(attemptId)!;
  const work = (async () => { const state = attempts.get(attemptId), outcome = pendingSettlementOutcomes.get(attemptId); if (!state || !outcome) return; const handoff = await durableSettlementHandoff(state, attemptId, outcome); pendingSettlementOutcomes.delete(attemptId); if (handoff === "fallback") { try { await promoteSettlementFallbacks(attemptId); } catch { scheduleSettlementRetry(); return; } } await processSettlement(attemptId); })(); persistingSettlementOutcomes.set(attemptId, work); try { await work; } finally { if (persistingSettlementOutcomes.get(attemptId) === work) persistingSettlementOutcomes.delete(attemptId); }
}
async function retryQueuedSettlements(): Promise<void> { try { await promoteSettlementFallbacks(); } catch { scheduleSettlementRetry(); } await Promise.all([...pendingSettlementOutcomes.keys()].map((id) => persistPendingSettlement(id).catch(() => scheduleSettlementRetry()))); const pending = await db.execute("SELECT attempt_id FROM accounting_settlement_queue").catch(() => undefined); if (!pending) { scheduleSettlementRetry(); return; } await Promise.all(pending.rows.map((row) => processSettlement(String(row.attempt_id)))); const remaining = await db.execute("SELECT 1 FROM accounting_settlement_queue LIMIT 1").catch(() => [{ rows: [{}] }] as never); const fallback = await db.execute("SELECT 1 FROM accounting_settlement_fallback LIMIT 1").catch(() => [{ rows: [{}] }] as never); if (remaining.rows.length || fallback.rows.length || pendingSettlementOutcomes.size) scheduleSettlementRetry(); }
async function drainQueuedSettlements(): Promise<void> { for (let attempt = 0; attempt < 6; attempt++) { await retryQueuedSettlements(); await Promise.allSettled([...activeSettlementJobs.values(), ...persistingSettlementOutcomes.values()]); const remaining = await db.execute("SELECT 1 FROM accounting_settlement_queue LIMIT 1").catch(() => ({ rows: [{}] })); if (!remaining.rows.length && !pendingSettlementOutcomes.size) return; await Bun.sleep(8 * (attempt + 1)); } }
async function waitForSettlementFinalization(attemptId: string): Promise<void> { for (let retry = 0; retry < 100; retry++) { await persistPendingSettlement(attemptId); await processSettlement(attemptId); const queued = await db.execute({ sql: "SELECT 1 FROM accounting_settlement_queue WHERE attempt_id=?", args: [attemptId] }).catch(() => ({ rows: [{}] })); if (!pendingSettlementOutcomes.has(attemptId) && !queued.rows.length) return; await Bun.sleep(50); } }
async function settle(attemptId: string, status: number, metrics: UsageMetrics | undefined, completedAt: number, ttftMs?: number, terminal = true, awaitFinalization = false): Promise<void> {
  const state = attempts.get(attemptId); if (!state || state.settled) return;
  // Capture the upstream outcome before attempting persistence. A transient
  // queue write failure must not turn a completed stream into a synthetic 502.
  state.settled = true; pendingSettlementOutcomes.set(attemptId, { status, metrics, completedAt, ttftMs, terminal }); try { await persistPendingSettlement(attemptId); } catch (error) { scheduleSettlementRetry(); throw error; } if (awaitFinalization) await waitForSettlementFinalization(attemptId);
}
/** A stream is successful only after an explicit terminal event. Item-level
 * `.done` frames and failure frames must not turn an interrupted response into
 * a successful, zero-cost ledger record. */
export function isTerminalStreamEvent(eventName: string | undefined, raw: string): boolean {
  return sseFrameOutcome({ ...(eventName ? { eventName } : {}), data: raw }) === "completed";
}
function applySseData(eventName: string | undefined, raw: string, current: { metrics?: UsageMetrics; terminal: boolean; failed: boolean }): void {
  const frame = { ...(eventName ? { eventName } : {}), data: raw };
  const outcome = sseFrameOutcome(frame);
  if (outcome === "failed") { current.failed = true; current.terminal = true; return; }
  if (outcome === "completed") current.terminal = true;
  try {
    current.metrics = { ...current.metrics, ...extractUsageMetrics(JSON.parse(raw)) };
  } catch { /* a malformed frame is not terminal and does not erase usage */ }
}
export async function monitorAccountingStream(attemptId: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
  const state = attempts.get(attemptId); if (!state) { await stream.cancel().catch(() => undefined); return; }
  const reader = stream.getReader(); const decoder = new TextDecoder(); let buffered = ""; let firstByte: number | undefined;
  const result: { metrics?: UsageMetrics; terminal: boolean; failed: boolean } = { terminal: false, failed: false };
  let interrupted = false; let cancelled = Boolean(signal?.aborted);
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (firstByte === undefined) firstByte = Date.now();
      buffered += decoder.decode(part.value, { stream: true });
      let separator: number;
      while ((separator = buffered.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffered.slice(0, separator); buffered = buffered.slice(separator).replace(/^\r?\n\r?\n/, "");
        const parsed = parseSseFrame(frame); if (parsed) applySseData(parsed.eventName, parsed.data, result);
      }
    }
    if (buffered.trim()) { const parsed = parseSseFrame(buffered); if (parsed) applySseData(parsed.eventName, parsed.data, result); }
  } catch (error) {
    interrupted = true;
    cancelled ||= Boolean(signal?.aborted) || error instanceof DOMException && error.name === "AbortError";
  } finally { reader.releaseLock(); }
  const succeeded = !interrupted && result.terminal && !result.failed;
  await settle(attemptId, succeeded ? 200 : cancelled ? 499 : 502, result.metrics, Date.now(), firstByte === undefined ? undefined : firstByte - state.attempt.startedAt, succeeded, true);
}
/** Idempotent cancellation fallback for a probe whose transport monitor did not
 * return after shutdown. It preserves the normal zero-cost failed-attempt
 * ledger semantics and releases any reservation through settlement. */
export async function cancelAccountingAttempt(attemptId: string): Promise<void> { await settle(attemptId, 499, undefined, Date.now(), undefined, false, true).catch(() => undefined); }
export function gatewayAccountingHooks(): GatewayAccountingHooks { return { beforeRequestedCombo: async ({ workspaceId, requestedModel }) => { try { return await writeTransaction(async (tx) => { const window = await currentWindow(tx, workspaceId, Date.now()); return window.bypass && window.exclusions.includes(requestedModel) ? admissionResponse(403, "This model is excluded while Unlimited Mode is active.", "model_excluded_in_unlimited_mode") : undefined; }); } catch (error) { if (/no such table/i.test(String(error))) return undefined; return admissionResponse(503, "Budget state is unavailable.", "budget_unavailable"); } }, beforeAttempt: async (attempt) => reserve(attempt, attempt.requestBodyBytes ?? 0, attempt.payload), onResult: async (attempt) => { if (attempt.streamed) return; const response = attempt.response; let metrics: UsageMetrics | undefined; if (response?.body && response.headers.get("content-type")?.toLowerCase().includes("json")) { try { metrics = extractUsageMetrics(JSON.parse(await response.clone().text())); } catch { /* opaque response stays missing */ } } await settle(attempt.attemptId, attempt.status, metrics, attempt.completedAt); }, onStream: monitorAccountingStream }; }

export async function deleteAccountingForWorkspace(workspaceId: string): Promise<void> { deletingAccountingWorkspaces.add(workspaceId); invalidatePublicAnalytics(workspaceId); for (const [id, state] of attempts) if (state.attempt.workspaceId === workspaceId) { attempts.delete(id); pendingSettlementOutcomes.delete(id); } await db.batch([{ sql: "INSERT INTO accounting_deleted_workspaces(workspace_id) VALUES(?) ON CONFLICT(workspace_id) DO NOTHING", args: [workspaceId] }, ...["accounting_settlement_queue", "accounting_settlement_fallback", "accounting_attempts", "usage_rollups", "usage_events", "budget_reservations", "budget_counters", "gateway_budgets", "budget_windows", "budget_settings", "budget_bypass_sessions", "pricing_jobs", "model_pricing_tiers", "model_pricing_versions", "pricing_fixed_membership_overrides", "model_pricing_memberships", "model_pricing_groups"].map((table) => ({ sql: `DELETE FROM ${table} WHERE workspace_id=?`, args: [workspaceId] }))], "write"); }

export async function pricingAdmin(workspaceId: string) { await syncFixedGroups(workspaceId); const [groups, models, jobs] = await Promise.all([db.execute({ sql: "SELECT * FROM model_pricing_groups WHERE workspace_id=? ORDER BY name", args: [workspaceId] }), db.execute({ sql: "SELECT id,name,gateway_model_id,enabled FROM provider_models WHERE workspace_id=? AND status='active' ORDER BY gateway_model_id", args: [workspaceId] }), db.execute({ sql: "SELECT * FROM pricing_jobs WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 50", args: [workspaceId] })]); const members = await db.execute({ sql: "SELECT group_id,model_id FROM model_pricing_memberships WHERE workspace_id=?", args: [workspaceId] }); const versions = await db.execute({ sql: "SELECT * FROM model_pricing_versions WHERE workspace_id=? ORDER BY version DESC", args: [workspaceId] }); return { timeZone: appTimeZone(), groups: groups.rows.map((group) => ({ id: String(group.id), name: String(group.name), kind: String(group.kind), groupKey: String(group.group_key), canonical: parse(group.canonical_json, null), models: members.rows.filter((member) => member.group_id === group.id).map((member) => String(member.model_id)), versions: versions.rows.filter((version) => version.group_id === group.id).map((version) => ({ id: String(version.id), version: Number(version.version), effectiveAt: Number(version.effective_at), inputMicrosPerMillion: Number(version.input_rate), outputMicrosPerMillion: Number(version.output_rate), cacheReadMicrosPerMillion: Number(version.cache_read_rate), cacheCreationMicrosPerMillion: Number(version.cache_creation_rate) })) })), models: models.rows.map((model) => ({ id: String(model.id), name: String(model.name), gatewayModelId: String(model.gateway_model_id), enabled: Number(model.enabled) === 1 })), jobs: jobs.rows.map((job) => ({ id: String(job.id), groupId: String(job.group_id), versionId: String(job.version_id), state: String(job.state), processed: Number(job.cursor), total: Number(job.total), error: job.error ? String(job.error) : null, updatedAt: Number(job.updated_at) })) }; }
export async function pricingAdminDetail(workspaceId: string) {
  const data = await pricingAdmin(workspaceId);
  const tiers = await db.execute({ sql: "SELECT version_id,threshold_tokens,input_rate,output_rate,cache_read_rate,cache_creation_rate FROM model_pricing_tiers WHERE workspace_id=? ORDER BY threshold_tokens", args: [workspaceId] });
  return { ...data, groups: data.groups.map((group) => ({ ...group, versions: group.versions.map((version) => ({ ...version, tiers: tiers.rows.filter((tier) => String(tier.version_id) === version.id).map((tier) => ({ thresholdTokens: Number(tier.threshold_tokens), inputMicrosPerMillion: Number(tier.input_rate), outputMicrosPerMillion: Number(tier.output_rate), cacheReadMicrosPerMillion: Number(tier.cache_read_rate), cacheCreationMicrosPerMillion: Number(tier.cache_creation_rate) })) })) })) };
}
async function syncFixedGroupsUnsafe(workspaceId: string): Promise<void> {
  const models = await db.execute({ sql: "SELECT id,gateway_suffix FROM provider_models WHERE workspace_id=? AND status='active'", args: [workspaceId] }); const now = Date.now();
  for (const model of models.rows) {
    const key = String(model.gateway_suffix); const group = await db.execute({ sql: "SELECT id,name_overridden FROM model_pricing_groups WHERE workspace_id=? AND kind='fixed' AND group_key=?", args: [workspaceId, key] });
    const groupId = group.rows[0]?.id ? String(group.rows[0].id) : crypto.randomUUID();
    if (!group.rows.length) await db.execute({ sql: "INSERT INTO model_pricing_groups(id,workspace_id,name,kind,group_key,created_at,updated_at) VALUES(?,?,?,'fixed',?,?,?)", args: [groupId, workspaceId, key, key, now, now] });
    else if (Number(group.rows[0]?.name_overridden ?? 0) === 0) await db.execute({ sql: "UPDATE model_pricing_groups SET name=?,updated_at=? WHERE workspace_id=? AND id=?", args: [key, now, workspaceId, groupId] });
    const override = await db.execute({ sql: "SELECT group_id FROM pricing_fixed_membership_overrides WHERE workspace_id=? AND model_id=?", args: [workspaceId, String(model.id)] });
    if (override.rows.length) {
      const manualGroupId = override.rows[0]?.group_id === null ? undefined : String(override.rows[0]?.group_id);
      if (!manualGroupId) await db.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND model_id=? AND group_id IN (SELECT id FROM model_pricing_groups WHERE workspace_id=? AND kind='fixed')", args: [workspaceId, String(model.id), workspaceId] });
      else {
        const exists = await db.execute({ sql: "SELECT 1 FROM model_pricing_groups WHERE workspace_id=? AND id=?", args: [workspaceId, manualGroupId] });
        if (exists.rows.length) { await db.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND model_id=?", args: [workspaceId, String(model.id)] }); await db.execute({ sql: "INSERT INTO model_pricing_memberships(workspace_id,group_id,model_id) VALUES(?,?,?)", args: [workspaceId, manualGroupId, String(model.id)] }); }
      }
      continue;
    }
    // A custom group is an explicit override. Otherwise suffix renames move the
    // member from its obsolete fixed group to the current fixed group.
    const owner = await db.execute({ sql: "SELECT g.kind FROM model_pricing_memberships m JOIN model_pricing_groups g ON g.workspace_id=m.workspace_id AND g.id=m.group_id WHERE m.workspace_id=? AND m.model_id=?", args: [workspaceId, String(model.id)] });
    if (owner.rows[0] && String(owner.rows[0].kind) === "fixed") await db.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND model_id=?", args: [workspaceId, String(model.id)] });
    await db.execute({ sql: "INSERT INTO model_pricing_memberships(workspace_id,group_id,model_id) VALUES(?,?,?) ON CONFLICT(workspace_id,model_id) DO NOTHING", args: [workspaceId, groupId, String(model.id)] });
  }
}
/** Fixed membership is derived state. Coalesce same-workspace cold reads so a
 * burst of first admissions cannot race the unique fixed-group insert. */
async function syncFixedGroups(workspaceId: string): Promise<void> { const active = fixedGroupSyncs.get(workspaceId); if (active) return active; const work = (async () => { let failure: unknown; for (let attempt = 0; attempt < 6; attempt++) { try { await syncFixedGroupsUnsafe(workspaceId); return; } catch (error) { failure = error; if (!/busy|locked/i.test(String(error)) || attempt === 5) throw error; await Bun.sleep(8 * (attempt + 1)); } } throw failure; })(); fixedGroupSyncs.set(workspaceId, work); try { await work; } finally { if (fixedGroupSyncs.get(workspaceId) === work) fixedGroupSyncs.delete(workspaceId); } }
async function savePricingGroupLegacy(workspaceId: string, input: { id?: string; name: unknown; modelIds: unknown; canonical?: unknown }): Promise<string> { const name = typeof input.name === "string" ? input.name.trim() : ""; if (!name || name.length > 120) throw new AccountingError("Pricing group name is required."); const modelIds = Array.isArray(input.modelIds) ? [...new Set(input.modelIds.filter((value): value is string => typeof value === "string"))] : []; const id = input.id ?? crypto.randomUUID(); await writeTransaction(async (tx) => { const found = await tx.execute({ sql: "SELECT id,kind FROM model_pricing_groups WHERE workspace_id=? AND id=?", args: [workspaceId, id] }); if (!found.rows.length) await tx.execute({ sql: "INSERT INTO model_pricing_groups(id,workspace_id,name,kind,group_key,canonical_json,created_at,updated_at) VALUES(?,?,?,'custom',?,?,?,?)", args: [id, workspaceId, name, id, json(input.canonical ?? null), Date.now(), Date.now()] }); else { if (String(found.rows[0]?.kind) === "fixed") throw new AccountingError("Fixed pricing membership follows the provider model suffix and cannot be edited.", 409); await tx.execute({ sql: "UPDATE model_pricing_groups SET name=?,canonical_json=?,updated_at=? WHERE workspace_id=? AND id=?", args: [name, json(input.canonical ?? null), Date.now(), workspaceId, id] }); } await tx.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND group_id=?", args: [workspaceId, id] }); for (const modelId of modelIds) { const exists = await tx.execute({ sql: "SELECT id FROM provider_models WHERE workspace_id=? AND id=? AND status='active'", args: [workspaceId, modelId] }); if (!exists.rows.length) throw new AccountingError("Model is unavailable."); await tx.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND model_id=?", args: [workspaceId, id] }); await tx.execute({ sql: "INSERT INTO model_pricing_memberships(workspace_id,group_id,model_id) VALUES(?,?,?)", args: [workspaceId, id, modelId] }); } }); invalidatePublicAnalytics(workspaceId); return id; }
void savePricingGroupLegacy;

function canonicalRates(value: unknown): PricingRates | undefined {
  const canonical = record(value); const rates = record(canonical?.rates); if (!rates) return undefined;
  return { inputMicrosPerMillion: checkedRate(rates.inputMicrosPerMillion), outputMicrosPerMillion: checkedRate(rates.outputMicrosPerMillion), cacheReadMicrosPerMillion: checkedRate(rates.cacheReadMicrosPerMillion), cacheCreationMicrosPerMillion: checkedRate(rates.cacheCreationMicrosPerMillion) };
}
function sameRates(left: PricingRates, right: PricingRates): boolean { return left.inputMicrosPerMillion === right.inputMicrosPerMillion && left.outputMicrosPerMillion === right.outputMicrosPerMillion && left.cacheReadMicrosPerMillion === right.cacheReadMicrosPerMillion && left.cacheCreationMicrosPerMillion === right.cacheCreationMicrosPerMillion; }
async function applyCanonicalRates(tx: Transaction, workspaceId: string, groupId: string, priorCanonical: unknown, canonical: unknown): Promise<void> {
  const next = record(canonical); const prior = record(typeof priorCanonical === "string" ? parse(priorCanonical, null) : priorCanonical); const rates = canonicalRates(canonical);
  if (!rates || String(next?.id ?? "") === String(prior?.id ?? "")) return;
  const previous = await tx.execute({ sql: "SELECT * FROM model_pricing_versions WHERE workspace_id=? AND group_id=? ORDER BY version DESC LIMIT 1", args: [workspaceId, groupId] });
  const latest = previous.rows[0];
  if (latest && sameRates(rates, { inputMicrosPerMillion: Number(latest.input_rate), outputMicrosPerMillion: Number(latest.output_rate), cacheReadMicrosPerMillion: Number(latest.cache_read_rate), cacheCreationMicrosPerMillion: Number(latest.cache_creation_rate) })) return;
  const versionId = crypto.randomUUID(); const now = Date.now(); const version = Number(latest?.version ?? 0) + 1;
  await tx.execute({ sql: "INSERT INTO model_pricing_versions(id,workspace_id,group_id,version,effective_at,input_rate,output_rate,cache_read_rate,cache_creation_rate,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [versionId, workspaceId, groupId, version, now, rates.inputMicrosPerMillion, rates.outputMicrosPerMillion, rates.cacheReadMicrosPerMillion, rates.cacheCreationMicrosPerMillion, now] });
  if (latest) { const tiers = await tx.execute({ sql: "SELECT threshold_tokens,input_rate,output_rate,cache_read_rate,cache_creation_rate FROM model_pricing_tiers WHERE workspace_id=? AND version_id=?", args: [workspaceId, String(latest.id)] }); for (const tier of tiers.rows) await tx.execute({ sql: "INSERT INTO model_pricing_tiers(workspace_id,version_id,threshold_tokens,input_rate,output_rate,cache_read_rate,cache_creation_rate) VALUES(?,?,?,?,?,?,?)", args: [workspaceId, versionId, Number(tier.threshold_tokens), Number(tier.input_rate), Number(tier.output_rate), Number(tier.cache_read_rate), Number(tier.cache_creation_rate)] }); }
}
export async function savePricingGroup(workspaceId: string, input: { id?: string; name: unknown; modelIds: unknown; canonical?: unknown }): Promise<string> {
  const name = typeof input.name === "string" ? input.name.trim() : ""; if (!name || name.length > 120) throw new AccountingError("Pricing group name is required.");
  const modelIds = Array.isArray(input.modelIds) ? [...new Set(input.modelIds.filter((value): value is string => typeof value === "string"))] : []; const id = input.id ?? crypto.randomUUID();
  await writeTransaction(async (tx) => {
    const found = await tx.execute({ sql: "SELECT kind,canonical_json FROM model_pricing_groups WHERE workspace_id=? AND id=?", args: [workspaceId, id] }); const existing = found.rows[0]; const kind = existing ? String(existing.kind) : "custom";
    if (!existing) await tx.execute({ sql: "INSERT INTO model_pricing_groups(id,workspace_id,name,kind,group_key,canonical_json,created_at,updated_at) VALUES(?,?,?,'custom',?,?,?,?)", args: [id, workspaceId, name, id, json(input.canonical ?? null), Date.now(), Date.now()] });
    else if (kind === "fixed") await tx.execute({ sql: "UPDATE model_pricing_groups SET name=?,canonical_json=?,name_overridden=1,canonical_overridden=1,updated_at=? WHERE workspace_id=? AND id=?", args: [name, json(input.canonical ?? null), Date.now(), workspaceId, id] });
    else await tx.execute({ sql: "UPDATE model_pricing_groups SET name=?,canonical_json=?,updated_at=? WHERE workspace_id=? AND id=?", args: [name, json(input.canonical ?? null), Date.now(), workspaceId, id] });
    const current = await tx.execute({ sql: "SELECT model_id FROM model_pricing_memberships WHERE workspace_id=? AND group_id=?", args: [workspaceId, id] });
    for (const modelId of modelIds) { const exists = await tx.execute({ sql: "SELECT id FROM provider_models WHERE workspace_id=? AND id=? AND status='active'", args: [workspaceId, modelId] }); if (!exists.rows.length) throw new AccountingError("Model is unavailable."); }
    await tx.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND group_id=?", args: [workspaceId, id] });
    if (kind === "fixed") for (const row of current.rows) if (!modelIds.includes(String(row.model_id))) await tx.execute({ sql: "INSERT INTO pricing_fixed_membership_overrides(workspace_id,model_id,group_id) VALUES(?,?,NULL) ON CONFLICT(workspace_id,model_id) DO UPDATE SET group_id=NULL", args: [workspaceId, String(row.model_id)] });
    for (const modelId of modelIds) { await tx.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND model_id=?", args: [workspaceId, modelId] }); await tx.execute({ sql: "INSERT INTO model_pricing_memberships(workspace_id,group_id,model_id) VALUES(?,?,?)", args: [workspaceId, id, modelId] }); if (kind === "fixed") await tx.execute({ sql: "INSERT INTO pricing_fixed_membership_overrides(workspace_id,model_id,group_id) VALUES(?,?,?) ON CONFLICT(workspace_id,model_id) DO UPDATE SET group_id=excluded.group_id", args: [workspaceId, modelId, id] }); else await tx.execute({ sql: "DELETE FROM pricing_fixed_membership_overrides WHERE workspace_id=? AND model_id=?", args: [workspaceId, modelId] }); }
    await applyCanonicalRates(tx, workspaceId, id, existing?.canonical_json, input.canonical);
  }); invalidatePublicAnalytics(workspaceId); return id;
}
export async function savePricingVersion(workspaceId: string, input: { groupId: unknown; rates: unknown; tiers?: unknown; mode?: unknown }): Promise<{ versionId: string; jobId?: string }> { const groupId = typeof input.groupId === "string" ? input.groupId : ""; const rates = record(input.rates); if (!groupId || !rates) throw new AccountingError("Pricing version is invalid."); const parsed: PricingRates = { inputMicrosPerMillion: checkedRate(rates.inputMicrosPerMillion), outputMicrosPerMillion: checkedRate(rates.outputMicrosPerMillion), cacheReadMicrosPerMillion: checkedRate(rates.cacheReadMicrosPerMillion), cacheCreationMicrosPerMillion: checkedRate(rates.cacheCreationMicrosPerMillion) }; const tiers = (Array.isArray(input.tiers) ? input.tiers : []).map((candidate) => { const tier = record(candidate); const thresholdTokens = Number(tier?.thresholdTokens); if (!tier || !Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0) throw new AccountingError("Pricing tier is invalid."); return { thresholdTokens, inputMicrosPerMillion: checkedRate(tier.inputMicrosPerMillion), outputMicrosPerMillion: checkedRate(tier.outputMicrosPerMillion), cacheReadMicrosPerMillion: checkedRate(tier.cacheReadMicrosPerMillion), cacheCreationMicrosPerMillion: checkedRate(tier.cacheCreationMicrosPerMillion) }; }).sort((a, b) => a.thresholdTokens - b.thresholdTokens); const versionId = crypto.randomUUID(); let jobId: string | undefined; await writeTransaction(async (tx) => { const group = await tx.execute({ sql: "SELECT id FROM model_pricing_groups WHERE workspace_id=? AND id=?", args: [workspaceId, groupId] }); if (!group.rows.length) throw new AccountingError("Pricing group not found.", 404); const count = await tx.execute({ sql: "SELECT COALESCE(MAX(version),0) max FROM model_pricing_versions WHERE workspace_id=? AND group_id=?", args: [workspaceId, groupId] }); const now = Date.now(); await tx.execute({ sql: "INSERT INTO model_pricing_versions(id,workspace_id,group_id,version,effective_at,input_rate,output_rate,cache_read_rate,cache_creation_rate,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [versionId, workspaceId, groupId, Number(count.rows[0]?.max ?? 0) + 1, now, parsed.inputMicrosPerMillion, parsed.outputMicrosPerMillion, parsed.cacheReadMicrosPerMillion, parsed.cacheCreationMicrosPerMillion, now] }); for (const tier of tiers) await tx.execute({ sql: "INSERT INTO model_pricing_tiers(workspace_id,version_id,threshold_tokens,input_rate,output_rate,cache_read_rate,cache_creation_rate) VALUES(?,?,?,?,?,?,?)", args: [workspaceId, versionId, tier.thresholdTokens, tier.inputMicrosPerMillion, tier.outputMicrosPerMillion, tier.cacheReadMicrosPerMillion, tier.cacheCreationMicrosPerMillion] }); if (input.mode === "replace") { jobId = crypto.randomUUID(); const total = await tx.execute({ sql: "SELECT COUNT(*) count FROM usage_events WHERE workspace_id=? AND price_group_id=?", args: [workspaceId, groupId] }); await tx.execute({ sql: "INSERT INTO pricing_jobs(id,workspace_id,group_id,version_id,state,cursor,total,created_at,updated_at) VALUES(?,?,?,?,'queued',0,?,?,?)", args: [jobId, workspaceId, groupId, versionId, Number(total.rows[0]?.count ?? 0), now, now] }); } }); invalidatePublicAnalytics(workspaceId); return { versionId, ...(jobId ? { jobId } : {}) }; }

export async function deletePricingGroup(workspaceId: string, groupId: string): Promise<void> { await writeTransaction(async (tx) => { const group = await tx.execute({ sql: "SELECT kind FROM model_pricing_groups WHERE workspace_id=? AND id=?", args: [workspaceId, groupId] }); if (!group.rows.length) return; const members = await tx.execute({ sql: "SELECT 1 FROM model_pricing_memberships WHERE workspace_id=? AND group_id=? LIMIT 1", args: [workspaceId, groupId] }); if (String(group.rows[0].kind) === "fixed" && members.rows.length) throw new AccountingError("Only empty fixed pricing groups can be deleted.", 409); await tx.execute({ sql: "DELETE FROM model_pricing_memberships WHERE workspace_id=? AND group_id=?", args: [workspaceId, groupId] }); await tx.execute({ sql: "DELETE FROM pricing_fixed_membership_overrides WHERE workspace_id=? AND group_id=?", args: [workspaceId, groupId] }); await tx.execute({ sql: "DELETE FROM model_pricing_tiers WHERE workspace_id=? AND version_id IN (SELECT id FROM model_pricing_versions WHERE workspace_id=? AND group_id=?)", args: [workspaceId, workspaceId, groupId] }); await tx.execute({ sql: "DELETE FROM model_pricing_versions WHERE workspace_id=? AND group_id=?", args: [workspaceId, groupId] }); await tx.execute({ sql: "DELETE FROM model_pricing_groups WHERE workspace_id=? AND id=?", args: [workspaceId, groupId] }); }); invalidatePublicAnalytics(workspaceId); }

export async function getBudgetAdmin(workspaceId: string) { await refreshCodexBudgetAnchor(workspaceId); const result = await writeTransaction(async (tx) => { const window = await currentWindow(tx, workspaceId, Date.now()); const [budgets, keys, settings, sessions, state] = await Promise.all([tx.execute({ sql: "SELECT b.gateway_key_id,b.limit_micros,b.enabled,COALESCE(c.spent_micros,0) spent_micros,COALESCE(c.reserved_micros,0) reserved_micros FROM gateway_budgets b LEFT JOIN budget_counters c ON c.workspace_id=b.workspace_id AND c.gateway_key_id=b.gateway_key_id AND c.window_start=? WHERE b.workspace_id=? ORDER BY b.gateway_key_id", args: [window.start, workspaceId] }), tx.execute({ sql: `SELECT id,name,status FROM gateway_keys WHERE workspace_id=? AND status<>'deleted' UNION ALL SELECT 'shared-workspace:' || s.recipient_workspace_id AS id,'Shared workspace: ' || w.name AS name,'active' AS status FROM model_shares s JOIN workspaces w ON w.id=s.recipient_workspace_id AND w.status='active' JOIN provider_models m ON m.workspace_id=s.owner_workspace_id AND m.id=s.source_model_id AND m.status='active' AND m.enabled=1 JOIN providers p ON p.workspace_id=m.workspace_id AND p.id=m.provider_id AND p.status='active' AND p.enabled=1 WHERE s.owner_workspace_id=? ORDER BY name`, args: [workspaceId, workspaceId] }), tx.execute({ sql: "SELECT unlimited_exclusions_json,beyond_enabled,beyond_models_json FROM budget_settings WHERE workspace_id=?", args: [workspaceId] }), tx.execute({ sql: "SELECT id,started_at,ended_at,end_reason FROM budget_bypass_sessions WHERE workspace_id=? ORDER BY started_at DESC LIMIT 50", args: [workspaceId] }), tx.execute({ sql: "SELECT auto_end,bypass_session_id,anchor_account_id,anchor_reset_at,anchor_checked_at,anchor_error FROM budget_windows WHERE workspace_id=?", args: [workspaceId] })]); const keyNames = new Map(keys.rows.map((key) => [String(key.id), String(key.name)])); const setting = settings.rows[0], active = state.rows[0], activeSessionId = active?.bypass_session_id ? String(active.bypass_session_id) : null, autoEnd = Number(active?.auto_end ?? 0) === 1; return { timeZone: appTimeZone(), window: { startAt: window.start, endAt: window.end, durationMs: window.end - window.start, unlimited: window.bypass, autoEnd, activeSessionId, anchor: active?.anchor_account_id ? { accountId: String(active.anchor_account_id), resetAt: Number(active.anchor_reset_at ?? 0) || null, checkedAt: Number(active.anchor_checked_at ?? 0) || null, error: active.anchor_error ? String(active.anchor_error) : null } : null }, keys: keys.rows.map((key) => ({ id: String(key.id), name: String(key.name), status: String(key.status) })), budgets: budgets.rows.map((budget) => ({ keyId: String(budget.gateway_key_id), keyName: keyNames.get(String(budget.gateway_key_id)) ?? (String(budget.gateway_key_id).startsWith("shared-workspace:") ? `Shared workspace: ${String(budget.gateway_key_id).slice("shared-workspace:".length)}` : "Deleted key"), limitMicros: Number(budget.limit_micros), spentMicros: Number(budget.spent_micros), reservedMicros: Number(budget.reserved_micros), enabled: Number(budget.enabled) === 1 })), unlimited: { exclusions: parse(String(setting?.unlimited_exclusions_json ?? "[]"), []), active: window.bypass, autoEnd, activeSessionId, activeSession: activeSessionId ? { id: activeSessionId, autoEnd } : null }, beyondLimits: { enabled: Number(setting?.beyond_enabled ?? 0) === 1, models: parse(String(setting?.beyond_models_json ?? "[]"), []) }, history: sessions.rows.map((session) => ({ id: String(session.id), startedAt: Number(session.started_at), endedAt: session.ended_at === null ? null : Number(session.ended_at), endReason: session.end_reason ? String(session.end_reason) : null })) }; }); return result; }
export async function getBudgetAdminDetail(workspaceId: string) { const base = await getBudgetAdmin(workspaceId); const [models, aliases, combos] = await Promise.all([db.execute({ sql: "SELECT gateway_model_id,name FROM provider_models WHERE workspace_id=? AND status='active' AND enabled=1 ORDER BY gateway_model_id", args: [workspaceId] }), db.execute({ sql: "SELECT alias FROM routing_aliases WHERE workspace_id=? ORDER BY normalized_alias", args: [workspaceId] }).catch(() => ({ rows: [] })), db.execute({ sql: "SELECT combo,name FROM routing_combos WHERE workspace_id=? ORDER BY normalized_combo", args: [workspaceId] }).catch(() => ({ rows: [] }))]); return { ...base, modelOptions: [...models.rows.map((model) => ({ id: String(model.gateway_model_id), name: String(model.name), type: "model" })), ...aliases.rows.map((alias) => ({ id: String(alias.alias), name: String(alias.alias), type: "alias" })), ...combos.rows.map((combo) => ({ id: String(combo.combo), name: String(combo.name), type: "combo" }))] }; }
export async function saveBudget(workspaceId: string, input: { keyId: unknown; limitMicros: unknown; enabled?: unknown }): Promise<void> {
  const keyId = typeof input.keyId === "string" ? input.keyId : ""; const limit = Number(input.limitMicros);
  if (!keyId || !Number.isSafeInteger(limit) || limit <= 0) throw new AccountingError("Budget limit must be a positive integer number of micros.");
  await writeTransaction(async (tx) => {
    const key = await tx.execute({ sql: "SELECT id FROM gateway_keys WHERE workspace_id=? AND id=? AND status='active'", args: [workspaceId, keyId] });
    const consumerId = keyId.startsWith("shared-workspace:") ? keyId.slice("shared-workspace:".length) : "";
    const shared = consumerId ? await tx.execute({ sql: `SELECT 1 FROM model_shares s JOIN workspaces w ON w.id=s.recipient_workspace_id AND w.status='active' JOIN provider_models m ON m.workspace_id=s.owner_workspace_id AND m.id=s.source_model_id AND m.status='active' AND m.enabled=1 JOIN providers p ON p.workspace_id=m.workspace_id AND p.id=m.provider_id AND p.status='active' AND p.enabled=1 WHERE s.owner_workspace_id=? AND s.recipient_workspace_id=? LIMIT 1`, args: [workspaceId, consumerId] }).catch(() => ({ rows: [] })) : { rows: [] };
    if (!key.rows.length && !shared.rows.length) throw new AccountingError("Gateway key not found.", 404);
    const window = await currentWindow(tx, workspaceId, Date.now());
    // A budget is a policy over an existing ledger, never a fresh counter.
    const spent = await tx.execute({ sql: "SELECT COALESCE(SUM(cost_micros),0) value FROM usage_events WHERE workspace_id=? AND gateway_key_id=? AND status>=200 AND status<300 AND completed_at>=? AND completed_at<?", args: [workspaceId, keyId, window.start, window.end] });
    await tx.execute({ sql: "INSERT INTO budget_counters(workspace_id,gateway_key_id,window_start,spent_micros,reserved_micros,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(workspace_id,gateway_key_id,window_start) DO UPDATE SET spent_micros=MAX(spent_micros,excluded.spent_micros),updated_at=excluded.updated_at", args: [workspaceId, keyId, window.start, Number(spent.rows[0]?.value ?? 0), Date.now()] });
    await tx.execute({ sql: "INSERT INTO gateway_budgets(workspace_id,gateway_key_id,limit_micros,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,gateway_key_id) DO UPDATE SET limit_micros=excluded.limit_micros,enabled=excluded.enabled,updated_at=excluded.updated_at", args: [workspaceId, keyId, limit, input.enabled === false ? 0 : 1, Date.now()] });
  });
  invalidatePublicAnalytics(workspaceId);
}
export async function deleteBudget(workspaceId: string, keyId: string): Promise<void> { await db.execute({ sql: "DELETE FROM gateway_budgets WHERE workspace_id=? AND gateway_key_id=?", args: [workspaceId, keyId] }); invalidatePublicAnalytics(workspaceId); }
async function reconcileBudgetCounters(workspaceId: string): Promise<void> {
  await writeTransaction(async (tx) => {
    await reconcileBudgetCountersInTransaction(tx, workspaceId);
  });
}
async function reconcileBudgetCountersInTransaction(tx: Transaction, workspaceId: string): Promise<void> {
  const window = await currentWindow(tx, workspaceId, Date.now());
  const budgets = await tx.execute({ sql: "SELECT gateway_key_id FROM gateway_budgets WHERE workspace_id=?", args: [workspaceId] });
  for (const budget of budgets.rows) {
    const keyId = String(budget.gateway_key_id);
    const ledger = await tx.execute({ sql: "SELECT COALESCE(SUM(cost_micros),0) value FROM usage_events WHERE workspace_id=? AND gateway_key_id=? AND status>=200 AND status<300 AND completed_at>=? AND completed_at<?", args: [workspaceId, keyId, window.start, window.end] });
    await tx.execute({ sql: "INSERT INTO budget_counters(workspace_id,gateway_key_id,window_start,spent_micros,reserved_micros,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(workspace_id,gateway_key_id,window_start) DO UPDATE SET spent_micros=excluded.spent_micros,updated_at=excluded.updated_at", args: [workspaceId, keyId, window.start, Number(ledger.rows[0]?.value ?? 0), Date.now()] });
  }
}
export async function saveBudgetWindow(workspaceId: string, input: { startAt: unknown; endAt: unknown }): Promise<void> { const start = Number(input.startAt), end = Number(input.endAt); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new AccountingError("Budget window is invalid."); await writeTransaction(async (tx) => { const now = Date.now(); await tx.execute({ sql: "INSERT INTO budget_windows(workspace_id,start_at,end_at,duration_ms,bypass,auto_end,updated_at) VALUES(?,?,?,?,0,0,?) ON CONFLICT(workspace_id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,duration_ms=excluded.duration_ms,anchor_account_id=NULL,anchor_reset_at=NULL,anchor_checked_at=NULL,anchor_attempted_at=NULL,anchor_error=NULL,updated_at=excluded.updated_at", args: [workspaceId, start, end, end - start, now] }); // A reconfigured window starts a new accounting policy; do not carry an in-flight hold from the prior policy into it.
    await tx.execute({ sql: "UPDATE budget_reservations SET state='abandoned' WHERE workspace_id=? AND state='reserved'", args: [workspaceId] }); await tx.execute({ sql: "UPDATE budget_counters SET reserved_micros=0,updated_at=? WHERE workspace_id=?", args: [now, workspaceId] }); }); await reconcileBudgetCounters(workspaceId); invalidatePublicAnalytics(workspaceId); }
export async function saveCodexBudgetAnchor(workspaceId: string, accountId: unknown): Promise<void> {
  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 128) throw new AccountingError("Codex account is invalid.");
  const quota = await quotaForAccount(workspaceId, accountId, true);
  const resetAt = Date.parse(String((quota.weekly as CodexWeeklyWindow | undefined)?.resetAt ?? ""));
  if (quota.stale === true || quota.reauthRequired === true || typeof quota.error === "string" || !Number.isFinite(resetAt) || resetAt <= Date.now()) throw new AccountingError("A fresh future Codex weekly reset is required to anchor this budget.", 502);
  const startAt = resetAt - 7 * 86_400_000; const now = Date.now();
  await writeTransaction(async (tx) => {
    await tx.execute({ sql: "INSERT INTO budget_windows(workspace_id,start_at,end_at,duration_ms,bypass,auto_end,anchor_account_id,anchor_reset_at,anchor_checked_at,anchor_attempted_at,anchor_error,updated_at) VALUES(?,?,?,?,0,0,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,duration_ms=excluded.duration_ms,anchor_account_id=excluded.anchor_account_id,anchor_reset_at=excluded.anchor_reset_at,anchor_checked_at=excluded.anchor_checked_at,anchor_attempted_at=excluded.anchor_attempted_at,anchor_error=NULL,updated_at=excluded.updated_at", args: [workspaceId, startAt, resetAt, 7 * 86_400_000, accountId, resetAt, now, now, null, now] });
    await tx.execute({ sql: "UPDATE budget_reservations SET state='abandoned' WHERE workspace_id=? AND state='reserved'", args: [workspaceId] });
    await tx.execute({ sql: "UPDATE budget_counters SET reserved_micros=0,updated_at=? WHERE workspace_id=?", args: [now, workspaceId] });
  });
  await reconcileBudgetCounters(workspaceId);
  invalidatePublicAnalytics(workspaceId);
}
export async function setUnlimited(workspaceId: string, active: boolean, autoEnd: boolean): Promise<void> { await writeTransaction(async (tx) => { const now = Date.now(); const window = await currentWindow(tx, workspaceId, now); if (active && !window.bypass) { const id = crypto.randomUUID(); await tx.execute({ sql: "INSERT INTO budget_bypass_sessions(id,workspace_id,started_at,ended_at,end_reason) VALUES(?,?,?,NULL,NULL)", args: [id, workspaceId, now] }); await tx.execute({ sql: "UPDATE budget_windows SET bypass=1,bypass_session_id=?,auto_end=?,updated_at=? WHERE workspace_id=?", args: [id, autoEnd ? 1 : 0, now, workspaceId] }); } else if (active && window.bypass) { await tx.execute({ sql: "UPDATE budget_windows SET auto_end=?,updated_at=? WHERE workspace_id=?", args: [autoEnd ? 1 : 0, now, workspaceId] }); } else if (!active && window.bypass) { const current = await tx.execute({ sql: "SELECT bypass_session_id FROM budget_windows WHERE workspace_id=?", args: [workspaceId] }); const session = current.rows[0]?.bypass_session_id; if (session) await tx.execute({ sql: "UPDATE budget_bypass_sessions SET ended_at=?,end_reason='manual' WHERE id=? AND workspace_id=? AND ended_at IS NULL", args: [now, String(session), workspaceId] }); await tx.execute({ sql: "UPDATE budget_windows SET bypass=0,bypass_session_id=NULL,auto_end=0,updated_at=? WHERE workspace_id=?", args: [now, workspaceId] }); } }); invalidatePublicAnalytics(workspaceId); }
export async function saveBudgetSettings(workspaceId: string, input: { exclusions?: unknown; beyondEnabled?: unknown; beyondModels?: unknown }): Promise<void> { const exclusions = Array.isArray(input.exclusions) ? [...new Set(input.exclusions.filter((value): value is string => typeof value === "string" && value.length <= 256))] : []; const beyond = Array.isArray(input.beyondModels) ? [...new Set(input.beyondModels.filter((value): value is string => typeof value === "string" && value.length <= 256))] : []; if (beyond.length > MAX_BEYOND_MODELS) throw new AccountingError("Beyond Limits supports at most 100 models."); await db.execute({ sql: "INSERT INTO budget_settings(workspace_id,unlimited_exclusions_json,beyond_enabled,beyond_models_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET unlimited_exclusions_json=excluded.unlimited_exclusions_json,beyond_enabled=excluded.beyond_enabled,beyond_models_json=excluded.beyond_models_json,updated_at=excluded.updated_at", args: [workspaceId, json(exclusions), input.beyondEnabled === true ? 1 : 0, json(beyond), Date.now()] }); invalidatePublicAnalytics(workspaceId); }

function rangeFor(preset: string, from: string | null, to: string | null): { from: number; to: number; label: string } {
  const now = Date.now(), today = startOfAppDay(now);
  if (preset === "today") return { from: today.getTime(), to: now, label: "Today" };
  if (preset === "yesterday") return { from: addAppDays(today, -1).getTime(), to: today.getTime(), label: "Yesterday" };
  if (preset === "week") return { from: mondayInAppTimeZone(now).getTime(), to: now, label: "This week" };
  if (preset === "lastWeek") { const end = mondayInAppTimeZone(now).getTime(); return { from: addAppDays(end, -7).getTime(), to: end, label: "Last week" }; }
  if (preset === "month") return { from: startOfAppMonth(now).getTime(), to: now, label: "This month" };
  if (preset === "lastMonth") { const end = startOfAppMonth(now).getTime(); return { from: startOfAppMonth(end - 1).getTime(), to: end, label: "Last month" }; }
  if (preset === "year") return { from: startOfAppYear(now).getTime(), to: now, label: "This year" };
  if (preset === "all") return { from: 0, to: now, label: "All time" };
  const startDate = from ? appDateStart(from) : new Date(NaN); const endDate = to ? appDateStart(to) : new Date(NaN);
  const start = startDate.getTime(); const end = addAppDays(endDate, 1).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 3650 * 86_400_000) throw new AccountingError("Custom usage range is invalid.");
  return { from: start, to: end, label: "Custom" };
}
async function usageDashboardLegacy(workspaceId: string, query: { preset?: string; from?: string | null; to?: string | null; granularity?: string; exactRange?: { from: number; to: number; label: string } }) { const range = query.exactRange ?? rangeFor(query.preset ?? "week", query.from ?? null, query.to ?? null); const granularity = ["hourly", "daily", "weekly", "monthly"].includes(query.granularity ?? "") ? query.granularity! : range.to - range.from <= 2 * 86_400_000 ? "hourly" : range.to - range.from <= 45 * 86_400_000 ? "daily" : "monthly"; const events = await db.execute({ sql: "SELECT * FROM usage_events WHERE workspace_id=? AND completed_at>=? AND completed_at<? ORDER BY completed_at", args: [workspaceId, range.from, range.to] }); const rows = events.rows; const sum = (name: string) => rows.reduce((total, row) => total + Number(row[name] ?? 0), 0); const bucket = new Map<number, { requests: number; costMicros: number; tokens: number }>(); const bucketOf = (date: number) => granularity === "hourly" ? startOfAppHour(date).getTime() : granularity === "daily" ? startOfAppDay(date).getTime() : granularity === "weekly" ? mondayInAppTimeZone(date).getTime() : startOfAppMonth(date).getTime(); for (const row of rows) { const time = bucketOf(Number(row.completed_at)); const current = bucket.get(time) ?? { requests: 0, costMicros: 0, tokens: 0 }; current.requests++; current.costMicros += Number(row.cost_micros); current.tokens += Number(row.total_tokens); bucket.set(time, current); } const grouped = (column: string) => [...new Map(rows.map((row) => [String(row[column]), { id: String(row[column]), requests: 0, costMicros: 0, tokens: 0 }])).values()]; const keys = grouped("gateway_key_id"), models = grouped("gateway_model_id"); for (const row of rows) for (const target of [keys.find((x) => x.id === String(row.gateway_key_id)), models.find((x) => x.id === String(row.gateway_model_id))]) if (target) { target.requests++; target.costMicros += Number(row.cost_micros); target.tokens += Number(row.total_tokens); } return { timeZone: appTimeZone(), range: { ...range, granularity }, summary: { requests: rows.length, tokens: sum("total_tokens"), costMicros: sum("cost_micros"), exactRequests: rows.filter((row) => row.confidence === "exact").length, assumedRequests: rows.filter((row) => row.confidence === "assumed").length, unpricedRequests: rows.filter((row) => row.confidence === "unpriced").length }, trend: [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([start, value]) => ({ start, label: formatAppBucket(start, granularity as "hourly"), ...value })), keys: keys.sort((a, b) => b.costMicros - a.costMicros), models: models.sort((a, b) => b.costMicros - a.costMicros), freshness: Date.now() }; }
void usageDashboardLegacy;

export async function usageDashboard(workspaceId: string, query: { preset?: string; from?: string | null; to?: string | null; granularity?: string; exactRange?: { from: number; to: number; label: string } }) {
  const range = query.exactRange ?? rangeFor(query.preset ?? "week", query.from ?? null, query.to ?? null); const granularity = ["hourly", "daily", "weekly", "monthly"].includes(query.granularity ?? "") ? query.granularity! : range.to - range.from <= 2 * 86_400_000 ? "hourly" : range.to - range.from <= 45 * 86_400_000 ? "daily" : "monthly";
  const budgetWindow = await writeTransaction((tx) => currentWindow(tx, workspaceId, Date.now()));
  const [events, keyRows, modelRows, budgets] = await Promise.all([db.execute({ sql: "SELECT * FROM usage_events WHERE workspace_id=? AND completed_at>=? AND completed_at<? ORDER BY completed_at", args: [workspaceId, range.from, range.to] }), db.execute({ sql: "SELECT id,name,status FROM gateway_keys WHERE workspace_id=?", args: [workspaceId] }), db.execute({ sql: "SELECT gateway_model_id,name FROM provider_models WHERE workspace_id=? AND status='active'", args: [workspaceId] }), db.execute({ sql: "SELECT b.gateway_key_id,b.limit_micros,b.enabled,COALESCE(c.spent_micros,0) spent_micros,COALESCE(c.reserved_micros,0) reserved_micros FROM gateway_budgets b LEFT JOIN budget_counters c ON c.workspace_id=b.workspace_id AND c.gateway_key_id=b.gateway_key_id AND c.window_start=? WHERE b.workspace_id=?", args: [budgetWindow.start, workspaceId] })]);
  const rows = events.rows; const sum = (name: string) => rows.reduce((total, row) => total + Number(row[name] ?? 0), 0); const bucket = new Map<number, { requests: number; costMicros: number; tokens: number }>(); const bucketOf = (date: number) => granularity === "hourly" ? startOfAppHour(date).getTime() : granularity === "daily" ? startOfAppDay(date).getTime() : granularity === "weekly" ? mondayInAppTimeZone(date).getTime() : startOfAppMonth(date).getTime();
  const keyMeta = new Map(keyRows.rows.map((row) => [String(row.id), { name: String(row.name), status: String(row.status) }])); const modelMeta = new Map(modelRows.rows.map((row) => [String(row.gateway_model_id), String(row.name)])); const budgetMeta = new Map(budgets.rows.map((row) => { const limitMicros = Number(row.limit_micros), spentMicros = Number(row.spent_micros), reservedMicros = Number(row.reserved_micros); return [String(row.gateway_key_id), { limitMicros, enabled: Number(row.enabled) === 1, spentMicros, reservedMicros, remainingMicros: Math.max(0, limitMicros - spentMicros - reservedMicros), utilization: limitMicros > 0 ? spentMicros / limitMicros : 0, windowStart: budgetWindow.start, windowEnd: budgetWindow.end, bypass: budgetWindow.bypass }] as const; }));
  const keys = new Map<string, { id: string; name: string; status: string; requests: number; tokens: number; costMicros: number; lastUsedAt: number; modelsUsed: string[]; budget?: { limitMicros: number; enabled: boolean; spentMicros: number; reservedMicros: number; remainingMicros: number; utilization: number; windowStart: number; windowEnd: number; bypass: boolean } }>(); const models = new Map<string, { id: string; name: string; requests: number; tokens: number; costMicros: number; lastUsedAt: number }>();
  for (const row of rows) { const completedAt = Number(row.completed_at), keyId = String(row.gateway_key_id), modelId = String(row.gateway_model_id), time = bucketOf(completedAt); const trend = bucket.get(time) ?? { requests: 0, costMicros: 0, tokens: 0 }; trend.requests++; trend.costMicros += Number(row.cost_micros); trend.tokens += Number(row.total_tokens); bucket.set(time, trend); const key = keys.get(keyId) ?? { id: keyId, name: keyMeta.get(keyId)?.name ?? (keyId.startsWith("shared-workspace:") ? "Shared workspace" : "Deleted key"), status: keyMeta.get(keyId)?.status ?? "deleted", requests: 0, tokens: 0, costMicros: 0, lastUsedAt: completedAt, modelsUsed: [] as string[], ...(budgetMeta.has(keyId) ? { budget: budgetMeta.get(keyId)! } : {}) }; key.requests++; key.tokens += Number(row.total_tokens); key.costMicros += Number(row.cost_micros); key.lastUsedAt = Math.max(key.lastUsedAt, completedAt); const modelName = modelMeta.get(modelId) ?? modelId; if (!key.modelsUsed.includes(modelName)) key.modelsUsed.push(modelName); keys.set(keyId, key); const model = models.get(modelId) ?? { id: modelId, name: modelName, requests: 0, tokens: 0, costMicros: 0, lastUsedAt: completedAt }; model.requests++; model.tokens += Number(row.total_tokens); model.costMicros += Number(row.cost_micros); model.lastUsedAt = Math.max(model.lastUsedAt, completedAt); models.set(modelId, model); }
  return { timeZone: appTimeZone(), range: { ...range, granularity }, summary: { requests: rows.length, tokens: sum("total_tokens"), costMicros: sum("cost_micros"), exactRequests: rows.filter((row) => row.confidence === "exact").length, assumedRequests: rows.filter((row) => row.confidence === "assumed").length, unpricedRequests: rows.filter((row) => row.confidence === "unpriced").length }, trend: [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([start, value]) => ({ start, label: formatAppBucket(start, granularity as "hourly"), ...value })), keys: [...keys.values()].sort((a, b) => b.costMicros - a.costMicros || b.lastUsedAt - a.lastUsedAt), models: [...models.values()].sort((a, b) => b.costMicros - a.costMicros || b.lastUsedAt - a.lastUsedAt), unlimited: budgetWindow.bypass, freshness: Date.now() };
}
export async function budgetUsageDashboard(workspaceId: string, granularity?: string) { const window = await writeTransaction((tx) => currentWindow(tx, workspaceId, Date.now())); return usageDashboard(workspaceId, { exactRange: { from: window.start, to: window.end, label: "Budget window" }, granularity }); }

let jobTimer: ReturnType<typeof setInterval> | undefined; let acceptingJobs = true;
async function pricingForVersion(workspaceId: string, versionId: string): Promise<Pricing | undefined> {
  const result = await db.execute({ sql: "SELECT id,group_id,input_rate,output_rate,cache_read_rate,cache_creation_rate FROM model_pricing_versions WHERE workspace_id=? AND id=?", args: [workspaceId, versionId] });
  const row = result.rows[0]; if (!row) return undefined;
  const tiers = await db.execute({ sql: "SELECT threshold_tokens,input_rate,output_rate,cache_read_rate,cache_creation_rate FROM model_pricing_tiers WHERE workspace_id=? AND version_id=?", args: [workspaceId, versionId] });
  return { groupId: String(row.group_id), versionId, inputMicrosPerMillion: Number(row.input_rate), outputMicrosPerMillion: Number(row.output_rate), cacheReadMicrosPerMillion: Number(row.cache_read_rate), cacheCreationMicrosPerMillion: Number(row.cache_creation_rate), tiers: tiers.rows.map((tier) => ({ thresholdTokens: Number(tier.threshold_tokens), inputMicrosPerMillion: Number(tier.input_rate), outputMicrosPerMillion: Number(tier.output_rate), cacheReadMicrosPerMillion: Number(tier.cache_read_rate), cacheCreationMicrosPerMillion: Number(tier.cache_creation_rate) })) };
}
async function rebuildRollupsInTransaction(tx: Transaction, workspaceId: string): Promise<boolean> { const deleted = await tx.execute({ sql: "SELECT 1 FROM accounting_deleted_workspaces WHERE workspace_id=?", args: [workspaceId] }); if (deleted.rows.length) return false; const events = await tx.execute({ sql: "SELECT * FROM usage_events WHERE workspace_id=?", args: [workspaceId] }); await tx.execute({ sql: "DELETE FROM usage_rollups WHERE workspace_id=?", args: [workspaceId] }); for (const row of events.rows) await addRollups(tx, workspaceId, { completedAt: Number(row.completed_at), gatewayKeyId: String(row.gateway_key_id), modelId: String(row.gateway_model_id), usage: { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), cacheReadTokens: Number(row.cache_read_tokens), cacheCreationTokens: Number(row.cache_creation_tokens), totalTokens: Number(row.total_tokens), completeness: String(row.completeness) as NormalizedUsage["completeness"], inputKnown: Number(row.input_known ?? 1) === 1, outputKnown: Number(row.output_known ?? 1) === 1, cacheReadKnown: Number(row.cache_read_known ?? 1) === 1, cacheCreationKnown: Number(row.cache_creation_known ?? 1) === 1 }, cost: Number(row.cost_micros), confidence: String(row.confidence), succeeded: Number(row.status) >= 200 && Number(row.status) < 300 }, Date.now()); return true; }

/**
 * Targeted operational repair: never accepts an ambient/default workspace and
 * uses normal write admission so deletion cannot race a rebuilt rollup.
 */
export async function reconcileUsageLedger(workspaceId: string): Promise<{ events: number; rollups: number; idempotencyViolations: number }> {
  if (!isWorkspaceId(workspaceId)) throw new AccountingError("Workspace is invalid.", 400);
  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.status !== "active") throw new AccountingError("Workspace is unavailable.", 409);
  const admission = await admitWorkspaceWrite(workspaceId);
  if (!admission) throw new AccountingError("Workspace is unavailable.", 409);
  try {
    const result = await writeTransaction(async (tx) => {
      const active = await tx.execute({ sql: "SELECT 1 FROM workspaces WHERE id=? AND status='active'", args: [workspaceId] });
      const deleted = await tx.execute({ sql: "SELECT 1 FROM accounting_deleted_workspaces WHERE workspace_id=?", args: [workspaceId] });
      if (!active.rows.length || deleted.rows.length) throw new AccountingError("Workspace is unavailable.", 409);
      const rebuilt = await rebuildRollupsInTransaction(tx, workspaceId);
      if (!rebuilt) throw new AccountingError("Workspace is unavailable.", 409);
      // Keep rollup rebuilding and counter repair in this same durable write.
      // A separate transaction could recreate budget rows after a concurrent
      // cross-process deletion completed between the two repairs.
      await reconcileBudgetCountersInTransaction(tx, workspaceId);
      const [events, rollups, duplicates] = await Promise.all([
        tx.execute({ sql: "SELECT COUNT(*) count FROM usage_events WHERE workspace_id=?", args: [workspaceId] }),
        tx.execute({ sql: "SELECT COUNT(*) count FROM usage_rollups WHERE workspace_id=?", args: [workspaceId] }),
        tx.execute({ sql: "SELECT COUNT(*) count FROM (SELECT attempt_id FROM usage_events WHERE workspace_id=? GROUP BY attempt_id HAVING COUNT(*)>1)", args: [workspaceId] }),
      ]);
      return { events: Number(events.rows[0]?.count ?? 0), rollups: Number(rollups.rows[0]?.count ?? 0), idempotencyViolations: Number(duplicates.rows[0]?.count ?? 0) };
    });
    // A delete can commit immediately after our transaction in another process.
    // Do not report a repair as active after that durable state has won.
    const stillActive = await getWorkspace(workspaceId);
    if (!stillActive || stillActive.status !== "active") throw new AccountingError("Workspace is unavailable.", 409);
    invalidatePublicAnalytics(workspaceId);
    return result;
  } finally {
    admission.release();
  }
}
async function runOnePricingJob(): Promise<void> {
  if (!acceptingJobs) return;
  const claim = await writeTransaction(async (tx) => {
    const pending = await tx.execute("SELECT workspace_id,id,group_id,version_id FROM pricing_jobs WHERE state='queued' ORDER BY created_at LIMIT 1");
    const row = pending.rows[0]; if (!row) return undefined;
    const changed = await tx.execute({ sql: "UPDATE pricing_jobs SET state='running',claimed_at=?,updated_at=? WHERE workspace_id=? AND id=? AND state='queued'", args: [Date.now(), Date.now(), String(row.workspace_id), String(row.id)] });
    return changed.rowsAffected ? { workspaceId: String(row.workspace_id), id: String(row.id), groupId: String(row.group_id), versionId: String(row.version_id) } : undefined;
  });
  if (!claim || activePricingJobs.has(claim.id) || !acceptingJobs) return;
  const work = (async () => { let admission: Awaited<ReturnType<typeof admitWorkspaceWrite>>; try {
    admission = await admitWorkspaceWrite(claim.workspaceId); if (!admission) return;
    const pricing = await pricingForVersion(claim.workspaceId, claim.versionId); if (!pricing) throw new Error("Pricing version is unavailable.");
    await writeTransaction(async (tx) => {
      const deleted = await tx.execute({ sql: "SELECT 1 FROM accounting_deleted_workspaces WHERE workspace_id=?", args: [claim.workspaceId] }); if (deleted.rows.length) return;
      const events = await tx.execute({ sql: "SELECT id,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,input_known,output_known,cache_read_known,cache_creation_known,confidence,status,cost_micros FROM usage_events WHERE workspace_id=? AND (cost_source IS NULL OR cost_source<>'shared-owner-mirror') AND (price_group_id=? OR model_id IN (SELECT pm.gateway_model_id FROM model_pricing_memberships m JOIN provider_models pm ON pm.workspace_id=m.workspace_id AND pm.id=m.model_id WHERE m.workspace_id=? AND m.group_id=?))", args: [claim.workspaceId, claim.groupId, claim.workspaceId, claim.groupId] });
      let processed = 0; for (const event of events.rows) {
        const usage = normalizeUsageMetrics({ ...(Number(event.input_known ?? 1) === 1 ? { input: Number(event.input_tokens) } : {}), ...(Number(event.output_known ?? 1) === 1 ? { output: Number(event.output_tokens) } : {}), ...(Number(event.cache_read_known ?? 1) === 1 ? { cached: Number(event.cache_read_tokens) } : {}), ...(Number(event.cache_creation_known ?? 1) === 1 ? { cacheCreation: Number(event.cache_creation_tokens) } : {}) }); const calculated = calculateUsageCost(usage, pricing); const successful = Number(event.status) >= 200 && Number(event.status) < 300;
        // Missing cache detail makes a complete input/output observation assumed,
        // not unknowable. Reprice that observed lower bound while retaining its
        // assumed provenance. Only partial/missing observations keep their prior
        // conservative prediction, since recalculating them would erase it.
        const repriceObserved = successful && usage.completeness === "complete" && calculated.confidence !== "unpriced";
        const cost = repriceObserved ? calculated.costMicros : Number(event.cost_micros);
        const confidence = repriceObserved && String(event.confidence) !== "assumed" ? calculated.confidence : String(event.confidence);
        await tx.execute({ sql: "UPDATE usage_events SET cost_micros=?,confidence=?,price_group_id=?,price_version_id=?,price_tier=?,cost_source=CASE WHEN ? THEN 'configured-pricing' ELSE cost_source END WHERE id=? AND workspace_id=?", args: [cost, confidence, claim.groupId, pricing.versionId, repriceObserved ? calculated.tier ?? null : null, repriceObserved ? 1 : 0, String(event.id), claim.workspaceId] }); processed++;
      }
      if (!await rebuildRollupsInTransaction(tx, claim.workspaceId)) return;
      const window = await currentWindow(tx, claim.workspaceId, Date.now()); const budgets = await tx.execute({ sql: "SELECT gateway_key_id FROM gateway_budgets WHERE workspace_id=?", args: [claim.workspaceId] }); for (const budget of budgets.rows) { const ledger = await tx.execute({ sql: "SELECT COALESCE(SUM(cost_micros),0) value FROM usage_events WHERE workspace_id=? AND gateway_key_id=? AND status>=200 AND status<300 AND completed_at>=? AND completed_at<?", args: [claim.workspaceId, String(budget.gateway_key_id), window.start, window.end] }); await tx.execute({ sql: "INSERT INTO budget_counters(workspace_id,gateway_key_id,window_start,spent_micros,reserved_micros,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(workspace_id,gateway_key_id,window_start) DO UPDATE SET spent_micros=excluded.spent_micros,updated_at=excluded.updated_at", args: [claim.workspaceId, String(budget.gateway_key_id), window.start, Number(ledger.rows[0]?.value ?? 0), Date.now()] }); }
      await tx.execute({ sql: "UPDATE pricing_jobs SET state='completed',cursor=total,updated_at=? WHERE workspace_id=? AND id=? AND state='running'", args: [Date.now(), claim.workspaceId, claim.id] });
    });
    invalidatePublicAnalytics(claim.workspaceId);
  } catch { if (!deletingAccountingWorkspaces.has(claim.workspaceId)) await db.execute({ sql: "UPDATE pricing_jobs SET state='failed',error='Unable to reprice usage.',updated_at=? WHERE workspace_id=? AND id=?", args: [Date.now(), claim.workspaceId, claim.id] }); } finally { admission?.release(); } })(); activePricingJobs.set(claim.id, work); try { await work; } finally { activePricingJobs.delete(claim.id); }
}
export function runPricingJobs(): Promise<void> { const work = runOnePricingJob(); activePricingRuns.add(work); void work.then(() => activePricingRuns.delete(work), () => activePricingRuns.delete(work)); return work; }
export function startAccountingJobs(): void { acceptingJobs = true; if (!jobTimer) jobTimer = setInterval(() => { void runPricingJobs(); void retryQueuedSettlements(); void refreshCodexBudgetAnchors(); }, 1_000); void runPricingJobs(); void retryQueuedSettlements(); void refreshCodexBudgetAnchors(); }
export async function recoverAccountingJobs(): Promise<void> {
  await db.execute("UPDATE pricing_jobs SET state='queued',claimed_at=NULL WHERE state='running'");
  await retryQueuedSettlements();
  await writeTransaction(async (tx) => {
    const reserved = await tx.execute("SELECT workspace_id,attempt_id,gateway_key_id,window_start,amount_micros FROM budget_reservations WHERE state='reserved' AND NOT EXISTS(SELECT 1 FROM accounting_settlement_queue q WHERE q.workspace_id=budget_reservations.workspace_id AND q.attempt_id=budget_reservations.attempt_id)");
    for (const row of reserved.rows) {
      await tx.execute({ sql: "UPDATE budget_counters SET reserved_micros=MAX(0,reserved_micros-?),updated_at=? WHERE workspace_id=? AND gateway_key_id=? AND window_start=?", args: [Number(row.amount_micros), Date.now(), String(row.workspace_id), String(row.gateway_key_id), Number(row.window_start)] });
      await tx.execute({ sql: "UPDATE budget_reservations SET state='abandoned' WHERE workspace_id=? AND attempt_id=? AND state='reserved'", args: [String(row.workspace_id), String(row.attempt_id)] });
    }
  });
}
export async function beginAccountingShutdown(): Promise<void> { acceptingJobs = false; if (jobTimer) clearInterval(jobTimer); jobTimer = undefined; if (settlementRetryTimer) clearTimeout(settlementRetryTimer); settlementRetryTimer = undefined; await Promise.allSettled(activePricingRuns); await Promise.allSettled(activePricingJobs.values()); await Promise.allSettled(activeCodexAnchorRefreshes); await drainQueuedSettlements(); await Promise.allSettled([...shutdownFinalizers].map((finalizer) => finalizer())); await drainQueuedSettlements(); }
