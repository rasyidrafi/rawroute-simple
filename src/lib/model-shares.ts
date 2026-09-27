import type { Transaction } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { codexExecutionReady } from "./codex";
import { getWorkspace, isWorkspaceId, listWorkspaces, type Workspace } from "./workspaces";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ModelShareError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ModelShareError"; }
}

export type ModelShare = { id: string; ownerWorkspaceId: string; recipientWorkspaceId: string; sourceModelId: string; createdAt: number; updatedAt: number };
export type SharedModelView = { id: string; ownerWorkspaceId: string; ownerWorkspaceName: string; sourceModelId: string; sourceModelName: string; qualifiedModelId: string; protocol: string; status: "active" | "unavailable"; createdAt: number; updatedAt: number };
export type SharedModelResolution = { share: ModelShare; owner: Workspace; recipient: Workspace; model: { id: string; providerId: string; gatewayModelId: string; name: string; upstreamModel: string; enabled: boolean; reasoningCapability?: { mode: "enabled" | "disabled"; supportedEfforts?: string[] } }; provider: { id: string; prefix: string; protocol: "openai-chat" | "openai-responses" | "anthropic-messages"; enabled: boolean } };
export type ModelShareTarget = { id: string; name: string; /** Persisted grant selection, never derived from runtime readiness. */ shared: boolean; /** Current execution/catalog readiness, separate from grant persistence. */ available: boolean; status: "active" | "unavailable" };

