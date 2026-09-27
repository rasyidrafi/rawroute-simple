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
import { getStatus as getCliproxyStatus, initCliproxy, registerCliproxyRecoveryReconciler, shutdownCliproxy } from "./lib/cliproxy";
import { checkDatabaseConnection } from "./lib/db";
import { env } from "./lib/env";
import { healthResponse } from "./lib/health";
import { deleteGatewayKeysForWorkspace, ensureGatewayKeySchema } from "./lib/gateway-keys";
import { deleteGatewayKeyHttp, getGatewayKeys, patchGatewayKey, postGatewayKey } from "./lib/gateway-keys-http";
import { deleteProvidersForWorkspace, ensureProviderSchema } from "./lib/providers";
import { deleteRoutingForWorkspace, ensureRoutingSchema } from "./lib/routing";
import { deleteModelSharesForWorkspace, ensureModelShareSchema } from "./lib/model-shares";
import { getIncomingModelShares, getModelShares, putModelShares } from "./lib/model-shares-http";
import { deleteRoutingAliasHttp, deleteRoutingComboHttp, getRouting, patchRoutingAlias, patchRoutingCombo, postRoutingAlias, postRoutingCombo, postRoutingComboConfirmation, postRoutingComboTest } from "./lib/routing-http";
import { deleteProviderCredentialHttp, deleteProviderHttp, deleteProviderModelHttp, getProvider, getProviderCleanup, getProviderModels, getProviders, getProviderSync, patchProvider, patchProviderCredential, patchProviderModel, postProvider, postProviderCredential, postProviderCredentialReorder, postProviderModel, postProviderSyncRetry } from "./lib/providers-http";
import { beginProviderSyncShutdown, reconcilePendingProviderProjections, startProviderSync } from "./lib/provider-sync";
import { clearGlobalLogs, clearLogs, readGlobalLogs, readLogs, reportBrowserEvent } from "./lib/logging/http";
import { loggedRequest } from "./lib/logging/request";
import { logs } from "./lib/logging/store";
import { beginGatewayShutdown, gatewayModelInfo, gatewayRequest, gatewayRoot, isGatewayPublicPath } from "./lib/gateway-http";
import { beginAccountingShutdown, deleteAccountingForWorkspace, ensureAccountingSchema, recoverAccountingJobs, startAccountingJobs } from "./lib/accounting";
import { deleteBudgetHttp, deletePricingGroupHttp, getBudgets, getPricing, getPricingModels, getUsage, patchBudgetCodexAnchor, patchBudgetSettings, patchBudgetUnlimited, patchBudgetWindow, patchPricingGroup, postBudget, postPricingGroup, postPricingVersion } from "./lib/accounting-http";
import { deleteCodexAccountHttp, getCodex, getCodexQuota, patchCodexAccount, patchCodexModel, postCodexCallback, postCodexCancel, postCodexCleanupRetry, postCodexPoll, postCodexReorder, postCodexReset, postCodexStart } from "./lib/codex-http";
import { deleteCodexForWorkspace, ensureCodexSchema, reconcileCodexCleanup, recoverCodexLogins, startCodexCleanupWorker, stopCodexCleanupWorker } from "./lib/codex";
import { cancelCliproxyOauth, cliproxyOauthStatus, deleteCliproxyApiKey, deleteCliproxyAuthFile, deleteCliproxyLogs, getCliproxyApiKeys, getCliproxyAuthFiles, getCliproxyLogs, getCliproxySettings, patchCliproxyAuthFile, patchCliproxySettings, postCliproxyOauthCallback, publicCliproxyOauthCallback, putCliproxyApiKeys, startCliproxyOauth } from "./lib/cliproxy/admin-http";
import { dashboardAliases, dashboardPage, dashboardPaths } from "./lib/dashboard-routes";
import { ensureWorkspaceSchema, recoverInterruptedWorkspaceDeletions, registerWorkspaceDeletionExtension } from "./lib/workspaces";
import { deleteWorkspaceHttp, getWorkspaces, patchWorkspace, postWorkspace } from "./lib/workspaces-http";
import { getPublicDashboard, getPublicWorkspaces } from "./lib/public-analytics-http";
import { registerPublicAnalyticsWorkspaceDeletion } from "./lib/public-analytics";

// All new API handlers should use this registration helper. Polling endpoints
// log failures only so watching the dashboard does not flood the console.
function tracked(source: string, event: string, message: string, handler: Parameters<typeof loggedRequest>[1], failuresOnly = false) {
  // These are global audit records and never include request values. Scoped
  // handlers still establish and enforce their own explicit workspace scope.
  return loggedRequest({ source, event, message }, handler, { failuresOnly, scope: "global" });
}

