import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { db } from "./db";
import type { Workspace } from "./workspaces";

const GATEWAY_KEY_SCHEMA_VERSION = 1;
const MASTER_KEY_FILE = "master-key";
const MASTER_KEY_DIRECTORY = "gateway-keys";
const MAX_NAME_LENGTH = 80;
const CUSTOM_VALUE_MIN_LENGTH = 32;
const CUSTOM_VALUE_MAX_LENGTH = 256;
const KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GatewayKeyFileOperations = Pick<
  typeof fs,
  "chmodSync" | "closeSync" | "existsSync" | "fsyncSync" | "linkSync" | "lstatSync" | "mkdirSync" | "openSync" | "readFileSync" | "unlinkSync" | "writeFileSync"
>;

type GatewayKeyStatus = "active" | "revoked" | "deleted";

type GatewayKeyRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: GatewayKeyStatus;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  deleted_at: number | null;
  encrypted_secret?: string;
};

export type GatewayKeyMetadata = {
  id: string;
  workspaceId: string;
  name: string;
  status: Exclude<GatewayKeyStatus, "deleted">;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
};

export type CreatedGatewayKey = {
  key: GatewayKeyMetadata;
  secret: string;
};

export type GatewayKeyAuthentication = {
  workspace: Workspace;
  key: GatewayKeyMetadata;
};

export class GatewayKeyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GatewayKeyError";
  }
}

let masterKey: Buffer | undefined;

function dataRoot(rawRouteDataDir = process.env.RAWROUTE_DATA_DIR): string {
  return path.resolve(rawRouteDataDir || path.join(homedir(), ".local/share/rawroute"));
}

export function gatewayKeyMasterPath(rawRouteDataDir = process.env.RAWROUTE_DATA_DIR): string {
  return path.join(dataRoot(rawRouteDataDir), MASTER_KEY_DIRECTORY, MASTER_KEY_FILE);
}

function ensurePrivateDirectory(directory: string, fileOperations: GatewayKeyFileOperations): void {
  fileOperations.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fileOperations.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Gateway key state directory is not a private directory.");
  }
  fileOperations.chmodSync(directory, 0o700);
}

function readPersistedMasterKey(filePath: string, fileOperations: GatewayKeyFileOperations): Buffer {
  const metadata = fileOperations.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Gateway key master key path is not a regular file.");
  }
  fileOperations.chmodSync(filePath, 0o600);
  const encoded = fileOperations.readFileSync(filePath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Gateway key master key is invalid.");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("Gateway key master key is invalid.");
  }
  return key;
}

async function ciphertextExists(): Promise<boolean> {
  const result = await db.execute("SELECT 1 FROM gateway_keys WHERE encrypted_secret <> '' LIMIT 1");
  return result.rows.length > 0;
}

/**
 * Loads the one-instance encryption key from RAWROUTE_DATA_DIR. A missing key
 * is fatal after any ciphertext has been persisted, rather than creating an
 * unreadable replacement key.
 */
export async function ensureGatewayKeyMaster(): Promise<void> {
  await ensureGatewayKeyMasterWithFileOperations(fs);
}

/**
 * The optional file-operation seam exists solely for deterministic failure
 * tests. Production callers use ensureGatewayKeyMaster/ensureGatewayKeySchema.
 */
