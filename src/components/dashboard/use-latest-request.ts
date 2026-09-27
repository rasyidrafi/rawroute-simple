import { useEffect, useRef } from "react";

export type LatestRequest = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export type LatestRequestGate = {
  begin: () => LatestRequest;
  invalidate: () => void;
};

export type LatestRequestHandlers<T> = {
  onStart?: () => void;
  onSuccess: (value: T) => void;
  onError: (reason: unknown) => void;
  onFinally?: () => void;
};

/**
 * Makes one request result authoritative. Starting a request also cancels the
 * prior one; invalidating is used when a component unmounts.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let generation = 0;
  let controller: AbortController | undefined;

  return {
    begin() {
      controller?.abort();
      const requestGeneration = ++generation;
      const requestController = new AbortController();
      controller = requestController;

      return {
        signal: requestController.signal,
        isCurrent: () => generation === requestGeneration && !requestController.signal.aborted,
      };
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = undefined;
    },
  };
}

/** Runs state transitions only for the latest request generation. */
export async function runLatestRequest<T>(
  gate: LatestRequestGate,
  load: (signal: AbortSignal) => Promise<T>,
  handlers: LatestRequestHandlers<T>,
): Promise<void> {
  const request = gate.begin();
  handlers.onStart?.();
  try {
    const value = await load(request.signal);
    if (request.isCurrent()) handlers.onSuccess(value);
  } catch (reason) {
    if (request.isCurrent()) handlers.onError(reason);
  } finally {
    if (request.isCurrent()) handlers.onFinally?.();
  }
}

export function useLatestRequest(): LatestRequestGate {
  const gate = useRef<LatestRequestGate | null>(null);
  if (!gate.current) gate.current = createLatestRequestGate();

  useEffect(() => () => gate.current?.invalidate(), []);
  return gate.current;
}
