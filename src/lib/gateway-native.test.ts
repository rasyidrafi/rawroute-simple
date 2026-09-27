import { expect, test } from "bun:test";
import { calculateUsageCost, extractUsageMetrics, normalizeUsageMetrics } from "./accounting";
import { nativeResponsesJson, nativeResponsesRequest, nativeResponsesStream } from "./gateway-native";
import { providerResponsesUrl, rewritePathModel } from "./gateway-protocol";

const encoder = new TextEncoder();
function stream(records: string[]): ReadableStream<Uint8Array> { return new ReadableStream({ start(controller) { for (const record of records) controller.enqueue(encoder.encode(record)); controller.close(); } }); }
function chatChunks(text: string): Array<Record<string, any>> { return text.split("\n\n").flatMap((frame) => frame.startsWith("data: ") && frame.slice(6) !== "[DONE]" ? [JSON.parse(frame.slice(6))] : []); }
function anthropicUsageFromResponse(usage: Record<string, unknown>) { return (JSON.parse(new TextDecoder().decode(nativeResponsesJson(encoder.encode(JSON.stringify({ output: [], usage })), "anthropic-messages", "public"))) as { usage: Record<string, unknown> }).usage; }
function normalizedUsage(usage: Record<string, unknown>) { return normalizeUsageMetrics(extractUsageMetrics({ usage })); }

test("native request translators preserve tools, tool histories, multimodal blocks, and Anthropic schemas", () => {
  const chat = nativeResponsesRequest({ model: "public", messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"London\"}" } }] }, { role: "tool", tool_call_id: "call_1", content: "sunny" }, { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://image.test/a.png" } }] }], tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }] }, "openai-chat", "upstream");
  expect(chat).toMatchObject({ model: "upstream", tools: [{ type: "function", name: "weather" }] });
  expect(chat.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function_call", call_id: "call_1" }), expect.objectContaining({ type: "function_call_output", call_id: "call_1" })]));
  expect(JSON.stringify(chat.input)).toContain("input_image");
  const anthropic = nativeResponsesRequest({ model: "public", max_tokens: 10, system: [{ type: "text", text: "be useful" }], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "weather", input: { city: "London" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "sunny" }] }], tools: [{ name: "weather", input_schema: { type: "object" } }] }, "anthropic-messages", "upstream");
  expect(anthropic).toMatchObject({ instructions: "be useful", max_output_tokens: 10, tools: [{ name: "weather", parameters: { type: "object" } }] });
  expect(JSON.stringify(anthropic.input)).toContain("function_call_output");
});

test("native response translators preserve tool calls and emit consumable Chat/Anthropic SSE", async () => {
  const response = new TextEncoder().encode(JSON.stringify({ id: "resp_1", output: [{ type: "function_call", call_id: "call_1", name: "weather", arguments: "{\"city\":\"London\"}" }] }));
  expect(JSON.parse(new TextDecoder().decode(nativeResponsesJson(response, "openai-chat", "public")))).toMatchObject({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_1" }] } }] });
  expect(JSON.parse(new TextDecoder().decode(nativeResponsesJson(response, "anthropic-messages", "public")))).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call_1" }] });
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2}}}\n\n')); controller.close(); } });
  const chat = await new Response(nativeResponsesStream(source, "openai-chat", "public")).text();
  expect(chat).toContain('"role":"assistant"'); expect(chat).toContain('"content":"Hello"'); expect(chat).toContain("[DONE]");
  const anthSource = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n')); controller.close(); } });
  const anth = await new Response(nativeResponsesStream(anthSource, "anthropic-messages", "public")).text();
  expect(anth).toContain("event: message_start"); expect(anth).toContain("event: content_block_delta"); expect(anth).toContain("event: message_stop");
});

test("native provider URLs and Gemini routing cannot reuse a client model path", () => {
  expect(providerResponsesUrl("https://provider.test")).toBe("https://provider.test/v1/responses");
  expect(providerResponsesUrl("https://provider.test/v1/responses")).toBe("https://provider.test/v1/responses");
  expect(rewritePathModel("/v1beta/models/foreign%2Fmodel:generateContent", "rr-ws-owned/model")).toBe("/v1beta/models/rr-ws-owned%2Fmodel:generateContent");
});

test("native conversion preserves refusal and flattens JSON schema and Anthropic tool choices", () => {
  const refusal = new TextEncoder().encode(JSON.stringify({ id: "r", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }));
  expect(JSON.parse(new TextDecoder().decode(nativeResponsesJson(refusal, "openai-chat", "public")))).toMatchObject({ choices: [{ message: { content: null, refusal: "No." } }] });
  expect(JSON.parse(new TextDecoder().decode(nativeResponsesJson(refusal, "anthropic-messages", "public")))).toMatchObject({ content: [{ type: "text", text: "No." }] });
  const json = nativeResponsesRequest({ messages: [], response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object" } } } }, "openai-chat", "upstream");
  expect(json).toMatchObject({ text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object" } } } }); expect(json).not.toHaveProperty("response_format");
  for (const [source, expected] of [["auto", "auto"], ["any", "required"], ["none", "none"]] as const) expect(nativeResponsesRequest({ messages: [], max_tokens: 8, tool_choice: { type: source } }, "anthropic-messages", "upstream").tool_choice).toBe(expected);
});

test("native Responses cache-inclusive usage round-trips through exclusive Anthropic usage", () => {
  const upstream = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } };
  const anthropic = anthropicUsageFromResponse(upstream);
  expect(anthropic).toEqual({ input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 });
  const original = normalizedUsage(upstream), roundTrip = normalizedUsage(anthropic);
  expect(roundTrip).toEqual(original);
  expect(original).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 10, totalTokens: 120 });
  expect(calculateUsageCost(roundTrip, { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 500_000, cacheCreationMicrosPerMillion: 0, groupId: "group", versionId: "version", tiers: [] })).toMatchObject({ costMicros: 115, confidence: "exact" });
});

