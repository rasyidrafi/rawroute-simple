export type WorkspaceStatus = "active" | "deleting";

export type Workspace = {
  id: string;
  name: string;
  isDefault: boolean;
  status: WorkspaceStatus;
  createdAt: number;
  updatedAt: number;
};

type ErrorBody = { error?: unknown; message?: unknown };

export class WorkspaceApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WorkspaceApiError(
      response.ok
        ? "The workspace service returned invalid JSON."
        : `Workspace request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  if (!response.ok) {
    const error = body as ErrorBody | null;
    throw new WorkspaceApiError(
      typeof error?.error === "string"
        ? error.error
        : typeof error?.message === "string"
          ? error.message
          : `Workspace request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      credentials: "same-origin",
      ...init,
    }),
  );
}

export const workspaceApi = {
  async list(signal?: AbortSignal): Promise<Workspace[]> {
    const body = await request<{ workspaces?: unknown }>("/api/workspaces", { signal });
    if (!Array.isArray(body.workspaces)) {
      throw new WorkspaceApiError("The workspace service returned an invalid list.", 502);
    }
    return body.workspaces as Workspace[];
  },

  async create(name: string): Promise<Workspace> {
    const body = await request<{ workspace?: unknown }>("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!body.workspace || typeof body.workspace !== "object") {
      throw new WorkspaceApiError("The workspace service returned an invalid workspace.", 502);
    }
    return body.workspace as Workspace;
  },

  async rename(workspaceId: string, name: string): Promise<Workspace> {
    const body = await request<{ workspace?: unknown }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!body.workspace || typeof body.workspace !== "object") {
      throw new WorkspaceApiError("The workspace service returned an invalid workspace.", 502);
    }
    return body.workspace as Workspace;
  },

  async remove(workspaceId: string, confirmation: string): Promise<void> {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    if (response.status === 204) return;
    await readJson<unknown>(response);
  },
};

/**
 * Contract for the next workspace-scoped resource slice. Callers must capture
 * and pass the workspace ID; there is intentionally no implicit active scope.
 */
export function workspaceScopedRequest(workspaceId: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("X-RawRoute-Workspace-Id", workspaceId);
  return { ...init, headers, credentials: "same-origin" };
}

export function workspaceScopedFetch(workspaceId: string, input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, workspaceScopedRequest(workspaceId, init));
}
