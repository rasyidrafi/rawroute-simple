import { createHash } from "node:crypto";
import {
  cliproxyManagement,
  cliproxyManagementJson,
  withCliproxyManagementLock,
} from "./cliproxy";
import { db } from "./db";
import {
  getProviderProjectionSnapshot,
  type ProviderProjectionSnapshot,
} from "./providers";
import { admitWorkspaceWrite } from "./workspaces";

type RemoteEntry = Record<string, unknown>;
export type ProviderSyncState =
  | "pending"
  | "applied"
  | "error"
  | "native-execution-pending"
  | "cleanup-pending"
  | "cleanup-error"
  | "cleaned";
export type ProviderSyncStatus = {
  providerId: string;
  desiredRevision: number;
  appliedRevision: number | null;
  state: ProviderSyncState;
  error: string | null;
  updatedAt: number;
  deleted: boolean;
};
type Projection = {
  workspaceId: string;
  providerId: string;
  revision: number;
  namespace: string;
  namePrefix: string;
  state: "applied" | "native-execution-pending";
  openai: RemoteEntry[];
  claude: RemoteEntry[];
};
type Tombstone = {
  workspace_id: string;
  provider_id: string;
  namespace: string;
  name_prefix: string;
  desired_revision: number;
  claude_fingerprints_json: string;
  state: "cleanup-pending" | "cleanup-error";
  last_error: string | null;
  updated_at: number;
};
type SyncSlot = {
  requestedRevision: number;
  promise: Promise<ProviderSyncStatus>;
};

const inFlight = new Map<string, SyncSlot>();
const pendingScans = new Set<Promise<void>>();
let accepting = true;
let databaseWrites: Promise<void> = Promise.resolve();
let projectionWrites: Promise<void> = Promise.resolve();

class SyncFailure extends Error {}

async function withDatabaseWrite<T>(operation: () => Promise<T>): Promise<T> {
  const previous = databaseWrites;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  databaseWrites = current;
  await previous.catch(() => undefined);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (
          (error as { code?: unknown }).code !== "SQLITE_BUSY" ||
          attempt === 7
        )
          throw error;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(32, 2 ** attempt)),
        );
      }
    }
  } finally {
    release();
  }
}
async function queueProjectionWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectionWrites;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectionWrites = current;
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function digest(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
export function providerManagedNamespace(
  workspaceId: string,
  providerId: string,
): string {
  return `rr-ws-${digest(`workspace:${workspaceId}`, 16)}-p-${digest(`provider:${providerId}`, 12)}`;
}
export function providerManagedNamePrefix(
  workspaceId: string,
  providerId: string,
): string {
  return `rr-managed-${digest(`workspace:${workspaceId}`, 16)}-${digest(`provider:${providerId}`, 12)}-`;
}
function managedName(
  workspaceId: string,
  providerId: string,
  credentialId: string,
): string {
  return `${providerManagedNamePrefix(workspaceId, providerId)}${digest(`credential:${credentialId}`, 16)}`;
}
function safeError(error: unknown): string {
  return error instanceof SyncFailure
    ? error.message.slice(0, 240)
    : "CLIProxy management is unavailable.";
}
function entries(value: unknown, key: string): RemoteEntry[] {
  const candidate =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  if (
    !Array.isArray(candidate) ||
    !candidate.every(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    )
  )
    throw new SyncFailure(
      "CLIProxy management returned an invalid configuration.",
    );
  return candidate as RemoteEntry[];
}
function stableOpenai(entries: RemoteEntry[]): string {
  // auth-index is endpoint runtime state. Nested model fields, including name,
  // are user configuration and must remain significant.
  return JSON.stringify(
    entries.map(({ "auth-index": _authIndex, ...entry }) => entry),
  );
}
function normalizedHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const output: Record<string, string> = {};
  for (const name of Object.keys(value as Record<string, unknown>).sort(
    (left, right) => left.localeCompare(right),
  )) {
    const header = (value as Record<string, unknown>)[name];
    if (typeof header !== "string") continue;
    const normalized = header.trim();
    if (normalized) output[name] = normalized;
  }
  return Object.keys(output).length ? output : undefined;
}
function normalizedClaudeEntry(entry: RemoteEntry): RemoteEntry {
  const {
    "auth-index": _authIndex,
    name: _name,
    "proxy-url": proxyUrl,
    headers,
    ...rest
  } = entry;
  const normalizedProxyUrl =
    typeof proxyUrl === "string" ? proxyUrl.trim() : undefined;
  const normalized = normalizedHeaders(headers);
  return {
    ...rest,
    ...(normalizedProxyUrl ? { "proxy-url": normalizedProxyUrl } : {}),
    ...(normalized ? { headers: normalized } : {}),
  };
}
function stableClaude(entries: RemoteEntry[]): string {
  // CLIProxy's Claude endpoint omits top-level name and synthesizes these two
  // runtime/default fields. It does not own nested model fields.
  return JSON.stringify(entries.map(normalizedClaudeEntry));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}
