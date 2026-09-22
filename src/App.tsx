import { useEffect, useState } from "react";
import { DbConnection } from "./module_bindings/index.js";
import "./index.css";

// Bun inlines literal process.env.* references into browser bundles when the
// matching [serve.static].env rule is configured in bunfig.toml.
const HOST = process.env.BUN_PUBLIC_SPACETIMEDB_HOST ?? "ws://localhost:3000";
const DB_NAME = process.env.BUN_PUBLIC_SPACETIMEDB_DB_NAME ?? "rawroute-simple";

export function App() {
  const [connection, setConnection] = useState<DbConnection | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("Connecting to SpacetimeDB…");

  useEffect(() => {
    const conn = DbConnection.builder()
      .withUri(HOST).withDatabaseName(DB_NAME)
      .withToken(localStorage.getItem("spacetimedb-token") ?? undefined)
      .onConnect((connected, _identity, token) => {
        localStorage.setItem("spacetimedb-token", token);
        setConnection(connected); setStatus("Connected");
        connected.subscriptionBuilder().onApplied(ctx => {
          setPeople([...ctx.db.person.iter()].map(person => person.name));
        }).subscribeToAllTables();
        connected.db.person.onInsert(() => setPeople([...connected.db.person.iter()].map(person => person.name)));
      })
      .onConnectError((_ctx, error) => setStatus(`Connection error: ${error.message}`))
      .onDisconnect(() => setStatus("Disconnected"))
      .build();
    return () => conn.disconnect();
  }, []);

  function addPerson(event: React.FormEvent) {
    event.preventDefault(); const value = name.trim();
    if (!value || !connection) return;
    connection.reducers.add({ name: value }); setName("");
  }

  return <main className="app">
    <p className="eyebrow">Bun · React · SpacetimeDB</p>
    <h1>Realtime app foundation</h1><p className="status">{status}</p>
    <form onSubmit={addPerson} className="person-form">
      <input value={name} onChange={event => setName(event.target.value)} placeholder="Your name" />
      <button type="submit" disabled={!connection}>Add person</button>
    </form>
    <section className="people"><h2>People ({people.length})</h2>
      {people.length === 0 ? <p>No people yet.</p> : <ul>{people.map(person => <li key={person}>{person}</li>)}</ul>}
    </section>
  </main>;
}

export default App;