export async function ensureGatewayKeyMasterWithFileOperations(
  fileOperations: GatewayKeyFileOperations,
): Promise<void> {
  if (masterKey) return;
  const filePath = gatewayKeyMasterPath();
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory, fileOperations);
  if (fileOperations.existsSync(filePath)) {
    masterKey = readPersistedMasterKey(filePath, fileOperations);
    return;
  }
  if (await ciphertextExists()) {
    throw new Error("Gateway key master key is missing while encrypted gateway keys exist.");
  }

  const candidate = randomBytes(32);
  const temporaryPath = path.join(directory, `.${MASTER_KEY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    // Write a private same-directory temporary file before publishing it. A
    // hard link is atomic and, unlike rename, never overwrites a concurrent
    // initializer's final key file.
    const descriptor = fileOperations.openSync(temporaryPath, "wx", 0o600);
    try {
      fileOperations.chmodSync(temporaryPath, 0o600);
      fileOperations.writeFileSync(descriptor, `${candidate.toString("base64url")}\n`, "utf8");
      fileOperations.fsyncSync(descriptor);
    } finally {
      fileOperations.closeSync(descriptor);
    }
    try {
      fileOperations.linkSync(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      masterKey = readPersistedMasterKey(filePath, fileOperations);
      return;
    }
    const directoryDescriptor = fileOperations.openSync(directory, "r");
    try {
      fileOperations.fsyncSync(directoryDescriptor);
    } finally {
      fileOperations.closeSync(directoryDescriptor);
    }
    masterKey = candidate;
  } catch (error) {
    // A failed cleanup can leave an unreferenced temporary file, but never a
    // substitute final key. If ciphertext appears before retry, the missing
    // final key remains fail-closed through ciphertextExists above.
    try {
      fileOperations.unlinkSync(temporaryPath);
    } catch {
      // Intentionally preserve the original failure and never repurpose temp files.
    }
    throw error;
  } finally {
    // link() leaves the temporary name behind on both the winning and losing
    // paths. Its removal is best effort only after a final key has been read or
    // durably published; a cleanup failure cannot turn it into a master key.
    try {
      fileOperations.unlinkSync(temporaryPath);
    } catch {
      // See the fail-closed note above.
    }
  }
}

function requireMasterKey(): Buffer {
  if (!masterKey) throw new Error("Gateway key master key has not been initialized.");
  return masterKey;
}

function aad(keyId: string, workspaceId: string): Buffer {
  return Buffer.from(`${keyId}\u0000${workspaceId}`, "utf8");
}

function encryptSecret(secret: string, keyId: string, workspaceId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireMasterKey(), iv);
  cipher.setAAD(aad(keyId, workspaceId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptSecret(payload: string, keyId: string, workspaceId: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Gateway key ciphertext is invalid.");
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16 || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]*$/.test(part))) {
      throw new Error("Gateway key ciphertext is invalid.");
    }
    const decipher = createDecipheriv("aes-256-gcm", requireMasterKey(), iv);
    decipher.setAAD(aad(keyId, workspaceId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message === "Gateway key ciphertext is invalid.") throw error;
    throw new Error("Gateway key ciphertext could not be authenticated.");
  }
}

function secretHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fromRow(row: GatewayKeyRow): GatewayKeyMetadata {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    status: row.status === "revoked" ? "revoked" : "active",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  };
}

function uniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique constraint|constraint failed/i.test(error.message);
}

function notFound(): GatewayKeyError {
  return new GatewayKeyError("Gateway key not found.", 404);
}

export function isGatewayKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

export function validateGatewayKeyName(input: unknown): string {
  if (typeof input !== "string") throw new GatewayKeyError("Gateway key name is required.", 400);
  const name = input.normalize("NFKC").trim();
  if (!name) throw new GatewayKeyError("Gateway key name is required.", 400);
  if (Array.from(name).length > MAX_NAME_LENGTH) {
    throw new GatewayKeyError(`Gateway key name must be ${MAX_NAME_LENGTH} characters or fewer.`, 400);
  }
  if (Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) {
    throw new GatewayKeyError("Gateway key name contains invalid characters.", 400);
  }
  return name;
}

export function validateGatewayKeyValue(input: unknown): string {
  if (input === undefined) return `rr_${randomBytes(32).toString("base64url")}`;
  if (typeof input !== "string") throw new GatewayKeyError("Gateway key value must be a string.", 400);
  // Whitespace-only custom input means "generate". Any nonblank input is kept
  // byte-for-byte/case-for-case and must therefore contain no whitespace.
  if (!input.trim()) return `rr_${randomBytes(32).toString("base64url")}`;
  if (
    input.length < CUSTOM_VALUE_MIN_LENGTH ||
    input.length > CUSTOM_VALUE_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/.test(input)
  ) {
    throw new GatewayKeyError(
      `Gateway key value must be ${CUSTOM_VALUE_MIN_LENGTH}-${CUSTOM_VALUE_MAX_LENGTH} printable ASCII characters without whitespace.`,
      400,
    );
  }
  return input;
}

export async function ensureGatewayKeySchema(fileOperations: GatewayKeyFileOperations = fs): Promise<void> {
  await db.batch([
    {
      sql: `
        CREATE TABLE IF NOT EXISTS gateway_key_schema_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        )
      `,
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS gateway_keys (
          id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          secret_hash TEXT NOT NULL UNIQUE,
          encrypted_secret TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          revoked_at INTEGER,
          deleted_at INTEGER
        )
      `,
    },
    {
      sql: "CREATE INDEX IF NOT EXISTS gateway_keys_workspace_status_idx ON gateway_keys(workspace_id, status, created_at DESC)",
    },
    {
      sql: `
        INSERT INTO gateway_key_schema_meta (id, version) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET version = MAX(version, excluded.version)
      `,
      args: [GATEWAY_KEY_SCHEMA_VERSION],
    },
  ], "write");
  await ensureGatewayKeyMasterWithFileOperations(fileOperations);
}

