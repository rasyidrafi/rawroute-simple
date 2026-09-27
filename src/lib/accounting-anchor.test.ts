import { test } from "bun:test";

test("Codex budget anchor fixture is isolated from private transport", async () => {
  const child = Bun.spawn([process.execPath, "test", "./accounting-anchor.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`Codex anchor fixture failed with exit code ${exitCode}.\n${stdout}\n${stderr}`);
});
