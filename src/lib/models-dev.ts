const MODELS_DEV_URL = "https://models.dev/api.json";
// Production always uses models.dev. The compiled E2E child can provide a
// loopback catalog so canonical-link coverage never depends on the network.
function catalogUrl(): string {
  const candidate = Bun.env.NODE_ENV === "test" ? Bun.env.RAWROUTE_MODELS_DEV_URL : undefined;
  if (!candidate) return MODELS_DEV_URL;
  try {
    const parsed = new URL(candidate);
    // This is intentionally narrower than "a valid URL": a test process may
    // only replace models.dev with its owned loopback fixture.  Test
    // configuration must not become an SSRF-shaped alternate catalog source.
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    return loopback && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.toString() : MODELS_DEV_URL;
  } catch { return MODELS_DEV_URL; }
}
const TTL = 60 * 60_000;
type Model = { id: string; name: string; provider: string; contextLimit: number | null; rates: { inputMicrosPerMillion: number; outputMicrosPerMillion: number; cacheReadMicrosPerMillion: number; cacheCreationMicrosPerMillion: number } };
let cached: { expires: number; models: Model[] } | undefined;
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function cost(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : 0; }
async function catalog(): Promise<Model[]> { if (cached && cached.expires > Date.now()) return cached.models; const response = await fetch(catalogUrl(), { signal: AbortSignal.timeout(5_000), cache: "no-store" }); if (!response.ok) throw new Error("models.dev unavailable"); const root = object(await response.json()) ?? {}; const models: Model[] = []; for (const [provider, rawProvider] of Object.entries(root)) { const entries = object(object(rawProvider)?.models); if (!entries) continue; for (const [id, raw] of Object.entries(entries)) { const detail = object(raw); if (!detail) continue; const pricing = object(detail.cost) ?? object(detail.pricing) ?? {}; const limit = object(detail.limit); models.push({ id: id.includes("/") ? id : `${provider}/${id}`, name: typeof detail.name === "string" ? detail.name : id, provider, contextLimit: typeof limit?.context === "number" ? limit.context : typeof detail.context_length === "number" ? detail.context_length : null, rates: { inputMicrosPerMillion: cost(pricing.input ?? pricing.prompt), outputMicrosPerMillion: cost(pricing.output ?? pricing.completion), cacheReadMicrosPerMillion: cost(pricing.cache_read ?? pricing.cacheRead), cacheCreationMicrosPerMillion: cost(pricing.cache_write ?? pricing.cacheWrite) } }); } } cached = { expires: Date.now() + TTL, models: models.sort((a, b) => a.id.localeCompare(b.id)) }; return cached.models; }
export async function searchModelsDev(query: string, limit = 50): Promise<Model[]> { const words = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean); const models = await catalog(); return models.filter((model) => words.every((word) => `${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(word))).slice(0, Math.min(100, Math.max(1, limit))); }
