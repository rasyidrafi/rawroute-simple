/** Normalize public Responses compatibility fields without changing other input. */
export function normalizeResponsesRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  if (!Object.hasOwn(normalized, "max_output_tokens")) {
    if (Object.hasOwn(normalized, "max_completion_tokens")) normalized.max_output_tokens = normalized.max_completion_tokens;
    else if (Object.hasOwn(normalized, "max_tokens")) normalized.max_output_tokens = normalized.max_tokens;
  }
  if (!Object.hasOwn(normalized, "reasoning") && typeof normalized.reasoning_effort === "string") {
    const effort = normalized.reasoning_effort.trim();
    if (effort && effort.length <= 64) normalized.reasoning = { effort };
  }
  delete normalized.max_completion_tokens;
  delete normalized.max_tokens;
  delete normalized.reasoning_effort;
  return normalized;
}
