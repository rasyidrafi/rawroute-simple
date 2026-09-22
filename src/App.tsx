import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import "./index.css";

type HelloResponse = {
  message: string;
};

export function App() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Bun fullstack starter</p>
        <h1 id="page-title">One server.<br />React on the edge.</h1>
        <p className="intro">
          Bun serves this page, bundles the React client, and handles the API request below.
        </p>
        <div className="api-card" aria-live="polite">
          <div className="api-card-heading">
            <span className={`status-dot ${error ? "is-error" : ""}`} />
            <span>GET /api/hello</span>
          </div>
          {isLoading && <p className="api-result">Calling the Bun API...</p>}
          {message && <p className="api-result">{message}</p>}
          {error && <p className="api-result error">{error}</p>}
        </div>
        <Button type="button" className="mt-6">shadcn Button</Button>
        <p className="footer-note">HTML import + Bun.serve + React</p>
      </section>
    </main>
  );
}

export default App;
