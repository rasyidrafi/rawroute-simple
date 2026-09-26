import type { LogDetails, LogEntry, LogEvent, LogLevel, LogScopeKind, LogSnapshot } from "./types";

export const LOG_CAPACITY = 2_000;
export const TOTAL_LOG_CAPACITY = 10_000;
export const MAX_WORKSPACE_LOG_SCOPES = 128;
export const LOG_STORE_VERSION = 2;

export type LogScope = { kind: "global" } | { kind: "workspace"; workspaceId: string };
export type WorkspaceLogAdmission = { kind: "workspace"; workspaceId: string; token: symbol };
type LogWriteScope = { kind: "global" } | WorkspaceLogAdmission;

function singleLine(value: string, length: number): string {
  return value.slice(0, length).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

// Numeric/boolean metadata only. This excludes secrets by construction, including
// accidental request/response objects passed by future callers.
export function safeDetails(input: LogDetails): LogDetails {
  const result: LogDetails = {};
  for (const [key, value] of Object.entries(input).slice(0, 16)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || /password|secret|token|key|cookie|authorization/i.test(key)) continue;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      result[key] = value;
    }
  }
  return result;
}

export function createLogStore(capacity = LOG_CAPACITY, totalCapacity = TOTAL_LOG_CAPACITY) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > LOG_CAPACITY ||
      !Number.isInteger(totalCapacity) || totalCapacity < capacity) throw new Error("Invalid log capacity");
  type Buffer = { entries: LogEntry[]; evicted: number; touched: number };
  type Admission = { token: symbol; touched: number };
  const buffers = new Map<string, Buffer>();
  const admissions = new Map<string, Admission>();
  const instance = crypto.randomUUID();
  let sequence = 0;
  let totalEntries = 0;

  function key(scope: LogScope): string { return scope.kind === "global" ? "global" : `workspace:${scope.workspaceId}`; }
  function scopeFor(scope: LogScope): { scope: LogScopeKind; workspaceId: string | null } {
    return scope.kind === "global" ? { scope: "global", workspaceId: null } : { scope: "workspace", workspaceId: scope.workspaceId };
  }
  function trimAdmissions(): void {
    if (admissions.size < MAX_WORKSPACE_LOG_SCOPES) return;
    const oldest = [...admissions.entries()].sort((left, right) => left[1].touched - right[1].touched)[0];
    if (oldest) admissions.delete(oldest[0]);
  }
  function validAdmission(scope: LogWriteScope): boolean {
    if (scope.kind === "global") return true;
    const current = admissions.get(scope.workspaceId);
    return current?.token === scope.token;
  }
  function buffer(scope: LogScope, create: boolean): Buffer | undefined {
    const scopeKey = key(scope);
    const found = buffers.get(scopeKey);
    if (found || !create) return found;
    if (scope.kind === "workspace") {
      const workspaceBuffers = [...buffers.keys()].filter((item) => item.startsWith("workspace:"));
      if (workspaceBuffers.length >= MAX_WORKSPACE_LOG_SCOPES) {
        const oldest = workspaceBuffers
          .map((item) => [item, buffers.get(item)!] as const)
          .sort((left, right) => left[1].touched - right[1].touched)[0];
        if (oldest) { totalEntries -= oldest[1].entries.length; buffers.delete(oldest[0]); }
      }
    }
    const created = { entries: [], evicted: 0, touched: ++sequence };
    buffers.set(scopeKey, created);
    return created;
  }
  function evictTotal(): void {
    while (totalEntries > totalCapacity) {
      const oldest = [...buffers.entries()]
        .filter(([, item]) => item.entries.length)
        .sort((left, right) => entrySequence(left[1].entries[0]!) - entrySequence(right[1].entries[0]!))[0];
      if (!oldest) return;
      oldest[1].entries.shift();
      oldest[1].evicted++;
      totalEntries--;
    }
  }
  return {
    version: LOG_STORE_VERSION,
    admitWorkspace(workspaceId: string): WorkspaceLogAdmission {
      let current = admissions.get(workspaceId);
      if (!current) {
        trimAdmissions();
        current = { token: Symbol(workspaceId), touched: ++sequence };
        admissions.set(workspaceId, current);
      } else {
        current.touched = ++sequence;
      }
      return { kind: "workspace", workspaceId, token: current.token };
    },
    record(event: LogEvent, level: LogLevel = "INFO", details: LogDetails = {}, origin: LogEntry["origin"] = "server", scope: LogWriteScope = { kind: "global" }) {
      if (!validAdmission(scope)) return false;
      const target = buffer(scope, true)!;
      const structuredScope = scopeFor(scope);
      const entry: LogEntry = {
        source: singleLine(event.source, 64),
        event: singleLine(event.event, 96),
        message: singleLine(event.message, 240),
        id: `${instance}:${++sequence}`,
        time: new Date().toISOString(), level, origin, ...structuredScope, details: safeDetails(details),
      };
      if (target.entries.length === capacity) { target.entries.shift(); target.evicted++; totalEntries--; }
      target.entries.push(entry);
      target.touched = ++sequence;
      totalEntries++;
      evictTotal();
      return true;
    },
    snapshot(scope: LogScope = { kind: "global" }): LogSnapshot {
      const target = buffer(scope, false);
      const structuredScope = scopeFor(scope);
      return {
        ...structuredScope,
        entries: [...(target?.entries ?? [])].reverse().map((entry) => ({ ...entry, details: { ...entry.details } })),
        capacity,
        evicted: target?.evicted ?? 0,
      };
    },
    clear(scope: LogWriteScope = { kind: "global" }) {
      if (!validAdmission(scope)) return false;
      const target = buffer(scope, false);
      if (!target) return true;
      totalEntries -= target.entries.length;
      target.entries.length = 0;
      target.evicted = 0;
      target.touched = ++sequence;
      return true;
    },
    deleteWorkspace(workspaceId: string) {
      const scopeKey = `workspace:${workspaceId}`;
      const target = buffers.get(scopeKey);
      if (target) {
        totalEntries -= target.entries.length;
        buffers.delete(scopeKey);
      }
      admissions.delete(workspaceId);
    },
  };
}

function entrySequence(entry: LogEntry): number {
  return Number(entry.id.slice(entry.id.lastIndexOf(":") + 1));
}

type LogStore = ReturnType<typeof createLogStore>;
type LogRuntime = { __rawrouteLogs?: unknown };

function isCompatibleStore(value: unknown): value is LogStore {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === LOG_STORE_VERSION &&
    ["admitWorkspace", "record", "snapshot", "clear", "deleteWorkspace"].every((method) =>
      typeof (value as Record<string, unknown>)[method] === "function",
    );
}

/** Replace pre-scope HMR state instead of retaining a store with unsafe APIs. */
export function resolveLogStore(runtime: LogRuntime): LogStore {
  if (isCompatibleStore(runtime.__rawrouteLogs)) return runtime.__rawrouteLogs;
  const store = createLogStore();
  runtime.__rawrouteLogs = store;
  return store;
}

// Keep current-instance history across Bun development module reloads only when
// it has the current scoped-store contract.
const runtime = globalThis as typeof globalThis & LogRuntime;
export const logs = resolveLogStore(runtime);