function cliproxyStatusForHealth() {
  return getCliproxyStatus();
}

await ensureAuthSchema();
await ensureDefaultPassword();
await ensureWorkspaceSchema();
await ensureGatewayKeySchema();
await ensureProviderSchema();
await ensureRoutingSchema();
await ensureModelShareSchema();
await ensureAccountingSchema();
await ensureCodexSchema();
let server: ReturnType<typeof serve> | undefined;
let initialization: Promise<void> = Promise.resolve();
let bootstrap: Promise<void> = Promise.resolve();
let shutdown: Promise<void> | undefined;

function handleShutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdown) return shutdown;
  logs.record({ source: "server", event: "server.stopping", message: "RawRoute shutdown started" });
  process.exitCode = signal === "SIGINT" ? 130 : 143;
   const mutationsDrained = stopAcceptingCliproxyMutations();
   stopCodexCleanupWorker();
  const acceptingStopped = server ? server.stop(false) : Promise.resolve();
  // Bootstrap never awaits shutdown, so this covers recovery, sync admission,
  // and initialization without a pre-listener signal deadlock.
  const bootstrapDrained = bootstrap;
  shutdown = (async () => {
    try {
      await Promise.all([bootstrapDrained, mutationsDrained]);
       await beginGatewayShutdown();
       await beginAccountingShutdown();
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
registerWorkspaceDeletionExtension({ name: "workspace-routing", deleteWorkspaceData: deleteRoutingForWorkspace });
registerWorkspaceDeletionExtension({ name: "workspace-model-shares", deleteWorkspaceData: deleteModelSharesForWorkspace });
registerWorkspaceDeletionExtension({ name: "workspace-accounting", deleteWorkspaceData: deleteAccountingForWorkspace });
registerPublicAnalyticsWorkspaceDeletion();
registerWorkspaceDeletionExtension({ name: "workspace-codex", deleteWorkspaceData: deleteCodexForWorkspace });
registerWorkspaceDeletionExtension({
  name: "workspace-gateway-keys",
  deleteWorkspaceData: deleteGatewayKeysForWorkspace,
});
registerWorkspaceDeletionExtension({
  name: "workspace-providers",
  deleteWorkspaceData: async (workspaceId) => {
    await deleteProvidersForWorkspace(workspaceId);
    // Offline cleanup leaves a durable tombstone; no provider row is recreated.
    // A different workspace's unavailable private CLIProxy projection must not
    // roll back this workspace deletion. The durable tombstone is reconciled
    // by the next provider/CLIProxy reconciliation attempt.
    await reconcilePendingProviderProjections().catch(() => undefined);
  },
});
bootstrap = (async () => {
  await recoverInterruptedWorkspaceDeletions();
   await recoverAccountingJobs();
   await recoverCodexLogins();
   await reconcileCodexCleanup();
  // A signal during recovery has already closed admission and scheduled the
  // shutdown path. Do not start sync or a child after that point.
  if (shutdown) return;
  // The server coordinates signals below; prevent the standalone service from
  // registering an earlier competing handler during startup initialization.
  const cliproxyProcess = process as typeof process & { __rawrouteCliproxySignals?: boolean };
  cliproxyProcess.__rawrouteCliproxySignals = true;
   startProviderSync();
   startAccountingJobs();
  registerCliproxyRecoveryReconciler(async () => {
    await reconcilePendingProviderProjections();
    await reconcileCodexCleanup();
  });
  initialization = (async () => {
    try {
       await initCliproxy();
       if (!shutdown) { await reconcilePendingProviderProjections(); await reconcileCodexCleanup(); startCodexCleanupWorker(); }
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
    ...Object.fromEntries(["/", ...Object.values(dashboardPaths), "/dashboard/ai/providers/:providerId"].map((path) => [path, { GET: index }])),
    "/api/health": {
      GET: async () => {
        const response = await healthResponse({ checkDatabase: checkDatabaseConnection, checkCliproxy: cliproxyStatusForHealth });
        // A nonce is test-process-only proof that an ephemeral-port probe is
        // talking to the child this harness just started, never a stale server.
        const nonce = env.nodeEnv === "test" ? Bun.env.RAWROUTE_E2E_RUN_NONCE : undefined;
        if (!nonce) return response;
        const headers = new Headers(response.headers);
        headers.set("x-rawroute-e2e-nonce", nonce);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      },
    },
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
    // Public analytics deliberately has no administrator/session scope. It
    // exposes only active workspace labels and redacted aggregate usage.
    "/api/public/workspaces": { GET: getPublicWorkspaces },
    "/api/public/dashboard": { GET: getPublicDashboard },
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
    // Persisted browser administration catalog.
    "/api/routing": { GET: tracked("routing", "routing.list", "Routing catalog request", getRouting) },
    "/api/routing/aliases": { POST: tracked("routing", "routing.alias.create", "Routing alias creation request", postRoutingAlias) },
    "/api/routing/aliases/:aliasId": { PATCH: tracked("routing", "routing.alias.update", "Routing alias update request", patchRoutingAlias), DELETE: tracked("routing", "routing.alias.delete", "Routing alias deletion request", deleteRoutingAliasHttp) },
    "/api/routing/combos": { POST: tracked("routing", "routing.combo.create", "Routing combo creation request", postRoutingCombo) },
    "/api/routing/combos/test": { POST: tracked("routing", "routing.combo.test", "Routing combo policy test request", postRoutingComboTest) },
    "/api/routing/combos/confirmation": { POST: tracked("routing", "routing.combo.confirmation", "Routing policy confirmation request", postRoutingComboConfirmation) },
    "/api/routing/combos/:comboId": { PATCH: tracked("routing", "routing.combo.update", "Routing combo update request", patchRoutingCombo), DELETE: tracked("routing", "routing.combo.delete", "Routing combo deletion request", deleteRoutingComboHttp) },
    "/api/model-shares": { GET: tracked("model-shares", "model-shares.list", "Model sharing list", getModelShares), PUT: tracked("model-shares", "model-shares.save", "Model sharing update", putModelShares) },
    "/api/model-shares/incoming": { GET: tracked("model-shares", "model-shares.incoming", "Incoming model shares", getIncomingModelShares, true) },
    "/api/model-pricing": { GET: tracked("accounting", "pricing.list", "Pricing list request", getPricing) },
    "/api/model-pricing/models": { GET: tracked("accounting", "pricing.models", "Canonical pricing search", getPricingModels, true) },
    "/api/model-pricing/groups": { POST: tracked("accounting", "pricing.group.create", "Pricing group create", postPricingGroup) },
    "/api/model-pricing/groups/:groupId": { PATCH: tracked("accounting", "pricing.group.update", "Pricing group update", patchPricingGroup), DELETE: tracked("accounting", "pricing.group.delete", "Pricing group delete", deletePricingGroupHttp) },
    "/api/model-pricing/versions": { POST: tracked("accounting", "pricing.version.create", "Pricing version create", postPricingVersion) },
    "/api/budgets": { GET: tracked("accounting", "budget.list", "Budget list request", getBudgets), POST: tracked("accounting", "budget.save", "Budget save", postBudget) },
    "/api/budgets/window": { PATCH: tracked("accounting", "budget.window", "Budget window update", patchBudgetWindow) },
    "/api/budgets/codex-anchor": { PATCH: tracked("accounting", "budget.codex-anchor", "Budget Codex anchor update", patchBudgetCodexAnchor) },
    "/api/budgets/unlimited": { PATCH: tracked("accounting", "budget.unlimited", "Unlimited mode update", patchBudgetUnlimited) },
    "/api/budgets/settings": { PATCH: tracked("accounting", "budget.settings", "Budget policy update", patchBudgetSettings) },
    "/api/budgets/:keyId": { DELETE: tracked("accounting", "budget.delete", "Budget delete", deleteBudgetHttp) },
    "/api/usage": { GET: tracked("accounting", "usage.query", "Usage dashboard query", getUsage, true) },
    // Codex OAuth remains a workspace-owned *mapping* to private CLIProxy auth
    // files. No route returns, accepts, or persists OAuth token material.
    "/api/codex": { GET: tracked("codex", "codex.list", "Codex account list", getCodex), },
    "/api/codex/device/start": { POST: tracked("codex", "codex.login.start", "Codex login started", postCodexStart) },
    "/api/codex/device/callback": { POST: tracked("codex", "codex.login.callback", "Codex callback submitted", postCodexCallback) },
    "/api/codex/device/poll": { POST: tracked("codex", "codex.login.poll", "Codex login polled", postCodexPoll, true) },
    "/api/codex/device/cancel": { POST: tracked("codex", "codex.login.cancel", "Codex login cancelled", postCodexCancel) },
    "/api/codex/cleanup/retry": { POST: tracked("codex", "codex.cleanup.retry", "Codex cleanup retry", postCodexCleanupRetry) },
    "/api/codex/reorder": { POST: tracked("codex", "codex.account.reorder", "Codex account reordered", postCodexReorder) },
    "/api/codex/:accountId": { PATCH: tracked("codex", "codex.account.update", "Codex account updated", patchCodexAccount), DELETE: tracked("codex", "codex.account.delete", "Codex account deleted", deleteCodexAccountHttp) },
    "/api/codex/:accountId/quota": { GET: tracked("codex", "codex.quota", "Codex quota read", getCodexQuota, true) },
    "/api/codex/:accountId/reset": { POST: tracked("codex", "codex.credit.reset", "Codex reset credit redeemed", postCodexReset) },
    "/api/codex/models/:modelId": { PATCH: tracked("codex", "codex.model.update", "Codex model updated", patchCodexModel) },
    "/api/logs": { GET: readLogs, DELETE: clearLogs },
    "/api/logs/global": { GET: readGlobalLogs, DELETE: clearGlobalLogs },
    "/api/logs/events": { POST: reportBrowserEvent },
    "/api/cliproxy/status": { GET: tracked("cliproxy", "cliproxy.status", "CLIProxy status request", cliproxyStatus, true) },
    "/api/cliproxy/versions": { GET: tracked("cliproxy", "cliproxy.versions", "CLIProxy version list request", cliproxyVersions) },
    "/api/cliproxy/install": { POST: tracked("cliproxy", "cliproxy.install", "CLIProxy installation request", cliproxyInstall) },
    "/api/cliproxy/start": { POST: tracked("cliproxy", "cliproxy.start", "CLIProxy start request", cliproxyStart) },
    "/api/cliproxy/stop": { POST: tracked("cliproxy", "cliproxy.stop", "CLIProxy stop request", cliproxyStop) },
    "/api/cliproxy/restart": { POST: tracked("cliproxy", "cliproxy.restart", "CLIProxy restart request", cliproxyRestart) },
    // Global private-management wrappers deliberately ignore workspace headers.
    // They redact secrets and refuse mutation of workspace-owned Codex files.
    "/api/cliproxy/api-keys": { GET: getCliproxyApiKeys, PUT: putCliproxyApiKeys },
    "/api/cliproxy/api-keys/:keyId": { DELETE: deleteCliproxyApiKey },
    "/api/cliproxy/auth-files": { GET: getCliproxyAuthFiles, PATCH: patchCliproxyAuthFile, DELETE: deleteCliproxyAuthFile },
    "/api/cliproxy/settings": { GET: getCliproxySettings, PATCH: patchCliproxySettings },
    "/api/cliproxy/logs": { GET: getCliproxyLogs, DELETE: deleteCliproxyLogs },
    "/api/cliproxy/oauth/:provider/start": { POST: startCliproxyOauth },
    "/api/cliproxy/oauth/:provider/callback": { POST: postCliproxyOauthCallback },
    "/api/cliproxy/oauth/status": { GET: cliproxyOauthStatus },
    "/api/cliproxy/oauth/cancel": { POST: cancelCliproxyOauth },
    "/:provider/callback": { GET: publicCliproxyOauthCallback },
    "/v1": { GET: gatewayRoot },
    "/v1/model/info": { GET: gatewayModelInfo },
    "/model/info": { GET: gatewayModelInfo },
    "/v0/management": tracked("gateway", "gateway.management.blocked", "Private management endpoint rejected", cliproxyManagementNotFound),
    "/v0/management/*": tracked("gateway", "gateway.management.blocked", "Private management endpoint rejected", cliproxyManagementNotFound),
    "/api/hello": {
      GET: () => Response.json({ message: "Hello from Bun and React" }),
    },
  },
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (isGatewayPublicPath(path)) return gatewayRequest(request as import("bun").BunRequest);
    if (dashboardAliases.includes(path as typeof dashboardAliases[number])) {
      const destination = path === "/dashboard/tools" ? dashboardPaths["tool-overview"] : dashboardPaths.endpoint;
      return request.method === "GET" || request.method === "HEAD"
        ? Response.redirect(new URL(destination, request.url), 302)
        : Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (dashboardPage(path)) return Response.json({ error: "Method not allowed" }, { status: 405 });
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  // Keep the production source entry usable for deployment and browser smoke
  // tests; Bun's dev client is not a production runtime dependency.
  ...(env.nodeEnv === "development" ? { development: { hmr: true, console: true } } : {}),
});

if (server) {
  console.log(`🚀 Bun fullstack server running at ${server.url}`);
  logs.record({ source: "server", event: "server.started", message: "RawRoute server started" });
} else if (shutdown) {
  await shutdown;
}
