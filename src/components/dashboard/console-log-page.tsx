"use client";

import { useState } from "react";
import { ClipboardIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { Confirm, copy, notify } from "@/components/dashboard/page-ui";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { consoleEntries } from "@/mock/dashboard-data";

export function ConsoleLog() {
  const [entries, setEntries] = useState(consoleEntries);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("ALL");
  const [live, setLive] = useState(true);
  const [clear, setClear] = useState(false);
  const visible = entries.filter(
    (entry) =>
      (level === "ALL" || entry.level === level) &&
      `${entry.source} ${entry.text} ${entry.detail}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const output = visible
    .map(
      (entry) =>
        `${entry.time} ${entry.level.padEnd(5)} [${entry.source}] ${entry.text} ${entry.detail}`,
    )
    .join("\n");
  return (
    <main className="h-[calc(100svh-var(--header-height))] max-h-[calc(100svh-var(--header-height))] min-h-0 flex-none overflow-hidden bg-[#f6f5f1] p-4 dark:bg-background md:h-[calc(100svh-var(--header-height)-1rem)] md:max-h-[calc(100svh-var(--header-height)-1rem)] md:p-6 lg:p-8">
      <Card className="mx-auto flex min-h-0 w-full max-w-7xl flex-1">
        <CardHeader>
          <CardTitle>Console Log</CardTitle>
          <CardDescription>
            Recent gateway, provider, budget, and dashboard events from this
            mock running instance.
          </CardDescription>
          <CardAction>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => notify("Console refreshed")}
              >
                <RefreshCwIcon />
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!visible.length}
                onClick={() => copy(output, "Logs copied")}
              >
                <ClipboardIcon />
                Copy
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!entries.length}
                onClick={() => setClear(true)}
              >
                <Trash2Icon />
                Clear
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-3 border-y py-3 lg:flex-row lg:items-center">
              <div className="flex gap-1">
                {["ALL", "INFO", "WARN", "ERROR"].map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={level === item ? "default" : "outline"}
                    onClick={() => setLevel(item)}
                  >
                    {item === "ALL" ? "All" : item[0] + item.slice(1).toLowerCase()}
                  </Button>
                ))}
              </div>
              <div className="flex flex-1 items-center gap-3 lg:justify-end">
                <div className="relative w-full max-w-sm">
                  <SearchIcon className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    style={{ paddingLeft: "2.25rem" }}
                    aria-label="Search log text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search log text..."
                  />
                </div>
                <label className="flex items-center gap-2 whitespace-nowrap text-sm">
                  <Switch checked={live} onCheckedChange={setLive} />
                  <span
                    className={
                      live ? "text-emerald-600" : "text-muted-foreground"
                    }
                  >
                    {live ? "Live" : "Paused"}
                  </span>
                </label>
              </div>
            </div>
            <div className="min-h-0 flex-1 rounded-lg border bg-zinc-950 p-4 text-zinc-200">
              <ScrollArea className="h-full">
                <pre className="font-mono text-xs leading-6 whitespace-pre-wrap">
                  {visible.length
                    ? visible.map((entry) => (
                        <span
                          key={`${entry.time}-${entry.text}`}
                          className={
                            entry.level === "ERROR"
                              ? "block text-red-300"
                              : entry.level === "WARN"
                                ? "block text-amber-300"
                                : "block"
                          }
                        >
                          <span className="text-zinc-500">{entry.time}</span>{" "}
                          <span className="font-semibold">
                            {entry.level.padEnd(5)}
                          </span>{" "}
                          <span className="text-sky-300">[{entry.source}]</span>{" "}
                          {entry.text}{" "}
                          <span className="text-zinc-400">{entry.detail}</span>
                        </span>
                      ))
                    : "No entries match this filter."}
                </pre>
              </ScrollArea>
            </div>
          </div>
        </CardContent>
      </Card>
      <Confirm
        open={clear}
        onOpenChange={setClear}
        title="Clear console log?"
        description="This removes the visible mock log history for this browser session."
        onConfirm={() => {
          setEntries([]);
          setClear(false);
          notify("Console logs cleared");
        }}
      />
    </main>
  );
}
