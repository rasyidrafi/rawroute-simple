import { listRouting, type AvailableRouteModel, type RoutingAlias, type RoutingCombo } from "./routing";
import type { SharedModelView } from "./model-shares";

export type CatalogEntry = { id: string; object: "model"; created: number; owned_by: string; protocol: string };
function aliasesAvailable(aliases: RoutingAlias[], models: AvailableRouteModel[], sharedModels: SharedModelView[] = []) { const activeShares = new Map(sharedModels.filter((model) => model.status === "active").map((model) => [model.id, model])); return aliases.filter((alias) => models.some((model) => model.id === alias.targetModelId) || Boolean(alias.shareId && activeShares.has(alias.shareId))); }
export function buildCatalog(models: AvailableRouteModel[], aliases: RoutingAlias[], combos: RoutingCombo[], sharedModels: SharedModelView[] = []): CatalogEntry[] {
  const entries: CatalogEntry[] = models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: model.providerPrefix, protocol: model.protocol }));
  const activeShares = new Map(sharedModels.filter((model) => model.status === "active").map((model) => [model.id, model]));
  const availableAliases = aliasesAvailable(aliases, models, sharedModels); for (const alias of availableAliases) { const model = models.find((item) => item.id === alias.targetModelId); const shared = alias.shareId ? activeShares.get(alias.shareId) : undefined; entries.push({ id: alias.alias, object: "model", created: Math.floor(alias.createdAt / 1000), owned_by: model?.providerPrefix ?? "shared", protocol: model?.protocol ?? shared?.protocol ?? "openai-chat" }); }
  for (const combo of combos) if (combo.members.some((member) => models.some((model) => model.id === member.target) || availableAliases.some((alias) => alias.alias === member.target))) entries.push({ id: combo.combo, object: "model", created: Math.floor(combo.createdAt / 1000), owned_by: "rawroute", protocol: "openai-chat" });
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}
export async function catalogForWorkspace(workspaceId: string): Promise<CatalogEntry[]> { const data = await listRouting(workspaceId); return buildCatalog(data.models, data.aliases, data.combos, data.sharedModels); }
