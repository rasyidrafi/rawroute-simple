export type ProviderPendingActions = {
  workspaceId: string | null;
  generation: number;
  keys: ReadonlySet<string>;
};

export const emptyProviderPendingActions: ProviderPendingActions = {
  workspaceId: null,
  generation: 0,
  keys: new Set(),
};

function inScope(
  current: ProviderPendingActions,
  workspaceId: string,
  generation: number,
) {
  return (
    current.workspaceId === workspaceId && current.generation === generation
  );
}

export function beginProviderPendingAction(
  current: ProviderPendingActions,
  workspaceId: string,
  generation: number,
  key: string,
): ProviderPendingActions {
  const keys = inScope(current, workspaceId, generation)
    ? new Set(current.keys)
    : new Set<string>();
  keys.add(key);
  return { workspaceId, generation, keys };
}

export function clearProviderPendingAction(
  current: ProviderPendingActions,
  workspaceId: string,
  generation: number,
  key: string,
): ProviderPendingActions {
  if (!inScope(current, workspaceId, generation)) return current;
  const keys = new Set(current.keys);
  keys.delete(key);
  return { ...current, keys };
}

export function isProviderPending(
  current: ProviderPendingActions,
  workspaceId: string | null,
  generation: number,
  key: string,
) {
  return (
    workspaceId !== null &&
    inScope(current, workspaceId, generation) &&
    current.keys.has(key)
  );
}
