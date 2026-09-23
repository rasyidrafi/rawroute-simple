import type { BunRequest, Server } from "bun";
import { getCurrentSession } from "../auth";
import { env } from "../env";
import {
  CLIPROXY_HOST,
  CLIPROXY_PORT,
  getApiKey,
  getStatus,
  getVersions,
  install,
  restart,
  start,
  stop,
} from "./index";

const MAX_MANAGEMENT_BODY_BYTES = 4 * 1024;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
}

export function isManagementOriginAllowed(
  request: Request,
  expectedOrigin: string | undefined,
  requireOrigin: boolean,
): boolean {
  const origin = request.headers.get("origin");
  if (!expectedOrigin) return false;
  if (origin === null) return !requireOrigin;
  return origin === expectedOrigin;
}

function assertManagementOrigin(request: Request, requireOrigin: boolean): void {
  let expectedOrigin: string | undefined;
  try {
    expectedOrigin = env.nodeEnv === "production" ? env.appOrigin : new URL(request.url).origin;
  } catch {
    expectedOrigin = undefined;
  }

  if (!isManagementOriginAllowed(request, expectedOrigin, requireOrigin)) {
    throw new HttpError("Invalid or missing request origin.", 403);
  }
}

function errorResponse(error: unknown, fallbackStatus: 502 | 503): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);

  const message = error instanceof Error ? error.message : "";
  if (/operation.*progress|another live Bun process|port 8317 .*owned|ownership is ambiguous/i.test(message)) {
    return json({ error: "A CLIProxy operation is already in progress or conflicts with another process." }, 409);
  }

  console.error("CLIProxy management request failed:", error);
  const publicMessage = fallbackStatus === 502
    ? "CLIProxy operation failed."
    : "CLIProxy is temporarily unavailable.";
  return json({ error: publicMessage }, fallbackStatus);
}

async function withManagement(
  request: BunRequest,
  action: () => Promise<Response>,
  fallbackStatus: 502 | 503,
  requireOrigin = false,
): Promise<Response> {
  try {
    assertManagementOrigin(request, requireOrigin);
    if (!(await getCurrentSession(request))) {
      throw new HttpError("Authentication is required.", 401);
    }
    return await action();
  } catch (error) {
    return errorResponse(error, fallbackStatus);
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_MANAGEMENT_BODY_BYTES) {
      throw new HttpError("Request body is invalid or too large.", 400);
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MANAGEMENT_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError("Request body is invalid or too large.", 400);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readInstallVersion(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError("Content-Type must be application/json.", 400);
  }

  let body: unknown;
  try {
    const bytes = await readBoundedBody(request);
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("Request body must be valid JSON.", 400);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("version" in body) ||
    typeof body.version !== "string" ||
    (body.version !== "latest" && !VERSION_PATTERN.test(body.version))
  ) {
    throw new HttpError("Body must contain only a valid version ('latest' or semantic version).", 400);
  }

  return body.version;
}

async function assertEmptyBody(request: Request): Promise<void> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) !== 0) {
      throw new HttpError("This operation does not accept a request body.", 400);
    }
  }
  if (!request.body) return;

  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) {
        await reader.cancel();
        throw new HttpError("This operation does not accept a request body.", 400);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createMutationGate() {
  let admissionClosed = false;
  let activeMutation: Promise<unknown> | undefined;

  function assertAdmissionOpen(): void {
    if (admissionClosed) {
      throw new HttpError("CLIProxy management is shutting down.", 503);
    }
  }

  return {
    run<T>(operation: (assertCanStart: () => void) => Promise<T>): Promise<T> {
      if (admissionClosed) {
        return Promise.reject(new HttpError("CLIProxy management is shutting down.", 503));
      }
      if (activeMutation) {
        return Promise.reject(new HttpError("A CLIProxy operation is already in progress.", 409));
      }

      const mutation = (async () => operation(assertAdmissionOpen))();
      activeMutation = mutation;
      void mutation.then(
        () => {
          if (activeMutation === mutation) activeMutation = undefined;
        },
        () => {
          if (activeMutation === mutation) activeMutation = undefined;
        },
      );
      return mutation;
    },

    beginShutdown(): Promise<void> {
      admissionClosed = true;
      return activeMutation
        ? activeMutation.then(() => undefined, () => undefined)
        : Promise.resolve();
    },
  };
}

const mutationGate = createMutationGate();

export function stopAcceptingCliproxyMutations(): Promise<void> {
  return mutationGate.beginShutdown();
}

async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
  return mutationGate.run(async (assertCanStart) => {
    const status = await getStatus();
    if (status.operation || status.conflict) {
      throw new HttpError("A CLIProxy operation is already in progress or the listener is in conflict.", 409);
    }
    assertCanStart();
    return await operation();
  });
}

