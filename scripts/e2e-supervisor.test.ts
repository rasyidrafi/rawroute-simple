import { expect, test } from "bun:test";
import { stopOwnedProcess } from "./e2e-supervisor";

test("E2E supervisor escalates and reaps a delayed owned server before cleanup", async () => {
  let resolveExit!: () => void;
  const signals: string[] = [];
  const process = {
    exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
    kill(signal?: number | NodeJS.Signals) {
      signals.push(String(signal));
      if (signal === "SIGKILL") resolveExit();
    },
  };

  await stopOwnedProcess(process, 1);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});
