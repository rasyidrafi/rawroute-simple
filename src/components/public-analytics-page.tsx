import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Workspace = { id: string; name: string };
type Row = { name: string; requests: number; tokens: number; costMicros: number };
type Dashboard = {
  timeZone: string;
  freshness: number;
  range: { label: string; granularity: string; from: number; to: number };
  summary: { requests: number; tokens: number; costMicros: number; exactRequests: number; assumedRequests: number; unpricedRequests: number; activeKeys: number };
  pricingConfidence: { exactRequests: number; assumedRequests: number; unpricedRequests: number };
  trend: Array<{ label: string; requests: number; tokens: number; costMicros: number }>;
  keys: Row[];
  models: Row[];
};

const presets = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["lastWeek", "Last week"],
  ["month", "This month"], ["lastMonth", "Last month"], ["year", "This year"], ["all", "All time"],
  ["custom", "Custom dates"], ["budget", "Budget window"],
] as const;
const granularities = [["", "Auto"], ["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const;
const PublicUsageTrend = lazy(() => import("@/components/public-analytics-trend").then(({ PublicUsageTrend }) => ({ default: PublicUsageTrend })));

function money(value: number): string { return `$${(value / 1_000_000).toFixed(4)}`; }

function Metric({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader><CardTitle>{label}</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{value}</p></CardContent></Card>;
}

function SummaryTable({ title, rows }: { title: string; rows: Row[] }) {
  return <Card>
    <CardHeader><CardTitle>{title}</CardTitle><CardDescription>Aggregate labels only; no credentials or request content are shown.</CardDescription></CardHeader>
    <CardContent>
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead><TableHead>Cost</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => <TableRow key={row.name}><TableCell>{row.name}</TableCell><TableCell>{row.requests}</TableCell><TableCell>{row.tokens.toLocaleString()}</TableCell><TableCell>{money(row.costMicros)}</TableCell></TableRow>)}
          {!rows.length ? <TableRow><TableCell colSpan={4}>No usage in this range.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </CardContent>
  </Card>;
}

export function PublicAnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspacesError, setWorkspacesError] = useState<string>();
  const [data, setData] = useState<Dashboard>();
  const [dataError, setDataError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const workspaceRequest = useRef(0);
  const workspaceController = useRef<AbortController | undefined>(undefined);
  const dashboardRequest = useRef(0);
  const selectedWorkspaceId = searchParams.get("workspace") ?? "";
  const hasWorkspaceParameter = searchParams.has("workspace");
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const preset = searchParams.get("preset") ?? "week";
  const granularity = searchParams.get("granularity") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const refreshedAt = useMemo(() => data ? new Intl.DateTimeFormat("en-GB", { timeZone: data.timeZone, timeStyle: "medium" }).format(data.freshness) : "", [data]);

  const update = useCallback((values: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [name, value] of Object.entries(values)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const reloadWorkspaces = useCallback(async () => {
    workspaceController.current?.abort();
    const request = ++workspaceRequest.current;
    const controller = new AbortController();
    workspaceController.current = controller;
    setWorkspacesLoading(true);
    try {
      const response = await fetch("/api/public/workspaces", { credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Workspaces could not load.");
      const value = await response.json() as { workspaces: Workspace[] };
      if (controller.signal.aborted || request !== workspaceRequest.current) return;
      setWorkspaces(value.workspaces);
      setWorkspacesError(undefined);
    } catch (error) {
      if (controller.signal.aborted || request !== workspaceRequest.current) return;
      setWorkspacesError(error instanceof Error ? error.message : "Workspaces could not load.");
    } finally {
      if (!controller.signal.aborted && request === workspaceRequest.current) setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadWorkspaces();
    return () => workspaceController.current?.abort();
  }, [reloadWorkspaces]);

  useEffect(() => {
    if (workspacesLoading) return;
    if (!hasWorkspaceParameter) {
      if (workspaces.length) update({ workspace: workspaces[0]!.id });
      else { setData(undefined); setDataError("No active workspaces are available."); }
      return;
    }
    if (!workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setData(undefined);
      setDataError("Selected workspace is unavailable.");
    }
  }, [hasWorkspaceParameter, selectedWorkspaceId, update, workspaces, workspacesLoading]);

  useEffect(() => {
    if (workspacesLoading || !selectedWorkspaceId || !workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setData(undefined);
      return;
    }
    const request = ++dashboardRequest.current;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ workspace: selectedWorkspaceId, preset });
    if (granularity) parameters.set("granularity", granularity);
    if (preset === "custom") {
      if (from) parameters.set("from", from);
      if (to) parameters.set("to", to);
    }
    setData(undefined);
    setDataError(undefined);
    fetch(`/api/public/dashboard?${parameters}`, { credentials: "omit", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as Dashboard & { error?: string };
        if (!response.ok) throw Object.assign(new Error(value.error ?? "Usage could not load."), { status: response.status });
        return value;
      })
      .then((value) => {
        if (controller.signal.aborted || request !== dashboardRequest.current) return;
        setData(value);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || request !== dashboardRequest.current) return;
        setData(undefined);
        setDataError(error instanceof Error ? error.message : "Usage could not load.");
        if ((error as { status?: number }).status === 404) void reloadWorkspaces();
      });
    return () => controller.abort();
  }, [from, granularity, preset, refresh, reloadWorkspaces, selectedWorkspaceId, to, workspaces, workspacesLoading]);

  return <main className="min-h-svh bg-background p-4 sm:p-8">
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1"><h1 className="text-3xl font-semibold tracking-tight">RawRoute usage</h1><p className="text-sm text-muted-foreground">Public aggregate analytics for a selected workspace.</p></div>
        <a className="text-sm underline underline-offset-4" href="/dashboard/ai/endpoint">Administrator sign-in</a>
      </header>
      <Card>
        <CardHeader><CardTitle>Usage filters</CardTitle><CardDescription>Select a workspace and reporting range. Dates use the accounting timezone.</CardDescription><CardAction><Button variant="outline" onClick={() => { void reloadWorkspaces(); setRefresh((value) => value + 1); }}><RefreshCwIcon data-icon="inline-start" />Refresh</Button></CardAction></CardHeader>
        <CardContent>
          <FieldGroup className="grid md:grid-cols-3">
            <Field><FieldLabel>Workspace</FieldLabel><Select value={selectedWorkspaceId || null} onValueChange={(value) => value && update({ workspace: value })}><SelectTrigger className="w-full"><SelectValue placeholder={workspacesLoading ? "Loading workspaces" : "Select workspace"}>{selectedWorkspace?.name}</SelectValue></SelectTrigger><SelectContent><SelectGroup>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            <Field><FieldLabel>Range</FieldLabel><Select value={preset} onValueChange={(value) => value && update({ preset: value, ...(value === "custom" ? {} : { from: null, to: null }) })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{presets.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            <Field><FieldLabel>Granularity</FieldLabel><Select value={granularity || "auto"} onValueChange={(value) => update({ granularity: value === "auto" ? null : value })}><SelectTrigger className="w-full"><SelectValue placeholder="Auto" /></SelectTrigger><SelectContent><SelectGroup>{granularities.map(([value, label]) => <SelectItem key={value || "auto"} value={value || "auto"}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            {preset === "custom" ? <><Field><FieldLabel htmlFor="public-usage-from">From</FieldLabel><Input id="public-usage-from" type="date" value={from} onChange={(event) => update({ from: event.target.value })} /></Field><Field><FieldLabel htmlFor="public-usage-to">To</FieldLabel><Input id="public-usage-to" type="date" value={to} onChange={(event) => update({ to: event.target.value })} /></Field></> : null}
          </FieldGroup>
          {workspacesError ? <p className="mt-4 text-sm text-destructive" role="alert">{workspacesError}</p> : null}
          {dataError ? <p className="mt-4 text-sm text-destructive" role="alert">{dataError}</p> : null}
        </CardContent>
      </Card>
      {!data && !dataError ? <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div> : null}
      {data ? <><p className="text-sm text-muted-foreground">{data.range.label} · {data.range.granularity} · {data.timeZone} · refreshed {refreshedAt}</p><section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Requests" value={data.summary.requests.toLocaleString()} /><Metric label="Tokens" value={data.summary.tokens.toLocaleString()} /><Metric label="Cost" value={money(data.summary.costMicros)} /><Metric label="Active keys" value={data.summary.activeKeys.toLocaleString()} /></section><p className="text-sm text-muted-foreground">Pricing confidence: {data.pricingConfidence.exactRequests} exact · {data.pricingConfidence.assumedRequests} assumed · {data.pricingConfidence.unpricedRequests} unpriced.</p><Suspense fallback={<Skeleton className="h-72" />}><PublicUsageTrend trend={data.trend} /></Suspense><section className="grid gap-4 lg:grid-cols-2"><SummaryTable title="Keys" rows={data.keys} /><SummaryTable title="Models" rows={data.models} /></section></> : null}
    </section>
  </main>;
}