test("native Anthropic usage preserves cache-field presence and clamps only the exclusive input", () => {
  const uncached = { input_tokens: 10, output_tokens: 2 }, unknownCache = { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: "unknown", cache_write_tokens: null } };
  expect(anthropicUsageFromResponse(uncached)).toEqual({ input_tokens: 10, output_tokens: 2 });
  expect(anthropicUsageFromResponse(unknownCache)).toEqual({ input_tokens: 10, output_tokens: 2 });
  expect(normalizedUsage(anthropicUsageFromResponse(uncached))).toEqual(normalizedUsage(uncached));
  expect(normalizedUsage(anthropicUsageFromResponse(unknownCache))).toEqual(normalizedUsage(unknownCache));
  const zero = anthropicUsageFromResponse({ input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  expect(zero).toEqual({ input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  expect(normalizedUsage(zero)).toEqual(normalizedUsage({ input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
  expect(anthropicUsageFromResponse({ input_tokens: 10, output_tokens: 2, cached_tokens: 3, cache_write_tokens: 2 })).toEqual({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
  expect(anthropicUsageFromResponse({ input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 } })).toEqual({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
});

test("native Chat tool-call chunks identify each call once and accumulate interleaved arguments", async () => {
  const body = await new Response(nativeResponsesStream(stream([
    "event: response.created\ndata: {\"response\":{\"id\":\"resp_weather\"}}\n\n",
    "event: response.output_item.added\ndata: {\"item\":{\"id\":\"weather-item\",\"type\":\"function_call\",\"call_id\":\"call_weather\",\"name\":\"weather\"}}\n\n",
    "event: response.output_item.added\ndata: {\"item\":{\"id\":\"time-item\",\"type\":\"function_call\",\"call_id\":\"call_time\",\"name\":\"time\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"weather-item\",\ndata: \"delta\":\"{\\\"city\\\":\"}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"time-item\",\"delta\":\"{\\\"zone\\\":\\\"UTC\\\"}\"}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"weather-item\",\"delta\":\"\\\"London\\\"}\"}\n\n",
    "event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n",
  ]), "openai-chat", "public")).text();
  const tools = chatChunks(body).flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
  expect(tools).toEqual([
    { index: 0, id: "call_weather", type: "function", function: { name: "weather", arguments: "{\"city\":" } },
    { index: 1, id: "call_time", type: "function", function: { name: "time", arguments: "{\"zone\":\"UTC\"}" } },
    { index: 0, function: { arguments: "\"London\"}" } },
  ]);
  const accumulated = new Map<number, { id?: string; name?: string; arguments: string }>();
  for (const tool of tools) { const current = accumulated.get(tool.index) ?? { arguments: "" }; if (tool.id) current.id = tool.id; if (tool.function.name) current.name = tool.function.name; current.arguments += tool.function.arguments; accumulated.set(tool.index, current); }
  expect([...accumulated.values()]).toEqual([{ id: "call_weather", name: "weather", arguments: "{\"city\":\"London\"}" }, { id: "call_time", name: "time", arguments: "{\"zone\":\"UTC\"}" }]);
  expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
});

test("native SSE honors event names, multiline records, failed response.done, and Anthropic final usage", async () => {
  const complete = await new Response(nativeResponsesStream(stream(["event: response.completed\ndata: {\"response\":{\"id\":\"r\",\ndata: \"status\":\"completed\"}}\n\n"]), "openai-chat", "public")).text();
  expect(complete).toContain("[DONE]");
  const failed = await new Response(nativeResponsesStream(stream(["event: response.done\ndata: {\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"weather failed\"}}}\n\n", "data: [DONE]\n\n"]), "openai-chat", "public")).text();
  expect(failed).toContain("weather failed"); expect(failed).not.toContain("[DONE]");
  const interrupted = await new Response(nativeResponsesStream(stream(["event: response.created\ndata: {\"response\":{\"id\":\"r\"}}\n\n", "event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n"]), "openai-chat", "public")).text();
  expect(interrupted).toContain("partial"); expect(interrupted).not.toContain("[DONE]");
  const anthropic = await new Response(nativeResponsesStream(stream(["event: response.created\ndata: {\"response\":{\"id\":\"r\"}}\n\n", "event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\n"]), "anthropic-messages", "public")).text();
  const final = anthropic.split("\n\n").map((item) => item.split("\ndata: ").at(-1)).filter(Boolean).map((item) => JSON.parse(item!)).find((item) => item.type === "message_delta");
  expect(final.usage).toEqual({ input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3 });
  expect(normalizedUsage(final.usage)).toEqual(normalizedUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } }));
});
