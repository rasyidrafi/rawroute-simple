import type { BunRequest } from "bun";
import {
  createProvider,
  createProviderCredential,
  createProviderModel,
  deleteProvider,
  deleteProviderCredential,
  deleteProviderModel,
  getProviderDetail,
  listProviderModels,
  isProviderId,
  listProviders,
  ProviderError,
  reorderProviderCredentials,
  updateProvider,
  updateProviderCredential,
  updateProviderModel,
} from "./providers";
import {
  getProviderSyncStatus,
  listProviderCleanupStatuses,
  reconcileDeletedProvider,
  reconcileProvider,
} from "./provider-sync";
import {
  RequestScopeError,
  requireWorkspaceRequestScope,
  runWithWorkspaceScope,
} from "./request-scope";
import { admitWorkspaceWrite } from "./workspaces";

const MAX_BODY_BYTES = 16 * 1024;
const PROVIDER_PREFIX = "/api/providers/";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function errorResponse(error: unknown): Response {
  if (error instanceof RequestScopeError || error instanceof ProviderError)
    return json({ error: error.message }, error.status);
  // Request input can include credentials. Never reflect or log it, database errors,
  // encryption payloads, or any arbitrary exception text.
  console.error("Provider request failed.");
  return json({ error: "Providers are temporarily unavailable." }, 503);
}
async function readJson(
  request: BunRequest,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    throw new ProviderError("Content-Type must be application/json.", 415);
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)
  )
    throw new ProviderError("Request body is invalid or too large.", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new ProviderError("Request body must be valid JSON.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ProviderError("Request body is invalid or too large.", 400);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Request body is invalid.", 400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderError("Request body must be valid JSON.", 400);
  }
  const allowedKeys = new Set(allowed);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !allowedKeys.has(key))
  )
    throw new ProviderError("Request body is invalid.", 400);
  return parsed as Record<string, unknown>;
}
function nested(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const value = body[field];
  const allowedKeys = new Set(allowed);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key))
  )
    throw new ProviderError(
      `${field === "provider" ? "Provider" : field === "credential" ? "Provider credential" : "Provider model"} payload is invalid.`,
      400,
    );
  return value as Record<string, unknown>;
}
function pathParts(request: BunRequest): string[] {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(PROVIDER_PREFIX))
    throw new ProviderError("Provider not found.", 404);
  const source = pathname.slice(PROVIDER_PREFIX.length);
  if (!source || source.endsWith("/"))
    throw new ProviderError("Provider not found.", 404);
  try {
    const parts = source.split("/").map(decodeURIComponent);
    if (
      parts.some((part) => !part || part.includes("/")) ||
      !isProviderId(parts[0])
    )
      throw new ProviderError("Provider not found.", 404);
    return parts;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Provider not found.", 404);
  }
}
function providerId(request: BunRequest): string {
  const parts = pathParts(request);
  if (parts.length !== 1) throw new ProviderError("Provider not found.", 404);
  return parts[0];
}
function syncProviderId(request: BunRequest): string {
  const parts = pathParts(request);
  if (parts.length !== 2 || parts[1] !== "sync")
    throw new ProviderError("Provider not found.", 404);
  return parts[0];
}
function childIds(
  request: BunRequest,
  kind: "credentials" | "models",
  allowReorder = false,
): { providerId: string; childId?: string; reorder: boolean } {
  const parts = pathParts(request);
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    (parts[1] !== kind &&
      !(kind === "credentials" && parts[1] === "api-keys")) ||
    (parts.length === 3 && parts[2] !== "reorder" && !isProviderId(parts[2])) ||
    (!allowReorder && parts.length !== 3)
  )
    throw new ProviderError("Provider not found.", 404);
  return {
    providerId: parts[0],
    childId:
      parts.length === 3 && parts[2] !== "reorder" ? parts[2] : undefined,
    reorder: parts[2] === "reorder",
  };
}
async function scoped(
  request: BunRequest,
  mutate: boolean,
  action: (workspaceId: string) => Promise<Response>,
): Promise<Response> {
  try {
    const scope = await requireWorkspaceRequestScope(request, { mutate });
    return await runWithWorkspaceScope(scope, () => action(scope.workspace.id));
  } catch (error) {
    return errorResponse(error);
  }
}
async function admitted(
  workspaceId: string,
  action: () => Promise<Response>,
): Promise<Response> {
  const admission = await admitWorkspaceWrite(workspaceId);
  if (!admission) return json({ error: "Workspace is unavailable." }, 409);
  try {
    return await action();
  } finally {
    admission.release();
  }
}

