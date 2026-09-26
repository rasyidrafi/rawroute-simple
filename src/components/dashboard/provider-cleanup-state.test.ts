import { expect, test } from "bun:test";
import { runProviderCleanupRetry } from "./provider-cleanup-state";

test("a rejected cleanup retry is retained as a visible error instead of escaping an event handler", async () => {
  await expect(
    runProviderCleanupRetry(async () => {
      throw new Error("Cleanup service unavailable.");
    }),
  ).resolves.toBe("Cleanup service unavailable.");
});
