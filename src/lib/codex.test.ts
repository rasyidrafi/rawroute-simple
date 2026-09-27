import { test } from "bun:test";

test("Codex mapping fixture is isolated from the default database and private transport", async () => {
  const child = Bun.spawn([process.execPath, "test", "./codex.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`Codex fixture failed with exit code ${exitCode}.\n${stdout}\n${stderr}`);
});
