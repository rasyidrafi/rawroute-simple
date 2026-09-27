import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { db } from "./db";
import { memberPolicyConfigHash, normalizeComboCustomPayload, normalizeReasoning, reasoningCapabilityError, type ComboReasoning } from "./combo-reasoning";
import { ModelShareError, ensureModelShareSchema, listIncomingModelShares, resolveSharedModelForRecipient, validateSharedAliasTarget } from "./model-shares";

const ROUTING_SCHEMA_VERSION = 1;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
// Never ship a predictable development proof key. Proofs intentionally expire
// across a restart when no deployment secret is configured.
const confirmationKey = Bun.env.ROUTING_CONFIRMATION_KEY || randomBytes(32).toString("base64url");

export class RoutingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "RoutingError"; }
}
export type RoutingAlias = { id: string; workspaceId: string; alias: string; targetModelId: string; shareId?: string; createdAt: number; updatedAt: number };
export type RoutingComboMember = { id: string; target: string; position: number; reasoning: ComboReasoning; customPayload?: Record<string, unknown>; policyHash: string; validationState: "not-tested" | "unverified" | "verified" | "invalid"; validationAt: number | null };
export type RoutingCombo = { id: string; workspaceId: string; combo: string; name: string; members: RoutingComboMember[]; createdAt: number; updatedAt: number };
export type AvailableRouteModel = { id: string; providerId: string; providerPrefix: string; name: string; upstreamModel: string; protocol: string; source: string; reasoningCapability?: { mode: "enabled" | "disabled"; supportedEfforts?: string[] }; shared?: { grantId: string; ownerWorkspaceId: string; consumerWorkspaceId: string; sourceModelId: string } };

function cleanPublicId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new RoutingError(`${label} is required.`);
  const cleaned = value.normalize("NFKC").trim().toLowerCase().replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!PUBLIC_ID.test(cleaned)) throw new RoutingError(`${label} must use lowercase letters, numbers, dots, underscores, hyphens, or slashes.`);
  return cleaned;
}
/** Provider model IDs and upstream IDs are case-sensitive transport identifiers. Never apply alias normalization to them. */
function cleanRouteTarget(value: unknown, label: string): string {
  return text(value, label, 256);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new RoutingError(`${label} is required.`);
  const result = value.normalize("NFKC").trim();
  if (!result || Array.from(result).length > max || Array.from(result).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === "\u007f")) throw new RoutingError(`${label} is invalid.`);
  return result;
}
function unique(error: unknown) { return error instanceof Error && /unique constraint|constraint failed/i.test(error.message); }
async function write<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let tx: Transaction | undefined;
    try { tx = await db.transaction("write"); const value = await operation(tx); await tx.commit(); return value; }
    catch (error) { if (tx && !tx.closed) await tx.rollback(); if ((error as { code?: string }).code !== "SQLITE_BUSY" || attempt === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 2 ** attempt)); }
    finally { tx?.close(); }
  }
  throw new Error("Routing transaction retry limit reached.");
}

