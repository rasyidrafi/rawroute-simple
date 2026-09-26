import { expect, test } from "bun:test";
import {
  beginProviderPendingAction,
  clearProviderPendingAction,
  emptyProviderPendingActions,
  isProviderPending,
} from "./use-providers-state";

test("an A completion cannot strand or clear the same pending action key in B", () => {
  const action = "delete-provider:shared-id";
  const actionA = beginProviderPendingAction(
    emptyProviderPendingActions,
    "workspace-a",
    1,
    action,
  );
  const switchedToB = beginProviderPendingAction(
    emptyProviderPendingActions,
    "workspace-b",
    2,
    action,
  );
  const staleAFinally = clearProviderPendingAction(
    switchedToB,
    "workspace-a",
    1,
    action,
  );

  expect(isProviderPending(staleAFinally, "workspace-b", 2, action)).toBe(true);
  const settledB = clearProviderPendingAction(
    staleAFinally,
    "workspace-b",
    2,
    action,
  );
  expect(isProviderPending(settledB, "workspace-b", 2, action)).toBe(false);
  expect(isProviderPending(actionA, "workspace-a", 1, action)).toBe(true);
});
