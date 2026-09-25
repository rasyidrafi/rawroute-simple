import type { BunRequest, Server } from "bun";
import { logs } from "./store";
import type { LogEvent } from "./types";

type Handler = (request: BunRequest, server: Server<undefined>) => Response | Promise<Response>;

const gatewayEndpoints = new Map([
  ["/v1/chat/completions", "chat-completions"],
  ["/v1/completions", "completions"],
  ["/v1/responses", "responses"],
  ["/v1/messages", "messages"],
  ["/v1/models", "models"],
  ["/v1/embeddings", "embeddings"],
  ["/v1/images/generations", "images"],
  ["/v1/audio/transcriptions", "transcriptions"],
]);

/** Map known endpoints to constants; never retain arbitrary paths or queries. */
export function loggedGateway(handler: Handler): Handler {
  return (request, server) => {
    const endpoint = gatewayEndpoints.get(new URL(request.url).pathname) ?? "other";
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].find((item) => item === request.method) ?? "OTHER";
    return loggedRequest({ source: "gateway", event: `gateway.${endpoint}.${method.toLowerCase()}`, message: `Gateway ${method} ${endpoint} request` }, handler)(request, server);
  };
}

/** Register future API handlers through this wrapper; it never inspects bodies,
 * headers, query strings, URLs, or errors. Streaming responses remain untouched. */
export function loggedRequest(event: LogEvent, handler: Handler, failuresOnly = false): Handler {
  return async (request, server) => {
    const started = performance.now();
    try {
      const response = await handler(request, server);
      if (!failuresOnly || response.status >= 400) {
        logs.record(event, response.status >= 500 ? "ERROR" : response.status >= 400 ? "WARN" : "INFO", {
          status: response.status,
          durationMs: Math.round(performance.now() - started),
          succeeded: response.ok,
        });
      }
      return response;
    } catch (error) {
      logs.record(event, "ERROR", { status: 500, durationMs: Math.round(performance.now() - started), succeeded: false });
      throw error;
    }
  };
}
