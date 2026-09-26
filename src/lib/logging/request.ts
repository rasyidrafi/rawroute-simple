import type { BunRequest, Server } from "bun";
import { currentWorkspaceScope } from "../request-scope";
import { admitWorkspaceWrite } from "../workspaces";
import { logs } from "./store";
import type { LogEvent } from "./types";

type Handler = (request: BunRequest, server: Server<undefined>) => Response | Promise<Response>;

/** Register future API handlers through this wrapper; it never inspects bodies,
 * headers, query strings, URLs, or errors. Streaming responses remain untouched. */
export function loggedRequest(
  event: LogEvent,
  handler: Handler,
  options: boolean | { failuresOnly?: boolean; scope?: "global" | "workspace" } = false,
): Handler {
  return async (request, server) => {
    const started = performance.now();
    const failuresOnly = typeof options === "boolean" ? options : options.failuresOnly ?? false;
    // Capture at request start. A later async workspace switch cannot reattribute
    // a response log.
    const workspace = typeof options === "object" && options.scope === "global" ? undefined : currentWorkspaceScope();
    const admission = workspace ? await admitWorkspaceWrite(workspace.workspace.id) : undefined;
    const scope = workspace
      ? admission ? logs.admitWorkspace(workspace.workspace.id) : undefined
      : { kind: "global" as const };
    try {
      const response = await handler(request, server);
      if (scope && (!failuresOnly || response.status >= 400)) {
        logs.record(event, response.status >= 500 ? "ERROR" : response.status >= 400 ? "WARN" : "INFO", {
          status: response.status,
          durationMs: Math.round(performance.now() - started),
          succeeded: response.ok,
        }, "server", scope);
      }
      return response;
    } catch (error) {
      if (scope) logs.record(event, "ERROR", { status: 500, durationMs: Math.round(performance.now() - started), succeeded: false }, "server", scope);
      throw error;
    } finally {
      admission?.release();
    }
  };
}
