import { dashboardScopeForPage, type DashboardPageScope } from "../dashboard-routes";
import type { BrowserEvent } from "./types";

export const workspaceEvents = new Set<BrowserEvent>([
  "providers.changed", "models.changed", "provider-keys.changed", "codex-models.changed", "codex-accounts.changed",
  "aliases.changed", "combos.changed", "budgets.changed", "pricing.changed", "budgets.window", "budgets.unlimited",
  "budgets.beyond-limits", "codex.authorize", "codex.credit", "logs.copied", "logs.paused", "logs.resumed",
]);

export const endpointEvents = new Set<BrowserEvent>([
  "gateway-key.copied", "gateway-keys.created", "gateway-keys.renamed", "gateway-keys.deleted",
]);

/**
 * Browser events can only claim declared shell routes. Page-less runtime errors
 * are global because their originating route is unknown.
 */
export function browserEventScope(event: BrowserEvent, page: unknown): DashboardPageScope | undefined {
  if ((event === "dashboard.error" || event === "dashboard.rejection") && page === undefined) return "global";

  const pageScope = dashboardScopeForPage(page);
  if (page !== undefined && !pageScope) return undefined;

  if (endpointEvents.has(event)) return page === "endpoint" ? "workspace" : undefined;
  if (workspaceEvents.has(event)) return page === undefined || (page !== "endpoint" && pageScope === "workspace") ? "workspace" : undefined;
  return pageScope;
}
