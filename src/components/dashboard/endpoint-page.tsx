"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { copy, notify, Page } from "@/components/dashboard/page-ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cleanupDeletedGatewayKey, deleteGatewayKeyRequest, gatewayKeyFromResponse, gatewayKeyListFromResponse, gatewayKeyRequest, gatewayKeyResultFromResponse, type GatewayKey } from "@/lib/gateway-keys-client";
import { reportEvent } from "@/lib/logging/client";

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function formatDate(value: number) {
  return Number.isFinite(value) ? dateTime.format(new Date(value)) : "Unknown";
}

export function EndpointKeys({ workspaceId }: { workspaceId: string }) {
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [listVersion, setListVersion] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GatewayKey | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GatewayKey | null>(null);
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const activeWorkspaceId = useRef(workspaceId);
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`;

  function beginRequest() {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  }

  function ownsRequest(scope: string, controller: AbortController) {
    return !controller.signal.aborted && activeWorkspaceId.current === scope;
  }

  async function request<T>(scope: string, path: string, init: RequestInit, controller: AbortController): Promise<T> {
    try {
      return await gatewayKeyRequest<T>(fetch, scope, path, init, controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }

  async function deleteRequest(scope: string, keyId: string, controller: AbortController): Promise<void> {
    try {
      await deleteGatewayKeyRequest(fetch, scope, keyId, controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }

  useEffect(() => () => {
    // The page is keyed by workspace. Invalidate this instance before any late
    // mutation can publish a secret, a toast, or an event for a new selection.
    activeWorkspaceId.current = "";
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }, []);

  useEffect(() => {
    // The provider's active workspace is captured before each operation. On a
    // switch, abort all work and clear drafts/secrets before loading the new owner.
    activeWorkspaceId.current = workspaceId;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setKeys([]);
    setVisibleSecrets({});
    setCreateOpen(false);
    setCreateName("");
    setCustomValue("");
    setCreating(false);
    setRenameTarget(null);
    setRenameValue("");
    setRenaming(false);
    setDeleteTarget(null);
    setPendingKeyId(null);
    setOperationError(null);
    setListError(null);
    setLoading(true);

    const scope = workspaceId;
    const controller = beginRequest();
    void request(scope, "/api/gateway-keys", { method: "GET" }, controller)
      .then((payload) => {
        const nextKeys = gatewayKeyListFromResponse(payload, scope);
        if (!nextKeys) throw new Error("The gateway key service returned an invalid list.");
        if (ownsRequest(scope, controller)) setKeys(nextKeys);
      })
      .catch((error) => {
        if (ownsRequest(scope, controller)) setListError(error instanceof Error ? error.message : "Unable to load gateway keys.");
      })
      .finally(() => {
        if (ownsRequest(scope, controller)) setLoading(false);
      });

    return () => controller.abort();
  }, [listVersion, workspaceId]);

  function closeCreate() {
    if (creating) return;
    setCreateOpen(false);
    setCreateName("");
    setCustomValue("");
    setOperationError(null);
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    if (!name) return;
    const scope = workspaceId;
    const controller = beginRequest();
    setCreating(true);
    setOperationError(null);
    try {
      const result = gatewayKeyResultFromResponse(await request<unknown>(scope, "/api/gateway-keys", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, value: customValue }),
      }, controller), scope);
      if (!result) throw new Error("The gateway key service returned an invalid key.");
      if (!ownsRequest(scope, controller)) return;
      setKeys((current) => [result.key, ...current]);
      setVisibleSecrets((current) => ({ ...current, [result.key.id]: result.secret }));
      setCreateOpen(false);
      setCreateName("");
      setCustomValue("");
      reportEvent("gateway-keys.created", { page: "endpoint", workspaceId: scope, added: 1 });
      notify("Gateway key created. Copy it before hiding it.");
    } catch (error) {
      if (ownsRequest(scope, controller)) setOperationError(error instanceof Error ? error.message : "Unable to create gateway key.");
    } finally {
      if (ownsRequest(scope, controller)) setCreating(false);
    }
  }

  async function revealOrHide(key: GatewayKey) {
    if (visibleSecrets[key.id]) {
      setVisibleSecrets((current) => {
        const { [key.id]: _secret, ...remaining } = current;
        return remaining;
      });
      return;
    }
    const scope = workspaceId;
    const controller = beginRequest();
    setPendingKeyId(key.id);
    setOperationError(null);
    try {
      const result = gatewayKeyResultFromResponse(await request<unknown>(scope, `/api/gateway-keys/${encodeURIComponent(key.id)}/reveal`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }, controller), scope);
      if (!result || result.key.id !== key.id) throw new Error("The gateway key service returned an invalid key.");
      if (!ownsRequest(scope, controller)) return;
      setKeys((current) => current.map((item) => item.id === result.key.id ? result.key : item));
      setVisibleSecrets((current) => ({ ...current, [result.key.id]: result.secret }));
      reportEvent("gateway-keys.revealed", { page: "endpoint", workspaceId: scope });
    } catch (error) {
      if (ownsRequest(scope, controller)) setOperationError(error instanceof Error ? error.message : "Unable to reveal gateway key.");
    } finally {
      if (ownsRequest(scope, controller)) setPendingKeyId(null);
    }
  }

  async function copySecret(key: GatewayKey) {
    const secret = visibleSecrets[key.id];
    if (!secret) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(secret);
      reportEvent("gateway-key.copied", { page: "endpoint", workspaceId });
      notify("Gateway key copied");
    } catch {
      reportEvent("dashboard.copy-failed", { page: "endpoint", workspaceId });
      setOperationError("Clipboard access failed. Copy the visible key manually.");
    }
  }

  async function renameKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = renameTarget;
    const name = renameValue.trim();
    if (!target || !name) return;
    const scope = workspaceId;
    const controller = beginRequest();
    setRenaming(true);
    setOperationError(null);
    try {
      const key = gatewayKeyFromResponse(await request<unknown>(scope, `/api/gateway-keys/${encodeURIComponent(target.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      }, controller), scope);
      if (!key || key.id !== target.id) throw new Error("The gateway key service returned an invalid key.");
      if (!ownsRequest(scope, controller)) return;
      setKeys((current) => current.map((item) => item.id === key.id ? key : item));
      setRenameTarget(null);
      setRenameValue("");
      reportEvent("gateway-keys.renamed", { page: "endpoint", workspaceId: scope, updated: 1 });
      notify("Gateway key renamed");
    } catch (error) {
      if (ownsRequest(scope, controller)) setOperationError(error instanceof Error ? error.message : "Unable to rename gateway key.");
    } finally {
      if (ownsRequest(scope, controller)) setRenaming(false);
    }
  }

  async function deleteKey() {
    const target = deleteTarget;
    if (!target) return;
    const scope = workspaceId;
    const controller = beginRequest();
    setPendingKeyId(target.id);
    setOperationError(null);
    try {
      await deleteRequest(scope, target.id, controller);
      if (!ownsRequest(scope, controller)) return;
      const cleanup = cleanupDeletedGatewayKey(keys, visibleSecrets, target.id);
      setKeys(cleanup.keys);
      setVisibleSecrets(cleanup.visibleSecrets);
      setDeleteTarget(cleanup.deleteTarget);
      reportEvent("gateway-keys.deleted", { page: "endpoint", workspaceId: scope, removed: 1 });
      notify("Gateway key deleted");
    } catch (error) {
      if (ownsRequest(scope, controller)) setOperationError(error instanceof Error ? error.message : "Unable to delete gateway key.");
    } finally {
      if (ownsRequest(scope, controller)) setPendingKeyId(null);
    }
  }

  return (
    <Page>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><KeyRoundIcon /><CardTitle>Endpoint & keys</CardTitle></div>
          <CardDescription>Create credentials for this workspace. The OpenAI-compatible endpoint remains <code>/v1</code> on this origin.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
              <Badge variant="secondary">OpenAI API</Badge><code className="min-w-0 flex-1 truncate text-sm">{endpoint}</code>
              <Button size="icon-sm" variant="outline" aria-label="Copy API endpoint" onClick={() => void copy(endpoint, "Endpoint copied", { page: "endpoint", workspaceId })}><CopyIcon /></Button>
            </div>
            <p className="text-sm text-muted-foreground">Workspace keys authenticate recognized <code>/v1</code> requests for this workspace. Provider routing is not configured yet, so those requests return a routing-not-ready response.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace gateway keys</CardTitle>
          <CardDescription>Key values are returned only when you create or explicitly reveal them.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <Button className="self-start" onClick={() => { setOperationError(null); setCreateOpen(true); }} disabled={loading}><PlusIcon data-icon="inline-start" />Create key</Button>
            {operationError && <p role="alert" className="text-sm text-destructive">{operationError}</p>}
            {loading ? <KeyTableSkeleton /> : listError ? (
            <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-4"><p role="alert" className="text-sm text-destructive">{listError}</p><Button className="w-fit" variant="outline" onClick={() => setListVersion((version) => version + 1)}>Retry</Button></div>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6"><p className="font-medium">No workspace keys yet</p><p className="text-sm text-muted-foreground">Create a key to store a workspace credential securely.</p><Button variant="outline" onClick={() => setCreateOpen(true)}><PlusIcon data-icon="inline-start" />Create key</Button></div>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead>Updated</TableHead><TableHead>Key value</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>{keys.map((key) => {
                const secret = visibleSecrets[key.id];
                const pending = pendingKeyId === key.id;
                return <TableRow key={key.id}>
                  <TableCell><span className="font-medium">{key.name}</span></TableCell>
                  <TableCell><Badge variant={key.status === "active" ? "secondary" : "outline"}>{key.status}</Badge></TableCell>
                  <TableCell><span className="text-muted-foreground">{formatDate(key.createdAt)}</span></TableCell>
                  <TableCell><span className="text-muted-foreground">{formatDate(key.updatedAt)}</span></TableCell>
                  <TableCell className="max-w-80"><code className="block break-all text-xs">{secret ?? "Hidden"}</code></TableCell>
                  <TableCell><div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={pendingKeyId !== null} onClick={() => void revealOrHide(key)}>{pending ? <Spinner data-icon="inline-start" /> : secret ? <EyeOffIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}{secret ? "Hide" : "Reveal"}</Button>
                    {secret && <Button size="icon-sm" variant="outline" aria-label={`Copy ${key.name}`} onClick={() => void copySecret(key)}><CopyIcon /></Button>}
                    <Button size="icon-sm" variant="ghost" aria-label={`Rename ${key.name}`} disabled={pendingKeyId !== null} onClick={() => { setOperationError(null); setRenameTarget(key); setRenameValue(key.name); }}><PencilIcon /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${key.name}`} disabled={pendingKeyId !== null} onClick={() => { setOperationError(null); setDeleteTarget(key); }}><Trash2Icon /></Button>
                  </div></TableCell>
                </TableRow>;
              })}</TableBody>
            </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) closeCreate(); }}><DialogContent><form onSubmit={(event) => void createKey(event)}>
        <DialogHeader><DialogTitle>Create workspace gateway key</DialogTitle><DialogDescription>Use a generated value or provide a custom value. It is encrypted at rest and is only shown after creation or reveal.</DialogDescription></DialogHeader>
        <FieldGroup className="mt-5">
          <Field data-invalid={Boolean(operationError)}><FieldLabel htmlFor="gateway-key-name">Name</FieldLabel><Input id="gateway-key-name" autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} aria-invalid={Boolean(operationError)} disabled={creating} placeholder="Production service" /></Field>
          <Field><FieldLabel htmlFor="gateway-key-custom-value">Custom value <span className="text-muted-foreground">(optional)</span></FieldLabel><Input id="gateway-key-custom-value" type="password" value={customValue} onChange={(event) => setCustomValue(event.target.value)} disabled={creating} autoComplete="new-password" /><FieldDescription>Leave blank to generate a value. Custom values must be 32–256 printable characters without whitespace.</FieldDescription>{operationError && <FieldError>{operationError}</FieldError>}</Field>
        </FieldGroup>
        <DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={closeCreate}>Cancel</Button><Button type="submit" disabled={creating || !createName.trim()}>{creating && <Spinner data-icon="inline-start" />}Create key</Button></DialogFooter>
      </form></DialogContent></Dialog>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => { if (!open && !renaming) { setRenameTarget(null); setRenameValue(""); setOperationError(null); } }}><DialogContent><form onSubmit={(event) => void renameKey(event)}>
        <DialogHeader><DialogTitle>Rename gateway key</DialogTitle><DialogDescription>Changing a name does not change the key value.</DialogDescription></DialogHeader>
        <FieldGroup className="mt-5"><Field data-invalid={Boolean(operationError)}><FieldLabel htmlFor="gateway-key-rename">Name</FieldLabel><Input id="gateway-key-rename" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-invalid={Boolean(operationError)} disabled={renaming} />{operationError && <FieldError>{operationError}</FieldError>}</Field></FieldGroup>
        <DialogFooter><Button type="button" variant="outline" disabled={renaming} onClick={() => { setRenameTarget(null); setRenameValue(""); setOperationError(null); }}>Cancel</Button><Button type="submit" disabled={renaming || !renameValue.trim()}>{renaming && <Spinner data-icon="inline-start" />}Save name</Button></DialogFooter>
      </form></DialogContent></Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !pendingKeyId) setDeleteTarget(null); }}><AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle><AlertDialogDescription>This removes the key from this workspace. It cannot be listed or revealed again.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={Boolean(pendingKeyId)}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={Boolean(pendingKeyId)} onClick={() => void deleteKey()}>{pendingKeyId && <Spinner data-icon="inline-start" />}Delete key</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
    </Page>
  );
}

function KeyTableSkeleton() {
  return <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading gateway keys">{[1, 2, 3].map((row) => <Skeleton key={row} className="h-12" />)}</div>;
}
