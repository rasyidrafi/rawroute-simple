import type { BunRequest } from "bun";
import { authenticateGatewayKey } from "./gateway-keys";
import { logs } from "./logging/store";
import { runWithWorkspaceScope } from "./request-scope";
import { admitWorkspaceWrite } from "./workspaces";
import { beginGatewayProbeShutdown, isCatalogPath, isInference, jsonError, monitorGatewayAccountingStream, proxyGatewayCatalog, proxyGatewayGeneric, proxyGatewayInference, publicResponse, releaseSharedOwnerAdmission, startGatewayProbes, waitForNativeAccountingMonitor } from "./gateway-runtime";
import { listRouting } from "./routing";

const MAX_GATEWAY_KEY_LENGTH = 256;
const MIN_GATEWAY_KEY_LENGTH = 32;
const GATEWAY_KEY_PATTERN = /^[\x21-\x7e]+$/;
const publicNamespaces = ["/v1/", "/openai/v1/", "/v1beta/", "/backend-api/codex/"];
let accepting = true;
type ActiveGatewayRequest = { controller: AbortController; done: Promise<void> };
const active = new Set<ActiveGatewayRequest>();
const GATEWAY_REQUEST_TIMEOUT_MS = Math.max(1_000, Number(Bun.env.ROUTING_MAX_STREAM_DURATION_SECONDS ?? 290) * 1_000 + 10_000);

function gatewayError(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store", ...headers } });
}
function authenticationFailed(): Response { return Response.json({ error: { message: "Invalid gateway API key." } }, { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } }); }
function validGatewayKey(value: string | null): string | undefined { return value && value.length >= MIN_GATEWAY_KEY_LENGTH && value.length <= MAX_GATEWAY_KEY_LENGTH && GATEWAY_KEY_PATTERN.test(value) ? value : undefined; }
/** Parse only bounded printable credentials. Two differing credential headers fail closed. */
export function gatewayCredential(request: Request): string | undefined {
  const authorization = request.headers.get("authorization"); const apiKey = request.headers.get("x-api-key");
  const bearer = authorization === null ? undefined : /^Bearer ([\x21-\x7e]+)$/i.exec(authorization)?.[1];
  const validBearer = authorization === null ? undefined : validGatewayKey(bearer ?? null);
  const headerKey = apiKey === null ? undefined : validGatewayKey(apiKey);
  if ((authorization !== null && !validBearer) || (apiKey !== null && !headerKey) || (validBearer && headerKey && validBearer !== headerKey)) return undefined;
  return validBearer ?? headerKey;
}
function logGlobal(event: string, message: string, level: "WARN" | "ERROR" = "WARN"): void { logs.record({ source: "gateway", event, message }, level); }
function expectedTransportAbort(error: unknown, signal: AbortSignal): boolean { return signal.aborted && typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError"; }
function gatewayStreamMonitorFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "gateway_stream_monitor_failed";
  return /^[a-z][a-z0-9_]{0,63}$/i.test(code) ? code : "gateway_stream_monitor_failed";
}
function logGatewayStreamMonitorFailure(error: unknown): void {
  const code = gatewayStreamMonitorFailureCode(error);
  logs.record({ source: "gateway", event: `gateway.stream.monitor.${code}`, message: "Gateway stream monitor failed" }, "ERROR");
  console.error(`Gateway stream monitor failed [${code}]`);
}
/** The public response is otherwise a passive tee branch. Bridge its network
 * cancellation back to the request controller so a client abort stops the
 * upstream fetch and the original native-accounting monitor promptly. */
