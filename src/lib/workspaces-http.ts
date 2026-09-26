import type { BunRequest } from "bun";
import { RequestScopeError, requestScopeErrorResponse, requireGlobalRequestScope } from "./request-scope";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  WorkspaceError,
} from "./workspaces";

const MAX_WORKSPACE_BODY_BYTES = 4 * 1024;
const WORKSPACE_ROUTE_PREFIX = "/api/workspaces/";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestScopeError) return requestScopeErrorResponse(error);
  if (error instanceof WorkspaceError) return json({ error: error.message }, error.status);
  console.error("Workspace request failed:", error);
  return json({ error: "Workspaces are temporarily unavailable." }, 503);
}

async function readBody(request: BunRequest, field: "name" | "confirmation"): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new WorkspaceError("Content-Type must be application/json.", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WORKSPACE_BODY_BYTES)) {
    throw new WorkspaceError("Request body is invalid or too large.", 400);
  }

  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceError("Request body must be valid JSON.", 400);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WORKSPACE_BODY_BYTES) {
        await reader.cancel();
        throw new WorkspaceError("Request body is invalid or too large.", 400);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("Request body is invalid.", 400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceError("Request body must be valid JSON.", 400);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as Record<string, unknown>)[field] !== "string"
  ) {
    throw new WorkspaceError(`Body must contain only ${field}.`, 400);
  }
  return (body as Record<string, string>)[field];
}

function workspaceIdFromRequest(request: BunRequest): string {
  const path = new URL(request.url).pathname;
  const encoded = path.slice(WORKSPACE_ROUTE_PREFIX.length);
  if (!encoded || encoded.includes("/")) throw new WorkspaceError("Workspace not found.", 404);
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new WorkspaceError("Workspace not found.", 404);
  }
}

export async function getWorkspaces(request: BunRequest): Promise<Response> {
  try {
    await requireGlobalRequestScope(request);
    return json({ workspaces: await listWorkspaces() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function postWorkspace(request: BunRequest): Promise<Response> {
  try {
    await requireGlobalRequestScope(request, { mutate: true });
    return json({ workspace: await createWorkspace(await readBody(request, "name")) }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function patchWorkspace(request: BunRequest): Promise<Response> {
  try {
    await requireGlobalRequestScope(request, { mutate: true });
    const workspace = await renameWorkspace(workspaceIdFromRequest(request), await readBody(request, "name"));
    return json({ workspace });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function deleteWorkspaceHttp(request: BunRequest): Promise<Response> {
  try {
    await requireGlobalRequestScope(request, { mutate: true });
    await deleteWorkspace(workspaceIdFromRequest(request), await readBody(request, "confirmation"));
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
