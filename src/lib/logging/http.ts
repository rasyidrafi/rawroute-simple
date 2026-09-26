import type { BunRequest } from "bun";
import { getCurrentSession } from "../auth";
import { env } from "../env";
import { RequestScopeError, requireGlobalRequestScope, requireWorkspaceRequestScope, runWithWorkspaceScope } from "../request-scope";
import { admitWorkspaceWrite } from "../workspaces";
import { logs } from "./store";
import { browserEvents, type BrowserEvent, type LogDetails } from "./types";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorize(request: BunRequest, mutate: boolean): Promise<Response | null> {
  const expected = env.nodeEnv === "production" ? env.appOrigin : new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== expected) || (mutate && origin !== expected)) {
    return json({ error: "Invalid or missing request origin." }, 403);
  }
  const session = await getCurrentSession(request);
  if (!session) return json({ error: "Sign in to access console logs." }, 401);
  if (session.isDefaultPassword) return json({ error: "Change password required." }, 403);
  return null;
}

async function guarded(request: BunRequest, mutate: boolean, action: () => Response | Promise<Response>): Promise<Response> {
  try { return await authorize(request, mutate) ?? await action(); }
  catch { return json({ error: "Console logs are temporarily unavailable." }, 503); }
}

export function readLogs(request: BunRequest): Promise<Response> {
  return workspaceScoped(request, false, (scope) =>
    runWithWorkspaceScope(scope, () => json(logs.snapshot({ kind: "workspace", workspaceId: scope.workspace.id }))),
  );
}

export function clearLogs(request: BunRequest): Promise<Response> {
  return workspaceScoped(request, true, async (scope) => {
    const admission = await admitWorkspaceWrite(scope.workspace.id);
    if (!admission) return json({ error: "Workspace is unavailable." }, 409);
    const logScope = logs.admitWorkspace(scope.workspace.id);
    try {
      return runWithWorkspaceScope(scope, () => {
        logs.clear(logScope);
        logs.record({ source: "console", event: "logs.cleared", message: "Workspace console history cleared by administrator" }, "INFO", {}, "server", logScope);
        return json(logs.snapshot({ kind: "workspace", workspaceId: scope.workspace.id }));
      });
    } finally {
      admission.release();
    }
  });
}

/** Explicit global log endpoint. Global routes never infer the workspace header. */
export function readGlobalLogs(request: BunRequest): Promise<Response> {
  return globalScoped(request, false, () => json(logs.snapshot()));
}

export function clearGlobalLogs(request: BunRequest): Promise<Response> {
  return globalScoped(request, true, () => {
    logs.clear();
    logs.record({ source: "console", event: "logs.cleared", message: "Global system history cleared by administrator" });
    return json(logs.snapshot());
  });
}

async function globalScoped(
  request: BunRequest,
  mutate: boolean,
  action: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    await requireGlobalRequestScope(request, { mutate });
    return await action();
  } catch (error) {
    if (error instanceof RequestScopeError) return json({ error: error.message }, error.status);
    return json({ error: "Console logs are temporarily unavailable." }, 503);
  }
}

async function workspaceScoped(
  request: BunRequest,
  mutate: boolean,
  action: (scope: Awaited<ReturnType<typeof requireWorkspaceRequestScope>>) => Response | Promise<Response>,
): Promise<Response> {
  try {
    const scope = await requireWorkspaceRequestScope(request, { mutate });
    return await action(scope);
  } catch (error) {
    if (error instanceof RequestScopeError) return json({ error: error.message }, error.status);
    return json({ error: "Console logs are temporarily unavailable." }, 503);
  }
}

let windowStart = 0;
let reports = 0;

