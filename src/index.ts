import { serve } from "bun";
import index from "./index.html";
import { changePassword, ensureAuthSchema, ensureDefaultPassword, loginFromPeer, logout, status } from "./lib/auth";
import {
  cliproxyInstall,
  cliproxyManagementNotFound,
  cliproxyRestart,
  cliproxyStart,
  cliproxyStatus,
  cliproxyStop,
  cliproxyVersions,
  stopAcceptingCliproxyMutations,
} from "./lib/cliproxy/http";
import { initCliproxy, registerCliproxyRecoveryReconciler, shutdownCliproxy } from "./lib/cliproxy";
import { checkDatabaseConnection } from "./lib/db";
import { env } from "./lib/env";
import { deleteGatewayKeysForWorkspace, ensureGatewayKeySchema } from "./lib/gateway-keys";
import { deleteGatewayKeyHttp, getGatewayKeys, patchGatewayKey, postGatewayKey, revealGatewayKeyHttp } from "./lib/gateway-keys-http";
import { deleteProvidersForWorkspace, ensureProviderSchema } from "./lib/providers";
import { deleteProviderCredentialHttp, deleteProviderHttp, deleteProviderModelHttp, getProvider, getProviderCleanup, getProviderModels, getProviders, getProviderSync, patchProvider, patchProviderCredential, patchProviderModel, postProvider, postProviderCredential, postProviderCredentialReorder, postProviderModel, postProviderSyncRetry } from "./lib/providers-http";
import { beginProviderSyncShutdown, reconcilePendingProviderProjections, startProviderSync } from "./lib/provider-sync";
import { clearGlobalLogs, clearLogs, readGlobalLogs, readLogs, reportBrowserEvent } from "./lib/logging/http";
import { loggedRequest } from "./lib/logging/request";
import { logs } from "./lib/logging/store";
import { gatewayEndpoints, gatewayMethodNotAllowed, gatewayRoot, gatewayUnavailable } from "./lib/gateway-http";
import { dashboardAliases, dashboardPage, dashboardPaths } from "./lib/dashboard-routes";
import { ensureWorkspaceSchema, recoverInterruptedWorkspaceDeletions, registerWorkspaceDeletionExtension } from "./lib/workspaces";
import { deleteWorkspaceHttp, getWorkspaces, patchWorkspace, postWorkspace } from "./lib/workspaces-http";

// All new API handlers should use this registration helper. Polling endpoints
// log failures only so watching the dashboard does not flood the console.
function tracked(source: string, event: string, message: string, handler: Parameters<typeof loggedRequest>[1], failuresOnly = false) {
  // These are global audit records and never include request values. Scoped
  // handlers still establish and enforce their own explicit workspace scope.
  return loggedRequest({ source, event, message }, handler, { failuresOnly, scope: "global" });
}

await ensureAuthSchema();
await ensureDefaultPassword();
await ensureWorkspaceSchema();
await ensureGatewayKeySchema();
await ensureProviderSchema();
let server: ReturnType<typeof serve> | undefined;
let initialization: Promise<void> = Promise.resolve();
let bootstrap: Promise<void> = Promise.resolve();
let shutdown: Promise<void> | undefined;

function handleShutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdown) return shutdown;
  logs.record({ source: "server", event: "server.stopping", message: "RawRoute shutdown started" });
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  const mutationsDrained = stopAcceptingCliproxyMutations();
  const acceptingStopped = server ? server.stop(false) : Promise.resolve();
  // Bootstrap never awaits shutdown, so this covers recovery, sync admission,
  // and initialization without a pre-listener signal deadlock.
  const bootstrapDrained = bootstrap;
  shutdown = (async () => {
    try {
      await Promise.all([bootstrapDrained, mutationsDrained]);
      await beginProviderSyncShutdown();
      await shutdownCliproxy();
    } catch (error) {
      logs.record({ source: "server", event: "server.shutdown.failed", message: "CLIProxy shutdown failed" }, "ERROR");
      console.error("CLIProxy shutdown failed:", error);
      process.exitCode = 1;
    } finally {
      if (server) await server.stop(true);
      await acceptingStopped;
    }
  })();
  return shutdown;
}
process.once("SIGINT", () => void handleShutdown("SIGINT"));
process.once("SIGTERM", () => void handleShutdown("SIGTERM"));

