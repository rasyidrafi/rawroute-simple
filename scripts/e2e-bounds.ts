export class E2eDeadlineError extends Error {
  constructor(message: string) { super(message); this.name = "E2eDeadlineError"; }
}

function combinedSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([timeout, parent]) : timeout;
}

function rejectedOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new E2eDeadlineError("E2E operation aborted"));
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new E2eDeadlineError("E2E operation aborted")), { once: true }));
}

export async function fetchBounded(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs: number, parent?: AbortSignal): Promise<Response> {
  const signal = combinedSignal(timeoutMs, parent);
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw new E2eDeadlineError("E2E fetch exceeded its deadline");
    throw error;
  }
}

/** Consume streamed bodies under a deadline; `Response.text()` cannot be aborted once started. */
export async function textBounded(response: Pick<Response, "body">, timeoutMs: number, parent?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const signal = combinedSignal(timeoutMs, parent);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), rejectedOnAbort(signal)]);
      if (part.done) break;
      length += part.value.byteLength;
      chunks.push(part.value);
    }
  } catch (error) {
    if (signal.aborted || error instanceof E2eDeadlineError) throw new E2eDeadlineError("E2E response body exceeded its deadline");
    throw error;
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function jsonBounded<T>(response: Response, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  return JSON.parse(await textBounded(response, timeoutMs, parent)) as T;
}

/** The deadline wins even if a future harness operation accidentally ignores its signal. */
export async function withSuiteWatchdog<T>(
  task: (signal: AbortSignal) => Promise<T>,
  cleanup: () => Promise<void>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  const timeoutError = rejectedOnAbort(timeout).then(() => { controller.abort(new E2eDeadlineError("E2E suite deadline exceeded")); throw new E2eDeadlineError("E2E suite deadline exceeded"); });
  try {
    return await Promise.race([task(controller.signal), timeoutError]);
  } finally {
    controller.abort(new E2eDeadlineError("E2E suite finished"));
    await cleanup();
  }
}
