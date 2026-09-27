"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  LinkIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Link } from "react-router";
import { dashboardPaths } from "@/lib/dashboard-routes";
import type {
  ProviderCredentialPatch,
  ProviderDetailDto,
  ProviderDto,
  ProviderInput,
  ProviderModelDto,
  ProviderModelInput,
  ProviderSyncDto,
} from "@/lib/providers-client";
import {
  providerDraftWithHeaders,
  providerHeaderEditorOnOpen,
  settleProviderDraft,
} from "@/components/dashboard/provider-dialog-state";
import { runProviderCleanupRetry } from "@/components/dashboard/provider-cleanup-state";
import type { ProviderResource } from "@/components/dashboard/use-providers";
import {
  Confirm,
  Metadata,
  Page,
  notify,
} from "@/components/dashboard/page-ui";
import { DataTableHeader } from "@/components/dashboard/data-table-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type ProviderActions = {
  reload: () => Promise<void>;
  read: <T>(
    operation: (
      api: ReturnType<typeof import("@/lib/providers-client").providerApi>,
      signal: AbortSignal,
    ) => Promise<T>,
  ) => Promise<T | undefined>;
  mutate: <T extends { sync?: ProviderSyncDto }>(
    key: string,
    operation: (
      api: ReturnType<typeof import("@/lib/providers-client").providerApi>,
      signal: AbortSignal,
    ) => Promise<T>,
  ) => Promise<T | undefined>;
  isPending: (key: string) => boolean;
};

const blankProvider = (): ProviderInput => ({
  name: "",
  prefix: "",
  baseUrl: "",
  protocol: "openai-chat",
  authType: "bearer",
  headers: {},
  enabled: true,
  supportPromptCacheKey: false,
});
const blankModel = (): ProviderModelInput => ({
  name: "",
  gatewaySuffix: "",
  upstreamModel: "",
  enabled: true,
});

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to save provider configuration.";
}
function protocolLabel(value: ProviderDto["protocol"]) {
  return value === "openai-chat"
    ? "OpenAI Chat"
    : value === "openai-responses"
      ? "OpenAI Responses"
      : "Anthropic Messages";
}
function syncLabel(sync?: ProviderSyncDto) {
  return sync ? sync.state.replaceAll("-", " ") : "status unavailable";
}

