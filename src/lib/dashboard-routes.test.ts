import { expect, test } from "bun:test";
import { dashboardPage, dashboardPaths, dashboardRouteMeta, dashboardScopeForPage, providerIdFromPath } from "./dashboard-routes";

test("each dashboard URL has a stable page ID and provider detail has a bounded segment", () => {
  for (const [id, path] of Object.entries(dashboardPaths)) expect(dashboardPage(path) === id).toBe(true);
  expect(dashboardPage("/dashboard/ai/providers/openai")).toBe("provider-detail");
  expect(dashboardPage("/dashboard/ai/providers/openai/keys")).toBeUndefined();
  expect(dashboardPage("/dashboard/tools/no-such-tool")).toBeUndefined();
  expect(dashboardPage("/api/auth/status")).toBeUndefined();
  expect(dashboardPage("/v1/models")).toBeUndefined();
});

test("route scope metadata keeps global lifecycle pages out of workspace scope", () => {
  expect(dashboardRouteMeta.endpoint.scope).toBe("workspace");
  expect(dashboardRouteMeta.cliproxy.scope).toBe("global");
  expect(dashboardRouteMeta["system-logs"].scope).toBe("global");
  expect(dashboardRouteMeta.settings.scope).toBe("global");
  expect(dashboardRouteMeta.logs.scope).toBe("workspace");
  expect(dashboardRouteMeta.providers.scope).toBe("workspace");
});

test("route scope lookup accepts only declared own route IDs", () => {
  for (const [page, meta] of Object.entries(dashboardRouteMeta)) {
    expect(dashboardScopeForPage(page)).toBe(meta.scope);
  }
  for (const page of [
    undefined, null, 1, true, {}, [], "unknown", "provider-detail",
    "toString", "constructor", "hasOwnProperty", "__proto__",
  ]) {
    expect(dashboardScopeForPage(page)).toBeUndefined();
  }
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
