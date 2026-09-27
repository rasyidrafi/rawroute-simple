import { getStatus, CLIPROXY_HOST, CLIPROXY_PORT, getDataRoot } from "./cliproxy";
import { getServicePaths, readSecret } from "./cliproxy/store";
import { catalogForWorkspace } from "./catalog";
import { listRouting, resolveRoutingModel, setRoutingComboMemberValidation, type AvailableRouteModel, type ResolvedRoute, type RoutingComboMember } from "./routing";
import { getProviderProjectionSnapshot, type ProviderProjectionSnapshot } from "./providers";
import { getProviderSyncStatus, providerManagedNamespace } from "./provider-sync";
import { applyReasoningOverride, memberPolicyConfigHash, reasoningCapabilityError, stripReasoningFields } from "./combo-reasoning";
import { ingressForPath, isCatalogPath, isInference, isNativeResponsesCompatible, modelFromPath, providerResponsesUrl, rewritePathModel, type GatewayIngress } from "./gateway-protocol";
import { nativeResponsesJson, nativeResponsesRequest, nativeResponsesStream } from "./gateway-native";
import { normalizeResponsesRequest } from "./request-normalization";
import { cancelAccountingAttempt, gatewayAccountingHooks, registerAccountingShutdownFinalizer } from "./accounting";
import { codexWorkspacePrefix, ensureCodexProvider, resolveCodexExecution } from "./codex";
import { resolveSharedModelForRecipient } from "./model-shares";
import { logs } from "./logging/store";
import { admitWorkspaceWrite, type WorkspaceWriteAdmission } from "./workspaces";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding", "expect"]);
const INTERNAL_HEADERS = new Set(["authorization", "x-api-key", "x-management-key", "x-rawroute-combo-terminal", "x-rawroute-combo-member-unavailable", "x-rawroute-accounting-attempt", "x-rawroute-accounting-original-monitored"]);

export type GatewayAttempt = { attemptId: string; requestId: string; workspaceId: string; gatewayKeyId: string; /** Public route requested by the caller (the combo id for combo members). */ requestedModel: string; /** Original member target, retained separately from the outer combo route. */ memberRequestedModel?: string; model: AvailableRouteModel; providerId: string; protocol: GatewayIngress; startedAt: number; requestBodyBytes: number; payload?: Record<string, unknown>; comboMember?: boolean; consumerWorkspaceId?: string; consumerGatewayKeyId?: string; consumerModelId?: string };
/**
 * Accounting is intentionally an injected boundary. A later durable admission
 * implementation receives the stable request/key/model identifiers here and may
 * return a terminal response (with an internal combo control header).
 */
export type GatewayAccountingHooks = {
  beforeRequestedCombo?: (input: { requestId: string; workspaceId: string; gatewayKeyId: string; requestedModel: string }) => Promise<Response | undefined>;
  beforeAttempt?: (attempt: GatewayAttempt) => Promise<Response | undefined>;
  onResult?: (attempt: GatewayAttempt & { status: number; completedAt: number; streamed: boolean; terminalStream: boolean; response?: Response }) => Promise<void>;
  onStream?: (attemptId: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal) => Promise<void>;
};
export type GatewayRuntimeDependencies = {
  fetch: typeof fetch;
  getStatus: typeof getStatus;
  getProviderSnapshot: typeof getProviderProjectionSnapshot;
  getProviderSync: typeof getProviderSyncStatus;
  resolve: typeof resolveRoutingModel;
  catalog: typeof catalogForWorkspace;
  cliproxyKey: () => string;
  hooks: GatewayAccountingHooks;
};

function productionDependencies(): GatewayRuntimeDependencies {
  return {
    fetch,
    getStatus,
    getProviderSnapshot: getProviderProjectionSnapshot,
    getProviderSync: getProviderSyncStatus,
    resolve: resolveRoutingModel,
    catalog: catalogForWorkspace,
    cliproxyKey: () => readSecret(getServicePaths(getDataRoot()).apiKey),
    hooks: gatewayAccountingHooks(),
  };
}
let dependencies = productionDependencies();
const nativeAccountingMonitors = new Map<string, Promise<void>>();
/** Shared owner admission is retained until durable settlement / stream drain.
 * The consumer request admission remains owned by gateway-http. */
const sharedOwnerAdmissions = new Map<string, () => void>();
export function releaseSharedOwnerAdmission(attemptId: string): void { const release = sharedOwnerAdmissions.get(attemptId); if (release) { sharedOwnerAdmissions.delete(attemptId); release(); } }
/** Native accounting owns a tee of the original provider stream. Its promise is
 * observed here rather than by a fire-and-forget caller so a client socket reset
 * cannot become an unhandled rejection in the compiled server. */
