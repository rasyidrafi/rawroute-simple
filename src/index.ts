import { serve } from "bun";
import index from "./index.html";
import { changePassword, ensureAuthSchema, ensureDefaultPassword, loginFromPeer, logout, status } from "./lib/auth";
import {
  cliproxyInstall,
  cliproxyKey,
  cliproxyManagementNotFound,
  cliproxyRestart,
  cliproxyRoot,
  cliproxyStart,
  cliproxyStatus,
  cliproxyStop,
  cliproxyVersions,
  proxyCliproxy,
  stopAcceptingCliproxyMutations,
} from "./lib/cliproxy/http";
import { initCliproxy, shutdownCliproxy } from "./lib/cliproxy";
import { checkDatabaseConnection } from "./lib/db";
import { env } from "./lib/env";
import { clearGlobalLogs, clearLogs, readGlobalLogs, readLogs, reportBrowserEvent } from "./lib/logging/http";
import { loggedGateway, loggedRequest } from "./lib/logging/request";
import { logs } from "./lib/logging/store";
import { dashboardAliases, dashboardPage, dashboardPaths } from "./lib/dashboard-routes";
import { ensureWorkspaceSchema, recoverInterruptedWorkspaceDeletions, registerWorkspaceDeletionExtension } from "./lib/workspaces";
import { deleteWorkspaceHttp, getWorkspaces, patchWorkspace, postWorkspace } from "./lib/workspaces-http";

// All new API handlers should use this registration helper. Polling endpoints
// log failures only so watching the dashboard does not flood the console.
function tracked(source: string, event: string, message: string, handler: Parameters<typeof loggedRequest>[1], failuresOnly = false) {
  // Every currently registered HTTP route is an administrator/global or legacy
  // route. Future workspace APIs must opt in through an explicit scoped wrapper.
  return loggedRequest({ source, event, message }, handler, { failuresOnly, scope: "global" });
}

await ensureAuthSchema();
await ensureDefaultPassword();
await ensureWorkspaceSchema();
await recoverInterruptedWorkspaceDeletions();
registerWorkspaceDeletionExtension({
  name: "workspace-console-logs",
  deleteWorkspaceData: (workspaceId) => logs.deleteWorkspace(workspaceId),
});

