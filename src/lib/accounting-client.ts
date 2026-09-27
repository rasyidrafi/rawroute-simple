export async function accountingFetch<T>(workspaceId: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "x-rawroute-workspace-id": workspaceId, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => ({}));
    throw new Error(typeof (failure as { error?: unknown }).error === "string" ? (failure as { error: string }).error : "Request failed.");
  }
  return await response.json() as T;
}
