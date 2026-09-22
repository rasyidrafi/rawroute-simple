import { serve } from "bun";
import index from "./index.html";
import { checkDatabaseConnection } from "./lib/db";
import { env } from "./lib/env";

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
    "/api/hello": {
      GET: () => Response.json({ message: "Hello from Bun and React" }),
    },
  },
  development: { hmr: true, console: true },
});

console.log(`🚀 Bun fullstack server running at ${server.url}`);
