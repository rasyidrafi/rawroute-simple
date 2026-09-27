/**
 * The financial matrix is deliberately a companion to e2e.ts: it receives the
 * live compiled-app harness instead of starting a second server or copying the
 * authentication/browser cleanup machinery.  Browser actions create the
 * administration state; HTTP only reads opaque IDs or exercises the public
 * gateway.
 */
type RequestOptions = { method?: string; body?: unknown; workspace?: string };
type Request = <T>(origin: string, cookie: string | undefined, pathname: string, options?: RequestOptions) => Promise<{ status: number; body: T; headers: Headers }>;
type UpstreamRequest = { path: string; authorization: string | null; body: unknown };
type LedgerEvent = { attemptId: string; keyId: string; modelId: string; completedAt: number; status: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number; inputKnown: boolean; outputKnown: boolean; cacheReadKnown: boolean; cacheCreationKnown: boolean; costMicros: number; confidence: string; costSource: string | null; priceGroupId: string | null; priceVersionId: string | null; priceTier: string | null };
type Summary = { requests: number; tokens: number; costMicros: number; exactRequests: number; assumedRequests: number; unpricedRequests: number };
type PricingRates = { inputMicrosPerMillion: number; outputMicrosPerMillion: number; cacheReadMicrosPerMillion: number; cacheCreationMicrosPerMillion: number };
type PricingVersion = PricingRates & { id: string; version: number; tiers: Array<PricingRates & { thresholdTokens: number }> };
type PricingGroup = { id: string; name: string; kind: "fixed" | "custom"; canonical: { id: string; rates: PricingRates } | null; models: string[]; versions: PricingVersion[] };
type PricingData = { groups: PricingGroup[]; models: Array<{ id: string; gatewayModelId: string }>; jobs: Array<{ id: string; groupId: string; versionId: string; state: string; processed: number; total: number; error: string | null }> };
type RoutingMember = { id: string; target: string; policyHash: string; validationState: string; reasoning: { mode: string; effort?: string }; customPayload?: Record<string, unknown> };
type RoutingData = { combos: Array<{ id: string; combo: string; members: RoutingMember[] }> };

export type FinancialResult = { summary: { summary: Summary }; ledger: LedgerEvent[]; pricing: { groupId: string; models: string[]; version: PricingVersion; jobId: string } };

export type FinancialHarness = {
  origin: string;
  cookie: string;
  workspaceId: string;
  key: { id: string; secret: string };
  transportKey: { id: string; secret: string };
  nativeModel: { id: string; gatewayModelId: string };
  request: Request;
  browser: (...args: string[]) => string;
  check: (condition: unknown, message: string) => asserts condition;
  eventually: (operation: () => Promise<boolean>, description: string, timeout?: number) => Promise<void>;
  upstreamRequests: UpstreamRequest[];
  upstreamAbortCount: () => number;
  usageEventsAfter: (workspaceId: string, keyId: string, after: number) => Promise<LedgerEvent[]>;
  usageLedger: (workspaceId: string) => Promise<LedgerEvent[]>;
};

const json = (body: unknown) => JSON.stringify(body);
const gatewayHeaders = (secret: string) => ({ authorization: `Bearer ${secret}`, "content-type": "application/json" });

// Deliberately independent of src/lib/accounting.ts: this is the fixture's
// published replacement tariff, used to detect a pricing-engine regression.
const replacementTariff = {
  rates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 3_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 },
  tiers: [
    { thresholdTokens: 10, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 6_000_000, cacheReadMicrosPerMillion: 7_000_000, cacheCreationMicrosPerMillion: 8_000_000 },
    { thresholdTokens: 32_000, inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 3_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 },
  ],
} as const;

function independentlyRepriced(event: LedgerEvent): { costMicros: number; confidence: string; tier: string | null; repriced: boolean } {
  // The job skips mirrors, failed records, and partial/missing token records.
  // Their prior conservative or unpriced result is itself the expectation.
  if (event.costSource === "shared-owner-mirror" || event.status < 200 || event.status >= 300 || !event.inputKnown || !event.outputKnown) return { costMicros: event.costMicros, confidence: event.confidence, tier: null, repriced: false };
  let selected = replacementTariff.rates;
  let tier: string | null = "standard";
  for (const candidate of replacementTariff.tiers) if (event.inputTokens >= candidate.thresholdTokens) { selected = candidate; tier = `context-${candidate.thresholdTokens}`; }
  const cacheRead = event.cacheReadKnown ? event.cacheReadTokens : 0;
  const cacheCreation = event.cacheCreationKnown ? event.cacheCreationTokens : 0;
  const billableInput = Math.max(0, event.inputTokens - cacheRead - cacheCreation);
  const costMicros = Math.round((billableInput * selected.inputMicrosPerMillion + event.outputTokens * selected.outputMicrosPerMillion + cacheRead * selected.cacheReadMicrosPerMillion + cacheCreation * selected.cacheCreationMicrosPerMillion) / 1_000_000);
  const calculatedConfidence = event.cacheReadKnown || selected.cacheReadMicrosPerMillion === 0 ? event.cacheCreationKnown || selected.cacheCreationMicrosPerMillion === 0 ? "exact" : "assumed" : "assumed";
  return { costMicros, confidence: event.confidence === "assumed" ? "assumed" : calculatedConfidence, tier, repriced: true };
}

function button(h: FinancialHarness, name: string) { h.browser("find", "role", "button", "click", "--name", name); }
function body(h: FinancialHarness) { return h.browser("get", "text", "body"); }
function dialogComboValues(h: FinancialHarness): string[] { return JSON.parse(JSON.parse(h.browser("eval", "JSON.stringify(Array.from(document.querySelectorAll('[role=dialog] [role=combobox]')).map((item) => item.textContent?.trim()))"))) as string[]; }
function saveRouteDialog(h: FinancialHarness) { h.browser("eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Save')?.click()"); }
function setDialogTextarea(h: FinancialHarness, index: number, value: string) { h.browser("eval", `(() => { const input = Array.from(document.querySelectorAll('[role=dialog] textarea')).at(${index}); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; if (!(input instanceof HTMLTextAreaElement) || !set) throw new Error('combo custom-payload control unavailable'); set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`); }