function abortableClientStream(source: ReadableStream<Uint8Array>, abort: (reason?: unknown) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { controller.close(); release(); } else controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    async cancel(reason) {
      abort(reason);
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
}

/**
 * Public gateway dispatcher. The workspace comes exclusively from the key;
 * client workspace headers are ignored. Only the documented public namespaces
 * reach this function, never CLIProxy management.
 */
export async function gatewayRequest(request: BunRequest): Promise<Response> {
  if (!accepting) return gatewayError("gateway_shutting_down", "Gateway is shutting down.", 503);
  if (request.signal.aborted) return jsonError(499, "Request cancelled.", "request_cancelled");
  const credential = gatewayCredential(request);
  if (!credential) { logGlobal("gateway.authentication.rejected", "Gateway authentication rejected"); return authenticationFailed(); }
  let authentication;
  try { authentication = await authenticateGatewayKey(credential); } catch { logGlobal("gateway.authentication.unavailable", "Gateway authentication unavailable", "ERROR"); return gatewayError("gateway_authentication_unavailable", "Gateway authentication is temporarily unavailable.", 503); }
  if (!accepting || request.signal.aborted) return gatewayError("gateway_shutting_down", "Gateway is shutting down.", 503);
  if (!authentication) { logGlobal("gateway.authentication.rejected", "Gateway authentication rejected"); return authenticationFailed(); }
  const admission = await admitWorkspaceWrite(authentication.workspace.id).catch(() => undefined);
  if (!admission) return authenticationFailed();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Gateway request timed out.")), GATEWAY_REQUEST_TIMEOUT_MS);
  const abort = (reason = request.signal.reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort(request.signal.reason);
  let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; }); const activeRequest = { controller, done }; active.add(activeRequest);
  let released = false; const release = () => { if (!released) { released = true; clearTimeout(timeout); request.signal.removeEventListener("abort", abort); admission.release(); active.delete(activeRequest); finish(); } };
  try {
    const path = new URL(request.url).pathname;
    if (controller.signal.aborted) { release(); return jsonError(499, "Request cancelled.", "request_cancelled"); }
    const scopedRequest = new Request(request, { signal: controller.signal }) as BunRequest;
    const response = await runWithWorkspaceScope({ kind: "workspace", workspace: authentication.workspace }, async () => {
      if (!accepting || controller.signal.aborted) return gatewayError("gateway_shutting_down", "Gateway is shutting down.", 503);
      if (path.startsWith("/v1beta/") && scopedRequest.method === "GET" && !isCatalogPath(path)) return gatewayError("model_not_found", "Unknown Gemini gateway resource.", 404);
      if (isCatalogPath(path)) return await proxyGatewayCatalog(authentication.workspace.id);
      if (isInference(scopedRequest, path)) return await proxyGatewayInference(scopedRequest, authentication.workspace.id, authentication.key.id);
      return await proxyGatewayGeneric(scopedRequest);
    });
    logs.record({ source: "gateway", event: "gateway.request", message: "Gateway request completed" }, response.ok ? "INFO" : "WARN", { status: response.status, succeeded: response.ok }, "server", logs.admitWorkspace(authentication.workspace.id));
    if (!response.body) { release(); return publicResponse(response); }
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      // Non-streaming accounting clones and settles the body before this point;
      // retaining workspace admission until an arbitrary client reads bytes can
      // deadlock a delete or a test client that only inspects status.
      release();
      return publicResponse(response);
    }
    // Tee before returning: downstream receives bytes immediately while the
    // monitor owns admission until terminal/error/cancellation, ready for the
    // later stream usage settlement hook.
    const [downstream, monitor] = response.body.tee();
    const accountingAttemptId = response.headers.get("x-rawroute-accounting-attempt"); const nativeOriginalMonitor = response.headers.get("x-rawroute-accounting-original-monitored") === "1";
    void (async () => { try { if (nativeOriginalMonitor && accountingAttemptId) { const reader = monitor.getReader(); try { await Promise.all([waitForNativeAccountingMonitor(accountingAttemptId), (async () => { while (!(await reader.read()).done) { /* translated stream */ } })()]); } finally { reader.releaseLock(); } } else if (accountingAttemptId) await monitorGatewayAccountingStream(accountingAttemptId, monitor, controller.signal); else { const reader = monitor.getReader(); try { while (!(await reader.read()).done) { /* generic stream */ } } finally { reader.releaseLock(); } } } finally { if (accountingAttemptId) releaseSharedOwnerAdmission(accountingAttemptId); try { await monitor.cancel(); } catch { /* already closed */ } release(); } })().catch((error) => { if (!expectedTransportAbort(error, controller.signal)) logGatewayStreamMonitorFailure(error); });
    return publicResponse(new Response(abortableClientStream(downstream, abort), { status: response.status, statusText: response.statusText, headers: response.headers }));
  } catch {
    release();
    return jsonError(503, "Gateway routing is temporarily unavailable.", "model_resolver_unavailable");
  }
}

