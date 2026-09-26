import { AsyncLocalStorage } from "node:async_hooks";
import type { BunRequest } from "bun";
import { getCurrentSession } from "./auth";
import { env } from "./env";
import { getWorkspace, isWorkspaceId, type Workspace } from "./workspaces";

export const WORKSPACE_ID_HEADER = "x-rawroute-workspace-id";

export type GlobalRequestScope = { kind: "global" };
export type WorkspaceRequestScope = { kind: "workspace"; workspace: Workspace };
export type RequestScope = GlobalRequestScope | WorkspaceRequestScope;

export class RequestScopeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RequestScopeError";
  }
}

const workspaceStorage = new AsyncLocalStorage<WorkspaceRequestScope>();

/** Returns undefined outside an explicitly scoped request; it never implies Default. */
export function currentWorkspaceScope(): WorkspaceRequestScope | undefined {
  return workspaceStorage.getStore();
}

/**
 * Scoped repositories should still receive scope.workspace.id explicitly. This
 * context is only for cross-cutting concerns such as future in-memory logs.
 */
export function runWithWorkspaceScope<T>(scope: WorkspaceRequestScope, callback: () => T): T {
  return workspaceStorage.run(scope, callback);
}

function assertOrigin(request: BunRequest, mutate: boolean): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const expectedOrigin = env.appOrigin ?? new URL(request.url).origin;
  if (fetchSite === "cross-site" || (mutate && !origin) || (origin && origin !== expectedOrigin)) {
    throw new RequestScopeError("Invalid or missing request origin.", 403);
  }
}

async function requireAdministrator(request: BunRequest, mutate: boolean): Promise<void> {
  assertOrigin(request, mutate);
  const session = await getCurrentSession(request);
  if (!session) throw new RequestScopeError("Authentication is required.", 401);
  if (session.isDefaultPassword) throw new RequestScopeError("Change password required.", 403);
}

/**
 * For global management endpoints. This intentionally does not inspect the
 * workspace header, so global APIs stay independent of request workspace scope.
 */
export async function requireGlobalRequestScope(
  request: BunRequest,
  options: { mutate?: boolean } = {},
): Promise<GlobalRequestScope> {
  await requireAdministrator(request, options.mutate ?? false);
  return { kind: "global" };
}

/** Requires a concrete active workspace header; there is no Default fallback. */
export async function requireWorkspaceRequestScope(
  request: BunRequest,
  options: { mutate?: boolean } = {},
): Promise<WorkspaceRequestScope> {
  await requireAdministrator(request, options.mutate ?? false);
  const workspaceId = request.headers.get(WORKSPACE_ID_HEADER)?.trim();
  if (!workspaceId) throw new RequestScopeError("Workspace scope is required.", 400);
  if (!isWorkspaceId(workspaceId)) throw new RequestScopeError("Workspace scope is invalid.", 400);
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new RequestScopeError("Workspace not found.", 404);
  if (workspace.status !== "active") throw new RequestScopeError("Workspace is unavailable.", 409);
  return { kind: "workspace", workspace };
}

export function requestScopeErrorResponse(error: RequestScopeError): Response {
  return Response.json(
    { error: error.message },
    { status: error.status, headers: { "Cache-Control": "no-store" } },
  );
}
