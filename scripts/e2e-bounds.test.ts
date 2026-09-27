import { expect, test } from "bun:test";
import { fetchBounded, textBounded, withSuiteWatchdog } from "./e2e-bounds";
import { stopOwnedProcess } from "./e2e-supervisor";

async function expectDeadline(operation: (signal: AbortSignal) => Promise<void>) {
  let cleaned = false;
  const child = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], stdout: "ignore", stderr: "ignore" });
  await expect(withSuiteWatchdog(operation, async () => { await stopOwnedProcess(child, 20); cleaned = true; }, 80)).rejects.toThrow();
  expect(cleaned).toBe(true);
  expect(child.exitCode ?? child.signalCode).not.toBeNull();
}

test("hung health fetch fails by deadline and reaps its owned process", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => undefined) });
  try { await expectDeadline(async (signal) => { await fetchBounded(`http://127.0.0.1:${server.port}/api/health`, {}, 20, signal); }); }
  finally { server.stop(true); }
});

test("unterminated stream fails by deadline and reaps its owned process", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({ start() {} })) });
  try { await expectDeadline(async (signal) => { const response = await fetchBounded(`http://127.0.0.1:${server.port}/v1/responses`, {}, 20, signal); await textBounded(response, 20, signal); }); }
  finally { server.stop(true); }
});
