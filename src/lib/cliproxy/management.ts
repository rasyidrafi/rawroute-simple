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
  // Callers pass only fixed management route names. Query values are always
  // URL-encoded by their owning repository (for example, a mapped auth file),
  // never copied from a public request.
  let parsed: URL;
  try { parsed = new URL(path, "http://cliproxy.invalid"); } catch { throw new Error("Invalid CLIProxy management path."); }
  if (!parsed.pathname.startsWith("/v0/management/") || parsed.pathname.includes("//") || parsed.username || parsed.password) {
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
