import { expect, test } from "bun:test";
import { createLatestRequestGate, runLatestRequest } from "./use-latest-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

test("a later controlled request is the only request allowed to settle UI state", async () => {
  const gate = createLatestRequestGate();
  const week = deferred<string>();
  const today = deferred<string>();
  let data: string | undefined;
  let error: string | undefined;
  let loading = false;

  const handlers = {
    onStart: () => { loading = true; error = undefined; },
    onSuccess: (next: string) => { data = next; },
    onError: (reason: unknown) => { error = String(reason); },
    onFinally: () => { loading = false; },
  };
  let weekSignal: AbortSignal | undefined;
  const weekLoad = runLatestRequest(gate, (signal) => { weekSignal = signal; return week.promise; }, handlers);
  const todayLoad = runLatestRequest(gate, () => today.promise, handlers);
  expect(weekSignal?.aborted).toBe(true);
  today.resolve("today");
  await todayLoad;
  expect({ data, error, loading }).toEqual({ data: "today", error: undefined, loading: false });

  week.reject(new Error("week failed after replacement"));
  await weekLoad;
  expect({ data, error, loading }).toEqual({ data: "today", error: undefined, loading: false });
});

test("invalidating a controlled request aborts it and prevents late settlement", async () => {
  const gate = createLatestRequestGate();
  const result = deferred<string>();
  let data: string | undefined;
  let loading = false;
  let signal: AbortSignal | undefined;
  const load = runLatestRequest(gate, (nextSignal) => { signal = nextSignal; return result.promise; }, {
    onStart: () => { loading = true; },
    onSuccess: (next) => { data = next; },
    onError: () => {},
    onFinally: () => { loading = false; },
  });

  gate.invalidate();
  expect(signal?.aborted).toBe(true);
  result.resolve("late result");
  await load;
  expect({ data, loading }).toEqual({ data: undefined, loading: true });
});
