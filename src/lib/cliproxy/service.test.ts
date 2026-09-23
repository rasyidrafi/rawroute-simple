import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  areAllLoopbackListeners,
  CLIPROXY_LOCK_TIMING,
  CLIPROXY_HOST,
  CLIPROXY_PORT,
  getDataRoot,
  getStartupAction,
  parseListeningSockets,
  parseProcStartTime,
  renderConfig,
  shouldStartAfterInstall,
  validateLoopbackConfig,
} from "./service";

describe("CLIProxy service helpers", () => {
  test("uses the configured persistent data root and the home default", () => {
    expect(getDataRoot("/data")).toBe("/data");
    expect(getDataRoot("")).toContain("/.local/share/rawroute");
  });

  test("renders the private loopback-only API and management config", () => {
    const config = renderConfig("api-secret-value", "management-secret-value", "/data/cliproxy/auth");
    expect(config).toContain(`host: "${CLIPROXY_HOST}"`);
    expect(config).toContain(`port: ${CLIPROXY_PORT}`);
    expect(config).toContain('  allow-remote: false');
    expect(config).toContain('  disable-control-panel: true');
    expect(config).toContain('  secret-key: "management-secret-value"');
    expect(config).toContain('  - "api-secret-value"');
    expect(config).toContain('auth-dir: "/data/cliproxy/auth"');
    expect(() => validateLoopbackConfig(config)).not.toThrow();
  });

  test("rejects persisted configs with a missing, duplicate, or non-loopback host", () => {
    expect(() => validateLoopbackConfig('host: "127.0.0.1" # safe\nport: 8317')).not.toThrow();
    expect(() => validateLoopbackConfig("host: 127.0.0.1\nport: 8317")).not.toThrow();
    expect(() => validateLoopbackConfig('host: "0.0.0.0"\nport: 8317')).toThrow(
      `host must be ${CLIPROXY_HOST}`
    );
    expect(() => validateLoopbackConfig("port: 8317")).toThrow("exactly one root host");
    expect(() =>
      validateLoopbackConfig('host: "127.0.0.1"\nhost: "0.0.0.0"\nport: 8317')
    ).toThrow("exactly one root host");
    expect(() =>
      validateLoopbackConfig('host: "127.0.0.1"\n"host": "0.0.0.0"\nport: 8317')
    ).toThrow("exactly one root host");
    expect(() => validateLoopbackConfig('"host": "0.0.0.0"\nport: 8317')).toThrow(
      `host must be ${CLIPROXY_HOST}`
    );
  });

  test("lock retries extend beyond stale recovery while heartbeat remains active", () => {
    const retryBudgetMs =
      CLIPROXY_LOCK_TIMING.retryAttempts * CLIPROXY_LOCK_TIMING.retryIntervalMs;
    expect(retryBudgetMs).toBeGreaterThanOrEqual(
      CLIPROXY_LOCK_TIMING.staleMs + CLIPROXY_LOCK_TIMING.recoveryMarginMs
    );
    expect(CLIPROXY_LOCK_TIMING.updateMs).toBeLessThanOrEqual(
      CLIPROXY_LOCK_TIMING.staleMs / 2
    );
  });

  test("fresh boot skips release fetching and reports an installed-but-missing desired service", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-init-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const freshRoot = path.join(testRoot, "fresh");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected release fetch"); };
      const moduleUrl = ${JSON.stringify(moduleUrl)};
      process.env.RAWROUTE_DATA_DIR = ${JSON.stringify(freshRoot)};
      const service = await import(moduleUrl);
      await service.initCliproxy();
      const freshStatus = await service.getStatus();
      let startError = "";
      let restartError = "";
      try { await service.start(); } catch (error) { startError = error.message; }
      try { await service.restart(); } catch (error) { restartError = error.message; }
      const afterStartRestart = await service.getStatus();
      await service.shutdownCliproxy();

      fs.writeFileSync(path.join(${JSON.stringify(freshRoot)}, "cliproxy", "state.json"), JSON.stringify({
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: null,
        pinnedVersion: null,
      }));
      await service.initCliproxy();
      const missingStatus = await service.getStatus();
      await service.shutdownCliproxy();
      console.log(JSON.stringify({
        fetchCalls,
        fresh: {
          installed: freshStatus.installed,
          desiredRunning: freshStatus.desiredRunning,
          lastError: freshStatus.lastError,
        },
        startError,
        restartError,
        afterStartRestart: {
          installed: afterStartRestart.installed,
          desiredRunning: afterStartRestart.desiredRunning,
        },
        missing: {
          installed: missingStatus.installed,
          desiredRunning: missingStatus.desiredRunning,
          lastError: missingStatus.lastError,
        },
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: freshRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result.fetchCalls).toBe(0);
      expect(result.fresh).toEqual({ installed: false, desiredRunning: false, lastError: null });
      expect(result.startError).toContain("install a version before starting");
      expect(result.restartError).toContain("install a version before restarting");
      expect(result.afterStartRestart).toEqual({ installed: false, desiredRunning: false });
      expect(result.missing.installed).toBe(false);
      expect(result.missing.desiredRunning).toBe(true);
      expect(result.missing.lastError).toContain("no version is installed");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("startup resumes only an installed desired service and first manual install starts", () => {
    expect(getStartupAction(false, false)).toBe("idle");
    expect(getStartupAction(false, true)).toBe("idle");
    expect(getStartupAction(true, true)).toBe("start");
    expect(getStartupAction(true, false)).toBe("missing-install");

    expect(shouldStartAfterInstall(false, false)).toBe(true);
    expect(shouldStartAfterInstall(true, false)).toBe(true);
    expect(shouldStartAfterInstall(false, true)).toBe(false);
    expect(shouldStartAfterInstall(true, true)).toBe(true);
  });

  test("reads Linux proc start time despite closing parentheses in command names", () => {
    const stat = "42 (bun (worker) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20";
    expect(parseProcStartTime(stat)).toBe("987654");
    expect(parseProcStartTime("malformed")).toBeNull();
  });

  test("parses listener addresses and requires every socket to be IPv4 loopback", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:207D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43210",
      "   1: 0100007F:207D 00000000:0000 01 00000000:00000000 00:00000000 00000000 1000 0 43211",
      "   2: 0100007F:207E 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43212",
      "   3: 00000000:207D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43213",
    ].join("\n");
    const listeners = parseListeningSockets(tcp, 8317, "ipv4");
    expect(listeners).toEqual([
      { inode: "43210", address: "127.0.0.1" },
      { inode: "43213", address: "0.0.0.0" },
    ]);
    expect(areAllLoopbackListeners(["127.0.0.1", "127.0.0.1"])).toBe(true);
    expect(areAllLoopbackListeners(["127.0.0.1", "0.0.0.0"])).toBe(false);
    const tcp6 = [
      "  sl  local_address                         rem_address                         st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:207D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43214",
    ].join("\n");
    const ipv6Listeners = parseListeningSockets(tcp6, 8317, "ipv6");
    expect(ipv6Listeners).toEqual([
      { inode: "43214", address: "ipv6:00000000000000000000000001000000" },
    ]);
    expect(areAllLoopbackListeners(ipv6Listeners.map((listener) => listener.address))).toBe(false);
  });
});