async function browserRoutingCrud(h: FinancialHarness) {
  h.browser("open", `${h.origin}/dashboard/ai/routing`);
  h.browser("wait", "--text", "Aliases");
  // Read only the reopened member controls. The table/background text is not a
  // reliable assertion of editor order.
  button(h, "Edit browser-combo");
  h.browser("wait", "#combo-id");
  const originalOrder = dialogComboValues(h);
  h.check(originalOrder[0]?.startsWith("browser/chat") && originalOrder[2]?.startsWith("browser/backup"), `combo editor did not reopen the saved chat→backup controls: ${JSON.stringify(originalOrder)}`);
  button(h, "Move member 2 up");
  saveRouteDialog(h);
  await Bun.sleep(250);
  button(h, "Edit browser-combo");
  h.browser("wait", "#combo-id");
  const persistedOrder = dialogComboValues(h);
  h.check(persistedOrder[0]?.startsWith("browser/backup") && persistedOrder[2]?.startsWith("browser/chat"), `combo edit did not persist the reordered member controls: ${JSON.stringify(persistedOrder)}`);
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent === 'Cancel')?.click()");

  // Configure the first member through the real editor. Saving a changed
  // policy performs one real, bounded upstream probe before it can persist.
  button(h, "Edit browser-combo");
  h.browser("wait", "#combo-id");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] [role=combobox]')).at(1)?.click()");
  h.browser("find", "role", "option", "click", "--name", "Override");
  h.browser("wait", "input[id^='effort-']");
  h.browser("fill", "input[id^='effort-']", "low");
  setDialogTextarea(h, 0, '{"extra_body":{"temperature":0.2}}');
  saveRouteDialog(h);
  h.browser("wait", "--text", "Save unverified policy?");
  button(h, "Confirm");
  // Saving records the confirmation as unverified. Test the persisted member
  // after a reload and capture this fresh strict probe, not an old state.
  await Bun.sleep(250);
  h.browser("reload");
  h.browser("wait", "--text", "browser-combo");
  const policyProbeAt = h.upstreamRequests.length;
  button(h, "Test");
  const editedPolicyHash = JSON.stringify(["browser/backup", "override", "low", { extra_body: { temperature: 0.2 } }]);
  let persistedPolicy: RoutingMember | undefined;
  try { await h.eventually(async () => {
    const routing = await h.request<RoutingData>(h.origin, h.cookie, "/api/routing", { workspace: h.workspaceId });
    const member = routing.body.combos.find((combo) => combo.combo === "browser-combo")?.members.find((item) => item.target === "browser/backup");
    persistedPolicy = member;
    return routing.status === 200 && member?.policyHash === editedPolicyHash && member.validationState === "verified";
  }, "verified persisted policy for the edited hash"); } catch (error) { throw new Error(`${String(error)}: ${JSON.stringify({ editedPolicyHash, persistedPolicy, probes: h.upstreamRequests.slice(policyProbeAt) })}`); }
  const policyProbe = h.upstreamRequests.slice(policyProbeAt);
  h.check(policyProbe.length === 1, `saving one changed policy issued an unexpected number of probes: ${JSON.stringify(policyProbe)}`);
  const policyProbeWire = policyProbe[0]?.body as Record<string, unknown>;
  h.check(policyProbeWire.model === "fixture-backup" && policyProbeWire.max_output_tokens === 8 && (policyProbeWire.reasoning as { effort?: unknown } | undefined)?.effort === "low" && ((policyProbeWire.extra_body as { temperature?: unknown } | undefined)?.temperature === 0.2), `changed policy did not issue the expected bounded strict probe: ${JSON.stringify(policyProbeWire)}`);

  // Protected top-level fields must be rejected in the browser before either a
  // probe request or a persistence mutation can escape the editor.
  const beforeRejectedPolicy = await h.request<RoutingData>(h.origin, h.cookie, "/api/routing", { workspace: h.workspaceId });
  h.check(beforeRejectedPolicy.status === 200, "could not capture routing state before protected payload rejection");
  const rejectedProbeAt = h.upstreamRequests.length;
  button(h, "Edit browser-combo");
  h.browser("wait", "#combo-id");
  setDialogTextarea(h, 0, '{"model":"must-not-escape"}');
  saveRouteDialog(h);
  h.browser("wait", "--text", "Custom payload cannot override model.");
  const afterRejectedPolicy = await h.request<RoutingData>(h.origin, h.cookie, "/api/routing", { workspace: h.workspaceId });
  h.check(afterRejectedPolicy.status === 200 && JSON.stringify(afterRejectedPolicy.body.combos) === JSON.stringify(beforeRejectedPolicy.body.combos) && h.upstreamRequests.length === rejectedProbeAt, "protected custom JSON caused a probe or persisted despite browser rejection");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent === 'Cancel')?.click()");


  // Editing the alias through the browser makes its direct request the known
  // successful member, independent of ordering used by the fallback fixture.
  button(h, "Edit browser-alias");
  h.browser("wait", "#alias-id");
  h.browser("eval", "document.querySelector('[role=dialog] [role=combobox]')?.click()");
  h.browser("find", "role", "option", "click", "--name", "browser/chat");
  button(h, "Save");
  h.browser("wait", "--text", "browser/chat");

  button(h, "Add alias");
  h.browser("wait", "#alias-id");
  h.browser("fill", "#alias-id", "browser-alias-delete");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent === 'Create')?.click()");
  h.browser("wait", "--text", "browser-alias-delete");
  button(h, "Delete browser-alias-delete");
  button(h, "Confirm");
  await Bun.sleep(150);
  h.check(!body(h).includes("browser-alias-delete"), "browser alias deletion did not remove the local route");

  button(h, "Add combo");
  h.browser("wait", "#combo-id");
  h.browser("fill", "#combo-id", "browser-combo-delete");
  h.browser("fill", "#combo-name", "Disposable browser combo");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent === 'Create')?.click()");
  await Bun.sleep(150);
  if (body(h).includes("Save unverified policy?")) button(h, "Confirm");
  h.browser("wait", "--text", "browser-combo-delete");
  button(h, "Delete browser-combo-delete");
  button(h, "Confirm");
  await Bun.sleep(150);
  h.check(!body(h).includes("browser-combo-delete"), "browser combo deletion did not remove the local route");

}

