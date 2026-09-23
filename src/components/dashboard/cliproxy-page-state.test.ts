import { describe, expect, it } from "bun:test";
import {
  canInstallExactRelease,
  createInstallAction,
  lifecycleControlsBlocked,
  releaseControlsBlocked,
  statusPollInterval,
} from "./cliproxy-page-state";

describe("CLIProxy dashboard lifecycle state", () => {
  it("requests latest instead of pinning the currently listed latest version", () => {
    expect(createInstallAction("latest", "1.8.0", "1.7.2")).toEqual({
      type: "install",
      version: "1.8.0",
      requestVersion: "latest",
      downgrade: false,
    });
  });

  it("keeps an exact release selection exact and identifies downgrades", () => {
    expect(createInstallAction("1.6.0", "1.8.0", "1.7.2")).toEqual({
      type: "install",
      version: "1.6.0",
      requestVersion: "1.6.0",
      downgrade: true,
    });
  });

  it("polls faster while a lifecycle operation is pending", () => {
    expect(statusPollInterval(true)).toBe(1_500);
    expect(statusPollInterval(false)).toBe(5_000);
  });

  it("blocks lifecycle and release controls during a server operation", () => {
    expect(lifecycleControlsBlocked({
      hasStatus: true,
      operationPending: true,
      actionBusy: false,
      statusRefreshing: false,
      conflict: false,
    })).toBe(true);
    expect(lifecycleControlsBlocked({
      hasStatus: true,
      operationPending: false,
      actionBusy: false,
      statusRefreshing: false,
      conflict: false,
    })).toBe(false);
  });

  it("keeps lifecycle controls available while only the remote release catalog is loading", () => {
    const lifecycleBlocked = lifecycleControlsBlocked({
      hasStatus: true,
      operationPending: false,
      actionBusy: false,
      statusRefreshing: false,
      conflict: false,
    });
    expect(lifecycleBlocked).toBe(false);
    expect(releaseControlsBlocked(lifecycleBlocked, true, true)).toBe(true);
    expect(releaseControlsBlocked(lifecycleBlocked, true, false)).toBe(false);
  });

  it("allows pinning the current floating version but skips an identical pin", () => {
    expect(canInstallExactRelease("1.8.0", "1.8.0", null)).toBe(true);
    expect(canInstallExactRelease("1.8.0", "1.8.0", "1.8.0")).toBe(false);
    expect(canInstallExactRelease("1.7.2", "1.8.0", null)).toBe(true);
    expect(canInstallExactRelease(null, "1.8.0", null)).toBe(false);
  });
});