export async function listGatewayKeys(workspaceId: string): Promise<GatewayKeyMetadata[]> {
  const result = await db.execute({
    sql: `
      SELECT id, workspace_id, name, status, created_at, updated_at, revoked_at, deleted_at
      FROM gateway_keys
      WHERE workspace_id = ? AND status <> 'deleted'
      ORDER BY created_at DESC, id DESC
    `,
    args: [workspaceId],
  });
  return result.rows.map((row) => fromRow(row as unknown as GatewayKeyRow));
}

export async function createGatewayKey(
  workspaceId: string,
  nameInput: unknown,
  valueInput: unknown = undefined,
): Promise<CreatedGatewayKey> {
  const name = validateGatewayKeyName(nameInput);
  const customValue =
    valueInput === undefined || (typeof valueInput === "string" && !valueInput.trim())
      ? undefined
      : validateGatewayKeyValue(valueInput);
  for (let attempts = 0; attempts < 4; attempts++) {
    const secret = customValue ?? validateGatewayKeyValue(undefined);
    const id = randomUUID();
    const now = Date.now();
    try {
      await db.execute({
        sql: `
          INSERT INTO gateway_keys (
            id, workspace_id, name, secret_hash, encrypted_secret, status,
            created_at, updated_at, revoked_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)
        `,
        args: [id, workspaceId, name, secretHash(secret), encryptSecret(secret, id, workspaceId), now, now],
      });
      return {
        key: { id, workspaceId, name, status: "active", createdAt: now, updatedAt: now, revokedAt: null },
        secret,
      };
    } catch (error) {
      if (!uniqueConstraint(error)) throw error;
      if (customValue !== undefined || attempts === 3) {
        throw new GatewayKeyError("Gateway key value is already in use.", 409);
      }
    }
  }
  throw new GatewayKeyError("Gateway key could not be created.", 503);
}

export async function getGatewayKey(workspaceId: string, keyId: string): Promise<GatewayKeyMetadata | undefined> {
  if (!isGatewayKeyId(keyId)) return undefined;
  const result = await db.execute({
    sql: `
      SELECT id, workspace_id, name, status, created_at, updated_at, revoked_at, deleted_at
      FROM gateway_keys
      WHERE workspace_id = ? AND id = ? AND status <> 'deleted'
      LIMIT 1
    `,
    args: [workspaceId, keyId],
  });
  const row = result.rows[0] as unknown as GatewayKeyRow | undefined;
  return row ? fromRow(row) : undefined;
}

export async function updateGatewayKey(
  workspaceId: string,
  keyId: string,
  update: { name?: unknown; revoked?: unknown },
): Promise<GatewayKeyMetadata> {
  if (!isGatewayKeyId(keyId)) throw notFound();
  const name = update.name === undefined ? undefined : validateGatewayKeyName(update.name);
  if (update.revoked !== undefined && update.revoked !== true) {
    throw new GatewayKeyError("Gateway keys cannot be reactivated.", 400);
  }
  if (name === undefined && update.revoked !== true) {
    throw new GatewayKeyError("Gateway key update is required.", 400);
  }
  const now = Date.now();
  const assignments: string[] = ["updated_at = ?"];
  const args: (string | number)[] = [now];
  if (name !== undefined) {
    assignments.push("name = ?");
    args.push(name);
  }
  if (update.revoked === true) {
    assignments.push("status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END", "revoked_at = COALESCE(revoked_at, ?)");
    args.push(now);
  }
  args.push(workspaceId, keyId);
  const result = await db.execute({
    sql: `UPDATE gateway_keys SET ${assignments.join(", ")} WHERE workspace_id = ? AND id = ? AND status <> 'deleted'`,
    args,
  });
  if (result.rowsAffected !== 1) throw notFound();
  const key = await getGatewayKey(workspaceId, keyId);
  if (!key) throw notFound();
  return key;
}

