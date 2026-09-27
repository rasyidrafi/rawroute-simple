import { test } from "bun:test";

test("native stream monitor remains part of gateway shutdown drain", async () => {
  const child = Bun.spawn([process.execPath, "test", "./accounting-native-drain.fixture.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Native drain fixture failed with exit code ${code}.\n${stdout}\n${stderr}`);
});
