import { db } from "./db";

export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_WORKSPACE_NAME = "Default";

const WORKSPACE_SCHEMA_VERSION = 1;
const MAX_WORKSPACE_NAME_LENGTH = 80;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type WorkspaceStatus = "active" | "deleting";

export type Workspace = {
  id: string;
  name: string;
  isDefault: boolean;
  status: WorkspaceStatus;
  createdAt: number;
  updatedAt: number;
};

type WorkspaceRow = {
  id: string;
  name: string;
  is_default: number;
  status: WorkspaceStatus;
  created_at: number;
  updated_at: number;
};

export class WorkspaceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Future resource stores register independent, idempotent cleanup before using
 * workspace_id foreign keys. A failed cleanup restores the workspace to active
 * so a later delete can safely retry the whole cleanup sequence.
 */
export type WorkspaceDeletionExtension = {
  name: string;
  deleteWorkspaceData: (workspaceId: string) => void | Promise<void>;
};

const deletionExtensions = new Map<string, WorkspaceDeletionExtension>();

type WorkspaceWriteSlot = {
  deleting: boolean;
  inFlight: number;
  drained?: () => void;
};

/**
 * Process-local admission for in-memory workspace resources. A deletion marks
 * its slot before cleanup and waits for admitted writes, so cleanup is the last
 * owner of the resource. Slots disappear once idle; this is not an unbounded
 * tombstone map.
 */
const workspaceWriteSlots = new Map<string, WorkspaceWriteSlot>();

export type WorkspaceWriteAdmission = { release: () => void };

export async function admitWorkspaceWrite(workspaceId: string): Promise<WorkspaceWriteAdmission | undefined> {
  // Reserve before the validation read. Deletion marks this same slot and waits
  // for it, preventing a read that started while active from writing after
  // cleanup. The post-read deleting check rejects that stale reservation.
  let slot = workspaceWriteSlots.get(workspaceId);
  if (slot?.deleting) return undefined;
  if (!slot) {
    slot = { deleting: false, inFlight: 0 };
    workspaceWriteSlots.set(workspaceId, slot);
  }
  slot.inFlight++;
  let released = false;
  const admission: WorkspaceWriteAdmission = {
    release() {
      if (released) return;
      released = true;
      slot!.inFlight--;
      if (slot!.deleting && slot!.inFlight === 0) slot!.drained?.();
      if (!slot!.deleting && slot!.inFlight === 0 && workspaceWriteSlots.get(workspaceId) === slot) {
        workspaceWriteSlots.delete(workspaceId);
      }
    },
  };
  try {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace || workspace.status !== "active" || slot.deleting) {
      admission.release();
      return undefined;
    }
    return admission;
  } catch (error) {
    admission.release();
    throw error;
  }
}

async function beginWorkspaceDeletion(workspaceId: string): Promise<(completed: boolean) => void> {
  let slot = workspaceWriteSlots.get(workspaceId);
  if (!slot) {
    slot = { deleting: true, inFlight: 0 };
    workspaceWriteSlots.set(workspaceId, slot);
  } else {
    slot.deleting = true;
  }
  if (slot.inFlight > 0) await new Promise<void>((resolve) => { slot!.drained = resolve; });
  return (completed: boolean) => {
    if (workspaceWriteSlots.get(workspaceId) !== slot) return;
    if (completed) workspaceWriteSlots.delete(workspaceId);
    else {
      slot!.deleting = false;
      slot!.drained = undefined;
      if (slot!.inFlight === 0) workspaceWriteSlots.delete(workspaceId);
    }
  };
}

export function registerWorkspaceDeletionExtension(extension: WorkspaceDeletionExtension): () => void {
  if (!extension.name || !/^[a-z][a-z0-9-]{0,63}$/.test(extension.name)) {
    throw new Error("Workspace deletion extension name is invalid.");
  }
  if (typeof extension.deleteWorkspaceData !== "function") {
    throw new Error("Workspace deletion extension must provide deleteWorkspaceData.");
  }
  if (deletionExtensions.has(extension.name)) {
    throw new Error(`Workspace deletion extension '${extension.name}' is already registered.`);
  }
  deletionExtensions.set(extension.name, extension);
  return () => deletionExtensions.delete(extension.name);
}

