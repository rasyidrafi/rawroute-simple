"use client";

import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "react-router";
import { useWorkspace } from "@/components/workspace-provider";
import { dashboardPaths, dashboardRouteMeta, type DashboardRoute } from "@/lib/dashboard-routes";
import { Budgets } from "@/components/dashboard/budgets-page";
import { CliproxyPage } from "@/components/dashboard/cliproxy-page";
import { CodexProviders } from "@/components/dashboard/codex-page";
import { ConsoleLog, SystemLogPanel } from "@/components/dashboard/console-log-page";
import { EndpointKeys } from "@/components/dashboard/endpoint-page";
import { Pricing } from "@/components/dashboard/pricing-page";
import { ProviderDetail, Providers } from "@/components/dashboard/providers-page";
import { useProviders } from "@/components/dashboard/use-providers";
import { Routing } from "@/components/dashboard/routing-page";
import { Settings } from "@/components/dashboard/settings-page";
import { ToolGateway } from "@/components/dashboard/tool-gateway-page";
import { WorkspaceUnavailable } from "@/components/dashboard/workspace-unavailable";

const Usage = lazy(() =>
  import("@/components/dashboard/usage-page").then(({ Usage }) => ({
    default: Usage,
  })),
);

type Props = {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  providerId?: string;
  providerDetail: boolean;
  onPasswordChanged: () => void | Promise<void>;
};

export function DashboardViews({
  route,
  onNavigate,
  providerId,
  providerDetail,
  onPasswordChanged,
}: Props) {
  const { activeWorkspaceId, isLoading, error, reload } = useWorkspace();
  const providerState = useProviders(activeWorkspaceId);

  if (dashboardRouteMeta[route].scope === "workspace" && !activeWorkspaceId) {
    return <WorkspaceUnavailable route={route} providerDetail={providerDetail} loading={isLoading} error={error} onRetry={reload} />;
  }

  return renderDashboardRoute({
    route, onNavigate, providerId, providerDetail, onPasswordChanged,
    workspaceId: activeWorkspaceId,
    providerState,
  });
}

type WorkspaceRouteProps = Props & {
  workspaceId: string | null;
  providerState: ReturnType<typeof useProviders>;
};

function renderDashboardRoute({
  route, onNavigate, providerId, providerDetail, onPasswordChanged, workspaceId,
  providerState,
}: WorkspaceRouteProps): ReactNode {
  if (route === "endpoint" && workspaceId) return <EndpointKeys key={workspaceId} workspaceId={workspaceId} />;
  if (route === "cliproxy") return <CliproxyPage />;
  if (route === "system-logs") return <SystemLogPanel />;
  if (route === "providers") {
    const provider = providerState.resource.providers.find((item) => item.id === providerId);
    if (!providerDetail) return <Providers key={workspaceId} resource={providerState.resource} reload={providerState.reload} read={providerState.read} mutate={providerState.mutate} isPending={providerState.isPending} />;
    if (!provider && providerState.resource.phase === "ready") return <main className="flex-1 p-6"><h2 className="text-xl font-semibold">Provider not found</h2><Link to={dashboardPaths.providers}>Back to providers</Link></main>;
    if (!provider) return <Providers key={workspaceId} resource={providerState.resource} reload={providerState.reload} read={providerState.read} mutate={providerState.mutate} isPending={providerState.isPending} />;
    return <ProviderDetail key={`${workspaceId}:${providerId}`} provider={provider} resource={providerState.resource} reload={providerState.reload} read={providerState.read} mutate={providerState.mutate} isPending={providerState.isPending} />;
  }
  if (route === "codex" && workspaceId) return <CodexProviders key={workspaceId} workspaceId={workspaceId} />;
  if (route === "routing" && workspaceId) return <Routing key={workspaceId} workspaceId={workspaceId} />;
  if (route === "usage" && workspaceId) return <Suspense fallback={<div className="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground" role="status">Loading usage dashboard…</div>}><Usage key={workspaceId} workspaceId={workspaceId} /></Suspense>;
  if (route === "budgets" && workspaceId) return <Budgets key={workspaceId} workspaceId={workspaceId} />;
  if (route === "pricing" && workspaceId) return <Pricing key={workspaceId} workspaceId={workspaceId} />;
  if (route === "logs" && workspaceId) return <ConsoleLog key={workspaceId} workspaceId={workspaceId} />;
  if (route === "settings") return <Settings onPasswordChanged={onPasswordChanged} />;
  return <ToolGateway key={workspaceId} route={route} onNavigate={onNavigate} />;
}
