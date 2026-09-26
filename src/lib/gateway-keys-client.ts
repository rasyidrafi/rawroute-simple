export type GatewayKey = {
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "revoked";
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
};

export type GatewayKeyResult = { key: GatewayKey; secret: string };

export type GatewayKeyFetch = (input: string, init?: RequestInit) => Promise<Response>;

function isGatewayKey(value: unknown, workspaceId: string): value is GatewayKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return typeof key.id === "string" && key.workspaceId === workspaceId &&
    typeof key.name === "string" && (key.status === "active" || key.status === "revoked") &&
    typeof key.createdAt === "number" && typeof key.updatedAt === "number" &&
    (key.revokedAt === null || typeof key.revokedAt === "number");
}

export function gatewayKeyListFromResponse(value: unknown, workspaceId: string): GatewayKey[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys) && keys.every((key) => isGatewayKey(key, workspaceId)) ? keys : null;
}

export function gatewayKeyResultFromResponse(value: unknown, workspaceId: string): GatewayKeyResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as { key?: unknown; secret?: unknown };
  return isGatewayKey(result.key, workspaceId) && typeof result.secret === "string" && result.secret.length > 0
    ? { key: result.key, secret: result.secret }
    : null;
}

export function gatewayKeyFromResponse(value: unknown, workspaceId: string): GatewayKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = (value as { key?: unknown }).key;
  return isGatewayKey(key, workspaceId) ? key : null;
}

function requestError(payload: unknown, status: number): Error {
  const message = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { error?: unknown }).error
    : undefined;
  return new Error(typeof message === "string" ? message : `Request failed (HTTP ${status}).`);
}

/** Performs a scoped browser request without parsing the intentionally empty 204 body. */
export async function gatewayKeyRequest<T>(
  fetcher: GatewayKeyFetch,
  workspaceId: string,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetcher(path, {
    ...init,
    credentials: "same-origin",
    signal,
    headers: { Accept: "application/json", "X-RawRoute-Workspace-Id": workspaceId, ...init.headers },
  });
  if (response.status === 204 && response.ok) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new Error("The gateway key service returned invalid JSON.");
  }
  if (!response.ok) throw requestError(payload, response.status);
  return payload as T;
}

export async function deleteGatewayKeyRequest(
  fetcher: GatewayKeyFetch,
  workspaceId: string,
  keyId: string,
  signal: AbortSignal,
): Promise<void> {
  await gatewayKeyRequest<void>(
    fetcher,
    workspaceId,
    `/api/gateway-keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE" },
    signal,
  );
}
