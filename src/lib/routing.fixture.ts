import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const databasePath = `/tmp/opencode/rawroute-routing-${crypto.randomUUID()}.db`;
Bun.env.NODE_ENV = "development";
Bun.env.DATABASE_URL = `file:${databasePath}`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-routing-data-${crypto.randomUUID()}`;

const { db } = await import("./db");
const workspaces = await import("./workspaces");
const providers = await import("./providers");
const routing = await import("./routing");
const reasoning = await import("./combo-reasoning");

beforeAll(async () => { await workspaces.ensureWorkspaceSchema(); await providers.ensureProviderSchema(); await routing.ensureRoutingSchema(); });
beforeEach(async () => {
  await db.batch([
    "DELETE FROM routing_combo_members", "DELETE FROM routing_combos", "DELETE FROM routing_aliases", "DELETE FROM provider_credentials", "DELETE FROM provider_models", "DELETE FROM providers", "DELETE FROM workspaces WHERE id <> 'default'",
  ], "write");
});
afterAll(async () => { await db.close(); });

async function models(workspaceId = "default") {
  const provider = await providers.createProvider(workspaceId, { name: "OpenAI", prefix: "openai", baseUrl: "https://example.test/v1", protocol: "openai-chat", enabled: true, supportPromptCacheKey: true });
  const first = await providers.createProviderModel(workspaceId, provider.id, { name: "One", gatewaySuffix: "one", upstreamModel: "upstream-one", enabled: true, reasoningCapability: { mode: "enabled", supportedEfforts: ["medium", "high"] } });
  const second = await providers.createProviderModel(workspaceId, provider.id, { name: "Two", gatewaySuffix: "two", upstreamModel: "upstream-two", enabled: true });
  return { provider, first, second };
}

test("persists aliases and ordered combos, builds an enabled-only catalog, and resolves exact alias then unique suffix", async () => {
  const { first, second } = await models();
  const alias = await routing.createRoutingAlias("default", { alias: "fast//one", targetModelId: first.gatewayModelId });
  const combo = await routing.createRoutingCombo("default", { combo: "reliable", name: "Reliable", members: [{ target: alias.alias }, { target: second.gatewayModelId }] });
  expect(alias.alias).toBe("fast/one");
  expect(combo.members.map((member) => member.target)).toEqual(["fast/one", second.gatewayModelId]);
  expect((await routing.resolveRoutingModel("default", "fast/one"))?.model?.id).toBe(first.gatewayModelId);
  expect((await routing.resolveRoutingModel("default", "one"))?.model?.id).toBe(first.gatewayModelId);
  expect((await routing.resolveRoutingModel("default", "reliable"))?.kind).toBe("combo");
  await providers.updateProviderModel("default", first.providerId, first.id, { enabled: false });
  expect(await routing.resolveRoutingModel("default", "fast/one")).toBeUndefined();
  expect((await import("./catalog")).buildCatalog((await routing.listRouting("default")).models, (await routing.listRouting("default")).aliases, (await routing.listRouting("default")).combos).map((entry) => entry.id)).not.toContain("fast/one");
});

test("rejects global public-ID collisions, cross-workspace targets, ambiguous suffixes, and unsafe policies", async () => {
  const { first, second } = await models();
  await routing.createRoutingAlias("default", { alias: "openai/friendly", targetModelId: first.gatewayModelId });
  await expect(providers.createProviderModel("default", first.providerId, { name: "Collision", gatewaySuffix: "friendly", upstreamModel: "x" })).rejects.toMatchObject({ status: 409 });
  await expect(routing.createRoutingCombo("default", { combo: "openai/friendly", name: "Collision", members: [{ target: first.gatewayModelId }, { target: second.gatewayModelId }] })).rejects.toMatchObject({ status: 409 });
  const other = await workspaces.createWorkspace("Other routing");
  await expect(routing.createRoutingAlias(other.id, { alias: "outside", targetModelId: first.gatewayModelId })).rejects.toMatchObject({ status: 400 });
  const otherProvider = await providers.createProvider("default", { name: "Other", prefix: "other", baseUrl: "https://other.test", protocol: "openai-chat" });
  await providers.createProviderModel("default", otherProvider.id, { name: "Same", gatewaySuffix: "one", upstreamModel: "same" });
  expect(await routing.resolveRoutingModel("default", "one")).toBeUndefined();
  await expect(routing.createRoutingCombo("default", { combo: "unsafe", name: "Unsafe", members: [{ target: first.gatewayModelId, customPayload: { model: "override" } }, { target: second.gatewayModelId }] })).rejects.toThrow("cannot override");
});

test("prefix and suffix changes preserve aliases and combo members by remapping stored targets", async () => {
  const { provider, first, second } = await models();
  const alias = await routing.createRoutingAlias("default", { alias: "stable", targetModelId: first.gatewayModelId });
  const combo = await routing.createRoutingCombo("default", { combo: "chain", name: "Chain", members: [{ target: alias.alias }, { target: second.gatewayModelId }] });
  await providers.updateProvider("default", provider.id, { prefix: "next" });
  let data = await routing.listRouting("default");
  expect(data.aliases.find((item) => item.id === alias.id)?.targetModelId).toBe("next/one");
  expect(data.combos.find((item) => item.id === combo.id)?.members[1]?.target).toBe("next/two");
  await providers.updateProviderModel("default", provider.id, first.id, { gatewaySuffix: "renamed" });
  data = await routing.listRouting("default");
  expect(data.aliases.find((item) => item.id === alias.id)?.targetModelId).toBe("next/renamed");
});

test("unverified policy needs a short signed confirmation and is never recorded as successfully validated", async () => {
  const { first, second } = await models();
  const member = { target: first.gatewayModelId, reasoning: { mode: "override" as const, effort: "high" }, customPayload: { extra_body: { temperature: 0.2 } } };
  await expect(routing.createRoutingCombo("default", { combo: "policy", name: "Policy", members: [member, { target: second.gatewayModelId }] })).rejects.toMatchObject({ status: 409 });
  const hash = JSON.stringify([member.target, "override", "high", { extra_body: { temperature: 0.2 } }]);
  const combo = await routing.createRoutingCombo("default", { combo: "policy", name: "Policy", members: [{ ...member, confirmation: routing.issueUnverifiedPolicyConfirmation(hash, "default") }, { target: second.gatewayModelId }] });
  expect(combo.members[0]?.validationState).toBe("unverified");
  expect(combo.members[0]?.validationAt).toBeNull();
});

test("review regressions: model spelling, aliases, resolution candidates, remapping, and nullable limits", async () => {
  const { provider, first, second } = await models();
  const upper = await providers.createProviderModel("default", provider.id, { name: "Case", gatewaySuffix: "Case:One", upstreamModel: "upstream:one" });
  await expect(routing.createRoutingAlias("default", { alias: "case", targetModelId: upper.gatewayModelId })).resolves.toMatchObject({ targetModelId: upper.gatewayModelId });
  await expect(routing.createRoutingAlias("default", { alias: "chain", targetModelId: "case" })).rejects.toMatchObject({ status: 400 });
  const shadow = await routing.createRoutingAlias("default", { alias: "two", targetModelId: first.gatewayModelId });
  await providers.updateProviderModel("default", provider.id, first.id, { enabled: false });
  expect(await routing.resolveRoutingModel("default", "two")).toBeUndefined();
  await providers.updateProviderModel("default", provider.id, first.id, { enabled: true });
  expect((await routing.resolveRoutingModel("default", "upstream-one"))?.model?.id).toBe(first.gatewayModelId);
  const duplicate = await providers.createProvider("default", { name: "Duplicate", prefix: "duplicate", baseUrl: "https://duplicate.test", protocol: "openai-chat" });
  await providers.createProviderModel("default", duplicate.id, { name: "Duplicate", gatewaySuffix: "different", upstreamModel: "upstream-one" });
  expect(await routing.resolveRoutingModel("default", "upstream-one")).toBeUndefined();
  const policy = { target: second.gatewayModelId, reasoning: { mode: "override" as const, effort: "high" } };
  const combo = await routing.createRoutingCombo("default", { combo: "remap", name: "Remap", members: [{ ...policy, confirmation: routing.issueUnverifiedPolicyConfirmation(JSON.stringify([policy.target, "override", "high", {}]), "default") }, { target: upper.gatewayModelId }] });
  await providers.updateProvider("default", provider.id, { prefix: "changed" });
  const updated = (await routing.listRouting("default")).combos.find((item) => item.id === combo.id)!;
  expect(updated.members[0]?.policyHash).toBe(JSON.stringify(["changed/two", "override", "high", {}]));
  expect(updated.members[0]?.validationState).toBe("unverified");
  const renamed = await routing.updateRoutingAlias("default", shadow.id, { alias: "shadow-two" });
  expect(renamed.alias).toBe("shadow-two");
  const credential = await providers.createProviderCredential("default", provider.id, { name: "Limits", key: "secret", rpmLimit: 2, maxConcurrency: 3 });
  const cleared = await providers.updateProviderCredential("default", provider.id, credential.id, { rpmLimit: null, maxConcurrency: null });
  expect(cleared.rpmLimit).toBeUndefined();
  expect((await providers.getProviderDetail("default", provider.id))?.credentials.find((item) => item.id === credential.id)?.maxConcurrency).toBeUndefined();
});

test("policy metadata-only combo edits preserve members and alias renames atomically remap dependent members", async () => {
  const { first, second } = await models();
  const alias = await routing.createRoutingAlias("default", { alias: "primary", targetModelId: first.gatewayModelId });
  const policy = { target: alias.alias, reasoning: { mode: "override" as const, effort: "high" } };
  const combo = await routing.createRoutingCombo("default", { combo: "metadata", name: "Before", members: [{ ...policy, confirmation: routing.issueUnverifiedPolicyConfirmation(JSON.stringify([policy.target, "override", "high", {}]), "default") }, { target: second.gatewayModelId }] });
  const metadata = await routing.updateRoutingCombo("default", combo.id, { name: "After" });
  expect(metadata.name).toBe("After");
  expect(metadata.members.map((member) => member.target)).toEqual(["primary", second.gatewayModelId]);
  await routing.updateRoutingAlias("default", alias.id, { alias: "renamed-primary" });
  const remapped = (await routing.listRouting("default")).combos.find((item) => item.id === combo.id)!;
  expect(remapped.members[0]?.target).toBe("renamed-primary");
  expect(remapped.members[0]?.policyHash).toBe(JSON.stringify(["renamed-primary", "override", "high", {}]));
});

test("policy identity survives member reordering and uses canonical reasoning for confirmation", async () => {
  const { first, second } = await models();
  const raw = { target: first.gatewayModelId, reasoning: { mode: "override" as const, effort: " Medium " } };
  const canonical = { target: raw.target, reasoning: reasoning.normalizeReasoning(raw.reasoning) };
  const combo = await routing.createRoutingCombo("default", {
    combo: "reordered-policy",
    name: "Reordered policy",
    members: [{ ...raw, confirmation: routing.issueUnverifiedPolicyConfirmation(reasoning.memberPolicyConfigHash(canonical), "default") }, { target: second.gatewayModelId }],
  });
  const reordered = await routing.updateRoutingCombo("default", combo.id, {
    members: [{ target: second.gatewayModelId }, { target: first.gatewayModelId, reasoning: { mode: "override", effort: "medium" } }],
  });
  expect(reordered.members.map((member) => member.target)).toEqual([second.gatewayModelId, first.gatewayModelId]);
  expect(reordered.members[1]?.validationState).toBe("unverified");
});