async function browserPricingAndBudget(h: FinancialHarness) {
  h.browser("open", `${h.origin}/dashboard/ai/pricing`);
  h.browser("wait", "--text", "Model pricing");
  button(h, "New group");
  h.browser("wait", "#pricing-group-name");
  h.browser("fill", "#pricing-group-name", "Browser canonical disposable");
  h.browser("fill", "#canonical-search", "canonical fixture");
  h.browser("wait", "--text", "Canonical Fixture");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent?.includes('Canonical Fixture'))?.click()");
  // Selecting a model is a real UI operation; this avoids creating the group
  // through the management API and verifies the test-only catalog wiring.
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] label')).find((item) => item.textContent?.includes('browser/chat'))?.querySelector('button,input')?.click()");
  button(h, "Save group");
  h.browser("wait", "--text", "Browser canonical disposable");
  h.check(body(h).includes("models.dev · fixture/canonical"), "browser canonical pricing link was not rendered from the deterministic catalog");
  const canonicalPricing = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
  const canonicalGroup = canonicalPricing.body.groups.find((group) => group.name === "Browser canonical disposable");
  const canonicalVersion = canonicalGroup?.versions.at(-1);
  const canonicalModel = canonicalPricing.body.models.find((model) => model.gatewayModelId === "browser/chat");
  h.check(canonicalPricing.status === 200 && canonicalGroup?.canonical?.id === "fixture/canonical" && canonicalGroup.models.length === 1 && canonicalGroup.models[0] === canonicalModel?.id && canonicalVersion?.version === 1 && canonicalVersion.inputMicrosPerMillion === 1_000_000 && canonicalVersion.outputMicrosPerMillion === 2_000_000 && canonicalVersion.cacheReadMicrosPerMillion === 250_000 && canonicalVersion.cacheCreationMicrosPerMillion === 500_000 && canonicalVersion.tiers.length === 0, `canonical browser selection did not persist the fixture rates as its first version: ${JSON.stringify(canonicalGroup)}`);
  const canonicalStartedAt = Date.now();
  const canonicalRequest = await gateway(h, "/v1/responses", { model: "browser/chat", input: "canonical fixture price" });
  h.check(canonicalRequest.status === 200, "canonical-priced browser model request failed");
  await h.eventually(async () => {
    const events = await h.usageEventsAfter(h.workspaceId, h.transportKey.id, canonicalStartedAt);
    return events.length === 1 && events[0]?.costMicros === 13 && events[0]?.confidence === "exact" && events[0]?.priceGroupId === canonicalGroup?.id && events[0]?.priceVersionId === canonicalVersion?.id;
  }, "exact canonical fixture cost for a new browser-selected request");

  // Fixed-group membership is derived by default, but explicit browser edits
  // must survive reload: exclude one member, then add the same member back.
  const fixedGroup = canonicalPricing.body.groups.find((group) => group.kind === "fixed" && group.models.includes(canonicalPricing.body.models.find((model) => model.gatewayModelId === "browser/backup")?.id ?? ""));
  const fixedMember = canonicalPricing.body.models.find((model) => model.gatewayModelId === "browser/backup");
  h.check(Boolean(fixedGroup && fixedMember), "browser backup fixed pricing group was unavailable for membership persistence");
  const openFixedMembers = () => h.browser("eval", `Array.from(document.querySelectorAll('tr')).find((row) => row.textContent?.includes(${JSON.stringify(fixedGroup!.name)}) && row.textContent?.includes('fixed'))?.querySelector('button')?.click()`);
  openFixedMembers();
  h.browser("wait", "#pricing-group-name");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] label')).find((item) => item.textContent?.includes('browser/backup'))?.querySelector('button,input')?.click()");
  button(h, "Save group");
  h.browser("reload");
  h.browser("wait", "--text", "Model pricing");
  const excludedFixed = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
  h.check(excludedFixed.status === 200 && !excludedFixed.body.groups.find((group) => group.id === fixedGroup!.id)?.models.includes(fixedMember!.id), "browser fixed-group exclusion did not survive reload");
  openFixedMembers();
  h.browser("wait", "#pricing-group-name");
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] label')).find((item) => item.textContent?.includes('browser/backup'))?.querySelector('button,input')?.click()");
  button(h, "Save group");
  h.browser("reload");
  h.browser("wait", "--text", "Model pricing");
  const restoredFixed = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
  h.check(restoredFixed.status === 200 && restoredFixed.body.groups.find((group) => group.id === fixedGroup!.id)?.models.includes(fixedMember!.id), "browser fixed-group add-back did not survive reload");

  h.browser("open", `${h.origin}/dashboard/ai/budgets`);
  h.browser("wait", "--text", "Gateway key budgets");
  button(h, "New budget");
  h.browser("wait", "#budget-usd");
  h.browser("eval", "document.querySelector('[role=dialog] [role=combobox]')?.click()");
  h.browser("wait", "--text", "browser-renamed-key");
  h.browser("find", "role", "option", "click", "--name", "browser-renamed-key");
  h.browser("fill", "#budget-usd", "0.01");
  button(h, "Save budget");
  h.browser("wait", "--text", "browser-renamed-key");
  h.check(body(h).includes("Active"), "browser-created budget was not active");
  button(h, "Delete browser-renamed-key");
  button(h, "Confirm");
  await Bun.sleep(150);
  h.check(!body(h).includes("browser-renamed-key"), "browser budget deletion did not persist");
}

