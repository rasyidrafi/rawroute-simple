import { test } from "bun:test";

test("pricing fixture persists group, tier, canonical link, and replacement job", async () => {
  const child = Bun.spawn([process.execPath, "test", "./accounting-pricing.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Pricing fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