function share(row: Record<string, unknown>): ModelShare { return { id: String(row.id), ownerWorkspaceId: String(row.owner_workspace_id), recipientWorkspaceId: String(row.recipient_workspace_id), sourceModelId: String(row.source_model_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
function parseReasoning(raw: unknown): SharedModelResolution["model"]["reasoningCapability"] { try { const value = JSON.parse(String(raw ?? "")); return value?.mode === "enabled" || value?.mode === "disabled" ? value : undefined; } catch { return undefined; } }
function qualified(ownerWorkspaceId: string, gatewayModelId: string) { return `${ownerWorkspaceId}/${gatewayModelId}`; }
async function transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T> { for (let attempt = 0; attempt < 8; attempt++) { let tx: Transaction | undefined; try { tx = await db.transaction("write"); const result = await action(tx); await tx.commit(); return result; } catch (error) { if (tx && !tx.closed) await tx.rollback(); if ((error as { code?: string }).code !== "SQLITE_BUSY" || attempt === 7) throw error; await Bun.sleep(2 ** attempt); } finally { tx?.close(); } } throw new Error("Model share transaction retry limit reached."); }

export async function ensureModelShareSchema(): Promise<void> {
  await db.batch([
    { sql: "CREATE TABLE IF NOT EXISTS model_share_schema_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)" },
    { sql: `CREATE TABLE IF NOT EXISTS model_shares (
      id TEXT PRIMARY KEY NOT NULL, owner_workspace_id TEXT NOT NULL, recipient_workspace_id TEXT NOT NULL, source_model_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner_workspace_id, recipient_workspace_id, source_model_id),
      FOREIGN KEY(owner_workspace_id) REFERENCES workspaces(id), FOREIGN KEY(recipient_workspace_id) REFERENCES workspaces(id)
    )` },
    { sql: "CREATE INDEX IF NOT EXISTS model_shares_recipient_idx ON model_shares(recipient_workspace_id, source_model_id)" },
    { sql: "CREATE INDEX IF NOT EXISTS model_shares_owner_idx ON model_shares(owner_workspace_id, source_model_id)" },
    { sql: "INSERT INTO model_share_schema_meta(id,version) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET version=MAX(version,excluded.version)" },
  ], "write");
}

async function sourceFor(shareRow: ModelShare): Promise<SharedModelResolution | undefined> {
  const [owner, recipient] = await Promise.all([getWorkspace(shareRow.ownerWorkspaceId), getWorkspace(shareRow.recipientWorkspaceId)]);
  if (!owner || !recipient || owner.status !== "active" || recipient.status !== "active") return undefined;
  const result = await db.execute({ sql: `SELECT m.id,m.provider_id,m.gateway_model_id,m.name,m.upstream_model,m.enabled,m.source,m.reasoning_json,p.id provider_id,p.prefix,p.protocol,p.enabled provider_enabled,p.status provider_status
    FROM provider_models m JOIN providers p ON p.workspace_id=m.workspace_id AND p.id=m.provider_id
    WHERE m.workspace_id=? AND m.id=? AND m.status='active' AND p.status='active' LIMIT 1`, args: [shareRow.ownerWorkspaceId, shareRow.sourceModelId] });
  const row = result.rows[0];
  if (!row || Number(row.enabled) !== 1 || Number(row.provider_enabled) !== 1) return undefined;
  // Codex builtins use an owner-only private CLIProxy namespace. A share is
  // not catalog-visible unless that exact owner has a currently live mapping;
  // this check does not expose the account or its auth-file to the recipient.
  if (String(row.prefix) === "codex" && (String(row.source) !== "builtin" || !await codexExecutionReady(shareRow.ownerWorkspaceId))) return undefined;
  return { share: shareRow, owner, recipient, model: { id: String(row.id), providerId: String(row.provider_id), gatewayModelId: String(row.gateway_model_id), name: String(row.name), upstreamModel: String(row.upstream_model), enabled: true, ...(parseReasoning(row.reasoning_json) ? { reasoningCapability: parseReasoning(row.reasoning_json) } : {}) }, provider: { id: String(row.provider_id), prefix: String(row.prefix), protocol: String(row.protocol) as SharedModelResolution["provider"]["protocol"], enabled: true } };
}
function view(row: ModelShare, resolved: SharedModelResolution | undefined): SharedModelView {
  return { id: row.id, ownerWorkspaceId: row.ownerWorkspaceId, ownerWorkspaceName: resolved?.owner.name ?? row.ownerWorkspaceId, sourceModelId: row.sourceModelId, sourceModelName: resolved?.model.name ?? "Unavailable shared model", qualifiedModelId: resolved ? qualified(row.ownerWorkspaceId, resolved.model.gatewayModelId) : "", protocol: resolved?.provider.protocol ?? "openai-chat", status: resolved ? "active" : "unavailable", createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function listIncomingModelShares(recipientWorkspaceId: string): Promise<SharedModelView[]> {
  const rows = await db.execute({ sql: "SELECT * FROM model_shares WHERE recipient_workspace_id=? ORDER BY created_at,id", args: [recipientWorkspaceId] });
  const values = await Promise.all(rows.rows.map(async (row) => { const item = share(row as unknown as Record<string, unknown>); return view(item, await sourceFor(item)); }));
  return values.sort((left, right) => left.ownerWorkspaceName.localeCompare(right.ownerWorkspaceName) || left.sourceModelName.localeCompare(right.sourceModelName));
}
export async function listOutgoingModelShares(ownerWorkspaceId: string, sourceModelId?: string): Promise<Array<ModelShare & { recipientWorkspaceName: string; status: "active" | "unavailable" }>> {
  const rows = await db.execute({ sql: `SELECT * FROM model_shares WHERE owner_workspace_id=?${sourceModelId ? " AND source_model_id=?" : ""} ORDER BY created_at,id`, args: sourceModelId ? [ownerWorkspaceId, sourceModelId] : [ownerWorkspaceId] });
  const workspaces = new Map((await listWorkspaces()).map((item) => [item.id, item]));
  return await Promise.all(rows.rows.map(async (row) => { const item = share(row as unknown as Record<string, unknown>); return { ...item, recipientWorkspaceName: workspaces.get(item.recipientWorkspaceId)?.name ?? item.recipientWorkspaceId, status: (await sourceFor(item)) ? "active" as const : "unavailable" as const }; }));
}
async function sourceGrantEligible(ownerWorkspaceId: string, sourceModelId: string): Promise<boolean> {
  const source = await db.execute({ sql: `SELECT p.prefix,m.source,m.enabled,p.enabled provider_enabled
    FROM provider_models m JOIN providers p ON p.workspace_id=m.workspace_id AND p.id=m.provider_id
    WHERE m.workspace_id=? AND m.id=? AND m.status='active' AND p.status='active' LIMIT 1`, args: [ownerWorkspaceId, sourceModelId] });
  const row = source.rows[0];
  if (!row || Number(row.enabled) !== 1 || Number(row.provider_enabled) !== 1) return false;
  return String(row.prefix) !== "codex" || (String(row.source) === "builtin" && await codexExecutionReady(ownerWorkspaceId));
}
async function sourceExecutionAvailable(ownerWorkspaceId: string, sourceModelId: string): Promise<boolean> {
  const source = await db.execute({ sql: `SELECT p.prefix,m.source,m.enabled,p.enabled provider_enabled
    FROM provider_models m JOIN providers p ON p.workspace_id=m.workspace_id AND p.id=m.provider_id
    WHERE m.workspace_id=? AND m.id=? AND m.status='active' AND p.status='active' LIMIT 1`, args: [ownerWorkspaceId, sourceModelId] });
  const row = source.rows[0];
  if (!row || Number(row.enabled) !== 1 || Number(row.provider_enabled) !== 1) return false;
  return String(row.prefix) !== "codex" || (String(row.source) === "builtin" && await codexExecutionReady(ownerWorkspaceId));
}
export async function listShareTargets(ownerWorkspaceId: string, sourceModelId: string): Promise<ModelShareTarget[]> {
  const current = await listOutgoingModelShares(ownerWorkspaceId, sourceModelId);
  // `shared` is durable configuration. Do not use the status-filtered catalog
  // view here: a temporary owner/account outage must not erase a UI checkbox.
  const byRecipient = new Map(current.map((item) => [item.recipientWorkspaceId, item]));
  // Compute source readiness once for every target. An existing healthy grant
  // must not make an unselected recipient look unavailable (or vice versa).
  const sourceAvailable = await sourceExecutionAvailable(ownerWorkspaceId, sourceModelId);
  return (await listWorkspaces()).filter((item) => item.status === "active" && item.id !== ownerWorkspaceId).map((item) => {
    const grant = byRecipient.get(item.id); const available = grant ? grant.status === "active" : sourceAvailable;
    return { id: item.id, name: item.name, shared: Boolean(grant), available, status: available ? "active" : "unavailable" };
  });
}
export async function setModelShareTargets(ownerWorkspaceId: string, sourceModelId: string, values: unknown): Promise<ModelShare[]> {
  if (!UUID.test(sourceModelId)) throw new ModelShareError("Model not found.", 404);
  const recipientIds = Array.isArray(values) ? [...new Set(values.filter((item): item is string => isWorkspaceId(item)))] : [];
  if (!Array.isArray(values) || recipientIds.length !== values.length) throw new ModelShareError("Recipient workspaces are invalid.");
  if (recipientIds.includes(ownerWorkspaceId)) throw new ModelShareError("A model cannot be shared with its own workspace.");
  const owner = await getWorkspace(ownerWorkspaceId); if (!owner || owner.status !== "active") throw new ModelShareError("Workspace is unavailable.", 409);
  const persisted = await db.execute({ sql: "SELECT recipient_workspace_id FROM model_shares WHERE owner_workspace_id=? AND source_model_id=?", args: [ownerWorkspaceId, sourceModelId] });
  const existingRecipients = new Set(persisted.rows.map((row) => String(row.recipient_workspace_id)));
  const canCreate = await sourceGrantEligible(ownerWorkspaceId, sourceModelId);
  // Existing grants are administration state, not an availability cache. A
  // no-edit save (or a revocation) remains safe while the source is disabled,
  // its provider is unavailable, or an owner Codex mapping is temporarily down.
  if (!canCreate && recipientIds.some((id) => !existingRecipients.has(id))) throw new ModelShareError("Only an enabled model on an enabled provider can be shared.");
  const recipientRows = await Promise.all(recipientIds.map((id) => getWorkspace(id))); if (recipientRows.some((item) => !item || item.status !== "active")) throw new ModelShareError("One or more recipient workspaces are unavailable.");
  await transaction(async (tx) => {
    const existing = await tx.execute({ sql: "SELECT * FROM model_shares WHERE owner_workspace_id=? AND source_model_id=?", args: [ownerWorkspaceId, sourceModelId] });
    const now = Date.now(); const keep = new Set(recipientIds);
    for (const row of existing.rows) if (!keep.has(String(row.recipient_workspace_id))) {
      const grantId = String(row.id), recipientWorkspaceId = String(row.recipient_workspace_id);
      await tx.execute({ sql: "DELETE FROM routing_combo_members WHERE workspace_id=? AND target IN (SELECT alias FROM routing_aliases WHERE workspace_id=? AND share_id=?)", args: [recipientWorkspaceId, recipientWorkspaceId, grantId] });
      await tx.execute({ sql: "DELETE FROM routing_aliases WHERE workspace_id=? AND share_id=?", args: [recipientWorkspaceId, grantId] });
      await tx.execute({ sql: "DELETE FROM model_shares WHERE id=? AND owner_workspace_id=?", args: [grantId, ownerWorkspaceId] });
    }
    const present = new Set(existing.rows.map((row) => String(row.recipient_workspace_id)));
    for (const recipientWorkspaceId of recipientIds) if (!present.has(recipientWorkspaceId)) await tx.execute({ sql: "INSERT INTO model_shares(id,owner_workspace_id,recipient_workspace_id,source_model_id,created_at,updated_at) VALUES(?,?,?,?,?,?)", args: [randomUUID(), ownerWorkspaceId, recipientWorkspaceId, sourceModelId, now, now] });
  });
  const shares = await listOutgoingModelShares(ownerWorkspaceId, sourceModelId); return shares.map(({ recipientWorkspaceName: _name, status: _status, ...item }) => item);
}
export async function resolveSharedModelForRecipient(recipientWorkspaceId: string, grantId: string): Promise<SharedModelResolution | undefined> {
  if (!UUID.test(grantId)) return undefined;
  const rows = await db.execute({ sql: "SELECT * FROM model_shares WHERE id=? AND recipient_workspace_id=? LIMIT 1", args: [grantId, recipientWorkspaceId] });
  return rows.rows[0] ? await sourceFor(share(rows.rows[0] as unknown as Record<string, unknown>)) : undefined;
}
export async function validateSharedAliasTarget(recipientWorkspaceId: string, grantId: unknown, targetModelId: string): Promise<SharedModelResolution> {
  if (typeof grantId !== "string") throw new ModelShareError("A shared alias requires an explicit grant.");
  const resolved = await resolveSharedModelForRecipient(recipientWorkspaceId, grantId);
  if (!resolved || qualified(resolved.owner.id, resolved.model.gatewayModelId) !== targetModelId) throw new ModelShareError("Shared model is unavailable.");
  return resolved;
}
/** Called inside owner provider mutations; a share binds model.id, never its mutable public name. */
export async function renameSharedAliasTargetsForSourceModel(tx: Transaction, ownerWorkspaceId: string, sourceModelId: string, gatewayModelId: string): Promise<void> {
  try { await tx.execute({ sql: "UPDATE routing_aliases SET target_model_id=?,updated_at=? WHERE share_id IN (SELECT id FROM model_shares WHERE owner_workspace_id=? AND source_model_id=?)", args: [qualified(ownerWorkspaceId, gatewayModelId), Date.now(), ownerWorkspaceId, sourceModelId] }); } catch (error) { if (!/no such table/i.test(String(error))) throw error; }
}
/** Revocation/deletion removes only recipient-owned references; owner providers and credentials are untouched. */
export async function deleteModelSharesForWorkspace(workspaceId: string): Promise<void> {
  await transaction(async (tx) => {
    try {
      const affected = await tx.execute({ sql: "SELECT id,recipient_workspace_id FROM model_shares WHERE owner_workspace_id=? OR recipient_workspace_id=?", args: [workspaceId, workspaceId] });
      for (const row of affected.rows) {
        const grantId = String(row.id), recipient = String(row.recipient_workspace_id);
        await tx.execute({ sql: "DELETE FROM routing_combo_members WHERE workspace_id=? AND target IN (SELECT alias FROM routing_aliases WHERE workspace_id=? AND share_id=?)", args: [recipient, recipient, grantId] });
        await tx.execute({ sql: "DELETE FROM routing_aliases WHERE workspace_id=? AND share_id=?", args: [recipient, grantId] });
      }
      await tx.execute({ sql: "DELETE FROM routing_combos WHERE workspace_id IN (SELECT workspace_id FROM routing_combos) AND id IN (SELECT c.id FROM routing_combos c LEFT JOIN routing_combo_members m ON m.workspace_id=c.workspace_id AND m.combo_id=c.id WHERE c.workspace_id=? GROUP BY c.workspace_id,c.id HAVING COUNT(m.id)<2)", args: [workspaceId] }).catch(() => undefined);
      await tx.execute({ sql: "DELETE FROM model_shares WHERE owner_workspace_id=? OR recipient_workspace_id=?", args: [workspaceId, workspaceId] });
    } catch (error) { if (!/no such table/i.test(String(error))) throw error; }
  });
}