function claudeFingerprint(entry: RemoteEntry): string {
  return digest(JSON.stringify(canonical(normalizedClaudeEntry(entry))));
}
function parseFingerprints(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item),
      )
    )
      return new Set(parsed);
  } catch {
    /* invalid persisted proof is never trusted */
  }
  return new Set();
}
function fingerprintsJson(fingerprints: Iterable<string>): string {
  return JSON.stringify([...new Set(fingerprints)].sort());
}
function sameFingerprints(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size &&
    [...left].every((fingerprint) => right.has(fingerprint))
  );
}
function entryPrefix(entry: RemoteEntry): string {
  return typeof entry.prefix === "string" ? entry.prefix : "";
}
function entryName(entry: RemoteEntry): string {
  return typeof entry.name === "string" ? entry.name : "";
}
function isManagedOpenai(
  entry: RemoteEntry,
  namespace: string,
  namePrefix: string,
): boolean {
  return (
    entryPrefix(entry) === namespace && entryName(entry).startsWith(namePrefix)
  );
}
function isOwnedClaude(
  entry: RemoteEntry,
  namespace: string,
  fingerprints: Set<string>,
): boolean {
  return (
    entryPrefix(entry) === namespace &&
    fingerprints.has(claudeFingerprint(entry))
  );
}
function cleanHeaders(
  headers: Record<string, string>,
): Record<string, string> | undefined {
  return normalizedHeaders(headers);
}
function projection(snapshot: ProviderProjectionSnapshot): Projection {
  const { provider, credentials, models } = snapshot;
  const namespace = providerManagedNamespace(provider.workspaceId, provider.id);
  const namePrefix = providerManagedNamePrefix(
    provider.workspaceId,
    provider.id,
  );
  const enabledModels = provider.enabled
    ? models
        .filter((model) => model.enabled)
        .map((model) => ({
          name: model.upstreamModel,
          alias: model.gatewaySuffix,
          "force-mapping": true,
        }))
    : [];
  const keys = credentials
    .filter((credential) => credential.enabled && credential.secret.trim())
    .sort(
      (left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id),
    );
  const headers = cleanHeaders(provider.headers);
  const base = {
    prefix: namespace,
    "base-url": provider.baseUrl,
    models: enabledModels,
    ...(headers ? { headers } : {}),
  };
  if (provider.protocol === "openai-responses")
    return {
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      revision: provider.desiredRevision,
      namespace,
      namePrefix,
      state: "native-execution-pending",
      openai: [],
      claude: [],
    };
  if (!provider.enabled || !enabledModels.length)
    return {
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      revision: provider.desiredRevision,
      namespace,
      namePrefix,
      state: "applied",
      openai: [],
      claude: [],
    };
  if (provider.authType === "none") {
    if (keys.length)
      throw new SyncFailure(
        "An anonymous provider cannot have enabled credentials.",
      );
    return {
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      revision: provider.desiredRevision,
      namespace,
      namePrefix,
      state: "applied",
      openai: [
        {
          name: managedName(provider.workspaceId, provider.id, "anonymous"),
          disabled: false,
          ...base,
        },
      ],
      claude: [],
    };
  }
  if (!keys.length)
    return {
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      revision: provider.desiredRevision,
      namespace,
      namePrefix,
      state: "applied",
      openai: [],
      claude: [],
    };
  if (provider.protocol === "openai-chat")
    return {
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      revision: provider.desiredRevision,
      namespace,
      namePrefix,
      state: "applied",
      openai: keys.map((credential, index) => ({
        name: managedName(provider.workspaceId, provider.id, credential.id),
        ...(keys.length - index - 1
          ? { priority: keys.length - index - 1 }
          : {}),
        disabled: false,
        ...base,
        "api-key-entries": [{ "api-key": credential.secret }],
      })),
      claude: [],
    };
  // CLIProxy's Claude endpoint retains a trimmed API key. Match that schema
  // before write-ahead fingerprinting; blank normalization is excluded above.
  return {
    workspaceId: provider.workspaceId,
    providerId: provider.id,
    revision: provider.desiredRevision,
    namespace,
    namePrefix,
    state: "applied",
    openai: [],
    claude: keys.map((credential, index) => ({
      name: managedName(provider.workspaceId, provider.id, credential.id),
      ...(keys.length - index - 1 ? { priority: keys.length - index - 1 } : {}),
      ...base,
      "api-key": credential.secret.trim(),
    })),
  };
}

