import { workspaceScopedFetch } from "./workspace-api";

export type ProviderProtocol =
  "openai-chat" | "openai-responses" | "anthropic-messages";
export type ProviderAuthType = "bearer" | "x-api-key" | "none";
export type ProviderSyncState =
  | "pending"
  | "applied"
  | "error"
  | "native-execution-pending"
  | "cleanup-pending"
  | "cleanup-error"
  | "cleaned";

export type ProviderDto = {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authType: ProviderAuthType;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  desiredRevision: number;
  appliedRevision: number | null;
  apiKeyCount: number;
  enabledApiKeyCount: number;
  modelCount: number;
  enabledModelCount: number;
};
export type ProviderCredentialDto = {
  id: string;
  workspaceId: string;
  providerId: string;
  name: string;
  /** Server redaction sentinel. It must never be presented as a credential value. */
  key: "__unchanged__";
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
};
export type ProviderModelDto = {
  id: string;
  workspaceId: string;
  providerId: string;
  name: string;
  gatewaySuffix: string;
  gatewayModelId: string;
  upstreamModel: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
export type ProviderDetailDto = ProviderDto & {
  credentials: ProviderCredentialDto[];
  models: ProviderModelDto[];
};
export type ProviderSyncDto = {
  providerId: string;
  desiredRevision: number;
  appliedRevision: number | null;
  state: ProviderSyncState;
  error: string | null;
  updatedAt: number;
  deleted: boolean;
};
export type ProviderInput = Pick<
  ProviderDto,
  | "name"
  | "prefix"
  | "baseUrl"
  | "protocol"
  | "authType"
  | "headers"
  | "enabled"
>;
export type ProviderModelInput = Pick<
  ProviderModelDto,
  "name" | "gatewaySuffix" | "upstreamModel" | "enabled"
>;
export type ProviderCredentialInput = {
  name: string;
  key: string;
  enabled: boolean;
};
export type ProviderCredentialPatch = Partial<ProviderCredentialInput>;

type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ProviderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }
}

function errorMessage(payload: unknown, status: number): string {
  return payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : `Provider request failed (HTTP ${status}).`;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal: AbortSignal | undefined,
  fetcher: ProviderFetch,
): Promise<T> {
  const response = await fetcher(path, {
    ...init,
    signal,
    headers: { Accept: "application/json", ...init.headers },
  } as RequestInit & { signal?: AbortSignal });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok)
      throw new ProviderApiError(
        "The provider service returned invalid JSON.",
        response.status,
      );
  }
  if (!response.ok)
    throw new ProviderApiError(
      errorMessage(body, response.status),
      response.status,
    );
  return body as T;
}

function scoped(workspaceId: string, fetcher?: ProviderFetch) {
  const call = <T>(path: string, init?: RequestInit, signal?: AbortSignal) =>
    request<T>(
      path,
      init,
      signal,
      fetcher ??
        ((input, options) => workspaceScopedFetch(workspaceId, input, options)),
    );
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const id = (value: string) => encodeURIComponent(value);
  return {
    async list(signal?: AbortSignal) {
      return (
        await call<{ providers: ProviderDto[] }>(
          "/api/providers",
          undefined,
          signal,
        )
      ).providers;
    },
    async listModels(signal?: AbortSignal) {
      return (
        await call<{ models: ProviderModelDto[] }>(
          "/api/providers/models",
          undefined,
          signal,
        )
      ).models;
    },
    async listCleanup(signal?: AbortSignal) {
      return (
        await call<{ cleanup: ProviderSyncDto[] }>(
          "/api/providers/cleanup",
          undefined,
          signal,
        )
      ).cleanup;
    },
    async detail(providerId: string, signal?: AbortSignal) {
      return await call<{ provider: ProviderDetailDto }>(
        `/api/providers/${id(providerId)}`,
        undefined,
        signal,
      );
    },
    async sync(providerId: string, signal?: AbortSignal) {
      return (
        await call<{ sync: ProviderSyncDto }>(
          `/api/providers/${id(providerId)}/sync`,
          undefined,
          signal,
        )
      ).sync;
    },
    async createProvider(provider: ProviderInput, signal?: AbortSignal) {
      return await call<{ provider: ProviderDto; sync: ProviderSyncDto }>(
        "/api/providers",
        json("POST", { provider }),
        signal,
      );
    },
    async updateProvider(
      providerId: string,
      provider: Partial<ProviderInput>,
      signal?: AbortSignal,
    ) {
      return await call<{ provider: ProviderDto; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}`,
        json("PATCH", { provider }),
        signal,
      );
    },
    async deleteProvider(providerId: string, signal?: AbortSignal) {
      return await call<{ deleted: true; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}`,
        { method: "DELETE" },
        signal,
      );
    },
    async createCredential(
      providerId: string,
      credential: ProviderCredentialInput,
      signal?: AbortSignal,
    ) {
      return await call<{
        credential: ProviderCredentialDto;
        sync: ProviderSyncDto;
      }>(
        `/api/providers/${id(providerId)}/credentials`,
        json("POST", { credential }),
        signal,
      );
    },
    async updateCredential(
      providerId: string,
      credentialId: string,
      credential: ProviderCredentialPatch,
      signal?: AbortSignal,
    ) {
      return await call<{
        credential: ProviderCredentialDto;
        sync: ProviderSyncDto;
      }>(
        `/api/providers/${id(providerId)}/credentials/${id(credentialId)}`,
        json("PATCH", { credential }),
        signal,
      );
    },
    async deleteCredential(
      providerId: string,
      credentialId: string,
      signal?: AbortSignal,
    ) {
      return await call<{ deleted: true; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}/credentials/${id(credentialId)}`,
        { method: "DELETE" },
        signal,
      );
    },
    async reorderCredentials(
      providerId: string,
      orderedIds: string[],
      signal?: AbortSignal,
    ) {
      return await call<{ ok: true; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}/credentials/reorder`,
        json("POST", { orderedIds }),
        signal,
      );
    },
    async createModel(
      providerId: string,
      model: ProviderModelInput,
      signal?: AbortSignal,
    ) {
      return await call<{ model: ProviderModelDto; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}/models`,
        json("POST", { model }),
        signal,
      );
    },
    async updateModel(
      providerId: string,
      modelId: string,
      model: Partial<ProviderModelInput>,
      signal?: AbortSignal,
    ) {
      return await call<{ model: ProviderModelDto; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}/models/${id(modelId)}`,
        json("PATCH", { model }),
        signal,
      );
    },
    async deleteModel(
      providerId: string,
      modelId: string,
      signal?: AbortSignal,
    ) {
      return await call<{ deleted: true; sync: ProviderSyncDto }>(
        `/api/providers/${id(providerId)}/models/${id(modelId)}`,
        { method: "DELETE" },
        signal,
      );
    },
    async retrySync(providerId: string, signal?: AbortSignal) {
      return (
        await call<{ sync: ProviderSyncDto }>(
          `/api/providers/${id(providerId)}/sync`,
          { method: "POST" },
          signal,
        )
      ).sync;
    },
  };
}

export function providerApi(workspaceId: string, fetcher?: ProviderFetch) {
  return scoped(workspaceId, fetcher);
}
