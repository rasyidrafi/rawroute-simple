import type { Workspace } from "@/lib/workspace-api";

export function activeWorkspaceIdFor(
  workspaces: Workspace[],
  preferredWorkspaceId: string | null | undefined,
): string | null {
  const active = workspaces.filter((workspace) => workspace.status === "active");
  if (preferredWorkspaceId && active.some((workspace) => workspace.id === preferredWorkspaceId)) {
    return preferredWorkspaceId;
  }
  return active.find((workspace) => workspace.isDefault)?.id ?? active[0]?.id ?? null;
}

export function removeWorkspaceFromState(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  deletedWorkspaceId: string,
) {
  const remaining = workspaces.filter((workspace) => workspace.id !== deletedWorkspaceId);
  return {
    workspaces: remaining,
    activeWorkspaceId: activeWorkspaceIdFor(remaining, activeWorkspaceId),
  };
}

/**
 * Drop browser-only fixture snapshots only after a successfully resolved
 * workspace list (or a confirmed local workspace mutation) is visible. A
 * loading or failed refresh is not authoritative and must retain drafts.
 */
export function pruneWorkspaceCollections<T>(
  collections: Record<string, T>,
  workspaces: ReadonlyArray<Pick<Workspace, "id">>,
  isAuthoritative: boolean,
): Record<string, T> {
  if (!isAuthoritative) return collections;

  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  let removed = false;
  const remaining: Record<string, T> = {};
  for (const [workspaceId, collection] of Object.entries(collections)) {
    if (workspaceIds.has(workspaceId)) remaining[workspaceId] = collection;
    else removed = true;
  }
  return removed ? remaining : collections;
}

export function updateWorkspaceCollection<T>(
  collections: Record<string, T>,
  workspaceId: string,
  initialValue: T,
  update: T | ((current: T) => T),
): Record<string, T> {
  const current = collections[workspaceId] ?? initialValue;
  const next = typeof update === "function"
    ? (update as (current: T) => T)(current)
    : update;
  return next === current ? collections : { ...collections, [workspaceId]: next };
}
