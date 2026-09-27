import { test } from "bun:test";

test("gateway runtime fixture covers native catalog, transformations, streaming, and local combo fallback", async () => {
  const child = Bun.spawn([process.execPath, "test", "./gateway-runtime.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Gateway runtime fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});

test("native accounting monitor reports persistence errors after cancellation", async () => {
  const child = Bun.spawn([process.execPath, "test", "./gateway-runtime-accounting-monitor.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Native accounting monitor fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
