import { useEffect, useState, type FormEvent } from "react";
import { LoginForm } from "@/components/login-form";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import "./index.css";

type AuthResponse = {
  authenticated?: boolean;
  isDefaultPassword?: boolean;
  defaultPasswordHint?: string | null;
  error?: string;
};
type HelloResponse = { message: string };

export function App() {
  const [serviceMessage, setServiceMessage] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [defaultPasswordHint, setDefaultPasswordHint] = useState<string | null>(
    null,
  );
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/hello", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Request failed with ${response.status}`);
        return response.json() as Promise<HelloResponse>;
      })
      .then((data) => setServiceMessage(data.message))
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setServiceMessage(requestError instanceof Error ? requestError.message : "Bun API unavailable");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/auth/status", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Request failed with ${response.status}`);
        return response.json() as Promise<AuthResponse>;
      })
      .then((data) => {
        setIsAuthenticated(data.authenticated === true);
        setIsDefaultPassword(data.isDefaultPassword === true);
        setDefaultPasswordHint(data.defaultPasswordHint ?? null);
      })
      .catch((fetchError) => {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        )
          return;
        setAuthError(
          fetchError instanceof Error
            ? fetchError.message
            : "Unable to load session",
        );
      })
      .finally(() => setIsSessionLoading(false));

    return () => controller.abort();
  }, []);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError(null);
    setIsAuthLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: authPassword }),
      });
      const data = (await response.json()) as AuthResponse;

      if (!response.ok) {
        throw new Error(data.error ?? `Request failed with ${response.status}`);
      }

      setIsAuthenticated(data.authenticated === true);
      setIsDefaultPassword(data.isDefaultPassword === true);
      setDefaultPasswordHint(data.defaultPasswordHint ?? null);
      setAuthPassword("");
    } catch (authRequestError) {
      setAuthError(
        authRequestError instanceof Error
          ? authRequestError.message
          : "Authentication failed",
      );
    } finally {
      setIsAuthLoading(false);
    }
  }

  async function handleLogout() {
    setAuthError(null);
    setIsAuthLoading(true);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(`Request failed with ${response.status}`);
      setIsAuthenticated(false);
      setIsDefaultPassword(false);
      setDefaultPasswordHint(null);
    } catch (logoutError) {
      setAuthError(
        logoutError instanceof Error ? logoutError.message : "Logout failed",
      );
    } finally {
      setIsAuthLoading(false);
    }
  }

  if (isAuthenticated) {
    return <DashboardShell onLogout={handleLogout} isDefaultPassword={isDefaultPassword} />;
  }

  return (
    <main className="relative flex min-h-svh w-full items-center justify-center overflow-hidden bg-[#f3f0e8] p-6 dark:bg-slate-950 md:p-10">
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,#94a3b822_1px,transparent_1px),linear-gradient(to_bottom,#94a3b822_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="pointer-events-none absolute -left-32 top-12 size-96 rounded-full bg-amber-300/30 blur-3xl" />
      <section className="relative w-full max-w-sm" aria-label="Password authentication">
        <p className="sr-only" role="status" aria-live="polite">{serviceMessage}</p>
        {isSessionLoading ? (
          <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground shadow-xl">
            Loading session...
          </div>
        ) : (
          <LoginForm
            password={authPassword}
            error={authError}
            isLoading={isAuthLoading}
            defaultPasswordHint={defaultPasswordHint}
            onPasswordChange={(event) => setAuthPassword(event.target.value)}
            onSubmit={handleAuthSubmit}
          />
        )}
      </section>
    </main>
  );
}

export default App;
