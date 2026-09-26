export type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogDetails = Record<string, number | boolean | null>;
export type LogScopeKind = "global" | "workspace";

export interface LogEvent {
  source: string;
  event: string;
  message: string;
}

export interface LogEntry extends LogEvent {
  id: string;
  time: string;
  level: LogLevel;
  origin: "server" | "browser";
  /** Scope is structural metadata, never user-provided log details. */
  scope: LogScopeKind;
  workspaceId: string | null;
  details: LogDetails;
}

export interface LogSnapshot {
  scope: LogScopeKind;
  workspaceId: string | null;
  entries: LogEntry[];
  capacity: number;
  evicted: number;
}

// Browser reports are deliberately a closed vocabulary: never accept arbitrary
// messages, URLs, names, credentials, or exception text from a client.
export const browserEvents = {
  "dashboard.navigation": "Dashboard page opened",
  "dashboard.copy": "Clipboard copy completed",
  "dashboard.copy-failed": "Clipboard copy failed",
  "dashboard.error": "Dashboard runtime error (details omitted)",
  "dashboard.rejection": "Dashboard unhandled promise rejection (details omitted)",
  "gateway-key.copied": "Workspace gateway key copied (value omitted)",
  "gateway-keys.created": "Workspace gateway key created",
  "gateway-keys.renamed": "Workspace gateway key renamed",
  "gateway-keys.deleted": "Workspace gateway key deleted",
  "providers.changed": "Local demo providers changed",
  "models.changed": "Local demo provider models changed",
  "provider-keys.changed": "Local demo provider credentials changed",
  "codex-models.changed": "Local demo Codex models changed",
  "codex-accounts.changed": "Local demo Codex accounts changed",
  "aliases.changed": "Local demo routing aliases changed",
  "combos.changed": "Local demo routing chains changed",
  "budgets.changed": "Local demo budgets changed",
  "pricing.changed": "Local demo pricing groups changed",
  "budgets.window": "Local demo budget window changed",
  "budgets.unlimited": "Local demo unlimited mode changed",
  "budgets.beyond-limits": "Local demo beyond-limits setting changed",
  "codex.authorize": "Demo device authorization requested",
  "codex.credit": "Demo reset credit requested",
  "logs.copied": "Console log copied",
  "logs.paused": "Console live updates paused",
  "logs.resumed": "Console live updates resumed",
} as const;

export type BrowserEvent = keyof typeof browserEvents;

export function formatLog(entry: LogEntry): string {
  const details = Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ");
  return `${entry.time} ${entry.level.padEnd(5)} [${entry.source}] ${entry.message} event=${entry.event} origin=${entry.origin}${details ? ` ${details}` : ""}`;
}
