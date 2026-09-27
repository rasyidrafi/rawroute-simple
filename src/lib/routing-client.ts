import { workspaceScopedFetch } from "./workspace-api";

export type RouteModelDto = { id: string; providerId: string; providerPrefix: string; name: string; upstreamModel: string; protocol: string; source: string; reasoningCapability?: { mode: "enabled" | "disabled"; supportedEfforts?: string[] } };
export type RoutingAliasDto = { id: string; workspaceId: string; alias: string; targetModelId: string; shareId?: string; createdAt: number; updatedAt: number };
export type SharedRouteModelDto = { id: string; ownerWorkspaceId: string; ownerWorkspaceName: string; sourceModelId: string; sourceModelName: string; qualifiedModelId: string; protocol: string; status: "active" | "unavailable"; createdAt: number; updatedAt: number };
export type RoutingMemberDto = { id?: string; target: string; position?: number; reasoning?: { mode: "inherit" | "default" | "override"; effort?: string }; customPayload?: Record<string, unknown>; policyHash?: string; validationState?: "not-tested" | "unverified" | "verified" | "invalid"; confirmation?: string };
export type RoutingComboDto = { id: string; workspaceId: string; combo: string; name: string; members: RoutingMemberDto[]; createdAt: number; updatedAt: number };
export type RoutingDto = { aliases: RoutingAliasDto[]; combos: RoutingComboDto[]; models: RouteModelDto[]; sharedModels?: SharedRouteModelDto[] };
export class RoutingApiError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = "RoutingApiError"; } }
async function request<T>(workspaceId: string, path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await workspaceScopedFetch(workspaceId, path, { ...init, signal, headers: { Accept: "application/json", ...init?.headers } }); let payload: unknown;
  try { payload = await response.json(); } catch { throw new RoutingApiError(`Routing request failed (HTTP ${response.status}).`, response.status); }
  if (!response.ok) throw new RoutingApiError(payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : `Routing request failed (HTTP ${response.status}).`, response.status);
  return payload as T;
}
export function routingApi(workspaceId: string) {
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const id = encodeURIComponent;
  return {
    list: (signal?: AbortSignal) => request<RoutingDto>(workspaceId, "/api/routing", undefined, signal),
    createAlias: (alias: string, targetModelId: string, shareId?: string, signal?: AbortSignal) => request<{ alias: RoutingAliasDto }>(workspaceId, "/api/routing/aliases", json("POST", { alias, targetModelId, ...(shareId ? { shareId } : {}) }), signal),
    updateAlias: (aliasId: string, input: Partial<Pick<RoutingAliasDto, "alias" | "targetModelId">> & { shareId?: string | null }, signal?: AbortSignal) => request<{ alias: RoutingAliasDto }>(workspaceId, `/api/routing/aliases/${id(aliasId)}`, json("PATCH", input), signal),
    deleteAlias: (aliasId: string, signal?: AbortSignal) => request<{ deleted: true }>(workspaceId, `/api/routing/aliases/${id(aliasId)}`, { method: "DELETE" }, signal),
    createCombo: (combo: string, name: string, members: RoutingMemberDto[], signal?: AbortSignal) => request<{ combo: RoutingComboDto }>(workspaceId, "/api/routing/combos", json("POST", { combo, name, members }), signal),
    updateCombo: (comboId: string, input: Partial<Pick<RoutingComboDto, "combo" | "name" | "members">>, signal?: AbortSignal) => request<{ combo: RoutingComboDto }>(workspaceId, `/api/routing/combos/${id(comboId)}`, json("PATCH", input), signal),
    deleteCombo: (comboId: string, signal?: AbortSignal) => request<{ deleted: true }>(workspaceId, `/api/routing/combos/${id(comboId)}`, { method: "DELETE" }, signal),
    testDraftMember: (member: Pick<RoutingMemberDto, "target" | "reasoning" | "customPayload" | "policyHash">, signal?: AbortSignal) => request<{ probe: { status: "verified" | "unverified" | "invalid"; message: string }; confirmation: string }>(workspaceId, "/api/routing/combos/test", json("POST", member), signal),
    testComboMember: (comboId: string, memberId: string, signal?: AbortSignal) => request<{ probe: { status: "verified" | "unverified" | "invalid"; message: string } }>(workspaceId, "/api/routing/combos/test", json("POST", { comboId, memberId }), signal),
  };
}
