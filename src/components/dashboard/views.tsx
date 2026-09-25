"use client";

import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { useLoggedState } from "@/hooks/use-logged-state";
import { dashboardPaths, type DashboardRoute } from "@/lib/dashboard-routes";
import { Budgets } from "@/components/dashboard/budgets-page";
import { CliproxyPage } from "@/components/dashboard/cliproxy-page";
import { CodexProviders } from "@/components/dashboard/codex-page";
import { ConsoleLog } from "@/components/dashboard/console-log-page";
import { EndpointKeys } from "@/components/dashboard/endpoint-page";
import { Pricing } from "@/components/dashboard/pricing-page";
import { ProviderDetail, Providers } from "@/components/dashboard/providers-page";
import { Routing } from "@/components/dashboard/routing-page";
import { Settings } from "@/components/dashboard/settings-page";
import { ToolGateway } from "@/components/dashboard/tool-gateway-page";
import {
  initialAliases,
  initialBudgets,
  initialCombos,
  initialCodexModels,
  initialGatewayKeys,
  initialModels,
  initialPriceGroups,
  initialProviders,
} from "@/mock/dashboard-data";

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
  const keys = initialGatewayKeys;
  const [providers, setProviders] = useLoggedState(initialProviders, "providers.changed");
  const [models, setModels] = useLoggedState(initialModels, "models.changed");
  const [codexModels, setCodexModels] = useLoggedState(initialCodexModels, "codex-models.changed");
  const [aliases, setAliases] = useLoggedState(initialAliases, "aliases.changed");
  const [combos, setCombos] = useLoggedState(initialCombos, "combos.changed");
  const [budgets, setBudgets] = useLoggedState(initialBudgets, "budgets.changed");
  const [priceGroups, setPriceGroups] = useLoggedState(initialPriceGroups, "pricing.changed");

  if (route === "endpoint") return <EndpointKeys />;
  if (route === "cliproxy") return <CliproxyPage />;
  if (route === "providers")
    return providerDetail ? (providers.find((provider) => provider.id === providerId) ? (
      <ProviderDetail
        key={providerId}
        provider={providers.find((provider) => provider.id === providerId)!}
        setProviders={setProviders}
        models={models}
        setModels={setModels}
      />) : <main className="flex-1 p-6"><h2 className="text-xl font-semibold">Provider not found</h2><Link to={dashboardPaths.providers}>Back to providers</Link></main>
    ) : (
      <Providers
        providers={providers}
        setProviders={setProviders}
      />
    );
  if (route === "codex")
    return <CodexProviders models={codexModels} setModels={setCodexModels} />;
  if (route === "routing")
    return (
      <Routing
        aliases={aliases}
        setAliases={setAliases}
        combos={combos}
        setCombos={setCombos}
        models={models}
      />
    );
  if (route === "usage")
    return (
      <Suspense
        fallback={
          <div className="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground" role="status">
            Loading usage dashboard…
          </div>
        }
      >
        <Usage />
      </Suspense>
    );
  if (route === "budgets")
    return <Budgets budgets={budgets} setBudgets={setBudgets} keys={keys} />;
  if (route === "pricing")
    return (
      <Pricing
        groups={priceGroups}
        setGroups={setPriceGroups}
        models={models}
      />
    );
  if (route === "logs") return <ConsoleLog />;
  if (route === "settings")
    return <Settings onPasswordChanged={onPasswordChanged} />;
  return <ToolGateway route={route} onNavigate={onNavigate} />;
}
