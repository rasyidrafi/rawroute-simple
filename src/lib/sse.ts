export type SseFrame = { eventName?: string; data: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Parse one complete SSE record. Data lines are intentionally joined with a
 * newline, as required by the EventSource framing rules. */
export function parseSseFrame(frame: string): SseFrame | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { ...(eventName ? { eventName } : {}), data: data.join("\n") } : undefined;
}

export function sseFrameType(frame: SseFrame, payload?: Record<string, unknown>): string {
  return (frame.eventName || String(payload?.type ?? payload?.event ?? "")).trim().toLowerCase();
}

/**
 * Classify only explicit terminal markers. EOF is deliberately not successful:
 * a network break after useful deltas is still an interrupted response.
 */
export function sseFrameOutcome(frame: SseFrame): "completed" | "failed" | undefined {
  if (frame.data.trim() === "[DONE]") return "completed";
  let payload: Record<string, unknown> | undefined;
  try { payload = object(JSON.parse(frame.data)); } catch { return undefined; }
  const type = sseFrameType(frame, payload);
  const response = object(payload?.response);
  const status = String(response?.status ?? payload?.status ?? "").toLowerCase();
  // A failed status wins even when a provider incorrectly labels the envelope
  // response.completed or response.done.
  if (["response.failed", "response.error", "error"].includes(type) || status === "failed") return "failed";
  if (type === "response.done") return ["completed", "complete", "incomplete"].includes(status) ? "completed" : undefined;
  if (["response.completed", "response.incomplete", "message_stop", "message.completed", "message.done", "done"].includes(type)) return "completed";
  if (type === "message_delta" && typeof object(payload?.delta)?.stop_reason === "string") return "completed";
  if (Array.isArray(payload?.candidates) && payload.candidates.some((candidate) => ["STOP", "MAX_TOKENS"].includes(String(object(candidate)?.finishReason ?? "")))) return "completed";
  return undefined;
}
