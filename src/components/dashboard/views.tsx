"use client";

import { useState, type FormEvent } from "react";
import type { DateRange } from "react-day-picker";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "@/components/ui/toast";
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  ClipboardIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LinkIcon,
  ListOrderedIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  Share2Icon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
  RouteIcon,
  BarChart3Icon,
  CalendarDaysIcon,
  WalletCardsIcon,
} from "lucide-react";
import { type DashboardRoute } from "@/components/app-sidebar";
import { CliproxyPage } from "@/components/dashboard/cliproxy-page";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
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
import { Calendar } from "@/components/ui/calendar";
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import {
  type Alias,
  type Budget,
  type Combo,
  type CodexModel,
  type GatewayKey,
  type Model,
  type PriceGroup,
  type Provider,
  consoleEntries,
  initialAliases,
  initialBudgets,
  initialCombos,
  initialCodexModels,
  initialGatewayKeys,
  initialModels,
  initialPriceGroups,
  initialProviders,
  modelMix,
  usageTrend,
} from "@/mock/dashboard-data";

type Props = {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  selectedProvider: Provider | null;
  onSelectProvider: (provider: Provider | null) => void;
};
type Editor = "key" | "provider" | "model" | "alias" | "combo" | "price" | null;

const trendConfig = {
  requests: { label: "Requests", color: "#18181b" },
  cost: { label: "Cost", color: "#a16207" },
} satisfies ChartConfig;
const mixConfig = {
  gpt: { label: "GPT-5", color: "#18181b" },
  sonnet: { label: "Sonnet", color: "#71717a" },
  haiku: { label: "Haiku", color: "#a1a1aa" },
  llama: { label: "Llama", color: "#d4d4d8" },
} satisfies ChartConfig;

function copy(value: string, label = "Copied") {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
  toast.add({ title: label, type: "success" });
}

