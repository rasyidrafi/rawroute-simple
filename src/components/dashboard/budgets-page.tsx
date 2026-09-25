"use client";

import { useState } from "react";
import { reportEvent } from "@/lib/logging/client";
import { cn } from "cn";
import { ChevronsUpDownIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Confirm, Metadata, notify, Page } from "@/components/dashboard/page-ui";
import { DataTableHeader } from "@/components/dashboard/data-table-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Budget, GatewayKey } from "@/mock/dashboard-data";

const budgetDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function Budgets({
  budgets,
  setBudgets,
  keys,
}: {
  budgets: Budget[];
  setBudgets: React.Dispatch<React.SetStateAction<Budget[]>>;
  keys: GatewayKey[];
}) {
  const [keyId, setKeyId] = useState("");
  const [limit, setLimit] = useState("50");
  const [unlimited, setUnlimited] = useState(false);
  const [confirmUnlimited, setConfirmUnlimited] = useState(false);
  const [edit, setEdit] = useState<Budget | null>(null);
  const [editLimit, setEditLimit] = useState("");
  const [sortBy, setSortBy] = useState<"limit" | "usage" | "name">("limit");
  const [windowOpen, setWindowOpen] = useState(false);
  const [windowStart, setWindowStart] = useState("2026-09-16");
  const [windowEnd, setWindowEnd] = useState("2026-09-23");
  const [windowStartDraft, setWindowStartDraft] = useState(windowStart);
  const [windowEndDraft, setWindowEndDraft] = useState(windowEnd);
  const [removeBudget, setRemoveBudget] = useState<Budget | null>(null);
  const [beyondLimits, setBeyondLimits] = useState(false);
  const allocated = budgets.reduce((sum, budget) => sum + budget.limit, 0);
  const spent = budgets.reduce((sum, budget) => sum + budget.spent, 0);
  const dateLabel = (value: string) => budgetDateFormatter.format(new Date(`${value}T00:00:00`));
  const sortedBudgets = [...budgets].sort((left, right) => {
    if (sortBy === "name") return left.key.localeCompare(right.key);
    if (sortBy === "usage") return right.spent / right.limit - left.spent / left.limit;
    return right.limit - left.limit;
  });
  function createBudget() {
    const key = keys.find((item) => item.id === keyId);
    const amount = Number(limit);
    if (!key || !Number.isFinite(amount) || amount <= 0) return;
    setBudgets((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        key: key.name,
        limit: amount,
        spent: 0,
        enabled: true,
      },
    ]);
    setKeyId("");
    notify("Budget created");
  }
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Budget window</CardTitle>
          <CardDescription>
            Choose the shared mock accounting window used by every gateway key.
          </CardDescription>
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setWindowStartDraft(windowStart);
                setWindowEndDraft(windowEnd);
                setWindowOpen(true);
              }}
            >
              Edit window
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Metadata label="Window anchor" value={`${dateLabel(windowStart)} - ${dateLabel(windowEnd)}`} />
            <Metadata label="Next reset" value={`${dateLabel(windowEnd)} at 00:00`} />
          </div>
        </CardContent>
      </Card>
      <Dialog open={windowOpen} onOpenChange={setWindowOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit budget window</DialogTitle>
            <DialogDescription>Choose a custom date range for this local mock window.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium" htmlFor="budget-window-start">Start date<Input id="budget-window-start" type="date" value={windowStartDraft} onChange={(event) => setWindowStartDraft(event.target.value)} /></label>
            <label className="grid gap-2 text-sm font-medium" htmlFor="budget-window-end">End date<Input id="budget-window-end" type="date" value={windowEndDraft} onChange={(event) => setWindowEndDraft(event.target.value)} /></label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWindowOpen(false)}>Cancel</Button>
            <Button disabled={!windowStartDraft || !windowEndDraft || windowStartDraft >= windowEndDraft} onClick={() => {
              setWindowStart(windowStartDraft);
              setWindowEnd(windowEndDraft);
              setWindowOpen(false);
              reportEvent("budgets.window");
              notify("Mock budget window updated");
            }}>Save window</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Card>
        <CardHeader>
          <CardTitle>Budgets</CardTitle>
          <CardDescription>
            Weekly USD limits for each gateway key. These controls update local mock state only; this clone does not route AI requests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border bg-muted/20 p-4">
                <span className="text-sm text-muted-foreground">
              Total budget allocated
                </span>
                <div className="mt-1 text-2xl font-semibold">
                  ${allocated.toFixed(2)}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Across {budgets.length} configured {budgets.length === 1 ? "budget" : "budgets"} in this window
                </p>
              </div>
              <div className="rounded-xl border bg-muted/20 p-4">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Total budget used</span>
                  <span>{allocated ? `${Math.round((spent / allocated) * 100)}%` : "0%"}</span>
                </div>
                <div className="mt-1 text-2xl font-semibold">
                  ${spent.toFixed(2)}
                </div>
                <Progress
                  className="mt-3"
                  value={allocated ? Math.min(100, (spent / allocated) * 100) : 0}
                />
                <div className="mt-2 text-xs text-muted-foreground">{unlimited ? "Unlimited Mode active" : "Measured across the shared budget window"}</div>
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row">
              <Select value={keyId} onValueChange={(value) => value !== null && setKeyId(value)}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue placeholder="Select gateway key" />
                </SelectTrigger>
                <SelectContent>
                  {keys
                    .filter(
                      (key) =>
                        !budgets.some((budget) => budget.key === key.name),
                    )
                    .map((key) => (
                      <SelectItem value={key.id} key={key.id}>
                        {key.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input
                className="sm:w-32"
                type="number"
                min="1"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                aria-label="Weekly USD limit"
              />
              <Button disabled={!keyId} onClick={createBudget}>
                <PlusIcon />
                Create budget
              </Button>
            </div>
            <Tabs defaultValue="unlimited">
              <TabsList>
                <TabsTrigger value="unlimited">Unlimited Mode</TabsTrigger>
                <TabsTrigger value="beyond">Beyond Limits</TabsTrigger>
              </TabsList>
              <TabsContent value="unlimited" className="mt-4">
                  <div className="rounded-xl border p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 font-medium">
                          <SparklesIcon className="size-4 text-amber-500" />
                          Unlimited Mode{" "}
                        <Badge
                          className="ml-2"
                          variant={unlimited ? "secondary" : "outline"}
                        >
                          {unlimited ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                          Budget limits are bypassed until you deactivate Unlimited Mode.
                      </p>
                    </div>
                    <Button
                      variant={unlimited ? "unlimited-active" : "unlimited-inactive"}
                      onClick={() => setConfirmUnlimited(true)}
                    >
                      {unlimited ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                  <div className="mt-4 border-t pt-4">
                    <label className="flex items-center gap-3 text-sm">
                      <Checkbox />
                      <span>
                        <span className="block font-medium">
                          Exclude expensive models
                        </span>
                        <span className="text-muted-foreground">
                          These models cannot start new requests while Unlimited Mode is active.
                        </span>
                      </span>
                    </label>
                  </div>
                  <div className="mt-4 text-xs text-muted-foreground">
                    History: Sep 14 09:23 - Sep 14 13:11 · Deactivated manually
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="beyond" className="mt-4">
                <div className="rounded-lg border p-4">
                  <div className="flex items-center gap-3">
                    <Switch checked={beyondLimits} onCheckedChange={(value) => { setBeyondLimits(value); reportEvent("budgets.beyond-limits"); }} aria-label="Enable Beyond Limits" />
                    <div>
                      <div className="font-medium">Beyond Limits</div>
                      <p className="text-sm text-muted-foreground">
                        Allow selected economical models after a key is over its
                        limit.
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {["anthropic/claude-haiku-4-5", "groq/llama-4-scout"].map(
                      (model) => (
                        <label
                          key={model}
                          className="flex items-center gap-2 rounded-md border p-2 text-sm"
                        >
                          <Checkbox defaultChecked />
                          {model}
                        </label>
                      ),
                    )}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="text-sm font-medium">Budget usage</div><div className="text-xs text-muted-foreground">Usage is measured across the shared budget window.</div></div>
              <Popover>
                <PopoverTrigger render={<Button variant="outline" className="justify-between sm:min-w-48"><span>Order: {sortBy === "limit" ? "Highest limit first" : sortBy === "usage" ? "Highest usage first" : "API key name"}</span><ChevronsUpDownIcon /></Button>} />
                <PopoverContent align="end" className="w-56">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">Order rows by</p>
                  {([ ["limit", "Highest limit first"], ["usage", "Highest usage first"], ["name", "API key name"] ] as const).map(([value, label]) => <Button key={value} variant={sortBy === value ? "secondary" : "ghost"} className="h-8 w-full justify-start" onClick={() => setSortBy(value)}>{label}</Button>)}
                </PopoverContent>
              </Popover>
            </div>
            <BudgetTable
              budgets={sortedBudgets}
              unlimited={unlimited}
              setBudgets={setBudgets}
              onEdit={(budget) => {
                setEdit(budget);
                setEditLimit(String(budget.limit));
              }}
              onRemove={setRemoveBudget}
            />
          </div>
        </CardContent>
      </Card>
      <BudgetDialogs
        unlimited={unlimited}
        setUnlimited={setUnlimited}
        confirmUnlimited={confirmUnlimited}
        setConfirmUnlimited={setConfirmUnlimited}
        removeBudget={removeBudget}
        setRemoveBudget={setRemoveBudget}
        edit={edit}
        setEdit={setEdit}
        editLimit={editLimit}
        setEditLimit={setEditLimit}
        setBudgets={setBudgets}
      />
    </Page>
  );
}

function BudgetTable({
  budgets,
  unlimited,
  setBudgets,
  onEdit,
  onRemove,
}: {
  budgets: Budget[];
  unlimited: boolean;
  setBudgets: React.Dispatch<React.SetStateAction<Budget[]>>;
  onEdit: (budget: Budget) => void;
  onRemove: (budget: Budget) => void;
}) {
  return (
    <Table>
      <DataTableHeader columns={[
        { id: "key", label: "Key" },
        { id: "status", label: "Status" },
        { id: "limit", label: "Limit" },
        { id: "usage", label: "Usage" },
        { id: "actions", label: "" },
      ]} />
      <TableBody>
        {budgets.map((budget) => (
          <TableRow key={budget.id}>
            <TableCell><span className="font-medium">{budget.key}</span></TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Switch
                  checked={budget.enabled}
                  onCheckedChange={(enabled) => setBudgets((items) => items.map((item) => item.id === budget.id ? { ...item, enabled } : item))}
                  aria-label={`Enable budget for ${budget.key}`}
                />
                <Badge variant={budget.enabled ? "secondary" : "outline"}>{budget.enabled ? "Active" : "Disabled"}</Badge>
              </div>
            </TableCell>
            <TableCell>
              {unlimited
                ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-semibold"><span className="font-mono">∞</span>Unlimited</span>
                : <span className="tabular-nums">${budget.limit.toFixed(2)}</span>}
            </TableCell>
            <TableCell className="min-w-40">
              <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-muted-foreground">${budget.spent.toFixed(2)} / ${budget.limit.toFixed(2)}</span>
                {unlimited
                  ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold"><span className="font-mono">∞</span>Unlimited</span>
                  : <span className="text-muted-foreground">{Math.round((budget.spent / budget.limit) * 100)}%</span>}
              </div>
              <div className={cn(unlimited && "unlimited-progress")}>
                <Progress value={unlimited ? 100 : Math.min(100, (budget.spent / budget.limit) * 100)} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{unlimited ? "Unlimited Usage" : `$${Math.max(0, budget.limit - budget.spent).toFixed(2)} remaining`}</div>
            </TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost" onClick={() => onEdit(budget)}>Edit</Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Delete budget for ${budget.key}`} onClick={() => onRemove(budget)}>
                <Trash2Icon />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BudgetDialogs({
  unlimited,
  setUnlimited,
  confirmUnlimited,
  setConfirmUnlimited,
  removeBudget,
  setRemoveBudget,
  edit,
  setEdit,
  editLimit,
  setEditLimit,
  setBudgets,
}: {
  unlimited: boolean;
  setUnlimited: React.Dispatch<React.SetStateAction<boolean>>;
  confirmUnlimited: boolean;
  setConfirmUnlimited: React.Dispatch<React.SetStateAction<boolean>>;
  removeBudget: Budget | null;
  setRemoveBudget: React.Dispatch<React.SetStateAction<Budget | null>>;
  edit: Budget | null;
  setEdit: React.Dispatch<React.SetStateAction<Budget | null>>;
  editLimit: string;
  setEditLimit: React.Dispatch<React.SetStateAction<string>>;
  setBudgets: React.Dispatch<React.SetStateAction<Budget[]>>;
}) {
  return (
    <>
      <Confirm
        open={confirmUnlimited}
        onOpenChange={setConfirmUnlimited}
        title={`${unlimited ? "Deactivate" : "Activate"} Unlimited Mode?`}
        description={unlimited ? "Budget limits will resume immediately." : "All configured budget limits will be bypassed."}
        onConfirm={() => {
          setUnlimited((value) => !value);
          setConfirmUnlimited(false);
          reportEvent("budgets.unlimited");
          notify("Unlimited Mode updated");
        }}
      />
      <Confirm
        open={Boolean(removeBudget)}
        onOpenChange={(open) => !open && setRemoveBudget(null)}
        title={`Delete budget for ${removeBudget?.key}?`}
        description="This removes the local mock budget and its usage limit."
        onConfirm={() => {
          if (removeBudget) setBudgets((items) => items.filter((item) => item.id !== removeBudget.id));
          setRemoveBudget(null);
          notify("Budget deleted");
        }}
      />
      <Dialog open={Boolean(edit)} onOpenChange={(open) => !open && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit budget</DialogTitle>
            <DialogDescription>Update the weekly limit for {edit?.key}.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 py-4 text-sm font-medium" htmlFor="edit-budget-limit">
            Weekly USD limit
            <Input id="edit-budget-limit" type="number" min="0.01" step="0.01" value={editLimit} onChange={(event) => setEditLimit(event.target.value)} />
          </label>
          <DialogFooter>
            <Button
              disabled={!Number.isFinite(Number(editLimit)) || Number(editLimit) <= 0}
              onClick={() => {
                if (edit) setBudgets((items) => items.map((item) => item.id === edit.id ? { ...item, limit: Number(editLimit) } : item));
                setEdit(null);
                notify("Budget updated");
              }}
            >
              Save limit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
