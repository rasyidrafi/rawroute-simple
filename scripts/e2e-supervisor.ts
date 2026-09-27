export type OwnedProcess = {
  exited: Promise<unknown>;
  kill(signal?: number | NodeJS.Signals): void;
};

/**
 * Reap only the process started by this harness. A timed-out graceful shutdown
 * is not allowed to outlive its temporary database/data directory.
 */
export async function stopOwnedProcess(process: OwnedProcess, timeoutMs = 10_000): Promise<void> {
  let exited = false;
  void process.exited.then(() => { exited = true; });
  try { process.kill("SIGTERM"); } catch { /* It may have exited between readiness and cleanup. */ }
  await Promise.race([process.exited, Bun.sleep(timeoutMs)]);
  if (!exited) {
    try { process.kill("SIGKILL"); } catch { /* Reap still verifies the exit. */ }
    await process.exited;
  }
}
