import type { BunRequest } from "bun";
import {
  createGatewayKey,
  deleteGatewayKey,
  GatewayKeyError,
  getGatewayKey,
  isGatewayKeyId,
  listGatewayKeys,
  revealGatewayKey,
  updateGatewayKey,
} from "./gateway-keys";
import { RequestScopeError, requireWorkspaceRequestScope, runWithWorkspaceScope } from "./request-scope";
import { admitWorkspaceWrite } from "./workspaces";

const MAX_GATEWAY_KEY_BODY_BYTES = 4 * 1024;
const GATEWAY_KEY_ROUTE_PREFIX = "/api/gateway-keys/";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestScopeError || error instanceof GatewayKeyError) {
    return json({ error: error.message }, error.status);
  }
  // Never include database errors, key values, hashes, ciphertext, or arbitrary
  // exception text in a response or log.
  console.error("Gateway key request failed.");
  return json({ error: "Gateway keys are temporarily unavailable." }, 503);
}

async function readJsonBody(request: BunRequest, allowedFields: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new GatewayKeyError("Content-Type must be application/json.", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_GATEWAY_KEY_BODY_BYTES)) {
    throw new GatewayKeyError("Request body is invalid or too large.", 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new GatewayKeyError("Request body must be valid JSON.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GATEWAY_KEY_BODY_BYTES) {
        await reader.cancel();
        throw new GatewayKeyError("Request body is invalid or too large.", 400);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GatewayKeyError) throw error;
    throw new GatewayKeyError("Request body is invalid.", 400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new GatewayKeyError("Request body must be valid JSON.", 400);
  }
  const allowed = new Set(allowedFields);
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((field) => !allowed.has(field))
  ) {
    throw new GatewayKeyError("Request body is invalid.", 400);
  }
  return body as Record<string, unknown>;
}

function keyIdFromRequest(request: BunRequest, reveal = false): string {
  const pathname = new URL(request.url).pathname;
  const suffix = reveal ? "/reveal" : "";
  if (!pathname.startsWith(GATEWAY_KEY_ROUTE_PREFIX) || !pathname.endsWith(suffix)) throw new GatewayKeyError("Gateway key not found.", 404);
  const encoded = pathname.slice(GATEWAY_KEY_ROUTE_PREFIX.length, suffix ? -suffix.length : undefined);
  if (!encoded || encoded.includes("/")) throw new GatewayKeyError("Gateway key not found.", 404);
  let keyId: string;
  try {
    keyId = decodeURIComponent(encoded);
  } catch {
    throw new GatewayKeyError("Gateway key not found.", 404);
  }
  if (!isGatewayKeyId(keyId)) throw new GatewayKeyError("Gateway key not found.", 404);
  return keyId;
}

async function scoped(
  request: BunRequest,
  mutate: boolean,
  action: (workspaceId: string) => Promise<Response>,
): Promise<Response> {
  try {
    const scope = await requireWorkspaceRequestScope(request, { mutate });
    return await runWithWorkspaceScope(scope, async () => await action(scope.workspace.id));
  } catch (error) {
    return errorResponse(error);
  }
}

async function admitted(workspaceId: string, action: () => Promise<Response>): Promise<Response> {
  const admission = await admitWorkspaceWrite(workspaceId);
  if (!admission) return json({ error: "Workspace is unavailable." }, 409);
  try {
    return await action();
  } finally {
    admission.release();
  }
}

export function getGatewayKeys(request: BunRequest): Promise<Response> {
  return scoped(request, false, async (workspaceId) => json({ keys: await listGatewayKeys(workspaceId) }));
}

export function postGatewayKey(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) => await admitted(workspaceId, async () => {
    const body = await readJsonBody(request, ["name", "value"]);
    if (typeof body.name !== "string") throw new GatewayKeyError("Gateway key name is required.", 400);
    const created = await createGatewayKey(workspaceId, body.name, body.value);
    return json(created, 201);
  }));
}

export function patchGatewayKey(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) => await admitted(workspaceId, async () => {
    const keyId = keyIdFromRequest(request);
    const body = await readJsonBody(request, ["name", "revoked"]);
    if (Object.keys(body).length === 0) throw new GatewayKeyError("Gateway key update is required.", 400);
    return json({ key: await updateGatewayKey(workspaceId, keyId, body) });
  }));
}

export function deleteGatewayKeyHttp(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) => await admitted(workspaceId, async () => {
    await deleteGatewayKey(workspaceId, keyIdFromRequest(request));
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }));
}

export function revealGatewayKeyHttp(request: BunRequest): Promise<Response> {
  return scoped(request, true, async (workspaceId) => await admitted(workspaceId, async () => {
    const keyId = keyIdFromRequest(request, true);
    // Explicit JSON keeps the sensitive action behind the same bounded-body and
    // content-type policy as all other mutations. The only accepted body is {}.
    const body = await readJsonBody(request, []);
    if (Object.keys(body).length !== 0) throw new GatewayKeyError("Request body is invalid.", 400);
    const key = await getGatewayKey(workspaceId, keyId);
    if (!key) throw new GatewayKeyError("Gateway key not found.", 404);
    return json({ key, secret: await revealGatewayKey(workspaceId, keyId) });
  }));
}
