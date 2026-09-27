import { expect, test } from "bun:test";

test("model sharing end-to-end fixture", async () => {
  const child = Bun.spawn([process.execPath, "test", "./model-shares.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
  expect(await child.exited, output).toBe(0);
});
