import { beforeEach, expect, test } from "bun:test";
import type { BunRequest, Server } from "bun";
import { createLogStore, logs, resolveLogStore, safeDetails } from "./store";
import { loggedGateway, loggedRequest } from "./request";
import { formatLog, type LogDetails } from "./types";
import { collectionChanges } from "./collection";

const event = { source: "test", event: "test.action", message: "Test action" };
beforeEach(() => logs.clear());

test("collection summaries capture duplicate credentials and reorder/update operations without values", () => {
  expect(collectionChanges(["secret"], ["secret", "secret"])).toEqual({ added: 1, removed: 0, updated: 0, reordered: false });
  expect(collectionChanges(["secret", "secret"], ["secret"])).toEqual({ added: 0, removed: 1, updated: 0, reordered: false });
  const first = { id: "first", secret: "private" };
  const second = { id: "second", secret: "private" };
  expect(collectionChanges([first, second], [second, { ...first }])).toEqual({ added: 0, removed: 0, updated: 1, reordered: true });
  expect(JSON.stringify(collectionChanges([first], [second]))).not.toContain("private");
});

test("retention is bounded, newest first, immutable to readers, and IDs survive clear", () => {
  const store = createLogStore(2);
  for (let index = 0; index < 3; index++) store.record(event, "INFO", { index });
  const snapshot = store.snapshot();
  expect(snapshot.entries.map((entry) => entry.details.index)).toEqual([2, 1]);
  expect(snapshot.evicted).toBe(1);
  const oldId = snapshot.entries[0]!.id;
  snapshot.entries[0]!.details.index = 99;
  expect(store.snapshot().entries[0]!.details.index).toBe(2);
  store.clear();
  store.record(event);
  expect(store.snapshot().entries[0]!.id).not.toBe(oldId);
  expect(store.snapshot().evicted).toBe(0);
});

test("workspace and global buffers are isolated, clear independently, and obey the total bound", () => {
  const store = createLogStore(2, 3);
  const alpha = { kind: "workspace" as const, workspaceId: "alpha" };
  const beta = { kind: "workspace" as const, workspaceId: "beta" };
  const alphaAdmission = store.admitWorkspace(alpha.workspaceId);
  const betaAdmission = store.admitWorkspace(beta.workspaceId);
  store.record(event, "INFO", { index: 1 }, "server", alphaAdmission);
  store.record(event, "INFO", { index: 2 }, "server", alphaAdmission);
  store.record(event, "INFO", { index: 3 }, "server", betaAdmission);
  store.record(event, "INFO", { index: 4 });
  expect(store.snapshot(alpha).entries.map((entry) => entry.details.index)).toEqual([2]);
  expect(store.snapshot(alpha).evicted).toBe(1);
  expect(store.snapshot(beta).entries.map((entry) => entry.workspaceId)).toEqual(["beta"]);
  expect(store.snapshot().entries.map((entry) => entry.scope)).toEqual(["global"]);
  store.clear(alphaAdmission);
  expect(store.snapshot(alpha).entries).toHaveLength(0);
  expect(store.snapshot(beta).entries).toHaveLength(1);
  store.deleteWorkspace("beta");
  expect(store.snapshot(beta).entries).toHaveLength(0);
});

test("hot reload replaces an incompatible pre-scope runtime store", () => {
  const legacy = { record() {}, snapshot() {}, clear() {} };
  const runtime: { __rawrouteLogs?: unknown } = { __rawrouteLogs: legacy };
  const migrated = resolveLogStore(runtime);
  expect(migrated).not.toBe(legacy);
  expect(migrated.version).toBe(2);
  expect(typeof migrated.admitWorkspace).toBe("function");
  expect(runtime.__rawrouteLogs).toBe(migrated);
});

test("metadata discards sensitive keys, strings, nested objects, nonfinite numbers, and unbounded keys", () => {
  expect(safeDetails({
    status: 200, succeeded: true, absent: null, password: 123456789,
    apiKey: "secret", authorization: "Bearer secret", request: { password: "secret" },
    url: "https://user:secret@example.com/?token=secret", durationMs: Infinity,
    "injected\nlog": 1,
  } as unknown as LogDetails)).toEqual({ status: 200, succeeded: true, absent: null });
});

