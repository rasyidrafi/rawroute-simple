export const dashboardPaths = {
  endpoint: "/dashboard/ai/endpoint",
  providers: "/dashboard/ai/providers",
  codex: "/dashboard/ai/codex-providers",
  routing: "/dashboard/ai/routing",
  usage: "/dashboard/ai/usage",
  budgets: "/dashboard/ai/budgets",
  pricing: "/dashboard/ai/pricing",
  cliproxy: "/dashboard/cliproxy",
  logs: "/dashboard/logs",
  settings: "/dashboard/settings",
  "tool-overview": "/dashboard/tools/overview",
  "tool-tools": "/dashboard/tools/catalog",
  "tool-connections": "/dashboard/tools/connections",
  "tool-policies": "/dashboard/tools/policies",
  "tool-activity": "/dashboard/tools/activity",
  "tool-settings": "/dashboard/tools/settings",
} as const;

export type DashboardRoute = keyof typeof dashboardPaths;
export type DashboardPageScope = "global" | "workspace";

/**
 * Routing scope is presentation metadata today. The next console/resource
 * slices reuse it to choose an explicit workspace request scope.
 */
export const dashboardRouteMeta: Record<DashboardRoute, { scope: DashboardPageScope }> = {
  endpoint: { scope: "global" },
  providers: { scope: "workspace" },
  codex: { scope: "workspace" },
  routing: { scope: "workspace" },
  usage: { scope: "workspace" },
  budgets: { scope: "workspace" },
  pricing: { scope: "workspace" },
  logs: { scope: "workspace" },
  cliproxy: { scope: "global" },
  settings: { scope: "global" },
  "tool-overview": { scope: "workspace" },
  "tool-tools": { scope: "workspace" },
  "tool-connections": { scope: "workspace" },
  "tool-policies": { scope: "workspace" },
  "tool-activity": { scope: "workspace" },
  "tool-settings": { scope: "workspace" },
};

export const dashboardAliases = ["/", "/dashboard", "/dashboard/ai", "/dashboard/tools"] as const;
export const providerDetailPath = "/dashboard/ai/providers/:providerId";

// Decode the URL segment rather than matchPath's param: React Router preserves
// percent escapes in most params but decodes %2F specially.
export function providerIdFromPath(path: string): string | undefined {
  const segment = /^\/dashboard\/ai\/providers\/([^/]+)$/.exec(path)?.[1];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function dashboardPage(path: string): DashboardRoute | "provider-detail" | undefined {
  const entry = Object.entries(dashboardPaths).find(([, value]) => value === path);
  if (entry) return entry[0] as DashboardRoute;
  if (/^\/dashboard\/ai\/providers\/[^/]+$/.test(path)) return "provider-detail";
}
