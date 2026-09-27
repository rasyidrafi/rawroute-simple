import { usageDashboard } from "./accounting";
import { db } from "./db";
import { invalidatePublicAnalytics, publicAnalyticsGeneration, readPublicAnalyticsCache, writePublicAnalyticsCache } from "./public-analytics-cache";
import { addAppDays, appDateStart, appDateString, mondayInAppTimeZone } from "./timezone";
import { admitWorkspaceWrite, getWorkspace, listWorkspaces, registerWorkspaceDeletionExtension } from "./workspaces";

const PUBLIC_PRESETS = new Set(["today", "yesterday", "week", "lastWeek", "month", "lastMonth", "year", "all", "custom", "budget"]);
const PUBLIC_GRANULARITIES = new Set(["hourly", "daily", "weekly", "monthly"]);
const MAX_PUBLIC_CUSTOM_DAYS = 366;

export class PublicAnalyticsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PublicAnalyticsError";
  }
}

export type PublicDashboardQuery = {
  workspaceId: string;
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  granularity?: string | null;
};

type Dashboard = Awaited<ReturnType<typeof usageDashboard>>;
type PublicRow = { name: string; requests: number; tokens: number; costMicros: number };
export type PublicDashboard = {
  timeZone: string;
  freshness: number;
  range: Dashboard["range"];
  summary: Dashboard["summary"] & { activeKeys: number };
  pricingConfidence: Pick<Dashboard["summary"], "exactRequests" | "assumedRequests" | "unpricedRequests">;
  trend: Array<{ label: string; requests: number; tokens: number; costMicros: number }>;
  keys: PublicRow[];
  models: PublicRow[];
};

function normalizedQuery(query: PublicDashboardQuery) {
  const preset = query.preset ?? "week";
  if (!PUBLIC_PRESETS.has(preset)) throw new PublicAnalyticsError("Usage range is invalid.", 400);
  const granularity = query.granularity ?? undefined;
  if (granularity && !PUBLIC_GRANULARITIES.has(granularity)) {
    throw new PublicAnalyticsError("Usage granularity is invalid.", 400);
  }
  if (preset !== "custom" && (query.from || query.to)) {
    throw new PublicAnalyticsError("Custom dates require the custom range.", 400);
  }
  if (preset === "custom" && (!query.from || !query.to)) {
    throw new PublicAnalyticsError("Custom usage dates are required.", 400);
  }
  return { preset, from: query.from ?? null, to: query.to ?? null, granularity };
}

function validDate(value: string): Date {
  const parsed = appDateStart(value);
  if (!Number.isFinite(parsed.getTime()) || appDateString(parsed) !== value) {
    throw new PublicAnalyticsError("Custom usage range is invalid.", 400);
  }
  return parsed;
}

function publicCustomRange(from: string, to: string) {
  const start = validDate(from);
  const inclusiveEnd = validDate(to);
  const maxEnd = addAppDays(start, MAX_PUBLIC_CUSTOM_DAYS);
  if (inclusiveEnd.getTime() < start.getTime() || inclusiveEnd.getTime() >= maxEnd.getTime()) {
    throw new PublicAnalyticsError("Custom usage range is invalid.", 400);
  }
  return { from: start.getTime(), to: addAppDays(inclusiveEnd, 1).getTime(), label: "Custom" };
}

/** The public budget view is read-only. It derives an elapsed custom window
 * without creating/rolling budget rows from an unauthenticated GET. */
async function publicBudgetDashboard(workspaceId: string, granularity?: string): Promise<Dashboard> {
  const now = Date.now();
  const result = await db.execute({ sql: "SELECT start_at,end_at,duration_ms FROM budget_windows WHERE workspace_id=?", args: [workspaceId] });
  const row = result.rows[0];
  let start = row ? Number(row.start_at) : mondayInAppTimeZone(now).getTime();
  let end = row ? Number(row.end_at) : addAppDays(start, 7).getTime();
  const duration = row ? Number(row.duration_ms) : end - start;
  if (end <= now && Number.isFinite(duration) && duration > 0) {
    const steps = Math.max(1, Math.floor((now - start) / duration));
    start += steps * duration;
    end += steps * duration;
  }
  return usageDashboard(workspaceId, { exactRange: { from: start, to: end, label: "Budget window" }, granularity });
}