function expectedTransportAbort(error: unknown, signal: AbortSignal): boolean {
  // Bun may surface the same fetch cancellation as an Error, DOMException, or
  // cross-realm error object, so require both the exact abort name and our own
  // cancelled transport signal. A generic error after cancellation is logged.
  return signal.aborted && typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
function monitorFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "accounting_monitor_failed";
  return /^[a-z][a-z0-9_]{0,63}$/i.test(code) ? code : "accounting_monitor_failed";
}
/** Record a closed-vocabulary failure: upstream/accounting exception text can
 * contain provider data, so neither the exception nor its message is logged. */
function logNativeAccountingMonitorFailure(error: unknown): void {
  const code = monitorFailureCode(error);
  logs.record({ source: "gateway", event: `gateway.accounting.monitor.${code}`, message: "Accounting stream monitor failed" }, "ERROR");
  console.error(`Accounting stream monitor failed [${code}]`);
}
function trackNativeAccountingMonitor(attemptId: string, monitoring: Promise<void>, signal: AbortSignal): void {
  const observed = monitoring.catch((error) => {
    // monitorAccountingStream handles ordinary AbortError transport cancellation
    // internally and settles it as 499. A rejected monitor is therefore an
    // operational failure even if the client already disconnected, except for
    // this explicit transport-abort shape.
    if (!expectedTransportAbort(error, signal)) logNativeAccountingMonitorFailure(error);
  });
  nativeAccountingMonitors.set(attemptId, observed);
  void observed.finally(() => nativeAccountingMonitors.delete(attemptId));
}
type ActiveProbe = { controller: AbortController; done: Promise<void>; attemptId?: string; finish: () => void };
const activeProbes = new Set<ActiveProbe>(); let acceptingProbes = true;
function beginProbeLifecycle(): { signal: AbortSignal; finish: () => void; setAttemptId: (attemptId: string | null) => void } | undefined {
  if (!acceptingProbes) return undefined;
  const controller = new AbortController(); let complete!: () => void; const done = new Promise<void>((resolve) => { complete = resolve; }); let finished = false; const active: ActiveProbe = { controller, done, finish: () => { if (!finished) { finished = true; activeProbes.delete(active); complete(); } } }; activeProbes.add(active);
  return { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), finish: active.finish, setAttemptId: (attemptId) => { if (attemptId) active.attemptId = attemptId; } };
}
/** Shutdown owns probe cancellation just like public streams. It bounds waiting
 * so a buggy upstream cannot hold process shutdown for the probe's 20s limit. */
export async function beginGatewayProbeShutdown(): Promise<void> { acceptingProbes = false; for (const probe of activeProbes) probe.controller.abort(new Error("Gateway is shutting down.")); await Promise.race([Promise.allSettled([...activeProbes].map((probe) => probe.done)), Bun.sleep(500)]); }
export function startGatewayProbes(): void { acceptingProbes = true; }
/** Called after accounting's first queue drain. Give cooperative monitors a
 * short final chance, then durably cancel stubborn attempts before releasing
 * their owner admission. Shutdown never leaves a probe-owned reservation. */
export async function finalizeGatewayProbesForAccountingShutdown(): Promise<void> { const snapshot = [...activeProbes]; await Promise.race([Promise.allSettled(snapshot.map((probe) => probe.done)), Bun.sleep(500)]); for (const probe of snapshot) if (activeProbes.has(probe)) { if (probe.attemptId) { await cancelAccountingAttempt(probe.attemptId); releaseSharedOwnerAdmission(probe.attemptId); } probe.finish(); } await Promise.allSettled(snapshot.map((probe) => probe.done)); }
registerAccountingShutdownFinalizer(finalizeGatewayProbesForAccountingShutdown);
/** Test seam only; production transport is always loopback CLIProxy/direct provider fetch. */
export function setGatewayRuntimeDependenciesForTesting(overrides: Partial<GatewayRuntimeDependencies>): () => void {
  const previous = dependencies;
  // Fixtures exercise transport in isolation. Accounting integration tests pass
  // hooks explicitly; production is the only default durable hook owner.
  dependencies = { ...dependencies, ...overrides, hooks: overrides.hooks ?? {} };
  return () => { dependencies = previous; };
}