async function readRemote(): Promise<{
  openai: RemoteEntry[];
  claude: RemoteEntry[];
}> {
  const [openai, claude] = await Promise.all([
    cliproxyManagementJson<{ "openai-compatibility"?: unknown }>(
      "/v0/management/openai-compatibility",
    ),
    cliproxyManagementJson<{ "claude-api-key"?: unknown }>(
      "/v0/management/claude-api-key",
    ),
  ]);
  if (!openai.response.ok || !claude.response.ok)
    throw new SyncFailure("CLIProxy management configuration is unavailable.");
  return {
    openai: entries(openai.data, "openai-compatibility"),
    claude: entries(claude.data, "claude-api-key"),
  };
}
async function put(path: string, value: unknown): Promise<void> {
  const response = await cliproxyManagement(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok)
    throw new SyncFailure("CLIProxy management configuration update failed.");
}
async function ensureFillFirst(): Promise<void> {
  const current = await cliproxyManagementJson<{ strategy?: unknown }>(
    "/v0/management/routing/strategy",
  );
  if (!current.response.ok || typeof current.data?.strategy !== "string")
    throw new SyncFailure("CLIProxy routing strategy is unavailable.");
  if (current.data.strategy !== "fill-first")
    await put("/v0/management/routing/strategy", { value: "fill-first" });
}
async function ownership(
  workspaceId: string,
  providerId: string,
): Promise<Set<string>> {
  const result = await db.execute({
    sql: "SELECT claude_fingerprints_json FROM provider_projection_ownership WHERE workspace_id = ? AND provider_id = ?",
    args: [workspaceId, providerId],
  });
  return parseFingerprints(result.rows[0]?.claude_fingerprints_json);
}
async function apply(
  projectionValue: Projection,
  priorOwnedClaude: Set<string>,
  intendedClaude: Set<string>,
  persistIntent: (fingerprints: Set<string>) => Promise<void>,
): Promise<Set<string>> {
  return await withCliproxyManagementLock(async () => {
    const current = await readRemote();
    // Only durable proof from an earlier attempt can authorize an existing
    // entry. A newly-derived desired fingerprint must never adopt operator data.
    const collision =
      current.openai.some(
        (entry) =>
          entryPrefix(entry) === projectionValue.namespace &&
          !isManagedOpenai(
            entry,
            projectionValue.namespace,
            projectionValue.namePrefix,
          ),
      ) ||
      current.claude.some(
        (entry) =>
          entryPrefix(entry) === projectionValue.namespace &&
          !isOwnedClaude(entry, projectionValue.namespace, priorOwnedClaude),
      );
    if (collision)
      throw new SyncFailure(
        "CLIProxy managed namespace is already used by unmanaged configuration.",
      );
    // This write is inside the same lifecycle lock and immediately precedes
    // effects, covering crash/timeout ambiguity without widening ownership.
    await persistIntent(new Set([...priorOwnedClaude, ...intendedClaude]));
    const nextOpenai = [
      ...current.openai.filter(
        (entry) =>
          !isManagedOpenai(
            entry,
            projectionValue.namespace,
            projectionValue.namePrefix,
          ),
      ),
      ...projectionValue.openai,
    ];
    const nextClaude = [
      ...current.claude.filter(
        (entry) =>
          !isOwnedClaude(entry, projectionValue.namespace, priorOwnedClaude),
      ),
      ...projectionValue.claude,
    ];
    if (stableOpenai(current.openai) !== stableOpenai(nextOpenai))
      await put("/v0/management/openai-compatibility", nextOpenai);
    if (stableClaude(current.claude) !== stableClaude(nextClaude))
      await put("/v0/management/claude-api-key", nextClaude);
    await ensureFillFirst();
    const confirmed = await readRemote();
    const namespaceEntries = confirmed.claude.filter(
      (entry) => entryPrefix(entry) === projectionValue.namespace,
    );
    if (namespaceEntries.length !== projectionValue.claude.length)
      throw new SyncFailure(
        "CLIProxy did not retain the managed Anthropic configuration.",
      );
    return new Set(namespaceEntries.map(claudeFingerprint));
  });
}
async function applyWithBoundedRetry(
  projectionValue: Projection,
  initialOwnedClaude: Set<string>,
  intendedClaude: Set<string>,
  reloadOwnership: () => Promise<Set<string>>,
  persistIntent: (fingerprints: Set<string>) => Promise<void>,
): Promise<Set<string>> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A successful write-ahead intent from an earlier attempt is durable proof
    // for its own remote PUT, but never for the first collision check.
    const priorOwnedClaude =
      attempt === 0 ? initialOwnedClaude : await reloadOwnership();
    try {
      return await apply(
        projectionValue,
        priorOwnedClaude,
        intendedClaude,
        persistIntent,
      );
    } catch (error) {
      failure = error;
      if (error instanceof SyncFailure && error.message.includes("namespace"))
        break;
      if (attempt === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw failure;
}
async function saveOwnership(
  workspaceId: string,
  providerId: string,
  fingerprints: Set<string>,
): Promise<void> {
  await withDatabaseWrite(async () => {
    const encoded = fingerprintsJson(fingerprints);
    // The caller holds workspace admission. Once deletion starts it drains that
    // admission before copying this proof to a tombstone, so `deleting` must not
    // discard an admitted write-ahead intent.
    const live = await db.execute({
      sql: "SELECT 1 FROM providers WHERE workspace_id = ? AND id = ? AND status = 'active'",
      args: [workspaceId, providerId],
    });
    if (live.rows.length) {
      await db.execute({
        sql: "INSERT INTO provider_projection_ownership (workspace_id, provider_id, claude_fingerprints_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, provider_id) DO UPDATE SET claude_fingerprints_json = excluded.claude_fingerprints_json, updated_at = excluded.updated_at",
        args: [workspaceId, providerId, encoded, Date.now()],
      });
      return;
    }
    // A direct repository deletion can race an old apply outside workspace
    // admission. Preserve proof on its durable tombstone, never a live state row.
    await db.execute({
      sql: "UPDATE provider_projection_tombstones SET claude_fingerprints_json = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ?",
      args: [encoded, Date.now(), workspaceId, providerId],
    });
  });
}
async function saveState(
  workspaceId: string,
  providerId: string,
  revision: number,
  state: Exclude<
    ProviderSyncState,
    "cleanup-pending" | "cleanup-error" | "cleaned"
  >,
  error: string | null,
): Promise<boolean> {
  return await withDatabaseWrite(async () => {
    const live = await db.execute({
      sql: "SELECT 1 FROM providers WHERE workspace_id = ? AND id = ? AND status = 'active'",
      args: [workspaceId, providerId],
    });
    if (!live.rows.length) return false;
    const applied = state === "applied" ? revision : null;
    await db.execute({
      sql: `INSERT INTO provider_sync_state (workspace_id, provider_id, desired_revision, applied_revision, state, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, provider_id) DO UPDATE SET desired_revision = excluded.desired_revision, applied_revision = excluded.applied_revision, state = excluded.state, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      args: [
        workspaceId,
        providerId,
        revision,
        applied,
        state,
        error,
        Date.now(),
      ],
    });
    return true;
  });
}

export async function ensureProviderSyncSchema(): Promise<void> {
  /* provider schema owns durable sync tables */
}
export async function getProviderSyncStatus(
  workspaceId: string,
  providerId: string,
): Promise<ProviderSyncStatus | undefined> {
  const provider = await db.execute({
    sql: "SELECT desired_revision, applied_revision FROM providers WHERE workspace_id = ? AND id = ? AND status = 'active'",
    args: [workspaceId, providerId],
  });
  if (provider.rows[0]) {
    const state = await db.execute({
      sql: "SELECT desired_revision, state, last_error, updated_at FROM provider_sync_state WHERE workspace_id = ? AND provider_id = ?",
      args: [workspaceId, providerId],
    });
    const row = state.rows[0] as Record<string, unknown> | undefined;
    const desiredRevision = Number(provider.rows[0].desired_revision);
    const appliedRevision =
      provider.rows[0].applied_revision === null
        ? null
        : Number(provider.rows[0].applied_revision);
    if (!row || Number(row.desired_revision) !== desiredRevision)
      return {
        providerId,
        desiredRevision,
        appliedRevision,
        state: "pending",
        error: null,
        updatedAt: row ? Number(row.updated_at) : 0,
        deleted: false,
      };
    return {
      providerId,
      desiredRevision,
      appliedRevision,
      state: String(row.state) as ProviderSyncState,
      error: row.last_error === null ? null : String(row.last_error),
      updatedAt: Number(row.updated_at),
      deleted: false,
    };
  }
  const tombstone = await db.execute({
    sql: "SELECT desired_revision, state, last_error, updated_at FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ?",
    args: [workspaceId, providerId],
  });
  const row = tombstone.rows[0] as Record<string, unknown> | undefined;
  return row
    ? {
        providerId,
        desiredRevision: Number(row.desired_revision),
        appliedRevision: null,
        state: String(row.state) as ProviderSyncState,
        error: row.last_error === null ? null : String(row.last_error),
        updatedAt: Number(row.updated_at),
        deleted: true,
      }
    : undefined;
}
/** Durable cleanup status for deleted providers in one active workspace. */
export async function listProviderCleanupStatuses(
  workspaceId: string,
): Promise<ProviderSyncStatus[]> {
  const tombstones = await db.execute({
    sql: "SELECT provider_id, desired_revision, state, last_error, updated_at FROM provider_projection_tombstones WHERE workspace_id = ? ORDER BY updated_at DESC, provider_id",
    args: [workspaceId],
  });
  return tombstones.rows.map((row) => {
    const value = row as Record<string, unknown>;
    return {
      providerId: String(value.provider_id),
      desiredRevision: Number(value.desired_revision),
      appliedRevision: null,
      state: String(value.state) as ProviderSyncState,
      error: value.last_error === null ? null : String(value.last_error),
      updatedAt: Number(value.updated_at),
      deleted: true,
    };
  });
}
async function activeRevision(
  workspaceId: string,
  providerId: string,
): Promise<number | undefined> {
  const result = await db.execute({
    sql: "SELECT desired_revision FROM providers WHERE workspace_id = ? AND id = ? AND status = 'active'",
    args: [workspaceId, providerId],
  });
  return result.rows[0] ? Number(result.rows[0].desired_revision) : undefined;
}
function unavailableStatus(
  workspaceId: string,
  providerId: string,
): Promise<ProviderSyncStatus> {
  return getProviderSyncStatus(workspaceId, providerId).then((status) =>
    status
      ? {
          ...status,
          state: "pending",
          error: "Workspace is unavailable.",
          deleted: false,
        }
      : {
          providerId,
          desiredRevision: 0,
          appliedRevision: null,
          state: "pending",
          error: "Workspace is unavailable.",
          updatedAt: Date.now(),
          deleted: false,
        },
  );
}
async function reconcileOne(
  workspaceId: string,
  providerId: string,
): Promise<{
  status: ProviderSyncStatus;
  attemptedRevision: number;
  terminal: boolean;
}> {
  const admission = await admitWorkspaceWrite(workspaceId);
  if (!admission)
    return {
      status: await unavailableStatus(workspaceId, providerId),
      attemptedRevision: (await activeRevision(workspaceId, providerId)) ?? 0,
      terminal: true,
    };
  try {
    const snapshot = await getProviderProjectionSnapshot(
      workspaceId,
      providerId,
    );
    if (!snapshot)
      return {
        status: (await getProviderSyncStatus(workspaceId, providerId)) ?? {
          providerId,
          desiredRevision: 0,
          appliedRevision: null,
          state: "cleaned",
          error: null,
          updatedAt: Date.now(),
          deleted: true,
        },
        attemptedRevision: 0,
        terminal: true,
      };
    const attemptedRevision = snapshot.provider.desiredRevision;
    try {
      const desired = projection(snapshot);
      const previousOwnership = await ownership(workspaceId, providerId);
      const intendedOwnership = new Set(desired.claude.map(claudeFingerprint));
      const fingerprints = await applyWithBoundedRetry(
        desired,
        previousOwnership,
        intendedOwnership,
        async () => await ownership(workspaceId, providerId),
        async (intent) => await saveOwnership(workspaceId, providerId, intent),
      );
      if (!sameFingerprints(fingerprints, intendedOwnership))
        throw new SyncFailure(
          "CLIProxy did not retain the managed Anthropic configuration.",
        );
      await saveOwnership(workspaceId, providerId, fingerprints);
      const current =
        desired.state === "native-execution-pending"
          ? { rowsAffected: 1 }
          : await withDatabaseWrite(
              async () =>
                await db.execute({
                  sql: "UPDATE providers SET applied_revision = ? WHERE workspace_id = ? AND id = ? AND status = 'active' AND desired_revision = ?",
                  args: [
                    desired.revision,
                    workspaceId,
                    providerId,
                    desired.revision,
                  ],
                }),
            );
      if (current.rowsAffected === 1)
        await saveState(
          workspaceId,
          providerId,
          desired.revision,
          desired.state,
          null,
        );
    } catch (error) {
      await saveState(
        workspaceId,
        providerId,
        attemptedRevision,
        "error",
        safeError(error),
      );
    }
    return {
      status:
        (await getProviderSyncStatus(workspaceId, providerId)) ??
        (await unavailableStatus(workspaceId, providerId)),
      attemptedRevision,
      terminal: false,
    };
  } finally {
    admission.release();
  }
}
async function reconcileDrain(
  workspaceId: string,
  providerId: string,
  slot: SyncSlot,
): Promise<ProviderSyncStatus> {
  for (;;) {
    const result = await reconcileOne(workspaceId, providerId);
    if (result.terminal || slot.requestedRevision <= result.attemptedRevision)
      return result.status;
  }
}
export async function reconcileProvider(
  workspaceId: string,
  providerId: string,
): Promise<ProviderSyncStatus> {
  if (!accepting)
    return (
      (await getProviderSyncStatus(workspaceId, providerId)) ?? {
        providerId,
        desiredRevision: 0,
        appliedRevision: null,
        state: "pending",
        error: "CLIProxy reconciliation is shutting down.",
        updatedAt: Date.now(),
        deleted: false,
      }
    );
  const revision = await activeRevision(workspaceId, providerId);
  if (revision === undefined)
    return await reconcileDeletedProvider(workspaceId, providerId);
  const key = `${workspaceId}\u0000${providerId}`;
  const existing = inFlight.get(key);
  if (existing) {
    existing.requestedRevision = Math.max(existing.requestedRevision, revision);
    return await existing.promise;
  }
  const slot = {
    requestedRevision: revision,
    promise: Promise.resolve<ProviderSyncStatus>({
      providerId,
      desiredRevision: revision,
      appliedRevision: null,
      state: "pending",
      error: null,
      updatedAt: 0,
      deleted: false,
    }),
  };
  const task = queueProjectionWrite(
    async () => await reconcileDrain(workspaceId, providerId, slot),
  ).finally(() => {
    if (inFlight.get(key)?.promise === task) inFlight.delete(key);
  });
  slot.promise = task;
  inFlight.set(key, slot);
  return await task;
}

function tombstoneStatus(
  tombstone: Tombstone,
  state: ProviderSyncState = tombstone.state,
  error: string | null = tombstone.last_error,
): ProviderSyncStatus {
  return {
    providerId: tombstone.provider_id,
    desiredRevision: Number(tombstone.desired_revision),
    appliedRevision: null,
    state,
    error,
    updatedAt: Number(tombstone.updated_at),
    deleted: true,
  };
}
async function cleanupOne(tombstone: Tombstone): Promise<ProviderSyncStatus> {
  try {
    await withCliproxyManagementLock(async () => {
      const fingerprints = parseFingerprints(
        tombstone.claude_fingerprints_json,
      );
      const current = await readRemote();
      const foreignClaude = current.claude.some(
        (entry) =>
          entryPrefix(entry) === tombstone.namespace &&
          !isOwnedClaude(entry, tombstone.namespace, fingerprints),
      );
      if (foreignClaude)
        throw new SyncFailure(
          "CLIProxy cleanup ownership could not be verified.",
        );
      const openai = current.openai.filter(
        (entry) =>
          !isManagedOpenai(entry, tombstone.namespace, tombstone.name_prefix),
      );
      const claude = current.claude.filter(
        (entry) => !isOwnedClaude(entry, tombstone.namespace, fingerprints),
      );
      if (stableOpenai(openai) !== stableOpenai(current.openai))
        await put("/v0/management/openai-compatibility", openai);
      if (stableClaude(claude) !== stableClaude(current.claude))
        await put("/v0/management/claude-api-key", claude);
      const confirmed = await readRemote();
      if (
        confirmed.openai.some((entry) =>
          isManagedOpenai(entry, tombstone.namespace, tombstone.name_prefix),
        ) ||
        confirmed.claude.some(
          (entry) => entryPrefix(entry) === tombstone.namespace,
        )
      )
        throw new SyncFailure("CLIProxy cleanup could not be verified.");
    });
    const deleted = await withDatabaseWrite(
      async () =>
        await db.execute({
          sql: "DELETE FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ? AND desired_revision = ?",
          args: [
            tombstone.workspace_id,
            tombstone.provider_id,
            tombstone.desired_revision,
          ],
        }),
    );
    if (deleted.rowsAffected === 1)
      return tombstoneStatus(tombstone, "cleaned", null);
    return (
      (await getProviderSyncStatus(
        tombstone.workspace_id,
        tombstone.provider_id,
      )) ?? tombstoneStatus(tombstone, "cleanup-pending", null)
    );
  } catch (error) {
    const message = safeError(error);
    await withDatabaseWrite(
      async () =>
        await db.execute({
          sql: "UPDATE provider_projection_tombstones SET state = 'cleanup-error', last_error = ?, updated_at = ? WHERE workspace_id = ? AND provider_id = ? AND desired_revision = ?",
          args: [
            message,
            Date.now(),
            tombstone.workspace_id,
            tombstone.provider_id,
            tombstone.desired_revision,
          ],
        }),
    );
    return {
      ...tombstoneStatus(tombstone, "cleanup-error", message),
      updatedAt: Date.now(),
    };
  }
}
async function cleanup(tombstone: Tombstone): Promise<ProviderSyncStatus> {
  return await queueProjectionWrite(async () => await cleanupOne(tombstone));
}
export async function reconcileDeletedProvider(
  workspaceId: string,
  providerId: string,
): Promise<ProviderSyncStatus> {
  const result = await db.execute({
    sql: "SELECT workspace_id, provider_id, namespace, name_prefix, desired_revision, claude_fingerprints_json, state, last_error, updated_at FROM provider_projection_tombstones WHERE workspace_id = ? AND provider_id = ?",
    args: [workspaceId, providerId],
  });
  const tombstone = result.rows[0] as unknown as Tombstone | undefined;
  return tombstone
    ? await cleanup(tombstone)
    : {
        providerId,
        desiredRevision: 0,
        appliedRevision: null,
        state: "cleaned",
        error: null,
        updatedAt: Date.now(),
        deleted: true,
      };
}

/** Tombstones carry their own persisted ownership proof; live jobs acquire workspace admission. */
async function reconcilePendingProviderProjectionsWork(): Promise<void> {
  const tombstones = await db.execute(
    "SELECT workspace_id, provider_id, namespace, name_prefix, desired_revision, claude_fingerprints_json, state, last_error, updated_at FROM provider_projection_tombstones ORDER BY updated_at, workspace_id, provider_id",
  );
  for (const row of tombstones.rows) await cleanup(row as unknown as Tombstone);
  if (!accepting) return;
  const providers = await db.execute(
    "SELECT p.workspace_id, p.id FROM providers p JOIN workspaces w ON w.id = p.workspace_id AND w.status = 'active' WHERE p.status = 'active' ORDER BY p.workspace_id, p.id",
  );
  for (const row of providers.rows)
    await reconcileProvider(String(row.workspace_id), String(row.id));
}
export function reconcilePendingProviderProjections(): Promise<void> {
  const work = reconcilePendingProviderProjectionsWork();
  pendingScans.add(work);
  void work.then(
    () => pendingScans.delete(work),
    () => pendingScans.delete(work),
  );
  return work;
}
export async function beginProviderSyncShutdown(): Promise<void> {
  accepting = false;
  await Promise.allSettled([...inFlight.values()].map((slot) => slot.promise));
  await Promise.allSettled(pendingScans);
  await projectionWrites.catch(() => undefined);
}
export function startProviderSync(): void {
  accepting = true;
}
