import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Transaction } from "@libsql/client";
import { db } from "./db";

const PROVIDER_SCHEMA_VERSION = 1;
const MASKED_SECRET = "__unchanged__";
// IDs are generated as UUIDv4 today, but the wire contract is an opaque stable
// UUID so a future generator can change without invalidating stored resources.
const PROVIDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reservedHeaders = new Set(["authorization", "connection", "content-length", "cookie", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "x-api-key"]);

export type ProviderProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export type ProviderAuthType = "bearer" | "x-api-key" | "none";
export type Provider = {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authType: ProviderAuthType;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  desiredRevision: number;
  appliedRevision: number | null;
  apiKeyCount: number;
  enabledApiKeyCount: number;
  modelCount: number;
  enabledModelCount: number;
};

export type ProviderCredential = {
  id: string;
  workspaceId: string;
  providerId: string;
  name: string;
  key: typeof MASKED_SECRET;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
};

export type ProviderModel = {
  id: string;
  workspaceId: string;
  providerId: string;
  name: string;
  gatewaySuffix: string;
  gatewayModelId: string;
  upstreamModel: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ProviderDetail = Provider & { credentials: ProviderCredential[]; models: ProviderModel[] };
/** Secret-bearing internal snapshot used only by server-side CLIProxy reconciliation. */
export type ProviderProjectionSnapshot = {
  provider: Provider;
  credentials: Array<{ id: string; enabled: boolean; priority: number; secret: string }>;
  models: ProviderModel[];
};

export type ProviderInput = {
  name: unknown;
  prefix: unknown;
  baseUrl: unknown;
  protocol: unknown;
  authType?: unknown;
  headers?: unknown;
  enabled?: unknown;
};

export class ProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProviderError";
  }
}

type ProviderRow = {
  id: string; workspace_id: string; name: string; prefix: string; base_url: string;
  protocol: ProviderProtocol; auth_type: ProviderAuthType; headers_json: string; enabled: number;
  created_at: number; updated_at: number; desired_revision: number; applied_revision: number | null;
  api_key_count?: number; enabled_api_key_count?: number; model_count?: number; enabled_model_count?: number;
};
type CredentialRow = { id: string; workspace_id: string; provider_id: string; name: string; enabled: number; priority: number; created_at: number; updated_at: number; encrypted_secret?: string };
type ModelRow = { id: string; workspace_id: string; provider_id: string; name: string; gateway_suffix: string; gateway_model_id: string; upstream_model: string; enabled: number; created_at: number; updated_at: number };

let masterKey: Buffer | undefined;
const providerWriteLocks = new Map<string, Promise<void>>();

function dataRoot(): string {
  return path.resolve(process.env.RAWROUTE_DATA_DIR || path.join(homedir(), ".local/share/rawroute"));
}

export function providerCredentialMasterPath(): string {
  return path.join(dataRoot(), "provider-credentials", "master-key");
}

function readPersistedProviderMaster(filePath: string): Buffer {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Provider credential master key path is not a regular file.");
  fs.chmodSync(filePath, 0o600);
  const encoded = fs.readFileSync(filePath, "utf8").trim();
  const key = Buffer.from(encoded, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("Provider credential master key is invalid.");
  return key;
}

async function ensureProviderCredentialMaster(): Promise<void> {
  if (masterKey) return;
  const filePath = providerCredentialMasterPath();
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = fs.lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Provider credential state directory is not private.");
  fs.chmodSync(directory, 0o700);
  if (fs.existsSync(filePath)) {
    masterKey = readPersistedProviderMaster(filePath);
    return;
  }
  const ciphertext = await db.execute("SELECT 1 FROM provider_credentials WHERE encrypted_secret <> '' LIMIT 1");
  if (ciphertext.rows.length) throw new Error("Provider credential master key is missing while encrypted provider credentials exist.");
  const candidate = randomBytes(32);
  const temporary = path.join(directory, `.master-key.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.chmodSync(temporary, 0o600);
      fs.writeFileSync(descriptor, `${candidate.toString("base64url")}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    try {
      fs.linkSync(temporary, filePath);
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      masterKey = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      masterKey = readPersistedProviderMaster(filePath);
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* published key is already durable */ }
  }
}

function requireMasterKey(): Buffer {
  if (!masterKey) throw new Error("Provider credential master key has not been initialized.");
  return masterKey;
}
function aad(credentialId: string, workspaceId: string, providerId: string): Buffer {
  return Buffer.from(`${credentialId}\u0000${workspaceId}\u0000${providerId}`, "utf8");
}
function encryptSecret(secret: string, credentialId: string, workspaceId: string, providerId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireMasterKey(), iv);
  cipher.setAAD(aad(credentialId, workspaceId, providerId));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
function decryptSecret(payload: string, credentialId: string, workspaceId: string, providerId: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]*$/.test(part))) throw new Error("Provider credential ciphertext is invalid.");
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Provider credential ciphertext is invalid.");
    const decipher = createDecipheriv("aes-256-gcm", requireMasterKey(), iv);
    decipher.setAAD(aad(credentialId, workspaceId, providerId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message === "Provider credential ciphertext is invalid.") throw error;
    throw new Error("Provider credential ciphertext could not be authenticated.");
  }
}

