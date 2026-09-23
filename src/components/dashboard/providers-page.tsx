"use client";

import { useState, type FormEvent } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  LinkIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { type DashboardRoute } from "@/components/app-sidebar";
import { Confirm, Metadata, notify, Page } from "@/components/dashboard/page-ui";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Model, Provider } from "@/mock/dashboard-data";

export function Providers({
  providers,
  setProviders,
  onSelect,
  onNavigate,
}: {
  providers: Provider[];
  setProviders: React.Dispatch<React.SetStateAction<Provider[]>>;
  onSelect: (provider: Provider) => void;
  onNavigate: (route: DashboardRoute) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [remove, setRemove] = useState<Provider | null>(null);
  function edit(provider?: Provider) {
    setEditing(provider ?? null);
    setName(provider?.name ?? "");
    setPrefix(provider?.prefix ?? "");
    setOpen(true);
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !prefix.trim()) return;
    if (editing)
      setProviders((items) =>
        items.map((item) =>
          item.id === editing.id ? { ...item, name, prefix } : item,
        ),
      );
    else
      setProviders((items) => [
        ...items,
        {
          id: prefix,
          name,
          prefix,
          protocol: "OpenAI Chat",
          baseUrl: "https://api.example.com/v1",
          keys: 0,
          models: 0,
          enabled: true,
        },
      ]);
    setOpen(false);
    notify(editing ? "Provider updated" : "Provider added");
  }
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
          <CardDescription>
            Choose a provider to configure its upstream credentials, priority,
            and exposed models.
          </CardDescription>
          <CardAction>
            <Button onClick={() => edit()}>
              <PlusIcon />
              Add provider
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>API keys</TableHead>
                <TableHead>Models</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow
                  key={provider.id}
                  className="cursor-pointer"
                  onClick={() => onSelect(provider)}
                >
                  <TableCell>
                    <span className="font-medium">{provider.name}</span>
                    {!provider.enabled && <Badge className="ml-2" variant="outline">Disabled</Badge>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{provider.prefix}/</Badge>
                  </TableCell>
                  <TableCell>{provider.protocol}</TableCell>
                  <TableCell>
                    <span className="block max-w-56 truncate font-mono text-xs">
                      {provider.baseUrl}
                    </span>
                  </TableCell>
                  <TableCell><span className="font-medium tabular-nums">{provider.keys}</span><span className="ml-2 text-xs text-muted-foreground">configured</span></TableCell>
                  <TableCell><span className="font-medium tabular-nums">{provider.models}</span><span className="ml-2 text-xs text-muted-foreground">configured</span></TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${provider.name}`}
                        onClick={() => edit(provider)}
                      >
                        <Settings2Icon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${provider.name}`}
                        onClick={() => setRemove(provider)}
                      >
                        <Trash2Icon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Open ${provider.name}`}
                        onClick={() => onSelect(provider)}
                      >
                        <ChevronRightIcon />
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
          <div className="flex items-center gap-2">
            <LinkIcon className="size-5" />
            <CardTitle>Codex Providers</CardTitle>
          </div>
          <CardDescription>
            Manage Codex accounts separately from ordinary provider API keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Accounts</TableHead>
                <TableHead>Models</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="cursor-pointer" onClick={() => onNavigate("codex")}>
                <TableCell><span className="font-medium">Codex Providers</span></TableCell>
                <TableCell><Badge variant="secondary">codex/</Badge></TableCell>
                <TableCell>OpenAI Responses</TableCell>
                <TableCell><span className="font-medium tabular-nums">2</span><span className="ml-2 text-xs text-muted-foreground">demo accounts</span></TableCell>
                <TableCell><span className="font-medium tabular-nums">3</span><span className="ml-2 text-xs text-muted-foreground">built-in</span></TableCell>
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <div className="flex justify-end">
                    <Button size="icon-sm" variant="ghost" aria-label="Open Codex Providers" onClick={() => onNavigate("codex")}>
                      <ChevronRightIcon />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="mt-4 text-sm text-muted-foreground">Open the Codex provider page to add a demo account.</p>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={save}>
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit provider" : "Add provider"}
              </DialogTitle>
              <DialogDescription>
                Set the gateway prefix and connection metadata for this mock
                provider.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="text-sm font-medium" htmlFor="provider-name">
                Name
                <Input
                  id="provider-name"
                  className="mt-2"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="text-sm font-medium" htmlFor="provider-prefix">
                Gateway prefix
                <Input
                  id="provider-prefix"
                  className="mt-2"
                  value={prefix}
                  onChange={(event) => setPrefix(event.target.value)}
                />
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || !prefix.trim()}>
                Save provider
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(value) => !value && setRemove(null)}
        title={`Delete ${remove?.name}?`}
        description="This removes its local mock configuration."
        onConfirm={() => {
          if (remove)
            setProviders((items) =>
              items.filter((item) => item.id !== remove.id),
            );
          setRemove(null);
          notify("Provider deleted");
        }}
      />
    </Page>
  );
}

export function ProviderDetail({
  provider,
  setProvider,
  setProviders,
  models,
  setModels,
}: {
  provider: Provider;
  setProvider: (provider: Provider | null) => void;
  setProviders: React.Dispatch<React.SetStateAction<Provider[]>>;
  models: Model[];
  setModels: React.Dispatch<React.SetStateAction<Model[]>>;
}) {
  const [keyNames, setKeyNames] = useState([
    `${provider.name} primary`,
    `${provider.name} standby`,
  ]);
  const [newKey, setNewKey] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [modelName, setModelName] = useState("");
  const [providerEditOpen, setProviderEditOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState({
    name: provider.name,
    prefix: provider.prefix,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
  });
  const providerModels = models.filter(
    (model) => model.provider === provider.id,
  );
  function openModel(model?: Model) {
    setEditingModel(model ?? null);
    setModelName(model?.name ?? "");
    setModelOpen(true);
  }
  function editProvider() {
    setProviderDraft({
      name: provider.name,
      prefix: provider.prefix,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
    });
    setProviderEditOpen(true);
  }
  function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updatedProvider = {
      ...provider,
      ...providerDraft,
      name: providerDraft.name.trim(),
      prefix: providerDraft.prefix.trim(),
      protocol: providerDraft.protocol.trim(),
      baseUrl: providerDraft.baseUrl.trim(),
    };
    if (!updatedProvider.name || !updatedProvider.prefix || !updatedProvider.baseUrl || !updatedProvider.protocol) return;
    setProviders((items) => items.map((item) => item.id === provider.id ? updatedProvider : item));
    setProvider(updatedProvider);
    setProviderEditOpen(false);
    notify("Provider updated");
  }
  return (
    <Page>
      <div>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-3"
          onClick={() => setProvider(null)}
        >
          <ArrowLeftIcon />
          Providers
        </Button>
        <h2 className="mt-2 text-2xl font-semibold">{provider.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {provider.keys} upstream API keys and {provider.models} configured
          models
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Provider details</CardTitle>
          <CardDescription>
            <span className="font-mono">{provider.baseUrl}</span>
          </CardDescription>
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              onClick={editProvider}
            >
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metadata label="Gateway prefix" value={`${provider.prefix}/`} />
            <Metadata label="Protocol" value={provider.protocol} />
            <Metadata label="Authentication" value="Bearer API key" />
          </div>
        </CardContent>
      </Card>
      <Dialog open={providerEditOpen} onOpenChange={setProviderEditOpen}>
        <DialogContent>
          <form onSubmit={saveProvider}>
            <DialogHeader>
              <DialogTitle>Edit provider</DialogTitle>
              <DialogDescription>Update the local mock connection details for {provider.name}.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="grid gap-2 text-sm font-medium" htmlFor="edit-provider-name">Name<Input id="edit-provider-name" autoFocus value={providerDraft.name} onChange={(event) => setProviderDraft((draft) => ({ ...draft, name: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-medium" htmlFor="edit-provider-prefix">Gateway prefix<Input id="edit-provider-prefix" value={providerDraft.prefix} onChange={(event) => setProviderDraft((draft) => ({ ...draft, prefix: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-medium" htmlFor="edit-provider-base-url">Base URL<Input id="edit-provider-base-url" value={providerDraft.baseUrl} onChange={(event) => setProviderDraft((draft) => ({ ...draft, baseUrl: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-medium" htmlFor="edit-provider-protocol">Protocol<Input id="edit-provider-protocol" value={providerDraft.protocol} onChange={(event) => setProviderDraft((draft) => ({ ...draft, protocol: event.target.value }))} /></label>
              <label className="flex items-center gap-3 text-sm font-medium" htmlFor="edit-provider-enabled"><Switch id="edit-provider-enabled" checked={providerDraft.enabled} onCheckedChange={(enabled) => setProviderDraft((draft) => ({ ...draft, enabled }))} />Provider enabled</label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setProviderEditOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!providerDraft.name.trim() || !providerDraft.prefix.trim() || !providerDraft.protocol.trim() || !providerDraft.baseUrl.trim()}>Save provider</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRoundIcon className="size-5" />
            <CardTitle>API keys</CardTitle>
          </div>
          <CardDescription>
            Priority is fill-first: the top enabled credential receives requests
            first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                aria-label="New upstream API key label"
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                placeholder="New upstream credential"
              />
              <Button
                onClick={() => {
                  if (newKey.trim()) {
                    setKeyNames((items) => [...items, newKey]);
                    setNewKey("");
                    notify("Provider key added");
                  }
                }}
              >
                <PlusIcon />
                Add key
              </Button>
            </div>
            {keyNames.map((key, index) => (
              <div
                className="flex items-center gap-3 rounded-lg border p-3"
                key={key}
              >
                <span className="w-7 text-center text-sm font-medium text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 font-medium">{key}</span>
                <Badge variant="secondary">Enabled</Badge>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${key} up`}
                  disabled={index === 0}
                  onClick={() =>
                    setKeyNames((items) => {
                      const next = [...items];
                      [next[index - 1], next[index]] = [
                        next[index],
                        next[index - 1],
                      ];
                      return next;
                    })
                  }
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${key} down`}
                  disabled={index === keyNames.length - 1}
                  onClick={() =>
                    setKeyNames((items) => {
                      const next = [...items];
                      [next[index + 1], next[index]] = [
                        next[index],
                        next[index + 1],
                      ];
                      return next;
                    })
                  }
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${key}`}
                  onClick={() =>
                    setKeyNames((items) => items.filter((item) => item !== key))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>
            Expose upstream models behind the {provider.prefix}/ prefix.
          </CardDescription>
          <CardAction>
            <Button onClick={() => openModel()}>
              <PlusIcon />
              Add model
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Gateway ID</TableHead>
                <TableHead>Upstream model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {providerModels.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <span className="font-medium">{model.name}</span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{model.id}</code>
                  </TableCell>
                  <TableCell>{model.upstream}</TableCell>
                  <TableCell>
                    <Switch
                      checked={model.enabled}
                      onCheckedChange={(checked) =>
                        setModels((items) =>
                          items.map((item) =>
                            item.id === model.id
                              ? { ...item, enabled: checked }
                              : item,
                          ),
                        )
                      }
                      aria-label={`Enable ${model.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openModel(model)}
                    >
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog
        open={modelOpen}
        onOpenChange={(open) => {
          setModelOpen(open);
          if (!open) setEditingModel(null);
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (modelName.trim()) {
                if (editingModel) {
                  setModels((items) =>
                    items.map((item) =>
                      item.id === editingModel.id
                        ? { ...item, name: modelName, upstream: modelName }
                        : item,
                    ),
                  );
                } else {
                  setModels((items) => [
                    ...items,
                    {
                      id: `${provider.prefix}/${modelName.toLowerCase().replaceAll(" ", "-")}`,
                      name: modelName,
                      upstream: modelName,
                      provider: provider.id,
                      enabled: true,
                    },
                  ]);
                }
                setModelName("");
                setEditingModel(null);
                setModelOpen(false);
                notify(editingModel ? "Model updated" : "Model added");
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editingModel ? "Edit model" : "Add model"}
              </DialogTitle>
              <DialogDescription>
                Map an upstream model to this gateway provider.
              </DialogDescription>
            </DialogHeader>
            <Input
              className="my-4"
              autoFocus
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              placeholder="Model name"
            />
            <DialogFooter>
              <Button type="submit" disabled={!modelName.trim()}>
                {editingModel ? "Save model" : "Add model"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
