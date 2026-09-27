import { expect, test } from "bun:test";
import { formatLedgerDateTimeLocal, isAmbiguousLedgerDateTimeLocal, parseLedgerDateTimeLocal } from "./timezone-client";

test("browser datetime-local uses the configured ledger zone instead of UTC", () => {
  const value = Date.UTC(2026, 8, 27, 12, 30);
  expect(formatLedgerDateTimeLocal(value, "Asia/Jakarta")).toBe("2026-09-27T19:30:00.000");
  expect(parseLedgerDateTimeLocal("2026-09-27T19:30:00.000", "Asia/Jakarta")).toBe(value);
});

test("preserves milliseconds and rejects an edited ambiguous DST wall time", () => {
  const secondFold = Date.parse("2026-11-01T06:30:00.123Z");
  const local = formatLedgerDateTimeLocal(secondFold, "America/New_York");
  expect(local).toBe("2026-11-01T01:30:00.123");
  expect(parseLedgerDateTimeLocal(local, "America/New_York", secondFold)).toBe(secondFold);
  expect(parseLedgerDateTimeLocal(local, "America/New_York")).toBe(secondFold);
  expect(isAmbiguousLedgerDateTimeLocal(local, "America/New_York")).toBe(true);
});
