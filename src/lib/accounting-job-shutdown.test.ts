import { test } from "bun:test";

test("pricing claim is registered before shutdown can observe it", async () => {
  const child = Bun.spawn([process.execPath, "test", "./accounting-job-shutdown.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Pricing shutdown fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
