import { serve } from "bun";
import index from "./index.html";
import { ensureAuthSchema, ensureDefaultPassword, login, logout, status } from "./lib/auth";
import {
  cliproxyInstall,
  cliproxyKey,
  cliproxyManagementNotFound,
  cliproxyRestart,
  cliproxyRoot,
  cliproxyStart,
  cliproxyStatus,
  cliproxyStop,
  cliproxyVersions,
  proxyCliproxy,
  stopAcceptingCliproxyMutations,
} from "./lib/cliproxy/http";
import { initCliproxy, shutdownCliproxy } from "./lib/cliproxy";
import { checkDatabaseConnection } from "./lib/db";
import { env } from "./lib/env";

await ensureAuthSchema();
await ensureDefaultPassword();

const server = serve({
  port: env.port,
  routes: {
    "/": index,
    "/api/health": { GET: () => Response.json({ ok: true, service: "bun-react" }) },
    "/api/db/health": {
      GET: async () => {
        try {
          await checkDatabaseConnection();
          return Response.json({ ok: true, database: "connected" });
        } catch (error) {
          console.error("Database health check failed:", error);
          return Response.json(
            { ok: false, database: "unavailable" },
            { status: 503 },
          );
        }
      },
    },
    "/api/auth/login": { POST: login },
    "/api/auth/logout": { POST: logout },
    "/api/auth/status": { GET: status },
    "/api/cliproxy/status": { GET: cliproxyStatus },
    "/api/cliproxy/versions": { GET: cliproxyVersions },
    "/api/cliproxy/key": { GET: cliproxyKey },
    "/api/cliproxy/install": { POST: cliproxyInstall },
    "/api/cliproxy/start": { POST: cliproxyStart },
    "/api/cliproxy/stop": { POST: cliproxyStop },
    "/api/cliproxy/restart": { POST: cliproxyRestart },
    "/v1": cliproxyRoot,
    "/v1/*": proxyCliproxy,
    "/v0/management": cliproxyManagementNotFound,
    "/v0/management/*": cliproxyManagementNotFound,
    "/api/hello": {
      GET: () => Response.json({ message: "Hello from Bun and React" }),
    },
  },
  development: { hmr: true, console: true },
});

console.log(`🚀 Bun fullstack server running at ${server.url}`);

// The service's standalone signal handlers exit the process. Let this server
// coordinate its shutdown instead so the proxy and HTTP listener stop once.
const cliproxyProcess = process as typeof process & { __rawrouteCliproxySignals?: boolean };
cliproxyProcess.__rawrouteCliproxySignals = true;

let initialization: Promise<void> = Promise.resolve();
let shutdown: Promise<void> | undefined;

function handleShutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdown) return shutdown;
  process.exitCode = signal === "SIGINT" ? 130 : 143;

  const mutationsDrained = stopAcceptingCliproxyMutations();
  const acceptingStopped = server.stop(false);
  shutdown = (async () => {
    try {
      await Promise.all([initialization, mutationsDrained]);
      await shutdownCliproxy();
    } catch (error) {
      console.error("CLIProxy shutdown failed:", error);
      process.exitCode = 1;
    } finally {
      await server.stop(true);
      await acceptingStopped;
    }
  })();
  return shutdown;
}

process.once("SIGINT", () => void handleShutdown("SIGINT"));
process.once("SIGTERM", () => void handleShutdown("SIGTERM"));

initialization = initCliproxy().catch((error: unknown) => {
  console.error("CLIProxy initialization failed:", error);
});
