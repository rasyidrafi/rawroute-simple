"use client";

import { useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { AlertTriangleIcon, MoonIcon, SunIcon } from "lucide-react";
import { AppSidebar, type DashboardRoute } from "@/components/app-sidebar";
import { DashboardViews } from "@/components/dashboard/views";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Provider } from "@/mock/dashboard-data";

const titles: Record<DashboardRoute, string> = {
  endpoint: "Endpoint & Key",
  providers: "Providers",
  codex: "Codex Providers",
  routing: "Model routing",
  usage: "Usage",
  budgets: "Budgets",
  pricing: "Model Pricing",
  logs: "Console Log",
  settings: "Settings",
  "tool-overview": "Overview",
  "tool-tools": "Tools",
  "tool-connections": "Connections",
  "tool-policies": "Policies",
  "tool-activity": "Activity",
  "tool-settings": "Settings",
};

export function DashboardShell({
  onLogout,
  isDefaultPassword,
}: {
  onLogout: () => Promise<void>;
  isDefaultPassword: boolean;
}) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <TooltipProvider>
        <DashboardContent onLogout={onLogout} isDefaultPassword={isDefaultPassword} />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function DashboardContent({
  onLogout,
  isDefaultPassword,
}: {
  onLogout: () => Promise<void>;
  isDefaultPassword: boolean;
}) {
  const [route, setRoute] = useState<DashboardRoute>("endpoint");
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(
    null,
  );
  const { resolvedTheme, setTheme } = useTheme();
  const toolRoute = route.startsWith("tool-");

  function navigate(nextRoute: DashboardRoute) {
    if (nextRoute === "providers") setSelectedProvider(null);
    setRoute(nextRoute);
  }

  return (
    <SidebarProvider
      style={
        {
          "--header-height": "3rem",
          "--sidebar-width": "17rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar route={route} onNavigate={navigate} onLogout={onLogout} />
      <SidebarInset>
        <div className="flex min-h-0 flex-1 flex-col bg-[#f6f5f1] dark:bg-background">
          <header className="sticky top-0 z-30 flex h-[var(--header-height)] shrink-0 items-center border-b bg-background/90 backdrop-blur-md">
            <div className="flex w-full items-center gap-3 px-4 lg:px-6">
              <SidebarTrigger className="-ml-1" />
              <h1 className="min-w-0 truncate text-sm font-medium">
                {toolRoute ? (
                  <>
                    <span className="text-muted-foreground">Tool Gateway</span>
                    <span className="mx-2 text-muted-foreground">/</span>
                    {titles[route]}
                  </>
                ) : (
                  titles[route]
                )}
              </h1>
              <button
                type="button"
                className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Toggle theme"
                onClick={() =>
                  setTheme(resolvedTheme === "dark" ? "light" : "dark")
                }
              >
                {resolvedTheme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              </button>
            </div>
          </header>
          {isDefaultPassword && (
            <div role="alert" className="mx-4 mt-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100 md:mx-6">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>The administrator account is marked as using the default password. Review the Bun auth configuration before exposing this dashboard. No password value is shown here.</p>
            </div>
          )}
          <DashboardViews
            route={route}
            onNavigate={navigate}
            selectedProvider={selectedProvider}
            onSelectProvider={setSelectedProvider}
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