export async function ensureRoutingSchema(): Promise<void> {
  await ensureModelShareSchema();
  await db.batch([
    { sql: "CREATE TABLE IF NOT EXISTS routing_schema_meta (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)" },
    { sql: `CREATE TABLE IF NOT EXISTS routing_aliases (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, target_model_id TEXT NOT NULL, share_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace_id, id), FOREIGN KEY(workspace_id) REFERENCES workspaces(id))` },
    { sql: "CREATE UNIQUE INDEX IF NOT EXISTS routing_aliases_public_id_idx ON routing_aliases(workspace_id, normalized_alias)" },
    { sql: `CREATE TABLE IF NOT EXISTS routing_combos (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, combo TEXT NOT NULL, normalized_combo TEXT NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace_id, id), FOREIGN KEY(workspace_id) REFERENCES workspaces(id))` },
    { sql: "CREATE UNIQUE INDEX IF NOT EXISTS routing_combos_public_id_idx ON routing_combos(workspace_id, normalized_combo)" },
    { sql: `CREATE TABLE IF NOT EXISTS routing_combo_members (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, combo_id TEXT NOT NULL, target TEXT NOT NULL, position INTEGER NOT NULL,
       reasoning_json TEXT NOT NULL, custom_payload_json TEXT, policy_hash TEXT NOT NULL, validation_state TEXT NOT NULL CHECK(validation_state IN ('not-tested', 'unverified', 'verified', 'invalid')),
      validation_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id, id), UNIQUE(workspace_id, combo_id, position), UNIQUE(workspace_id, combo_id, target),
      FOREIGN KEY(workspace_id, combo_id) REFERENCES routing_combos(workspace_id, id))` },
    { sql: "CREATE INDEX IF NOT EXISTS routing_combo_members_combo_idx ON routing_combo_members(workspace_id, combo_id, position)" },
    { sql: "INSERT INTO routing_schema_meta(id, version) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET version = MAX(version, excluded.version)", args: [ROUTING_SCHEMA_VERSION] },
  ], "write");
  const aliasesColumns = await db.execute("PRAGMA table_info(routing_aliases)");
  if (!aliasesColumns.rows.some((column) => String(column.name) === "share_id")) await db.execute("ALTER TABLE routing_aliases ADD COLUMN share_id TEXT");
  // SQLite cannot alter a CHECK constraint in place. Preserve every scoped row
  // while widening the truthful probe-state vocabulary introduced by execution.
  const membersSql = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'routing_combo_members'");
  if (!String(membersSql.rows[0]?.sql ?? "").includes("'verified'")) {
    await db.batch([
      { sql: "ALTER TABLE routing_combo_members RENAME TO routing_combo_members_legacy" },
      { sql: `CREATE TABLE routing_combo_members (
        id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, combo_id TEXT NOT NULL, target TEXT NOT NULL, position INTEGER NOT NULL,
        reasoning_json TEXT NOT NULL, custom_payload_json TEXT, policy_hash TEXT NOT NULL, validation_state TEXT NOT NULL CHECK(validation_state IN ('not-tested', 'unverified', 'verified', 'invalid')),
        validation_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, id), UNIQUE(workspace_id, combo_id, position), UNIQUE(workspace_id, combo_id, target),
        FOREIGN KEY(workspace_id, combo_id) REFERENCES routing_combos(workspace_id, id))` },
      { sql: "INSERT INTO routing_combo_members SELECT id, workspace_id, combo_id, target, position, reasoning_json, custom_payload_json, policy_hash, validation_state, validation_at, created_at, updated_at FROM routing_combo_members_legacy" },
      { sql: "DROP TABLE routing_combo_members_legacy" },
      { sql: "CREATE INDEX IF NOT EXISTS routing_combo_members_combo_idx ON routing_combo_members(workspace_id, combo_id, position)" },
    ], "write");
  }
}

