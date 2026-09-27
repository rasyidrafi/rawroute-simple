const MAX_PUBLIC_ANALYTICS_CACHE_ENTRIES = 128;
const MAX_PUBLIC_ANALYTICS_GENERATIONS = 256;

type Entry<T> = { expiresAt: number; value: T };

/**
 * Public analytics is intentionally a small, workspace-first cache. Values are
 * invalidated by accounting mutations and workspace deletion; TTL is only a
 * fallback for quiet workspaces.
 */
const entries = new Map<string, Entry<unknown>>();
const generations = new Map<string, number>();

function key(workspaceId: string, queryKey: string): string {
  return `${workspaceId}\u0000${queryKey}`;
}

export function readPublicAnalyticsCache<T>(workspaceId: string, queryKey: string): T | undefined {
  const cacheKey = key(workspaceId, queryKey);
  const entry = entries.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(cacheKey);
    return undefined;
  }
  // LRU promotion keeps active public workspaces in the fixed-size cache.
  entries.delete(cacheKey);
  entries.set(cacheKey, entry);
  return entry.value as T;
}

export function publicAnalyticsGeneration(workspaceId: string): number {
  return generations.get(workspaceId) ?? 0;
}

export function writePublicAnalyticsCache<T>(workspaceId: string, queryKey: string, value: T, ttlMs = 30_000, expectedGeneration?: number): T {
  // A mutation/deletion that settled while a read was aggregating must win: the
  // completed read can still answer its caller but cannot repopulate old data.
  if (expectedGeneration !== undefined && expectedGeneration !== publicAnalyticsGeneration(workspaceId)) return value;
  const cacheKey = key(workspaceId, queryKey);
  entries.delete(cacheKey);
  entries.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
  while (entries.size > MAX_PUBLIC_ANALYTICS_CACHE_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return value;
}

export function invalidatePublicAnalytics(workspaceId: string): void {
  const nextGeneration = publicAnalyticsGeneration(workspaceId) + 1;
  generations.delete(workspaceId);
  generations.set(workspaceId, nextGeneration);
  while (generations.size > MAX_PUBLIC_ANALYTICS_GENERATIONS) {
    const oldest = generations.keys().next().value;
    if (oldest === undefined) break;
    generations.delete(oldest);
  }
  const prefix = `${workspaceId}\u0000`;
  for (const cacheKey of entries.keys()) if (cacheKey.startsWith(prefix)) entries.delete(cacheKey);
}

export function clearPublicAnalyticsCacheForTesting(): void {
  entries.clear();
  generations.clear();
}