export function Providers({
  resource,
  ...actions
}: { resource: ProviderResource } & ProviderActions) {
  const [draft, setDraft] = useState<ProviderInput | null>(null);
  const [remove, setRemove] = useState<ProviderDto | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const removeKey = remove ? `delete-provider:${remove.id}` : "";

  async function save(
    event: FormEvent<HTMLFormElement>,
    submittedDraft?: ProviderInput,
  ) {
    event.preventDefault();
    const savedDraft = submittedDraft ?? draft;
    if (!savedDraft) return;
    setSaveError(null);
    try {
      const result = await actions.mutate("create-provider", (api, signal) =>
        api.createProvider(savedDraft, signal),
      );
      if (!result) return;
      setDraft(settleProviderDraft(savedDraft, true));
      notify("Provider saved");
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  }
  async function confirmDelete() {
    if (!remove) return;
    setSaveError(null);
    try {
      const result = await actions.mutate(removeKey, (api, signal) =>
        api.deleteProvider(remove.id, signal),
      );
      if (!result) return;
      setRemove(null);
      notify("Provider deleted. Cleanup status remains below.");
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  }

  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
          <CardDescription>
            Configure ordinary upstream providers. Saving desired state does not
            enable the public /v1 gateway.
          </CardDescription>
          <CardAction>
            <Button
              onClick={() => {
                setSaveError(null);
                setDraft(blankProvider());
              }}
              disabled={resource.phase === "loading"}
            >
              <PlusIcon />
              Add provider
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {resource.phase === "loading" ? (
            <ProviderSkeleton />
          ) : resource.phase === "error" ? (
            <LoadFailure error={resource.error} onRetry={actions.reload} />
          ) : resource.providers.length === 0 ? (
            <EmptyProviders />
          ) : (
            <Table>
              <DataTableHeader
                columns={[
                  { id: "provider", label: "Provider" },
                  { id: "prefix", label: "Prefix" },
                  { id: "protocol", label: "Protocol" },
                  { id: "origin", label: "Origin" },
                  { id: "keys", label: "API keys" },
                  { id: "models", label: "Models" },
                  { id: "sync", label: "Sync" },
                  { id: "actions", label: "" },
                ]}
              />
              <TableBody>
                {resource.providers.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell>
                      <Link
                        className="font-medium"
                        to={`${dashboardPaths.providers}/${encodeURIComponent(provider.id)}`}
                      >
                        {provider.name}
                      </Link>
                      {!provider.enabled && (
                        <Badge className="ml-2" variant="outline">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{provider.prefix}/</Badge>
                    </TableCell>
                    <TableCell>{protocolLabel(provider.protocol)}</TableCell>
                    <TableCell>
                      <span className="block max-w-56 truncate font-mono text-xs">
                        {provider.baseUrl}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium tabular-nums">
                        {provider.enabledApiKeyCount}/{provider.apiKeyCount}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        enabled
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium tabular-nums">
                        {provider.enabledModelCount}/{provider.modelCount}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        enabled
                      </span>
                    </TableCell>
                    <TableCell>
                      <SyncBadge sync={resource.syncByProvider[provider.id]} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${provider.name}`}
                          disabled={actions.isPending(
                            `delete-provider:${provider.id}`,
                          )}
                          onClick={() => {
                            setSaveError(null);
                            setRemove(provider);
                          }}
                        >
                          <Trash2Icon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Open ${provider.name}`}
                          nativeButton={false}
                          render={
                            <Link
                              to={`${dashboardPaths.providers}/${encodeURIComponent(provider.id)}`}
                            />
                          }
                        >
                          <ChevronRightIcon />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <CleanupCards syncs={resource.cleanup} {...actions} />
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <LinkIcon className="size-5" />
            <CardTitle>Codex Providers</CardTitle>
          </div>
          <CardDescription>
            Codex OAuth accounts are managed separately because their tokens
            remain in the private CLIProxy auth-file store.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to={dashboardPaths.codex} />}
          >
            Manage Codex accounts
            <ChevronRightIcon data-icon="inline-end" />
          </Button>
        </CardContent>
      </Card>
      <ProviderDialog
        mode="create"
        draft={draft}
        setDraft={setDraft}
        error={saveError}
        pending={actions.isPending("create-provider")}
        onSubmit={save}
      />
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(open) => !open && setRemove(null)}
        title={`Delete ${remove?.name}?`}
        description="The provider is removed from this workspace. Any private CLIProxy cleanup is tracked separately."
        onConfirm={() => void confirmDelete()}
        pending={actions.isPending(removeKey)}
        error={saveError}
      />
    </Page>
  );
}

export function ProviderDetail({
  provider,
  resource,
  ...actions
}: { provider: ProviderDto; resource: ProviderResource } & ProviderActions) {
  const [detail, setDetail] = useState<ProviderDetailDto | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderInput | null>(
    null,
  );
  const [modelDraft, setModelDraft] = useState<{
    model: ProviderModelInput;
    id?: string;
  } | null>(null);
  const [credentialDraft, setCredentialDraft] = useState<{
    name: string;
    key: string;
    enabled: boolean;
    rpmLimit?: number | null;
    maxConcurrency?: number | null;
    id?: string;
  } | null>(null);
  const [remove, setRemove] = useState<{
    kind: "credential" | "model";
    id: string;
    name: string;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const providerId = provider.id;

  const reloadDetail = useCallback(async () => {
    setPhase("loading");
    setLoadError(null);
    try {
      const result = await actions.read((api, signal) =>
        api.detail(providerId, signal),
      );
      if (!result) return;
      setDetail(result.provider);
      setPhase("ready");
    } catch (error) {
      setLoadError(errorMessage(error));
      setPhase("error");
    }
  }, [actions.read, providerId]);
  useEffect(() => {
    // The shared hook also guards workspace ownership. This local guard makes
    // a route/unmount completion a no-op before it reaches page-local state.
    let active = true;
    setPhase("loading");
    setLoadError(null);
    void actions
      .read((api, signal) => api.detail(providerId, signal))
      .then(
        (result) => {
          if (!active || !result) return;
          setDetail(result.provider);
          setPhase("ready");
        },
        (error: unknown) => {
          if (!active) return;
          setLoadError(errorMessage(error));
          setPhase("error");
        },
      );
    return () => {
      active = false;
    };
  }, [actions.read, providerId]);
  const current = detail ?? provider;
  const sync = resource.syncByProvider[providerId];
  async function mutateAndReload<T extends { sync?: ProviderSyncDto }>(
    key: string,
    operation: (
      api: ReturnType<typeof import("@/lib/providers-client").providerApi>,
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    setFormError(null);
    try {
      const result = await actions.mutate(key, operation);
      if (result) {
        await reloadDetail();
        return true;
      }
      return false;
    } catch (error) {
      setFormError(errorMessage(error));
      return false;
    }
  }
  async function saveProvider(
    event: FormEvent<HTMLFormElement>,
    submittedDraft?: ProviderInput,
  ) {
    event.preventDefault();
    const savedDraft = submittedDraft ?? providerDraft;
    if (!savedDraft) return;
    if (
      await mutateAndReload("update-provider", (api, signal) =>
        api.updateProvider(providerId, savedDraft, signal),
      )
    ) {
      setProviderDraft(null);
      notify("Provider saved");
    }
  }
  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modelDraft) return;
    const saved = await mutateAndReload(
      modelDraft.id ? `update-model:${modelDraft.id}` : "create-model",
      (api, signal) =>
        modelDraft.id
          ? api.updateModel(providerId, modelDraft.id, modelDraft.model, signal)
          : api.createModel(providerId, modelDraft.model, signal),
    );
    if (saved) {
      setModelDraft(null);
      notify("Model saved");
    }
  }
  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialDraft) return;
    const patch: ProviderCredentialPatch = {
      name: credentialDraft.name,
      enabled: credentialDraft.enabled,
      rpmLimit: credentialDraft.rpmLimit,
      maxConcurrency: credentialDraft.maxConcurrency,
      ...(credentialDraft.key ? { key: credentialDraft.key } : {}),
    };
    const saved = await mutateAndReload(
      credentialDraft.id
        ? `update-credential:${credentialDraft.id}`
        : "create-credential",
      (api, signal) =>
        credentialDraft.id
          ? api.updateCredential(providerId, credentialDraft.id, patch, signal)
          : api.createCredential(
              providerId,
              { ...patch, key: credentialDraft.key } as {
                name: string;
                key: string;
                enabled: boolean;
              },
              signal,
            ),
    );
    if (saved) {
      setCredentialDraft(null);
      notify("Credential saved");
    }
  }
  async function deleteChild() {
    if (!remove) return;
    const saved = await mutateAndReload(
      `delete-${remove.kind}:${remove.id}`,
      (api, signal) =>
        remove.kind === "credential"
          ? api.deleteCredential(providerId, remove.id, signal)
          : api.deleteModel(providerId, remove.id, signal),
    );
    if (saved) {
      setRemove(null);
      notify(
        `${remove.kind === "credential" ? "Credential" : "Model"} deleted`,
      );
    }
  }
  async function retry() {
    await mutateAndReload(`sync:${providerId}`, (api, signal) =>
      api.retrySync(providerId, signal).then((sync) => ({ sync })),
    );
  }
  async function reorder(credentialId: string, direction: -1 | 1) {
    if (!detail) return;
    const index = detail.credentials.findIndex(
      (credential) => credential.id === credentialId,
    );
    const orderedIds = detail.credentials.map((credential) => credential.id);
    [orderedIds[index], orderedIds[index + direction]] = [
      orderedIds[index + direction],
      orderedIds[index],
    ];
    await mutateAndReload("reorder-credentials", (api, signal) =>
      api.reorderCredentials(providerId, orderedIds, signal),
    );
  }

  return (
    <Page>
      <div>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-3"
          nativeButton={false}
          render={<Link to={dashboardPaths.providers} />}
        >
          <ArrowLeftIcon />
          Providers
        </Button>
        <h2 className="mt-2 text-2xl font-semibold">{current.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {current.enabledApiKeyCount}/{current.apiKeyCount} enabled credentials
          and {current.enabledModelCount}/{current.modelCount} enabled models
        </p>
      </div>
      {phase === "error" ? (
        <LoadFailure error={loadError} onRetry={reloadDetail} />
      ) : phase === "loading" && !detail ? (
        <ProviderSkeleton />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Provider details</CardTitle>
              <CardDescription>
                <span className="font-mono">{current.baseUrl}</span>
              </CardDescription>
              <CardAction>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFormError(null);
                    setProviderDraft(toDraft(current));
                  }}
                >
                  Edit
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metadata label="Gateway prefix" value={`${current.prefix}/`} />
                <Metadata
                  label="Protocol"
                  value={protocolLabel(current.protocol)}
                />
                <Metadata label="Authentication" value={current.authType} />
              </div>
              {current.protocol === "openai-responses" && (
                <p className="mt-4 text-sm text-muted-foreground">
                  Responses projection is native-execution pending; it does not
                  activate public /v1 routing.
                </p>
              )}
              <SyncNotice
                sync={sync}
                pending={actions.isPending(`sync:${providerId}`)}
                onRetry={retry}
              />
            </CardContent>
          </Card>
          <CredentialsCard
            detail={detail}
            onAdd={() => {
              setFormError(null);
              setCredentialDraft({ name: "", key: "", enabled: true, rpmLimit: 60, maxConcurrency: 4 });
            }}
            onEdit={(credential) => {
              setFormError(null);
              setCredentialDraft({
                id: credential.id,
                name: credential.name,
                key: "",
                enabled: credential.enabled,
                rpmLimit: credential.rpmLimit,
                maxConcurrency: credential.maxConcurrency,
              });
            }}
            onDelete={(credential) =>
              setRemove({
                kind: "credential",
                id: credential.id,
                name: credential.name,
              })
            }
            onToggle={(credential, enabled) =>
              void mutateAndReload(
                `update-credential:${credential.id}`,
                (api, signal) =>
                  api.updateCredential(
                    providerId,
                    credential.id,
                    { enabled },
                    signal,
                  ),
              )
            }
            onMove={reorder}
            pending={actions.isPending}
          />
          <ModelsCard
            workspaceId={current.workspaceId}
            models={detail?.models ?? []}
            onAdd={() => {
              setFormError(null);
              setModelDraft({ model: blankModel() });
            }}
            onEdit={(model) => {
              setFormError(null);
              setModelDraft({
                id: model.id,
                model: {
                  name: model.name,
                  gatewaySuffix: model.gatewaySuffix,
                  upstreamModel: model.upstreamModel,
                  enabled: model.enabled,
                  source: model.source,
                  reasoningCapability: model.reasoningCapability,
                },
              });
            }}
            onDelete={(model) =>
              setRemove({ kind: "model", id: model.id, name: model.name })
            }
            onToggle={(model, enabled) =>
              void mutateAndReload(`update-model:${model.id}`, (api, signal) =>
                api.updateModel(providerId, model.id, { enabled }, signal),
              )
            }
            pending={actions.isPending}
          />
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </>
      )}
      <ProviderDialog
        mode="edit"
        draft={providerDraft}
        setDraft={setProviderDraft}
        error={formError}
        pending={actions.isPending("update-provider")}
        onSubmit={saveProvider}
      />
      <ModelDialog
        draft={modelDraft}
        setDraft={setModelDraft}
        prefix={current.prefix}
        error={formError}
        pending={actions.isPending(
          modelDraft?.id ? `update-model:${modelDraft.id}` : "create-model",
        )}
        onSubmit={saveModel}
      />
      <CredentialDialog
        draft={credentialDraft}
        setDraft={setCredentialDraft}
        error={formError}
        pending={actions.isPending(
          credentialDraft?.id
            ? `update-credential:${credentialDraft.id}`
            : "create-credential",
        )}
        onSubmit={saveCredential}
      />
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(open) => !open && setRemove(null)}
        title={`Delete ${remove?.name}?`}
        description="The saved provider configuration will be removed and sync attempted."
        onConfirm={() => void deleteChild()}
        pending={actions.isPending(
          remove ? `delete-${remove.kind}:${remove.id}` : "",
        )}
        error={formError}
      />
    </Page>
  );
}