registerWorkspaceDeletionExtension({
  name: "workspace-console-logs",
  deleteWorkspaceData: (workspaceId) => logs.deleteWorkspace(workspaceId),
});
registerWorkspaceDeletionExtension({
  name: "workspace-gateway-keys",
  deleteWorkspaceData: deleteGatewayKeysForWorkspace,
});
registerWorkspaceDeletionExtension({
  name: "workspace-providers",
  deleteWorkspaceData: async (workspaceId) => {
    await deleteProvidersForWorkspace(workspaceId);
    // Offline cleanup leaves a durable tombstone; no provider row is recreated.
    await reconcilePendingProviderProjections();
  },
});
bootstrap = (async () => {
  await recoverInterruptedWorkspaceDeletions();
  // A signal during recovery has already closed admission and scheduled the
  // shutdown path. Do not start sync or a child after that point.
  if (shutdown) return;
  // The server coordinates signals below; prevent the standalone service from
  // registering an earlier competing handler during startup initialization.
  const cliproxyProcess = process as typeof process & { __rawrouteCliproxySignals?: boolean };
  cliproxyProcess.__rawrouteCliproxySignals = true;
  startProviderSync();
  registerCliproxyRecoveryReconciler(reconcilePendingProviderProjections);
  initialization = (async () => {
    try {
      await initCliproxy();
      if (!shutdown) await reconcilePendingProviderProjections();
    } catch (error) {
      logs.record({ source: "server", event: "server.initialization.failed", message: "CLIProxy initialization or provider reconciliation failed" }, "ERROR");
      console.error("CLIProxy initialization failed:", error);
    }
  })();
  await initialization;
})();
await bootstrap;

