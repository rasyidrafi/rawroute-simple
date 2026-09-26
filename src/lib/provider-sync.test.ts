import { test } from "bun:test";

test("provider reconciliation fixture is isolated from cached database and CLIProxy modules", async () => {
  const child = Bun.spawn([process.execPath, "test", "./provider-sync.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Provider sync fixture failed with exit code ${exitCode}.\n${stdout}\n${stderr}`);
});
