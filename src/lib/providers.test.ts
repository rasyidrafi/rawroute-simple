import { test } from "bun:test";

test("provider backend fixture is isolated from cached auth, database, and encryption modules", async () => {
  const child = Bun.spawn([process.execPath, "test", "./providers.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Provider fixture failed with exit code ${exitCode}.\n${stdout}\n${stderr}`);
});
