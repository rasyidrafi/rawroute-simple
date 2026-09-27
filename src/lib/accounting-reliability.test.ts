import { test } from "bun:test";

test("accounting settlement, budget, and stream reliability fixture", async () => {
  const child = Bun.spawn([process.execPath, "test", "./accounting-reliability.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Accounting reliability fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