function jsonError(status: number, message: string, code?: string, headers?: HeadersInit): Response {
  return Response.json({ error: { message, ...(code ? { code } : {}) } }, { status, headers: { "cache-control": "no-store", ...headers } });
}
function safeHeaders(source: Headers): Headers {
  const result = new Headers();
  const connectionFields = source.get("connection")?.split(",").map((field) => field.trim().toLowerCase()).filter(Boolean) ?? [];
  const forbidden = new Set([...HOP_BY_HOP, ...connectionFields, ...INTERNAL_HEADERS]);
  for (const [name, value] of source) if (!forbidden.has(name.toLowerCase())) result.set(name, value);
  return result;
}
function publicResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: safeHeaders(response.headers) });
}
function bodyObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] = current && value && typeof current === "object" && typeof value === "object" && !Array.isArray(current) && !Array.isArray(value)
      ? merge(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return result;
}
function applyMemberPolicy(payload: Record<string, unknown>, member: RoutingComboMember, ingress: GatewayIngress, native: boolean): Record<string, unknown> {
  const result = member.customPayload ? merge(payload, member.customPayload) : { ...payload };
  if (member.reasoning.mode === "default") return stripReasoningFields(result);
  if (member.reasoning.mode === "override") return applyReasoningOverride(result, member.reasoning.effort!, native ? "openai-responses" : ingress);
  return result;
}
function clampProbePayload(payload: Record<string, unknown>, ingress: GatewayIngress, native: boolean): Record<string, unknown> {
  const next = { ...payload }; delete next.n;
  if (native || ingress === "openai-responses") { delete next.max_tokens; delete next.max_completion_tokens; next.max_output_tokens = 8; return next; }
  if (ingress === "openai-chat") { delete next.max_tokens; delete next.max_output_tokens; next.max_completion_tokens = 8; return next; }
  delete next.max_output_tokens; delete next.max_completion_tokens; next.max_tokens = 8; return next;
}
async function boundedFailure(response: Response): Promise<{ synthetic: boolean; confirmedLimit: boolean }> {
  if (response.status !== 429) return { synthetic: false, confirmedLimit: false };
  const reader = response.clone().body?.getReader(); if (!reader) return { synthetic: false, confirmedLimit: false };
  let text = ""; const decoder = new TextDecoder(); const deadline = Date.now() + 250;
  try { while (text.length < 8192 && Date.now() < deadline) { const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), Math.max(1, deadline - Date.now())))]); if (next.done) break; text += decoder.decode(next.value, { stream: true }); } } catch { /* opaque errors are never interpreted */ } finally { void reader.cancel().catch(() => undefined); }
  try { const payload = JSON.parse(text) as { error?: { code?: unknown; type?: unknown; message?: unknown } }; const code = String(payload.error?.code ?? payload.error?.type ?? "").toLowerCase().replace(/[-:]/g, "_"); const message = String(payload.error?.message ?? "").toLowerCase(); return { synthetic: ["model_cooldown", "codex_cooldown", "combo_cooldown", "combo_rate_limited"].includes(code) || message.includes("cooldown is still active"), confirmedLimit: ["usage_limit_reached", "insufficient_quota", "quota_exceeded", "rate_limit_exceeded", "rate_limit_error", "too_many_requests"].includes(code) || message.includes("quota exceeded") || message.includes("rate limit") }; } catch { return { synthetic: false, confirmedLimit: false }; }
}
async function sanitizeFailure(response: Response): Promise<Response> {
  const headers = safeHeaders(response.headers);
  if (response.status !== 429) { headers.delete("retry-after"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
  const failure = await boundedFailure(response);
  if (failure.synthetic || !failure.confirmedLimit) return jsonError(503, "Upstream routing is temporarily unavailable.", "upstream_unavailable");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function projectedReady(snapshot: ProviderProjectionSnapshot): Promise<boolean> {
  const status = await dependencies.getProviderSync(snapshot.provider.workspaceId, snapshot.provider.id);
  if (!status || status.state !== "applied" || status.appliedRevision !== snapshot.provider.desiredRevision) return false;
  return (await dependencies.getStatus()).healthy;
}
function cliProxyUrl(request: Request, path = new URL(request.url).pathname): string { const current = new URL(request.url); return `http://${CLIPROXY_HOST}:${CLIPROXY_PORT}${path}${current.search}`; }
async function executeOne(request: Request, workspaceId: string, keyId: string, requestId: string, requestedModel: string, payload: Record<string, unknown>, resolved: Exclude<ResolvedRoute, { kind: "combo" }>, policy?: RoutingComboMember, rawBody?: Uint8Array): Promise<Response> {
  if (policy?.validationState === "invalid" && keyId !== "policy-probe") return jsonError(400, "This combo member policy is invalid.", "model_not_found", { "x-rawroute-combo-member-unavailable": "1" });
  if (!resolved.model) return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found", { "x-rawroute-combo-member-unavailable": "1" });
  // A share is re-read immediately before transport selection. This closes the
  // resolver-to-fetch window for revocation, disabled source models, and either
  // workspace becoming unavailable. The client never supplies this binding.
  let model = resolved.model; let executionWorkspaceId = workspaceId; let ownerAdmission: WorkspaceWriteAdmission | undefined;
  if (model.shared) {
    const shared = await resolveSharedModelForRecipient(workspaceId, model.shared.grantId);
    if (!shared || shared.share.sourceModelId !== model.shared.sourceModelId) return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found", { "x-rawroute-combo-member-unavailable": "1" });
    executionWorkspaceId = shared.owner.id;
    model = { id: shared.model.gatewayModelId, providerId: shared.provider.id, providerPrefix: shared.provider.prefix, name: shared.model.name, upstreamModel: shared.model.upstreamModel, protocol: shared.provider.protocol, source: "shared", ...(shared.model.reasoningCapability ? { reasoningCapability: shared.model.reasoningCapability } : {}), shared: model.shared };
    ownerAdmission = await admitWorkspaceWrite(executionWorkspaceId);
    if (!ownerAdmission) return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found", { "x-rawroute-combo-member-unavailable": "1" });
  }
  let snapshot: ProviderProjectionSnapshot | undefined;
  try { snapshot = await dependencies.getProviderSnapshot(executionWorkspaceId, model.providerId); } catch { ownerAdmission?.release(); return jsonError(503, "Model resolver is temporarily unavailable.", "model_resolver_unavailable"); }
  if (!snapshot || !snapshot.provider.enabled) { ownerAdmission?.release(); return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found", { "x-rawroute-combo-member-unavailable": "1" }); }
  // A grant may be revoked while a private snapshot is being assembled. Recheck
  // after that await and before any credential or upstream request is used.
  if (model.shared) {
    const current = await resolveSharedModelForRecipient(workspaceId, model.shared.grantId);
    if (!current || current.share.sourceModelId !== model.shared.sourceModelId) { ownerAdmission?.release(); return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found", { "x-rawroute-combo-member-unavailable": "1" }); }
  }
  const providerModel = snapshot.models.find((item) => item.gatewayModelId === model.id && item.enabled);
  if (!providerModel) { ownerAdmission?.release(); return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found", { "x-rawroute-combo-member-unavailable": "1" }); }
  const ingress = ingressForPath(new URL(request.url).pathname);
  const policyError = policy ? reasoningCapabilityError(policy.reasoning, model.reasoningCapability) : undefined;
  if (policyError) { ownerAdmission?.release(); return jsonError(400, policyError, "reasoning_not_supported"); }
  let withPolicy = policy ? applyMemberPolicy(payload, policy, ingress, snapshot.provider.protocol === "openai-responses") : payload;
  if (keyId === "policy-probe") withPolicy = clampProbePayload(withPolicy, ingress, snapshot.provider.protocol === "openai-responses");
  // Admission predicts what the provider actually receives, not the caller's
  // pre-policy payload. Native conversion can substantially change byte size.
  const transportPayload = snapshot.provider.protocol === "openai-responses" ? nativeResponsesRequest(withPolicy, ingress, providerModel.upstreamModel) : ingress === "openai-responses" ? normalizeResponsesRequest(withPolicy) : { ...withPolicy };
  // CLIProxy routes use a namespace-owned model id. Put it in the object before
  // accounting admission so the measured bytes exactly equal JSON sent on wire.
  // Codex uses a workspace-owned auth-file prefix in the same private CLIProxy,
  // never a direct Responses request. The model namespace is server-generated;
  // no client auth-file/index/name is accepted on this path.
  const codex = snapshot.provider.prefix === "codex";
  const managedModel = codex ? `${codexWorkspacePrefix(executionWorkspaceId)}/${providerModel.gatewaySuffix}` : snapshot.provider.protocol === "openai-responses" ? undefined : `${providerManagedNamespace(executionWorkspaceId, snapshot.provider.id)}/${providerModel.gatewaySuffix}`;
  if (managedModel) transportPayload.model = managedModel;
  const transportBytes = new TextEncoder().encode(JSON.stringify(transportPayload)).byteLength;
  const attempt: GatewayAttempt = { attemptId: crypto.randomUUID(), requestId, workspaceId: executionWorkspaceId, gatewayKeyId: model.shared ? `shared-workspace:${workspaceId}` : keyId, requestedModel, ...(policy ? { memberRequestedModel: policy.target } : {}), model, providerId: snapshot.provider.id, protocol: ingress, startedAt: Date.now(), requestBodyBytes: transportBytes, payload: transportPayload, comboMember: Boolean(policy), ...(model.shared ? { consumerWorkspaceId: workspaceId, consumerGatewayKeyId: keyId, consumerModelId: requestedModel } : {}) };
  if (ownerAdmission) sharedOwnerAdmissions.set(attempt.attemptId, () => ownerAdmission!.release());
  const completed = async (response: Response, streamed = false, accountingResponse = response): Promise<Response> => {
    // This private header connects the response tee to the durable stream
    // monitor. publicResponse strips it before a client can observe it.
    const headers = new Headers(response.headers); headers.set("x-rawroute-accounting-attempt", attempt.attemptId);
    const tracked = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    // A completed response is not allowed to silently drop its accounting
    // promise. The durable hook owns retrying transient settlement failures;
    // an unavailable ledger must never rewrite a successful upstream outcome.
    try { await dependencies.hooks.onResult?.({ ...attempt, status: tracked.status, completedAt: Date.now(), streamed, terminalStream: !streamed, response: accountingResponse }); } catch (error) { console.error("Accounting result persistence failed:", error); } finally { if (!streamed) releaseSharedOwnerAdmission(attempt.attemptId); }
    return tracked;
  };
  let admission: Response | undefined;
  try { admission = await dependencies.hooks.beforeAttempt?.(attempt); } catch { releaseSharedOwnerAdmission(attempt.attemptId); return jsonError(503, "Budget state is unavailable.", "budget_unavailable"); }
  if (admission) return await completed(admission);
  try {
    if (codex) {
      // Resolve after the final grant re-read. This is owner-scoped state and
      // returns no credential material; the generated prefix is the only
      // namespace sent to the shared private CLIProxy transport.
      const codexExecution = await resolveCodexExecution(executionWorkspaceId);
      if (!codexExecution || !(await dependencies.getStatus()).healthy) return await completed(jsonError(503, "The selected Codex account is not ready.", "provider_not_ready"));
      if (transportPayload.model !== `${codexExecution.prefix}/${providerModel.gatewaySuffix}`) return await completed(jsonError(503, "The selected Codex account is not ready.", "provider_not_ready"));
      if (!isNativeResponsesCompatible(new URL(request.url).pathname)) return await completed(jsonError(400, "This endpoint is not supported by Codex.", "native_provider_protocol_unsupported"));
      const headers = safeHeaders(request.headers); headers.set("authorization", `Bearer ${dependencies.cliproxyKey()}`); headers.delete("x-api-key"); headers.set("content-type", "application/json");
      // The request was normalized to Responses above, so it must also enter
      // CLIProxy at its Responses endpoint. Forwarding it to chat/messages
      // would make CLIProxy translate once and our native converter translate
      // that already-translated response a second time.
      const response = await dependencies.fetch(cliProxyUrl(request, "/v1/responses"), { method: request.method, headers, body: JSON.stringify(transportPayload), signal: request.signal, cache: "no-store", duplex: "half" as const } as RequestInit & { duplex: "half" });
      if (!response.ok) return await completed(await sanitizeFailure(response));
       if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") && response.body) {
           const [client, accounting] = response.body.tee(); const monitoring = dependencies.hooks.onStream?.(attempt.attemptId, accounting, request.signal) ?? Promise.resolve(); trackNativeAccountingMonitor(attempt.attemptId, monitoring, request.signal);
         const translatedHeaders = safeHeaders(response.headers); translatedHeaders.set("x-rawroute-accounting-original-monitored", "1");
         return await completed(new Response(nativeResponsesStream(client, ingress, requestedModel, request.signal), { status: response.status, headers: translatedHeaders }), true);
       }
       const bytes = new Uint8Array(await response.arrayBuffer());
       if (bodyObject(bytes)?.status === "failed") return await completed(jsonError(502, "Upstream response failed.", "upstream_failed"));
       const responseHeaders = safeHeaders(response.headers); responseHeaders.set("content-type", "application/json"); return await completed(new Response(Buffer.from(nativeResponsesJson(bytes, ingress, requestedModel)), { status: response.status, headers: responseHeaders }), false, new Response(bytes, { status: response.status, headers: response.headers }));
    }
    if (snapshot.provider.protocol === "openai-responses") {
      const credentials = snapshot.provider.authType === "none" ? [undefined] : snapshot.credentials.filter((credential) => credential.enabled && credential.secret.trim()).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      if (!credentials.length) return await completed(jsonError(503, "No enabled provider credentials are available.", "provider_unavailable"));
      let last: Response | undefined;
      for (const credential of credentials) {
        if (request.signal.aborted) throw request.signal.reason;
        const headers = new Headers(snapshot.provider.headers); headers.set("content-type", "application/json"); headers.set("accept", request.headers.get("accept") ?? "application/json");
        if (snapshot.provider.authType === "bearer" && credential) headers.set("authorization", `Bearer ${credential.secret}`);
        if (!isNativeResponsesCompatible(new URL(request.url).pathname)) return await completed(jsonError(400, "This endpoint is not supported by a native Responses provider.", "native_provider_protocol_unsupported"));
        const response = await dependencies.fetch(providerResponsesUrl(snapshot.provider.baseUrl), { method: "POST", headers, body: JSON.stringify(transportPayload), signal: request.signal, cache: "no-store" });
        if (response.ok || credential === credentials.at(-1)) { last = response; break; }
        void response.body?.cancel().catch(() => undefined); last = response;
      }
      const response = last!;
      if (!response.ok) return await completed(await sanitizeFailure(response));
       if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") && response.body) {
         const [client, accounting] = response.body.tee();
           const monitoring = dependencies.hooks.onStream?.(attempt.attemptId, accounting, request.signal) ?? Promise.resolve();
           trackNativeAccountingMonitor(attempt.attemptId, monitoring, request.signal);
         const translatedHeaders = safeHeaders(response.headers); translatedHeaders.set("x-rawroute-accounting-original-monitored", "1");
          return await completed(new Response(nativeResponsesStream(client, ingress, requestedModel, request.signal), { status: response.status, headers: translatedHeaders }), true);
       }
       const bytes = new Uint8Array(await response.arrayBuffer());
       const nativeStatus = bodyObject(bytes)?.status;
        if (nativeStatus === "failed") return await completed(jsonError(502, "Upstream response failed.", "upstream_failed"));
       // Account from the unmodified native response. Translating to Chat or
       // Anthropic intentionally drops cache-detail fields from the public DTO.
        const headers = safeHeaders(response.headers); headers.set("content-type", "application/json"); return await completed(new Response(Buffer.from(nativeResponsesJson(bytes, ingress, requestedModel)), { status: response.status, headers }), false, new Response(bytes, { status: response.status, headers: response.headers }));
    }
    if (!await projectedReady(snapshot)) return await completed(jsonError(503, "The selected provider is not ready.", "provider_not_ready"));
    const headers = safeHeaders(request.headers); headers.set("authorization", `Bearer ${dependencies.cliproxyKey()}`); headers.delete("x-api-key");
    const normalized = transportPayload;
    const path = rewritePathModel(new URL(request.url).pathname, managedModel!);
    const isJson = request.headers.get("content-type")?.split(";", 1)[0].toLowerCase() === "application/json";
    if (isJson) headers.set("content-type", "application/json");
    const body = isJson ? JSON.stringify(normalized) : rawBody ? Buffer.from(rawBody) : undefined;
    const response = await dependencies.fetch(cliProxyUrl(request, path), { method: request.method, headers, body, signal: request.signal, cache: "no-store", ...(body ? { duplex: "half" as const } : {}) } as RequestInit & { duplex?: "half" });
    // Keep accounting admission metadata until gateway-http has installed its
    // stream tee. gateway-http is the public boundary and strips it there.
    return await completed(response.ok ? response : await sanitizeFailure(response), Boolean(response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")));
  } catch {
    if (request.signal.aborted) return await completed(jsonError(499, "Request cancelled.", "request_cancelled"));
    return await completed(jsonError(502, "Upstream request failed.", "upstream_request_failed"));
  }
}

function terminal(response: Response): boolean { return response.headers.get("x-rawroute-combo-terminal") === "1"; }
export async function proxyGatewayInference(request: Request, workspaceId: string, gatewayKeyId: string): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer()); const json = request.headers.get("content-type")?.split(";", 1)[0].toLowerCase() === "application/json"; const payload = json ? bodyObject(bytes) : {};
  const pathModel = modelFromPath(new URL(request.url).pathname); const bodyModel = typeof payload?.model === "string" ? payload.model.trim() : "";
  if (new URL(request.url).pathname.startsWith("/v1beta/") && !pathModel) return jsonError(404, "Unknown Gemini gateway operation.", "model_not_found");
  if (pathModel && bodyModel && pathModel !== bodyModel) return jsonError(400, "The URL model and request model must match.", "model_not_found");
  const requestedModel = bodyModel || pathModel || "";
  if (!requestedModel || (json && !payload)) return jsonError(400, "A configured model is required.", "model_not_found");
  if (requestedModel.startsWith("codex/")) {
    try { await ensureCodexProvider(workspaceId); } catch { return jsonError(503, "Model resolver is temporarily unavailable.", "model_resolver_unavailable"); }
  }
  const requestId = crypto.randomUUID();
  let resolved: ResolvedRoute | undefined;
  try { resolved = await dependencies.resolve(workspaceId, requestedModel); } catch { return jsonError(503, "Model resolver is temporarily unavailable.", "model_resolver_unavailable"); }
  if (!resolved) return jsonError(400, `Model ${requestedModel} is not configured or is unavailable.`, "model_not_found");
  if (resolved.kind !== "combo") return await executeOne(request, workspaceId, gatewayKeyId, requestId, requestedModel, payload!, resolved, undefined, bytes);
  const comboAdmission = await dependencies.hooks.beforeRequestedCombo?.({ requestId, workspaceId, gatewayKeyId, requestedModel });
  if (comboAdmission) return publicResponse(comboAdmission);
  let last: Response | undefined;
  for (const member of resolved.combo!.members.sort((a, b) => a.position - b.position)) {
    if (request.signal.aborted) return jsonError(499, "Request cancelled.", "request_cancelled");
    let target: ResolvedRoute | undefined;
    try { target = await dependencies.resolve(workspaceId, member.target); } catch { return jsonError(503, "Model resolver is temporarily unavailable.", "model_resolver_unavailable"); }
    if (!target || target.kind === "combo") continue;
    const response = await executeOne(request, workspaceId, gatewayKeyId, requestId, requestedModel, { ...payload!, model: member.target }, target, member, bytes);
    if (response.ok || terminal(response)) return response;
    void last?.body?.cancel().catch(() => undefined); last = response;
  }
  return last ?? jsonError(503, "No combo models are available.", "provider_unavailable");
}
export type ComboPolicyProbeResult = { status: "verified" | "unverified" | "invalid"; httpStatus?: number; message: string; policyHash: string; confirmation?: string };
async function drainProbeResponse(response: Response): Promise<void> {
  const attemptId = response.headers.get("x-rawroute-accounting-attempt"); const nativeOriginal = response.headers.get("x-rawroute-accounting-original-monitored") === "1";
  try {
    if (!response.body) return;
    if (attemptId && nativeOriginal) {
      const reader = response.body.getReader();
      try { await Promise.allSettled([waitForNativeAccountingMonitor(attemptId), (async () => { while (!(await reader.read()).done) { /* drain translated probe bytes */ } })()]); } finally { reader.releaseLock(); }
    } else if (attemptId) await dependencies.hooks.onStream?.(attemptId, response.body);
    else { const reader = response.body.getReader(); try { while (!(await reader.read()).done) { /* drain probe bytes */ } } finally { reader.releaseLock(); } }
  } finally { if (attemptId) releaseSharedOwnerAdmission(attemptId); }
}
/** A real, bounded streaming upstream probe for an already persisted member policy. */
export async function testComboMemberPolicy(workspaceId: string, comboId: string, memberId: string): Promise<ComboPolicyProbeResult> {
  const lifecycle = beginProbeLifecycle(); if (!lifecycle) return { status: "unverified", message: "Gateway is shutting down.", policyHash: "" };
  let draining = false;
  try {
  const routing = await listRouting(workspaceId); const combo = routing.combos.find((item) => item.id === comboId); const member = combo?.members.find((item) => item.id === memberId);
  if (!combo || !member) throw new Error("Combo member not found.");
  if (member.reasoning.mode === "override") {
    const target = await dependencies.resolve(workspaceId, member.target);
    const capability = target?.model?.reasoningCapability;
    if (reasoningCapabilityError(member.reasoning, capability)) {
      await setRoutingComboMemberValidation(workspaceId, comboId, memberId, member.policyHash, "invalid");
      return { status: "invalid", message: "This model does not accept the configured reasoning effort.", policyHash: member.policyHash };
    }
  }
  const request = new Request("http://rawroute.internal/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ model: member.target, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 8, stream: true }), signal: lifecycle.signal });
  let response: Response;
  try {
    const target = await dependencies.resolve(workspaceId, member.target);
    if (!target || target.kind === "combo") response = jsonError(400, "Model is unavailable.", "model_not_found");
    else response = await executeOne(request, workspaceId, "policy-probe", crypto.randomUUID(), member.target, { model: member.target, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 8, stream: true }, target, member);
  } catch { response = jsonError(503, "Upstream policy test could not be completed.", "provider_unavailable"); }
  const status = response.status; lifecycle.setAttemptId(response.headers.get("x-rawroute-accounting-attempt")); draining = true; void drainProbeResponse(response).catch(() => undefined).finally(lifecycle.finish);
  const outcome: ComboPolicyProbeResult["status"] = response.ok ? "verified" : [400, 404, 422].includes(status) ? "invalid" : "unverified";
  await setRoutingComboMemberValidation(workspaceId, comboId, memberId, member.policyHash, outcome);
  return { status: outcome, ...(status ? { httpStatus: status } : {}), message: outcome === "verified" ? "Upstream accepted the streaming member policy." : outcome === "invalid" ? "The upstream rejected this member policy." : "The upstream could not verify this member policy.", policyHash: member.policyHash };
  } finally { if (!draining) lifecycle.finish(); }
}
/** Draft counterpart used before persistence: it never writes routing state. */
export async function testComboMemberPolicyDraft(workspaceId: string, member: Pick<RoutingComboMember, "target" | "reasoning" | "customPayload" | "policyHash">): Promise<ComboPolicyProbeResult> {
  const lifecycle = beginProbeLifecycle(); if (!lifecycle) return { status: "unverified", message: "Gateway is shutting down.", policyHash: member.policyHash };
  let draining = false;
  try {
  const canonicalHash = memberPolicyConfigHash(member);
  const draft: RoutingComboMember = { id: "draft", target: member.target, position: 0, reasoning: member.reasoning, ...(member.customPayload ? { customPayload: member.customPayload } : {}), policyHash: canonicalHash, validationState: "not-tested", validationAt: null };
  const request = new Request("http://rawroute.internal/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ model: draft.target, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 8, stream: true }), signal: lifecycle.signal });
  try {
    const target = await dependencies.resolve(workspaceId, draft.target);
    if (!target || target.kind === "combo") return { status: "invalid", httpStatus: 400, message: "Model is unavailable.", policyHash: draft.policyHash };
    const capabilityError = reasoningCapabilityError(draft.reasoning, target.model?.reasoningCapability);
    if (capabilityError) return { status: "invalid", httpStatus: 422, message: capabilityError, policyHash: draft.policyHash };
    const response = await executeOne(request, workspaceId, "policy-probe", crypto.randomUUID(), draft.target, { model: draft.target, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 8, stream: true }, target, draft);
    const status = response.status; lifecycle.setAttemptId(response.headers.get("x-rawroute-accounting-attempt")); draining = true; void drainProbeResponse(response).catch(() => undefined).finally(lifecycle.finish);
    return { status: response.ok ? "verified" : [400, 404, 422].includes(status) ? "invalid" : "unverified", httpStatus: status, message: response.ok ? "Upstream accepted the streaming member policy." : [400, 404, 422].includes(status) ? "The upstream rejected this member policy." : "The upstream could not verify this member policy.", policyHash: draft.policyHash };
  } catch { return { status: "unverified", message: "The upstream could not verify this member policy.", policyHash: draft.policyHash }; }
  } finally { if (!draining) lifecycle.finish(); }
}
export async function proxyGatewayCatalog(workspaceId: string): Promise<Response> { return Response.json({ object: "list", data: await dependencies.catalog(workspaceId) }, { headers: { "cache-control": "no-store" } }); }
/** Called by gateway-http's owned stream tee; no browser-facing state crosses this seam. */
export async function monitorGatewayAccountingStream(attemptId: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> { await dependencies.hooks.onStream?.(attemptId, stream, signal); }
/** The native provider monitor owns the unmodified upstream tee. Gateway HTTP
 * awaits it before releasing its workspace admission during stream shutdown. */
export async function waitForNativeAccountingMonitor(attemptId: string): Promise<void> { await nativeAccountingMonitors.get(attemptId); }
export async function proxyGatewayGeneric(request: Request): Promise<Response> {
  try { if (!(await dependencies.getStatus()).healthy) return jsonError(503, "CLIProxy is unavailable.", "provider_not_ready"); const headers = safeHeaders(request.headers); headers.set("authorization", `Bearer ${dependencies.cliproxyKey()}`); headers.delete("x-api-key"); const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body; const response = await dependencies.fetch(cliProxyUrl(request), { method: request.method, headers, body, signal: request.signal, cache: "no-store", ...(body ? { duplex: "half" as const } : {}) } as RequestInit & { duplex?: "half" }); return response.ok ? publicResponse(response) : await sanitizeFailure(response); } catch { return jsonError(502, "Upstream request failed.", "upstream_request_failed"); }
}
export { ingressForPath, isCatalogPath, isInference, jsonError, publicResponse };
export type { GatewayIngress } from "./gateway-protocol";
