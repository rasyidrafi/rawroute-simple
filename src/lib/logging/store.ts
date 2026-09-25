import type { LogDetails, LogEntry, LogEvent, LogLevel, LogSnapshot } from "./types";

export const LOG_CAPACITY = 2_000;

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

export function createLogStore(capacity = LOG_CAPACITY) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > LOG_CAPACITY) throw new Error("Invalid log capacity");
  const entries: LogEntry[] = [];
  const instance = crypto.randomUUID();
  let sequence = 0;
  let evicted = 0;
  return {
    record(event: LogEvent, level: LogLevel = "INFO", details: LogDetails = {}, origin: LogEntry["origin"] = "server") {
      const entry: LogEntry = {
        source: singleLine(event.source, 64),
        event: singleLine(event.event, 96),
        message: singleLine(event.message, 240),
        id: `${instance}:${++sequence}`,
        time: new Date().toISOString(), level, origin, details: safeDetails(details),
      };
      if (entries.length === capacity) { entries.shift(); evicted++; }
      entries.push(entry);
    },
    snapshot(): LogSnapshot {
      return { entries: [...entries].reverse().map((entry) => ({ ...entry, details: { ...entry.details } })), capacity, evicted };
    },
    clear() { entries.length = 0; evicted = 0; },
  };
}

// Keep the current-instance history across Bun development module reloads.
const runtime = globalThis as typeof globalThis & { __rawrouteLogs?: ReturnType<typeof createLogStore> };
export const logs = runtime.__rawrouteLogs ??= createLogStore();
