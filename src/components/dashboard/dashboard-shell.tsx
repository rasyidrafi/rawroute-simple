"use client";

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { reportEvent } from "@/lib/logging/client";
import { AppSidebar } from "@/components/app-sidebar";
import { useWorkspace } from "@/components/workspace-provider";
import { dashboardPage, dashboardPaths, dashboardRouteMeta, providerIdFromPath, type DashboardRoute } from "@/lib/dashboard-routes";
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
import { Badge } from "@/components/ui/badge";

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
  const location = useLocation();
  const navigateTo = useNavigate();
  const page = dashboardPage(location.pathname);
  const route: DashboardRoute = page === "provider-detail" ? "providers" : page ?? "endpoint";
  const providerId = page === "provider-detail" ? providerIdFromPath(location.pathname) : undefined;
  const toolRoute = route.startsWith("tool-");
  const { activeWorkspace, activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace();
  const scope = dashboardRouteMeta[route].scope;

  useEffect(() => {
    if (page) reportEvent("dashboard.navigation", {
      page: route,
      workspaceId: dashboardRouteMeta[route].scope === "workspace" ? activeWorkspaceId : null,
    });
  }, [activeWorkspaceId, location.pathname, page, route]);

  useEffect(() => {
    if (isDefaultPassword) return;
    // Browser-global errors have no reliable operation provenance. Keeping them
    // global avoids falsely assigning a delayed error from workspace A to B.
    const onError = () => reportEvent("dashboard.error");
    const onRejection = () => reportEvent("dashboard.rejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [isDefaultPassword]);

  function navigate(nextRoute: DashboardRoute) {
    navigateTo(dashboardPaths[nextRoute]);
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
                 <Badge variant="outline" className="hidden sm:inline-flex">
                   {scope === "global"
                      ? "Global"
                      : activeWorkspace
                        ? route === "logs"
                          ? "Workspace"
                          : "Workspace mock · browser only"
                       : isWorkspaceLoading
                         ? "Loading workspace"
                         : "Workspace unavailable"}
                 </Badge>
                 <ThemeToggle className="ml-auto" />
              </div>
            </header>
            <DashboardViews
              route={route}
              onNavigate={navigate}
              providerId={providerId}
              providerDetail={page === "provider-detail"}
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