export function cliproxyStatus(request: BunRequest): Promise<Response> {
  return withManagement(request, async () => json(await getStatus()), 503);
}

export function cliproxyVersions(request: BunRequest, server: Server<undefined>): Promise<Response> {
  return withManagement(request, async () => {
    server.timeout(request, 0);
    return json(await getVersions());
  }, 502);
}

export function cliproxyKey(request: BunRequest): Promise<Response> {
  return withManagement(request, async () => json({ apiKey: getApiKey() }), 503);
}

export function cliproxyInstall(request: BunRequest, server: Server<undefined>): Promise<Response> {
  return withManagement(request, async () => {
    const version = await readInstallVersion(request);
    server.timeout(request, 0);
    const installedVersion = await runMutation(() => install(version));
    return json({ version: installedVersion });
  }, 502, true);
}

function cliproxyAction(
  request: BunRequest,
  server: Server<undefined>,
  operation: () => Promise<void>,
): Promise<Response> {
  return withManagement(request, async () => {
    await assertEmptyBody(request);
    server.timeout(request, 0);
    await runMutation(operation);
    return json({ ok: true });
  }, 502, true);
}

export function cliproxyStart(request: BunRequest, server: Server<undefined>): Promise<Response> {
  return cliproxyAction(request, server, start);
}

export function cliproxyStop(request: BunRequest, server: Server<undefined>): Promise<Response> {
  return cliproxyAction(request, server, stop);
}

export function cliproxyRestart(request: BunRequest, server: Server<undefined>): Promise<Response> {
  return cliproxyAction(request, server, restart);
}

function connectionHeaderTokens(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function copyProxyHeaders(source: Headers, stripCookies: boolean): Headers {
  const strippedHeaders = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaderTokens(source), "host"]);
  if (stripCookies) {
    strippedHeaders.add("cookie");
    strippedHeaders.add("cookie2");
  }

  const headers = new Headers();
  source.forEach((value, name) => {
    if (!strippedHeaders.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

function unavailableResponse(): Response {
  return json({ error: "CLIProxy is unavailable." }, 503);
}

export async function proxyCliproxy(request: BunRequest, server: Server<undefined>): Promise<Response> {
  server.timeout(request, 0);

  const authorization = request.headers.get("authorization") ?? "";
  const apiKey = request.headers.get("x-api-key")?.trim() ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization) && !apiKey) {
    return json(
      { error: "A CLIProxy API key is required." },
      401,
      { "WWW-Authenticate": "Bearer" },
    );
  }

  const incomingUrl = new URL(request.url);
  const upstreamUrl = `http://${CLIPROXY_HOST}:${CLIPROXY_PORT}${incomingUrl.pathname}${incomingUrl.search}`;
  try {
    const headers = copyProxyHeaders(request.headers, true);
    if (!/^Bearer\s+\S+$/i.test(authorization)) headers.delete("authorization");
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: request.signal,
      redirect: "manual",
      decompress: false,
    });
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyProxyHeaders(upstream.headers, false),
    });
  } catch {
    return unavailableResponse();
  }
}

export function cliproxyRoot(): Response {
  return json({ error: "Use a CLIProxy endpoint under /v1/." }, 404);
}

export function cliproxyManagementNotFound(): Response {
  return json({ error: "Not found." }, 404);
}
