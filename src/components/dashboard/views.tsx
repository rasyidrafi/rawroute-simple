"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link } from "react-router";
import { useWorkspace } from "@/components/workspace-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { collectionChanges } from "@/lib/logging/collection";
import { reportEvent } from "@/lib/logging/client";
import type { BrowserEvent } from "@/lib/logging/types";
import { dashboardPaths, dashboardRouteMeta, type DashboardRoute } from "@/lib/dashboard-routes";
import { pruneWorkspaceCollections, updateWorkspaceCollection } from "@/lib/workspace-state";
import { Budgets } from "@/components/dashboard/budgets-page";
import { CliproxyPage } from "@/components/dashboard/cliproxy-page";
import { CodexProviders } from "@/components/dashboard/codex-page";
import { ConsoleLog, SystemLogPanel } from "@/components/dashboard/console-log-page";
import { EndpointKeys } from "@/components/dashboard/endpoint-page";
import { Page } from "@/components/dashboard/page-ui";
import { Pricing } from "@/components/dashboard/pricing-page";
import { ProviderDetail, Providers } from "@/components/dashboard/providers-page";
import { Routing } from "@/components/dashboard/routing-page";
import { Settings } from "@/components/dashboard/settings-page";
import { ToolGateway } from "@/components/dashboard/tool-gateway-page";
import {
  initialAliases,
  initialBudgets,
  initialCombos,
  initialCodexAccounts,
  initialCodexModels,
  initialGatewayKeys,
  initialModels,
  initialProviderCredentialLabels,
  initialPriceGroups,
  initialProviders,
} from "@/mock/dashboard-data";
import type { Alias, Budget, CodexAccount, CodexModel, Combo, Model, PriceGroup, Provider, ProviderCredentialLabels } from "@/mock/dashboard-data";

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

function cloneFixture<T>(value: T[]): T[] {
  return structuredClone(value);
}

/**
 * Workspace mock collections are browser-memory fixtures only. The map lives
 * here so fixtures survive page navigation and a switch back to their owner.
 */
function useWorkspaceCollection<T>(
  workspaceId: string | null,
  workspaces: { id: string }[],
  workspaceListVersion: number,
  initialValue: T[],
  event: BrowserEvent,
) {
  const [collections, setCollections] = useState<Record<string, T[]>>({});
  const value = workspaceId ? collections[workspaceId] ?? initialValue : initialValue;
  const previousCollections = useRef<Record<string, T[]>>({});
  const synchronizedWorkspaceListVersion = useRef(0);

  useEffect(() => {
    if (workspaceListVersion === 0 || synchronizedWorkspaceListVersion.current === workspaceListVersion) return;
    synchronizedWorkspaceListVersion.current = workspaceListVersion;
    // Removing an owner key does not appear as a fixture edit: the reporting
    // effect below only compares collection entries that still exist.
    setCollections((current) =>
      pruneWorkspaceCollections(current, workspaces, true),
    );
  }, [workspaceListVersion, workspaces]);

  useEffect(() => {
    const before = previousCollections.current;
    previousCollections.current = collections;
    for (const [ownerWorkspaceId, nextValue] of Object.entries(collections)) {
      const beforeValue = before[ownerWorkspaceId] ?? initialValue;
      if (beforeValue === nextValue) continue;
      const changes = collectionChanges(beforeValue, nextValue);
      if (changes.added || changes.removed || changes.updated || changes.reordered) {
        // The map key was captured by the setter at action start. Selection-only
        // renders never update this map, so switching A → B cannot fabricate or
        // misattribute a fixture mutation.
        reportEvent(event, { ...changes, workspaceId: ownerWorkspaceId });
      }
    }
  }, [collections, event, initialValue]);

  const setValue = useCallback<Dispatch<SetStateAction<T[]>>>(
    (update) => {
      if (!workspaceId) return;
      setCollections((current) =>
        updateWorkspaceCollection(
          current,
          workspaceId,
          cloneFixture(initialValue),
          update,
        ),
      );
    },
    [initialValue, workspaceId],
  );

  return [value, setValue] as const;
}

export function DashboardViews({
  route,
  onNavigate,
  providerId,
  providerDetail,
  onPasswordChanged,
}: Props) {
  const { activeWorkspaceId, workspaces, workspaceListVersion, isLoading, error, reload } = useWorkspace();
  const [providers, setProviders] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialProviders, "providers.changed");
  const [models, setModels] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialModels, "models.changed");
  const [codexModels, setCodexModels] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialCodexModels, "codex-models.changed");
  const [codexAccounts, setCodexAccounts] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialCodexAccounts, "codex-accounts.changed");
  const [providerCredentialLabels, setProviderCredentialLabels] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialProviderCredentialLabels, "provider-keys.changed");
  const [aliases, setAliases] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialAliases, "aliases.changed");
  const [combos, setCombos] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialCombos, "combos.changed");
  const [budgets, setBudgets] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialBudgets, "budgets.changed");
  const [priceGroups, setPriceGroups] = useWorkspaceCollection(activeWorkspaceId, workspaces, workspaceListVersion, initialPriceGroups, "pricing.changed");

  if (dashboardRouteMeta[route].scope === "workspace" && !activeWorkspaceId) {
    return <WorkspaceUnavailable loading={isLoading} error={error} onRetry={reload} />;
  }

  return renderDashboardRoute({
    route, onNavigate, providerId, providerDetail, onPasswordChanged,
    workspaceId: activeWorkspaceId,
    providers, setProviders, models, setModels, codexModels, setCodexModels,
    codexAccounts, setCodexAccounts, providerCredentialLabels, setProviderCredentialLabels,
    aliases, setAliases, combos, setCombos, budgets, setBudgets, priceGroups, setPriceGroups,
  });
}