export function isWorkspaceId(value: unknown): value is string {
  return value === DEFAULT_WORKSPACE_ID || (typeof value === "string" && WORKSPACE_ID_PATTERN.test(value));
}

export function normalizeWorkspaceName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function validateWorkspaceName(input: unknown): string {
  if (typeof input !== "string") throw new WorkspaceError("Workspace name is required.", 400);
  const name = input.normalize("NFKC").trim();
  const length = Array.from(name).length;
  if (!name) throw new WorkspaceError("Workspace name is required.", 400);
  if (length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new WorkspaceError(`Workspace name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`, 400);
  }
  if (Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) {
    throw new WorkspaceError("Workspace name contains invalid characters.", 400);
  }
  return name;
}

function fromRow(row: WorkspaceRow): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    isDefault: Number(row.is_default) === 1,
    status: row.status === "deleting" ? "deleting" : "active",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function workspaceNotFound(): WorkspaceError {
  return new WorkspaceError("Workspace not found.", 404);
}

function workspaceDeleting(): WorkspaceError {
  return new WorkspaceError("Workspace deletion is already in progress.", 409);
}

function workspaceUniqueError(error: unknown): boolean {
  return error instanceof Error && /unique constraint|constraint failed/i.test(error.message);
}

async function releaseDeletionClaim(workspaceId: string, deletionToken: string): Promise<void> {
  try {
    await db.execute({
      sql: `
        UPDATE workspaces
        SET status = 'active', deletion_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'deleting' AND deletion_token = ?
      `,
      args: [Date.now(), workspaceId, deletionToken],
    });
  } catch {
    // Startup recovery owns any claim left behind by a process-level failure.
  }
}

