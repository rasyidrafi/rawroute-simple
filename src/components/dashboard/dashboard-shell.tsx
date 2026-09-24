"use client";

import { useState } from "react";
import { AppSidebar, type DashboardRoute } from "@/components/app-sidebar";
import { PasswordChangeForm } from "@/components/dashboard/password-change-form";
import { DashboardViews } from "@/components/dashboard/views";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  cliproxy: "CLIProxyAPI",
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
  onPasswordChanged,
  isDefaultPassword,
  logoutError,
}: {
  onLogout: () => Promise<void>;
  onPasswordChanged: () => void | Promise<void>;
  isDefaultPassword: boolean;
  logoutError?: string | null;
}) {
  return (
    <TooltipProvider>
      <DashboardContent
        onLogout={onLogout}
        onPasswordChanged={onPasswordChanged}
        isDefaultPassword={isDefaultPassword}
        logoutError={logoutError}
      />
      <Toaster />
    </TooltipProvider>
  );
}

function DashboardContent({
  onLogout,
  onPasswordChanged,
  isDefaultPassword,
  logoutError,
}: {
  onLogout: () => Promise<void>;
  onPasswordChanged: () => void | Promise<void>;
  isDefaultPassword: boolean;
  logoutError?: string | null;
}) {
  const [route, setRoute] = useState<DashboardRoute>("endpoint");
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(
    null,
  );
  const toolRoute = route.startsWith("tool-");

  function navigate(nextRoute: DashboardRoute) {
    if (nextRoute === "providers") setSelectedProvider(null);
    setRoute(nextRoute);
  }

  return (
    <>
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
                <ThemeToggle className="ml-auto" />
              </div>
            </header>
            <DashboardViews
              route={route}
              onNavigate={navigate}
              selectedProvider={selectedProvider}
              onSelectProvider={setSelectedProvider}
              onPasswordChanged={onPasswordChanged}
            />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Dialog open={isDefaultPassword} onOpenChange={() => undefined}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>Change your administrator password</DialogTitle>
            <DialogDescription>
              Change your password to unlock the dashboard. This dialog stays
              open until the password is changed or you sign out.
            </DialogDescription>
          </DialogHeader>
          <PasswordChangeForm
            mode="dialog"
            requireCurrentPassword={!isDefaultPassword}
            onPasswordChanged={onPasswordChanged}
            onLogout={onLogout}
            logoutError={logoutError}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
