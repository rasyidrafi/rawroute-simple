import { test } from "bun:test";

test("routing catalog fixture is isolated from cached database modules", async () => {
  const child = Bun.spawn([process.execPath, "test", "./routing.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Routing fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
