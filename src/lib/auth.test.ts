import { expect, test } from "bun:test";

test("auth fixture is isolated from cached configuration and rate-limit state", async () => {
  const child = Bun.spawn([process.execPath, "test", "./auth.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `Auth fixture failed.\n${stdout}\n${stderr}`).toBe(0);
}, 30_000);
