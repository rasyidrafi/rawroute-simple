import { expect, test } from "bun:test";

test("cold pricing fixture is isolated from cached database and gateway-key state", async () => {
  const child = Bun.spawn([process.execPath, "test", "./accounting-cold-concurrency.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `Cold pricing fixture failed.\n${stdout}\n${stderr}`).toBe(0);
}, 30_000);
