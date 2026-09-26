"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  cleanupDeletedGatewayKey,
  deleteGatewayKeyRequest,
  gatewayKeyFromResponse,
  gatewayKeyListFromResponse,
  gatewayKeyRequest,
  gatewayKeyResultFromResponse,
  type GatewayKey,
  type GatewayKeyResult,
} from "@/lib/gateway-keys-client";
import { reportEvent } from "@/lib/logging/client";
import { notify } from "@/components/dashboard/page-ui";

export function useEndpointKeys(workspaceId: string) {
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
  const [createdKey, setCreatedKey] = useState<GatewayKeyResult | null>(null);
  const [copyingCreated, setCopyingCreated] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GatewayKey | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GatewayKey | null>(null);
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const activeWorkspaceId = useRef(workspaceId);

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
    setCreatedKey(null);
    setCopyingCreated(false);
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
      setCreatedKey(result);
      setCreateOpen(false);
      setCreateName("");
      setCustomValue("");
      reportEvent("gateway-keys.created", { page: "endpoint", workspaceId: scope, added: 1 });
      notify("Gateway key created");
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
    const scope = workspaceId;
    const controller = beginRequest();
    setPendingKeyId(key.id);
    setOperationError(null);
    try {
      let secret = visibleSecrets[key.id];
      if (!secret) {
        const result = gatewayKeyResultFromResponse(await request<unknown>(scope, `/api/gateway-keys/${encodeURIComponent(key.id)}/reveal`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        }, controller), scope);
        if (!result || result.key.id !== key.id) throw new Error("The gateway key service returned an invalid key.");
        if (!ownsRequest(scope, controller)) return;
        setKeys((current) => current.map((item) => item.id === result.key.id ? result.key : item));
        secret = result.secret;
      }
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(secret);
      if (!ownsRequest(scope, controller)) return;
      reportEvent("gateway-key.copied", { page: "endpoint", workspaceId: scope });
      notify("Gateway key copied");
    } catch {
      if (!ownsRequest(scope, controller)) return;
      reportEvent("dashboard.copy-failed", { page: "endpoint", workspaceId: scope });
      setOperationError("Clipboard access failed. Reveal the key and copy it manually.");
    } finally {
      controllers.current.delete(controller);
      if (ownsRequest(scope, controller)) setPendingKeyId(null);
    }
  }

  async function copyCreatedSecret() {
    const result = createdKey;
    const scope = workspaceId;
    if (!result) return;
    setCopyingCreated(true);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(result.secret);
      if (activeWorkspaceId.current !== scope) return;
      reportEvent("gateway-key.copied", { page: "endpoint", workspaceId: scope });
      notify("Gateway key copied");
    } catch {
      if (activeWorkspaceId.current !== scope) return;
      reportEvent("dashboard.copy-failed", { page: "endpoint", workspaceId: scope });
      setOperationError("Clipboard access failed. Copy the visible key manually.");
    } finally {
      if (activeWorkspaceId.current === scope) setCopyingCreated(false);
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
      setCreatedKey((current) => current?.key.id === target.id ? null : current);
      reportEvent("gateway-keys.deleted", { page: "endpoint", workspaceId: scope, removed: 1 });
      notify("Gateway key deleted");
    } catch (error) {
      if (ownsRequest(scope, controller)) setOperationError(error instanceof Error ? error.message : "Unable to delete gateway key.");
    } finally {
      if (ownsRequest(scope, controller)) setPendingKeyId(null);
    }
  }

  return {
    keys, loading, listError, operationError, visibleSecrets, createOpen, createName,
    customValue, creating, createdKey, copyingCreated, renameTarget, renameValue,
    renaming, deleteTarget, pendingKeyId, setListVersion, setOperationError,
    setCreateOpen, setCreateName, setCustomValue, setCreatedKey, setCopyingCreated,
    setRenameTarget, setRenameValue, setDeleteTarget, closeCreate, createKey,
    revealOrHide, copySecret, copyCreatedSecret, renameKey, deleteKey,
  };
}