if (!shutdown) server = serve({
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
    // Gateway keys are workspace-scoped and require an explicit workspace header.
    // Their handlers enforce scoped auth/admission; audit logs are global and never include key material.
    "/api/gateway-keys": { GET: tracked("gateway-keys", "gateway-keys.list", "Gateway key list request", getGatewayKeys), POST: tracked("gateway-keys", "gateway-keys.create", "Gateway key creation request", postGatewayKey) },
    "/api/gateway-keys/:keyId": { PATCH: tracked("gateway-keys", "gateway-keys.update", "Gateway key update request", patchGatewayKey), DELETE: tracked("gateway-keys", "gateway-keys.delete", "Gateway key deletion request", deleteGatewayKeyHttp) },
    "/api/gateway-keys/:keyId/reveal": { POST: tracked("gateway-keys", "gateway-keys.reveal", "Gateway key reveal request", revealGatewayKeyHttp) },
    // Provider configuration is workspace-scoped desired state. Projection uses
    // a private loopback management API; it is never public gateway routing.
    "/api/providers": { GET: tracked("providers", "providers.list", "Provider list request", getProviders), POST: tracked("providers", "providers.create", "Provider creation request", postProvider) },
    "/api/providers/cleanup": { GET: tracked("providers", "providers.cleanup.list", "Provider cleanup list request", getProviderCleanup, true) },
    "/api/providers/models": { GET: tracked("providers", "providers.models.list", "Provider model list request", getProviderModels) },
    "/api/providers/:providerId": { GET: tracked("providers", "providers.detail", "Provider detail request", getProvider), PATCH: tracked("providers", "providers.update", "Provider update request", patchProvider), DELETE: tracked("providers", "providers.delete", "Provider deletion request", deleteProviderHttp) },
    "/api/providers/:providerId/credentials": { POST: tracked("providers", "providers.credential.create", "Provider credential creation request", postProviderCredential) },
    "/api/providers/:providerId/credentials/:credentialId": { PATCH: tracked("providers", "providers.credential.update", "Provider credential update request", patchProviderCredential), DELETE: tracked("providers", "providers.credential.delete", "Provider credential deletion request", deleteProviderCredentialHttp) },
    "/api/providers/:providerId/credentials/reorder": { POST: tracked("providers", "providers.credential.reorder", "Provider credential reorder request", postProviderCredentialReorder) },
    // Keep the established admin naming as an alias while the browser moves to
    // the more explicit credential terminology above.
    "/api/providers/:providerId/api-keys": { POST: tracked("providers", "providers.credential.create", "Provider credential creation request", postProviderCredential) },
    "/api/providers/:providerId/api-keys/:credentialId": { PATCH: tracked("providers", "providers.credential.update", "Provider credential update request", patchProviderCredential), DELETE: tracked("providers", "providers.credential.delete", "Provider credential deletion request", deleteProviderCredentialHttp) },
    "/api/providers/:providerId/api-keys/reorder": { POST: tracked("providers", "providers.credential.reorder", "Provider credential reorder request", postProviderCredentialReorder) },
    "/api/providers/:providerId/models": { POST: tracked("providers", "providers.model.create", "Provider model creation request", postProviderModel) },
    "/api/providers/:providerId/models/:modelId": { PATCH: tracked("providers", "providers.model.update", "Provider model update request", patchProviderModel), DELETE: tracked("providers", "providers.model.delete", "Provider model deletion request", deleteProviderModelHttp) },
    "/api/providers/:providerId/sync": { GET: tracked("providers", "providers.sync.status", "Provider projection status request", getProviderSync, true), POST: tracked("providers", "providers.sync.retry", "Provider projection retry request", postProviderSyncRetry) },
    "/api/logs": { GET: readLogs, DELETE: clearLogs },
    "/api/logs/global": { GET: readGlobalLogs, DELETE: clearGlobalLogs },
    "/api/logs/events": { POST: reportBrowserEvent },
    "/api/cliproxy/status": { GET: tracked("cliproxy", "cliproxy.status", "CLIProxy status request", cliproxyStatus, true) },
    "/api/cliproxy/versions": { GET: tracked("cliproxy", "cliproxy.versions", "CLIProxy version list request", cliproxyVersions) },
    "/api/cliproxy/install": { POST: tracked("cliproxy", "cliproxy.install", "CLIProxy installation request", cliproxyInstall) },
    "/api/cliproxy/start": { POST: tracked("cliproxy", "cliproxy.start", "CLIProxy start request", cliproxyStart) },
    "/api/cliproxy/stop": { POST: tracked("cliproxy", "cliproxy.stop", "CLIProxy stop request", cliproxyStop) },
    "/api/cliproxy/restart": { POST: tracked("cliproxy", "cliproxy.restart", "CLIProxy restart request", cliproxyRestart) },
    "/v1": { GET: gatewayRoot },
    "/v1/chat/completions": { POST: (request) => gatewayUnavailable(request, "chat-completions", "POST") },
    "/v1/completions": { POST: (request) => gatewayUnavailable(request, "completions", "POST") },
    "/v1/responses": { POST: (request) => gatewayUnavailable(request, "responses", "POST") },
    "/v1/messages": { POST: (request) => gatewayUnavailable(request, "messages", "POST") },
    "/v1/models": { GET: (request) => gatewayUnavailable(request, "models", "GET") },
    "/v1/embeddings": { POST: (request) => gatewayUnavailable(request, "embeddings", "POST") },
    "/v1/images/generations": { POST: (request) => gatewayUnavailable(request, "images", "POST") },
    "/v1/audio/transcriptions": { POST: (request) => gatewayUnavailable(request, "audio-transcriptions", "POST") },
    "/v0/management": tracked("gateway", "gateway.management.blocked", "Private management endpoint rejected", cliproxyManagementNotFound),
    "/v0/management/*": tracked("gateway", "gateway.management.blocked", "Private management endpoint rejected", cliproxyManagementNotFound),
    "/api/hello": {
      GET: () => Response.json({ message: "Hello from Bun and React" }),
    },
  },
  fetch(request) {
    const path = new URL(request.url).pathname;
    const gatewayEndpoint = gatewayEndpoints[path];
    if (gatewayEndpoint) return gatewayMethodNotAllowed(gatewayEndpoint.method);
    if (path === "/v1") return gatewayMethodNotAllowed("GET");
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

if (server) {
  console.log(`🚀 Bun fullstack server running at ${server.url}`);
  logs.record({ source: "server", event: "server.started", message: "RawRoute server started" });
} else if (shutdown) {
  await shutdown;
}
