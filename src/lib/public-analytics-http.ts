import type { BunRequest } from "bun";
import { PublicAnalyticsError, listPublicWorkspaces, publicDashboard } from "./public-analytics";

const PUBLIC_CACHE_CONTROL = "public, max-age=30, s-maxage=30";

function json(body: unknown, status = 200, cacheControl = PUBLIC_CACHE_CONTROL): Response {
  return Response.json(body, { status, headers: { "cache-control": cacheControl } });
}

function failure(error: unknown): Response {
  if (error instanceof PublicAnalyticsError) return json({ error: error.message }, error.status, "no-store");
  console.error("Public analytics request failed.");
  return json({ error: "Public analytics is temporarily unavailable." }, 503, "no-store");
}

export async function getPublicWorkspaces(): Promise<Response> {
  try {
    // Workspace choices must disappear immediately on deletion. The aggregate
    // dashboard, not this global selector list, owns the 30-second public TTL.
    return json({ workspaces: await listPublicWorkspaces() }, 200, "no-store");
  } catch (error) {
    return failure(error);
  }
}

export async function getPublicDashboard(request: BunRequest): Promise<Response> {
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspace");
    if (!workspaceId) throw new PublicAnalyticsError("Workspace is required.", 400);
    return json(await publicDashboard({
      workspaceId,
      preset: url.searchParams.get("preset"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      granularity: url.searchParams.get("granularity"),
    }));
  } catch (error) {
    return failure(error);
  }
}
