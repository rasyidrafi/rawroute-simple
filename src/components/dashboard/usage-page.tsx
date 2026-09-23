"use client";

import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ActivityIcon, BarChart3Icon, CalendarDaysIcon, KeyRoundIcon, RefreshCwIcon, WalletCardsIcon } from "lucide-react";
import { notify, Page } from "@/components/dashboard/page-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { modelMix, usageTrend } from "@/mock/dashboard-data";

const trendConfig = { requests: { label: "Requests", color: "#18181b" }, cost: { label: "Cost", color: "#a16207" } } satisfies ChartConfig;
const mixConfig = { gpt: { label: "GPT-5", color: "#18181b" }, sonnet: { label: "Sonnet", color: "#71717a" }, haiku: { label: "Haiku", color: "#a1a1aa" }, llama: { label: "Llama", color: "#d4d4d8" } } satisfies ChartConfig;

export function Usage() {
  const [period, setPeriod] = useState("Last 7 days");
  const [grouping, setGrouping] = useState("Daily");
  const [selectedRange, setSelectedRange] = useState<DateRange>();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const latestDate = usageTrend[usageTrend.length - 1].date;
  const firstDate = usageTrend[0].date;
  const toIsoDate = (date: Date) => `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
  const fromIsoDate = (date: string) => new Date(`${date}T12:00:00`);
  const rangeStart = period === "Today"
    ? latestDate
    : period === "Last 30 days"
      ? "2026-08-24"
      : period === "Custom range"
        ? selectedRange?.from ? toIsoDate(selectedRange.from) : ""
        : firstDate;
  const rangeEnd = period === "Custom range"
    ? selectedRange?.to ? toIsoDate(selectedRange.to) : ""
    : latestDate;
  const filteredTrend = usageTrend.filter((point) =>
    Boolean(rangeStart && rangeEnd && point.date >= rangeStart && point.date <= rangeEnd),
  );
  const totals = filteredTrend.reduce(
    (sum, point) => ({
      requests: sum.requests + point.requests,
      tokens: sum.tokens + point.tokens,
      cost: sum.cost + point.cost,
    }),
    { requests: 0, tokens: 0, cost: 0 },
  );
  const keyTotals = [
    { name: "Production gateway", requests: 2190, tokens: 18_200_000, cost: 51.08 },
    { name: "Developer sandbox", requests: 1246, tokens: 9_600_000, cost: 22.13 },
    { name: "CI evaluation", requests: 528, tokens: 3_100_000, cost: 8.19 },
  ];
  const fullTotals = usageTrend.reduce(
    (sum, point) => ({
      requests: sum.requests + point.requests,
      tokens: sum.tokens + point.tokens,
      cost: sum.cost + point.cost,
    }),
    { requests: 0, tokens: 0, cost: 0 },
  );
  let allocatedRequests = 0;
  let allocatedTokens = 0;
  let allocatedCost = 0;
  const usageByKey = filteredTrend.length
    ? keyTotals.map((key, index) => {
        const last = index === keyTotals.length - 1;
        const row = {
          ...key,
          requests: last ? totals.requests - allocatedRequests : Math.round(key.requests / fullTotals.requests * totals.requests),
          tokens: last ? totals.tokens - allocatedTokens : Math.round(key.tokens / fullTotals.tokens * totals.tokens),
          cost: last ? totals.cost - allocatedCost : key.cost / fullTotals.cost * totals.cost,
        };
        allocatedRequests += row.requests;
        allocatedTokens += row.tokens;
        allocatedCost += row.cost;
        return row;
      })
    : [];
  const topKeys = usageByKey.slice().sort((a, b) => b.cost - a.cost);
  const displayedRange = period === "Custom range"
    ? selectedRange
    : period === "Today"
      ? { from: fromIsoDate(latestDate), to: fromIsoDate(latestDate) }
      : {
          from: fromIsoDate(period === "Last 30 days" ? "2026-08-24" : firstDate),
          to: fromIsoDate(latestDate),
        };
  const chartData = grouping === "Weekly"
    ? Array.from(
        filteredTrend.reduce((weeks, point) => {
          const monday = fromIsoDate(point.date);
          monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
          const weekKey = toIsoDate(monday);
          const bucket = weeks.get(weekKey) ?? { day: `Week of ${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, requests: 0, cost: 0 };
          bucket.requests += point.requests;
          bucket.cost += point.cost;
          weeks.set(weekKey, bucket);
          return weeks;
        }, new Map<string, { day: string; requests: number; cost: number }>()).values(),
      )
    : filteredTrend;
  const formatTokens = (tokens: number) => tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens.toLocaleString();
  return (
    <Page>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Usage dashboard</h2>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{period}</span><span>{grouping} buckets</span><span>Updated just now</span>
          </div>
        </div>
        <div className="flex items-center gap-2"><Badge variant="outline">Mock data</Badge><Button variant="outline" onClick={() => notify("Mock usage refreshed")}><RefreshCwIcon />Refresh</Button></div>
      </div>
      <div className="border-y border-border/70 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-muted-foreground">Range</span>
            <Select value={period} onValueChange={(value) => {
              if (value === null) return;
              setPeriod(value);
              if (value === "Custom range") setCalendarOpen(true);
              else setSelectedRange(undefined);
            }}>
              <SelectTrigger className="h-8 min-w-0 sm:w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="Today">Today</SelectItem><SelectItem value="Last 7 days">Last 7 days</SelectItem><SelectItem value="Last 30 days">Last 30 days</SelectItem><SelectItem value="Custom range">Custom range</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger
                render={
                  <Button variant="outline" className="h-8 min-w-0 justify-between sm:w-[220px]">
                    <span className="truncate font-normal">
                      {displayedRange?.from
                        ? `${displayedRange.from.toLocaleDateString()}${displayedRange.to ? ` - ${displayedRange.to.toLocaleDateString()}` : ""}`
                        : "Select date range"}
                    </span>
                    <CalendarDaysIcon />
                  </Button>
                }
              />
              <PopoverContent align="start" className="w-auto">
                <Calendar autoFocus mode="range" defaultMonth={displayedRange?.from} selected={displayedRange} onSelect={(range) => {
                  setSelectedRange(range);
                  if (range?.from && range.to) {
                    setPeriod("Custom range");
                    setCalendarOpen(false);
                  }
                }} numberOfMonths={1} />
              </PopoverContent>
            </Popover>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">Group</span>
              <Select value={grouping} onValueChange={(value) => value !== null && setGrouping(value)}>
                <SelectTrigger className="h-8 min-w-0 sm:w-[190px]"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="Hourly" disabled>Hourly (not available in mock data)</SelectItem><SelectItem value="Daily">Daily</SelectItem><SelectItem value="Weekly">Weekly</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
      {period === "Last 30 days" && <p className="text-xs text-muted-foreground">Only Sep 16–22, 2026 mock samples are available; no older usage is fabricated.</p>}
      <section className="space-y-4">
        <div><h3 className="text-lg font-semibold tracking-tight">Usage summary</h3><p className="text-sm text-muted-foreground">High-level totals for the currently selected range.</p></div>
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
          <Metric icon={BarChart3Icon} label="Requests" value={totals.requests.toLocaleString()} detail="Total request volume in the selected range." />
          <Metric icon={ActivityIcon} label="Tokens" value={formatTokens(totals.tokens)} detail="Input, output, and cache tokens combined." />
          <Metric icon={WalletCardsIcon} label="API-equivalent cost" value={`$${totals.cost.toFixed(2)}`} detail="Calculated from configured model pricing." />
          <Metric icon={KeyRoundIcon} label="Active keys" value={String(usageByKey.filter((key) => key.requests > 0).length)} detail="Keys with mock traffic in this window." />
        </div>
      </section>
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
        <Card className="min-h-[28rem]">
          <CardHeader><CardDescription>Trend</CardDescription><CardTitle>Requests and spend</CardTitle><CardAction><Badge variant="outline">{period}</Badge></CardAction></CardHeader>
          <CardContent className="min-h-0 flex-1">
            <ChartContainer config={trendConfig} className="h-full min-h-80 w-full">
              <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <defs><linearGradient id="usage-requests" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--color-requests)" stopOpacity={0.28} /><stop offset="100%" stopColor="var(--color-requests)" stopOpacity={0.03} /></linearGradient></defs>
                <CartesianGrid vertical={false} /><XAxis dataKey="day" tickLine={false} axisLine={false} /><YAxis yAxisId="left" tickLine={false} axisLine={false} /><YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                <Area yAxisId="left" dataKey="requests" type="monotone" stroke="var(--color-requests)" fill="url(#usage-requests)" strokeWidth={2} />
                <Area yAxisId="right" dataKey="cost" type="monotone" stroke="var(--color-cost)" fill="none" strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
            {!chartData.length && <p className="mt-2 text-center text-sm text-muted-foreground">No mock usage falls within this range.</p>}
          </CardContent>
        </Card>
        <Card className="min-h-[28rem]">
          <CardHeader><CardDescription>Concentration</CardDescription><CardTitle>Top keys by cost</CardTitle></CardHeader>
          <CardContent>
            <div className="flex min-h-0 flex-1 flex-col gap-4">
            {topKeys.length ? <ChartContainer config={{ cost: { label: "Cost", color: "#52525b" } }} className="h-52 w-full">
              <BarChart data={topKeys} layout="vertical" margin={{ left: 4, right: 8 }}><CartesianGrid horizontal={false} /><XAxis type="number" hide /><YAxis dataKey="name" type="category" width={116} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent formatter={(value) => <span>${Number(value).toFixed(2)}</span>} />} /><Bar dataKey="cost" radius={8}>{topKeys.map((item, index) => <Cell key={item.name} fill={["#27272a", "#71717a", "#a1a1aa"][index]} />)}</Bar></BarChart>
            </ChartContainer> : <p className="py-8 text-center text-sm text-muted-foreground">No keys have usage in this range.</p>}
            <div className="flex flex-col gap-2">{topKeys.map((item) => <div key={item.name} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.requests.toLocaleString()} requests</div></div><div className="text-sm font-medium tabular-nums">${item.cost.toFixed(2)}</div></div>)}</div>
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Card className="min-h-[28rem]"><CardHeader><CardDescription>Per-key detail</CardDescription><CardTitle>Usage table</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>No</TableHead><TableHead>Name</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">API-equivalent cost</TableHead></TableRow></TableHeader><TableBody>{usageByKey.length ? usageByKey.map((key, index) => <TableRow key={key.name}><TableCell><span className="text-muted-foreground">{index + 1}</span></TableCell><TableCell><span className="font-medium">{key.name}</span></TableCell><TableCell className="text-right"><span className="tabular-nums">{key.requests.toLocaleString()}</span></TableCell><TableCell className="text-right"><span className="tabular-nums">{formatTokens(key.tokens)}</span></TableCell><TableCell className="text-right"><span className="tabular-nums">${key.cost.toFixed(2)}</span></TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-24 text-center"><span className="text-muted-foreground">No mock usage in this range.</span></TableCell></TableRow>}</TableBody></Table></CardContent></Card>
        <Card className="min-h-[28rem]"><CardHeader><CardDescription>Model mix</CardDescription><CardTitle>Spend allocation</CardTitle></CardHeader><CardContent><div className="flex flex-col gap-4">
          {usageByKey.length ? <><ChartContainer config={mixConfig} className="mx-auto h-56 w-full max-w-72"><PieChart><ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} /><Pie data={modelMix} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3} /></PieChart></ChartContainer>
           <div className="flex flex-col gap-2">{modelMix.map((item) => <div key={item.name} className="flex items-center gap-2 text-sm"><span className="size-2.5 rounded-full" style={{ background: item.fill }} /><span className="flex-1">{item.name}</span><span className="font-medium tabular-nums">{item.value}%</span></div>)}</div></> : <p className="py-8 text-center text-sm text-muted-foreground">No model mix is available in this range.</p>}
        </div></CardContent></Card>
      </div>
    </Page>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof ActivityIcon;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <div className="flex items-start justify-between gap-4">
          <CardTitle variant="metric">{value}</CardTitle>
          <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground"><Icon className="size-5" /></div>
        </div>
      </CardHeader>
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}
