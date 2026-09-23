"use client";

import { useState, type FormEvent } from "react";
import {
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowUpIcon,
  CopyIcon,
  ListOrderedIcon,
  PlusIcon,
  Settings2Icon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";
import { Confirm, copy, notify, Page } from "@/components/dashboard/page-ui";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Alias, Combo, Model } from "@/mock/dashboard-data";

type Editor = "alias" | "combo" | null;

export function Routing({
  aliases,
  setAliases,
  combos,
  setCombos,
  models,
}: {
  aliases: Alias[];
  setAliases: React.Dispatch<React.SetStateAction<Alias[]>>;
  combos: Combo[];
  setCombos: React.Dispatch<React.SetStateAction<Combo[]>>;
  models: Model[];
}) {
  const [editor, setEditor] = useState<Editor>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState(models[0]?.id ?? "");
  const [remove, setRemove] = useState<{
    type: "alias" | "combo";
    id: string;
    name: string;
  } | null>(null);
  function open(kind: "alias" | "combo", item?: Alias | Combo) {
    setEditingId(item?.id ?? null);
    setName(item?.name ?? "");
    setTarget(
      kind === "alias" && item
        ? (item as Alias).target
        : kind === "combo" && item
          ? ((item as Combo).members[0] ?? "")
          : (models[0]?.id ?? ""),
    );
    setEditor(kind);
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (editor === "alias") {
      setAliases((items) =>
        editingId
          ? items.map((item) =>
              item.id === editingId ? { ...item, name, target } : item,
            )
          : [
              ...items,
                { id: crypto.randomUUID(), name, target, shared: target.startsWith("shared/") },
            ],
      );
    }
    if (editor === "combo") {
      setCombos((items) =>
        editingId
          ? items.map((item) =>
              item.id === editingId
                ? { ...item, name, members: [target, ...item.members.slice(1)] }
                : item,
            )
          : [
              ...items,
              {
                id: crypto.randomUUID(),
                name,
                members: [
                  target,
                  ...models
                    .map((model) => model.id)
                    .filter((modelId) => modelId !== target)
                    .slice(0, 2),
                ],
              },
            ],
      );
    }
    setEditor(null);
    notify(
      editingId
        ? editor === "alias"
          ? "Alias updated"
          : "Combo updated"
        : editor === "alias"
          ? "Alias created"
          : "Combo created",
    );
  }
  function move(combo: Combo, index: number, direction: -1 | 1) {
    setCombos((items) =>
      items.map((item) => {
        if (item.id !== combo.id) return item;
        const next = [...item.members];
        [next[index], next[index + direction]] = [
          next[index + direction],
          next[index],
        ];
        return { ...item, members: next };
      }),
    );
  }
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle><span className="flex items-center gap-2"><ArrowLeftRightIcon className="size-5" />Aliases</span></CardTitle>
          <CardDescription>
            Create local gateway IDs that forward to enabled local or shared models.
          </CardDescription>
          <CardAction>
            <Button onClick={() => open("alias")}>
              <PlusIcon />
              Add alias
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gateway ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Target model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.map((alias) => (
                <TableRow key={alias.id}>
                  <TableCell>
                    <code className="text-xs font-medium">{alias.name}</code>
                  </TableCell>
                  <TableCell>{alias.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{alias.target}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={alias.shared ? "secondary" : "outline"}>
                      {alias.shared ? "Shared" : "Local"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Copy ${alias.name}`}
                      onClick={() => copy(alias.name)}
                    >
                      <CopyIcon />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => open("alias", alias)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${alias.name}`}
                      onClick={() =>
                        setRemove({
                          type: "alias",
                          id: alias.id,
                          name: alias.name,
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><span className="flex items-center gap-2"><ListOrderedIcon className="size-5" />Combos</span></CardTitle>
          <CardDescription>
            Try models in order until one accepts the request.
          </CardDescription>
          <CardAction>
            <Button onClick={() => open("combo")}>
              <PlusIcon />
              Add combo
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gateway ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Fallback order</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {combos.map((combo) => (
                <TableRow key={combo.id}>
                  <TableCell><code className="text-xs font-medium">{combo.name}</code></TableCell>
                  <TableCell>{combo.name}</TableCell>
                  <TableCell>
                    <ol className="space-y-1">
                      {combo.members.map((member, index) => (
                        <li key={`${combo.id}-${member}`} className="flex min-w-0 items-center gap-1 text-xs">
                          <span className="w-5 shrink-0 text-muted-foreground">{index + 1}.</span>
                          <code className="min-w-0 flex-1 truncate">{member}</code>
                          <Button size="icon-xs" variant="ghost" aria-label={`Move ${member} up`} disabled={index === 0} onClick={() => move(combo, index, -1)}><ArrowUpIcon /></Button>
                          <Button size="icon-xs" variant="ghost" aria-label={`Move ${member} down`} disabled={index === combo.members.length - 1} onClick={() => move(combo, index, 1)}><ArrowDownIcon /></Button>
                        </li>
                      ))}
                    </ol>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button size="icon-sm" variant="outline" aria-label={`Copy ${combo.name}`} onClick={() => copy(combo.name)}><CopyIcon /></Button>
                      <Button size="icon-sm" variant="outline" aria-label={`Edit ${combo.name}`} onClick={() => open("combo", combo)}><Settings2Icon /></Button>
                      <Button size="icon-sm" variant="destructive" aria-label={`Delete ${combo.name}`} onClick={() => setRemove({ type: "combo", id: combo.id, name: combo.name })}><Trash2Icon /></Button>
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
          <CardTitle><span className="flex items-center gap-2"><Share2Icon className="size-5" />Shared Models</span></CardTitle>
          <CardDescription>
            Read-only models shared into this workspace. Create a local alias before gateway keys can use one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Qualified model</TableHead><TableHead>Source workspace</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow><TableCell><code className="text-xs">shared/acme/claude-sonnet</code></TableCell><TableCell>Acme Production</TableCell><TableCell><Badge variant="secondary">Available</Badge></TableCell><TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => { setName("claude-sonnet"); setTarget("shared/acme/claude-sonnet"); setEditingId(null); setEditor("alias"); notify("Create an alias to expose this shared model", "info") }}><PlusIcon />Create alias</Button></TableCell></TableRow>
              <TableRow><TableCell><code className="text-xs">shared/research/gpt-5</code></TableCell><TableCell>Research</TableCell><TableCell><Badge variant="secondary">Available</Badge></TableCell><TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => { setName("gpt-5"); setTarget("shared/research/gpt-5"); setEditingId(null); setEditor("alias"); notify("Create an alias to expose this shared model", "info") }}><PlusIcon />Create alias</Button></TableCell></TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog
        open={editor === "alias" || editor === "combo"}
        onOpenChange={(openState) => !openState && setEditor(null)}
      >
        <DialogContent>
          <form onSubmit={save}>
            <DialogHeader>
              <DialogTitle>
                {editingId ? "Edit" : "Create"} {editor}
              </DialogTitle>
              <DialogDescription>
                {editor === "combo"
                  ? "The first selected model becomes the primary, followed by a visible fallback chain."
                  : "Choose a local model target."}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="text-sm font-medium" htmlFor="route-name">
                Gateway ID
                <Input
                  id="route-name"
                  className="mt-2"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Select value={target} onValueChange={(value) => value !== null && setTarget(value)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem value={model.id} key={model.id}>
                      {model.id}
                    </SelectItem>
                  ))}
                  <SelectItem value="shared/acme/claude-sonnet">shared/acme/claude-sonnet</SelectItem>
                  <SelectItem value="shared/research/gpt-5">shared/research/gpt-5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!name.trim()}>
                {editingId ? "Save" : "Create"} {editor}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(openState) => !openState && setRemove(null)}
        title={`Delete ${remove?.name}?`}
        description="This local model route will stop accepting requests."
        onConfirm={() => {
          if (remove?.type === "alias")
            setAliases((items) =>
              items.filter((item) => item.id !== remove.id),
            );
          if (remove?.type === "combo")
            setCombos((items) => items.filter((item) => item.id !== remove.id));
          setRemove(null);
          notify("Route deleted");
        }}
      />
    </Page>
  );
}
