import { test } from "bun:test";

test("ledger maintenance cannot repair a workspace after concurrent deletion", async () => {
  const child = Bun.spawn([process.execPath, "./accounting-maintenance.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Accounting maintenance fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