test("request instrumentation classifies failures and leaves streaming bodies unread", async () => {
  const request = new Request("http://localhost/v1/completions?api_key=do-not-log", {
    method: "POST", headers: { authorization: "Bearer do-not-log" }, body: "do-not-log",
  }) as BunRequest;
  for (const status of [200, 401, 503]) {
    const response = new Response("private response body", { status });
    const result = await loggedRequest(event, () => response)(request, {} as Server<undefined>);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(request.bodyUsed).toBe(false);
  }
  const snapshot = logs.snapshot();
  expect(snapshot.entries.map((entry) => entry.level)).toEqual(["ERROR", "WARN", "INFO"]);
  expect(JSON.stringify(snapshot)).not.toContain("do-not-log");
  expect(JSON.stringify(snapshot)).not.toContain("private response");
  expect(formatLog(snapshot.entries[0]!)).toContain("status=503");
});

test("Bun.serve preserves cookie mutations through a logged route", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/cookies": { GET: loggedRequest(event, (request, instance) => {
        expect(instance).toBe(server);
        request.cookies.set("fresh", "visible", { path: "/" });
        request.cookies.delete("old");
        return new Response("cookie response", { headers: { "x-logged": "yes" } });
      }) },
    },
  });
  try {
    const response = await fetch(new URL("/cookies", server.url), { headers: { cookie: "old=previous" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-logged")).toBe("yes");
    expect(await response.text()).toBe("cookie response");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith("fresh=visible;"))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("old=") && /Max-Age=0|Expires=/i.test(cookie))).toBe(true);
    expect(logs.snapshot().entries[0]?.details.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("Bun.serve delivers the first streamed chunk before a gated second chunk", async () => {
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let secondReleased = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/stream": { GET: loggedRequest(event, (_request, instance) => {
        expect(instance).toBe(server);
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            await secondGate;
            secondReleased = true;
            controller.enqueue(new TextEncoder().encode("second"));
            controller.close();
          },
        }), { headers: { "content-type": "text/plain" } });
      }) },
    },
  });
  try {
    const response = await fetch(new URL("/stream", server.url), { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");
    expect(first.done).toBe(false);
    expect(secondReleased).toBe(false);
    releaseSecond();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second");
    expect((await reader.read()).done).toBe(true);
    expect(logs.snapshot().entries[0]?.details.status).toBe(200);
  } finally {
    releaseSecond();
    server.stop(true);
  }
});

test("polling success is quiet and thrown errors are recorded without exception contents", async () => {
  const request = new Request("http://localhost") as BunRequest;
  await loggedRequest(event, () => new Response(), true)(request, {} as Server<undefined>);
  expect(logs.snapshot().entries).toHaveLength(0);
  const cause = new Error("password=secret");
  await expect(loggedRequest(event, () => { throw cause; })(request, {} as Server<undefined>)).rejects.toBe(cause);
  expect(logs.snapshot().entries[0]!.level).toBe("ERROR");
  expect(JSON.stringify(logs.snapshot())).not.toContain("secret");
});

test("invalidated workspace admissions cannot recreate a deleted buffer", () => {
  const store = createLogStore();
  const workspaceId = crypto.randomUUID();
  const admission = store.admitWorkspace(workspaceId);
  expect(store.record(event, "INFO", {}, "server", admission)).toBe(true);
  store.deleteWorkspace(workspaceId);
  expect(store.record(event, "INFO", {}, "server", admission)).toBe(false);
  expect(store.clear(admission)).toBe(false);
  expect(store.snapshot({ kind: "workspace", workspaceId }).entries).toHaveLength(0);
});

test("gateway events identify allowlisted endpoints and methods without logging arbitrary URLs", async () => {
  const handler = loggedGateway(() => new Response());
  await handler(new Request("http://localhost/v1/chat/completions?token=secret", { method: "POST" }) as BunRequest, {} as Server<undefined>);
  const customRequest = new Request("http://localhost/v1/secret") as BunRequest;
  Object.defineProperty(customRequest, "method", { value: "SECRET" });
  await handler(customRequest, {} as Server<undefined>);
  expect(logs.snapshot().entries.map((entry) => entry.event)).toEqual(["gateway.other.other", "gateway.chat-completions.post"]);
  expect(JSON.stringify(logs.snapshot()).toLowerCase()).not.toContain("secret");
});
