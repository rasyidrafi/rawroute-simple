"use client";

import { useEffect, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  DownloadIcon,
  LoaderCircleIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import type {
  CliproxyOperationName,
  CliproxyStatus,
  CliproxyVersions,
} from "@/lib/cliproxy";
import {
  canInstallExactRelease,
  createInstallAction,
  lifecycleControlsBlocked,
  releaseControlsBlocked,
  statusPollInterval,
  type CliproxyInstallAction,
} from "@/components/dashboard/cliproxy-page-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusDetails = CliproxyStatus & {
  pid?: number | null;
  port?: number;
};

type PendingAction =
  | { type: "stop" }
  | CliproxyInstallAction;

type LifecycleAction = "install" | "start" | "stop" | "restart";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapRecord(payload: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("Server returned an invalid JSON response.");
  for (const key of keys) {
    if (isRecord(payload[key])) return payload[key];
  }
  return payload;
}

async function requestJson(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "Server returned invalid JSON."
        : `Request failed with HTTP ${response.status}; the error response was not valid JSON.`,
    );
  }

  if (!response.ok) {
    const body = unwrapErrorBody(payload);
    throw new Error(body ?? `Request failed with HTTP ${response.status}.`);
  }
  return payload;
}

async function fetchStatus(): Promise<StatusDetails> {
  return parseStatus(await requestJson("/api/cliproxy/status"));
}

function unwrapErrorBody(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.error) ? payload.error : payload;
  if (typeof nested.message === "string") return nested.message;
  if (typeof nested.error === "string") return nested.error;
  if (typeof payload.message === "string") return payload.message;
  return null;
}

function parseStatus(payload: unknown): StatusDetails {
  const data = unwrapRecord(payload, ["status", "data"]);
  if (
    typeof data.installed !== "boolean" ||
    typeof data.processRunning !== "boolean" ||
    typeof data.healthy !== "boolean" ||
    typeof data.conflict !== "boolean"
  ) {
    throw new Error("CLIProxy status response is missing required fields.");
  }
  return {
    ...data,
    pid: Number.isSafeInteger(data.pid) ? (data.pid as number) : null,
    port: Number.isSafeInteger(data.port) ? (data.port as number) : undefined,
  } as unknown as StatusDetails;
}

function parseVersions(payload: unknown): CliproxyVersions {
  const data = unwrapRecord(payload, ["versions", "data"]);
  if (
    typeof data.latest !== "string" ||
    !Array.isArray(data.versions) ||
    !data.versions.every(
      (release) =>
        isRecord(release) &&
        typeof release.version === "string" &&
        (release.publishedAt === null || typeof release.publishedAt === "string"),
    )
  ) {
    throw new Error("CLIProxy versions response is incomplete.");
  }
  return data as unknown as CliproxyVersions;
}

function statusLabel(status: StatusDetails | null): string {
  if (!status) return "Loading";
  if (status.conflict) return "Conflict";
  if (status.operation?.name === "initializing") {
    return status.installed ? "Updating" : "Installing";
  }
  if (status.operation?.name === "installing") {
    return status.installed ? "Updating" : "Installing";
  }
  if (status.operation?.name === "starting") return "Starting";
  if (status.operation?.name === "stopping") return "Stopping";
  if (status.operation?.name === "restarting") return "Restarting";
  if (status.lastError || (status.processRunning && !status.healthy)) return "Error";
  if (status.healthy) return "Running";
  return status.installed ? "Stopped" : "Uninstalled";
}

function statusBadgeClass(label: string): string {
  if (label === "Running") {
    return "border-emerald-600/20 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300";
  }
  if (["Installing", "Updating", "Starting", "Stopping", "Restarting"].includes(label)) {
    return "border-blue-600/20 bg-blue-600/10 text-blue-800 dark:text-blue-300";
  }
  if (label === "Conflict" || label === "Error") return "border-destructive/30";
  return "";
}

