"use client";
import { useCallback, useEffect, useState } from "react";
import {
  CalendarDaysIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Confirm, notify, Page } from "@/components/dashboard/page-ui";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accountingFetch } from "@/lib/accounting-client";
import {
  formatLedgerDateTimeLocal,
  isAmbiguousLedgerDateTimeLocal,
  parseLedgerDateTimeLocal,
} from "@/lib/timezone-client";
import {
  budgetPolicyActionsDisabled,
  runBudgetPolicyAction,
} from "./budget-policy-actions";
import { runLatestRequest, useLatestRequest } from "./use-latest-request";

type Budget = {
  keyId: string;
  keyName: string;
  limitMicros: number;
  spentMicros: number;
  reservedMicros: number;
  enabled: boolean;
};
type Data = {
  timeZone: string;
  window: {
    startAt: number;
    endAt: number;
    durationMs: number;
    unlimited: boolean;
    autoEnd: boolean;
    activeSessionId: string | null;
    anchor: {
      accountId: string;
      resetAt: number | null;
      checkedAt: number | null;
      error: string | null;
    } | null;
  };
  keys: Array<{ id: string; name: string; status: string }>;
  budgets: Budget[];
  unlimited: {
    exclusions: string[];
    active: boolean;
    autoEnd: boolean;
    activeSessionId: string | null;
  };
  beyondLimits: { enabled: boolean; models: string[] };
  modelOptions: Array<{ id: string; name: string; type: string }>;
  history: Array<{
    id: string;
    startedAt: number;
    endedAt: number | null;
    endReason: string | null;
  }>;
};
const money = (value: number) => `$${(value / 1_000_000).toFixed(2)}`;
const dateTime = (value: number, zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(value);

export function Budgets({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Budget | "new" | null>(null);
  const [remove, setRemove] = useState<Budget | null>(null);
  const [windowOpen, setWindowOpen] = useState(false);
  const [anchorOpen, setAnchorOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    active: boolean;
    autoEnd: boolean;
  } | null>(null);
  const requests = useLatestRequest();
  const load = useCallback(async () => {
    await runLatestRequest(
      requests,
      (signal) =>
        accountingFetch<Data>(workspaceId, "/api/budgets", { signal }),
      {
        onStart: () => setLoading(true),
        onSuccess: (next) => {
          setData(next);
          setError(undefined);
        },
        onError: (reason) =>
          setError(
            reason instanceof Error
              ? reason.message
              : "Budgets could not load.",
          ),
        onFinally: () => setLoading(false),
      },
    );
  }, [requests, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  const policySnapshot = {
    hasData: Boolean(data),
    loading,
    error,
  };
  const policyActionsDisabled = budgetPolicyActionsDisabled(policySnapshot);
  useEffect(() => {
    if (!policyActionsDisabled) return;
    setConfirm(null);
    setRemove(null);
  }, [policyActionsDisabled]);
  async function setUnlimited(active: boolean, autoEnd: boolean) {
    if (policyActionsDisabled) {
      setConfirm(null);
      return;
    }
    try {
      await accountingFetch(workspaceId, "/api/budgets/unlimited", {
        method: "PATCH",
        body: JSON.stringify({ active, autoEnd }),
      });
      setConfirm(null);
      await load();
      notify(
        active ? "Unlimited Mode activated" : "Unlimited Mode deactivated",
      );
    } catch (reason) {
      notify(
        reason instanceof Error
          ? reason.message
          : "Unlimited Mode could not update.",
        "error",
      );
    }
  }
  async function deleteBudget() {
    if (policyActionsDisabled) {
      setRemove(null);
      return;
    }
    if (!remove) return;
    try {
      await accountingFetch(
        workspaceId,
        `/api/budgets/${encodeURIComponent(remove.keyId)}`,
        { method: "DELETE" },
      );
      setRemove(null);
      await load();
      notify("Budget deleted");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Budget could not delete.",
        "error",
      );
    }
  }
  return (
    <Page>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Budget data may be out of date</AlertTitle>
          <AlertDescription>
            {error} Showing the last successful snapshot. Policy changes are
            disabled until a refresh succeeds.
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load()}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Budget window</CardTitle>
          <CardDescription>
            {data?.window.anchor
              ? "Anchored to an owned Codex weekly reset. Provider reset instants are UTC; custom intervals use the server ledger timezone."
              : "Custom intervals roll forward in the server ledger timezone."}
          </CardDescription>
          <CardAction>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Refresh
              </Button>
              <Button
                variant="outline"
                disabled={policyActionsDisabled}
                onClick={() => setAnchorOpen(true)}
              >
                Codex anchor
              </Button>
              <Button
                variant="outline"
                disabled={policyActionsDisabled}
                onClick={() => setWindowOpen(true)}
              >
                <CalendarDaysIcon data-icon="inline-start" />
                Custom window
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {data ? (
            <>
              <p>
                {dateTime(data.window.startAt, data.timeZone)} –{" "}
                {dateTime(data.window.endAt, data.timeZone)}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.window.anchor
                  ? `Codex account anchor${data.window.anchor.error ? ` · refresh issue: ${data.window.anchor.error}` : " · refreshed from weekly quota"}`
                  : `${data.timeZone} · ${(data.window.durationMs / 3_600_000).toFixed(3)} hour interval`}
              </p>
            </>
          ) : (
            <p>{loading ? "Loading…" : "Budget data is unavailable."}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Gateway key budgets</CardTitle>
          <CardDescription>
            USD values use integer micros and include held reservations.
          </CardDescription>
          <CardAction>
            <Button
              disabled={policyActionsDisabled}
              onClick={() => setEdit("new")}
            >
              <PlusIcon data-icon="inline-start" />
              New budget
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <BudgetTable
            data={data}
            workspaceId={workspaceId}
            reload={load}
            disabled={policyActionsDisabled}
            onEdit={setEdit}
            onDelete={setRemove}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Limit policies</CardTitle>
          <CardDescription>
            Changes apply to newly admitted gateway attempts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="unlimited">
            <TabsList>
              <TabsTrigger value="unlimited">Unlimited Mode</TabsTrigger>
              <TabsTrigger value="beyond">Beyond Limits</TabsTrigger>
            </TabsList>
            <TabsContent value="unlimited">
              <UnlimitedPolicy
                workspaceId={workspaceId}
                data={data}
                reload={load}
                disabled={policyActionsDisabled}
                onConfirm={(active, autoEnd) => setConfirm({ active, autoEnd })}
              />
            </TabsContent>
            <TabsContent value="beyond">
              <BeyondPolicy
                workspaceId={workspaceId}
                data={data}
                reload={load}
                disabled={policyActionsDisabled}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <BudgetDialog
        workspaceId={workspaceId}
        data={data}
        budget={edit}
        open={edit !== null}
        disabled={policyActionsDisabled}
        onOpenChange={(open) => !open && setEdit(null)}
        reload={load}
      />
      <WindowDialog
        workspaceId={workspaceId}
        data={data}
        open={windowOpen}
        disabled={policyActionsDisabled}
        onOpenChange={setWindowOpen}
        reload={load}
      />
      <CodexAnchorDialog
        workspaceId={workspaceId}
        open={anchorOpen}
        disabled={policyActionsDisabled}
        onOpenChange={setAnchorOpen}
        reload={load}
      />
      <Confirm
        open={Boolean(confirm)}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm?.active
            ? "Activate Unlimited Mode?"
            : "Deactivate Unlimited Mode?"
        }
        description={
          confirm?.active
            ? "Limits are bypassed, except selected exclusions."
            : "Budget admission resumes immediately."
        }
        disabled={policyActionsDisabled}
        onConfirm={() => {
          const action = confirm;
          if (!action) return;
          runBudgetPolicyAction(policySnapshot, () => setConfirm(null), () => {
            void setUnlimited(action.active, action.autoEnd);
          });
        }}
      />
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(open) => !open && setRemove(null)}
        title={`Delete budget for ${remove?.keyName}?`}
        description="This only removes the key limit, not immutable usage."
        disabled={policyActionsDisabled}
        onConfirm={() => {
          if (!remove) return;
          runBudgetPolicyAction(policySnapshot, () => setRemove(null), () => {
            void deleteBudget();
          });
        }}
      />
    </Page>
  );
}

function BudgetTable({
  data,
  workspaceId,
  reload,
  disabled,
  onEdit,
  onDelete,
}: {
  data?: Data;
  workspaceId: string;
  reload: () => Promise<void>;
  disabled: boolean;
  onEdit: (budget: Budget) => void;
  onDelete: (budget: Budget) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Key</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Limit</TableHead>
          <TableHead>Usage</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data?.budgets.map((budget) => {
          const used = budget.spentMicros + budget.reservedMicros;
          return (
            <TableRow key={budget.keyId}>
              <TableCell>{budget.keyName}</TableCell>
              <TableCell>
                <Switch
                  checked={budget.enabled}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    void accountingFetch(workspaceId, "/api/budgets", {
                      method: "POST",
                      body: JSON.stringify({
                        keyId: budget.keyId,
                        limitMicros: budget.limitMicros,
                        enabled,
                      }),
                    })
                      .then(reload)
                      .catch(() => notify("Budget could not update.", "error"))
                  }
                />
                <Badge variant={budget.enabled ? "secondary" : "outline"}>
                  {budget.enabled ? "Active" : "Disabled"}
                </Badge>
              </TableCell>
              <TableCell>
                {data.window.unlimited
                  ? "Unlimited"
                  : money(budget.limitMicros)}
              </TableCell>
              <TableCell className="min-w-48">
                <div className="flex justify-between text-xs">
                  <span>{money(budget.spentMicros)} used</span>
                  <span>{money(budget.reservedMicros)} held</span>
                </div>
                <Progress
                  value={Math.min(
                    100,
                    budget.limitMicros ? (used / budget.limitMicros) * 100 : 0,
                  )}
                />
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Edit ${budget.keyName}`}
                    onClick={() => onEdit(budget)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Delete ${budget.keyName}`}
                    onClick={() => onDelete(budget)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
        {!data?.budgets.length ? (
          <TableRow>
            <TableCell colSpan={5} className="text-center">
              No configured budgets.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
function BudgetDialog({
  workspaceId,
  data,
  budget,
  open,
  disabled,
  onOpenChange,
  reload,
}: {
  workspaceId: string;
  data?: Data;
  budget: Budget | "new" | null;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  reload: () => Promise<void>;
}) {
  const existing = budget && budget !== "new" ? budget : undefined;
  const [keyId, setKeyId] = useState("");
  const [usd, setUsd] = useState("50");
  useEffect(() => {
    if (open) {
      setKeyId(existing?.keyId ?? "");
      setUsd(existing ? String(existing.limitMicros / 1_000_000) : "50");
    }
  }, [existing?.keyId, open]);
  async function save() {
    try {
      await accountingFetch(workspaceId, "/api/budgets", {
        method: "POST",
        body: JSON.stringify({
          keyId,
          limitMicros: Math.round(Number(usd) * 1_000_000),
          enabled: existing?.enabled ?? true,
        }),
      });
      onOpenChange(false);
      await reload();
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Budget could not save.",
        "error",
      );
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit budget" : "New budget"}</DialogTitle>
          <DialogDescription>Enter a positive USD limit.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Gateway key</FieldLabel>
            <Select
              value={keyId}
              onValueChange={(value) => value && setKeyId(value)}
              disabled={disabled || Boolean(existing)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select key" />
              </SelectTrigger>
              <SelectContent>
                {data?.keys
                  .filter((key) => key.status === "active")
                  .map((key) => (
                    <SelectItem key={key.id} value={key.id}>
                      {key.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="budget-usd">USD limit</FieldLabel>
            <Input
              id="budget-usd"
              disabled={disabled}
              type="number"
              min="0.000001"
              step="0.01"
              value={usd}
              onChange={(event) => setUsd(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={disabled || !keyId || Number(usd) <= 0}
            onClick={() => void save()}
          >
            Save budget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function WindowDialog({
  workspaceId,
  data,
  open,
  disabled,
  onOpenChange,
  reload,
}: {
  workspaceId: string;
  data?: Data;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  reload: () => Promise<void>;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [original, setOriginal] = useState<{ start: number; end: number }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open && data) {
      setStart(formatLedgerDateTimeLocal(data.window.startAt, data.timeZone));
      setEnd(formatLedgerDateTimeLocal(data.window.endAt, data.timeZone));
      setOriginal({ start: data.window.startAt, end: data.window.endAt });
      setError(undefined);
    }
  }, [data, open]);
  async function save() {
    const originalStart =
        original &&
        data &&
        start === formatLedgerDateTimeLocal(original.start, data.timeZone)
          ? original.start
          : undefined,
      originalEnd =
        original &&
        data &&
        end === formatLedgerDateTimeLocal(original.end, data.timeZone)
          ? original.end
          : undefined;
    if (
      data &&
      ((!originalStart &&
        isAmbiguousLedgerDateTimeLocal(start, data.timeZone)) ||
        (!originalEnd && isAmbiguousLedgerDateTimeLocal(end, data.timeZone)))
    ) {
      setError("Choose a non-repeated DST time after editing this interval.");
      return;
    }
    const startAt = data
        ? parseLedgerDateTimeLocal(start, data.timeZone, originalStart)
        : undefined,
      endAt = data
        ? parseLedgerDateTimeLocal(end, data.timeZone, originalEnd)
        : undefined;
    if (!startAt || !endAt || endAt <= startAt) {
      setError("Enter an unambiguous interval in the ledger timezone.");
      return;
    }
    try {
      await accountingFetch(workspaceId, "/api/budgets/window", {
        method: "PATCH",
        body: JSON.stringify({ startAt, endAt }),
      });
      onOpenChange(false);
      await reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Window could not save.",
      );
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom budget interval</DialogTitle>
          <DialogDescription>
            Edited repeated DST times must be unambiguous.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="window-start">Start</FieldLabel>
            <Input
              id="window-start"
              disabled={disabled}
              type="datetime-local"
              step="0.001"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="window-end">End</FieldLabel>
            <Input
              id="window-end"
              disabled={disabled}
              type="datetime-local"
              step="0.001"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </Field>
        </FieldGroup>
        {error ? <p role="alert">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={disabled} onClick={() => void save()}>
            Save window
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CodexAnchorDialog({
  workspaceId,
  open,
  disabled,
  onOpenChange,
  reload,
}: {
  workspaceId: string;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  reload: () => Promise<void>;
}) {
  const [accounts, setAccounts] = useState<
    Array<{ id: string; name: string; enabled: boolean; status?: string }>
  >([]);
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(undefined);
    void fetch("/api/codex", {
      signal: controller.signal,
      headers: { "x-rawroute-workspace-id": workspaceId },
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(payload.error || "Codex accounts could not load.");
        if (!controller.signal.aborted)
          setAccounts(Array.isArray(payload.accounts) ? payload.accounts : []);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Codex accounts could not load.",
          );
      });
    return () => controller.abort();
  }, [open, workspaceId]);
  async function save() {
    try {
      await accountingFetch(workspaceId, "/api/budgets/codex-anchor", {
        method: "PATCH",
        body: JSON.stringify({ accountId }),
      });
      onOpenChange(false);
      await reload();
      notify("Budget window anchored to Codex weekly reset");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Codex anchor could not save.",
      );
    }
  }
  const eligible = accounts.filter(
    (account) =>
      account.enabled &&
      account.status !== "missing" &&
      account.status !== "unavailable",
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Anchor to Codex weekly reset</DialogTitle>
          <DialogDescription>
            A fresh future weekly quota reset from an owned enabled account sets
            this window. If refresh later fails, the last anchored interval
            remains until you choose a custom window.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Codex account</FieldLabel>
            <Select
              value={accountId}
              onValueChange={(value) => value && setAccountId(value)}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select owned account" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {error ? (
            <Field data-invalid>
              <FieldDescription>{error}</FieldDescription>
            </Field>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={disabled || !accountId} onClick={() => void save()}>
            Use weekly reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function UnlimitedPolicy({
  workspaceId,
  data,
  reload,
  disabled,
  onConfirm,
}: {
  workspaceId: string;
  data?: Data;
  reload: () => Promise<void>;
  disabled: boolean;
  onConfirm: (active: boolean, autoEnd: boolean) => void;
}) {
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [autoEnd, setAutoEnd] = useState(true);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setExclusions(data?.unlimited.exclusions ?? []);
    setAutoEnd(data?.unlimited.autoEnd ?? true);
  }, [data]);
  async function updateAutoEnd(next: boolean) {
    setAutoEnd(next);
    if (!data?.window.unlimited) return;
    setPending(true);
    try {
      await accountingFetch(workspaceId, "/api/budgets/unlimited", {
        method: "PATCH",
        body: JSON.stringify({ active: true, autoEnd: next }),
      });
      await reload();
    } catch (reason) {
      setAutoEnd(data.unlimited.autoEnd);
      notify(
        reason instanceof Error ? reason.message : "Auto-end could not update.",
        "error",
      );
    } finally {
      setPending(false);
    }
  }
  async function saveSettings() {
    try {
      await accountingFetch(workspaceId, "/api/budgets/settings", {
        method: "PATCH",
        body: JSON.stringify({
          exclusions,
          beyondEnabled: data?.beyondLimits.enabled,
          beyondModels: data?.beyondLimits.models,
        }),
      });
      await reload();
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Exclusions could not save.",
        "error",
      );
    }
  }
  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-center justify-between">
        <div>
          <Badge variant={data?.window.unlimited ? "secondary" : "outline"}>
            {data?.window.unlimited ? "Active" : "Inactive"}
          </Badge>
          <p className="mt-1 text-sm text-muted-foreground">
            {data?.unlimited.activeSessionId
              ? "Active session is persisted."
              : "Each activation is retained in history."}
          </p>
        </div>
        <div className="flex gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={autoEnd}
              disabled={disabled || pending}
              onCheckedChange={(value) => void updateAutoEnd(value === true)}
            />
            Auto-end at window boundary
          </label>
          <Button
            disabled={disabled || pending}
            onClick={() => onConfirm(!data?.window.unlimited, autoEnd)}
          >
            {data?.window.unlimited ? "Deactivate" : "Activate"}
          </Button>
        </div>
      </div>
      <ModelSelector
        title="Excluded routes and models"
        values={exclusions}
        options={data?.modelOptions ?? []}
        disabled={disabled}
        onChange={setExclusions}
      />
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => void saveSettings()}
      >
        Save exclusions
      </Button>
      <History history={data?.history ?? []} />
    </div>
  );
}
function BeyondPolicy({
  workspaceId,
  data,
  reload,
  disabled,
}: {
  workspaceId: string;
  data?: Data;
  reload: () => Promise<void>;
  disabled: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    setEnabled(data?.beyondLimits.enabled ?? false);
    setModels(data?.beyondLimits.models ?? []);
  }, [data]);
  async function save() {
    try {
      await accountingFetch(workspaceId, "/api/budgets/settings", {
        method: "PATCH",
        body: JSON.stringify({
          exclusions: data?.unlimited.exclusions,
          beyondEnabled: enabled,
          beyondModels: models,
        }),
      });
      await reload();
    } catch (reason) {
      notify(
        reason instanceof Error
          ? reason.message
          : "Beyond Limits could not save.",
        "error",
      );
    }
  }
  return (
    <div className="flex flex-col gap-4 pt-4">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={setEnabled}
        />
        Enable selected routes after budget exhaustion
      </label>
      <ModelSelector
        title="Allowed routes and models"
        values={models}
        options={data?.modelOptions ?? []}
        disabled={disabled}
        onChange={setModels}
      />
      <Button
        disabled={disabled || models.length > 100}
        onClick={() => void save()}
      >
        Save Beyond Limits
      </Button>
    </div>
  );
}
function ModelSelector({
  title,
  values,
  options,
  disabled,
  onChange,
}: {
  title: string;
  values: string[];
  options: Array<{ id: string; name: string }>;
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">
        {title} ({values.length}/100)
      </p>
      <ScrollArea className="h-40 rounded-md border">
        <div className="flex flex-col gap-2 p-3">
          {options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.includes(option.id)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...new Set([...values, option.id])].slice(0, 100)
                      : values.filter((id) => id !== option.id),
                  )
                }
              />
              {option.name}{" "}
              <span className="text-muted-foreground">{option.id}</span>
            </label>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
function History({ history }: { history: Data["history"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead>Ended</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((item) => (
          <TableRow key={item.id}>
            <TableCell>{new Date(item.startedAt).toLocaleString()}</TableCell>
            <TableCell>
              {item.endedAt
                ? new Date(item.endedAt).toLocaleString()
                : "Active"}
            </TableCell>
            <TableCell>{item.endReason ?? "Active"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
