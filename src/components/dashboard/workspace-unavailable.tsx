import type { DashboardRoute } from "@/lib/dashboard-routes";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Page } from "@/components/dashboard/page-ui";

export function WorkspaceUnavailable({
  route,
  providerDetail,
  loading,
  error,
  onRetry,
}: {
  route: DashboardRoute;
  providerDetail: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  if (loading)
    return (
      <WorkspacePageSkeleton route={route} providerDetail={providerDetail} />
    );

  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Workspace unavailable</CardTitle>
          <CardDescription>
            {error ?? "No active workspace is available."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void onRetry()}>
            Retry workspace loading
          </Button>
        </CardContent>
      </Card>
    </Page>
  );
}

function WorkspacePageSkeleton({
  route,
  providerDetail,
}: {
  route: DashboardRoute;
  providerDetail: boolean;
}) {
  if (route === "endpoint") return <EndpointWorkspaceSkeleton />;
  if (route === "logs") return <ConsoleWorkspaceSkeleton />;
  if (route === "usage") return <UsageWorkspaceSkeleton />;
  if (route === "budgets") return <BudgetsWorkspaceSkeleton />;
  if (route === "pricing") return <PricingWorkspaceSkeleton />;
  if (route === "routing") return <RoutingWorkspaceSkeleton />;
  if (route === "providers" || route === "codex")
    return (
      <ProviderWorkspaceSkeleton
        route={route}
        providerDetail={providerDetail}
      />
    );
  return <ToolWorkspaceSkeleton route={route} />;
}

