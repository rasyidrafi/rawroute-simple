export type HealthDependencies = {
  checkDatabase: () => Promise<void>;
  checkCliproxy: () => Promise<{ healthy: boolean }>;
};

/**
 * Health is intentionally unauthenticated and reports only coarse dependency
 * state. Native execution requires the database-backed resolver but not the
 * private CLIProxy process; projected/Codex execution needs both.
 */
export async function healthResponse(dependencies: HealthDependencies): Promise<Response> {
  const [database, cliproxy] = await Promise.all([
    dependencies.checkDatabase().then(() => true, () => false),
    dependencies.checkCliproxy().then((status) => status.healthy === true, () => false),
  ]);
  const ok = database && cliproxy;
  return Response.json({
    ok,
    service: "bun-react",
    dependencies: {
      database: database ? "ready" : "unavailable",
      cliproxy: cliproxy ? "ready" : "unavailable",
    },
    executors: {
      native: database ? "available" : "unavailable",
      projected: database && cliproxy ? "available" : "unavailable",
    },
  }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
