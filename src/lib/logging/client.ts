import type { BrowserEvent } from "./types";

/** Best effort: log reporting must never block or retry a business action. */
export function reportEvent(event: BrowserEvent, details: { page?: string; added?: number; removed?: number; updated?: number; reordered?: boolean } = {}): void {
  void fetch("/api/logs/events", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, ...details }), signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}