function notify(message: string, type: "success" | "info" | "error" = "success") {
  toast.add({ title: message, type });
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">{children}</div>
    </main>
  );
}
function Confirm({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DashboardViews({
  route,
  onNavigate,
  selectedProvider,
  onSelectProvider,
}: Props) {
  const keys = initialGatewayKeys;
  const [providers, setProviders] = useState(initialProviders);
  const [models, setModels] = useState(initialModels);
  const [codexModels, setCodexModels] = useState(initialCodexModels);
  const [aliases, setAliases] = useState(initialAliases);
  const [combos, setCombos] = useState(initialCombos);
  const [budgets, setBudgets] = useState(initialBudgets);
  const [priceGroups, setPriceGroups] = useState(initialPriceGroups);
  if (route === "endpoint")
    return <EndpointKeys />;
  if (route === "cliproxy") return <CliproxyPage />;
  if (route === "providers")
    return selectedProvider ? (
      <ProviderDetail
        provider={selectedProvider}
        setProvider={onSelectProvider}
        setProviders={setProviders}
        models={models}
        setModels={setModels}
      />
    ) : (
      <Providers
        providers={providers}
        setProviders={setProviders}
        onSelect={onSelectProvider}
        onNavigate={onNavigate}
      />
    );
  if (route === "codex")
    return <CodexProviders models={codexModels} setModels={setCodexModels} />;
  if (route === "routing")
    return (
      <Routing
        aliases={aliases}
        setAliases={setAliases}
        combos={combos}
        setCombos={setCombos}
        models={models}
      />
    );
  if (route === "usage") return <Usage />;
  if (route === "budgets")
    return <Budgets budgets={budgets} setBudgets={setBudgets} keys={keys} />;
  if (route === "pricing")
    return (
      <Pricing
        groups={priceGroups}
        setGroups={setPriceGroups}
        models={models}
      />
    );
  if (route === "logs") return <ConsoleLog />;
  if (route === "settings") return <Settings />;
  return <ToolGateway route={route} onNavigate={onNavigate} />;
}

function EndpointKeys() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`;
  async function revealKey() {
    if (keyVisible) {
      setKeyVisible(false);
      setApiKey(null);
      return;
    }
    if (apiKey) {
      setKeyVisible(true);
      return;
    }
    setKeyLoading(true);
    setKeyError(null);
    try {
      const response = await fetch("/api/cliproxy/key", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(
          response.ok
            ? "The key endpoint returned invalid JSON."
            : `Could not load the key (HTTP ${response.status}).`,
        );
      }
      if (!response.ok) {
        const body = payload as { error?: unknown; message?: unknown } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : typeof body?.message === "string"
              ? body.message
              : `Could not load the key (HTTP ${response.status}).`,
        );
      }
      const body = payload as { key?: unknown; apiKey?: unknown } | string | null;
      const value =
        typeof body === "string"
          ? body
          : typeof body?.key === "string"
            ? body.key
            : typeof body?.apiKey === "string"
              ? body.apiKey
              : null;
      if (!value) throw new Error("The key endpoint response did not include an API key.");
      setApiKey(value);
      setKeyVisible(true);
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : "Could not load the CLIProxyAPI key.");
    } finally {
      setKeyLoading(false);
    }
  }
  async function copyNativeKey() {
    if (!apiKey) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(apiKey);
      notify("CLIProxyAPI key copied");
    } catch {
      setKeyError("Clipboard access failed. Reveal the key to select and copy it manually.");
    }
  }
  return (
    <Page>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <RouteIcon className="size-5" />
            <CardTitle>API Endpoint</CardTitle>
          </div>
          <CardDescription>
            OpenAI-compatible base URL on this same origin. Requests are forwarded to CLIProxyAPI when the managed service is installed and running.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <Badge variant="secondary">OpenAI API</Badge>
            <code className="min-w-0 flex-1 truncate text-sm">
              {endpoint}
            </code>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Copy API endpoint"
              onClick={() => copy(endpoint, "Endpoint copied")}
            >
              <CopyIcon />
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>CLIProxyAPI key</CardTitle>
          <CardDescription>
            Native proxy credential for authenticated API requests. This administrator-only secret is fetched on demand and hidden by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Administrator-managed credential</p>
              <code className="mt-1 block break-all text-xs text-muted-foreground">
                {apiKey && keyVisible ? apiKey : "Hidden until explicitly revealed"}
              </code>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" onClick={() => void revealKey()} disabled={keyLoading}>
                {keyLoading ? <RefreshCwIcon className="animate-spin" /> : null}
                {keyVisible ? "Hide key" : apiKey ? "Reveal key" : "Load & reveal"}
              </Button>
              {apiKey && keyVisible && (
                <Button variant="outline" onClick={() => void copyNativeKey()}>
                  <CopyIcon /> Copy
                </Button>
              )}
            </div>
          </div>
          {keyError && (
            <p role="alert" className="text-sm text-destructive">{keyError}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Dashboard-created gateway keys are not supported and are not shown here. Use this native key as a Bearer token with the endpoint above.
          </p>
        </CardContent>
      </Card>
    </Page>
  );
}

function Providers({
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
                <TableCell className="font-medium">Codex Providers</TableCell>
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

function ProviderDetail({
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

function CodexProviders({
  models,
  setModels,
}: {
  models: CodexModel[];
  setModels: React.Dispatch<React.SetStateAction<CodexModel[]>>;
}) {
  const [accounts, setAccounts] = useState([
    {
      id: "codex-work",
      name: "Work Codex",
      plan: "Team",
      enabled: true,
      quota: 62,
    },
    {
      id: "codex-personal",
      name: "Personal Codex",
      plan: "Plus",
      enabled: true,
      quota: 28,
    },
  ]);
  const [connect, setConnect] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Codex Providers</CardTitle>
          <CardDescription>
            OAuth-backed Codex accounts use fill-first priority and report mock
            quota windows.
          </CardDescription>
          <CardAction>
            <Button onClick={() => setConnect(true)}>
              <PlusIcon />
              Add Codex account
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account, index) => (
                <TableRow
                  key={account.id}
                  style={!account.enabled ? { opacity: 0.6 } : undefined}
                >
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${account.name} up`}
                        disabled={index === 0}
                        onClick={() =>
                          setAccounts((items) => {
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
                        aria-label={`Move ${account.name} down`}
                        disabled={index === accounts.length - 1}
                        onClick={() =>
                          setAccounts((items) => {
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
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{account.name}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{account.plan}</Badge>
                  </TableCell>
                  <TableCell className="min-w-36">
                    <div className="mb-1 flex justify-between text-xs">
                      <span>Weekly</span>
                      <span>{account.quota}% left</span>
                    </div>
                    <Progress value={account.quota} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={account.enabled}
                      onCheckedChange={(enabled) =>
                        setAccounts((items) =>
                          items.map((item) =>
                            item.id === account.id
                              ? { ...item, enabled }
                              : item,
                          ),
                        )
                      }
                      aria-label={`Enable ${account.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={account.quota > 0}
                        onClick={() =>
                          notify("Codex reset credit redeemed")
                        }
                      >
                        Redeem
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${account.name}`}
                        onClick={() => setRemove(account.id)}
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
          <CardTitle>Built-in Codex models</CardTitle>
          <CardDescription>
            Toggle default model mappings used by connected accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {models.slice(0, 3).map((model) => (
              <div
                className="flex items-center justify-between rounded-lg border p-3"
                key={model.id}
              >
                <span>
                  <span className="block font-medium">{model.name}</span>
                  <code className="text-xs text-muted-foreground">
                    {model.id}
                  </code>
                </span>
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
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Dialog open={connect} onOpenChange={setConnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Codex account</DialogTitle>
            <DialogDescription>
              No external OAuth session is opened. Complete this action to add a
              demo account to the local mock list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              variant="outline"
              onClick={() => notify("Mock device authorization started", "info")}
            >
              <ExternalLinkIcon />
              Open Codex sign-in
            </Button>
            <Input
              aria-label="Optional redirect URL reference"
              placeholder="http://localhost:1455/auth/callback?code=..."
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setConnect(false);
                setAccounts((items) => [
                  ...items,
                  {
                    id: crypto.randomUUID(),
                    name: "New Codex account",
                    plan: "Plus",
                    enabled: true,
                    quota: 100,
                  },
                ]);
                notify("Codex account connected");
              }}
            >
              Add demo account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(open) => !open && setRemove(null)}
        title="Remove Codex account?"
        description="This removes only local mock account data."
        onConfirm={() => {
          if (remove)
            setAccounts((items) => items.filter((item) => item.id !== remove));
          setRemove(null);
          notify("Codex account removed");
        }}
      />
    </Page>
  );
}

function Routing({
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
          <CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-5" />Aliases</CardTitle>
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
          <CardTitle className="flex items-center gap-2"><ListOrderedIcon className="size-5" />Combos</CardTitle>
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
          <CardTitle className="flex items-center gap-2"><Share2Icon className="size-5" />Shared Models</CardTitle>
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

function Usage() {
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
                  <Button variant="outline" className="h-8 min-w-0 justify-between font-normal sm:w-[220px]">
              <span className="truncate">{displayedRange?.from ? `${displayedRange.from.toLocaleDateString()}${displayedRange.to ? ` - ${displayedRange.to.toLocaleDateString()}` : ""}` : "Select date range"}</span>
                  <CalendarDaysIcon />
                  </Button>
                }
              />
              <PopoverContent align="start" className="w-auto p-0">
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
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
            {topKeys.length ? <ChartContainer config={{ cost: { label: "Cost", color: "#52525b" } }} className="h-52 w-full">
              <BarChart data={topKeys} layout="vertical" margin={{ left: 4, right: 8 }}><CartesianGrid horizontal={false} /><XAxis type="number" hide /><YAxis dataKey="name" type="category" width={116} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent formatter={(value) => <span>${Number(value).toFixed(2)}</span>} />} /><Bar dataKey="cost" radius={8}>{topKeys.map((item, index) => <Cell key={item.name} fill={["#27272a", "#71717a", "#a1a1aa"][index]} />)}</Bar></BarChart>
            </ChartContainer> : <p className="py-8 text-center text-sm text-muted-foreground">No keys have usage in this range.</p>}
            <div className="space-y-2">{topKeys.map((item) => <div key={item.name} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.requests.toLocaleString()} requests</div></div><div className="text-sm font-medium tabular-nums">${item.cost.toFixed(2)}</div></div>)}</div>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Card className="min-h-[28rem]"><CardHeader><CardDescription>Per-key detail</CardDescription><CardTitle>Usage table</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>No</TableHead><TableHead>Name</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">API-equivalent cost</TableHead></TableRow></TableHeader><TableBody>{usageByKey.length ? usageByKey.map((key, index) => <TableRow key={key.name}><TableCell className="text-muted-foreground">{index + 1}</TableCell><TableCell className="font-medium">{key.name}</TableCell><TableCell className="text-right tabular-nums">{key.requests.toLocaleString()}</TableCell><TableCell className="text-right tabular-nums">{formatTokens(key.tokens)}</TableCell><TableCell className="text-right tabular-nums">${key.cost.toFixed(2)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No mock usage in this range.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
        <Card className="min-h-[28rem]"><CardHeader><CardDescription>Model mix</CardDescription><CardTitle>Spend allocation</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
          {usageByKey.length ? <><ChartContainer config={mixConfig} className="mx-auto h-56 w-full max-w-72"><PieChart><ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} /><Pie data={modelMix} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3} /></PieChart></ChartContainer>
          <div className="space-y-2">{modelMix.map((item) => <div key={item.name} className="flex items-center gap-2 text-sm"><span className="size-2.5 rounded-full" style={{ background: item.fill }} /><span className="flex-1">{item.name}</span><span className="font-medium tabular-nums">{item.value}%</span></div>)}</div></> : <p className="py-8 text-center text-sm text-muted-foreground">No model mix is available in this range.</p>}
        </CardContent></Card>
      </div>
    </Page>
  );
}

function Budgets({
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
  const dateLabel = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`));
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
                      variant={unlimited ? "default" : "outline"}
                      className={unlimited ? "unlimited-button" : "unlimited-button-idle"}
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
                    <Switch checked={beyondLimits} onCheckedChange={setBeyondLimits} aria-label="Enable Beyond Limits" />
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
                <PopoverContent align="end" className="w-56 p-1">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">Order rows by</p>
                  {([ ["limit", "Highest limit first"], ["usage", "Highest usage first"], ["name", "API key name"] ] as const).map(([value, label]) => <Button key={value} variant={sortBy === value ? "secondary" : "ghost"} className="h-8 w-full justify-start" onClick={() => setSortBy(value)}>{label}</Button>)}
                </PopoverContent>
              </Popover>
            </div>
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
                {sortedBudgets.map((budget) => (
                  <TableRow key={budget.id}>
                    <TableCell>
                      <span className="font-medium">{budget.key}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                      <Switch
                        checked={budget.enabled}
                        onCheckedChange={(enabled) =>
                          setBudgets((items) =>
                            items.map((item) =>
                              item.id === budget.id
                                ? { ...item, enabled }
                                : item,
                            ),
                          )
                        }
                        aria-label={`Enable budget for ${budget.key}`}
                      />
                      <Badge variant={budget.enabled ? "secondary" : "outline"}>{budget.enabled ? "Active" : "Disabled"}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{unlimited ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-semibold"><span className="font-mono">∞</span>Unlimited</span> : `$${budget.limit.toFixed(2)}`}</TableCell>
                    <TableCell className="min-w-40">
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium text-muted-foreground">${budget.spent.toFixed(2)} / ${budget.limit.toFixed(2)}</span>
                        {unlimited ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold"><span className="font-mono">∞</span>Unlimited</span> : <span className="text-muted-foreground">{Math.round((budget.spent / budget.limit) * 100)}%</span>}
                      </div>
                      <Progress
                        className={unlimited ? "unlimited-progress" : undefined}
                        value={unlimited ? 100 : Math.min(100, (budget.spent / budget.limit) * 100)}
                      />
                      <div className="mt-1 text-xs text-muted-foreground">{unlimited ? "Unlimited Usage" : `$${Math.max(0, budget.limit - budget.spent).toFixed(2)} remaining`}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEdit(budget);
                          setEditLimit(String(budget.limit));
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete budget for ${budget.key}`}
                        onClick={() => setRemoveBudget(budget)}
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <Confirm
        open={confirmUnlimited}
        onOpenChange={setConfirmUnlimited}
        title={`${unlimited ? "Deactivate" : "Activate"} Unlimited Mode?`}
        description={
          unlimited
            ? "Budget limits will resume immediately."
            : "All configured budget limits will be bypassed."
        }
        onConfirm={() => {
          setUnlimited((value) => !value);
          setConfirmUnlimited(false);
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
      <Dialog
        open={Boolean(edit)}
        onOpenChange={(open) => !open && setEdit(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit budget</DialogTitle>
            <DialogDescription>
              Update the weekly limit for {edit?.key}.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 py-4 text-sm font-medium" htmlFor="edit-budget-limit">Weekly USD limit<Input id="edit-budget-limit" type="number" min="0.01" step="0.01" value={editLimit} onChange={(event) => setEditLimit(event.target.value)} /></label>
          <DialogFooter>
            <Button
              disabled={!Number.isFinite(Number(editLimit)) || Number(editLimit) <= 0}
              onClick={() => {
                if (edit)
                  setBudgets((items) =>
                    items.map((item) =>
                      item.id === edit.id
                        ? { ...item, limit: Number(editLimit) }
                        : item,
                    ),
                  );
                setEdit(null);
                notify("Budget updated");
              }}
            >
              Save limit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function Pricing({
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

function ConsoleLog() {
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

function ToolGateway({
  route,
  onNavigate,
}: {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
}) {
  const page = route.replace("tool-", "") as
    "overview" | "tools" | "connections" | "policies" | "activity" | "settings";
  const pageCopy: Record<
    Exclude<typeof page, "overview">,
    { title: string; description: string }
  > = {
    tools: {
      title: "Tools",
      description:
        "The Bun + React clone does not mount an Executor tools API or browser manager. This page is a visual mock only.",
    },
    connections: {
      title: "Connections",
      description:
        "No Executor connection API is mounted in this clone, so connections cannot be listed or edited here.",
    },
    policies: {
      title: "Policies",
      description:
        "No Executor policy API is mounted in this clone. Workspace-scoped policy controls are not available.",
    },
    activity: {
      title: "Activity",
      description:
        "This clone has no Executor activity or logs route, so no live event data is available.",
    },
    settings: {
      title: "Settings",
      description:
        "Executor is not configured by this clone. There are no Tool Gateway settings to display.",
    },
  };
  const navigation = [
    "tools",
    "connections",
    "policies",
    "activity",
    "settings",
  ] as const;
  return (
    <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Tool Gateway</CardTitle>
            <Badge variant="outline">Not available</Badge>
            <Badge variant="secondary">Local mock</Badge>
          </div>
          <CardDescription>
            This Bun + React clone does not include the optional Executor service or an API proxy route. The navigation below is presentation-only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No Tool Gateway API is mounted by this clone. The only server routes are authentication, health, database health, and the hello example.
          </div>
        </CardContent>
      </Card>
      {page === "overview" ? (
        <Card>
          <CardHeader>
            <CardTitle>Tool Gateway overview</CardTitle>
            <CardDescription>
              This overview preserves the original page hierarchy while clearly marking the integration as unavailable in this local mock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {navigation.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="rounded-lg border bg-muted/20 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onNavigate(`tool-${item}` as DashboardRoute)}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <WrenchIcon className="size-4" />
                    {item[0].toUpperCase() + item.slice(1)}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                  Open the local mock page; no Executor data is connected.
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{pageCopy[page].title}</CardTitle>
            <CardDescription>{pageCopy[page].description}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No workspace-scoped Executor data is shown in RawRoute.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
    </main>
  );
}

function Settings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword) {
      notify("Complete every password field", "error");
      return;
    }
    if (newPassword !== confirmPassword) {
      notify("New passwords do not match", "error");
      return;
    }
    notify("Password updates are not available in this local mock.", "info");
  }

  return (
    <Page>
      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <KeyRoundIcon className="size-5" />
              <CardTitle>Admin password</CardTitle>
            </div>
            <CardDescription>
              This clone uses Bun-managed password authentication. Password updates are not available in this mock dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
              The fields below are a visual mock only. They do not change your sign-in password.
            </div>
            <form className="grid gap-4" onSubmit={savePassword}>
              <label
                className="grid gap-2 text-sm font-medium"
                htmlFor="current-password"
              >
                Current password
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label
                className="grid gap-2 text-sm font-medium"
                htmlFor="new-password"
              >
                New password
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label
                className="grid gap-2 text-sm font-medium"
                htmlFor="confirm-password"
              >
                Confirm new password
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <div>
                <Button type="submit">Update password</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
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
          <CardTitle className="text-3xl tracking-tight">{value}</CardTitle>
          <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground"><Icon className="size-5" /></div>
        </div>
      </CardHeader>
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}
