import { describe, expect, test } from "bun:test";
import { appDateStart, appDateString, addAppDays } from "./timezone";

describe("ledger timezone dates", () => {
  test("uses configured-zone midnight and inclusive end dates", () => {
    const start = appDateStart("2026-09-27");
    expect(appDateString(start)).toBe("2026-09-27");
    expect(appDateString(addAppDays(start, 1))).toBe("2026-09-28");
  });
});
