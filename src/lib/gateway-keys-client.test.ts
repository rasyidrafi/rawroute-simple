import { expect, test } from "bun:test";
import { cleanupDeletedGatewayKey, deleteGatewayKeyRequest, gatewayKeyListFromResponse } from "./gateway-keys-client";

test("a successful DELETE 204 resolves and removes the deleted key from visible UI state", async () => {
  let path = "";
  let request: RequestInit | undefined;
  await deleteGatewayKeyRequest(async (nextPath, nextRequest) => {
    path = nextPath;
    request = nextRequest;
    return new Response(null, { status: 204 });
  }, "workspace-a", "key/a", new AbortController().signal);

  expect(path).toBe("/api/gateway-keys/key%2Fa");
  expect(request?.method).toBe("DELETE");
  expect(new Headers(request?.headers).get("x-rawroute-workspace-id")).toBe("workspace-a");
  expect(cleanupDeletedGatewayKey(
    [{ id: "delete", name: "Delete" }, { id: "keep", name: "Keep" }],
    { delete: "visible-secret", keep: "still-visible" },
    "delete",
  )).toEqual({
    keys: [{ id: "keep", name: "Keep" }],
    visibleSecrets: { keep: "still-visible" },
    deleteTarget: null,
  });
});

test("metadata returned for another workspace is discarded", () => {
  expect(gatewayKeyListFromResponse({
    keys: [{
      id: "key-b",
      workspaceId: "workspace-b",
      name: "Wrong owner",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      revokedAt: null,
    }],
  }, "workspace-a")).toBeNull();
});
