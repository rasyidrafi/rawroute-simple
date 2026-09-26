"use client";

import { CopyIcon, PencilIcon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react";
import { copy, Page } from "@/components/dashboard/page-ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useEndpointKeys } from "@/components/dashboard/use-endpoint-keys";

const maskedKeyValue = "••••••••••••••••••••••••";

export function EndpointKeys({ workspaceId }: { workspaceId: string }) {
  const {
    keys, loading, listError, operationError, visibleSecrets, createOpen, createName,
    customValue, creating, createdKey, copyingCreated, renameTarget, renameValue,
    renaming, deleteTarget, pendingKeyId, setListVersion, setOperationError,
    setCreateOpen, setCreateName, setCustomValue, setCreatedKey, setCopyingCreated,
    setRenameTarget, setRenameValue, setDeleteTarget, closeCreate, createKey,
    revealOrHide, copySecret, copyCreatedSecret, renameKey, deleteKey,
  } = useEndpointKeys(workspaceId);
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`;

  return (
    <Page>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><RouteIcon /><CardTitle>API Endpoint</CardTitle></div>
          <CardDescription>Use this base URL with the native protocol endpoint supported by each model.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <Badge variant="secondary" className="shrink-0">Gateway</Badge>
            <code className="min-w-0 flex-1 truncate text-sm">{endpoint}</code>
            <Button size="icon-sm" variant="outline" aria-label="Copy API endpoint" onClick={() => void copy(endpoint, "Endpoint copied", { page: "endpoint", workspaceId })}><CopyIcon /></Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gateway API keys</CardTitle>
          <CardDescription>Clients use these keys to access every proxy endpoint.</CardDescription>
          <CardAction><Button onClick={() => { setOperationError(null); setCreateOpen(true); }} disabled={loading}><PlusIcon data-icon="inline-start" />Create key</Button></CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {operationError && <p role="alert" className="text-sm text-destructive">{operationError}</p>}
            {loading ? <KeyTableSkeleton /> : listError ? (
            <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-4"><p role="alert" className="text-sm text-destructive">{listError}</p><Button className="w-fit" variant="outline" onClick={() => setListVersion((version) => version + 1)}>Retry</Button></div>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center"><p className="font-medium">No gateway API keys</p><p className="mt-1 text-sm text-muted-foreground">Create a key before sending requests through this workspace.</p></div>
          ) : (
            <>{keys.map((key) => {
                const secret = visibleSecrets[key.id];
                const pending = pendingKeyId === key.id;
                return <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{key.name}</div>
                    {secret ? (
                      <div className="flex min-w-0 items-start gap-1">
                        <code className="min-w-0 flex-1 select-text break-all text-xs text-muted-foreground">{secret}</code>
                        <Button size="xs" variant="ghost" aria-label={`Hide ${key.name}`} disabled={pendingKeyId !== null} onClick={() => void revealOrHide(key)}>Hide</Button>
                      </div>
                    ) : (
                      <Button size="xs" variant="ghost" className="max-w-full justify-start" aria-label={`Reveal ${key.name}`} disabled={pendingKeyId !== null} onClick={() => void revealOrHide(key)}>{pending ? <Spinner data-icon="inline-start" /> : <code className="block truncate text-xs text-muted-foreground">{maskedKeyValue}</code>}</Button>
                    )}
                  </div>
                  <Button aria-label={`Copy ${key.name}`} size="icon-sm" variant="outline" disabled={pendingKeyId !== null} onClick={() => void copySecret(key)}>{pending ? <Spinner /> : <CopyIcon />}</Button>
                  <Button aria-label={`Edit ${key.name}`} size="icon-sm" variant="outline" disabled={pendingKeyId !== null} onClick={() => { setOperationError(null); setRenameTarget(key); setRenameValue(key.name); }}><PencilIcon /></Button>
                  <Button aria-label={`Delete ${key.name}`} size="icon-sm" variant="destructive" disabled={pendingKeyId !== null} onClick={() => { setOperationError(null); setDeleteTarget(key); }}><Trash2Icon /></Button>
                </div>;
              })}</>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) closeCreate(); }}><DialogContent><form onSubmit={(event) => void createKey(event)}>
        <DialogHeader><DialogTitle>Create API key</DialogTitle><DialogDescription>Give this key a recognizable name. Leave the value blank to generate a secure key.</DialogDescription></DialogHeader>
        <FieldGroup className="mt-5">
          <Field data-invalid={Boolean(operationError)}><FieldLabel htmlFor="gateway-key-name">Key name</FieldLabel><Input id="gateway-key-name" autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} aria-invalid={Boolean(operationError)} disabled={creating} placeholder="Production gateway" /></Field>
          <Field><FieldLabel htmlFor="gateway-key-custom-value">Key value <span className="text-muted-foreground">(optional)</span></FieldLabel><Input id="gateway-key-custom-value" type="password" value={customValue} onChange={(event) => setCustomValue(event.target.value)} disabled={creating} autoComplete="new-password" placeholder="Optional custom secret" /><FieldDescription>Custom values must be 32–256 printable characters without whitespace.</FieldDescription>{operationError && <FieldError>{operationError}</FieldError>}</Field>
        </FieldGroup>
        <DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={closeCreate}>Cancel</Button><Button type="submit" disabled={creating || !createName.trim()}>{creating && <Spinner data-icon="inline-start" />}Create key</Button></DialogFooter>
      </form></DialogContent></Dialog>

      <Dialog open={Boolean(createdKey)} onOpenChange={(open) => { if (!open) { setCreatedKey(null); setCopyingCreated(false); } }}><DialogContent><DialogHeader><DialogTitle>API key created</DialogTitle><DialogDescription>Copy this value now. You can reveal it again from the key value.</DialogDescription></DialogHeader>{createdKey && <div className="flex items-center gap-2 py-5"><code className="min-w-0 flex-1 break-all rounded-md border bg-muted/30 p-3 text-xs">{createdKey.secret}</code><Button aria-label="Copy created API key" size="icon-sm" variant="outline" disabled={copyingCreated} onClick={() => void copyCreatedSecret()}>{copyingCreated ? <Spinner /> : <CopyIcon />}</Button></div>}<DialogFooter><Button disabled={copyingCreated} onClick={() => setCreatedKey(null)}>Done</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => { if (!open && !renaming) { setRenameTarget(null); setRenameValue(""); setOperationError(null); } }}><DialogContent><form onSubmit={(event) => void renameKey(event)}>
        <DialogHeader><DialogTitle>Rename gateway key</DialogTitle><DialogDescription>Changing a name does not change the key value.</DialogDescription></DialogHeader>
        <FieldGroup className="mt-5"><Field data-invalid={Boolean(operationError)}><FieldLabel htmlFor="gateway-key-rename">Name</FieldLabel><Input id="gateway-key-rename" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-invalid={Boolean(operationError)} disabled={renaming} />{operationError && <FieldError>{operationError}</FieldError>}</Field></FieldGroup>
        <DialogFooter><Button type="button" variant="outline" disabled={renaming} onClick={() => { setRenameTarget(null); setRenameValue(""); setOperationError(null); }}>Cancel</Button><Button type="submit" disabled={renaming || !renameValue.trim()}>{renaming && <Spinner data-icon="inline-start" />}Save name</Button></DialogFooter>
      </form></DialogContent></Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !pendingKeyId) setDeleteTarget(null); }}><AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle><AlertDialogDescription>Clients using this key will immediately lose access.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={Boolean(pendingKeyId)}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={Boolean(pendingKeyId)} onClick={() => void deleteKey()}>{pendingKeyId && <Spinner data-icon="inline-start" />}Delete key</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
    </Page>
  );
}

function KeyTableSkeleton() {
  return <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading gateway keys">{[1, 2, 3].map((row) => <div key={row} className="flex min-h-14 items-center gap-3 rounded-lg border bg-muted/30 p-3">
    <div className="min-w-0 flex-1"><Skeleton className="h-4 w-36 max-w-full" /><Skeleton className="mt-2 h-3 w-52 max-w-full" /></div>
    <div className="flex shrink-0 gap-2"><Skeleton className="size-7" /><Skeleton className="size-7" /><Skeleton className="size-7" /></div>
  </div>)}</div>;
}