function fieldText(input: unknown, label: string, max: number): string {
  if (typeof input !== "string") throw new ProviderError(`${label} is required.`, 400);
  const value = input.normalize("NFKC").trim();
  if (!value || Array.from(value).length > max || Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === "\u007f")) throw new ProviderError(`${label} is invalid.`, 400);
  return value;
}
function normalizePrefix(input: unknown): string {
  const prefix = fieldText(input, "Provider prefix", 63).toLowerCase();
  if (!PREFIX.test(prefix)) throw new ProviderError("Provider prefix must use lowercase letters, numbers, or hyphens.", 400);
  if (prefix === "codex") throw new ProviderError("The codex provider prefix is reserved.", 400);
  return prefix;
}
function validateUrl(input: unknown, protocol: ProviderProtocol): string {
  const raw = fieldText(input, "Provider base URL", 2048).replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderError("Provider base URL is invalid.", 400); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new ProviderError("Provider base URL is invalid.", 400);
  if (protocol === "anthropic-messages" && url.pathname.replace(/\/+$/, "") === "/v1") url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}
function firstPartyAnthropic(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.anthropic.com" && (!url.port || url.port === "443") && !url.username && !url.password;
  } catch { return false; }
}
function validateProtocol(input: unknown): ProviderProtocol {
  if (input === "openai-chat" || input === "openai-responses" || input === "anthropic-messages") return input;
  throw new ProviderError("Provider protocol is invalid.", 400);
}
function validateAuth(input: unknown, protocol: ProviderProtocol, baseUrl: string): ProviderAuthType {
  const auth = input === undefined ? "bearer" : input;
  if (auth !== "bearer" && auth !== "x-api-key" && auth !== "none") throw new ProviderError("Provider authentication type is invalid.", 400);
  if (protocol !== "anthropic-messages" && auth !== "bearer" && auth !== "none") throw new ProviderError("OpenAI-compatible providers support bearer or no authentication.", 400);
  if (protocol === "anthropic-messages" && ((!firstPartyAnthropic(baseUrl) && auth !== "bearer") || (firstPartyAnthropic(baseUrl) && auth === "none"))) throw new ProviderError("Anthropic authentication is not compatible with this provider URL.", 400);
  return auth;
}
function validateHeaders(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 20) throw new ProviderError("Provider headers must be a JSON object.", 400);
  const output: Record<string, string> = {};
  const probe = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (reservedHeaders.has(name.toLowerCase())) throw new ProviderError(`Provider header ${name} is reserved.`, 400);
    if (typeof value !== "string" || value.length > 1024) throw new ProviderError(`Provider header ${name} is invalid.`, 400);
    try { probe.set(name, value); } catch { throw new ProviderError(`Invalid provider header name or value: ${name}`, 400); }
    output[name] = value;
  }
  return output;
}
function parseHeaders(value: string): Record<string, string> {
  try { return validateHeaders(JSON.parse(value)); } catch { throw new Error("Provider headers stored in the database are invalid."); }
}
function validateEnabled(input: unknown): boolean {
  if (input === undefined) return true;
  if (typeof input !== "boolean") throw new ProviderError("Enabled must be a boolean.", 400);
  return input;
}
function isUnique(error: unknown): boolean { return error instanceof Error && /unique constraint|constraint failed/i.test(error.message); }
function notFound(kind = "Provider"): ProviderError { return new ProviderError(`${kind} not found.`, 404); }
export function isProviderId(value: unknown): value is string { return typeof value === "string" && PROVIDER_ID.test(value); }

