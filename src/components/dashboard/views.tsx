"use client";

import { lazy, Suspense, useState } from "react";
import { type DashboardRoute } from "@/components/app-sidebar";
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
  type Provider,
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
  selectedProvider: Provider | null;
  onSelectProvider: (provider: Provider | null) => void;
  onPasswordChanged: () => void | Promise<void>;
};

export function DashboardViews({
  route,
  onNavigate,
  selectedProvider,
  onSelectProvider,
  onPasswordChanged,
}: Props) {
  const keys = initialGatewayKeys;
  const [providers, setProviders] = useState(initialProviders);
  const [models, setModels] = useState(initialModels);
  const [codexModels, setCodexModels] = useState(initialCodexModels);
  const [aliases, setAliases] = useState(initialAliases);
  const [combos, setCombos] = useState(initialCombos);
  const [budgets, setBudgets] = useState(initialBudgets);
  const [priceGroups, setPriceGroups] = useState(initialPriceGroups);

  if (route === "endpoint") return <EndpointKeys />;
  if (route === "cliproxy") return <CliproxyPage />;
  if (route === "providers")
    return selectedProvider ? (
      <ProviderDetail
        provider={selectedProvider}
        setProvider={onSelectProvider}
        setProviders={setProviders}
        models={models}
        setModels={setModels}
      />
    ) : (
      <Providers
        providers={providers}
        setProviders={setProviders}
        onSelect={onSelectProvider}
        onNavigate={onNavigate}
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
