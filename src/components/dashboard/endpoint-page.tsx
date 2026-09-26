"use client";

import { useState } from "react";
import { reportEvent } from "@/lib/logging/client";
import { CopyIcon, RefreshCwIcon, RouteIcon } from "lucide-react";
import { copy, notify, Page } from "@/components/dashboard/page-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function EndpointKeys() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`;
  async function revealKey() {
    if (keyVisible) {
      setKeyVisible(false);
      setApiKey(null);
      return;
    }
    if (apiKey) {
      setKeyVisible(true);
      return;
    }
    setKeyLoading(true);
    setKeyError(null);
    try {
      const response = await fetch("/api/cliproxy/key", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(
          response.ok
            ? "The key endpoint returned invalid JSON."
            : `Could not load the key (HTTP ${response.status}).`,
        );
      }
      if (!response.ok) {
        const body = payload as { error?: unknown; message?: unknown } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : typeof body?.message === "string"
              ? body.message
              : `Could not load the key (HTTP ${response.status}).`,
        );
      }
      const body = payload as { key?: unknown; apiKey?: unknown } | string | null;
      const value =
        typeof body === "string"
          ? body
          : typeof body?.key === "string"
            ? body.key
            : typeof body?.apiKey === "string"
              ? body.apiKey
              : null;
      if (!value) throw new Error("The key endpoint response did not include an API key.");
      setApiKey(value);
      setKeyVisible(true);
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : "Could not load the CLIProxyAPI key.");
    } finally {
      setKeyLoading(false);
    }
  }
  async function copyNativeKey() {
    if (!apiKey) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(apiKey);
      reportEvent("gateway-key.copied");
      notify("CLIProxyAPI key copied");
    } catch {
      reportEvent("dashboard.copy-failed", { page: "endpoint" });
      setKeyError("Clipboard access failed. Reveal the key to select and copy it manually.");
    }
  }
  return (
    <Page>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <RouteIcon className="size-5" />
            <CardTitle>Legacy global API endpoint</CardTitle>
          </div>
          <CardDescription>
            OpenAI-compatible base URL on this same origin. This legacy native endpoint is global, not workspace-isolated, and forwards to CLIProxyAPI when the managed service is running.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <Badge variant="secondary">OpenAI API</Badge>
            <code className="min-w-0 flex-1 truncate text-sm">
              {endpoint}
            </code>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Copy API endpoint"
              onClick={() => copy(endpoint, "Endpoint copied", { page: "endpoint" })}
            >
              <CopyIcon />
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Legacy global CLIProxyAPI key</CardTitle>
          <CardDescription>
            Global native proxy credential for authenticated API requests. It is administrator-only, fetched on demand, and has no workspace attribution.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Administrator-managed global credential</p>
                <code className="mt-1 block break-all text-xs text-muted-foreground">
                  {apiKey && keyVisible ? apiKey : "Hidden until explicitly revealed"}
                </code>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" onClick={() => void revealKey()} disabled={keyLoading}>
                  {keyLoading ? <RefreshCwIcon className="animate-spin" /> : null}
                  {keyVisible ? "Hide key" : apiKey ? "Reveal key" : "Load & reveal"}
                </Button>
                {apiKey && keyVisible && (
                  <Button variant="outline" onClick={() => void copyNativeKey()}>
                    <CopyIcon /> Copy
                  </Button>
                )}
              </div>
            </div>
            {keyError && (
              <p role="alert" className="text-sm text-destructive">{keyError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Workspace gateway keys are not available yet. Use this legacy global native key as a Bearer token with the endpoint above.
            </p>
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}
