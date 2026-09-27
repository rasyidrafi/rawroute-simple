import { describe, expect, test } from "bun:test";
import { calculateUsageCost, extractUsageMetrics, isTerminalStreamEvent, normalizeUsageMetrics } from "./accounting";

describe("accounting primitives", () => {
  test("charges cache tokens once and selects the highest matching context tier", () => {
    const usage = normalizeUsageMetrics({ input: 2_000_000, output: 10, cached: 500_000, cacheCreation: 100_000 });
    expect(calculateUsageCost(usage, {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
      cacheReadMicrosPerMillion: 100_000,
      cacheCreationMicrosPerMillion: 500_000,
      groupId: "group", versionId: "version", tiers: [{ thresholdTokens: 1_000_000, inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 3_000_000, cacheReadMicrosPerMillion: 200_000, cacheCreationMicrosPerMillion: 1_000_000 }],
    })).toEqual({ costMicros: 3_000_030, confidence: "exact", tier: "context-1000000" });
  });

  test("keeps incomplete metrics assumed and recognizes Anthropic and Gemini usage", () => {
    expect(normalizeUsageMetrics(extractUsageMetrics({ usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 } }))).toMatchObject({ inputTokens: 15, cacheReadTokens: 3, cacheCreationTokens: 2, outputTokens: 4, completeness: "complete" });
    expect(normalizeUsageMetrics(extractUsageMetrics({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 } }))).toMatchObject({ inputTokens: 8, outputTokens: 2, completeness: "complete" });
    expect(normalizeUsageMetrics({ input: 8 })).toMatchObject({ completeness: "partial" });
  });

  test("recognizes named Responses terminal events but never item or failed events", () => {
    expect(isTerminalStreamEvent("response.done", '{"response":{"status":"completed"}}')).toBe(true);
    expect(isTerminalStreamEvent("response.done", '{"response":{"status":"failed"}}')).toBe(false);
    expect(isTerminalStreamEvent("response.output_text.done", '{"type":"response.output_text.done"}')).toBe(false);
    expect(isTerminalStreamEvent("response.completed", '{"response":{"status":"completed"}}')).toBe(true);
    expect(isTerminalStreamEvent("response.done", '{"response":{"status":"failed"}}')).toBe(false);
  });
});
