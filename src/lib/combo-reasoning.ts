/** Safe, canonical member-policy handling shared by admin persistence and later execution. */
export const comboCustomPayloadMaxBytes = 16 * 1024;
export const comboCustomPayloadMaxDepth = 12;
export const protectedComboPayloadFields = ["model", "messages", "input", "prompt", "stream", "stream_options"] as const;

const protectedFields = new Set<string>(protectedComboPayloadFields);
const unsafeFields = new Set(["__proto__", "prototype", "constructor"]);

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validate(value: unknown, path: string[], depth: number): void {
  if (depth > comboCustomPayloadMaxDepth) throw new Error(`Custom payload cannot be nested more than ${comboCustomPayloadMaxDepth} levels.`);
  if (Array.isArray(value)) return value.forEach((item, index) => validate(item, [...path, String(index)], depth + 1));
  if (!plain(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (unsafeFields.has(key)) throw new Error(`Custom payload field ${entryPath.join(".")} is not allowed.`);
    if ((path.length === 0 || (path.length === 1 && path[0] === "extra_body")) && protectedFields.has(key)) {
      throw new Error(`Custom payload cannot override ${entryPath.join(".")}.`);
    }
    validate(item, entryPath, depth + 1);
  }
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
}

export function normalizeComboCustomPayload(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!plain(value)) throw new Error("Custom payload must be a JSON object.");
  validate(value, [], 0);
  const result = sort(value) as Record<string, unknown>;
  if (!Object.keys(result).length) return undefined;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > comboCustomPayloadMaxBytes) throw new Error("Custom payload cannot exceed 16 KB.");
  return result;
}

export type ComboReasoning = { mode: "inherit" | "default" | "override"; effort?: string };
export function normalizeReasoning(value: unknown): ComboReasoning {
  if (value === undefined || value === null) return { mode: "inherit" };
  if (!plain(value) || (value.mode !== "inherit" && value.mode !== "default" && value.mode !== "override")) {
    throw new Error("Combo reasoning policy is invalid.");
  }
  const effort = typeof value.effort === "string" ? value.effort.trim().toLowerCase() : undefined;
  if (value.mode === "override" && (!effort || effort.length > 64)) throw new Error("Reasoning effort is required when override is enabled.");
  if (value.mode !== "override" && value.effort !== undefined) throw new Error("Reasoning effort is only allowed with override.");
  return value.mode === "override" ? { mode: "override", effort } : { mode: value.mode };
}

/** The same capability gate is used while saving, probing, and executing. */
export function reasoningCapabilityError(reasoning: ComboReasoning, capability?: { mode: "enabled" | "disabled"; supportedEfforts?: string[] }): string | undefined {
  if (reasoning.mode !== "override") return undefined;
  if (capability?.mode === "disabled") return "This model does not accept the configured reasoning effort.";
  if (capability?.supportedEfforts?.length && !capability.supportedEfforts.includes(reasoning.effort!)) return "This model does not accept the configured reasoning effort.";
  return undefined;
}

export function memberPolicyConfigHash(member: { target: string; reasoning: ComboReasoning; customPayload?: Record<string, unknown> }): string {
  return JSON.stringify([member.target, member.reasoning.mode, member.reasoning.effort ?? "", sort(member.customPayload ?? {})]);
}

/** Remove every supported client spelling before a default/override policy. */
export function stripReasoningFields(payload: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(payload);
  for (const key of ["reasoning", "reasoning_effort", "thinking", "thinking_config"]) delete next[key];
  const erase = (container: unknown, key: string) => {
    if (container && typeof container === "object" && !Array.isArray(container)) delete (container as Record<string, unknown>)[key];
  };
  erase(next.output_config, "effort");
  erase(next.generationConfig, "thinkingConfig");
  if (next.google && typeof next.google === "object" && !Array.isArray(next.google)) erase(next.google, "thinking_config");
  if (next.extra_body && typeof next.extra_body === "object" && !Array.isArray(next.extra_body)) {
    const extra = next.extra_body as Record<string, unknown>;
    for (const key of ["reasoning", "reasoning_effort", "thinking", "thinking_config"]) delete extra[key];
    if (extra.google && typeof extra.google === "object" && !Array.isArray(extra.google)) erase(extra.google, "thinking_config");
  }
  return next;
}

/** Apply a normalized effort in the syntax expected by the receiving ingress. */
export function applyReasoningOverride(payload: Record<string, unknown>, effort: string, protocol: "openai-chat" | "openai-responses" | "anthropic-messages"): Record<string, unknown> {
  const next = stripReasoningFields(payload);
  if (protocol === "openai-responses") return { ...next, reasoning: { effort } };
  if (protocol === "openai-chat") return { ...next, reasoning_effort: effort };
  if (effort === "none") return { ...next, thinking: { type: "disabled" } };
  if (effort === "auto") return { ...next, thinking: { type: "enabled" } };
  const output = next.output_config && typeof next.output_config === "object" && !Array.isArray(next.output_config) ? next.output_config as Record<string, unknown> : {};
  return { ...next, thinking: { type: "adaptive" }, output_config: { ...output, effort } };
}