/**
 * User-requested deletion is a durable tombstone: the encrypted value and hash
 * remain for audit/retry safety, but list, reveal, and authentication exclude it.
 * Workspace deletion separately purges all of its tombstones and active keys.
 */
export async function deleteGatewayKey(workspaceId: string, keyId: string): Promise<void> {
  if (!isGatewayKeyId(keyId)) throw notFound();
  const now = Date.now();
  const result = await db.execute({
    sql: `
      UPDATE gateway_keys
      SET status = 'deleted', updated_at = ?, revoked_at = COALESCE(revoked_at, ?), deleted_at = ?
      WHERE workspace_id = ? AND id = ? AND status <> 'deleted'
    `,
    args: [now, now, now, workspaceId, keyId],
  });
  if (result.rowsAffected !== 1) throw notFound();
}

export async function revealGatewayKey(workspaceId: string, keyId: string): Promise<string> {
  if (!isGatewayKeyId(keyId)) throw notFound();
  const result = await db.execute({
    sql: `
      SELECT id, workspace_id, name, status, created_at, updated_at, revoked_at, deleted_at, encrypted_secret
      FROM gateway_keys
      WHERE workspace_id = ? AND id = ? AND status <> 'deleted'
      LIMIT 1
    `,
    args: [workspaceId, keyId],
  });
  const row = result.rows[0] as unknown as GatewayKeyRow | undefined;
  if (!row?.encrypted_secret) throw notFound();
  return decryptSecret(String(row.encrypted_secret), String(row.id), String(row.workspace_id));
}

/** Direct database lookup for a future gateway cutover. It never returns a secret or hash. */
export async function authenticateGatewayKey(value: unknown): Promise<GatewayKeyAuthentication | undefined> {
  if (typeof value !== "string" || !value) return undefined;
  const result = await db.execute({
    sql: `
      SELECT
        keys.id AS key_id, keys.workspace_id AS key_workspace_id, keys.name AS key_name,
        keys.status AS key_status, keys.created_at AS key_created_at,
        keys.updated_at AS key_updated_at, keys.revoked_at AS key_revoked_at,
        workspaces.id AS workspace_id, workspaces.name AS workspace_name,
        workspaces.is_default AS workspace_is_default, workspaces.status AS workspace_status,
        workspaces.created_at AS workspace_created_at, workspaces.updated_at AS workspace_updated_at
      FROM gateway_keys AS keys
      JOIN workspaces ON workspaces.id = keys.workspace_id
      WHERE keys.secret_hash = ? AND keys.status = 'active' AND workspaces.status = 'active'
      LIMIT 1
    `,
    args: [secretHash(value)],
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    workspace: {
      id: String(row.workspace_id),
      name: String(row.workspace_name),
      isDefault: Number(row.workspace_is_default) === 1,
      status: "active",
      createdAt: Number(row.workspace_created_at),
      updatedAt: Number(row.workspace_updated_at),
    },
    key: {
      id: String(row.key_id),
      workspaceId: String(row.key_workspace_id),
      name: String(row.key_name),
      status: "active",
      createdAt: Number(row.key_created_at),
      updatedAt: Number(row.key_updated_at),
      revokedAt: row.key_revoked_at === null || row.key_revoked_at === undefined ? null : Number(row.key_revoked_at),
    },
  };
}

/** Idempotent workspace-deletion extension; no ambient/default workspace is used. */
export async function deleteGatewayKeysForWorkspace(workspaceId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM gateway_keys WHERE workspace_id = ?", args: [workspaceId] });
}
