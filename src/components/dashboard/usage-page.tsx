"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { RefreshCwIcon } from "lucide-react";
import { Page } from "@/components/dashboard/page-ui";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accountingFetch } from "@/lib/accounting-client";
import { runLatestRequest, useLatestRequest } from "./use-latest-request";

type Budget = { limitMicros: number; enabled: boolean; spentMicros: number; reservedMicros: number; remainingMicros: number; utilization: number; windowStart: number; windowEnd: number; bypass: boolean };
type Row = { id: string; name?: string; status?: string; requests: number; tokens: number; costMicros: number; lastUsedAt?: number; modelsUsed?: string[]; budget?: Budget };
type Data = { timeZone: string; freshness: number; unlimited?: boolean; range: { label: string; granularity: string; from: number; to: number }; summary: { requests: number; tokens: number; costMicros: number; exactRequests: number; assumedRequests: number; unpricedRequests: number }; trend: Array<{ label: string; requests: number; costMicros: number }>; keys: Row[]; models: Row[] };

const money = (value: number) => `$${(value / 1_000_000).toFixed(4)}`;
const presets = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["lastWeek", "Last week"], ["month", "This month"], ["lastMonth", "Last month"], ["year", "This year"], ["budget", "Budget window"], ["custom", "Custom dates"], ["all", "All time"]] as const;
const granularities = [["auto", "Auto"], ["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const;
const ordering = [["usage", "Highest usage first"], ["recent", "Most recent first"], ["name", "API key name"]] as const;

export function Usage({ workspaceId }: { workspaceId: string }) {
  const [preset, setPreset] = useState("week"); const [granularity, setGranularity] = useState("auto"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [sortBy, setSortBy] = useState<(typeof ordering)[number][0]>("usage"); const [data, setData] = useState<Data>(); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(false);
  const requests = useLatestRequest();
  const load = useCallback(async () => {
    if (preset === "custom" && (!from || !to || from > to)) {
      requests.invalidate();
      setError("Choose an inclusive start and end date.");
      setLoading(false);
      return;
    }
    const parameters = new URLSearchParams({ preset });
    if (granularity !== "auto") parameters.set("granularity", granularity);
    if (preset === "custom") { parameters.set("from", from); parameters.set("to", to); }
    await runLatestRequest(requests, (signal) => accountingFetch<Data>(workspaceId, `/api/usage?${parameters}`, { signal }), {
      onStart: () => { setLoading(true); setError(undefined); },
      onSuccess: setData,
      onError: (reason) => setError(reason instanceof Error ? reason.message : "Usage could not load."),
      onFinally: () => setLoading(false),
    });
  }, [from, granularity, preset, requests, to, workspaceId]);
  useEffect(() => {
    if (preset === "custom" && (!from || !to)) {
      requests.invalidate();
      setLoading(false);
      return;
    }
    void load();
  }, [from, load, preset, requests, to]);
  const keys = useMemo(() => [...(data?.keys ?? [])].sort((left, right) => sortBy === "name" ? (left.name ?? left.id).localeCompare(right.name ?? right.id) : sortBy === "recent" ? (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) : right.costMicros - left.costMicros || right.requests - left.requests), [data?.keys, sortBy]);
  return <Page><Card><CardHeader><CardTitle>Usage dashboard</CardTitle><CardDescription>{data ? `${data.range.label} · ${data.range.granularity} · ${data.timeZone} · refreshed ${new Intl.DateTimeFormat("en-GB", { timeZone: data.timeZone, timeStyle: "medium" }).format(data.freshness)}` : loading ? "Loading usage" : "Choose a range to load usage."}</CardDescription><CardAction><div className="flex flex-wrap gap-2"><UsageSelect value={preset} label="Range" options={presets} onChange={setPreset} /><UsageSelect value={granularity} label="Grouping" options={granularities} onChange={setGranularity} /><Button variant="outline" onClick={() => void load()}><RefreshCwIcon data-icon="inline-start" />Refresh</Button></div></CardAction></CardHeader>{preset === "custom" ? <CardContent><FieldGroup className="sm:flex-row"><Field><FieldLabel htmlFor="usage-from">From</FieldLabel><Input id="usage-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field><Field><FieldLabel htmlFor="usage-to">To</FieldLabel><Input id="usage-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></Field></FieldGroup></CardContent> : null}</Card>{error ? <Card><CardContent className="py-4 text-sm text-destructive" role="alert">{error}</CardContent></Card> : null}{data ? <><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><Metric label="Requests" value={data.summary.requests.toLocaleString()} /><Metric label="Tokens" value={data.summary.tokens.toLocaleString()} /><Metric label="Selected range cost" value={money(data.summary.costMicros)} /><Metric label="Pricing confidence" value={`${data.summary.exactRequests} exact · ${data.summary.assumedRequests} assumed · ${data.summary.unpricedRequests} unpriced`} /></div><Trend data={data} /><UsageTable rows={keys} sortBy={sortBy} onSort={setSortBy} /><SummaryTable title="Models" rows={data.models} /></> : null}</Page>;
}

function UsageSelect<T extends string>({ value, label, options, onChange }: { value: T; label: string; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) { return <Select value={value} onValueChange={(next) => next && onChange(next as T)}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{label}</SelectLabel>{options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectGroup></SelectContent></Select>; }
function Metric({ label, value }: { label: string; value: string }) { return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader></Card>; }
function Trend({ data }: { data: Data }) { return <Card><CardHeader><CardTitle>Requests and spend</CardTitle><CardDescription>Selected range trend</CardDescription></CardHeader><CardContent><ChartContainer config={{ requests: { label: "Requests", color: "var(--chart-1)" }, cost: { label: "Cost", color: "var(--chart-2)" } }} className="h-72 w-full"><AreaChart data={data.trend.map((item) => ({ ...item, cost: item.costMicros / 1_000_000 }))}><CartesianGrid vertical={false} /><XAxis dataKey="label" /><YAxis yAxisId="requests" /><YAxis yAxisId="cost" orientation="right" /><ChartTooltip content={<ChartTooltipContent />} /><Area yAxisId="requests" type="monotone" dataKey="requests" stroke="var(--color-requests)" fill="var(--color-requests)" fillOpacity={0.18} /><Area yAxisId="cost" type="monotone" dataKey="cost" stroke="var(--color-cost)" fill="var(--color-cost)" fillOpacity={0.12} /></AreaChart></ChartContainer></CardContent></Card>; }
function UsageTable({ rows, sortBy, onSort }: { rows: Row[]; sortBy: (typeof ordering)[number][0]; onSort: (value: (typeof ordering)[number][0]) => void }) { return <Card><CardHeader><CardTitle>Usage by key</CardTitle><CardDescription>Cost is for the selected range. Budget usage is always the current budget window.</CardDescription><CardAction><UsageSelect value={sortBy} label="Order rows by" options={ordering} onChange={onSort} /></CardAction></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead><TableHead>Selected range cost</TableHead><TableHead>Models</TableHead><TableHead>Current budget window</TableHead><TableHead>Last used</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.id}><TableCell><div className="font-medium">{row.name ?? row.id}</div><div className="text-xs text-muted-foreground">{row.status ?? row.id}</div></TableCell><TableCell>{row.requests.toLocaleString()}</TableCell><TableCell>{row.tokens.toLocaleString()}</TableCell><TableCell>{money(row.costMicros)}</TableCell><TableCell>{row.modelsUsed?.join(", ") || "—"}</TableCell><TableCell><BudgetUsage budget={row.budget} /></TableCell><TableCell>{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : "—"}</TableCell></TableRow>)}{!rows.length ? <TableRow><TableCell colSpan={7} className="text-center">No usage in this range.</TableCell></TableRow> : null}</TableBody></Table></CardContent></Card>; }
function BudgetUsage({ budget }: { budget?: Budget }) { if (!budget) return "—"; if (budget.bypass) return <div className="flex flex-col gap-1"><span>Unlimited</span><span className="text-xs text-muted-foreground">{money(budget.spentMicros)} spent this window</span></div>; const percent = Math.min(100, Math.round(budget.utilization * 100)); return <div className="flex min-w-48 flex-col gap-1"><span className="text-xs">{money(budget.spentMicros)} spent · {money(budget.remainingMicros)} remaining</span><Progress value={percent} /><span className="text-xs text-muted-foreground">{percent}% utilized{budget.reservedMicros ? ` · ${money(budget.reservedMicros)} reserved` : ""}</span></div>; }
function SummaryTable({ title, rows }: { title: string; rows: Row[] }) { return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>Selected range totals only.</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead><TableHead>Cost</TableHead></TableRow></TableHeader><TableBody>{rows.map((item) => <TableRow key={item.id}><TableCell>{item.name ?? item.id}</TableCell><TableCell>{item.requests.toLocaleString()}</TableCell><TableCell>{item.tokens.toLocaleString()}</TableCell><TableCell>{money(item.costMicros)}</TableCell></TableRow>)}{!rows.length ? <TableRow><TableCell colSpan={4} className="text-center">No usage in this range.</TableCell></TableRow> : null}</TableBody></Table></CardContent></Card>; }
