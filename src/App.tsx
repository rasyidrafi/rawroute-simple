import { useEffect, useState, type FormEvent } from "react";
import { LoginForm } from "@/components/login-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import "./index.css";

type HelloResponse = {
  message: string;
};

type AuthResponse = {
  authenticated?: boolean;
  isDefaultPassword?: boolean;
  defaultPasswordHint?: string | null;
  error?: string;
};

export function App() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [defaultPasswordHint, setDefaultPasswordHint] = useState<string | null>(null);
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/hello", { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Request failed with ${response.status}`);
        return response.json() as Promise<HelloResponse>;
      })
      .then(data => setMessage(data.message))
      .catch(fetchError => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : "Request failed");
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/auth/status", { credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Request failed with ${response.status}`);
        return response.json() as Promise<AuthResponse>;
      })
      .then(data => {
        setIsAuthenticated(data.authenticated === true);
        setIsDefaultPassword(data.isDefaultPassword === true);
        setDefaultPasswordHint(data.defaultPasswordHint ?? null);
      })
      .catch(fetchError => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setAuthError(fetchError instanceof Error ? fetchError.message : "Unable to load session");
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
        authRequestError instanceof Error ? authRequestError.message : "Authentication failed",
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
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      setIsAuthenticated(false);
      setIsDefaultPassword(false);
      setDefaultPasswordHint(null);
    } catch (logoutError) {
      setAuthError(logoutError instanceof Error ? logoutError.message : "Logout failed");
    } finally {
      setIsAuthLoading(false);
    }
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto grid min-h-svh w-full max-w-6xl items-center gap-12 px-6 py-12 lg:grid-cols-[1fr_420px] lg:px-12">
        <section className="hidden lg:block" aria-labelledby="page-title">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary">
            Bun fullstack starter
          </p>
          <h1 id="page-title" className="mt-6 max-w-xl text-6xl font-semibold tracking-tight">
            One server.
            <br />
            React on the edge.
          </h1>
          <p className="mt-6 max-w-lg text-lg text-muted-foreground">
            Bun serves this page, bundles the React client, and handles authentication with a
            Turso-compatible libSQL database.
          </p>
          <Card className="mt-10 max-w-md">
            <CardHeader>
              <CardTitle>GET /api/hello</CardTitle>
              <CardDescription>Server status from the Bun backend.</CardDescription>
            </CardHeader>
            <CardContent aria-live="polite">
              {isLoading && <p className="text-sm text-muted-foreground">Calling the Bun API...</p>}
              {message && <p className="text-sm text-primary">{message}</p>}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </CardContent>
          </Card>
        </section>
        <section className="flex w-full justify-center" aria-label="Password authentication">
          {isSessionLoading ? (
            <Card className="w-full max-w-sm">
              <CardContent>
                <p className="py-8 text-center text-sm text-muted-foreground">Loading session...</p>
              </CardContent>
            </Card>
          ) : isAuthenticated ? (
            <Card className="w-full max-w-sm" aria-live="polite">
              <CardHeader>
                <CardTitle>You&apos;re signed in</CardTitle>
                <CardDescription>Password session active.</CardDescription>
              </CardHeader>
              <CardContent>
                {isDefaultPassword && (
                  <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">
                    You are using the default password. Change it before exposing this app publicly.
                  </p>
                )}
                <Button type="button" className="w-full" onClick={handleLogout} disabled={isAuthLoading}>
                  {isAuthLoading ? "Signing out..." : "Sign out"}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <LoginForm
              className="w-full max-w-sm"
              password={authPassword}
              error={authError}
              isLoading={isAuthLoading}
              defaultPasswordHint={defaultPasswordHint}
              onPasswordChange={event => setAuthPassword(event.target.value)}
              onSubmit={handleAuthSubmit}
            />
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
