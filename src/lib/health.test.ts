import { expect, test } from "bun:test";
import { healthResponse } from "./health";

test("health degrades without leaking dependency details and recovers independently of native execution", async () => {
  const down = await healthResponse({
    checkDatabase: async () => undefined,
    checkCliproxy: async () => ({ healthy: false }),
  });
  expect(down.status).toBe(503);
  expect(await down.json()).toEqual({
    ok: false,
    service: "bun-react",
    dependencies: { database: "ready", cliproxy: "unavailable" },
    executors: { native: "available", projected: "unavailable" },
  });
  expect(down.headers.get("cache-control")).toBe("no-store");
  expect(down.headers.get("set-cookie")).toBeNull();

  const databaseDown = await healthResponse({
    checkDatabase: async () => { throw new Error("private database DSN"); },
    checkCliproxy: async () => ({ healthy: true }),
  });
  expect(databaseDown.status).toBe(503);
  expect(JSON.stringify(await databaseDown.json())).not.toContain("private database DSN");

  const recovered = await healthResponse({
    checkDatabase: async () => undefined,
    checkCliproxy: async () => ({ healthy: true }),
  });
  expect(recovered.status).toBe(200);
  expect((await recovered.json() as { ok: boolean }).ok).toBe(true);
});
