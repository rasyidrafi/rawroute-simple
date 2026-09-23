"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangleIcon, CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Confirm, notify, Page } from "@/components/dashboard/page-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Model, PriceGroup } from "@/mock/dashboard-data";

export function Pricing({
  groups,
  setGroups,
  models,
}: {
  groups: PriceGroup[];
  setGroups: React.Dispatch<React.SetStateAction<PriceGroup[]>>;
  models: Model[];
}) {
  const [open, setOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<PriceGroup | null>(null);
  const [rateOpen, setRateOpen] = useState<PriceGroup | null>(null);
  const [name, setName] = useState("");
  const [input, setInput] = useState("1");
  const [output, setOutput] = useState("5");
  const [cacheRead, setCacheRead] = useState("0");
  const [cacheCreation, setCacheCreation] = useState("0");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [remove, setRemove] = useState<PriceGroup | null>(null);
  const grouped = new Set(groups.flatMap((group) => group.models));
  const ungrouped = models.filter((model) => !grouped.has(model.id));
  function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setGroups((items) =>
      editingGroup
        ? items.map((group) =>
            group.id === editingGroup.id
              ? { ...group, name, models: selectedModels, input: Number(input), output: Number(output), cacheRead: Number(cacheRead), cacheCreation: Number(cacheCreation) }
              : group,
          )
        : [
            ...items,
            {
              id: crypto.randomUUID(),
              name,
              kind: "Custom",
              models: selectedModels,
              input: Number(input),
              output: Number(output),
              cacheRead: Number(cacheRead),
              cacheCreation: Number(cacheCreation),
              version: 1,
            },
          ],
    );
    setOpen(false);
    setEditingGroup(null);
    notify(editingGroup ? "Model group updated" : "Model group created");
  }
  function saveRates(event: FormEvent) {
    event.preventDefault();
    if (!rateOpen) return;
    setGroups((items) =>
      items.map((group) =>
        group.id === rateOpen.id
          ? {
              ...group,
              input: Number(input),
              output: Number(output),
              cacheRead: Number(cacheRead),
              cacheCreation: Number(cacheCreation),
              version: group.version + 1,
            }
          : group,
      ),
    );
    setRateOpen(null);
    notify("New pricing version saved");
  }
  return (
    <Page>
      <div
        className={
          ungrouped.length ? "rounded-xl border border-amber-400/60" : undefined
        }
      >
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              {ungrouped.length ? (
                <AlertTriangleIcon className="size-5 text-amber-600" />
              ) : (
                <CheckIcon className="size-5 text-emerald-600" />
              )}
              <CardTitle>
                {ungrouped.length
                  ? `${ungrouped.length} ungrouped model${ungrouped.length === 1 ? "" : "s"}`
                  : "All models are priced"}
              </CardTitle>
            </div>
            <CardDescription>
              {ungrouped.length
                ? "Ungrouped models remain visible in usage, but cannot receive model pricing until assigned to a group."
                : "Every enabled model is assigned to a current pricing group."}
            </CardDescription>
          </CardHeader>
          {ungrouped.length > 0 && (
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {ungrouped.map((model) => (
                  <Badge key={model.id} variant="outline">
                    {model.id}
                  </Badge>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Model pricing</CardTitle>
          <CardDescription>
            Group compatible gateway models, version their rates, and review the local mock repricing history.
          </CardDescription>
          <CardAction>
            <Button
              onClick={() => {
                setName("");
                setInput("1");
                setOutput("5");
                setCacheRead("0");
                setCacheCreation("0");
                setSelectedModels(ungrouped.slice(0, 2).map((model) => model.id));
                setEditingGroup(null);
                setOpen(true);
              }}
            >
              <PlusIcon />
              New group
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Current pricing</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <TableRow key={group.id}>
                  <TableCell>
                    <div className="font-medium">{group.name}</div>
                    <div className="text-xs text-muted-foreground">
                      v{group.version} active Sep 18, 2026
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={group.kind === "Fixed" ? "outline" : "secondary"}
                    >
                      {group.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{group.models.length}</div>
                    <div className="max-w-52 truncate text-xs text-muted-foreground">
                      {group.models.join(", ")}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <span className="text-muted-foreground">Input</span><span className="text-right font-medium">${group.input.toFixed(2)}</span>
                      <span className="text-muted-foreground">Output</span><span className="text-right font-medium">${group.output.toFixed(2)}</span>
                      <span className="text-muted-foreground">Cache read</span><span className="text-right font-medium">${(group.cacheRead ?? 0).toFixed(2)}</span>
                      <span className="text-muted-foreground">Cache creation</span><span className="text-right font-medium">${(group.cacheCreation ?? 0).toFixed(2)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingGroup(group);
                          setName(group.name);
                          setInput(String(group.input));
                          setOutput(String(group.output));
                          setCacheRead(String(group.cacheRead ?? 0));
                          setCacheCreation(String(group.cacheCreation ?? 0));
                          setSelectedModels(group.models);
                          setOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRateOpen(group);
                          setInput(String(group.input));
                          setOutput(String(group.output));
                          setCacheRead(String(group.cacheRead ?? 0));
                          setCacheCreation(String(group.cacheCreation ?? 0));
                        }}
                      >
                        Rates
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${group.name}`}
                        onClick={() => setRemove(group)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Repricing history</CardTitle>
          <CardDescription>
            Historical cost recalculations created after a pricing replacement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex justify-between rounded-lg border p-3 text-sm">
              <span>
                <span className="font-medium">GPT-5 family</span>
                <span className="ml-2 text-muted-foreground">
                  v2 replaced by v3
                </span>
              </span>
              <Badge variant="secondary">Completed · 3,964 events</Badge>
            </div>
            <div className="flex justify-between rounded-lg border p-3 text-sm">
              <span>
                <span className="font-medium">Claude Sonnet</span>
                <span className="ml-2 text-muted-foreground">rate refresh</span>
              </span>
              <Badge variant="outline">Completed · 1,241 events</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setEditingGroup(null);
        }}
      >
        <DialogContent>
          <form onSubmit={create}>
            <DialogHeader>
              <DialogTitle>
                {editingGroup ? "Edit model group" : "Create model group"}
              </DialogTitle>
              <DialogDescription>
                Choose currently ungrouped models and establish initial prices.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="text-sm font-medium" htmlFor="group-name">
                Group name
                <Input
                  id="group-name"
                  className="mt-2"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="space-y-2">
                <div className="text-sm font-medium">Models in group</div>
                <div className="max-h-44 divide-y overflow-y-auto rounded-lg border">
                  {models.filter((model) => !grouped.has(model.id) || editingGroup?.models.includes(model.id)).map((model) => (
                    <label key={model.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/40">
                      <Checkbox checked={selectedModels.includes(model.id)} onCheckedChange={(checked) => setSelectedModels((current) => checked ? [...new Set([...current, model.id])] : current.filter((id) => id !== model.id))} />
                      <span className="min-w-0"><span className="block truncate font-medium">{model.name}</span><code className="block truncate text-xs text-muted-foreground">{model.id}</code></span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="text-sm font-medium" htmlFor="group-input">
                  Input / 1M
                  <Input
                    id="group-input"
                    className="mt-2"
                    type="number"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                  />
                </label>
                <label className="text-sm font-medium" htmlFor="group-cache-read">Cache read / 1M<Input id="group-cache-read" className="mt-2" type="number" min="0" step="any" value={cacheRead} onChange={(event) => setCacheRead(event.target.value)} /></label>
                <label className="text-sm font-medium" htmlFor="group-cache-creation">Cache creation / 1M<Input id="group-cache-creation" className="mt-2" type="number" min="0" step="any" value={cacheCreation} onChange={(event) => setCacheCreation(event.target.value)} /></label>
                <label className="text-sm font-medium" htmlFor="group-output">
                  Output / 1M
                  <Input
                    id="group-output"
                    className="mt-2"
                    type="number"
                    value={output}
                    onChange={(event) => setOutput(event.target.value)}
                  />
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!name.trim()}>
                {editingGroup ? "Save group" : "Create group"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(rateOpen)}
        onOpenChange={(value) => !value && setRateOpen(null)}
      >
        <DialogContent>
          <form onSubmit={saveRates}>
            <DialogHeader>
              <DialogTitle>Update {rateOpen?.name} rates</DialogTitle>
              <DialogDescription>
                Saving creates a new pricing version and mock historical
                recalculation.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 py-4 sm:grid-cols-4">
              <label className="text-sm font-medium" htmlFor="rate-input">
                Input / 1M
                <Input
                  id="rate-input"
                  className="mt-2"
                  type="number"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                />
              </label>
              <label className="text-sm font-medium" htmlFor="rate-cache-read">Cache read / 1M<Input id="rate-cache-read" className="mt-2" type="number" min="0" step="any" value={cacheRead} onChange={(event) => setCacheRead(event.target.value)} /></label>
              <label className="text-sm font-medium" htmlFor="rate-cache-creation">Cache creation / 1M<Input id="rate-cache-creation" className="mt-2" type="number" min="0" step="any" value={cacheCreation} onChange={(event) => setCacheCreation(event.target.value)} /></label>
              <label className="text-sm font-medium" htmlFor="rate-output">
                Output / 1M
                <Input
                  id="rate-output"
                  className="mt-2"
                  type="number"
                  value={output}
                  onChange={(event) => setOutput(event.target.value)}
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="submit">Save new version</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(value) => !value && setRemove(null)}
        title={`Delete ${remove?.name}?`}
        description="The mock pricing group and its history will be removed."
        onConfirm={() => {
          if (remove)
            setGroups((items) => items.filter((item) => item.id !== remove.id));
          setRemove(null);
          notify("Model group deleted");
        }}
      />
    </Page>
  );
}