export function CliproxyPage() {
  const [status, setStatus] = useState<StatusDetails | null>(null);
  const [versions, setVersions] = useState<CliproxyVersions | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<LifecycleAction | null>(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [versionsRefreshing, setVersionsRefreshing] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  async function refreshStatus() {
    setStatusRefreshing(true);
    try {
      setStatus(await fetchStatus());
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : "Could not load CLIProxy status.");
    } finally {
      setStatusRefreshing(false);
    }
  }

  async function refreshVersions() {
    setVersionsRefreshing(true);
    try {
      const nextVersions = parseVersions(await requestJson("/api/cliproxy/versions"));
      setVersions(nextVersions);
      setSelectedVersion((current) =>
        nextVersions.versions.some((release) => release.version === current)
          ? current
          : nextVersions.latest,
      );
      setVersionsError(null);
    } catch (error) {
      setVersions(null);
      setVersionsError(error instanceof Error ? error.message : "Could not load CLIProxy versions.");
    } finally {
      setVersionsRefreshing(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    void refreshVersions();
  }, []);

  useEffect(() => {
    if (busy || statusRefreshing) return;
    let active = true;
    let timeout: number;
    const pollStatus = async () => {
      try {
        const nextStatus = await fetchStatus();
        if (!active) return;
        setStatus(nextStatus);
        setStatusError(null);
      } catch (error) {
        if (!active) return;
        setStatus(null);
        setStatusError(error instanceof Error ? error.message : "Could not load CLIProxy status.");
      } finally {
        if (active) {
          timeout = window.setTimeout(
            () => void pollStatus(),
            statusPollInterval(Boolean(status?.operation)),
          );
        }
      }
    };
    timeout = window.setTimeout(
      () => void pollStatus(),
      statusPollInterval(Boolean(status?.operation)),
    );
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [status?.operation?.name, status?.operation?.startedAt, busy, statusRefreshing]);

  async function runAction(action: PendingAction | { type: Exclude<LifecycleAction, "install" | "stop"> }) {
    const lifecycleAction: LifecycleAction = action.type;
    setBusy(lifecycleAction);
    setActionError(null);
    try {
      if (action.type === "install") {
        await requestJson("/api/cliproxy/install", {
          method: "POST",
          body: JSON.stringify({ version: action.requestVersion }),
        });
      } else {
        await requestJson(`/api/cliproxy/${action.type}`, { method: "POST" });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "CLIProxy action failed.");
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  }

  const label = statusLabel(status);
  const selectedRelease = versions?.versions.find(
    (release) => release.version === selectedVersion,
  );
  const latestIsCurrent = Boolean(
    status?.installed &&
      status.version === versions?.latest &&
      status.pinnedVersion === null,
  );
  const blocked = lifecycleControlsBlocked({
    hasStatus: Boolean(status),
    operationPending: Boolean(status?.operation),
    actionBusy: Boolean(busy),
    statusRefreshing,
    conflict: Boolean(status?.conflict),
  });
  const releaseBlocked = releaseControlsBlocked(
    blocked,
    Boolean(versions),
    versionsRefreshing,
  );
  const port = status?.port ?? 8317;

  function confirmInstall(requestVersion: string) {
    setPendingAction(
      createInstallAction(requestVersion, versions?.latest ?? null, status?.version ?? null),
    );
  }

  return (
    <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <TerminalIcon className="size-3.5" /> System service
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">CLIProxyAPI</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Manage the local OpenAI-compatible proxy and its releases. The process is
              kept on loopback; clients connect through this dashboard origin.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={statusRefreshing || Boolean(busy)}
            onClick={() => void refreshStatus()}
          >
            <RefreshCwIcon className={statusRefreshing ? "animate-spin" : ""} />
            Recheck status
          </Button>
        </div>

        {statusError && (
          <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Could not load CLIProxy status</p>
              <p className="mt-1 break-words text-muted-foreground">{statusError}</p>
            </div>
            <Button size="sm" variant="outline" disabled={statusRefreshing || Boolean(busy)} onClick={() => void refreshStatus()}>Retry</Button>
          </div>
        )}
        {actionError && (
          <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">The requested action failed</p>
              <p className="mt-1 break-words text-muted-foreground">{actionError}</p>
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss error" onClick={() => setActionError(null)}><XIcon /></Button>
          </div>
        )}

        <Card className="overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-slate-900 via-slate-500 to-emerald-600 dark:from-slate-100 dark:via-slate-500 dark:to-emerald-400" />
          <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/60">
                <ServerIcon className="size-5" />
              </div>
              <div>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Managed process
                  <Badge variant={label === "Error" || label === "Conflict" ? "destructive" : "outline"} className={statusBadgeClass(label)}>
                    {busy ? <LoaderCircleIcon className="animate-spin" /> : label === "Running" ? <CheckCircle2Icon /> : null}
                    {busy ? actionLabel(busy) : label}
                  </Badge>
                </CardTitle>
                <CardDescription className="mt-1">
                  {status?.operation
                    ? `${operationLabel(status.operation.name)} since ${new Date(status.operation.startedAt).toLocaleTimeString()}`
                    : status?.healthy
                      ? "Health check passed; the proxy is accepting authenticated requests."
                      : status?.processRunning
                        ? "The process exists but did not pass its health check."
                        : status?.installed
                        ? "Installed and ready to start."
                        : "No managed CLIProxyAPI release is installed."}
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {status?.installed && !status.processRunning ? (
                <Button disabled={blocked || !status.installed} onClick={() => void runAction({ type: "start" })}>
                  <PlayIcon /> Start
                </Button>
              ) : null}
              {status?.processRunning ? (
                <>
                  <Button variant="outline" disabled={blocked} onClick={() => void runAction({ type: "restart" })}>
                    <RotateCwIcon /> Restart
                  </Button>
                  <Button variant="destructive" disabled={blocked} onClick={() => setPendingAction({ type: "stop" })}>
                    <SquareIcon /> Stop
                  </Button>
                </>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {status?.lastError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div>
                  <p className="font-medium">Service reported an error</p>
                  <p className="mt-1 break-words text-muted-foreground">{status.lastError}</p>
                </div>
              </div>
            )}
            {status?.conflict && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-600/30 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100" role="alert">
                <CircleHelpIcon className="mt-0.5 size-4 shrink-0" />
                <p>Port {port} is occupied by a process that CLIProxyAPI does not own. Lifecycle actions are disabled to avoid signaling an unrelated process.</p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Installed version" value={status?.version ?? "Not installed"} mono />
              <Detail label="Selected release" value={status?.pinnedVersion ? `${status.pinnedVersion} (pinned)` : "Latest"} />
              <Detail label="Loopback port" value={`${port}`} mono />
              <Detail label="Process ID" value={status?.pid ? `${status.pid}` : "Not exposed by status API"} mono />
            </div>

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Release management</p>
                  <p className={`text-xs ${versionsError ? "text-destructive" : "text-muted-foreground"}`}>
                    {versions?.latest
                      ? `Latest available: ${versions.latest}`
                      : versionsError ?? "Checking release catalog..."}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || versionsRefreshing}
                  onClick={() => void refreshVersions()}
                >
                  <RefreshCwIcon className={versionsRefreshing ? "animate-spin" : ""} />
                  {versionsRefreshing ? "Checking" : "Refresh releases"}
                </Button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  disabled={releaseBlocked || latestIsCurrent}
                  onClick={() => versions && confirmInstall("latest")}
                >
                  <DownloadIcon />
                  {status?.installed ? "Update to latest" : "Install latest"}
                </Button>
                <div className="flex gap-2">
                  <Select
                    value={selectedRelease?.version ?? ""}
                    onValueChange={(value) => value && setSelectedVersion(value)}
                    disabled={releaseBlocked || !versions?.versions.length}
                  >
                    <SelectTrigger aria-label="Choose an exact CLIProxyAPI release" className="min-w-40">
                      <SelectValue placeholder="Pick exact release" />
                    </SelectTrigger>
                    <SelectContent>
                      {versions?.versions.map((release) => (
                        <SelectItem key={release.version} value={release.version}>
                          {release.version}{release.version === versions.latest ? " - latest" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    disabled={
                      releaseBlocked ||
                      !canInstallExactRelease(
                        selectedRelease?.version ?? null,
                        status?.version ?? null,
                        status?.pinnedVersion ?? null,
                      )
                    }
                    onClick={() => selectedRelease && confirmInstall(selectedRelease.version)}
                  >
                    Select
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Connection details</CardTitle>
            <CardDescription>
              CLIProxyAPI binds to loopback only. Use the dashboard's same-origin API URL in clients; requests are forwarded by the application.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Detail label="Client base URL" value={`${typeof window === "undefined" ? "" : window.location.origin}/v1`} mono />
            <Detail label="Upstream listener" value={`127.0.0.1:${port}`} mono />
            <Detail label="Health" value={status?.healthy ? "Healthy" : status?.processRunning ? "Not healthy" : "Not running"} />
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={Boolean(pendingAction)} onOpenChange={(open) => !open && setPendingAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingActionTitle(pendingAction)}</AlertDialogTitle>
            <AlertDialogDescription>{pendingActionDescription(pendingAction)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busy)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={blocked}
              variant={pendingAction?.type === "stop" ? "destructive" : "default"}
              onClick={() => {
                const action = pendingAction;
                setPendingAction(null);
                if (action) void runAction(action);
              }}
            >
              {pendingAction?.type === "stop" ? "Stop CLIProxyAPI" : "Confirm release"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background/70 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 truncate text-sm font-medium ${mono ? "font-mono" : ""}`} title={value}>{value}</p>
    </div>
  );
}

function actionLabel(action: LifecycleAction): string {
  const labels: Record<LifecycleAction, string> = {
    install: "Installing",
    start: "Starting",
    stop: "Stopping",
    restart: "Restarting",
  };
  return labels[action];
}

function operationLabel(name: CliproxyOperationName): string {
  return name === "initializing"
    ? "Initializing"
    : name[0].toUpperCase() + name.slice(1);
}

function pendingActionTitle(action: PendingAction | null): string {
  if (!action) return "Confirm action";
  if (action.type === "stop") return "Stop CLIProxyAPI?";
  return action.downgrade ? `Downgrade to ${action.version}?` : `Install CLIProxyAPI ${action.version}?`;
}

function pendingActionDescription(action: PendingAction | null): string {
  if (!action) return "Confirm this CLIProxyAPI action.";
  if (action.type === "stop") {
    return "The proxy will stop serving API requests. Any clients using this instance will fail until it is started again.";
  }
  if (action.downgrade) {
    return `This replaces the current release with older version ${action.version} and may restart the service. Confirm only if you intend to downgrade.`;
  }
  return `This installs CLIProxyAPI ${action.version}. If a version is already running, it will be stopped and restarted on the selected release.`;
}
