import { serve } from "bun";
import index from "./index.html";
import { ensureAuthSchema, ensureDefaultPassword, login, logout, status } from "./lib/auth";
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
    "/api/hello": {
      GET: () => Response.json({ message: "Hello from Bun and React" }),
    },
  },
  development: { hmr: true, console: true },
});

console.log(`🚀 Bun fullstack server running at ${server.url}`);