/** Stop gateway admission before CLIProxy shutdown and drain active stream monitors. */
export async function beginGatewayShutdown(): Promise<void> {
  accepting = false;
  for (const request of active) request.controller.abort(new Error("Gateway is shutting down."));
  await Promise.all([Promise.race([Promise.allSettled([...active].map((request) => request.done)), Bun.sleep(5_000)]), beginGatewayProbeShutdown()]);
}
export function startGateway(): void { accepting = true; startGatewayProbes(); }
export function isGatewayPublicPath(path: string): boolean { return publicNamespaces.some((prefix) => path.startsWith(prefix)) || path === "/model/info"; }
export function gatewayRoot(): Response { return Response.json({ service: "RawRoute AI Gateway", endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/models"] }, { headers: { "cache-control": "no-store" } }); }
export async function gatewayModelInfo(request: BunRequest): Promise<Response> {
  const credential = gatewayCredential(request); if (!credential) return authenticationFailed();
  try {
    const authentication = await authenticateGatewayKey(credential); if (!authentication) return authenticationFailed();
    const routing = await listRouting(authentication.workspace.id); const models = new Map(routing.models.filter((model) => model.protocol === "openai-chat").map((model) => [model.id, model]));
    const data = [...models.values()].map((model) => ({ model_name: model.id, litellm_params: { model: model.upstreamModel }, model_info: { id: model.id, db_model: false, mode: "chat" as const } }));
    const shared = new Map((routing.sharedModels ?? []).filter((item) => item.status === "active" && item.protocol === "openai-chat").map((item) => [item.id, item]));
    for (const alias of routing.aliases) { const target = models.get(alias.targetModelId); if (target) data.push({ model_name: alias.alias, litellm_params: { model: target.upstreamModel }, model_info: { id: alias.alias, db_model: false, mode: "chat" } }); else if (alias.shareId && shared.has(alias.shareId)) data.push({ model_name: alias.alias, litellm_params: { model: alias.alias }, model_info: { id: alias.alias, db_model: false, mode: "chat" } }); }
    return Response.json({ data }, { headers: { "cache-control": "private, no-store" } });
  } catch { return gatewayError("model_resolver_unavailable", "Model resolver is temporarily unavailable.", 503); }
}

// Compatibility wrapper retained for existing key-storage tests. It authenticates
// and admits a workspace but never executes; new public routes use gatewayRequest.
export async function gatewayUnavailable(request: BunRequest, endpoint: string, expectedMethod: string): Promise<Response> {
  if (request.method !== expectedMethod) return gatewayError("method_not_allowed", "Method not allowed.", 405, { Allow: expectedMethod });
  const credential = gatewayCredential(request); if (!credential) { logGlobal("gateway.authentication.rejected", "Gateway authentication rejected"); return authenticationFailed(); }
  try { const auth = await authenticateGatewayKey(credential); if (!auth) return authenticationFailed(); const admission = await admitWorkspaceWrite(auth.workspace.id); if (!admission) return authenticationFailed(); try { logs.record({ source: "gateway", event: `gateway.${endpoint}.${expectedMethod.toLowerCase()}`, message: "Gateway compatibility request" }, "ERROR", { status: 503, succeeded: false }, "server", logs.admitWorkspace(auth.workspace.id)); return gatewayError("workspace_routing_not_ready", "Workspace routing is not configured.", 503); } finally { admission.release(); } } catch { return gatewayError("gateway_authentication_unavailable", "Gateway authentication is temporarily unavailable.", 503); }
}
export const gatewayEndpoints: Record<string, { endpoint: string; method: "GET" | "POST" }> = {
  "/v1/chat/completions": { endpoint: "chat-completions", method: "POST" },
  "/v1/completions": { endpoint: "completions", method: "POST" },
  "/v1/responses": { endpoint: "responses", method: "POST" },
  "/v1/messages": { endpoint: "messages", method: "POST" },
  "/v1/models": { endpoint: "models", method: "GET" },
  "/v1/embeddings": { endpoint: "embeddings", method: "POST" },
  "/v1/images/generations": { endpoint: "images", method: "POST" },
  "/v1/audio/transcriptions": { endpoint: "audio-transcriptions", method: "POST" },
};
export function gatewayMethodNotAllowed(method: "GET" | "POST"): Response { return gatewayError("method_not_allowed", "Method not allowed.", 405, { Allow: method }); }