type CollectionSetter<T> = Dispatch<SetStateAction<T[]>>;
type WorkspaceRouteProps = Props & {
  workspaceId: string | null;
  providers: Provider[];
  setProviders: CollectionSetter<Provider>;
  models: Model[];
  setModels: CollectionSetter<Model>;
  codexModels: CodexModel[];
  setCodexModels: CollectionSetter<CodexModel>;
  codexAccounts: CodexAccount[];
  setCodexAccounts: CollectionSetter<CodexAccount>;
  providerCredentialLabels: ProviderCredentialLabels[];
  setProviderCredentialLabels: CollectionSetter<ProviderCredentialLabels>;
  aliases: Alias[];
  setAliases: CollectionSetter<Alias>;
  combos: Combo[];
  setCombos: CollectionSetter<Combo>;
  budgets: Budget[];
  setBudgets: CollectionSetter<Budget>;
  priceGroups: PriceGroup[];
  setPriceGroups: CollectionSetter<PriceGroup>;
};

function renderDashboardRoute({
  route, onNavigate, providerId, providerDetail, onPasswordChanged, workspaceId,
  providers, setProviders, models, setModels, codexModels, setCodexModels,
  codexAccounts, setCodexAccounts, providerCredentialLabels, setProviderCredentialLabels,
  aliases, setAliases, combos, setCombos, budgets, setBudgets, priceGroups, setPriceGroups,
}: WorkspaceRouteProps): ReactNode {
  if (route === "endpoint" && workspaceId) return <EndpointKeys key={workspaceId} workspaceId={workspaceId} />;
  if (route === "cliproxy") return <CliproxyPage />;
  if (route === "system-logs") return <SystemLogPanel />;
  if (route === "providers") {
    const provider = providers.find((item) => item.id === providerId);
    if (!providerDetail) return <Providers key={workspaceId} providers={providers} setProviders={setProviders} />;
    if (!provider) return <main className="flex-1 p-6"><h2 className="text-xl font-semibold">Provider not found</h2><Link to={dashboardPaths.providers}>Back to providers</Link></main>;
    const keyFixture = providerCredentialLabels.find((item) => item.providerId === provider.id);
    const defaultKeyNames = [`${provider.name} primary`, `${provider.name} standby`];
    const setKeyNames: CollectionSetter<string> = (update) => setProviderCredentialLabels((items) => {
      const current = items.find((item) => item.providerId === provider.id)?.labels ?? defaultKeyNames;
      const labels = typeof update === "function" ? update(current) : update;
      const fixture = { providerId: provider.id, labels };
      return items.some((item) => item.providerId === provider.id)
        ? items.map((item) => item.providerId === provider.id ? fixture : item)
        : [...items, fixture];
    });
    return <ProviderDetail key={`${workspaceId}:${providerId}`} provider={provider} setProviders={setProviders} models={models} setModels={setModels} keyNames={keyFixture?.labels ?? defaultKeyNames} setKeyNames={setKeyNames} />;
  }
  if (route === "codex" && workspaceId) return <CodexProviders key={workspaceId} workspaceId={workspaceId} models={codexModels} setModels={setCodexModels} accounts={codexAccounts} setAccounts={setCodexAccounts} />;
  if (route === "routing" && workspaceId) return <Routing key={workspaceId} workspaceId={workspaceId} aliases={aliases} setAliases={setAliases} combos={combos} setCombos={setCombos} models={models} />;
  if (route === "usage") return <Suspense fallback={<div className="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground" role="status">Loading usage dashboard…</div>}><Usage key={workspaceId} /></Suspense>;
  if (route === "budgets" && workspaceId) return <Budgets key={workspaceId} workspaceId={workspaceId} budgets={budgets} setBudgets={setBudgets} keys={initialGatewayKeys} />;
  if (route === "pricing") return <Pricing key={workspaceId} groups={priceGroups} setGroups={setPriceGroups} models={models} />;
  if (route === "logs" && workspaceId) return <ConsoleLog key={workspaceId} workspaceId={workspaceId} />;
  if (route === "settings") return <Settings onPasswordChanged={onPasswordChanged} />;
  return <ToolGateway key={workspaceId} route={route} onNavigate={onNavigate} />;
}

function WorkspaceUnavailable({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>{loading ? "Loading workspaces" : "Workspace unavailable"}</CardTitle>
          <CardDescription>
            {loading
              ? "Loading the workspace selector before opening this workspace-scoped page."
              : error ?? "No active workspace is available."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Spinner /> : <Button onClick={() => void onRetry()}>Retry workspace loading</Button>}
        </CardContent>
      </Card>
    </Page>
  );
}
