import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withSuiteWatchdog } from "./e2e-bounds";

const executable = "/usr/bin/chromium";

test("watchdog closes its owned agent-browser daemon after abort", async () => {
  expect(fs.existsSync(executable)).toBe(true);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-e2e-browser-watchdog-"));
  const home = path.join(workdir, "home");
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-ab-watchdog-"));
  const config = path.join(workdir, "agent-browser.e2e.json");
  const session = `rr-wd-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ headed: false }), { mode: 0o600 });

  function command(args: string[], sessionScoped = true) {
    const result = Bun.spawnSync({
      cmd: ["agent-browser", "--config", config, "--executable-path", executable, ...(sessionScoped ? ["--session", session] : []), ...args],
      cwd: workdir,
      env: { PATH: process.env.PATH ?? "", HOME: home, AGENT_BROWSER_SOCKET_DIR: socketDir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0 || result.exitedDueToTimeout) throw new Error(result.stderr.toString() || result.stdout.toString());
    return result.stdout.toString();
  }

  try {
    command(["open", "about:blank"]);
    await expect(withSuiteWatchdog(
      async (signal) => await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      // Deliberately bypass the aborted task signal: this is the production
      // harness's cleanup-only close pattern, never `close --all`.
      async () => { command(["close"]); },
      50,
    )).rejects.toThrow();
    let active = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      active = command(["session", "list"], false);
      if (!active.includes(session)) break;
      await Bun.sleep(50);
    }
    expect(active).not.toContain(session);
    expect(fs.existsSync(path.join(socketDir, `${session}.pid`))).toBe(false);
  } finally {
    try { command(["close"]); } catch { /* already closed by watchdog */ }
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
});
