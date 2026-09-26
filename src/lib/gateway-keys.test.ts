import { test } from "bun:test";

test("gateway key fixture is isolated from cached env, database, and master-key modules", async () => {
  const child = Bun.spawn([process.execPath, "test", "./gateway-keys.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Gateway key fixture failed with exit code ${exitCode}.\n${stdout}\n${stderr}`);
  }
});
