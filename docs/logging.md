# Console logging

The Console Log page reads real events from `GET /api/logs`. Live mode polls every
three seconds while the page is visible; severity/search and Copy use the retained
snapshot. Clear (`DELETE /api/logs`) clears history for all administrators and
records a `logs.cleared` event. All log endpoints require a non-default administrator
session; mutations require a matching origin. Responses are not cacheable.

## Retention and scope

The server retains the newest 2,000 entries in a bounded, process-local memory
buffer. History survives dashboard navigation and page refreshes, but not a server
restart. This is an operational console, not a durable audit trail. Multiple server
processes have separate histories. Eviction counts are displayed in the UI.

Server events cover auth requests, credential reads, CLIProxy management requests,
lifecycle operations and automatic recovery, gateway responses, startup/shutdown,
and database health-check failures. Successful background status polls are quiet.
Gateway events include allowlisted endpoint names and HTTP methods; unknown paths
are labeled `other`, and queries are omitted. Gateway timing measures time to
response headers, not streamed response completion;
the logger never consumes or buffers the response stream.

Browser reports cover committed provider/model/credential, Codex, routing, budget,
and pricing edits; navigation; clipboard actions; local budget settings; console
controls; and runtime errors. Demo state changes are explicitly labeled **local
demo**. Browser events are best-effort, client-reported observations, not authoritative
server-side confirmations. Reports are bounded to 1 KiB and 120/minute per process.
Search terms, drafts, keystrokes and secret values are never captured.

## Add logging to a feature

For backend work, import `logs` from `src/lib/logging/store.ts`:

```ts
logs.record(
  { source: "router", event: "router.rules.saved", message: "Routing rules saved" },
  "INFO",
  { updated: 3 },
);
```

Use stable dot-separated event names and constant developer-authored messages.
Levels are `INFO`, `WARN`, and `ERROR`. Metadata permits only finite numbers,
booleans, and null; sensitive keys and unsupported values are discarded. Never
interpolate user input or exception text into source, event, message, or metadata
keys. Do not pass credentials, cookies, headers, request/response bodies, prompts,
or URLs. The logger cannot identify arbitrary secrets in free-form messages.

Register new HTTP routes with `tracked(...)` in `src/index.ts` (backed by
`loggedRequest`). It preserves the original response and logs status, success,
and duration even for rejected requests. Use `failuresOnly = true` for background
polling. Log feature-specific milestones within the service itself when needed.

For browser actions, extend `browserEvents` in `src/lib/logging/types.ts` with a
constant message, then call `reportEvent(eventName)` after the action. The server
uses its own catalog; it accepts no browser-supplied messages or arbitrary metadata.
Reports always carry `origin=browser`. For local collections, use `useLoggedState`
to report committed additions/removals/updates/reordering without sending values.
When a feature gains a backend, move authoritative logging into its server handler.

The store and request wrapper avoid database or CLIProxy lifecycle dependencies, allowing
future persistence or additional sinks to be implemented behind the store API.
