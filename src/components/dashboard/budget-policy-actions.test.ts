import { expect, test } from "bun:test";
import { runBudgetPolicyAction } from "./budget-policy-actions";

test("a confirmation opened before a failed refresh cannot submit a stale budget policy", () => {
  let mutations = 0;
  let closed = 0;
  const mutate = () => {
    mutations += 1;
  };
  const close = () => {
    closed += 1;
  };

  expect(
    runBudgetPolicyAction({ hasData: true, loading: true }, close, mutate),
  ).toBe(false);
  expect(
    runBudgetPolicyAction(
      { hasData: true, loading: false, error: "Service unavailable" },
      close,
      mutate,
    ),
  ).toBe(false);
  expect({ mutations, closed }).toEqual({ mutations: 0, closed: 2 });

  expect(
    runBudgetPolicyAction({ hasData: true, loading: false }, close, mutate),
  ).toBe(true);
  expect({ mutations, closed }).toEqual({ mutations: 1, closed: 2 });
});
