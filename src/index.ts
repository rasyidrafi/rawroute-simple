import { serve } from "bun";
import index from "./index.html";

const server = serve({
  port: Number(process.env.PORT ?? 3001),
  routes: {
    "/": index,
    "/api/health": { GET: () => Response.json({ ok: true, service: "bun-react-spacetime" }) },
  },
  development: { hmr: true, console: true },
});

console.log(`🚀 Bun fullstack server running at ${server.url}`);
