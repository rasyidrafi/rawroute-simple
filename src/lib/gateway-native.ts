import type { GatewayIngress } from "./gateway-protocol";
import { normalizeResponsesRequest } from "./request-normalization";
import { parseSseFrame, sseFrameOutcome, sseFrameType } from "./sse";

const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function chatContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.flatMap((part) => {
    const item = record(part); if (!item) return [];
    if (item.type === "text" && typeof item.text === "string") return [{ type: "input_text", text: item.text }];
    if (item.type === "image_url") { const image = record(item.image_url); const url = typeof image?.url === "string" ? image.url : typeof item.image_url === "string" ? item.image_url : undefined; return url ? [{ type: "input_image", image_url: url }] : []; }
    return [item];
  });
}
function chatInput(messages: unknown): unknown[] {
  return array(messages).flatMap((raw) => {
    const message = record(raw); if (!message || typeof message.role !== "string") return [];
    if (message.role === "tool") return typeof message.tool_call_id === "string" ? [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content ?? "" }] : [];
    const output: unknown[] = [];
    for (const call of array(message.tool_calls)) { const tool = record(call); const fn = record(tool?.function); if (tool?.type === "function" && typeof tool.id === "string" && typeof fn?.name === "string") output.push({ type: "function_call", call_id: tool.id, name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "{}" }); }
    const content = chatContent(message.content);
    return [...(content === undefined || content === null || content === "" ? [] : [{ role: message.role, content }]), ...output];
  });
}
function anthropicBlocks(value: unknown): unknown[] {
  return (typeof value === "string" ? [{ type: "text", text: value }] : array(value)).flatMap<unknown>((raw) => {
    const block = record(raw); if (!block) return [];
    if (block.type === "text" && typeof block.text === "string") return [{ type: "input_text", text: block.text }];
    if (block.type === "image") { const source = record(block.source); const image = typeof source?.url === "string" ? source.url : typeof source?.data === "string" ? `data:${source.media_type ?? "image/*"};base64,${source.data}` : undefined; return image ? [{ type: "input_image", image_url: image }] : []; }
    if (block.type === "document") { const source = record(block.source); const file = typeof source?.url === "string" ? { file_url: source.url } : typeof source?.data === "string" ? { file_data: `data:${source.media_type ?? "application/pdf"};base64,${source.data}` } : undefined; return file ? [{ type: "input_file", ...file }] : []; }
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") return [{ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }];
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") return [{ type: "function_call_output", call_id: block.tool_use_id, output: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "") }];
    return [];
  });
}
function anthropicInput(messages: unknown): unknown[] {
  return array(messages).flatMap((raw) => { const message = record(raw); if (!message || typeof message.role !== "string") return []; const blocks = anthropicBlocks(message.content); const calls = blocks.filter((block) => { const item = record(block); return item?.type === "function_call" || item?.type === "function_call_output"; }); const content = blocks.filter((block) => !calls.includes(block)); return [...(content.length ? [{ role: message.role, content }] : []), ...calls]; });
}
function nativeTools(payload: Record<string, unknown>, ingress: GatewayIngress): unknown[] | undefined {
  const tools = array(payload.tools).flatMap((raw) => {
    const tool = record(raw); if (!tool) return [];
    if (ingress === "openai-chat") { const fn = record(tool.function); return tool.type === "function" && typeof fn?.name === "string" ? [{ type: "function", name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}), ...(fn.strict === true ? { strict: true } : {}) }] : []; }
    return typeof tool.name === "string" ? [{ type: "function", name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : tool.parameters !== undefined ? { parameters: tool.parameters } : {}) }] : [];
  });
  return tools.length ? tools : undefined;
}
/** Fully translate the supported Chat/Anthropic request subset to native Responses. */
export function nativeResponsesRequest(payload: Record<string, unknown>, ingress: GatewayIngress, upstreamModel: string): Record<string, unknown> {
  if (ingress === "openai-responses") return { ...normalizeResponsesRequest(payload), model: upstreamModel };
  const result: Record<string, unknown> = { ...payload, model: upstreamModel };
  if (ingress === "openai-chat") {
    result.input = chatInput(payload.messages); delete result.messages;
    if (!Object.hasOwn(result, "max_output_tokens")) result.max_output_tokens = payload.max_completion_tokens ?? payload.max_tokens;
  } else {
    result.input = anthropicInput(payload.messages); delete result.messages;
    result.max_output_tokens = payload.max_tokens;
    const instructions = (typeof payload.system === "string" ? payload.system : array(payload.system).map((item) => record(item)?.type === "text" ? record(item)?.text : undefined).filter((item): item is string => typeof item === "string").join("\n"));
    if (instructions) result.instructions = instructions;
    delete result.system; delete result.max_tokens;
  }
  const tools = nativeTools(payload, ingress); if (tools) result.tools = tools;
  if (ingress === "openai-chat") {
    const choice = record(payload.tool_choice); if (choice?.type === "function") { const fn = record(choice.function); if (typeof fn?.name === "string") result.tool_choice = { type: "function", name: fn.name }; }
    const format = record(payload.response_format); if (format?.type === "json_object") result.text = { format: { type: "json_object" } }; else if (format?.type === "json_schema") { const schema = record(format.json_schema); if (schema?.schema !== undefined) result.text = { format: { type: "json_schema", ...(typeof schema.name === "string" ? { name: schema.name } : {}), ...(schema.schema !== undefined ? { schema: schema.schema } : {}), ...(schema.strict === true ? { strict: true } : {}) } }; }
  }
  if (ingress === "anthropic-messages") { const choice = record(payload.tool_choice); if (choice?.type === "tool" && typeof choice.name === "string") result.tool_choice = { type: "function", name: choice.name }; else if (choice?.type === "auto") result.tool_choice = "auto"; else if (choice?.type === "any") result.tool_choice = "required"; else if (choice?.type === "none") result.tool_choice = "none"; }
  delete result.stream_options;
  delete result.response_format;
  delete result.max_tokens; delete result.max_completion_tokens;
  return normalizeResponsesRequest(result);
}
function outputItems(response: Record<string, unknown>): Record<string, unknown>[] { return array(response.output).map(record).filter((item): item is Record<string, unknown> => Boolean(item)); }
function outputText(response: Record<string, unknown>): string { return outputItems(response).flatMap((item) => array(item.content).map(record)).map((item) => typeof item?.text === "string" ? item.text : typeof item?.refusal === "string" ? item.refusal : "").join(""); }
function outputRefusal(response: Record<string, unknown>): string | undefined { return outputItems(response).flatMap((item) => array(item.content).map(record)).map((item) => typeof item?.refusal === "string" ? item.refusal : undefined).find((item): item is string => Boolean(item)); }
function toolCalls(response: Record<string, unknown>) { return outputItems(response).filter((item) => item.type === "function_call").map((item, index) => ({ id: String(item.call_id ?? item.id ?? `call_${index}`), type: "function", function: { name: String(item.name ?? "function"), arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) } })); }
function usage(response: Record<string, unknown>) { const value = record(response.usage); return value ? { prompt_tokens: value.input_tokens ?? 0, completion_tokens: value.output_tokens ?? 0, total_tokens: Number(value.input_tokens ?? 0) + Number(value.output_tokens ?? 0) } : undefined; }
function token(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function firstToken(...values: unknown[]): number | undefined { for (const value of values) { const parsed = token(value); if (parsed !== undefined) return parsed; } return undefined; }
/** Responses input tokens include cache categories; Anthropic input tokens exclude them. */
function anthropicUsage(raw?: Record<string, unknown>) {
  const detail = record(raw?.input_tokens_details) ?? record(raw?.prompt_tokens_details);
  const cached = firstToken(raw?.cache_read_input_tokens, raw?.cached_tokens, detail?.cached_tokens, detail?.cache_read_tokens, detail?.cacheReadTokens);
  const created = firstToken(raw?.cache_creation_input_tokens, raw?.cache_write_tokens, raw?.cache_creation_tokens, detail?.cache_write_tokens, detail?.cacheWriteTokens, detail?.cache_creation_tokens, detail?.cacheCreationTokens);
  const inclusiveInput = firstToken(raw?.input_tokens, raw?.prompt_tokens) ?? 0;
  return { input_tokens: Math.max(0, inclusiveInput - (cached ?? 0) - (created ?? 0)), output_tokens: raw?.output_tokens ?? raw?.completion_tokens ?? 0, ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}), ...(created !== undefined ? { cache_creation_input_tokens: created } : {}) };
}
export function nativeResponsesJson(bytes: Uint8Array, ingress: GatewayIngress, model: string): Uint8Array {
  if (ingress === "openai-responses") return bytes;
  let response: Record<string, unknown>; try { response = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { return bytes; }
  if (response.status === "failed") return encoder.encode(JSON.stringify({ error: { message: String(record(response.error)?.message ?? "Upstream response failed."), code: String(record(response.error)?.code ?? "upstream_failed") } }));
  const calls = toolCalls(response); const incomplete = response.status === "incomplete"; const id = String(response.id ?? `${ingress === "anthropic-messages" ? "msg" : "chatcmpl"}_${crypto.randomUUID()}`);
  if (ingress === "anthropic-messages") {
    const content: unknown[] = []; if (outputText(response)) content.push({ type: "text", text: outputText(response) }); for (const call of calls) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: (() => { try { return JSON.parse(call.function.arguments); } catch { return {}; } })() });
    const raw = record(response.usage); return encoder.encode(JSON.stringify({ id, type: "message", role: "assistant", model, content, stop_reason: calls.length ? "tool_use" : incomplete ? "max_tokens" : "end_turn", usage: anthropicUsage(raw) }));
  }
  const refusal = outputRefusal(response); return encoder.encode(JSON.stringify({ id, object: "chat.completion", created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: refusal ? null : outputText(response), ...(refusal ? { refusal } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : incomplete ? "length" : "stop" }], ...(usage(response) ? { usage: usage(response) } : {}) }));
}

