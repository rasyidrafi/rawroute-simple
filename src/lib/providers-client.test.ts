import { expect, test } from "bun:test";
import { providerApi } from "./providers-client";

test("provider model collection requests use the captured workspace and aggregate endpoint", async () => {
  let path = "";
  let request: RequestInit | undefined;
  const api = providerApi("workspace-a", async (input, init) => {
    path = String(input);
    request = init;
    return Response.json({ models: [] });
  });
  await expect(api.listModels()).resolves.toEqual([]);
  expect(path).toBe("/api/providers/models");
  expect(new Headers(request?.headers).get("accept")).toBe("application/json");
});

test("provider cleanup collection uses the scoped durable cleanup endpoint", async () => {
  let path = "";
  const api = providerApi("workspace-a", async (input) => {
    path = String(input);
    return Response.json({ cleanup: [] });
  });
  await expect(api.listCleanup()).resolves.toEqual([]);
  expect(path).toBe("/api/providers/cleanup");
});

test("a failed provider save exposes the server error without serializing request data", async () => {
  const api = providerApi("workspace-a", async () =>
    Response.json(
      { error: "Provider prefix is already in use in this workspace." },
      { status: 409 },
    ),
  );
  await expect(
    api.createProvider({
      name: "Name",
      prefix: "taken",
      baseUrl: "https://example.test",
      protocol: "openai-chat",
      authType: "bearer",
      headers: {},
      enabled: true,
    }),
  ).rejects.toMatchObject({
    message: "Provider prefix is already in use in this workspace.",
    status: 409,
  });
});
