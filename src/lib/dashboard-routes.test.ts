import { expect, test } from "bun:test";
import { dashboardPage, dashboardPaths, providerIdFromPath } from "./dashboard-routes";

test("each dashboard URL has a stable page ID and provider detail has a bounded segment", () => {
  for (const [id, path] of Object.entries(dashboardPaths)) expect(dashboardPage(path) === id).toBe(true);
  expect(dashboardPage("/dashboard/ai/providers/openai")).toBe("provider-detail");
  expect(dashboardPage("/dashboard/ai/providers/openai/keys")).toBeUndefined();
  expect(dashboardPage("/dashboard/tools/no-such-tool")).toBeUndefined();
  expect(dashboardPage("/api/auth/status")).toBeUndefined();
  expect(dashboardPage("/v1/models")).toBeUndefined();
});

test("provider detail URLs decode exactly once, including encoded slashes", () => {
  for (const id of ["my provider", "東京", "50% done", "%20", "path/part", "x%2Fy"]) {
    const path = `${dashboardPaths.providers}/${encodeURIComponent(id)}`;
    expect(dashboardPage(path)).toBe("provider-detail");
    expect(providerIdFromPath(path)).toBe(id);
  }
  expect(providerIdFromPath(`${dashboardPaths.providers}/broken%`)).toBeUndefined();
  expect(providerIdFromPath(`${dashboardPaths.providers}/%E6%9D`)).toBeUndefined();
  expect(providerIdFromPath(`${dashboardPaths.providers}/two/segments`)).toBeUndefined();
});
