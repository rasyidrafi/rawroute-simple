"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  providerApi,
  type ProviderDto,
  type ProviderModelDto,
  type ProviderSyncDto,
} from "@/lib/providers-client";
import {
  beginProviderPendingAction,
  clearProviderPendingAction,
  emptyProviderPendingActions,
  isProviderPending,
  type ProviderPendingActions,
} from "@/components/dashboard/use-providers-state";

export type ProviderResource = {
  workspaceId: string | null;
  phase: "idle" | "loading" | "ready" | "error";
  providers: ProviderDto[];
  models: ProviderModelDto[];
  syncByProvider: Record<string, ProviderSyncDto>;
  cleanup: ProviderSyncDto[];
  error: string | null;
};

const emptyResource: ProviderResource = {
  workspaceId: null,
  phase: "idle",
  providers: [],
  models: [],
  syncByProvider: {},
  cleanup: [],
  error: null,
};

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Providers are temporarily unavailable.";
}

function abortable(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useProviders(workspaceId: string | null) {
  const [resource, setResource] = useState<ProviderResource>(emptyResource);
  const workspaceRef = useRef(workspaceId);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const [pending, setPending] = useState<ProviderPendingActions>(
    emptyProviderPendingActions,
  );

  const cancel = useCallback(() => {
    generation.current += 1;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setPending(emptyProviderPendingActions);
  }, []);

  const load = useCallback(
    async (
      ownerWorkspaceId: string,
      requestGeneration: number,
      replace = true,
    ) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      if (
        replace &&
        workspaceRef.current === ownerWorkspaceId &&
        generation.current === requestGeneration
      ) {
        setResource({
          workspaceId: ownerWorkspaceId,
          phase: "loading",
          providers: [],
          models: [],
          syncByProvider: {},
          cleanup: [],
          error: null,
        });
      }
      try {
        const api = providerApi(ownerWorkspaceId);
        const [providers, models, cleanup] = await Promise.all([
          api.list(controller.signal),
          api.listModels(controller.signal),
          api.listCleanup(controller.signal),
        ]);
        const sync = await Promise.all(
          providers.map(
            async (provider) => await api.sync(provider.id, controller.signal),
          ),
        );
        if (
          workspaceRef.current !== ownerWorkspaceId ||
          generation.current !== requestGeneration
        )
          return false;
        const syncByProvider = Object.fromEntries(
          sync.map((status) => [status.providerId, status]),
        );
        setResource({
          workspaceId: ownerWorkspaceId,
          phase: "ready",
          providers,
          models,
          syncByProvider,
          cleanup,
          error: null,
        });
        return true;
      } catch (error) {
        if (
          abortable(error) ||
          workspaceRef.current !== ownerWorkspaceId ||
          generation.current !== requestGeneration
        )
          return false;
        setResource({
          workspaceId: ownerWorkspaceId,
          phase: "error",
          providers: [],
          models: [],
          syncByProvider: {},
          cleanup: [],
          error: message(error),
        });
        return false;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );

  useEffect(() => {
    workspaceRef.current = workspaceId;
    cancel();
    if (!workspaceId) {
      setResource(emptyResource);
      return;
    }
    const requestGeneration = generation.current;
    void load(workspaceId, requestGeneration);
    return cancel;
  }, [cancel, load, workspaceId]);

  const reload = useCallback(async () => {
    const ownerWorkspaceId = workspaceRef.current;
    if (!ownerWorkspaceId) return;
    cancel();
    await load(ownerWorkspaceId, generation.current);
  }, [cancel, load]);

  const read = useCallback(
    async <T>(
      operation: (
        api: ReturnType<typeof providerApi>,
        signal: AbortSignal,
      ) => Promise<T>,
    ): Promise<T | undefined> => {
      const ownerWorkspaceId = workspaceRef.current;
      const requestGeneration = generation.current;
      if (!ownerWorkspaceId) return undefined;
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const result = await operation(
          providerApi(ownerWorkspaceId),
          controller.signal,
        );
        return workspaceRef.current === ownerWorkspaceId &&
          generation.current === requestGeneration
          ? result
          : undefined;
      } catch (error) {
        if (
          abortable(error) ||
          workspaceRef.current !== ownerWorkspaceId ||
          generation.current !== requestGeneration
        )
          return undefined;
        throw error;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );

  const mutate = useCallback(
    async <T extends { sync?: ProviderSyncDto }>(
      key: string,
      operation: (
        api: ReturnType<typeof providerApi>,
        signal: AbortSignal,
      ) => Promise<T>,
    ): Promise<T | undefined> => {
      const ownerWorkspaceId = workspaceRef.current;
      const requestGeneration = generation.current;
      if (!ownerWorkspaceId) return undefined;
      const controller = new AbortController();
      controllers.current.add(controller);
      setPending((current) =>
        beginProviderPendingAction(
          current,
          ownerWorkspaceId,
          requestGeneration,
          key,
        ),
      );
      try {
        const result = await operation(
          providerApi(ownerWorkspaceId),
          controller.signal,
        );
        if (
          workspaceRef.current !== ownerWorkspaceId ||
          generation.current !== requestGeneration
        )
          return undefined;
        const sync = result.sync;
        if (sync)
          setResource((current) => ({
            ...current,
            syncByProvider: sync.deleted
              ? current.syncByProvider
              : { ...current.syncByProvider, [sync.providerId]: sync },
            cleanup: sync.deleted
              ? [
                  ...current.cleanup.filter(
                    (item) => item.providerId !== sync.providerId,
                  ),
                  sync,
                ]
              : current.cleanup,
          }));
        await load(ownerWorkspaceId, requestGeneration, false);
        return result;
      } finally {
        controllers.current.delete(controller);
        if (
          workspaceRef.current === ownerWorkspaceId &&
          generation.current === requestGeneration
        )
          setPending((current) =>
            clearProviderPendingAction(
              current,
              ownerWorkspaceId,
              requestGeneration,
              key,
            ),
          );
      }
    },
    [load],
  );

  return {
    resource,
    reload,
    read,
    mutate,
    isPending: (key: string) =>
      isProviderPending(pending, workspaceRef.current, generation.current, key),
  };
}