export function getProviders(request: BunRequest): Promise<Response> {
  return scoped(request, false, async (workspaceId) =>
    json({ providers: await listProviders(workspaceId) }),
  );
}
export function getProviderModels(request: BunRequest): Promise<Response> {
  return scoped(request, false, async (workspaceId) =>
    json({ models: await listProviderModels(workspaceId) }),
  );
}
export function getProviderCleanup(request: BunRequest): Promise<Response> {
  return scoped(request, false, async (workspaceId) =>
    json({ cleanup: await listProviderCleanupStatuses(workspaceId) }),
  );
}
export function postProvider(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const input = nested(await readJson(request, ["provider"]), "provider", [
        "name",
        "prefix",
        "baseUrl",
        "protocol",
        "authType",
        "headers",
        "enabled",
      ]);
      const provider = await createProvider(
        workspaceId,
        input as {
          name: unknown;
          prefix: unknown;
          baseUrl: unknown;
          protocol: unknown;
          authType?: unknown;
          headers?: unknown;
          enabled?: unknown;
        },
      );
      return json(
        { provider, sync: await reconcileProvider(workspaceId, provider.id) },
        201,
      );
    }),
  );
}
export function getProvider(request: BunRequest): Promise<Response> {
  return scoped(request, false, async (workspaceId) => {
    const provider = await getProviderDetail(workspaceId, providerId(request));
    if (!provider) throw new ProviderError("Provider not found.", 404);
    return json({
      provider,
      credentials: provider.credentials,
      models: provider.models,
    });
  });
}
export function patchProvider(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const input = nested(await readJson(request, ["provider"]), "provider", [
        "name",
        "prefix",
        "baseUrl",
        "protocol",
        "authType",
        "headers",
        "enabled",
      ]);
      if (!Object.keys(input).length)
        throw new ProviderError("Provider update is required.", 400);
      const provider = await updateProvider(
        workspaceId,
        providerId(request),
        input,
      );
      return json({
        provider,
        sync: await reconcileProvider(workspaceId, provider.id),
      });
    }),
  );
}
export function deleteProviderHttp(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      await deleteProvider(workspaceId, providerId(request));
      return json({
        deleted: true,
        sync: await reconcileDeletedProvider(workspaceId, providerId(request)),
      });
    }),
  );
}

export function postProviderCredential(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const {
        providerId: id,
        childId,
        reorder,
      } = childIds(request, "credentials", true);
      if (childId || reorder)
        throw new ProviderError("Provider credential not found.", 404);
      const input = nested(
        await readJson(request, ["credential"]),
        "credential",
        ["name", "key", "enabled"],
      );
      const credential = await createProviderCredential(
        workspaceId,
        id,
        input as { name: unknown; key: unknown; enabled?: unknown },
      );
      return json(
        { credential, sync: await reconcileProvider(workspaceId, id) },
        201,
      );
    }),
  );
}
export function patchProviderCredential(
  request: BunRequest,
): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const {
        providerId: id,
        childId,
        reorder,
      } = childIds(request, "credentials");
      if (!childId || reorder)
        throw new ProviderError("Provider credential not found.", 404);
      const input = nested(
        await readJson(request, ["credential"]),
        "credential",
        ["name", "key", "enabled"],
      );
      if (!Object.keys(input).length)
        throw new ProviderError("Provider credential update is required.", 400);
      const credential = await updateProviderCredential(
        workspaceId,
        id,
        childId,
        input,
      );
      return json({
        credential,
        sync: await reconcileProvider(workspaceId, id),
      });
    }),
  );
}
export function deleteProviderCredentialHttp(
  request: BunRequest,
): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const {
        providerId: id,
        childId,
        reorder,
      } = childIds(request, "credentials");
      if (!childId || reorder)
        throw new ProviderError("Provider credential not found.", 404);
      await deleteProviderCredential(workspaceId, id, childId);
      return json({
        deleted: true,
        sync: await reconcileProvider(workspaceId, id),
      });
    }),
  );
}
export function postProviderCredentialReorder(
  request: BunRequest,
): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const { providerId: id, reorder } = childIds(
        request,
        "credentials",
        true,
      );
      if (!reorder)
        throw new ProviderError("Provider credential not found.", 404);
      const body = await readJson(request, ["orderedIds"]);
      await reorderProviderCredentials(workspaceId, id, body.orderedIds);
      return json({ ok: true, sync: await reconcileProvider(workspaceId, id) });
    }),
  );
}

export function postProviderModel(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const {
        providerId: id,
        childId,
        reorder,
      } = childIds(request, "models", true);
      if (childId || reorder)
        throw new ProviderError("Provider model not found.", 404);
      const input = nested(await readJson(request, ["model"]), "model", [
        "name",
        "gatewaySuffix",
        "upstreamModel",
        "enabled",
      ]);
      const model = await createProviderModel(
        workspaceId,
        id,
        input as {
          name: unknown;
          gatewaySuffix: unknown;
          upstreamModel: unknown;
          enabled?: unknown;
        },
      );
      return json(
        { model, sync: await reconcileProvider(workspaceId, id) },
        201,
      );
    }),
  );
}
export function patchProviderModel(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const { providerId: id, childId, reorder } = childIds(request, "models");
      if (!childId || reorder)
        throw new ProviderError("Provider model not found.", 404);
      const input = nested(await readJson(request, ["model"]), "model", [
        "name",
        "gatewaySuffix",
        "upstreamModel",
        "enabled",
      ]);
      if (!Object.keys(input).length)
        throw new ProviderError("Provider model update is required.", 400);
      const model = await updateProviderModel(workspaceId, id, childId, input);
      return json({ model, sync: await reconcileProvider(workspaceId, id) });
    }),
  );
}
export function deleteProviderModelHttp(
  request: BunRequest,
): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const { providerId: id, childId, reorder } = childIds(request, "models");
      if (!childId || reorder)
        throw new ProviderError("Provider model not found.", 404);
      await deleteProviderModel(workspaceId, id, childId);
      return json({
        deleted: true,
        sync: await reconcileProvider(workspaceId, id),
      });
    }),
  );
}

export function getProviderSync(request: BunRequest): Promise<Response> {
  return scoped(request, false, async (workspaceId) => {
    const id = syncProviderId(request);
    const status = await getProviderSyncStatus(workspaceId, id);
    if (!status) throw new ProviderError("Provider not found.", 404);
    return json({ sync: status });
  });
}
export function postProviderSyncRetry(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) =>
    admitted(workspaceId, async () => {
      const id = syncProviderId(request);
      return json({ sync: await reconcileProvider(workspaceId, id) });
    }),
  );
}