async function gateway(h: FinancialHarness, path: string, value: unknown, key = h.transportKey) {
  const response = await fetch(`${h.origin}${path}`, { method: "POST", headers: gatewayHeaders(key.secret), body: json(value), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: await response.text() };
}

async function routingAndProtocolMatrix(h: FinancialHarness) {
  // This is an actual loopback HTTP client disconnect, not a manually aborted
  // server Request. The fake emits its first native SSE frame then pauses until
  // the compiled gateway cancels its upstream fetch.
  const abortStartedAt = Date.now();
  const beforeAbort = await h.request<{ summary: { requests: number; costMicros: number } }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId });
  const beforeAbortBudget = await h.request<{ budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(beforeAbort.status === 200 && beforeAbortBudget.status === 200, "abort regression preconditions were unavailable");
  const abortController = new AbortController();
  const abortResponse = await fetch(`${h.origin}/v1/responses`, { method: "POST", headers: gatewayHeaders(h.key.secret), body: json({ model: h.nativeModel.gatewayModelId, input: "e2e-client-abort", stream: true }), signal: abortController.signal });
  h.check(abortResponse.status === 200 && abortResponse.body, "client-abort fixture did not start a native SSE response");
  const abortReader = abortResponse.body.getReader();
  const first = await abortReader.read();
  h.check(!first.done && new TextDecoder().decode(first.value).includes("response.created"), "client-abort fixture did not deliver its first SSE frame");
  abortController.abort(new DOMException("E2E client cancelled stream", "AbortError"));
  try {
    await abortReader.cancel();
  } catch (error) {
    h.check(error instanceof DOMException && error.name === "AbortError", `client cancellation raised an unexpected error: ${String(error)}`);
  } finally {
    abortReader.releaseLock();
  }
  await h.eventually(async () => h.upstreamAbortCount() === 1, "upstream signal cancellation after the real client stream abort", 3_000);
  await h.eventually(async () => {
    const [usage, budget, events] = await Promise.all([
      h.request<{ summary: { requests: number; costMicros: number } }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId }),
      h.request<{ budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId }),
      h.usageEventsAfter(h.workspaceId, h.key.id, abortStartedAt),
    ]);
    const priorBudget = beforeAbortBudget.body.budgets.find((item) => item.keyId === h.key.id);
    const settledBudget = budget.body.budgets.find((item) => item.keyId === h.key.id);
    return usage.status === 200 && usage.body.summary.requests === beforeAbort.body.summary.requests + 1 && usage.body.summary.costMicros === beforeAbort.body.summary.costMicros
      && events.length === 1 && events[0]?.status === 499 && events[0]?.costMicros === 0
      && settledBudget?.reservedMicros === 0 && settledBudget?.spentMicros === priorBudget?.spentMicros;
  }, "one durable 499 client-abort settlement with no held or spent budget cost");
  const healthyAfterAbort = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "healthy after client abort" });
  h.check(healthyAfterAbort.status === 200 && healthyAfterAbort.text.includes("native e2e ok"), "compiled gateway did not remain healthy after client stream abort");
  console.log("financial assertion: native-client-abort-upstream-cancel-499-budget-release");

  const aliasAt = h.upstreamRequests.length;
  const alias = await gateway(h, "/v1/responses", { model: "browser-alias", input: "alias route" });
  h.check(alias.status === 200 && alias.text.includes("native e2e ok"), `local browser alias did not execute through the native gateway: ${alias.status} ${alias.text} ${JSON.stringify(h.upstreamRequests.at(-1))}`);
  h.check(h.upstreamRequests.length === aliasAt + 1 && (h.upstreamRequests.at(-1)?.body as Record<string, unknown>)?.model === "fixture-chat", "alias did not send the resolved model's strict native payload");

  const comboAt = h.upstreamRequests.length;
  const combo = await gateway(h, "/v1/responses", { model: "browser-combo", input: "ordered fallback" });
  h.check(combo.status === 200 && combo.text.includes("native e2e ok"), "combo did not fall through from the failed first member");
  const ordered = h.upstreamRequests.slice(comboAt).map((entry) => (entry.body as Record<string, unknown>)?.model);
  // Browser fixture intentionally has two ordered credentials. Both retry the
  // failing first member before the resolver advances to the saved next member.
  h.check(JSON.stringify(ordered) === JSON.stringify(["fixture-backup", "fixture-backup", "fixture-chat"]), `combo fallback order or normalized payload changed: ${JSON.stringify(ordered)}`);
  const policyWire = h.upstreamRequests.slice(comboAt)[0]?.body as { reasoning?: { effort?: unknown }; extra_body?: { temperature?: unknown } };
  h.check(policyWire.reasoning?.effort === "low" && policyWire.extra_body?.temperature === 0.2, `confirmed combo policy did not reach the strict native wire payload: ${JSON.stringify(policyWire)}`);

  const chat = await gateway(h, "/v1/chat/completions", { model: h.nativeModel.gatewayModelId, messages: [{ role: "user", content: "chat native" }], max_tokens: 12 });
  const chatPayload = JSON.parse(chat.text) as { choices?: Array<{ message?: { content?: string } }> };
  h.check(chat.status === 200 && chatPayload.choices?.[0]?.message?.content === "native e2e ok", "native Chat Completions translation failed");

  const anthropic = await gateway(h, "/v1/messages", { model: h.nativeModel.gatewayModelId, max_tokens: 12, system: "be precise", messages: [{ role: "user", content: "anthropic native" }], tools: [{ name: "weather", input_schema: { type: "object" } }] });
  const anthPayload = JSON.parse(anthropic.text) as { type?: string; content?: Array<{ type: string }> };
  h.check(anthropic.status === 200 && anthPayload.type === "message" && anthPayload.content?.[0]?.type === "text", "native Anthropic translation failed");
  const anthWire = h.upstreamRequests.at(-1)?.body as Record<string, unknown>;
  h.check(Array.isArray(anthWire.tools) && anthWire.instructions === "be precise", "Anthropic tools/system were not normalized onto the native wire payload");

  const chatStream = await gateway(h, "/v1/chat/completions", { model: h.nativeModel.gatewayModelId, messages: [{ role: "user", content: "chat stream" }], stream: true });
  h.check(chatStream.status === 200 && chatStream.text.includes("chat.completion.chunk") && chatStream.text.includes("[DONE]"), "multi-frame native SSE did not translate to Chat chunks");
  const anthStream = await gateway(h, "/v1/messages", { model: h.nativeModel.gatewayModelId, max_tokens: 8, messages: [{ role: "user", content: "anthropic stream" }], stream: true });
  h.check(anthStream.status === 200 && anthStream.text.includes("message_start") && anthStream.text.includes("message_stop"), "multi-frame native SSE did not translate to Anthropic events");

  const failed = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "e2e-upstream-failed" });
  h.check(failed.status === 502 && failed.text.includes("upstream_failed"), "native failed response was not surfaced as a terminal gateway error");
  const beforeStreamFailure = await h.request<{ summary: { requests: number; costMicros: number } }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId });
  const streamFailed = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "e2e-stream-failed", stream: true });
  h.check(streamFailed.status === 200 && streamFailed.text.includes("response.failed"), "native response.failed SSE was not preserved through Responses ingress");
  await h.eventually(async () => { const usage = await h.request<{ summary: { requests: number; costMicros: number } }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId }); return usage.status === 200 && usage.body.summary.requests === beforeStreamFailure.body.summary.requests + 1 && usage.body.summary.costMicros === beforeStreamFailure.body.summary.costMicros; }, "zero-cost single settlement for response.failed SSE");
  console.log("financial assertion: native-sse-failed-settles-once-zero-cost");
  const incompleteStartedAt = Date.now();
  const incompleteBudgetBefore = await h.request<{ budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  const incomplete = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "e2e-incomplete", stream: true }, h.key);
  h.check(incomplete.status === 200 && incomplete.text.includes("response.incomplete"), "native incomplete SSE was not forwarded for durable settlement");
  await h.eventually(async () => {
    const [events, budget] = await Promise.all([
      h.usageEventsAfter(h.workspaceId, h.key.id, incompleteStartedAt),
      h.request<{ budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId }),
    ]);
    const prior = incompleteBudgetBefore.body.budgets.find((item) => item.keyId === h.key.id);
    const settled = budget.body.budgets.find((item) => item.keyId === h.key.id);
    return incompleteBudgetBefore.status === 200 && budget.status === 200 && events.length === 1 && events[0]?.status === 200 && events[0]?.inputTokens === 3 && events[0]?.outputTokens === 5 && events[0]?.totalTokens === 8 && events[0]?.costMicros === 13 && events[0]?.confidence === "exact" && settled?.reservedMicros === 0 && settled?.spentMicros === (prior?.spentMicros ?? 0) + 13;
  }, "one exact incomplete SSE ledger settlement with its released budget hold");
  console.log("financial assertion: native-sse-incomplete-terminal-usage");
}