function providerFromRow(row: ProviderRow): Provider {
  return { id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), prefix: String(row.prefix), baseUrl: String(row.base_url), protocol: row.protocol, authType: row.auth_type, headers: parseHeaders(String(row.headers_json)), enabled: Number(row.enabled) === 1, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), desiredRevision: Number(row.desired_revision), appliedRevision: row.applied_revision === null || row.applied_revision === undefined ? null : Number(row.applied_revision), apiKeyCount: Number(row.api_key_count ?? 0), enabledApiKeyCount: Number(row.enabled_api_key_count ?? 0), modelCount: Number(row.model_count ?? 0), enabledModelCount: Number(row.enabled_model_count ?? 0) };
}
function credentialFromRow(row: CredentialRow): ProviderCredential {
  return { id: String(row.id), workspaceId: String(row.workspace_id), providerId: String(row.provider_id), name: String(row.name), key: MASKED_SECRET, enabled: Number(row.enabled) === 1, priority: Number(row.priority), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function modelFromRow(row: ModelRow): ProviderModel {
  return { id: String(row.id), workspaceId: String(row.workspace_id), providerId: String(row.provider_id), name: String(row.name), gatewaySuffix: String(row.gateway_suffix), gatewayModelId: String(row.gateway_model_id), upstreamModel: String(row.upstream_model), enabled: Number(row.enabled) === 1, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

const providerSelect = `
  SELECT p.id, p.workspace_id, p.name, p.prefix, p.base_url, p.protocol, p.auth_type, p.headers_json, p.enabled,
    p.created_at, p.updated_at, p.desired_revision, p.applied_revision,
    (SELECT COUNT(*) FROM provider_credentials c WHERE c.workspace_id = p.workspace_id AND c.provider_id = p.id AND c.status = 'active') AS api_key_count,
    (SELECT COUNT(*) FROM provider_credentials c WHERE c.workspace_id = p.workspace_id AND c.provider_id = p.id AND c.status = 'active' AND c.enabled = 1) AS enabled_api_key_count,
    (SELECT COUNT(*) FROM provider_models m WHERE m.workspace_id = p.workspace_id AND m.provider_id = p.id AND m.status = 'active') AS model_count,
    (SELECT COUNT(*) FROM provider_models m WHERE m.workspace_id = p.workspace_id AND m.provider_id = p.id AND m.status = 'active' AND m.enabled = 1) AS enabled_model_count
  FROM providers p`;

async function activeProvider(workspaceId: string, providerId: string): Promise<ProviderRow | undefined> {
  if (!isProviderId(providerId)) return undefined;
  const result = await db.execute({ sql: `${providerSelect} WHERE p.workspace_id = ? AND p.id = ? AND p.status = 'active' LIMIT 1`, args: [workspaceId, providerId] });
  return result.rows[0] as unknown as ProviderRow | undefined;
}
async function activeProviderInTransaction(transaction: Transaction, workspaceId: string, providerId: string): Promise<ProviderRow | undefined> {
  if (!isProviderId(providerId)) return undefined;
  const result = await transaction.execute({ sql: `${providerSelect} WHERE p.workspace_id = ? AND p.id = ? AND p.status = 'active' LIMIT 1`, args: [workspaceId, providerId] });
  return result.rows[0] as unknown as ProviderRow | undefined;
}
async function inWriteTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
  // libSQL's local SQLite client opens write transactions concurrently. A losing
  // transaction receives SQLITE_BUSY instead of waiting, so retry the complete
  // read/modify/write operation rather than applying a stale pre-transaction read.
  for (let attempt = 0; attempt < 8; attempt++) {
    let transaction: Transaction | undefined;
    try {
      transaction = await db.transaction("write");
      const value = await operation(transaction);
      await transaction.commit();
      return value;
    } catch (error) {
      if (transaction && !transaction.closed) await transaction.rollback();
      if ((error as { code?: unknown }).code !== "SQLITE_BUSY" || attempt === 7) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(32, 2 ** attempt)));
    } finally { transaction?.close(); }
  }
  throw new Error("Provider transaction retry limit reached.");
}
async function withProviderWriteLock<T>(workspaceId: string, providerId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${workspaceId}\u0000${providerId}`;
  const previous = providerWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  providerWriteLocks.set(key, current);
  await previous.catch(() => undefined);
  try { return await operation(); } finally {
    release();
    if (providerWriteLocks.get(key) === current) providerWriteLocks.delete(key);
  }
}
async function inProviderWriteTransaction<T>(workspaceId: string, providerId: string, operation: (transaction: Transaction) => Promise<T>): Promise<T> {
  return await withProviderWriteLock(workspaceId, providerId, async () => await inWriteTransaction(operation));
}
function touchProvider(workspaceId: string, providerId: string, now: number) {
  return { sql: "UPDATE providers SET desired_revision = desired_revision + 1, applied_revision = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'active'", args: [now, workspaceId, providerId] };
}
function managedNamespace(workspaceId: string, providerId: string): string {
  const digest = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);
  return `rr-ws-${digest(`workspace:${workspaceId}`, 16)}-p-${digest(`provider:${providerId}`, 12)}`;
}
function managedNamePrefix(workspaceId: string, providerId: string): string {
  const digest = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);
  return `rr-managed-${digest(`workspace:${workspaceId}`, 16)}-${digest(`provider:${providerId}`, 12)}-`;
}
function providerTombstone(workspaceId: string, providerId: string, desiredRevision: number, claudeFingerprintsJson: string, now: number) {
  return {
    sql: `INSERT INTO provider_projection_tombstones (workspace_id, provider_id, namespace, name_prefix, desired_revision, claude_fingerprints_json, state, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'cleanup-pending', NULL, ?, ?)
      ON CONFLICT(workspace_id, provider_id) DO UPDATE SET desired_revision = excluded.desired_revision,
        claude_fingerprints_json = CASE WHEN excluded.claude_fingerprints_json = '[]' THEN provider_projection_tombstones.claude_fingerprints_json ELSE excluded.claude_fingerprints_json END,
        state = 'cleanup-pending', last_error = NULL, updated_at = excluded.updated_at`,
    args: [workspaceId, providerId, managedNamespace(workspaceId, providerId), managedNamePrefix(workspaceId, providerId), desiredRevision, claudeFingerprintsJson, now, now],
  };
}
function ownershipFingerprints(value: unknown): string {
  if (typeof value !== "string") return "[]";
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))) return JSON.stringify([...new Set(parsed)].sort());
  } catch { /* stale ownership is not trusted */ }
  return "[]";
}
function mergedOwnershipFingerprints(...values: unknown[]): string {
  const fingerprints = new Set<string>();
  for (const value of values) {
    try {
      const parsed: unknown = JSON.parse(ownershipFingerprints(value));
      if (Array.isArray(parsed)) for (const fingerprint of parsed) fingerprints.add(String(fingerprint));
    } catch { /* ownershipFingerprints already rejected invalid values */ }
  }
  return JSON.stringify([...fingerprints].sort());
}

export async function ensureProviderSchema(): Promise<void> {
  await db.batch([
    { sql: "CREATE TABLE IF NOT EXISTS provider_schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)" },
    { sql: `CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, normalized_prefix TEXT NOT NULL,
      base_url TEXT NOT NULL, protocol TEXT NOT NULL CHECK (protocol IN ('openai-chat', 'openai-responses', 'anthropic-messages')),
      auth_type TEXT NOT NULL CHECK (auth_type IN ('bearer', 'x-api-key', 'none')), headers_json TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('active', 'deleted')), desired_revision INTEGER NOT NULL, applied_revision INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      UNIQUE(workspace_id, id)
    )` },
    { sql: "CREATE UNIQUE INDEX IF NOT EXISTS providers_workspace_prefix_active_idx ON providers(workspace_id, normalized_prefix) WHERE status = 'active'" },
    { sql: `CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), priority INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      UNIQUE(workspace_id, id), FOREIGN KEY(workspace_id, provider_id) REFERENCES providers(workspace_id, id)
    )` },
    { sql: "CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_name_active_idx ON provider_credentials(workspace_id, provider_id, normalized_name) WHERE status = 'active'" },
    { sql: "CREATE INDEX IF NOT EXISTS provider_credentials_order_idx ON provider_credentials(workspace_id, provider_id, status, priority, id)" },
    { sql: `CREATE TABLE IF NOT EXISTS provider_models (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, name TEXT NOT NULL, gateway_suffix TEXT NOT NULL,
      gateway_model_id TEXT NOT NULL, upstream_model TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      UNIQUE(workspace_id, id), FOREIGN KEY(workspace_id, provider_id) REFERENCES providers(workspace_id, id)
    )` },
    { sql: "CREATE UNIQUE INDEX IF NOT EXISTS provider_models_gateway_active_idx ON provider_models(workspace_id, gateway_model_id) WHERE status = 'active'" },
    { sql: "CREATE INDEX IF NOT EXISTS provider_models_provider_idx ON provider_models(workspace_id, provider_id, status, gateway_suffix)" },
    { sql: `CREATE TABLE IF NOT EXISTS provider_sync_state (
      workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, desired_revision INTEGER NOT NULL, applied_revision INTEGER,
      state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'error', 'native-execution-pending')),
      last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, provider_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS provider_projection_tombstones (
      workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, namespace TEXT NOT NULL, name_prefix TEXT NOT NULL,
      desired_revision INTEGER NOT NULL, claude_fingerprints_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL CHECK (state IN ('cleanup-pending', 'cleanup-error')),
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, provider_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS provider_projection_ownership (
      workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, claude_fingerprints_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, provider_id)
    )` },
    { sql: "INSERT INTO provider_schema_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = MAX(version, excluded.version)", args: [PROVIDER_SCHEMA_VERSION] },
  ], "write");
  const tombstoneColumns = await db.execute("PRAGMA table_info(provider_projection_tombstones)");
  if (!tombstoneColumns.rows.some((row) => String(row.name) === "claude_fingerprints_json")) {
    await db.execute("ALTER TABLE provider_projection_tombstones ADD COLUMN claude_fingerprints_json TEXT NOT NULL DEFAULT '[]'");
  }
  await ensureProviderCredentialMaster();
}

export async function listProviders(workspaceId: string): Promise<Provider[]> {
  const result = await db.execute({ sql: `${providerSelect} WHERE p.workspace_id = ? AND p.status = 'active' ORDER BY p.name COLLATE NOCASE, p.id`, args: [workspaceId] });
  return result.rows.map((row) => providerFromRow(row as unknown as ProviderRow));
}
/** Scoped aggregate used by admin model selectors; it never includes deleted rows. */
export async function listProviderModels(workspaceId: string): Promise<ProviderModel[]> {
  const result = await db.execute({ sql: "SELECT id, workspace_id, provider_id, name, gateway_suffix, gateway_model_id, upstream_model, enabled, created_at, updated_at FROM provider_models WHERE workspace_id = ? AND status = 'active' ORDER BY gateway_model_id COLLATE NOCASE, id", args: [workspaceId] });
  return result.rows.map((row) => modelFromRow(row as unknown as ModelRow));
}
export async function getProviderDetail(workspaceId: string, providerId: string): Promise<ProviderDetail | undefined> {
  const row = await activeProvider(workspaceId, providerId);
  if (!row) return undefined;
  const [credentials, models] = await Promise.all([
    db.execute({ sql: "SELECT id, workspace_id, provider_id, name, enabled, priority, created_at, updated_at FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND status = 'active' ORDER BY priority, id", args: [workspaceId, providerId] }),
    db.execute({ sql: "SELECT id, workspace_id, provider_id, name, gateway_suffix, gateway_model_id, upstream_model, enabled, created_at, updated_at FROM provider_models WHERE workspace_id = ? AND provider_id = ? AND status = 'active' ORDER BY gateway_suffix COLLATE NOCASE, id", args: [workspaceId, providerId] }),
  ]);
  return { ...providerFromRow(row), credentials: credentials.rows.map((item) => credentialFromRow(item as unknown as CredentialRow)), models: models.rows.map((item) => modelFromRow(item as unknown as ModelRow)) };
}

export async function getProviderProjectionSnapshot(workspaceId: string, providerId: string): Promise<ProviderProjectionSnapshot | undefined> {
  const row = await activeProvider(workspaceId, providerId);
  if (!row) return undefined;
  const [credentials, models] = await Promise.all([
    db.execute({ sql: "SELECT id, workspace_id, provider_id, enabled, priority, encrypted_secret FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND status = 'active' ORDER BY priority, id", args: [workspaceId, providerId] }),
    db.execute({ sql: "SELECT id, workspace_id, provider_id, name, gateway_suffix, gateway_model_id, upstream_model, enabled, created_at, updated_at FROM provider_models WHERE workspace_id = ? AND provider_id = ? AND status = 'active' ORDER BY gateway_suffix COLLATE NOCASE, id", args: [workspaceId, providerId] }),
  ]);
  return {
    provider: providerFromRow(row),
    credentials: credentials.rows.map((item) => {
      const credential = item as unknown as CredentialRow;
      return { id: String(credential.id), enabled: Number(credential.enabled) === 1, priority: Number(credential.priority), secret: decryptSecret(String(credential.encrypted_secret), String(credential.id), String(credential.workspace_id), String(credential.provider_id)) };
    }),
    models: models.rows.map((item) => modelFromRow(item as unknown as ModelRow)),
  };
}

export async function createProvider(workspaceId: string, input: ProviderInput): Promise<Provider> {
  const protocol = validateProtocol(input.protocol);
  const prefix = normalizePrefix(input.prefix);
  const baseUrl = validateUrl(input.baseUrl, protocol);
  const authType = validateAuth(input.authType, protocol, baseUrl);
  const id = randomUUID(); const now = Date.now();
  try {
    await db.execute({ sql: `INSERT INTO providers (id, workspace_id, name, prefix, normalized_prefix, base_url, protocol, auth_type, headers_json, enabled, status, desired_revision, applied_revision, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, NULL, ?, ?, NULL)`, args: [id, workspaceId, fieldText(input.name, "Provider name", 80), prefix, prefix, baseUrl, protocol, authType, JSON.stringify(validateHeaders(input.headers)), validateEnabled(input.enabled) ? 1 : 0, now, now] });
  } catch (error) { if (isUnique(error)) throw new ProviderError("Provider prefix is already in use in this workspace.", 409); throw error; }
  const detail = await getProviderDetail(workspaceId, id); if (!detail) throw notFound(); return detail;
}

export async function updateProvider(workspaceId: string, providerId: string, input: Partial<ProviderInput>): Promise<Provider> {
  if (Object.keys(input).length === 0) throw new ProviderError("Provider update is required.", 400);
  try {
    await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
      const row = await activeProviderInTransaction(transaction, workspaceId, providerId); if (!row) throw notFound();
      const current = providerFromRow(row);
      const protocol = input.protocol === undefined ? current.protocol : validateProtocol(input.protocol);
      const prefix = input.prefix === undefined ? current.prefix : normalizePrefix(input.prefix);
      const baseUrl = validateUrl(input.baseUrl === undefined ? current.baseUrl : input.baseUrl, protocol);
      const authType = validateAuth(input.authType === undefined ? current.authType : input.authType, protocol, baseUrl);
      const name = input.name === undefined ? current.name : fieldText(input.name, "Provider name", 80);
      const headers = input.headers === undefined ? current.headers : validateHeaders(input.headers);
      const enabled = input.enabled === undefined ? current.enabled : validateEnabled(input.enabled);
      const now = Date.now();
      await transaction.execute({ sql: `UPDATE providers SET name = ?, prefix = ?, normalized_prefix = ?, base_url = ?, protocol = ?, auth_type = ?, headers_json = ?, enabled = ?, desired_revision = desired_revision + 1, applied_revision = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'active'`, args: [name, prefix, prefix, baseUrl, protocol, authType, JSON.stringify(headers), enabled ? 1 : 0, now, workspaceId, providerId] });
      if (prefix !== current.prefix) {
        await transaction.execute({ sql: "UPDATE provider_models SET gateway_model_id = ? || '/' || gateway_suffix, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND status = 'active'", args: [prefix, now, workspaceId, providerId] });
      }
    });
  } catch (error) { if (isUnique(error)) throw new ProviderError("Provider prefix or gateway model ID is already in use in this workspace.", 409); throw error; }
  const detail = await getProviderDetail(workspaceId, providerId); if (!detail) throw notFound(); return detail;
}

export async function deleteProvider(workspaceId: string, providerId: string): Promise<void> {
  await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
    const provider = await activeProviderInTransaction(transaction, workspaceId, providerId);
    if (!provider) throw notFound();
    const ownership = await transaction.execute({ sql: "SELECT claude_fingerprints_json FROM provider_projection_ownership WHERE workspace_id = ? AND provider_id = ?", args: [workspaceId, providerId] });
    const tombstone = await transaction.execute({ sql: "SELECT claude_fingerprints_json FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ?", args: [workspaceId, providerId] });
    const now = Date.now();
    await transaction.batch([
      { sql: "UPDATE provider_credentials SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND status = 'active'", args: [now, now, workspaceId, providerId] },
      { sql: "UPDATE provider_models SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND status = 'active'", args: [now, now, workspaceId, providerId] },
      { sql: "UPDATE providers SET status = 'deleted', deleted_at = ?, desired_revision = desired_revision + 1, applied_revision = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'active'", args: [now, now, workspaceId, providerId] },
      providerTombstone(workspaceId, providerId, Number(provider.desired_revision) + 1, mergedOwnershipFingerprints(ownership.rows[0]?.claude_fingerprints_json, tombstone.rows[0]?.claude_fingerprints_json), now),
      { sql: "DELETE FROM provider_sync_state WHERE workspace_id = ? AND provider_id = ?", args: [workspaceId, providerId] },
      { sql: "DELETE FROM provider_projection_ownership WHERE workspace_id = ? AND provider_id = ?", args: [workspaceId, providerId] },
    ]);
  });
}

function credentialName(input: unknown): string { return fieldText(input, "Provider credential name", 80); }
function credentialSecret(input: unknown, required: boolean): string | undefined {
  if (input === undefined || input === MASKED_SECRET) { if (required) throw new ProviderError("Provider credential value is required.", 400); return undefined; }
  if (typeof input !== "string" || !input.trim() || input.length > 8192 || input.includes("\0") || input.includes("\r") || input.includes("\n")) throw new ProviderError("Provider credential value is invalid.", 400);
  return input;
}
export async function createProviderCredential(workspaceId: string, providerId: string, input: { name: unknown; key: unknown; enabled?: unknown }): Promise<ProviderCredential> {
  const id = randomUUID(); const name = credentialName(input.name); const secret = credentialSecret(input.key, true)!;
  const enabled = input.enabled === undefined ? true : validateEnabled(input.enabled);
  let priority = 0; let now = 0;
  try {
    await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
      const provider = await activeProviderInTransaction(transaction, workspaceId, providerId); if (!provider) throw notFound();
      if (provider.auth_type === "none") throw new ProviderError("This provider does not use credentials.", 409);
      const priorityResult = await transaction.execute({ sql: "SELECT COALESCE(MAX(priority), -1) AS max_priority FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND status = 'active'", args: [workspaceId, providerId] });
      priority = Number(priorityResult.rows[0]?.max_priority ?? -1) + 1;
      now = Date.now();
      await transaction.batch([
        { sql: "INSERT INTO provider_credentials (id, workspace_id, provider_id, name, normalized_name, encrypted_secret, enabled, priority, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)", args: [id, workspaceId, providerId, name, name.toLocaleLowerCase("en-US"), encryptSecret(secret, id, workspaceId, providerId), enabled ? 1 : 0, priority, now, now] },
        touchProvider(workspaceId, providerId, now),
      ]);
    });
  } catch (error) { if (isUnique(error)) throw new ProviderError("Provider credential name is already in use.", 409); throw error; }
  return { id, workspaceId, providerId, name, key: MASKED_SECRET, enabled, priority, createdAt: now, updatedAt: now };
}

export async function updateProviderCredential(workspaceId: string, providerId: string, credentialId: string, input: { name?: unknown; key?: unknown; enabled?: unknown }): Promise<ProviderCredential> {
  if (!isProviderId(credentialId)) throw notFound("Provider credential");
  if (!Object.keys(input).length) throw new ProviderError("Provider credential update is required.", 400);
  const secret = credentialSecret(input.key, false);
  let updated: ProviderCredential | undefined;
  try {
    await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
      if (!await activeProviderInTransaction(transaction, workspaceId, providerId)) throw notFound();
      const result = await transaction.execute({ sql: "SELECT id, workspace_id, provider_id, name, enabled, priority, created_at, updated_at FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [workspaceId, providerId, credentialId] });
      const row = result.rows[0] as unknown as CredentialRow | undefined; if (!row) throw notFound("Provider credential");
      const name = input.name === undefined ? row.name : credentialName(input.name);
      const enabled = input.enabled === undefined ? Number(row.enabled) === 1 : validateEnabled(input.enabled);
      const now = Date.now();
      await transaction.batch([
        { sql: "UPDATE provider_credentials SET name = ?, normalized_name = ?, encrypted_secret = COALESCE(?, encrypted_secret), enabled = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [name, name.toLocaleLowerCase("en-US"), secret === undefined ? null : encryptSecret(secret, credentialId, workspaceId, providerId), enabled ? 1 : 0, now, workspaceId, providerId, credentialId] },
        touchProvider(workspaceId, providerId, now),
      ]);
      updated = { ...credentialFromRow(row), name, enabled, updatedAt: now };
    });
  } catch (error) { if (isUnique(error)) throw new ProviderError("Provider credential name is already in use.", 409); throw error; }
  if (!updated) throw notFound("Provider credential");
  return updated;
}

export async function deleteProviderCredential(workspaceId: string, providerId: string, credentialId: string): Promise<void> {
  if (!isProviderId(credentialId)) throw notFound("Provider credential");
  await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
    if (!await activeProviderInTransaction(transaction, workspaceId, providerId)) throw notFound();
    const now = Date.now();
    const result = await transaction.execute({ sql: "UPDATE provider_credentials SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [now, now, workspaceId, providerId, credentialId] });
    if (result.rowsAffected !== 1) throw notFound("Provider credential");
    await transaction.execute(touchProvider(workspaceId, providerId, now));
  });
}

export async function reorderProviderCredentials(workspaceId: string, providerId: string, orderedIds: unknown): Promise<void> {
  if (!Array.isArray(orderedIds) || !orderedIds.every(isProviderId)) throw new ProviderError("A complete ordered credential ID list is required.", 400);
  await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
    if (!await activeProviderInTransaction(transaction, workspaceId, providerId)) throw notFound();
    const current = await transaction.execute({ sql: "SELECT id FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND status = 'active' ORDER BY priority, id", args: [workspaceId, providerId] });
    const ids = current.rows.map((row) => String(row.id));
    const currentIds = new Set(ids);
    if (ids.length !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !currentIds.has(id))) throw new ProviderError("Provider credential order is out of date.", 409);
    const now = Date.now();
    await transaction.batch(orderedIds.map((id, priority) => ({ sql: "UPDATE provider_credentials SET priority = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [priority, now, workspaceId, providerId, id] })));
    await transaction.execute(touchProvider(workspaceId, providerId, now));
  });
}

export async function readProviderCredentialSecret(workspaceId: string, providerId: string, credentialId: string): Promise<string> {
  if (!isProviderId(credentialId)) throw notFound("Provider credential");
  const result = await db.execute({ sql: "SELECT id, workspace_id, provider_id, encrypted_secret FROM provider_credentials WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [workspaceId, providerId, credentialId] });
  const row = result.rows[0] as unknown as CredentialRow | undefined;
  if (!row?.encrypted_secret) throw notFound("Provider credential");
  return decryptSecret(row.encrypted_secret, String(row.id), String(row.workspace_id), String(row.provider_id));
}

function modelInput(input: { name: unknown; gatewaySuffix: unknown; upstreamModel: unknown; enabled?: unknown }, prefix: string) {
  const suffix = fieldText(input.gatewaySuffix, "Gateway model suffix", 128);
  if (!SUFFIX.test(suffix)) throw new ProviderError("Gateway model suffix is invalid.", 400);
  return { name: fieldText(input.name, "Model name", 120), gatewaySuffix: suffix, gatewayModelId: `${prefix}/${suffix}`, upstreamModel: fieldText(input.upstreamModel, "Upstream model ID", 256), enabled: input.enabled === undefined ? true : validateEnabled(input.enabled) };
}
export async function createProviderModel(workspaceId: string, providerId: string, input: { name: unknown; gatewaySuffix: unknown; upstreamModel: unknown; enabled?: unknown }): Promise<ProviderModel> {
  const id = randomUUID();
  const name = fieldText(input.name, "Model name", 120);
  const gatewaySuffix = fieldText(input.gatewaySuffix, "Gateway model suffix", 128);
  if (!SUFFIX.test(gatewaySuffix)) throw new ProviderError("Gateway model suffix is invalid.", 400);
  const upstreamModel = fieldText(input.upstreamModel, "Upstream model ID", 256);
  const enabled = input.enabled === undefined ? true : validateEnabled(input.enabled);
  let model: ReturnType<typeof modelInput> | undefined; let now = 0;
  try {
    await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
      const provider = await activeProviderInTransaction(transaction, workspaceId, providerId); if (!provider) throw notFound();
      model = modelInput({ name, gatewaySuffix, upstreamModel, enabled }, provider.prefix);
      now = Date.now();
      await transaction.batch([
        { sql: "INSERT INTO provider_models (id, workspace_id, provider_id, name, gateway_suffix, gateway_model_id, upstream_model, enabled, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)", args: [id, workspaceId, providerId, model.name, model.gatewaySuffix, model.gatewayModelId, model.upstreamModel, model.enabled ? 1 : 0, now, now] },
        touchProvider(workspaceId, providerId, now),
      ]);
    });
  } catch (error) { if (isUnique(error)) throw new ProviderError("Gateway model ID is already in use in this workspace.", 409); throw error; }
  if (!model) throw notFound("Provider model");
  return { id, workspaceId, providerId, ...model, createdAt: now, updatedAt: now };
}
export async function updateProviderModel(workspaceId: string, providerId: string, modelId: string, input: { name?: unknown; gatewaySuffix?: unknown; upstreamModel?: unknown; enabled?: unknown }): Promise<ProviderModel> {
  if (!isProviderId(modelId)) throw notFound("Provider model");
  if (!Object.keys(input).length) throw new ProviderError("Provider model update is required.", 400);
  let updated: ProviderModel | undefined;
  try {
    await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
      const provider = await activeProviderInTransaction(transaction, workspaceId, providerId); if (!provider) throw notFound();
      const result = await transaction.execute({ sql: "SELECT id, workspace_id, provider_id, name, gateway_suffix, gateway_model_id, upstream_model, enabled, created_at, updated_at FROM provider_models WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [workspaceId, providerId, modelId] });
      const existing = result.rows[0] as unknown as ModelRow | undefined; if (!existing) throw notFound("Provider model");
      const model = modelInput({ name: input.name === undefined ? existing.name : input.name, gatewaySuffix: input.gatewaySuffix === undefined ? existing.gateway_suffix : input.gatewaySuffix, upstreamModel: input.upstreamModel === undefined ? existing.upstream_model : input.upstreamModel, enabled: input.enabled === undefined ? Number(existing.enabled) === 1 : input.enabled }, provider.prefix);
      const now = Date.now();
      await transaction.batch([
        { sql: "UPDATE provider_models SET name = ?, gateway_suffix = ?, gateway_model_id = ?, upstream_model = ?, enabled = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [model.name, model.gatewaySuffix, model.gatewayModelId, model.upstreamModel, model.enabled ? 1 : 0, now, workspaceId, providerId, modelId] },
        touchProvider(workspaceId, providerId, now),
      ]);
      updated = { id: modelId, workspaceId, providerId, ...model, createdAt: Number(existing.created_at), updatedAt: now };
    });
  } catch (error) { if (isUnique(error)) throw new ProviderError("Gateway model ID is already in use in this workspace.", 409); throw error; }
  if (!updated) throw notFound("Provider model");
  return updated;
}
export async function deleteProviderModel(workspaceId: string, providerId: string, modelId: string): Promise<void> {
  if (!isProviderId(modelId)) throw notFound("Provider model");
  await inProviderWriteTransaction(workspaceId, providerId, async (transaction) => {
    if (!await activeProviderInTransaction(transaction, workspaceId, providerId)) throw notFound();
    const now = Date.now();
    const result = await transaction.execute({ sql: "UPDATE provider_models SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND id = ? AND status = 'active'", args: [now, now, workspaceId, providerId, modelId] });
    if (result.rowsAffected !== 1) throw notFound("Provider model");
    await transaction.execute(touchProvider(workspaceId, providerId, now));
  });
}

/** Idempotent workspace deletion extension. Active rows are removed but durable cleanup tombstones remain. */
export async function deleteProvidersForWorkspace(workspaceId: string): Promise<void> {
  await inWriteTransaction(async (transaction) => {
    const rows = await transaction.execute({ sql: "SELECT id, desired_revision FROM providers WHERE workspace_id = ? AND status = 'active'", args: [workspaceId] });
    const ownership = await transaction.execute({ sql: "SELECT provider_id, claude_fingerprints_json FROM provider_projection_ownership WHERE workspace_id = ?", args: [workspaceId] });
    const tombstones = await transaction.execute({ sql: "SELECT provider_id, claude_fingerprints_json FROM provider_projection_tombstones WHERE workspace_id = ?", args: [workspaceId] });
    const fingerprints = new Map(ownership.rows.map((row) => [String(row.provider_id), ownershipFingerprints(row.claude_fingerprints_json)]));
    const tombstoneFingerprints = new Map(tombstones.rows.map((row) => [String(row.provider_id), ownershipFingerprints(row.claude_fingerprints_json)]));
    const now = Date.now();
    await transaction.batch([
      ...rows.rows.map((row) => providerTombstone(workspaceId, String(row.id), Number(row.desired_revision) + 1, mergedOwnershipFingerprints(fingerprints.get(String(row.id)), tombstoneFingerprints.get(String(row.id))), now)),
      { sql: "DELETE FROM provider_sync_state WHERE workspace_id = ?", args: [workspaceId] },
      { sql: "DELETE FROM provider_projection_ownership WHERE workspace_id = ?", args: [workspaceId] },
      { sql: "DELETE FROM provider_credentials WHERE workspace_id = ?", args: [workspaceId] },
      { sql: "DELETE FROM provider_models WHERE workspace_id = ?", args: [workspaceId] },
      { sql: "DELETE FROM providers WHERE workspace_id = ?", args: [workspaceId] },
    ]);
  });
}