async function availableModelsTx(tx: Transaction, workspaceId: string): Promise<AvailableRouteModel[]> {
  const rows = await tx.execute({ sql: `SELECT m.gateway_model_id id, m.provider_id provider_id, p.prefix provider_prefix, m.name, m.upstream_model, p.protocol, m.source, m.reasoning_json
    FROM provider_models m JOIN providers p ON p.workspace_id = m.workspace_id AND p.id = m.provider_id
    WHERE m.workspace_id = ? AND m.status = 'active' AND m.enabled = 1 AND p.status = 'active' AND p.enabled = 1 ORDER BY m.gateway_model_id COLLATE NOCASE, m.id`, args: [workspaceId] });
  return rows.rows.map((row) => {
    const reasoning = String(row.reasoning_json ?? "");
    let reasoningCapability: AvailableRouteModel["reasoningCapability"];
    try { const parsed = JSON.parse(reasoning); if (parsed && (parsed.mode === "enabled" || parsed.mode === "disabled")) reasoningCapability = parsed; } catch { /* malformed legacy metadata is not exposed */ }
    return { id: String(row.id), providerId: String(row.provider_id), providerPrefix: String(row.provider_prefix), name: String(row.name), upstreamModel: String(row.upstream_model), protocol: String(row.protocol), source: String(row.source ?? "custom"), ...(reasoningCapability ? { reasoningCapability } : {}) };
  });
}
export async function listAvailableRouteModels(workspaceId: string): Promise<AvailableRouteModel[]> {
  const tx = await db.transaction("read"); try { return await availableModelsTx(tx, workspaceId); } finally { tx.close(); }
}
async function aliasesTx(tx: Transaction, workspaceId: string): Promise<RoutingAlias[]> {
  const result = await tx.execute({ sql: "SELECT id, workspace_id, alias, target_model_id, share_id, created_at, updated_at FROM routing_aliases WHERE workspace_id = ? ORDER BY normalized_alias, id", args: [workspaceId] });
  return result.rows.map((row) => ({ id: String(row.id), workspaceId: String(row.workspace_id), alias: String(row.alias), targetModelId: String(row.target_model_id), ...(row.share_id ? { shareId: String(row.share_id) } : {}), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
}
function member(row: Record<string, unknown>): RoutingComboMember {
  let reasoning: ComboReasoning = { mode: "inherit" }; let customPayload: Record<string, unknown> | undefined;
  try { reasoning = normalizeReasoning(JSON.parse(String(row.reasoning_json))); } catch { /* schema data was written by this module */ }
  try { customPayload = normalizeComboCustomPayload(row.custom_payload_json ? JSON.parse(String(row.custom_payload_json)) : undefined); } catch { /* do not expose malformed custom data */ }
  const validationState = row.validation_state === "verified" || row.validation_state === "invalid" || row.validation_state === "unverified" ? row.validation_state : "not-tested";
  return { id: String(row.id), target: String(row.target), position: Number(row.position), reasoning, ...(customPayload ? { customPayload } : {}), policyHash: String(row.policy_hash), validationState, validationAt: row.validation_at === null ? null : Number(row.validation_at) };
}
async function combosTx(tx: Transaction, workspaceId: string): Promise<RoutingCombo[]> {
  const combos = await tx.execute({ sql: "SELECT id, workspace_id, combo, name, created_at, updated_at FROM routing_combos WHERE workspace_id = ? ORDER BY normalized_combo, id", args: [workspaceId] });
  const members = await tx.execute({ sql: "SELECT id, combo_id, target, position, reasoning_json, custom_payload_json, policy_hash, validation_state, validation_at FROM routing_combo_members WHERE workspace_id = ? ORDER BY combo_id, position", args: [workspaceId] });
  const byCombo = new Map<string, RoutingComboMember[]>();
  for (const row of members.rows) { const id = String(row.combo_id); const list = byCombo.get(id) ?? []; list.push(member(row as unknown as Record<string, unknown>)); byCombo.set(id, list); }
  return combos.rows.map((row) => ({ id: String(row.id), workspaceId: String(row.workspace_id), combo: String(row.combo), name: String(row.name), members: byCombo.get(String(row.id)) ?? [], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
}
export async function listRouting(workspaceId: string): Promise<{ aliases: RoutingAlias[]; combos: RoutingCombo[]; models: AvailableRouteModel[]; sharedModels: Awaited<ReturnType<typeof listIncomingModelShares>> }> {
  const tx = await db.transaction("read"); try { const [aliases, combos, models, sharedModels] = await Promise.all([aliasesTx(tx, workspaceId), combosTx(tx, workspaceId), availableModelsTx(tx, workspaceId), listIncomingModelShares(workspaceId)]); return { aliases, combos, models, sharedModels }; } finally { tx.close(); }
}
async function assertPublicId(tx: Transaction, workspaceId: string, publicId: string, except?: { table: "routing_aliases" | "routing_combos"; id: string }): Promise<void> {
  const models = await tx.execute({ sql: "SELECT 1 FROM provider_models WHERE workspace_id = ? AND gateway_model_id = ? AND status = 'active' LIMIT 1", args: [workspaceId, publicId] });
  if (models.rows.length) throw new RoutingError("Gateway model ID is already in use in this workspace.", 409);
  for (const [table, column] of [["routing_aliases", "normalized_alias"], ["routing_combos", "normalized_combo"]] as const) {
    const where = except?.table === table ? ` AND id <> ?` : "";
    const rows = await tx.execute({ sql: `SELECT 1 FROM ${table} WHERE workspace_id = ? AND ${column} = ?${where} LIMIT 1`, args: except?.table === table ? [workspaceId, publicId, except.id] : [workspaceId, publicId] });
    if (rows.rows.length) throw new RoutingError("Gateway model ID is already in use in this workspace.", 409);
  }
}
async function activeModelTarget(tx: Transaction, workspaceId: string, target: string, models?: AvailableRouteModel[]): Promise<boolean> {
  return (models ?? await availableModelsTx(tx, workspaceId)).some((model) => model.id === target);
}
async function activeComboTarget(tx: Transaction, workspaceId: string, target: string, aliases?: RoutingAlias[], models?: AvailableRouteModel[]): Promise<boolean> {
  const currentModels = models ?? await availableModelsTx(tx, workspaceId);
  if (currentModels.some((model) => model.id === target)) return true;
  const alias = (aliases ?? await aliasesTx(tx, workspaceId)).find((item) => item.alias === target);
  if (!alias) return false;
  if (alias.shareId) return Boolean(await resolveSharedModelForRecipient(workspaceId, alias.shareId));
  return currentModels.some((model) => model.id === alias.targetModelId);
}

export async function assertProviderModelPublicIdAvailable(transaction: Transaction, workspaceId: string, publicId: string, ownModelId?: string): Promise<void> {
  const aliases = await transaction.execute({ sql: "SELECT 1 FROM routing_aliases WHERE workspace_id = ? AND normalized_alias = ? LIMIT 1", args: [workspaceId, publicId] });
  const combos = await transaction.execute({ sql: "SELECT 1 FROM routing_combos WHERE workspace_id = ? AND normalized_combo = ? LIMIT 1", args: [workspaceId, publicId] });
  const models = await transaction.execute({ sql: `SELECT 1 FROM provider_models WHERE workspace_id = ? AND gateway_model_id = ? AND status = 'active'${ownModelId ? " AND id <> ?" : ""} LIMIT 1`, args: ownModelId ? [workspaceId, publicId, ownModelId] : [workspaceId, publicId] });
  if (aliases.rows.length || combos.rows.length || models.rows.length) throw new RoutingError("Gateway model ID is already in use in this workspace.", 409);
}

export async function createRoutingAlias(workspaceId: string, input: { alias: unknown; targetModelId: unknown; shareId?: unknown }): Promise<RoutingAlias> {
  const alias = cleanPublicId(input.alias, "Alias"); const targetModelId = cleanRouteTarget(input.targetModelId, "Alias target"); const id = randomUUID(); const now = Date.now(); let shareId: string | undefined;
  try { if (input.shareId !== undefined) { const shared = await validateSharedAliasTarget(workspaceId, input.shareId, targetModelId); shareId = shared.share.id; } await write(async (tx) => { await assertPublicId(tx, workspaceId, alias); if (shareId) { /* grant was checked above and is checked again when resolving */ } else if (!await activeModelTarget(tx, workspaceId, targetModelId)) throw new RoutingError("Alias target is unavailable."); await tx.execute({ sql: "INSERT INTO routing_aliases(id, workspace_id, alias, normalized_alias, target_model_id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: [id, workspaceId, alias, alias, targetModelId, shareId ?? null, now, now] }); }); }
  catch (error) { if (error instanceof ModelShareError) throw new RoutingError(error.message, error.status); if (unique(error)) throw new RoutingError("Gateway model ID is already in use in this workspace.", 409); throw error; }
  return { id, workspaceId, alias, targetModelId, ...(shareId ? { shareId } : {}), createdAt: now, updatedAt: now };
}
export async function updateRoutingAlias(workspaceId: string, aliasId: string, input: { alias?: unknown; targetModelId?: unknown; shareId?: unknown }): Promise<RoutingAlias> {
  if (!ID.test(aliasId) || !Object.keys(input).length) throw new RoutingError(!ID.test(aliasId) ? "Alias not found." : "Alias update is required.", !ID.test(aliasId) ? 404 : 400);
  return await write(async (tx) => {
    const current = await tx.execute({ sql: "SELECT alias, target_model_id, share_id, created_at FROM routing_aliases WHERE workspace_id = ? AND id = ?", args: [workspaceId, aliasId] }); const row = current.rows[0]; if (!row) throw new RoutingError("Alias not found.", 404);
    const alias = input.alias === undefined ? String(row.alias) : cleanPublicId(input.alias, "Alias"); const targetModelId = input.targetModelId === undefined ? String(row.target_model_id) : cleanRouteTarget(input.targetModelId, "Alias target");
    // Retargeting a shared alias to an enabled local model clears the old grant
    // even for older clients that omit `shareId`; an unchanged target retains
    // its binding. New clients send `shareId: null` explicitly.
    const specifiedShare = input.shareId === undefined ? (input.targetModelId !== undefined && targetModelId !== String(row.target_model_id) ? undefined : row.share_id ?? undefined) : input.shareId;
    let shareId: string | undefined;
    try { if (specifiedShare) shareId = (await validateSharedAliasTarget(workspaceId, specifiedShare, targetModelId)).share.id; } catch (error) { if (error instanceof ModelShareError) throw new RoutingError(error.message, error.status); throw error; }
    await assertPublicId(tx, workspaceId, alias, { table: "routing_aliases", id: aliasId }); if (!shareId && !await activeModelTarget(tx, workspaceId, targetModelId)) throw new RoutingError("Alias target is unavailable."); const now = Date.now();
    if (alias !== row.alias) await remapComboMemberTarget(tx, workspaceId, String(row.alias), alias, now);
    await tx.execute({ sql: "UPDATE routing_aliases SET alias = ?, normalized_alias = ?, target_model_id = ?, share_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", args: [alias, alias, targetModelId, shareId ?? null, now, workspaceId, aliasId] });
    return { id: aliasId, workspaceId, alias, targetModelId, ...(shareId ? { shareId } : {}), createdAt: Number(row.created_at), updatedAt: now };
  });
}
export async function deleteRoutingAlias(workspaceId: string, aliasId: string): Promise<void> {
  if (!ID.test(aliasId)) throw new RoutingError("Alias not found.", 404);
  const result = await db.execute({ sql: "DELETE FROM routing_aliases WHERE workspace_id = ? AND id = ?", args: [workspaceId, aliasId] }); if (result.rowsAffected !== 1) throw new RoutingError("Alias not found.", 404);
}

type MemberInput = { target: unknown; reasoning?: unknown; customPayload?: unknown; confirmation?: unknown };
function confirmation(payload: string): string { return createHmac("sha256", confirmationKey).update(payload).digest("base64url"); }
function confirmValid(token: unknown, hash: string, workspaceId: string): boolean {
  if (typeof token !== "string") return false; const [expiry, signature] = token.split("."); const expiresAt = Number(expiry); if (!/^\d+$/.test(expiry) || expiresAt < Date.now() || expiresAt > Date.now() + 5 * 60_000 || !signature) return false;
  const expected = confirmation(`${workspaceId}.${hash}.${expiry}`); try { return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}
function normalizeMembers(input: unknown): Array<{ target: string; reasoning: ComboReasoning; customPayload?: Record<string, unknown>; policyHash: string; confirmation?: unknown }> {
  if (!Array.isArray(input) || input.length < 2 || input.length > 8) throw new RoutingError("A combo needs between 2 and 8 models.");
  const output = input.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoutingError("Combo member is invalid."); const value = raw as MemberInput;
    let reasoning: ComboReasoning; let customPayload: Record<string, unknown> | undefined;
    try { reasoning = normalizeReasoning(value.reasoning); customPayload = normalizeComboCustomPayload(value.customPayload); } catch (error) { throw new RoutingError(error instanceof Error ? error.message : "Combo member policy is invalid."); }
    const target = cleanRouteTarget(value.target, "Combo member"); const policyHash = memberPolicyConfigHash({ target, reasoning, customPayload });
    return { target, reasoning, ...(customPayload ? { customPayload } : {}), policyHash, confirmation: value.confirmation };
  });
  if (new Set(output.map((item) => item.target)).size !== output.length) throw new RoutingError("Combo members must be unique.");
  return output;
}
export function issueUnverifiedPolicyConfirmation(policyHash: string, workspaceId = ""): string {
  const expiry = Date.now() + 5 * 60_000; return `${expiry}.${confirmation(`${workspaceId}.${policyHash}.${expiry}`)}`;
}
async function saveCombo(tx: Transaction, workspaceId: string, comboId: string, members: ReturnType<typeof normalizeMembers>, now: number): Promise<void> {
  const [aliases, models, existingResult] = await Promise.all([aliasesTx(tx, workspaceId), availableModelsTx(tx, workspaceId), tx.execute({ sql: "SELECT target, position, policy_hash, validation_state, validation_at FROM routing_combo_members WHERE workspace_id = ? AND combo_id = ?", args: [workspaceId, comboId] })]);
  for (const value of members) {
    if (!await activeComboTarget(tx, workspaceId, value.target, aliases, models)) throw new RoutingError("One or more combo models are unavailable.");
    const aliasTarget = aliases.find((alias) => alias.alias === value.target)?.targetModelId;
    const capabilityError = reasoningCapabilityError(value.reasoning, models.find((model) => model.id === (aliasTarget ?? value.target))?.reasoningCapability);
    if (capabilityError) throw new RoutingError(capabilityError, 409);
  }
  // A member's target and canonical policy identify it across a reorder. Its
  // list position is routing order, not policy identity.
  const existing = new Map(existingResult.rows.map((row) => [`${String(row.target)}\u0000${String(row.policy_hash)}`, row]));
  await tx.execute({ sql: "DELETE FROM routing_combo_members WHERE workspace_id = ? AND combo_id = ?", args: [workspaceId, comboId] });
  for (const [position, value] of members.entries()) {
    const policyConfigured = value.reasoning.mode !== "inherit" || Boolean(value.customPayload);
    const prior = existing.get(`${value.target}\u0000${value.policyHash}`); const unchanged = Boolean(prior);
    if (policyConfigured && prior?.validation_state === "invalid") throw new RoutingError("Invalid member policies cannot be saved.", 409);
    if (policyConfigured && !unchanged && !confirmValid(value.confirmation, value.policyHash, workspaceId)) throw new RoutingError("Unverified member policy requires a current confirmation.", 409);
    const validationState = unchanged && prior ? String(prior.validation_state) : policyConfigured ? "unverified" : "not-tested";
    const validationAt = unchanged && prior ? prior.validation_at ?? null : null;
    await tx.execute({ sql: "INSERT INTO routing_combo_members(id, workspace_id, combo_id, target, position, reasoning_json, custom_payload_json, policy_hash, validation_state, validation_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [randomUUID(), workspaceId, comboId, value.target, position, JSON.stringify(value.reasoning), value.customPayload ? JSON.stringify(value.customPayload) : null, value.policyHash, validationState, validationAt, now, now] });
  }
}
export async function createRoutingCombo(workspaceId: string, input: { combo: unknown; name: unknown; members: unknown }): Promise<RoutingCombo> {
  const combo = cleanPublicId(input.combo, "Combo"); const name = text(input.name, "Combo name", 120); const members = normalizeMembers(input.members); const id = randomUUID(); const now = Date.now();
  try { await write(async (tx) => { await assertPublicId(tx, workspaceId, combo); await tx.execute({ sql: "INSERT INTO routing_combos(id, workspace_id, combo, normalized_combo, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: [id, workspaceId, combo, combo, name, now, now] }); await saveCombo(tx, workspaceId, id, members, now); }); }
  catch (error) { if (unique(error)) throw new RoutingError("Gateway model ID is already in use in this workspace.", 409); throw error; }
  const result = await listRouting(workspaceId); const found = result.combos.find((item) => item.id === id); if (!found) throw new Error("Combo persistence failed."); return found;
}
export async function updateRoutingCombo(workspaceId: string, comboId: string, input: { combo?: unknown; name?: unknown; members?: unknown }): Promise<RoutingCombo> {
  if (!ID.test(comboId) || !Object.keys(input).length) throw new RoutingError(!ID.test(comboId) ? "Combo not found." : "Combo update is required.", !ID.test(comboId) ? 404 : 400);
  await write(async (tx) => {
    const result = await tx.execute({ sql: "SELECT combo, name FROM routing_combos WHERE workspace_id = ? AND id = ?", args: [workspaceId, comboId] }); const row = result.rows[0]; if (!row) throw new RoutingError("Combo not found.", 404);
    const combo = input.combo === undefined ? String(row.combo) : cleanPublicId(input.combo, "Combo"); const name = input.name === undefined ? String(row.name) : text(input.name, "Combo name", 120); const now = Date.now();
    await assertPublicId(tx, workspaceId, combo, { table: "routing_combos", id: comboId }); await tx.execute({ sql: "UPDATE routing_combos SET combo = ?, normalized_combo = ?, name = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", args: [combo, combo, name, now, workspaceId, comboId] });
    if (input.members !== undefined) await saveCombo(tx, workspaceId, comboId, normalizeMembers(input.members), now);
  });
  const result = await listRouting(workspaceId); const found = result.combos.find((item) => item.id === comboId); if (!found) throw new RoutingError("Combo not found.", 404); return found;
}
export async function deleteRoutingCombo(workspaceId: string, comboId: string): Promise<void> {
  if (!ID.test(comboId)) throw new RoutingError("Combo not found.", 404);
  await write(async (tx) => { await tx.execute({ sql: "DELETE FROM routing_combo_members WHERE workspace_id = ? AND combo_id = ?", args: [workspaceId, comboId] }); const result = await tx.execute({ sql: "DELETE FROM routing_combos WHERE workspace_id = ? AND id = ?", args: [workspaceId, comboId] }); if (result.rowsAffected !== 1) throw new RoutingError("Combo not found.", 404); });
}
/** Stores only the probe outcome/config hash timestamp, never upstream text or credentials. */
export async function setRoutingComboMemberValidation(workspaceId: string, comboId: string, memberId: string, policyHash: string, state: "verified" | "invalid" | "unverified"): Promise<boolean> {
  const result = await db.execute({ sql: "UPDATE routing_combo_members SET validation_state = ?, validation_at = ?, updated_at = ? WHERE workspace_id = ? AND combo_id = ? AND id = ? AND policy_hash = ?", args: [state, Date.now(), Date.now(), workspaceId, comboId, memberId, policyHash] });
  return result.rowsAffected === 1;
}

async function remapComboMemberTarget(transaction: Transaction, workspaceId: string, from: string, to: string, now: number): Promise<void> {
  const rows = await transaction.execute({ sql: "SELECT id, combo_id, target, position, reasoning_json, custom_payload_json FROM routing_combo_members WHERE workspace_id = ? AND target = ?", args: [workspaceId, from] });
  for (const row of rows.rows) {
    const collision = await transaction.execute({ sql: "SELECT 1 FROM routing_combo_members WHERE workspace_id = ? AND combo_id = ? AND target = ? AND id <> ? LIMIT 1", args: [workspaceId, String(row.combo_id), to, String(row.id)] });
    if (collision.rows.length) throw new RoutingError("Renaming this route would duplicate a combo member.", 409);
    let reasoning: ComboReasoning; let customPayload: Record<string, unknown> | undefined;
    try { reasoning = normalizeReasoning(JSON.parse(String(row.reasoning_json))); customPayload = normalizeComboCustomPayload(row.custom_payload_json ? JSON.parse(String(row.custom_payload_json)) : undefined); }
    catch { throw new Error("Routing policy data stored in the database is invalid."); }
    const policyHash = memberPolicyConfigHash({ target: to, reasoning, customPayload });
    const policyConfigured = reasoning.mode !== "inherit" || Boolean(customPayload);
    await transaction.execute({ sql: "UPDATE routing_combo_members SET target = ?, policy_hash = ?, validation_state = ?, validation_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?", args: [to, policyHash, policyConfigured ? "unverified" : "not-tested", now, workspaceId, String(row.id)] });
  }
}
async function remapAliasTargets(transaction: Transaction, workspaceId: string, from: string, to: string, now: number): Promise<void> {
  await transaction.execute({ sql: "UPDATE routing_aliases SET target_model_id = ?, updated_at = ? WHERE workspace_id = ? AND target_model_id = ?", args: [to, now, workspaceId, from] });
}
/** Update stored references atomically when a provider prefix changes. */
export async function renameRoutingModelTargets(transaction: Transaction, workspaceId: string, providerId: string, oldPrefix: string, newPrefix: string): Promise<void> {
  const rows = await transaction.execute({ sql: "SELECT gateway_suffix FROM provider_models WHERE workspace_id = ? AND provider_id = ? AND status = 'active'", args: [workspaceId, providerId] });
  const now = Date.now();
  for (const row of rows.rows) {
    const from = `${oldPrefix}/${String(row.gateway_suffix)}`; const to = `${newPrefix}/${String(row.gateway_suffix)}`;
    await remapAliasTargets(transaction, workspaceId, from, to, now);
    await remapComboMemberTarget(transaction, workspaceId, from, to, now);
  }
}
export async function renameRoutingModelTarget(transaction: Transaction, workspaceId: string, from: string, to: string): Promise<void> {
  const now = Date.now();
  await remapAliasTargets(transaction, workspaceId, from, to, now);
  await remapComboMemberTarget(transaction, workspaceId, from, to, now);
}
export async function deleteRoutingForWorkspace(workspaceId: string): Promise<void> {
  await write(async (transaction) => { await transaction.batch([{ sql: "DELETE FROM routing_combo_members WHERE workspace_id = ?", args: [workspaceId] }, { sql: "DELETE FROM routing_combos WHERE workspace_id = ?", args: [workspaceId] }, { sql: "DELETE FROM routing_aliases WHERE workspace_id = ?", args: [workspaceId] }]); });
}

export type ResolvedRoute = { requestedId: string; kind: "model" | "alias" | "combo"; model?: AvailableRouteModel; alias?: RoutingAlias; combo?: RoutingCombo };
/** Runtime resolver only reads redacted catalog data; it never exposes credential or transport details. */
export async function resolveRoutingModel(workspaceId: string, requested: string): Promise<ResolvedRoute | undefined> {
  const raw = cleanRouteTarget(requested, "Model"); let aliasId: string | undefined; try { aliasId = cleanPublicId(requested, "Model"); } catch { /* upstream IDs need not be alias-safe */ } const catalog = await listRouting(workspaceId);
  const model = catalog.models.find((entry) => entry.id === raw); if (model) return { requestedId: raw, kind: "model", model };
  // An exact alias spelling shadows suffix/upstream lookup even when its target has become unavailable.
  const alias = aliasId ? catalog.aliases.find((entry) => entry.alias === aliasId) : undefined;
  if (alias) {
    if (alias.shareId) {
      const shared = await resolveSharedModelForRecipient(workspaceId, alias.shareId);
      if (!shared) return undefined;
      const model: AvailableRouteModel = { id: shared.model.gatewayModelId, providerId: shared.provider.id, providerPrefix: shared.provider.prefix, name: shared.model.name, upstreamModel: shared.model.upstreamModel, protocol: shared.provider.protocol, source: "shared", ...(shared.model.reasoningCapability ? { reasoningCapability: shared.model.reasoningCapability } : {}), shared: { grantId: shared.share.id, ownerWorkspaceId: shared.owner.id, consumerWorkspaceId: workspaceId, sourceModelId: shared.model.id } };
      return { requestedId: aliasId!, kind: "alias", alias, model };
    }
    const target = catalog.models.find((entry) => entry.id === alias.targetModelId); return target ? { requestedId: aliasId!, kind: "alias", alias, model: target } : undefined;
  }
  const activeSharedGrants = new Set(catalog.sharedModels.filter((entry) => entry.status === "active").map((entry) => entry.id));
  const combo = aliasId ? catalog.combos.find((entry) => entry.combo === aliasId && entry.members.some((memberEntry) => catalog.models.some((modelEntry) => modelEntry.id === memberEntry.target) || catalog.aliases.some((aliasEntry) => aliasEntry.alias === memberEntry.target && (catalog.models.some((modelEntry) => modelEntry.id === aliasEntry.targetModelId) || Boolean(aliasEntry.shareId && activeSharedGrants.has(aliasEntry.shareId)))))) : undefined; if (combo) return { requestedId: aliasId!, kind: "combo", combo };
  const candidates = new Map<string, AvailableRouteModel>();
  for (const entry of catalog.models) if (entry.upstreamModel === raw || entry.id.split("/").at(-1) === raw) candidates.set(entry.id, entry);
  return candidates.size === 1 ? { requestedId: raw, kind: "model", model: candidates.values().next().value } : undefined;
}
