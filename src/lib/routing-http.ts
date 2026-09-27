import type { BunRequest } from "bun";
import { createRoutingAlias, createRoutingCombo, deleteRoutingAlias, deleteRoutingCombo, issueUnverifiedPolicyConfirmation, listRouting, RoutingError, updateRoutingAlias, updateRoutingCombo } from "./routing";
import { RequestScopeError, requireWorkspaceRequestScope, runWithWorkspaceScope } from "./request-scope";
import { admitWorkspaceWrite } from "./workspaces";
import { testComboMemberPolicy, testComboMemberPolicyDraft } from "./gateway-runtime";
import { memberPolicyConfigHash, normalizeComboCustomPayload, normalizeReasoning } from "./combo-reasoning";

const MAX_BODY_BYTES = 32 * 1024;
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function failure(error: unknown): Response {
  if (error instanceof RoutingError || error instanceof RequestScopeError) return json({ error: error.message }, error.status);
  console.error("Routing request failed."); return json({ error: "Routing is temporarily unavailable." }, 503);
}
async function body(request: BunRequest, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RoutingError("Content-Type must be application/json.", 415);
  const contentLength = request.headers.get("content-length"); if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) throw new RoutingError("Request body is invalid or too large.");
  const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > MAX_BODY_BYTES) throw new RoutingError("Request body is invalid or too large.");
  let result: unknown; try { result = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RoutingError("Request body must be valid JSON."); }
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some((key) => !allowed.includes(key))) throw new RoutingError("Request body is invalid.");
  return result as Record<string, unknown>;
}
function pathId(request: BunRequest, kind: "aliases" | "combos"): string {
  const prefix = `/api/routing/${kind}/`; const path = new URL(request.url).pathname;
  if (!path.startsWith(prefix)) throw new RoutingError(`${kind === "aliases" ? "Alias" : "Combo"} not found.`, 404);
  const value = path.slice(prefix.length); if (!value || value.includes("/")) throw new RoutingError(`${kind === "aliases" ? "Alias" : "Combo"} not found.`, 404);
  try { return decodeURIComponent(value); } catch { throw new RoutingError(`${kind === "aliases" ? "Alias" : "Combo"} not found.`, 404); }
}
async function scoped(request: BunRequest, mutate: boolean, action: (workspaceId: string) => Promise<Response>): Promise<Response> {
  try { const scope = await requireWorkspaceRequestScope(request, { mutate }); return await runWithWorkspaceScope(scope, () => action(scope.workspace.id)); } catch (error) { return failure(error); }
}
async function admitted(workspaceId: string, action: () => Promise<Response>): Promise<Response> {
  const admission = await admitWorkspaceWrite(workspaceId); if (!admission) return json({ error: "Workspace is unavailable." }, 409);
  try { return await action(); } finally { admission.release(); }
}
export function getRouting(request: BunRequest): Promise<Response> { return scoped(request, false, async (workspaceId) => json(await listRouting(workspaceId))); }
export function postRoutingAlias(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => { const input = await body(request, ["alias", "targetModelId", "shareId"]); return json({ alias: await createRoutingAlias(workspaceId, { alias: input.alias, targetModelId: input.targetModelId, shareId: input.shareId }) }, 201); })); }
export function patchRoutingAlias(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => { const input = await body(request, ["alias", "targetModelId", "shareId"]); return json({ alias: await updateRoutingAlias(workspaceId, pathId(request, "aliases"), input) }); })); }
export function deleteRoutingAliasHttp(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => { await deleteRoutingAlias(workspaceId, pathId(request, "aliases")); return json({ deleted: true }); })); }
export function postRoutingCombo(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => { const input = await body(request, ["combo", "name", "members"]); return json({ combo: await createRoutingCombo(workspaceId, { combo: input.combo, name: input.name, members: input.members }) }, 201); })); }
export function patchRoutingCombo(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => json({ combo: await updateRoutingCombo(workspaceId, pathId(request, "combos"), await body(request, ["combo", "name", "members"])) }))); }
export function deleteRoutingComboHttp(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => { await deleteRoutingCombo(workspaceId, pathId(request, "combos")); return json({ deleted: true }); })); }
/** Execution is intentionally not available in this slice. This signs only a five-minute acknowledgement of an unverified policy, never a successful upstream probe. */
export function postRoutingComboConfirmation(_request: BunRequest): Promise<Response> { return Promise.resolve(json({ error: "Policy confirmations are issued only by a real upstream test." }, 410)); }
/** Runs the real bounded upstream probe; only a safe outcome and config hash are persisted. */
export function postRoutingComboTest(request: BunRequest): Promise<Response> { return scoped(request, true, async (workspaceId) => admitted(workspaceId, async () => { const input = await body(request, ["comboId", "memberId", "target", "reasoning", "customPayload", "policyHash"]); try { const probe = await (typeof input.comboId === "string" && typeof input.memberId === "string" ? testComboMemberPolicy(workspaceId, input.comboId, input.memberId) : typeof input.target === "string" ? (() => { const reasoning = normalizeReasoning(input.reasoning); const customPayload = normalizeComboCustomPayload(input.customPayload); return testComboMemberPolicyDraft(workspaceId, { target: input.target, reasoning, ...(customPayload ? { customPayload } : {}), policyHash: memberPolicyConfigHash({ target: input.target, reasoning, customPayload }) }); })() : (() => { throw new RoutingError("Combo member is invalid."); })()); if (probe.status === "invalid") return json({ probe }, 422); return json({ probe, confirmation: issueUnverifiedPolicyConfirmation(probe.policyHash, workspaceId) }); } catch (error) { if (error instanceof RoutingError) throw error; throw new RoutingError("Combo member could not be tested.", 503); } })); }
