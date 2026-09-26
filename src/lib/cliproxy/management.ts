import { CLIPROXY_HOST, CLIPROXY_PORT, getDataRoot } from "./service";
import { getServicePaths, readSecret } from "./store";

export type CliproxyManagementTransport = (path: string, init?: RequestInit) => Promise<Response>;

let testTransport: CliproxyManagementTransport | undefined;

/** Test-only seam; production always uses the authenticated loopback transport. */
export function setCliproxyManagementTransportForTesting(transport: CliproxyManagementTransport): () => void {
  const previous = testTransport;
  testTransport = transport;
  return () => { testTransport = previous; };
}

export async function cliproxyManagement(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/v0/management/") || path.includes("//") || path.includes("?")) {
    throw new Error("Invalid CLIProxy management path.");
  }
  if (testTransport) return await testTransport(path, init);
  const headers = new Headers(init.headers);
  headers.set("x-management-key", readSecret(getServicePaths(getDataRoot()).managementKey));
  return await fetch(`http://${CLIPROXY_HOST}:${CLIPROXY_PORT}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(3_000),
  });
}

export async function cliproxyManagementJson<T>(path: string, init: RequestInit = {}): Promise<{ response: Response; data: T | undefined }> {
  const response = await cliproxyManagement(path, init);
  const data = await response.json().catch(() => undefined) as T | undefined;
  return { response, data };
}