function SkeletonTable({
  columns,
  rows = 3,
}: {
  columns: number;
  rows?: number;
}) {
  const slots = Array.from(
    { length: columns },
    (_, index) => `column-${index}`,
  );
  const rowSlots = Array.from({ length: rows }, (_, index) => `row-${index}`);
  return (
    <div className="mt-6 overflow-hidden">
      <div
        className="grid gap-4 border-b px-2 pb-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {slots.map((slot) => (
          <Skeleton key={`header-${slot}`} className="h-3 w-20 max-w-full" />
        ))}
      </div>
      {rowSlots.map((row) => (
        <div
          key={row}
          className="grid min-h-14 items-center gap-4 border-b px-2 last:border-0"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {slots.map((slot) => (
            <Skeleton
              key={`${row}-${slot}`}
              className={
                slot === "column-0"
                  ? "h-4 w-36 max-w-full"
                  : "h-4 w-20 max-w-full"
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SkeletonCardHeader({ action = false }: { action?: boolean }) {
  return (
    <CardHeader>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      {action && (
        <CardAction>
          <Skeleton className="h-8 w-24" />
        </CardAction>
      )}
    </CardHeader>
  );
}

function EndpointWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading endpoint and keys"
        className="flex flex-col gap-8"
      >
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Skeleton className="size-5" />
              <Skeleton className="h-6 w-36" />
            </div>
            <Skeleton className="h-4 w-full max-w-xl" />
          </CardHeader>
          <CardContent>
            <div className="flex h-12 items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="size-7" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <div className="flex flex-col gap-3">
              {["key-1", "key-2", "key-3"].map((key) => (
                <div
                  key={key}
                  className="flex min-h-14 items-center gap-3 rounded-lg border bg-muted/30 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-2 h-3 w-52 max-w-full" />
                  </div>
                  <div className="flex gap-2">
                    <Skeleton className="size-7" />
                    <Skeleton className="size-7" />
                    <Skeleton className="size-7" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function ConsoleWorkspaceSkeleton() {
  return (
    <Page>
      <Card aria-busy="true" aria-label="Loading workspace console log">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-full max-w-xl" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-7 w-16" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 border-y py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex gap-2">
                {["all", "info", "warn", "error"].map((tab) => (
                  <Skeleton key={tab} className="h-8 w-14" />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Skeleton className="h-8 w-52 max-w-full" />
                <Skeleton className="h-5 w-16" />
              </div>
            </div>
            <div className="h-[min(55svh,36rem)] min-h-48 rounded-lg border bg-muted/20 p-4">
              <div className="flex flex-col gap-3">
                {[
                  "log-1",
                  "log-2",
                  "log-3",
                  "log-4",
                  "log-5",
                  "log-6",
                  "log-7",
                ].map((line) => (
                  <Skeleton key={line} className="h-3 w-full" />
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}

function ProviderWorkspaceSkeleton({
  route,
  providerDetail,
}: {
  route: "providers" | "codex";
  providerDetail: boolean;
}) {
  if (route === "providers" && providerDetail)
    return <ProviderDetailWorkspaceSkeleton />;
  if (route === "codex") return <CodexWorkspaceSkeleton />;
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading providers"
        className="flex flex-col gap-8"
      >
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <SkeletonTable columns={7} />
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            <SkeletonTable columns={6} rows={1} />
            <Skeleton className="mt-4 h-4 w-72 max-w-full" />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function ProviderDetailWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading provider details"
        className="flex flex-col gap-8"
      >
        <div>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="mt-3 h-8 w-56" />
          <Skeleton className="mt-2 h-4 w-44" />
        </div>
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              {["detail-1", "detail-2", "detail-3"].map((detail) => (
                <div key={detail} className="rounded-lg border bg-muted/20 p-3">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-2 h-4 w-28" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            <div className="flex gap-2">
              <Skeleton className="h-8 flex-1" />
              <Skeleton className="h-8 w-24" />
            </div>
            <div className="mt-3 flex flex-col gap-3">
              {["key-1", "key-2"].map((key) => (
                <div
                  key={key}
                  className="flex h-12 items-center gap-3 rounded-lg border p-3"
                >
                  <Skeleton className="size-7" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="size-6" />
                  <Skeleton className="size-6" />
                  <Skeleton className="size-7" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <SkeletonTable columns={5} />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function CodexWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading Codex providers"
        className="flex flex-col gap-8"
      >
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <SkeletonTable columns={6} />
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            <div className="flex flex-col gap-3">
              {["model-1", "model-2", "model-3"].map((model) => (
                <div
                  key={model}
                  className="flex h-14 items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-5 w-9" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function RoutingWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading model routing"
        className="flex flex-col gap-8"
      >
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <SkeletonTable columns={5} rows={3} />
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <SkeletonTable columns={4} rows={3} />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function UsageWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading usage dashboard"
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="flex flex-col gap-2 border-y py-3 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-8 w-52" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-8 w-40" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
          {["metric-1", "metric-2", "metric-3", "metric-4"].map((metric) => (
            <Card key={metric}>
              <CardHeader>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-full" />
              </CardHeader>
            </Card>
          ))}
        </div>
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
          {["chart-1", "chart-2"].map((chart) => (
            <Card key={chart} className="min-h-[28rem]">
              <SkeletonCardHeader />
              <CardContent>
                <Skeleton className="h-72 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <Card className="min-h-[28rem]">
            <SkeletonCardHeader />
            <CardContent>
              <SkeletonTable columns={5} rows={4} />
            </CardContent>
          </Card>
          <Card className="min-h-[28rem]">
            <SkeletonCardHeader />
            <CardContent>
              <Skeleton className="mx-auto size-56" />
              <div className="mt-4 flex flex-col gap-2">
                {["mix-1", "mix-2", "mix-3", "mix-4"].map((item) => (
                  <div
                    key={item}
                    className="flex items-center justify-between gap-2"
                  >
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function BudgetsWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading budgets"
        className="flex flex-col gap-8"
      >
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-36 w-full" />
              <Skeleton className="h-36 w-full" />
            </div>
            <div className="mt-6 flex gap-3">
              <Skeleton className="h-9 w-56" />
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-28" />
            </div>
            <SkeletonTable columns={5} />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function PricingWorkspaceSkeleton() {
  return (
    <Page>
      <div
        aria-busy="true"
        aria-label="Loading model pricing"
        className="flex flex-col gap-8"
      >
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            <Skeleton className="h-6 w-64" />
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader action />
          <CardContent>
            <SkeletonTable columns={5} />
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function ToolWorkspaceSkeleton({ route }: { route: DashboardRoute }) {
  const overview = route === "tool-overview";
  return (
    <main
      aria-busy="true"
      aria-label="Loading Tool Gateway"
      className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-6 w-28" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="h-4 w-full max-w-xl" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
        <Card>
          <SkeletonCardHeader />
          <CardContent>
            {overview ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  "tools",
                  "connections",
                  "policies",
                  "activity",
                  "settings",
                ].map((item) => (
                  <div key={item} className="rounded-lg border bg-muted/20 p-4">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="mt-2 h-4 w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