/** A native fetch can report a reset as an untyped error after its known request
 * signal fired. Only that known transport shutdown becomes a clean close; the
 * separate original-body accounting tee still owns durable settlement. */
function closeOnKnownAbort(source: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = source.getReader(); let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const part = await reader.read(); if (part.done) { controller.close(); release(); } else controller.enqueue(part.value); }
      catch (error) { if (signal.aborted || typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") controller.close(); else controller.error(error); release(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  });
}

/** Translate native Responses SSE without buffering client-visible output. */
export function nativeResponsesStream(body: ReadableStream<Uint8Array>, ingress: GatewayIngress, model: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
  if (ingress === "openai-responses") return signal ? closeOnKnownAbort(body, signal) : body;
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let id = ""; let started = false; let textStarted = false; let textIndex = 0; let done = false; let failed = false; let latestUsage: Record<string, unknown> | undefined;
  const calls = new Map<string, { contentIndex: number; chatIndex: number; id: string; name: string; anthropicStarted: boolean; chatIdentityEmitted: boolean }>(); let nextContentIndex = 0; let nextChatCallIndex = 0;
  const frame = (event: string | undefined, value: unknown) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (value: string) => controller.enqueue(encoder.encode(value));
      const startAnthropic = () => { if (!started) { started = true; emit(frame("message_start", { type: "message_start", message: { id: id || `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: anthropicUsage(latestUsage) } })); } };
      const callFor = (value: Record<string, unknown>, item?: Record<string, unknown>) => { const key = String(value.item_id ?? item?.id ?? value.call_id ?? item?.call_id ?? "call"); let call = calls.get(key); if (!call) { call = { contentIndex: nextContentIndex++, chatIndex: nextChatCallIndex++, id: String(item?.call_id ?? value.call_id ?? item?.id ?? key), name: String(item?.name ?? value.name ?? "function"), anthropicStarted: false, chatIdentityEmitted: false }; calls.set(key, call); } return call; };
      const emitChatToolDelta = (call: ReturnType<typeof callFor>, delta: string) => { const tool = call.chatIdentityEmitted ? { index: call.chatIndex, function: { arguments: delta } } : { index: call.chatIndex, id: call.id, type: "function", function: { name: call.name, arguments: delta } }; call.chatIdentityEmitted = true; emit(`data: ${JSON.stringify({ id: id || `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }] })}\n\n`); };
      const finish = (incomplete: boolean) => { if (done || failed) return; if (ingress === "anthropic-messages") { startAnthropic(); if (textStarted) emit(frame("content_block_stop", { type: "content_block_stop", index: textIndex })); for (const call of calls.values()) if (call.anthropicStarted) emit(frame("content_block_stop", { type: "content_block_stop", index: call.contentIndex })); emit(frame("message_delta", { type: "message_delta", delta: { stop_reason: calls.size ? "tool_use" : incomplete ? "max_tokens" : "end_turn" }, usage: anthropicUsage(latestUsage) })); emit(frame("message_stop", { type: "message_stop" })); } else { const rawUsage = latestUsage; emit(`data: ${JSON.stringify({ id: id || `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: calls.size ? "tool_calls" : incomplete ? "length" : "stop" }], ...(rawUsage ? { usage: { prompt_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0, completion_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0, total_tokens: Number(rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0) + Number(rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0) } } : {}) })}\n\n`); emit("data: [DONE]\n\n"); } done = true; };
      const fail = (source?: Record<string, unknown>) => { if (done || failed) return; const error = record(source?.error); if (ingress === "anthropic-messages") emit(frame("error", { type: "error", error: { type: String(error?.code ?? "api_error"), message: String(error?.message ?? "Upstream response failed.") } })); else emit(`data: ${JSON.stringify({ error: { message: String(error?.message ?? "Upstream response failed."), code: String(error?.code ?? "upstream_failed") } })}\n\n`); failed = true; done = true; };
      const consume = (rawFrame: string) => {
        const parsed = parseSseFrame(rawFrame); if (!parsed) return;
        const outcome = sseFrameOutcome(parsed);
        if (parsed.data.trim() === "[DONE]") { if (!failed) finish(false); return; }
        let value: Record<string, unknown>; try { value = JSON.parse(parsed.data) as Record<string, unknown>; } catch { return; }
        const response = record(value.response); if (typeof response?.id === "string") id = response.id;
        const rawUsage = record(response?.usage) ?? record(value.usage); if (rawUsage) latestUsage = { ...latestUsage, ...rawUsage };
        const type = sseFrameType(parsed, value);
        if (outcome === "failed") { fail(response ?? value); return; }
        if (type === "response.created") { if (ingress === "anthropic-messages") startAnthropic(); else emit(`data: ${JSON.stringify({ id: id || `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`); return; }
        if (type === "response.output_item.added") { const item = record(value.item); if (item?.type === "function_call") callFor(value, item); return; }
        const delta = typeof value.delta === "string" ? value.delta : typeof record(value.delta)?.text === "string" ? String(record(value.delta)?.text) : "";
        if ((type === "response.output_text.delta" || type === "response.refusal.delta") && delta) { if (ingress === "anthropic-messages") { startAnthropic(); if (!textStarted) { textStarted = true; textIndex = nextContentIndex++; emit(frame("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } })); } emit(frame("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta } })); } else emit(`data: ${JSON.stringify({ id: id || `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: type === "response.refusal.delta" ? { refusal: delta } : { content: delta }, finish_reason: null }] })}\n\n`); }
        if (type === "response.function_call_arguments.delta") { const call = callFor(value); if (ingress === "anthropic-messages") { startAnthropic(); if (!call.anthropicStarted) { call.anthropicStarted = true; emit(frame("content_block_start", { type: "content_block_start", index: call.contentIndex, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } })); } emit(frame("content_block_delta", { type: "content_block_delta", index: call.contentIndex, delta: { type: "input_json_delta", partial_json: delta } })); } else emitChatToolDelta(call, delta); }
        if (outcome === "completed") finish(type === "response.incomplete" || String(response?.status ?? value.status ?? "").toLowerCase() === "incomplete");
      };
      void (async () => { try { for (;;) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); let separator: number; while ((separator = buffer.search(/\r?\n\r?\n/)) >= 0) { const event = buffer.slice(0, separator); buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/, ""); consume(event); } } buffer += decoder.decode(); if (buffer.trim()) consume(buffer); controller.close(); } catch (error) { if (signal?.aborted || typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") controller.close(); else controller.error(error); } finally { reader.releaseLock(); } })();
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
