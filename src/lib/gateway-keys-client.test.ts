import { expect, test } from "bun:test";
import { deleteGatewayKeyRequest, gatewayKeyListFromResponse } from "./gateway-keys-client";

test("a successful DELETE 204 resolves", async () => {
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
