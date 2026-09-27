export type GatewayIngress = "openai-chat" | "openai-responses" | "anthropic-messages";

export function ingressForPath(path: string): GatewayIngress {
  const normalized = path.toLowerCase();
  if (normalized.includes("/messages")) return "anthropic-messages";
  if (normalized.includes("/responses") || normalized.includes("/backend-api/codex/")) return "openai-responses";
  return "openai-chat";
}
export function isCatalogPath(path: string): boolean { return /\/models\/?$/i.test(path); }
export function isInference(request: Request, path: string): boolean { return request.method !== "GET" && request.method !== "HEAD" && !isCatalogPath(path); }
/** Gemini chooses its model from the URL. Decode once, then resolve it locally. */
export function modelFromPath(path: string): string | undefined {
  const match = /^\/v1beta\/models\/(.+?)(?::(?:generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents))?\/?$/i.exec(path);
  if (!match) return undefined;
  try { const model = decodeURIComponent(match[1]!); return model && !model.includes("\0") ? model : undefined; } catch { return undefined; }
}
/** Rebuild the Gemini URL from the owned transport model; never splice client input. */
export function rewritePathModel(path: string, managedModel: string): string {
  const match = /^(\/v1beta\/models\/).+?((?::(?:generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents))?\/?$)/i.exec(path);
  if (!match) return path;
  return `${match[1]}${encodeURIComponent(managedModel)}${match[2]}`;
}
export function isNativeResponsesCompatible(path: string): boolean {
  return /\/(?:chat\/completions|responses|messages)\/?$/i.test(path) || path.toLowerCase().startsWith("/backend-api/codex/");
}
export function providerResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/responses") ? path : path.endsWith("/v1") ? `${path}/responses` : `${path}/v1/responses`;
  return url.toString();
}