function toDraft(provider: ProviderDto): ProviderInput {
  return {
    name: provider.name,
    prefix: provider.prefix,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    authType: provider.authType,
    headers: provider.headers,
    enabled: provider.enabled,
    supportPromptCacheKey: provider.supportPromptCacheKey,
  };
}
type ProviderDialogProps = {
  mode: "create" | "edit";
  draft: ProviderInput | null;
  setDraft: (draft: ProviderInput | null) => void;
  error: string | null;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>, draft: ProviderInput) => void;
};

function ProviderDialog({
  mode,
  draft,
  setDraft,
  error,
  pending,
  onSubmit,
}: ProviderDialogProps) {
  if (!draft) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && setDraft(null)}>
      <DialogContent>
        <ProviderDialogForm
          mode={mode}
          draft={draft}
          setDraft={setDraft}
          error={error}
          pending={pending}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProviderDialogForm({
  mode,
  draft,
  setDraft,
  error,
  pending,
  onSubmit,
}: Omit<ProviderDialogProps, "draft"> & { draft: ProviderInput }) {
  const [headerEditor, setHeaderEditor] = useState<{
    open: boolean;
    text: string;
  }>(() => providerHeaderEditorOnOpen(null, draft, true));
  const [headersError, setHeadersError] = useState<string | null>(null);
  const headersText = headerEditor.text;
  const set = <K extends keyof ProviderInput>(
    key: K,
    value: ProviderInput[K],
  ) => setDraft({ ...draft, [key]: value });
  const allowedAuth =
    draft.protocol === "anthropic-messages"
      ? (["bearer", "x-api-key"] as const)
      : (["bearer", "none"] as const);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const submittedDraft = providerDraftWithHeaders(draft, headersText);
          setHeadersError(null);
          onSubmit(event, submittedDraft);
        } catch {
          setHeadersError("Static headers must be valid JSON.");
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {mode === "edit" ? "Edit provider" : "Add provider"}
        </DialogTitle>
        <DialogDescription>
          Desired state is saved per workspace and projected privately to
          CLIProxy.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="provider-name">Full name</FieldLabel>
          <Input
            id="provider-name"
            autoFocus
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-prefix">Gateway prefix</FieldLabel>
          <Input
            id="provider-prefix"
            value={draft.prefix}
            onChange={(event) => set("prefix", event.target.value)}
          />
          <FieldDescription>
            Lowercase letters, numbers, and hyphens. Model previews update from
            this prefix.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-url">Base URL</FieldLabel>
          <Input
            id="provider-url"
            type="url"
            value={draft.baseUrl}
            onChange={(event) => set("baseUrl", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Protocol</FieldLabel>
          <Select
            value={draft.protocol}
            onValueChange={(value) => {
              if (value) {
                const protocol = value as ProviderDto["protocol"];
                setDraft({
                  ...draft,
                  protocol,
                  authType:
                    protocol === "anthropic-messages"
                      ? "bearer"
                      : draft.authType === "x-api-key"
                        ? "bearer"
                        : draft.authType,
                });
              }
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="openai-chat">OpenAI Chat</SelectItem>
                <SelectItem value="openai-responses">
                  OpenAI Responses
                </SelectItem>
                <SelectItem value="anthropic-messages">
                  Anthropic Messages
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Authentication</FieldLabel>
          <Select
            value={draft.authType}
            onValueChange={(value) =>
              value && set("authType", value as ProviderDto["authType"])
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {allowedAuth.map((auth) => (
                  <SelectItem key={auth} value={auth}>
                    {auth === "x-api-key"
                      ? "x-api-key"
                      : auth === "bearer"
                        ? "Bearer API key"
                        : "No authentication"}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {draft.protocol !== "anthropic-messages" && <Field orientation="horizontal">
          <Switch id="provider-prompt-cache-key" checked={draft.supportPromptCacheKey === true} onCheckedChange={(supportPromptCacheKey) => set("supportPromptCacheKey", supportPromptCacheKey)} />
          <FieldLabel htmlFor="provider-prompt-cache-key">Support prompt cache key</FieldLabel>
          <FieldDescription>Stored provider capability for later executor mapping.</FieldDescription>
        </Field>}
        <Field>
          <FieldLabel htmlFor="provider-headers">
            Static JSON headers
          </FieldLabel>
          <Textarea
            id="provider-headers"
            value={headersText}
            onChange={(event) =>
              setHeaderEditor({ open: true, text: event.target.value })
            }
          />
          <FieldDescription>
            Authorization and transport headers are intentionally rejected.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch
            id="provider-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => set("enabled", enabled)}
          />
          <FieldLabel htmlFor="provider-enabled">Provider enabled</FieldLabel>
        </Field>
      </FieldGroup>
      {(headersError || error) && (
        <p role="alert" className="text-sm text-destructive">
          {headersError ?? error}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setDraft(null)}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            pending ||
            !draft.name.trim() ||
            !draft.prefix.trim() ||
            !draft.baseUrl.trim()
          }
        >
          {pending ? "Saving…" : "Save provider"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CredentialsCard({
  detail,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
  onMove,
  pending,
}: {
  detail: ProviderDetailDto | null;
  onAdd: () => void;
  onEdit: (credential: ProviderDetailDto["credentials"][number]) => void;
  onDelete: (credential: ProviderDetailDto["credentials"][number]) => void;
  onToggle: (
    credential: ProviderDetailDto["credentials"][number],
    enabled: boolean,
  ) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  pending: (key: string) => boolean;
}) {
  const credentials = detail?.credentials ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-5" />
          <CardTitle>API keys</CardTitle>
        </div>
        <CardDescription>
          Secrets are write-only. Existing key material is never shown in the
          browser.
        </CardDescription>
        <CardAction>
          <Button onClick={onAdd}>
            <PlusIcon />
            Add key
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upstream credentials configured.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {credentials.map((credential, index) => (
              <div
                className="flex items-center gap-3 rounded-lg border p-3"
                key={credential.id}
              >
                <span className="w-7 text-center text-sm font-medium text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 font-medium">
                  {credential.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    Configured
                  </span>
                </span>
                <Switch
                  aria-label={`Enable ${credential.name}`}
                  checked={credential.enabled}
                  disabled={pending(`update-credential:${credential.id}`)}
                  onCheckedChange={(enabled) => onToggle(credential, enabled)}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${credential.name} up`}
                  disabled={index === 0 || pending("reorder-credentials")}
                  onClick={() => onMove(credential.id, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${credential.name} down`}
                  disabled={
                    index === credentials.length - 1 ||
                    pending("reorder-credentials")
                  }
                  onClick={() => onMove(credential.id, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onEdit(credential)}
                >
                  Edit
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${credential.name}`}
                  disabled={pending(`delete-credential:${credential.id}`)}
                  onClick={() => onDelete(credential)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
function ModelsCard({
  workspaceId,
  models,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
  pending,
}: {
  workspaceId: string;
  models: ProviderModelDto[];
  onAdd: () => void;
  onEdit: (model: ProviderModelDto) => void;
  onDelete: (model: ProviderModelDto) => void;
  onToggle: (model: ProviderModelDto, enabled: boolean) => void;
  pending: (key: string) => boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>
          Internal model identity is stable. The gateway ID tracks the current
          provider prefix.
        </CardDescription>
        <CardAction>
          <Button onClick={onAdd}>
            <PlusIcon />
            Add model
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models configured.</p>
        ) : (
          <Table>
            <DataTableHeader
              columns={[
                { id: "model", label: "Display name" },
                { id: "gateway", label: "Gateway ID" },
                { id: "upstream", label: "Upstream ID" },
                { id: "status", label: "Enabled" },
                { id: "actions", label: "" },
              ]}
            />
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <span className="font-medium">{model.name}</span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{model.gatewayModelId}</code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{model.upstreamModel}</code>
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`Enable ${model.name}`}
                      checked={model.enabled}
                      disabled={pending(`update-model:${model.id}`)}
                      onCheckedChange={(enabled) => onToggle(model, enabled)}
                    />
                  </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <ModelShareButton workspaceId={workspaceId} model={model} />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onEdit(model)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${model.name}`}
                        disabled={pending(`delete-model:${model.id}`)}
                        onClick={() => onDelete(model)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
/** Shared by ordinary provider and built-in Codex model catalog rows. */
export function ModelShareButton({ workspaceId, model }: { workspaceId: string; model: Pick<ProviderModelDto, "id" | "name" | "enabled"> }) {
  const [open, setOpen] = useState(false); const [targets, setTargets] = useState<Array<{ id: string; name: string; shared: boolean; available: boolean; status: "active" | "unavailable" }>>([]); const [selected, setSelected] = useState<string[]>([]); const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle"); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false); const [reload, setReload] = useState(0);
  const load = useCallback(async () => { const response = await fetch(`/api/model-shares?modelId=${encodeURIComponent(model.id)}`, { headers: { "x-rawroute-workspace-id": workspaceId } }); const body: unknown = await response.json().catch(() => ({})); if (!response.ok) throw new Error(typeof (body as { error?: unknown }).error === "string" ? String((body as { error: string }).error) : "Unable to load sharing targets."); return (body as { targets: Array<{ id: string; name: string; shared: boolean; available: boolean; status: "active" | "unavailable" }> }).targets; }, [model.id, workspaceId]);
  useEffect(() => { if (!open) return; let current = true; setPhase("loading"); setError(null); void load().then((next) => { if (!current) return; setTargets(next); setSelected(next.filter((item) => item.shared).map((item) => item.id)); setPhase("ready"); }, (reason: unknown) => { if (!current) return; setError(reason instanceof Error ? reason.message : "Unable to load sharing."); setPhase("error"); }); return () => { current = false; }; }, [open, load, reload]);
  async function save() { if (phase !== "ready") return; setSaving(true); setError(null); try { const response = await fetch("/api/model-shares", { method: "PUT", headers: { "content-type": "application/json", "x-rawroute-workspace-id": workspaceId }, body: JSON.stringify({ modelId: model.id, recipientWorkspaceIds: selected }) }); const body: unknown = await response.json().catch(() => ({})); if (!response.ok) throw new Error(typeof (body as { error?: unknown }).error === "string" ? String((body as { error: string }).error) : "Unable to save sharing."); setOpen(false); notify("Model sharing saved"); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save sharing."); } finally { setSaving(false); } }
  return <><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Share</Button><Dialog open={open} onOpenChange={(next) => !saving && setOpen(next)}><DialogContent><DialogHeader><DialogTitle>Share {model.name}</DialogTitle><DialogDescription>Grant active workspaces access through their own local alias. Existing grants stay selected when this source is temporarily unavailable.</DialogDescription></DialogHeader>{phase === "loading" ? <p className="text-sm text-muted-foreground" role="status">Loading sharing targets…</p> : phase === "error" ? <div className="flex items-center gap-2"><p className="text-sm text-destructive" role="alert">{error}</p><Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>Retry</Button></div> : <FieldGroup>{targets.map((target) => <Field key={target.id} orientation="horizontal"><Checkbox id={`share-${model.id}-${target.id}`} checked={selected.includes(target.id)} disabled={!target.available && !target.shared} onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, target.id])] : current.filter((id) => id !== target.id))} /><FieldLabel htmlFor={`share-${model.id}-${target.id}`}>{target.name}{target.shared && !target.available ? <Badge className="ml-2" variant="outline">Unavailable</Badge> : null}</FieldLabel></Field>)}{!targets.length && <FieldDescription>No other active workspaces are available.</FieldDescription>}</FieldGroup>}{phase !== "error" && error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={phase !== "ready" || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save sharing"}</Button></DialogFooter></DialogContent></Dialog></>;
}
function ModelDialog({
  draft,
  setDraft,
  prefix,
  error,
  pending,
  onSubmit,
}: {
  draft: { model: ProviderModelInput; id?: string } | null;
  setDraft: (draft: { model: ProviderModelInput; id?: string } | null) => void;
  prefix: string;
  error: string | null;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!draft) return null;
  const set = <K extends keyof ProviderModelInput>(
    key: K,
    value: ProviderModelInput[K],
  ) => setDraft({ ...draft, model: { ...draft.model, [key]: value } });
  return (
    <Dialog
      open={Boolean(draft)}
      onOpenChange={(open) => !open && !pending && setDraft(null)}
    >
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{draft.id ? "Edit model" : "Add model"}</DialogTitle>
            <DialogDescription>
              Gateway preview:{" "}
              <code>
                {prefix}/{draft.model.gatewaySuffix || "suffix"}
              </code>
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-name">Display name</FieldLabel>
              <Input
                id="model-name"
                autoFocus
                value={draft.model.name}
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="model-suffix">Gateway suffix</FieldLabel>
              <Input
                id="model-suffix"
                value={draft.model.gatewaySuffix}
                onChange={(event) => set("gatewaySuffix", event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="model-upstream">
                Upstream model ID
              </FieldLabel>
              <Input
                id="model-upstream"
                value={draft.model.upstreamModel}
                onChange={(event) => set("upstreamModel", event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Model source</FieldLabel>
              <Select value={draft.model.source ?? "custom"} onValueChange={(source) => source && set("source", source as "custom" | "builtin")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="custom">Custom</SelectItem><SelectItem value="builtin">Built-in</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Reasoning capability</FieldLabel>
              <Select value={draft.model.reasoningCapability?.mode ?? "enabled"} onValueChange={(mode) => mode && set("reasoningCapability", mode === "disabled" ? { mode: "disabled" } : { mode: "enabled" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="enabled">Enabled</SelectItem><SelectItem value="disabled">Disabled</SelectItem></SelectGroup></SelectContent>
              </Select>
              <FieldDescription>Capability metadata is exposed to later combo policy validation.</FieldDescription>
            </Field>
            {draft.model.reasoningCapability?.mode !== "disabled" && <Field>
              <FieldLabel htmlFor="model-reasoning-efforts">Supported reasoning efforts</FieldLabel>
              <Input id="model-reasoning-efforts" value={draft.model.reasoningCapability?.supportedEfforts?.join(", ") ?? ""} placeholder="low, medium, high" onChange={(event) => set("reasoningCapability", { mode: "enabled", ...(event.target.value.trim() ? { supportedEfforts: [...new Set(event.target.value.split(",").map((effort) => effort.trim()).filter(Boolean))] } : {}) })} />
            </Field>}
            <Field orientation="horizontal">
              <Switch
                id="model-enabled"
                checked={draft.model.enabled}
                onCheckedChange={(enabled) => set("enabled", enabled)}
              />
              <FieldLabel htmlFor="model-enabled">Model enabled</FieldLabel>
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !draft.model.name.trim() ||
                !draft.model.gatewaySuffix.trim() ||
                !draft.model.upstreamModel.trim()
              }
            >
              {pending ? "Saving…" : "Save model"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function CredentialDialog({
  draft,
  setDraft,
  error,
  pending,
  onSubmit,
}: {
  draft: { name: string; key: string; enabled: boolean; rpmLimit?: number | null; maxConcurrency?: number | null; id?: string } | null;
  setDraft: (
    draft: { name: string; key: string; enabled: boolean; rpmLimit?: number | null; maxConcurrency?: number | null; id?: string } | null,
  ) => void;
  error: string | null;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!draft) return null;
  const set = (key: "name" | "key" | "enabled" | "rpmLimit" | "maxConcurrency", value: string | boolean | number | null) =>
    setDraft({ ...draft, [key]: value });
  return (
    <Dialog
      open={Boolean(draft)}
      onOpenChange={(open) => !open && !pending && setDraft(null)}
    >
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>
              {draft.id ? "Edit API key" : "Add API key"}
            </DialogTitle>
            <DialogDescription>
              {draft.id
                ? "Leave the password empty to retain the configured secret."
                : "The secret is sent directly to the server and is never shown again."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="credential-name">Name</FieldLabel>
              <Input
                id="credential-name"
                autoFocus
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="credential-secret">Secret</FieldLabel>
              <Input
                id="credential-secret"
                type="password"
                autoComplete="new-password"
                value={draft.key}
                onChange={(event) => set("key", event.target.value)}
                placeholder={
                  draft.id
                    ? "Configured — enter a replacement"
                    : "Upstream API key"
                }
              />
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="credential-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => set("enabled", enabled)}
              />
              <FieldLabel htmlFor="credential-enabled">
                Credential enabled
              </FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="credential-rpm">Requests per minute (advisory)</FieldLabel>
              <Input id="credential-rpm" type="number" min={1} value={draft.rpmLimit ?? ""} onChange={(event) => set("rpmLimit", event.target.value ? Number(event.target.value) : null)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="credential-concurrency">Max concurrency (advisory)</FieldLabel>
              <Input id="credential-concurrency" type="number" min={1} value={draft.maxConcurrency ?? ""} onChange={(event) => set("maxConcurrency", event.target.value ? Number(event.target.value) : null)} />
              <FieldDescription>These limits are persisted only; request-time enforcement is not implemented.</FieldDescription>
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending || !draft.name.trim() || (!draft.id && !draft.key)
              }
            >
              {pending ? "Saving…" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function SyncBadge({ sync }: { sync?: ProviderSyncDto }) {
  return (
    <Badge
      variant={
        sync?.state === "error" || sync?.state === "cleanup-error"
          ? "destructive"
          : "outline"
      }
    >
      {syncLabel(sync)}
    </Badge>
  );
}
function SyncNotice({
  sync,
  pending,
  onRetry,
}: {
  sync?: ProviderSyncDto;
  pending: boolean;
  onRetry: () => void;
}) {
  if (!sync || sync.state === "applied") return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
      <SyncBadge sync={sync} />
      <span className="text-muted-foreground">
        {sync.error ??
          (sync.state === "native-execution-pending"
            ? "Native Responses execution is pending."
            : "Desired state is waiting for private CLIProxy sync.")}
      </span>
      <Button size="sm" variant="outline" disabled={pending} onClick={onRetry}>
        {pending ? "Retrying…" : "Retry sync"}
      </Button>
    </div>
  );
}
function CleanupCards({
  syncs,
  mutate,
  isPending,
}: Pick<ProviderActions, "mutate" | "isPending"> & {
  syncs: ProviderSyncDto[];
}) {
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  async function retryCleanup(sync: ProviderSyncDto) {
    const error = await runProviderCleanupRetry(
      async () =>
        await mutate(`cleanup:${sync.providerId}`, (api, signal) =>
          api
            .retrySync(sync.providerId, signal)
            .then((next) => ({ sync: next })),
        ),
    );
    setRetryErrors((current) =>
      error
        ? { ...current, [sync.providerId]: error }
        : Object.fromEntries(
            Object.entries(current).filter(
              ([providerId]) => providerId !== sync.providerId,
            ),
          ),
    );
  }
  if (!syncs.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deleted provider cleanup</CardTitle>
        <CardDescription>
          Removed providers are no longer listed, but private CLIProxy cleanup
          remains observable and retryable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {syncs.map((sync) => (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
              key={sync.providerId}
            >
              <SyncBadge sync={sync} />
              <code className="text-xs">{sync.providerId}</code>
              {sync.error && (
                <span className="text-sm text-muted-foreground">
                  {sync.error}
                </span>
              )}
              {retryErrors[sync.providerId] && (
                <span role="alert" className="text-sm text-destructive">
                  {retryErrors[sync.providerId]}
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={isPending(`cleanup:${sync.providerId}`)}
                onClick={() => void retryCleanup(sync)}
              >
                {isPending(`cleanup:${sync.providerId}`)
                  ? "Retrying…"
                  : "Retry cleanup"}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
function ProviderSkeleton() {
  return (
    <div
      className="flex flex-col gap-3"
      role="status"
      aria-label="Loading providers"
    >
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
function LoadFailure({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void | Promise<void>;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
      role="alert"
    >
      <p className="text-sm text-destructive">
        {error ?? "Providers could not be loaded."}
      </p>
      <Button size="sm" variant="outline" onClick={() => void onRetry()}>
        Retry
      </Button>
    </div>
  );
}
function EmptyProviders() {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">No providers yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Add an ordinary provider to configure credentials and models for this
        workspace.
      </p>
    </div>
  );
}
