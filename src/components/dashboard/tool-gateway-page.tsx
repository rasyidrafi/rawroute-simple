"use client";

import { WrenchIcon } from "lucide-react";
import type { DashboardRoute } from "@/components/app-sidebar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Props = {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
};

export function ToolGateway({ route, onNavigate }: Props) {
  const page = route.replace("tool-", "") as
    "overview" | "tools" | "connections" | "policies" | "activity" | "settings";
  const pageCopy: Record<
    Exclude<typeof page, "overview">,
    { title: string; description: string }
  > = {
    tools: {
      title: "Tools",
      description:
        "The Bun + React clone does not mount an Executor tools API or browser manager. This page is a visual mock only.",
    },
    connections: {
      title: "Connections",
      description:
        "No Executor connection API is mounted in this clone, so connections cannot be listed or edited here.",
    },
    policies: {
      title: "Policies",
      description:
        "No Executor policy API is mounted in this clone. Workspace-scoped policy controls are not available.",
    },
    activity: {
      title: "Activity",
      description:
        "This clone has no Executor activity or logs route, so no live event data is available.",
    },
    settings: {
      title: "Settings",
      description:
        "Executor is not configured by this clone. There are no Tool Gateway settings to display.",
    },
  };
  const navigation = [
    "tools",
    "connections",
    "policies",
    "activity",
    "settings",
  ] as const;
  return (
    <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Tool Gateway</CardTitle>
            <Badge variant="outline">Not available</Badge>
            <Badge variant="secondary">Local mock</Badge>
          </div>
          <CardDescription>
            This Bun + React clone does not include the optional Executor service or an API proxy route. The navigation below is presentation-only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No Tool Gateway API is mounted by this clone. The only server routes are authentication, health, database health, and the hello example.
          </div>
        </CardContent>
      </Card>
      {page === "overview" ? (
        <Card>
          <CardHeader>
            <CardTitle>Tool Gateway overview</CardTitle>
            <CardDescription>
              This overview preserves the original page hierarchy while clearly marking the integration as unavailable in this local mock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {navigation.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="rounded-lg border bg-muted/20 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onNavigate(`tool-${item}` as DashboardRoute)}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <WrenchIcon className="size-4" />
                    {item[0].toUpperCase() + item.slice(1)}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                  Open the local mock page; no Executor data is connected.
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{pageCopy[page].title}</CardTitle>
            <CardDescription>{pageCopy[page].description}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No workspace-scoped Executor data is shown in RawRoute.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
    </main>
  );
}
