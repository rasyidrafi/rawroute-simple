import type { BrowserEvent } from "./types";

export type BrowserLogDetails = {
  page?: string;
  workspaceId?: string | null;
  added?: number;
  removed?: number;
  updated?: number;
  reordered?: boolean;
};

/** Best effort: log reporting must never block or retry a business action. */
export function reportEvent(event: BrowserEvent, details: BrowserLogDetails = {}): void {
  // Snapshot the workspace before starting fetch. Callers that finish after a
  // workspace switch still report to the workspace that owned the action.
  const { workspaceId, ...body } = details;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (workspaceId) headers.set("X-RawRoute-Workspace-Id", workspaceId);
  void fetch("/api/logs/events", {
    method: "POST", credentials: "same-origin", headers,
    body: JSON.stringify({ event, ...body }), signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}