async function readReport(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_024) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function reportBrowserEvent(request: BunRequest): Promise<Response> {
  return guarded(request, true, async () => {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return json({ error: "Content-Type must be application/json." }, 415);
    }
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; reports = 0; }
    if (++reports > 120) return json({ error: "Too many browser log events." }, 429);
    const body = await readReport(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid log event." }, 400);
    const data = body as Record<string, unknown>;
    if (Object.keys(data).some((key) => !["event", "page", "added", "removed", "updated", "reordered"].includes(key)) ||
        typeof data.event !== "string" || !Object.hasOwn(browserEvents, data.event)) {
      return json({ error: "Unknown browser log event." }, 400);
    }
    const event = data.event as BrowserEvent;
    const scopeKind = browserEventScope(event, data.page);
    if (!scopeKind) return json({ error: "Invalid page for browser log event." }, 400);
    const details: LogDetails = {};
    for (const key of ["added", "removed", "updated"] as const) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== "number" || !Number.isInteger(data[key]) || data[key] < 0 || data[key] > 100_000) return json({ error: "Invalid counts." }, 400);
      details[key] = data[key];
    }
    if (data.reordered !== undefined) {
      if (typeof data.reordered !== "boolean") return json({ error: "Invalid order flag." }, 400);
      details.reordered = data.reordered;
    }
    const level = event === "dashboard.error" || event === "dashboard.rejection" ? "ERROR" : event === "dashboard.copy-failed" ? "WARN" : "INFO";
    if (scopeKind === "global") {
      logs.record({ source: "dashboard", event, message: `${browserEvents[event]}${data.page ? ` (${data.page})` : ""}` }, level, details, "browser");
    } else {
      let scope;
      try { scope = await requireWorkspaceRequestScope(request, { mutate: true }); }
      catch (error) {
        if (error instanceof RequestScopeError) return json({ error: error.message }, error.status);
        return json({ error: "Console logs are temporarily unavailable." }, 503);
      }
      const admission = await admitWorkspaceWrite(scope.workspace.id);
      if (!admission) return json({ error: "Workspace is unavailable." }, 409);
      try {
        const logScope = logs.admitWorkspace(scope.workspace.id);
        runWithWorkspaceScope(scope, () => logs.record(
          { source: "dashboard", event, message: `${browserEvents[event]}${data.page ? ` (${data.page})` : ""}` },
          level, details, "browser", logScope,
        ));
      } finally {
        admission.release();
      }
    }
    return json({ success: true });
  });
}

const workspaceEvents = new Set<BrowserEvent>([
  "providers.changed", "models.changed", "provider-keys.changed", "codex-models.changed", "codex-accounts.changed",
  "aliases.changed", "combos.changed", "budgets.changed", "pricing.changed", "budgets.window", "budgets.unlimited",
  "budgets.beyond-limits", "codex.authorize", "codex.credit", "logs.copied", "logs.paused", "logs.resumed",
]);

const endpointEvents = new Set<BrowserEvent>([
  "gateway-key.copied", "gateway-keys.created", "gateway-keys.renamed", "gateway-keys.revealed", "gateway-keys.deleted",
]);

function browserEventScope(event: BrowserEvent, page: unknown): "global" | "workspace" | null {
  if ((event === "dashboard.error" || event === "dashboard.rejection") && page === undefined) return "global";
  if (page !== undefined && (typeof page !== "string" || (!globalPages.has(page) && !workspacePages.has(page)))) return null;
  if (endpointEvents.has(event)) return page === "endpoint" ? "workspace" : null;
  if (workspaceEvents.has(event)) return page === undefined || (page !== "endpoint" && workspacePages.has(page)) ? "workspace" : null;
  if (typeof page !== "string") return null;
  return globalPages.has(page) ? "global" : "workspace";
}

const globalPages = new Set(["cliproxy", "system-logs", "settings"]);
const workspacePages = new Set(["endpoint", "providers", "codex", "routing", "usage", "budgets", "pricing", "logs", "tool-overview", "tool-tools", "tool-connections", "tool-policies", "tool-activity", "tool-settings"]);
