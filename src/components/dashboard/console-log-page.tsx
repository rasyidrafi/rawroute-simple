"use client";

import { useState } from "react";
import { ClipboardIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { cn } from "cn";
import { Confirm, copy, notify } from "@/components/dashboard/page-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConsoleLogs } from "@/hooks/use-console-logs";
import { reportEvent } from "@/lib/logging/client";
import { formatLog, type LogEntry, type LogSnapshot } from "@/lib/logging/types";

export function ConsoleLog({ workspaceId }: { workspaceId: string }) {
  return <LogPanel scope={{ kind: "workspace", workspaceId }} title="Console Log" description="Workspace console history is isolated from every other workspace and retained in memory until the server restarts." />;
}

export function SystemLogPanel() {
  return <LogPanel scope={{ kind: "global" }} title="System Logs" description="Global administrator, CLIProxy, authentication, and rejected gateway authentication history. This is distinct from every workspace console." />;
}

function LogPanel({
  scope, title, description,
}: {
  scope: { kind: "workspace"; workspaceId: string } | { kind: "global" };
  title: string;
  description: string;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("ALL");
  const [live, setLive] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const { snapshot, error, busy, refresh, clear } = useConsoleLogs(live, scope);
  const entries = snapshot?.entries ?? [];
  const visible = entries.filter((entry) =>
    (level === "ALL" || entry.level === level) && formatLog(entry).toLowerCase().includes(query.toLowerCase()));

  async function clearHistory() {
    setConfirmClear(false);
    if (await clear()) notify("Console history cleared");
  }

  return (
    <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <CardTitle>{title}</CardTitle>
              <CardDescription>
                {description} Keeps the latest {snapshot?.capacity.toLocaleString() ?? "2,000"} entries in this scope.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
                <RefreshCwIcon data-icon="inline-start" />{busy ? "Loading…" : "Refresh"}
              </Button>
              <Button size="sm" variant="outline" disabled={!visible.length} onClick={async () => {
                if (await copy(visible.map(formatLog).join("\n"), "Logs copied", { page: scope.kind === "workspace" ? "logs" : "system-logs", workspaceId: scope.kind === "workspace" ? scope.workspaceId : null })) {
                  if (scope.kind === "workspace") reportEvent("logs.copied", { workspaceId: scope.workspaceId });
                }
              }}>
                <ClipboardIcon data-icon="inline-start" />Copy
              </Button>
              <Button size="sm" variant="destructive" disabled={busy || !entries.length} onClick={() => setConfirmClear(true)}>
                <Trash2Icon data-icon="inline-start" />Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={level} onValueChange={(value) => setLevel(String(value))}>
            <Separator />
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <TabsList aria-label="Log severity">
                {["ALL", "INFO", "WARN", "ERROR"].map((item) => (
                  <TabsTrigger key={item} value={item}>{item === "ALL" ? "All" : item[0] + item.slice(1).toLowerCase()}</TabsTrigger>
                ))}
              </TabsList>
              <div className="flex items-center gap-3">
                <InputGroup className="max-w-sm">
                  <InputGroupInput aria-label="Search log text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search log text…" />
                  <InputGroupAddon><SearchIcon /></InputGroupAddon>
                </InputGroup>
                <label className="flex items-center gap-2 whitespace-nowrap text-sm">
                  <Switch checked={live} onCheckedChange={(value) => {
                    setLive(value);
                    if (scope.kind === "workspace") reportEvent(value ? "logs.resumed" : "logs.paused", { workspaceId: scope.workspaceId });
                    if (value) void refresh();
                  }} />
                  {live ? "Live" : "Paused"}
                </label>
              </div>
            </div>
            <Separator />
            {error && <FieldError>{error} Existing entries may be stale. Use Refresh to retry.</FieldError>}
            <LogStatus snapshot={snapshot} count={visible.length} busy={busy} live={live} />
            <TabsContent value={level}>
              <LogResults entries={visible} loaded={snapshot !== null} busy={busy} filtered={entries.length > 0} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <Confirm open={confirmClear} onOpenChange={setConfirmClear} title="Clear console log?"
        description={`This removes all retained ${scope.kind === "workspace" ? "workspace" : "global system"} history for every administrator, including entries hidden by filters. A history-cleared event will remain.`}
        onConfirm={() => void clearHistory()} />
      </div>
    </main>
  );
}

function LogStatus({ snapshot, count, busy, live }: { snapshot: LogSnapshot | null; count: number; busy: boolean; live: boolean }) {
  let message = busy ? "Loading console logs…" : "No log history loaded.";
  if (snapshot) {
    message = `${count} of ${snapshot.entries.length} entries · newest first`;
    if (snapshot.evicted) message += ` · ${snapshot.evicted} older entries expired`;
  }
  if (live) message += " · Refreshes every 3 seconds";
  return <p className="text-xs text-muted-foreground" role="status">{message}</p>;
}

function LogResults({ entries, loaded, busy, filtered }: { entries: LogEntry[]; loaded: boolean; busy: boolean; filtered: boolean }) {
  let empty = filtered ? "No entries match this filter." : "No events recorded yet.";
  if (!loaded) empty = busy ? "Loading…" : "Logs are unavailable.";
  return (
    <div className="rounded-lg border bg-muted/20">
      <ScrollArea className="h-[min(55svh,36rem)] min-h-48">
        <div className="p-4 font-mono text-xs leading-6" aria-label="Console log entries">
          {entries.length ? entries.map((entry) => <LogLine key={entry.id} entry={entry} />) : <p className="text-muted-foreground">{empty}</p>}
        </div>
      </ScrollArea>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <p className={cn("break-words whitespace-pre-wrap", entry.level === "ERROR" && "text-destructive")}>
      <time className="text-muted-foreground" dateTime={entry.time}>{entry.time}</time>{" "}
      <strong>{entry.level.padEnd(5)}</strong>{" "}
      <span className="text-primary">[{entry.source}]</span> {entry.message}{" "}
      <span className="text-muted-foreground">event={entry.event} origin={entry.origin}{" "}
        {Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ")}
      </span>
    </p>
  );
}
