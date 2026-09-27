import { test } from "bun:test";

test("public analytics fixture proves redaction, scoped caching, invalidation, and public validation", async () => {
  const child = Bun.spawn([process.execPath, "./public-analytics.fixture.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Public analytics fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
