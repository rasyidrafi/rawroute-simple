import type { BunRequest } from "bun";
import { authenticateGatewayKey } from "./gateway-keys";
import { logs } from "./logging/store";
import { runWithWorkspaceScope } from "./request-scope";
import { admitWorkspaceWrite } from "./workspaces";

const MAX_GATEWAY_KEY_LENGTH = 256;
const MIN_GATEWAY_KEY_LENGTH = 32;
const GATEWAY_KEY_PATTERN = /^[\x21-\x7e]+$/;

export type GatewayEndpoint =
  | "chat-completions"
  | "completions"
  | "responses"
  | "messages"
  | "models"
  | "embeddings"
  | "images"
  | "audio-transcriptions";

type GatewayEndpointDefinition = {
  endpoint: GatewayEndpoint;
  method: "GET" | "POST";
};

export const gatewayEndpoints: Record<string, GatewayEndpointDefinition> = {
  "/v1/chat/completions": { endpoint: "chat-completions", method: "POST" },
  "/v1/completions": { endpoint: "completions", method: "POST" },
  "/v1/responses": { endpoint: "responses", method: "POST" },
  "/v1/messages": { endpoint: "messages", method: "POST" },
  "/v1/models": { endpoint: "models", method: "GET" },
  "/v1/embeddings": { endpoint: "embeddings", method: "POST" },
  "/v1/images/generations": { endpoint: "images", method: "POST" },
  "/v1/audio/transcriptions": { endpoint: "audio-transcriptions", method: "POST" },
};

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
}

function gatewayError(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

export function gatewayMethodNotAllowed(method: "GET" | "POST"): Response {
  return gatewayError("method_not_allowed", "Method not allowed.", 405, { Allow: method });
}

function authenticationFailed(): Response {
  return gatewayError(
    "gateway_authentication_failed",
    "A valid gateway key is required.",
    401,
    { "WWW-Authenticate": "Bearer" },
  );
}

function validGatewayKey(value: string | null): string | undefined {
  if (!value || value.length < MIN_GATEWAY_KEY_LENGTH || value.length > MAX_GATEWAY_KEY_LENGTH || !GATEWAY_KEY_PATTERN.test(value)) return undefined;
  return value;
}

/** Parse only bounded, printable credentials. Two different credentials fail closed. */
export function gatewayCredential(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  let bearer: string | undefined;

  if (authorization !== null) {
    const match = /^Bearer ([\x21-\x7e]+)$/i.exec(authorization);
    if (!match) return undefined;
    bearer = validGatewayKey(match[1]!);
    if (!bearer) return undefined;
  }

  const headerKey = apiKey === null ? undefined : validGatewayKey(apiKey);
  if (apiKey !== null && !headerKey) return undefined;
  if (bearer && headerKey && bearer !== headerKey) return undefined;
  return bearer ?? headerKey;
}

function logGlobal(event: string, message: string, level: "WARN" | "ERROR" = "WARN"): void {
  logs.record({ source: "gateway", event, message }, level);
}

/**
 * Authentication always comes from the key's active workspace; client workspace
 * headers are ignored. Workspace routing is intentionally unavailable until a
 * workspace-owned provider design exists, so this handler never contacts
 * CLIProxy or an upstream.
 */
export async function gatewayUnavailable(
  request: BunRequest,
  endpoint: GatewayEndpoint,
  expectedMethod: "GET" | "POST",
): Promise<Response> {
  if (request.method !== expectedMethod) {
    return gatewayMethodNotAllowed(expectedMethod);
  }

  const credential = gatewayCredential(request);
  if (!credential) {
    logGlobal("gateway.authentication.rejected", "Gateway authentication rejected");
    return authenticationFailed();
  }

  let authentication;
  try {
    authentication = await authenticateGatewayKey(credential);
  } catch {
    logGlobal("gateway.authentication.unavailable", "Gateway authentication unavailable", "ERROR");
    return gatewayError("gateway_authentication_unavailable", "Gateway authentication is temporarily unavailable.", 503);
  }
  if (!authentication) {
    logGlobal("gateway.authentication.rejected", "Gateway authentication rejected");
    return authenticationFailed();
  }

  let admission;
  try {
    admission = await admitWorkspaceWrite(authentication.workspace.id);
  } catch {
    logGlobal("gateway.authentication.unavailable", "Gateway authentication unavailable", "ERROR");
    return gatewayError("gateway_authentication_unavailable", "Gateway authentication is temporarily unavailable.", 503);
  }
  if (!admission) {
    logGlobal("gateway.authentication.rejected", "Gateway authentication rejected");
    return authenticationFailed();
  }

  const scope = { kind: "workspace" as const, workspace: authentication.workspace };
  const logScope = logs.admitWorkspace(authentication.workspace.id);
  try {
    return runWithWorkspaceScope(scope, () => {
      const response = gatewayError("workspace_routing_not_ready", "Workspace routing is not configured.", 503);
      logs.record(
        {
          source: "gateway",
          event: `gateway.${endpoint}.${expectedMethod.toLowerCase()}`,
          message: `Gateway ${expectedMethod} ${endpoint} request`,
        },
        "ERROR",
        { status: response.status, succeeded: false },
        "server",
        logScope,
      );
      return response;
    });
  } finally {
    admission.release();
  }
}

/** `/v1` is not an API operation and deliberately does not accept credentials. */
export function gatewayRoot(): Response {
  return gatewayError("gateway_endpoint_required", "Use a recognized endpoint under /v1/.", 404);
}