async function pricingBudgetAndUsageMatrix(h: FinancialHarness) {
  const before = await h.request<{ summary: Summary }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId });
  h.check(before.status === 200, "usage dashboard was unavailable before financial checks");

  // A new version changes only future settlements. The ordinary 3/5 response
  // is exactly 29 micros; the 15-token fixture crosses the context tier and
  // carries distinct cache read/write prices for an exact 112 micros.
  const pricing = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
  const group = pricing.body.groups.find((item) => item.name === "native rates");
  h.check(pricing.status === 200 && group, "native price group was not retained");
  const newVersion = await h.request<{ jobId?: string }>(h.origin, h.cookie, "/api/model-pricing/versions", { method: "POST", workspace: h.workspaceId, body: { groupId: group!.id, mode: "new", rates: { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 4_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, tiers: [{ thresholdTokens: 10, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 6_000_000, cacheReadMicrosPerMillion: 7_000_000, cacheCreationMicrosPerMillion: 8_000_000 }] } });
  h.check(newVersion.status === 200 && !newVersion.body.jobId, "new pricing version should not reprice historical rows");
  const priced = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "future price" });
  h.check(priced.status === 200, "future request was not admitted under the new price version");
  const tiered = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "e2e-tiered-price" });
  h.check(tiered.status === 200, "tiered future request was not admitted under the new price version");
  let settled: { summary: Summary } | undefined;
  await h.eventually(async () => {
    const usage = await h.request<{ summary: Summary; keys: Array<{ name?: string }>; models: Array<{ name?: string }> }>(h.origin, h.cookie, "/api/usage?preset=all&granularity=daily", { workspace: h.workspaceId });
    if (usage.status !== 200) return false;
    h.check(usage.body.summary.requests === before.body.summary.requests + 2 && usage.body.summary.tokens === before.body.summary.tokens + 28 && usage.body.summary.costMicros === before.body.summary.costMicros + 141 && usage.body.summary.exactRequests === before.body.summary.exactRequests + 2, `future pricing did not preserve the old ledger and settle the isolated 29+112 micro events exactly: ${JSON.stringify({ before: before.body.summary, after: usage.body.summary })}`);
    h.check(usage.body.keys.some((item) => item.name === "native E2E") && usage.body.models.some((item) => item.name === "Native test"), "usage rows did not resolve named keys/models");
    settled = usage.body;
    return true;
  }, "settled future price version");

  const replacementBefore = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
  const versionBefore = replacementBefore.body.groups.find((item) => item.id === group!.id)?.versions[0];
  const jobIdsBefore = new Set(replacementBefore.body.jobs.map((job) => job.id));
  const ledgerBeforeReplacement = await h.usageLedger(h.workspaceId);
  const budgetBeforeReplacement = await h.request<{ window: { startAt: number; endAt: number }; budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(replacementBefore.status === 200 && versionBefore && budgetBeforeReplacement.status === 200, "could not snapshot the version, jobs, ledger, and budget before browser replacement");

  // The replacement path is intentionally driven in the browser. It changes
  // all four base rates, adds a distinct context tier, and starts the durable
  // job; no management API provisions this version.
  h.browser("open", `${h.origin}/dashboard/ai/pricing`);
  h.browser("wait", "--text", "native rates");
  h.browser("eval", "Array.from(document.querySelectorAll('tr')).find((row) => row.textContent?.includes('native rates'))?.querySelectorAll('button')[1]?.click()");
  h.browser("wait", "--text", "Rates for native rates");
  h.browser("eval", `(() => { const values = [2000000,3000000,0,0]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; const inputs = Array.from(document.querySelectorAll('[role=dialog] input[type=number]')); if (!set || inputs.length < 4) throw new Error('base pricing controls unavailable'); values.forEach((value, index) => { const input = inputs[index]; if (!(input instanceof HTMLInputElement)) throw new Error('rate input unavailable'); set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }); })()`);
  button(h, "Add tier");
  h.browser("wait", "[aria-label='Tier 1 threshold']");
  h.browser("eval", `(() => { const values = [10,5000000,6000000,7000000,8000000]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; const inputs = Array.from(document.querySelectorAll('[role=dialog] input[type=number]')).slice(4); if (!set || inputs.length < 5) throw new Error('tier pricing controls unavailable'); values.forEach((value, index) => { const input = inputs[index]; if (!(input instanceof HTMLInputElement)) throw new Error('tier input unavailable'); set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }); })()`);
  h.browser("eval", "Array.from(document.querySelectorAll('[role=dialog] label')).find((item) => item.textContent?.includes('Replace historical pricing'))?.querySelector('button,input')?.click()");
  await Bun.sleep(100);
  h.browser("eval", "(() => { const action = Array.from(document.querySelectorAll('[role=dialog] button')).find((item) => item.textContent?.trim() === 'Replace and reprice'); if (!(action instanceof HTMLButtonElement)) throw new Error('replacement action was unavailable'); action.click(); })()");
  let replacement: { group: PricingGroup; version: PricingVersion; job: PricingData["jobs"][number] } | undefined;
  let replacementDetail: PricingData | undefined;
  try { await h.eventually(async () => {
    const detail = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
    replacementDetail = detail.body;
    const current = detail.body.groups.find((item) => item.id === group!.id);
    const version = current?.versions.find((item) => item.version === versionBefore!.version + 1);
    const job = detail.body.jobs.find((item) => !jobIdsBefore.has(item.id) && item.groupId === group!.id && item.versionId === version?.id);
    if (detail.status !== 200 || !current || !version || !job || job.total <= 0 || job.state !== "completed") return false;
    replacement = { group: current, version, job };
    return true;
  }, "the newly created non-empty browser replacement pricing job"); } catch (error) { throw new Error(`${String(error)}: ${JSON.stringify({ versionBefore, jobIdsBefore: [...jobIdsBefore], replacementDetail })}`); }
  h.check(replacement && replacement.version.inputMicrosPerMillion === 2_000_000 && replacement.version.outputMicrosPerMillion === 3_000_000 && replacement.version.cacheReadMicrosPerMillion === 0 && replacement.version.cacheCreationMicrosPerMillion === 0 && JSON.stringify(replacement.version.tiers) === JSON.stringify([{ thresholdTokens: 10, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 6_000_000, cacheReadMicrosPerMillion: 7_000_000, cacheCreationMicrosPerMillion: 8_000_000 }, { thresholdTokens: 32_000, inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 3_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }]), `browser replacement did not persist its pinned rates and cache tiers: ${JSON.stringify(replacement)}`);
  const repriced = await h.request<{ summary: Summary }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId });
  const ledgerAfterReplacement = await h.usageLedger(h.workspaceId);
  const budgetAfterReplacement = await h.request<{ window: { startAt: number; endAt: number }; budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  const replacementCandidates = ledgerBeforeReplacement.filter((event) => event.costSource !== "shared-owner-mirror" && (event.priceGroupId === group!.id || event.modelId === h.nativeModel.gatewayModelId));
  const expectedReplacement = new Map(replacementCandidates.map((event) => [event.attemptId, independentlyRepriced(event)]));
  const repricedAfter = ledgerAfterReplacement.filter((event) => expectedReplacement.has(event.attemptId));
  const expectedRepriceDelta = replacementCandidates.reduce((total, event) => total + expectedReplacement.get(event.attemptId)!.costMicros - event.costMicros, 0);
  const hKeyBudget = budgetAfterReplacement.body.budgets.find((item) => item.keyId === h.key.id);
  const expectedHKeyWindowSpend = ledgerAfterReplacement.filter((event) => event.keyId === h.key.id && event.status >= 200 && event.status < 300 && event.completedAt >= budgetAfterReplacement.body.window.startAt && event.completedAt < budgetAfterReplacement.body.window.endAt).reduce((sum, event) => sum + (expectedReplacement.get(event.attemptId)?.costMicros ?? event.costMicros), 0);
  h.check(Boolean(settled) && repriced.status === 200 && repriced.body.summary.requests === settled!.summary.requests && repriced.body.summary.tokens === settled!.summary.tokens && expectedRepriceDelta === 48 && repriced.body.summary.costMicros === settled!.summary.costMicros + expectedRepriceDelta && replacement!.job.total === replacementCandidates.length && repricedAfter.length === replacementCandidates.length && repricedAfter.every((event) => { const prior = ledgerBeforeReplacement.find((item) => item.attemptId === event.attemptId)!; const expected = expectedReplacement.get(event.attemptId)!; return event.inputTokens === prior.inputTokens && event.outputTokens === prior.outputTokens && event.cacheReadTokens === prior.cacheReadTokens && event.cacheCreationTokens === prior.cacheCreationTokens && event.totalTokens === prior.totalTokens && event.costMicros === expected.costMicros && event.confidence === expected.confidence && event.priceTier === expected.tier && event.priceVersionId === replacement!.version.id; }) && budgetAfterReplacement.status === 200 && hKeyBudget?.reservedMicros === 0 && hKeyBudget.spentMicros === expectedHKeyWindowSpend, `browser replacement did not match the independent fixture tariff per historical event or derive budget spend from it: ${JSON.stringify({ before: settled?.summary, after: repriced.body.summary, expectedRepriceDelta, replacementCandidates, repricedAfter, expectedReplacement: [...expectedReplacement], budgetBeforeReplacement: budgetBeforeReplacement.body, budgetAfterReplacement: budgetAfterReplacement.body, expectedHKeyWindowSpend })}`);
  console.log(`financial assertion: browser-reprice job=${replacement.job.id} total=${replacement.job.total} cost=${settled!.summary.costMicros}->${repriced.body.summary.costMicros}`);

  // Cut a precise current budget window after the historical traffic. The fake
  // then emits one incomplete-price record and one missing-usage record so the
  // browser confidence and selected-range/budget-window distinction are real.
  const budgetCut = Date.now();
  const cutWindow = await h.request(h.origin, h.cookie, "/api/budgets/window", { method: "PATCH", workspace: h.workspaceId, body: { startAt: budgetCut, endAt: budgetCut + 86_400_000 } });
  h.check(cutWindow.status === 200, "could not set the exact post-reprice budget window");
  const confidenceStartedAt = Date.now();
  const assumed = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "e2e-assumed" }, h.key);
  const missing = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "e2e-unpriced" }, h.key);
  const unpriced = await gateway(h, "/v1/responses", { model: "browser/backup", input: "unpriced model price" });
  h.check(assumed.status === 200 && missing.status === 200 && unpriced.status === 200, `fake missing-usage confidence fixtures were not admitted: ${JSON.stringify({ assumed, missing, unpriced })}`);
  let confidenceDiagnostic: unknown;
  try { await h.eventually(async () => {
    const [usage, nativeEvents, transportEvents] = await Promise.all([
      h.request<{ summary: Summary; keys: Array<{ id: string; costMicros: number; budget?: { spentMicros: number; reservedMicros: number } }> }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId }),
      h.usageEventsAfter(h.workspaceId, h.key.id, confidenceStartedAt),
      h.usageEventsAfter(h.workspaceId, h.transportKey.id, confidenceStartedAt),
    ]);
    const events = [...nativeEvents, ...transportEvents];
    if (usage.status !== 200 || events.length !== 3) { confidenceDiagnostic = { usage, events }; return false; }
    const expected = { requests: repriced.body.summary.requests + 3, tokens: repriced.body.summary.tokens + 28, costMicros: repriced.body.summary.costMicros + 126, exactRequests: repriced.body.summary.exactRequests, assumedRequests: repriced.body.summary.assumedRequests + 2, unpricedRequests: repriced.body.summary.unpricedRequests + 1 };
    const nativeKey = usage.body.keys.find((item) => item.id === h.key.id);
    if (JSON.stringify(usage.body.summary) !== JSON.stringify(expected) || !nativeKey || nativeKey.budget?.spentMicros !== 126 || nativeKey.budget.reservedMicros !== 0) { confidenceDiagnostic = { expected, usage: usage.body, events, nativeKey }; return false; }
    h.check(events.some((event) => event.confidence === "assumed" && event.totalTokens === 20 && event.costMicros === 105 && event.priceTier === "context-10") && events.some((event) => event.confidence === "assumed" && event.totalTokens === 0 && event.costMicros === 21) && events.some((event) => event.confidence === "unpriced" && event.totalTokens === 8 && event.costMicros === 0), `fake confidence fixtures did not create meaningful exact/assumed/unpriced ledger entries: ${JSON.stringify(events)}`);
    return true;
  }, "exact, assumed, and unpriced current confidence fixture settlements"); } catch (error) { throw new Error(`${String(error)}: ${JSON.stringify(confidenceDiagnostic)}`); }

  // An exhausted enabled key is rejected before any upstream transport. Then
  // Unlimited Mode (a browser-administered policy) admits the same request.
  const budget = await h.request(h.origin, h.cookie, "/api/budgets", { method: "POST", workspace: h.workspaceId, body: { keyId: h.key.id, limitMicros: 1, enabled: true } });
  h.check(budget.status === 200, "could not exhaust the native gateway key budget");

  // Toggle the existing exhausted budget in the rendered table. A disabled
  // budget must admit a real request; enabling it again must reject before the
  // fake transport observes a byte.
  h.browser("open", `${h.origin}/dashboard/ai/budgets`);
  h.browser("wait", "--text", "native E2E");
  h.browser("eval", "Array.from(document.querySelectorAll('tr')).find((row) => row.textContent?.includes('native E2E'))?.querySelector('[role=switch]')?.click()");
  await h.eventually(async () => { const detail = await h.request<{ budgets: Array<{ keyId: string; enabled: boolean }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId }); return detail.status === 200 && detail.body.budgets.some((item) => item.keyId === h.key.id && !item.enabled); }, "browser-disabled native budget");
  const disabledCalls = h.upstreamRequests.length;
  const disabled = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "disabled budget admits" }, h.key);
  h.check(disabled.status === 200 && h.upstreamRequests.length === disabledCalls + 1, "disabled browser budget did not admit a real request");
  h.browser("eval", "Array.from(document.querySelectorAll('tr')).find((row) => row.textContent?.includes('native E2E'))?.querySelector('[role=switch]')?.click()");
  await h.eventually(async () => { const detail = await h.request<{ budgets: Array<{ keyId: string; enabled: boolean }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId }); return detail.status === 200 && detail.body.budgets.some((item) => item.keyId === h.key.id && item.enabled); }, "browser-enabled native budget");
  const calls = h.upstreamRequests.length;
  const exhausted = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "must not reach upstream" }, h.key);
  h.check(exhausted.status === 429 && h.upstreamRequests.length === calls, "exhausted budget called upstream instead of rejecting admission");

  h.browser("wait", "--text", "Unlimited Mode");
  const inactive = await h.request<{ window: { unlimited: boolean }; history: Array<{ id: string }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(inactive.status === 200 && !inactive.body.window.unlimited, "exhausted budget did not begin from inactive Unlimited Mode");
  // Cancel is a real confirmation branch: no bypass session may be created.
  button(h, "Activate");
  h.browser("wait", "--text", "Activate Unlimited Mode?");
  button(h, "Cancel");
  const cancelledActivation = await h.request<{ window: { unlimited: boolean }; history: Array<{ id: string }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(cancelledActivation.status === 200 && !cancelledActivation.body.window.unlimited && cancelledActivation.body.history.length === inactive.body.history.length, "cancelled Unlimited activation mutated persisted state or audit history");
  button(h, "Activate");
  h.browser("wait", "--text", "Activate Unlimited Mode?");
  button(h, "Confirm");
  h.browser("wait", "--text", "Active");
  const active = await h.request<{ window: { unlimited: boolean; autoEnd: boolean; activeSessionId: string | null } }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(active.status === 200 && active.body.window.unlimited && active.body.window.activeSessionId, "confirmed Unlimited activation did not persist its session");
  // The label itself owns the Base UI checkbox activation. Toggle each way and
  // reload between writes: auto-end may change, but one audit session remains.
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('Auto-end at window boundary'))?.click()");
  await h.eventually(async () => { const value = await h.request<{ window: { autoEnd: boolean; activeSessionId: string | null } }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId }); return value.status === 200 && value.body.window.autoEnd !== active.body.window.autoEnd && value.body.window.activeSessionId === active.body.window.activeSessionId; }, "Unlimited auto-end browser toggle");
  h.browser("reload");
  h.browser("wait", "--text", "Unlimited Mode");
  const toggled = await h.request<{ window: { autoEnd: boolean; activeSessionId: string | null } }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(toggled.status === 200 && toggled.body.window.activeSessionId === active.body.window.activeSessionId, "auto-end toggle did not survive browser reload with its audit session");
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('Auto-end at window boundary'))?.click()");
  await h.eventually(async () => { const value = await h.request<{ window: { autoEnd: boolean; activeSessionId: string | null } }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId }); return value.status === 200 && value.body.window.autoEnd === active.body.window.autoEnd && value.body.window.activeSessionId === active.body.window.activeSessionId; }, "Unlimited auto-end browser toggle restore");
  console.log("financial assertion: unlimited-autoend-same-audit-session");

  // Requested-route exclusion is terminal and must not reach either combo
  // member. The same editor then excludes only the first member, allowing the
  // second member to execute as the fallback.
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('browser-combo'))?.click()");
  button(h, "Save exclusions");
  await Bun.sleep(250);
  const excludedCalls = h.upstreamRequests.length;
  const excludedCombo = await gateway(h, "/v1/responses", { model: "browser-combo", input: "requested combo excluded" });
  h.check(excludedCombo.status === 403 && h.upstreamRequests.length === excludedCalls, "requested combo exclusion did not reject before upstream routing");
  console.log("financial assertion: unlimited-requested-combo-no-upstream");
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('browser-combo'))?.click(); Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('browser/backup'))?.click()");
  button(h, "Save exclusions");
  await Bun.sleep(250);
  const memberExcludedAt = h.upstreamRequests.length;
  const memberExcluded = await gateway(h, "/v1/responses", { model: "browser-combo", input: "first member excluded" });
  const memberExcludedModels = h.upstreamRequests.slice(memberExcludedAt).map((entry) => (entry.body as Record<string, unknown>).model);
  h.check(memberExcluded.status === 200 && JSON.stringify(memberExcludedModels) === JSON.stringify(["fixture-chat"]), `excluded first combo member did not skip directly to the second member: ${JSON.stringify(memberExcludedModels)}`);
  console.log("financial assertion: unlimited-member-exclusion-skips-first");
  const unlimitedCalls = h.upstreamRequests.length;
  const unlimited = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "unlimited admission" }, h.key);
  h.check(unlimited.status === 200 && h.upstreamRequests.length === unlimitedCalls + 1, `browser-enabled Unlimited Mode did not admit an exhausted key: ${JSON.stringify({ status: unlimited.status, text: unlimited.text, calls: unlimitedCalls, actual: h.upstreamRequests.length })}`);
  h.browser("eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Deactivate')?.click()");
  h.browser("wait", "--text", "Deactivate Unlimited Mode?");
  button(h, "Cancel");
  const cancelledDeactivate = await h.request<{ window: { unlimited: boolean; activeSessionId: string | null } }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(cancelledDeactivate.status === 200 && cancelledDeactivate.body.window.unlimited && cancelledDeactivate.body.window.activeSessionId === active.body.window.activeSessionId, "cancelled Unlimited deactivation closed or replaced the active audit session");
  h.browser("eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Deactivate')?.click()");
  h.browser("wait", "--text", "Deactivate Unlimited Mode?");
  button(h, "Confirm");

  // API reads validate the persisted policy/window independently of React's
  // local state and cover the budget-range/current-window distinction.
  const detail = await h.request<{ window: { unlimited: boolean }; budgets: Array<{ keyId: string; enabled: boolean }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(detail.status === 200 && !detail.body.window.unlimited && detail.body.budgets.some((item) => item.keyId === h.key.id && item.enabled), "unlimited deactivate or exhausted budget persistence failed");

  // Beyond Limits is a browser-maintained allowlist applied at admission, not
  // an upstream fallback. Allow native/chat, prove it reaches the fake, then
  // remove it and prove the identical exhausted request is terminal again.
  h.browser("eval", "Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Beyond Limits')?.click()");
  h.browser("wait", "--text", "Enable selected routes after budget exhaustion");
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('Enable selected routes after budget exhaustion'))?.click()");
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('native/chat'))?.click()");
  button(h, "Save Beyond Limits");
  await Bun.sleep(250);
  const beyondAllowedAt = h.upstreamRequests.length;
  const beyondAllowed = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "beyond allowlisted" }, h.key);
  h.check(beyondAllowed.status === 200 && h.upstreamRequests.length === beyondAllowedAt + 1, "Beyond Limits allowlisted model was not admitted after exhaustion");
  h.browser("eval", "Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('native/chat'))?.click()");
  button(h, "Save Beyond Limits");
  await Bun.sleep(250);
  const beyondDeniedAt = h.upstreamRequests.length;
  const beyondDenied = await gateway(h, "/v1/responses", { model: h.nativeModel.gatewayModelId, input: "beyond no longer allowlisted" }, h.key);
  h.check(beyondDenied.status === 429 && h.upstreamRequests.length === beyondDeniedAt, "non-allowlisted Beyond Limits model did not reject before upstream");
  console.log("financial assertion: beyond-limits-allowlist-admission-and-terminal-denial");

  // Usage is checked after all traffic and through its real lazy browser page:
  // every sort, range, confidence total, and current-window value is rendered.
  const finalUsage = await h.request<{ timeZone: string; summary: Summary; keys: Array<{ id: string; name: string; requests: number; costMicros: number; lastUsedAt: number; budget?: { spentMicros: number; reservedMicros: number } }> }>(h.origin, h.cookie, "/api/usage?preset=all", { workspace: h.workspaceId });
  const finalBudget = await h.request<{ window: { startAt: number; endAt: number }; budgets: Array<{ keyId: string; spentMicros: number; reservedMicros: number }> }>(h.origin, h.cookie, "/api/budgets", { workspace: h.workspaceId });
  h.check(finalUsage.status === 200 && finalBudget.status === 200 && finalUsage.body.summary.exactRequests > 0 && finalUsage.body.summary.assumedRequests > 0 && finalUsage.body.summary.unpricedRequests > 0, `final usage confidence did not retain exact, assumed, and unpriced records: ${JSON.stringify(finalUsage.body.summary)}`);
  h.browser("open", `${h.origin}/dashboard/ai/usage`);
  h.browser("wait", "--text", "Usage dashboard");
  h.browser("click", "[aria-label='Range']");
  h.browser("find", "role", "option", "click", "--name", "All time");
  h.browser("wait", "--text", "native E2E");
  const renderedAll = body(h);
  const money = (value: number) => `$${(value / 1_000_000).toFixed(4)}`;
  h.check(renderedAll.includes("Pricing confidence") && renderedAll.includes(`${finalUsage.body.summary.exactRequests} exact · ${finalUsage.body.summary.assumedRequests} assumed · ${finalUsage.body.summary.unpricedRequests} unpriced`) && renderedAll.includes("Selected range cost") && renderedAll.includes(money(finalUsage.body.summary.costMicros)) && renderedAll.includes("Native test"), `usage browser did not render its exact selected-range labels and confidence values: ${JSON.stringify(finalUsage.body.summary)}`);
  h.browser("wait", "--text", "Usage by key");
  const browserKeyOrder = () => JSON.parse(JSON.parse(h.browser("eval", "(() => { const table = document.querySelectorAll('table')[0]; return JSON.stringify(table ? Array.from(table.querySelectorAll('tbody tr')).map((row) => row.querySelector('td .font-medium')?.textContent?.trim()) : []); })()"))) as string[];
  const expectedOrder = (sort: "name" | "recent" | "usage") => finalUsage.body.keys.slice().sort((left, right) => sort === "name" ? left.name.localeCompare(right.name) : sort === "recent" ? right.lastUsedAt - left.lastUsedAt : right.costMicros - left.costMicros || right.requests - left.requests).map((row) => row.name);
  for (const [sort, option] of [["name", "API key name"], ["recent", "Most recent first"], ["usage", "Highest usage first"]] as const) {
    h.browser("scroll", "down", "1200");
    h.browser("eval", "document.querySelector(\"[aria-label='Order rows by']\")?.click()");
    await Bun.sleep(100);
    h.browser("find", "role", "option", "click", "--name", option);
    h.check(JSON.stringify(browserKeyOrder()) === JSON.stringify(expectedOrder(sort)), `usage browser ${sort} sort order did not match the rendered key rows: ${JSON.stringify({ expected: expectedOrder(sort), actual: browserKeyOrder() })}`);
  }
  const nativeKey = finalUsage.body.keys.find((item) => item.id === h.key.id);
  const nativeBudget = finalBudget.body.budgets.find((item) => item.keyId === h.key.id);
  const nativeCells = JSON.parse(JSON.parse(h.browser("eval", "(() => { const table = document.querySelectorAll('table')[0]; const row = Array.from(table?.querySelectorAll('tbody tr') ?? []).find((item) => item.textContent?.includes('native E2E')); return JSON.stringify(row ? Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim()) : []); })()"))) as string[];
  h.check(Boolean(nativeKey && nativeBudget) && nativeCells[3] === money(nativeKey!.costMicros) && nativeCells[5]?.includes(`${money(nativeBudget!.spentMicros)} spent`), `usage browser did not keep selected-range cost separate from current budget-window spend: ${JSON.stringify({ nativeKey, nativeBudget, nativeCells })}`);

  const appDate = (time: number, offsetDays = 0) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: finalUsage.body.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return new Date(Date.UTC(value("year"), value("month") - 1, value("day") + offsetDays)).toISOString().slice(0, 10);
  };
  const today = appDate(Date.now()), yesterday = appDate(Date.now(), -1);
  const todayUsage = await h.request<{ summary: Summary }>(h.origin, h.cookie, `/api/usage?preset=custom&from=${today}&to=${today}`, { workspace: h.workspaceId });
  const yesterdayUsage = await h.request<{ summary: Summary }>(h.origin, h.cookie, `/api/usage?preset=custom&from=${yesterday}&to=${yesterday}`, { workspace: h.workspaceId });
  h.check(todayUsage.status === 200 && yesterdayUsage.status === 200 && todayUsage.body.summary.requests > yesterdayUsage.body.summary.requests, `custom usage date ranges did not produce different event counts: ${JSON.stringify({ summaryToday: todayUsage.body.summary, summaryYesterday: yesterdayUsage.body.summary, dateToday: today, dateYesterday: yesterday })}`);
  const setCustomDates = (from: string, to: string) => h.browser("eval", `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; for (const [selector, value] of [['#usage-from', ${JSON.stringify(from)}], ['#usage-to', ${JSON.stringify(to)}]]) { const input = document.querySelector(selector); if (!(input instanceof HTMLInputElement) || !set) throw new Error('custom usage date control unavailable'); set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  h.browser("eval", "window.scrollTo(0, 0)");
  h.browser("eval", "document.querySelector(\"[aria-label='Range']\")?.click()");
  await Bun.sleep(100);
  h.browser("find", "role", "option", "click", "--name", "Custom dates");
  await Bun.sleep(100);
  h.browser("wait", "#usage-from");
  setCustomDates(today, today);
  h.browser("wait", "--text", `${todayUsage.body.summary.exactRequests} exact · ${todayUsage.body.summary.assumedRequests} assumed · ${todayUsage.body.summary.unpricedRequests} unpriced`);
  setCustomDates(yesterday, yesterday);
  h.browser("wait", "--text", "No usage in this range.");
  h.check(body(h).includes("Custom") && body(h).includes("No usage in this range."), "usage browser custom date selection did not render the empty distinct range");

  const finalPricing = await h.request<PricingData>(h.origin, h.cookie, "/api/model-pricing", { workspace: h.workspaceId });
  const finalGroup = finalPricing.body.groups.find((item) => item.id === group!.id);
  const finalLedger = await h.usageLedger(h.workspaceId);
  h.check(finalPricing.status === 200 && finalGroup?.models.includes(h.nativeModel.id) && JSON.stringify(finalGroup.versions.find((item) => item.id === replacement!.version.id)) === JSON.stringify(replacement!.version), "current replacement group or pinned version changed before restart capture");
  return { summary: { summary: finalUsage.body.summary }, ledger: finalLedger, pricing: { groupId: group!.id, models: finalGroup!.models, version: replacement!.version, jobId: replacement!.job.id } };
}

export async function runFinancialMatrix(h: FinancialHarness): Promise<FinancialResult> {
  await browserRoutingCrud(h);
  await browserPricingAndBudget(h);
  await routingAndProtocolMatrix(h);
  return await pricingBudgetAndUsageMatrix(h);
}
