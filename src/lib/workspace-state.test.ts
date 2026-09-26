import { expect, test } from "bun:test";
import { workspaceScopedRequest, type Workspace } from "./workspace-api";
import { activeWorkspaceIdFor, pruneWorkspaceCollections, removeWorkspaceFromState, updateWorkspaceCollection } from "./workspace-state";

const defaultWorkspace: Workspace = {
  id: "default", name: "Default", isDefault: true, status: "active", createdAt: 1, updatedAt: 1,
};
const workspaceA: Workspace = {
  id: "a", name: "A", isDefault: false, status: "active", createdAt: 1, updatedAt: 1,
};
const workspaceB: Workspace = {
  id: "b", name: "B", isDefault: false, status: "active", createdAt: 1, updatedAt: 1,
};

test("a saved workspace selection is honored when the initial workspace list resolves", () => {
  const list = [defaultWorkspace, workspaceA, workspaceB];
  expect(activeWorkspaceIdFor(list, "b")).toBe("b");
  expect(activeWorkspaceIdFor(list, "missing-workspace")).toBe("default");
});

test("workspace deletion falls back to Default without changing an unrelated active workspace", () => {
  const list = [defaultWorkspace, workspaceA, workspaceB];
  expect(removeWorkspaceFromState(list, "b", "a").activeWorkspaceId).toBe("b");
  expect(removeWorkspaceFromState(list, "a", "a").activeWorkspaceId).toBe("default");
});

test("workspace collections keep A and B isolated while retaining each snapshot", () => {
  const initial = ["fixture"];
  const afterA = updateWorkspaceCollection({}, "a", initial, (items) => [...items, "A draft"]);
  const afterB = updateWorkspaceCollection(afterA, "b", initial, (items) => [...items, "B draft"]);
  expect(afterB.a).toEqual(["fixture", "A draft"]);
  expect(afterB.b).toEqual(["fixture", "B draft"]);
});

test("workspace collection cleanup removes deleted snapshots but preserves surviving edits", () => {
  const collections = {
    default: ["fixture", "Default draft"],
    a: ["fixture", "A draft"],
    b: ["fixture", "Deleted workspace draft"],
  };

  expect(pruneWorkspaceCollections(collections, [defaultWorkspace, workspaceA], true)).toEqual({
    default: ["fixture", "Default draft"],
    a: ["fixture", "A draft"],
  });
});

test("workspace collection cleanup waits for a successful list result", () => {
  const collections = { a: ["A draft"], b: ["B draft"] };

  // Loading and failed refreshes both leave this marker false, even if their
  // temporary list is empty.
  expect(pruneWorkspaceCollections(collections, [], false)).toBe(collections);
});

test("future scoped requests use the caller-captured workspace ID", () => {
  const requestForA = workspaceScopedRequest("a", { headers: { Accept: "application/json" } });
  const requestForB = workspaceScopedRequest("b");
  expect(new Headers(requestForA.headers).get("X-RawRoute-Workspace-Id")).toBe("a");
  expect(new Headers(requestForB.headers).get("X-RawRoute-Workspace-Id")).toBe("b");
});