const server = serve({
  port: env.port,
  routes: {
    "/": { GET: (request) => Response.redirect(new URL(dashboardPaths.endpoint, request.url), 302) },
    ...Object.fromEntries([...Object.values(dashboardPaths), "/dashboard/ai/providers/:providerId"].map((path) => [path, { GET: index }])),
    "/api/health": { GET: () => Response.json({
      ok: true,
      service: "bun-react",
      ...(Bun.env.RAWROUTE_PREVIEW_PROBE ? { previewProbe: Bun.env.RAWROUTE_PREVIEW_PROBE } : {}),
    }) },
    "/api/db/health": {
      GET: async () => {
        try {
          await checkDatabaseConnection();
          return Response.json({ ok: true, database: "connected" });
         } catch (error) {
           logs.record({ source: "database", event: "database.health.failed", message: "Database health check failed" }, "ERROR");
          console.error("Database health check failed:", error);
          return Response.json(
            { ok: false, database: "unavailable" },
            { status: 503 },
          );
        }
      },
    },
    "/api/auth/login": {
      POST: tracked("auth", "auth.login", "Sign-in request", (request, server) =>
        loginFromPeer(request, server.requestIP(request)?.address),
      ),
    },
    "/api/auth/logout": { POST: tracked("auth", "auth.logout", "Sign-out request", logout) },
    "/api/auth/password": { POST: tracked("auth", "auth.password.change", "Password-change request (success revokes all sessions)", changePassword) },
    "/api/auth/status": { GET: tracked("auth", "auth.status", "Session status request", status, true) },
    // Workspace management is global. It deliberately ignores workspace scope
    // headers; future scoped resources must use requireWorkspaceRequestScope.
    "/api/workspaces": { GET: tracked("workspace", "workspace.list", "Workspace list request", getWorkspaces), POST: tracked("workspace", "workspace.create", "Workspace creation request", postWorkspace) },
    "/api/workspaces/:workspaceId": { PATCH: tracked("workspace", "workspace.rename", "Workspace rename request", patchWorkspace), DELETE: tracked("workspace", "workspace.delete", "Workspace deletion request", deleteWorkspaceHttp) },
    "/api/logs": { GET: readLogs, DELETE: clearLogs },
    "/api/logs/global": { GET: readGlobalLogs, DELETE: clearGlobalLogs },
    "/api/logs/events": { POST: reportBrowserEvent },
    "/api/cliproxy/status": { GET: tracked("cliproxy", "cliproxy.status", "CLIProxy status request", cliproxyStatus, true) },
    "/api/cliproxy/versions": { GET: tracked("cliproxy", "cliproxy.versions", "CLIProxy version list request", cliproxyVersions) },
    "/api/cliproxy/key": { GET: tracked("cliproxy", "cliproxy.key.read", "Gateway credential access request", cliproxyKey) },
    "/api/cliproxy/install": { POST: tracked("cliproxy", "cliproxy.install", "CLIProxy installation request", cliproxyInstall) },
    "/api/cliproxy/start": { POST: tracked("cliproxy", "cliproxy.start", "CLIProxy start request", cliproxyStart) },
    "/api/cliproxy/stop": { POST: tracked("cliproxy", "cliproxy.stop", "CLIProxy stop request", cliproxyStop) },
    "/api/cliproxy/restart": { POST: tracked("cliproxy", "cliproxy.restart", "CLIProxy restart request", cliproxyRestart) },
    "/v1": tracked("gateway", "gateway.root", "Gateway root request", cliproxyRoot),
    "/v1/*": loggedGateway(proxyCliproxy),
    "/v0/management": tracked("gateway", "gateway.management.blocked", "Private management endpoint rejected", cliproxyManagementNotFound),
    "/v0/management/*": tracked("gateway", "gateway.management.blocked", "Private management endpoint rejected", cliproxyManagementNotFound),
    "/api/hello": {
      GET: () => Response.json({ message: "Hello from Bun and React" }),
    },
  },
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (dashboardAliases.includes(path as typeof dashboardAliases[number])) {
      const destination = path === "/dashboard/tools" ? dashboardPaths["tool-overview"] : dashboardPaths.endpoint;
      return request.method === "GET" || request.method === "HEAD"
        ? Response.redirect(new URL(destination, request.url), 302)
        : Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (dashboardPage(path)) return Response.json({ error: "Method not allowed" }, { status: 405 });
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  development: { hmr: true, console: true },
});

console.log(`🚀 Bun fullstack server running at ${server.url}`);
logs.record({ source: "server", event: "server.started", message: "RawRoute server started" });

// The service's standalone signal handlers exit the process. Let this server
// coordinate its shutdown instead so the proxy and HTTP listener stop once.
const cliproxyProcess = process as typeof process & { __rawrouteCliproxySignals?: boolean };
cliproxyProcess.__rawrouteCliproxySignals = true;

let initialization: Promise<void> = Promise.resolve();
let shutdown: Promise<void> | undefined;

function handleShutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdown) return shutdown;
  logs.record({ source: "server", event: "server.stopping", message: "RawRoute shutdown started" });
  process.exitCode = signal === "SIGINT" ? 130 : 143;

  const mutationsDrained = stopAcceptingCliproxyMutations();
  const acceptingStopped = server.stop(false);
  shutdown = (async () => {
    try {
      await Promise.all([initialization, mutationsDrained]);
      await shutdownCliproxy();
    } catch (error) {
      logs.record({ source: "server", event: "server.shutdown.failed", message: "CLIProxy shutdown failed" }, "ERROR");
      console.error("CLIProxy shutdown failed:", error);
      process.exitCode = 1;
    } finally {
      await server.stop(true);
      await acceptingStopped;
    }
  })();
  return shutdown;
}

process.once("SIGINT", () => void handleShutdown("SIGINT"));
process.once("SIGTERM", () => void handleShutdown("SIGTERM"));

initialization = initCliproxy().catch((error: unknown) => {
  logs.record({ source: "server", event: "server.initialization.failed", message: "CLIProxy initialization failed" }, "ERROR");
  console.error("CLIProxy initialization failed:", error);
});