export async function ensureWorkspaceSchema(): Promise<void> {
  const now = Date.now();
  await db.batch([
    {
      sql: `
        CREATE TABLE IF NOT EXISTS workspace_schema_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        )
      `,
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
          status TEXT NOT NULL CHECK (status IN ('active', 'deleting')),
          deletion_token TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
    },
    {
      sql: `
        INSERT INTO workspace_schema_meta (id, version)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET version = MAX(version, excluded.version)
      `,
      args: [WORKSPACE_SCHEMA_VERSION],
    },
    {
      sql: `
        INSERT INTO workspaces (
          id, name, normalized_name, is_default, status, deletion_token, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 'active', NULL, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      args: [DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, normalizeWorkspaceName(DEFAULT_WORKSPACE_NAME), now, now],
    },
  ], "write");
}

/**
 * Startup-only recovery for a deletion interrupted by process termination. The
 * server calls this before it accepts HTTP requests, so no active request can
 * own one of these durable claims. Resource cleanup must be idempotent because
 * recovery intentionally makes the complete deletion retryable.
 */
export async function recoverInterruptedWorkspaceDeletions(): Promise<number> {
  const result = await db.execute({
    sql: `
      UPDATE workspaces
      SET status = 'active', deletion_token = NULL, updated_at = ?
      WHERE is_default = 0 AND status = 'deleting'
    `,
    args: [Date.now()],
  });
  return result.rowsAffected;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const result = await db.execute(`
    SELECT id, name, is_default, status, created_at, updated_at
    FROM workspaces
    ORDER BY is_default DESC, normalized_name ASC, id ASC
  `);
  return result.rows.map((row) => fromRow(row as unknown as WorkspaceRow));
}

export async function getWorkspace(workspaceId: string): Promise<Workspace | undefined> {
  if (!isWorkspaceId(workspaceId)) return undefined;
  const result = await db.execute({
    sql: `
      SELECT id, name, is_default, status, created_at, updated_at
      FROM workspaces
      WHERE id = ?
      LIMIT 1
    `,
    args: [workspaceId],
  });
  const row = result.rows[0] as unknown as WorkspaceRow | undefined;
  return row ? fromRow(row) : undefined;
}

export async function createWorkspace(nameInput: unknown): Promise<Workspace> {
  const name = validateWorkspaceName(nameInput);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.execute({
      sql: `
        INSERT INTO workspaces (
          id, name, normalized_name, is_default, status, deletion_token, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'active', NULL, ?, ?)
      `,
      args: [id, name, normalizeWorkspaceName(name), now, now],
    });
  } catch (error) {
    if (workspaceUniqueError(error)) throw new WorkspaceError("Workspace name is already in use.", 409);
    throw error;
  }
  return { id, name, isDefault: false, status: "active", createdAt: now, updatedAt: now };
}

export async function renameWorkspace(workspaceId: string, nameInput: unknown): Promise<Workspace> {
  if (!isWorkspaceId(workspaceId)) throw workspaceNotFound();
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    throw new WorkspaceError("Default workspace cannot be renamed.", 409);
  }
  const name = validateWorkspaceName(nameInput);
  const now = Date.now();
  try {
    const result = await db.execute({
      sql: `
        UPDATE workspaces
        SET name = ?, normalized_name = ?, updated_at = ?
        WHERE id = ? AND is_default = 0 AND status = 'active'
      `,
      args: [name, normalizeWorkspaceName(name), now, workspaceId],
    });
    if (result.rowsAffected === 1) {
      const updated = await getWorkspace(workspaceId);
      if (updated) return updated;
      throw workspaceNotFound();
    }
  } catch (error) {
    if (workspaceUniqueError(error)) throw new WorkspaceError("Workspace name is already in use.", 409);
    throw error;
  }

  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw workspaceNotFound();
  if (workspace.status === "deleting") throw workspaceDeleting();
  throw new WorkspaceError("Workspace cannot be renamed.", 409);
}

export async function deleteWorkspace(workspaceId: string, confirmation: unknown): Promise<void> {
  if (!isWorkspaceId(workspaceId)) throw workspaceNotFound();
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    throw new WorkspaceError("Default workspace cannot be deleted.", 409);
  }
  if (typeof confirmation !== "string") {
    throw new WorkspaceError("Workspace name confirmation is required.", 400);
  }

  const deletionToken = crypto.randomUUID();
  const claimed = await db.execute({
    sql: `
      UPDATE workspaces
      SET status = 'deleting', deletion_token = ?, updated_at = ?
      WHERE id = ? AND is_default = 0 AND status = 'active' AND name = ?
    `,
    args: [deletionToken, Date.now(), workspaceId, confirmation],
  });

  if (claimed.rowsAffected !== 1) {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) throw workspaceNotFound();
    if (workspace.status === "deleting") throw workspaceDeleting();
    throw new WorkspaceError("Workspace name confirmation does not match.", 400);
  }

  const finishDeletion = await beginWorkspaceDeletion(workspaceId);

  try {
    // Snapshot registration so a late module import cannot alter an in-flight delete.
    const cleanups = await Promise.allSettled(
      [...deletionExtensions.values()].map((extension) =>
        Promise.resolve().then(() => extension.deleteWorkspaceData(workspaceId)),
      ),
    );
    if (cleanups.some((result) => result.status === "rejected")) {
      throw new Error("A workspace deletion extension failed.");
    }
  } catch {
    await releaseDeletionClaim(workspaceId, deletionToken);
    finishDeletion(false);
    throw new WorkspaceError("Workspace deletion could not complete. Please try again.", 503);
  }

  try {
    const deleted = await db.execute({
      sql: "DELETE FROM workspaces WHERE id = ? AND status = 'deleting' AND deletion_token = ?",
      args: [workspaceId, deletionToken],
    });
    if (deleted.rowsAffected === 1) {
      finishDeletion(true);
      return;
    }
  } catch {
    // The token prevents this request from releasing a newer deletion claim.
  }
  await releaseDeletionClaim(workspaceId, deletionToken);
  finishDeletion(false);
  throw new WorkspaceError("Workspace deletion could not complete. Please try again.", 503);
}
