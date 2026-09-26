import { useCallback, useEffect, useRef, useState } from "react";
import type { LogSnapshot } from "@/lib/logging/types";

export function useConsoleLogs(live: boolean, scope: { kind: "workspace"; workspaceId: string } | { kind: "global" }) {
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [error, setError] = useState<{ scopeKey: string; message: string } | null>(null);
  const [clearError, setClearError] = useState<{ scopeKey: string; message: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "clearing">("idle");
  const pending = useRef<{ controller: AbortController; method: string } | null>(null);

  const scopeKey = scope.kind === "workspace" ? `workspace:${scope.workspaceId}` : "global";
  const endpoint = scope.kind === "workspace" ? "/api/logs" : "/api/logs/global";
  const workspaceId = scope.kind === "workspace" ? scope.workspaceId : null;
  const load = useCallback(async (method: "GET" | "DELETE" = "GET") => {
    if (method === "GET" && pending.current) return false;
    pending.current?.controller.abort();
    const controller = new AbortController();
    pending.current = { controller, method };
    setPhase(method === "DELETE" ? "clearing" : "loading");
    if (method === "DELETE") setClearError(null);
    try {
      const response = await fetch(endpoint, {
        method, credentials: "same-origin", cache: "no-store",
        headers: workspaceId ? { "X-RawRoute-Workspace-Id": workspaceId } : undefined,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        throw new Error(response.status === 401 ? "Your session expired. Sign in again to view logs."
          : response.status === 403 ? "Access denied. Sign in with an updated administrator password."
          : `Unable to ${method === "DELETE" ? "clear" : "load"} console logs (HTTP ${response.status}).`);
      }
      const data = await response.json() as LogSnapshot;
      if (!Array.isArray(data.entries) || typeof data.capacity !== "number") throw new Error("Invalid console log response.");
      if (pending.current?.controller !== controller) return false;
      setSnapshot(data);
      setError(null);
      if (method === "DELETE") setClearError(null);
      return true;
    } catch (cause) {
      if (pending.current?.controller === controller && !controller.signal.aborted) {
        const requestError = cause instanceof Error ? cause.message : "Unable to load console logs.";
        setError({ scopeKey, message: requestError });
        if (method === "DELETE") setClearError({ scopeKey, message: requestError });
      }
      return false;
    } finally {
      if (pending.current?.controller === controller) {
        pending.current = null;
        setPhase("idle");
      }
    }
  }, [endpoint, scopeKey, workspaceId]);

  useEffect(() => {
    void load();
    return () => { pending.current?.controller.abort(); pending.current = null; };
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 3_000);
    return () => clearInterval(timer);
  }, [live, load]);

  const currentSnapshot = snapshot?.scope === scope.kind && snapshot.workspaceId === workspaceId ? snapshot : null;
  const currentError = error?.scopeKey === scopeKey ? error.message : null;
  const currentClearError = clearError?.scopeKey === scopeKey ? clearError.message : null;
  return {
    snapshot: currentSnapshot,
    error: currentError,
    clearError: currentClearError,
    busy: phase !== "idle",
    isInitialLoading: currentSnapshot === null && phase === "loading",
    isRefreshing: phase === "loading",
    isClearing: phase === "clearing",
    refresh: () => load(),
    clear: () => load("DELETE"),
  };
}