async function publicKeyNames(workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT id,name FROM gateway_keys WHERE workspace_id=? AND status<>'deleted' AND id IN (${placeholders})`,
    args: [workspaceId, ...ids],
  });
  return new Map(result.rows.map((row) => [String(row.id), String(row.name)]));
}

function safeRows(rows: Dashboard["models"], names?: Map<string, string>): PublicRow[] {
  return rows.map((row) => ({
    // Model gateway IDs and administrator-selected key names are already public
    // labels. Never send durable IDs, provider IDs, request IDs, or credentials.
    name: names?.get(row.id) ?? (names ? "Deleted key" : row.id),
    requests: row.requests,
    tokens: row.tokens,
    costMicros: row.costMicros,
  }));
}

export async function listPublicWorkspaces(): Promise<Array<{ id: string; name: string }>> {
  const workspaces = await listWorkspaces();
  return workspaces
    .filter((workspace) => workspace.status === "active")
    .map(({ id, name }) => ({ id, name }));
}

export async function publicDashboard(query: PublicDashboardQuery): Promise<PublicDashboard> {
  const workspace = await getWorkspace(query.workspaceId);
  if (!workspace || workspace.status !== "active") throw new PublicAnalyticsError("Workspace not found.", 404);
  // Treat the aggregate read as deletion-admitted work. A deletion that wins
  // first makes this request unselectable; a read that won first completes
  // before deletion cleanup/invalidation can expose a stale cached result.
  const admission = await admitWorkspaceWrite(workspace.id);
  if (!admission) throw new PublicAnalyticsError("Workspace not found.", 404);
  try {
    const normalized = normalizedQuery(query);
    const queryKey = JSON.stringify(normalized);
    const cached = readPublicAnalyticsCache<PublicDashboard>(workspace.id, queryKey);
    if (cached) return cached;
    const cacheGeneration = publicAnalyticsGeneration(workspace.id);

    let dashboard: Dashboard;
    if (normalized.preset === "budget") {
      dashboard = await publicBudgetDashboard(workspace.id, normalized.granularity);
    } else if (normalized.preset === "custom") {
      dashboard = await usageDashboard(workspace.id, {
        exactRange: publicCustomRange(normalized.from!, normalized.to!),
        granularity: normalized.granularity,
      });
    } else {
      dashboard = await usageDashboard(workspace.id, normalized);
    }
    const keyNames = await publicKeyNames(workspace.id, dashboard.keys.map((row) => row.id));
    const value: PublicDashboard = {
      timeZone: dashboard.timeZone,
      freshness: dashboard.freshness,
      range: dashboard.range,
      summary: { ...dashboard.summary, activeKeys: dashboard.keys.length },
      pricingConfidence: {
        exactRequests: dashboard.summary.exactRequests,
        assumedRequests: dashboard.summary.assumedRequests,
        unpricedRequests: dashboard.summary.unpricedRequests,
      },
      trend: dashboard.trend.map(({ label, requests, tokens, costMicros }) => ({ label, requests, tokens, costMicros })),
      keys: safeRows(dashboard.keys, keyNames),
      models: safeRows(dashboard.models),
    };
    return writePublicAnalyticsCache(workspace.id, queryKey, value, 30_000, cacheGeneration);
  } finally {
    admission.release();
  }
}

/** Workspace deletion may run beside accounting cleanup, so discard all cached
 * variants before either cleanup can make the workspace unselectable. */
export function registerPublicAnalyticsWorkspaceDeletion(): () => void {
  return registerWorkspaceDeletionExtension({
    name: "public-analytics-cache",
    deleteWorkspaceData: async (workspaceId) => invalidatePublicAnalytics(workspaceId),
  });
}

export { invalidatePublicAnalytics };
