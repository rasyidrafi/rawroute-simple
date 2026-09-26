"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workspaceApi, type Workspace } from "@/lib/workspace-api";
import {
  activeWorkspaceIdFor,
  beginWorkspaceLoadingGeneration,
  isCurrentWorkspaceRequest,
  nextWorkspaceRequestGeneration,
  removeWorkspaceFromState,
  settleWorkspaceLoadingGeneration,
} from "@/lib/workspace-state";

const ACTIVE_WORKSPACE_STORAGE_KEY = "rawroute.active-workspace-id";

type WorkspaceContextValue = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | null;
  /** Increments after an accepted list result or confirmed workspace mutation. */
  workspaceListVersion: number;
  isLoading: boolean;
  error: string | null;
  selectWorkspace: (workspaceId: string) => void;
  reload: () => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<Workspace>;
  deleteWorkspace: (workspaceId: string, confirmation: string) => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function storedWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistWorkspaceId(workspaceId: string | null) {
  try {
    if (workspaceId) window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    else window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    // Storage is optional; it must not prevent selecting a workspace.
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Workspaces are temporarily unavailable.";
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Capture storage during the initial render. The first persistence effect
  // must not erase this preference while the workspace list is still loading.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    () => storedWorkspaceId(),
  );
  const [workspaceListVersion, setWorkspaceListVersion] = useState(0);
  const [loadingGeneration, setLoadingGeneration] = useState<number | null>(0);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const workspacesRef = useRef<Workspace[]>([]);
  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
    persistWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId]);

  const invalidateWorkspaceReloads = useCallback(() => {
    requestId.current = nextWorkspaceRequestGeneration(requestId.current);
    // An invalidated request cannot clear a newer loading generation.
    setLoadingGeneration(null);
  }, []);

  const reload = useCallback(async () => {
    const currentRequestId = nextWorkspaceRequestGeneration(requestId.current);
    requestId.current = currentRequestId;
    setLoadingGeneration(beginWorkspaceLoadingGeneration(currentRequestId));
    setError(null);
    try {
      const nextWorkspaces = await workspaceApi.list();
      if (!isCurrentWorkspaceRequest(currentRequestId, requestId.current)) return;
      workspacesRef.current = nextWorkspaces;
      setWorkspaces(nextWorkspaces);
      setWorkspaceListVersion((version) => version + 1);
      setActiveWorkspaceId((current) =>
        activeWorkspaceIdFor(nextWorkspaces, current ?? storedWorkspaceId()),
      );
    } catch (loadError) {
      if (!isCurrentWorkspaceRequest(currentRequestId, requestId.current)) return;
      setError(message(loadError));
    } finally {
      setLoadingGeneration((current) =>
        settleWorkspaceLoadingGeneration(current, currentRequestId),
      );
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId((current) =>
      activeWorkspaceIdFor(workspaces, workspaceId) ?? current,
    );
  }, [workspaces]);

  const createWorkspace = useCallback(async (name: string) => {
    // Keep a later user selection intact if this global mutation resolves late.
    const selectedAtStart = activeWorkspaceIdRef.current;
    invalidateWorkspaceReloads();
    const workspace = await workspaceApi.create(name);
    const nextWorkspaces = [...workspacesRef.current.filter((item) => item.id !== workspace.id), workspace];
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    setWorkspaceListVersion((version) => version + 1);
    if (activeWorkspaceIdRef.current === selectedAtStart) setActiveWorkspaceId(workspace.id);
    // Also invalidate refreshes that started while the mutation was in flight.
    invalidateWorkspaceReloads();
    setError(null);
    return workspace;
  }, [invalidateWorkspaceReloads]);

  const renameWorkspace = useCallback(async (workspaceId: string, name: string) => {
    // workspaceId is captured by the caller, never read from the current selector.
    invalidateWorkspaceReloads();
    const workspace = await workspaceApi.rename(workspaceId, name);
    const nextWorkspaces = workspacesRef.current.map((item) => item.id === workspaceId ? workspace : item);
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    setWorkspaceListVersion((version) => version + 1);
    invalidateWorkspaceReloads();
    setError(null);
    return workspace;
  }, [invalidateWorkspaceReloads]);

  const deleteWorkspace = useCallback(async (workspaceId: string, confirmation: string) => {
    // workspaceId is captured by the caller, so deleting A cannot remove B after a switch.
    invalidateWorkspaceReloads();
    await workspaceApi.remove(workspaceId, confirmation);
    const next = removeWorkspaceFromState(workspacesRef.current, activeWorkspaceIdRef.current, workspaceId);
    workspacesRef.current = next.workspaces;
    setWorkspaces(next.workspaces);
    setWorkspaceListVersion((version) => version + 1);
    setActiveWorkspaceId(next.activeWorkspaceId);
    invalidateWorkspaceReloads();
    setError(null);
  }, [invalidateWorkspaceReloads]);

  const activeWorkspace = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId && workspace.status === "active",
  ) ?? null;
  const isLoading = loadingGeneration !== null;
  const value = useMemo<WorkspaceContextValue>(() => ({
    workspaces,
    activeWorkspaceId: activeWorkspace?.id ?? null,
    activeWorkspace,
    workspaceListVersion,
    isLoading,
    error,
    selectWorkspace,
    reload,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
  }), [
    activeWorkspace,
    createWorkspace,
    deleteWorkspace,
    error,
    isLoading,
    reload,
    renameWorkspace,
    selectWorkspace,
    workspaceListVersion,
    workspaces,
  ]);

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used within WorkspaceProvider.");
  return context;
}
