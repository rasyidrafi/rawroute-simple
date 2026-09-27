import { test } from "bun:test";

async function run(file: string, stateFile: string): Promise<void> {
  const child = Bun.spawn([process.execPath, file], { cwd: import.meta.dir, env: { ...process.env, ACCOUNTING_QUEUE_CRASH_STATE: stateFile }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${file} failed with exit code ${code}.\n${stdout}\n${stderr}`);
}

test("a transient queue insert is durably handed off before a fresh-process recovery", async () => {
  const stateFile = `/tmp/opencode/rawroute-accounting-crash-${crypto.randomUUID()}.json`;
  await run("./accounting-queue-crash-seed.fixture.ts", stateFile);
  await run("./accounting-queue-crash-recover.fixture.ts", stateFile);
});
