import { expect, test } from "bun:test";
import { dashboardRouteMeta } from "../dashboard-routes";
import { browserEventScope, endpointEvents, workspaceEvents } from "./browser-event-scope";
import { browserEvents, type BrowserEvent } from "./types";

const routes = Object.entries(dashboardRouteMeta) as Array<[string, { scope: "global" | "workspace" }]>;

test("ordinary browser events use the declared scope for every dashboard route", () => {
  const ordinaryEvents = (Object.keys(browserEvents) as BrowserEvent[]).filter(
    (event) => !workspaceEvents.has(event) && !endpointEvents.has(event),
  );
  for (const event of ordinaryEvents) {
    for (const [page, meta] of routes) {
      expect(browserEventScope(event, page)).toBe(meta.scope);
    }
  }
});

test("browser events reject unknown, inherited, provider-detail, and non-string pages", () => {
  const invalidPages = [
    undefined, null, 1, true, {}, [], "unknown", "provider-detail",
    "toString", "constructor", "hasOwnProperty", "__proto__",
  ];
  for (const event of Object.keys(browserEvents) as BrowserEvent[]) {
    for (const page of invalidPages) {
      const expected = page === undefined && (event === "dashboard.error" || event === "dashboard.rejection")
        ? "global"
        : workspaceEvents.has(event) && page === undefined
          ? "workspace"
          : undefined;
      expect(browserEventScope(event, page)).toBe(expected);
    }
  }
});

test("endpoint key events are accepted only on Endpoint", () => {
  for (const event of endpointEvents) {
    for (const [page] of routes) {
      expect(browserEventScope(event, page)).toBe(page === "endpoint" ? "workspace" : undefined);
    }
    expect(browserEventScope(event, undefined)).toBeUndefined();
  }
});

test("mock workspace events allow no page, reject Endpoint and global pages, and accept other workspace pages", () => {
  for (const event of workspaceEvents) {
    expect(browserEventScope(event, undefined)).toBe("workspace");
    for (const [page, meta] of routes) {
      const expected = meta.scope === "workspace" && page !== "endpoint" ? "workspace" : undefined;
      expect(browserEventScope(event, page)).toBe(expected);
    }
  }
});

test("page-less runtime errors are global", () => {
  expect(browserEventScope("dashboard.error", undefined)).toBe("global");
  expect(browserEventScope("dashboard.rejection", undefined)).toBe("global");
});
