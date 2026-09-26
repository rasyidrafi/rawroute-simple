# Console logging

The workspace Console Log page reads real events from `GET /api/logs` and sends the
active `X-RawRoute-Workspace-Id` header. It clears only that workspace with
`DELETE /api/logs`; the retained `logs.cleared` event is also workspace-scoped.
The standalone global System Logs page reads the separate system view at
`GET /api/logs/global` and clears only that view with `DELETE /api/logs/global`.

There is no implicit Default workspace for `/api/logs`. A missing or malformed
workspace header is rejected (400), an unknown workspace is 404, and a workspace
being deleted is unavailable (409). The explicit global endpoint deliberately
ignores that header. All log endpoints require a non-default administrator
session; mutation requests require the configured matching origin. Responses are
not cacheable. Live mode polls every three seconds while visible, and Copy,
severity filters, and search operate on the loaded scope snapshot.

## Retention and scope

The server retains the newest 2,000 entries per scope in bounded, process-local
memory: one global buffer and independently keyed workspace buffers. All buffers
together retain at most 10,000 entries. The store keeps no more than 128 workspace
buffers and 128 workspace-admission records; least-recently-used workspace buffers
may therefore expire before their per-buffer capacity. History survives dashboard
navigation and page refreshes, but not a server restart. This is an operational
console, not a durable audit trail. Multiple server processes have separate
histories. Per-snapshot eviction counts are displayed in the UI.

Workspace log writes are admitted against the active workspace before recording.
Workspace deletion blocks new admitted writes, waits for admitted writes to drain,
then the registered `workspace-console-logs` deletion extension removes that
workspace's buffer and invalidates its write admission. A stale request cannot
recreate that deleted buffer. Global logs are intentionally independent of this
deletion flow.

Server events cover auth requests, CLIProxy management requests, lifecycle
operations and automatic recovery, gateway authentication/routing responses,
startup/shutdown, and database health-check failures. Successful background
status polls are quiet. A valid gateway key writes its allowlisted endpoint and
method only to that key's workspace buffer. Rejected or unavailable gateway
authentication writes a constant event to the global buffer without a workspace.
Queries, credential values, headers, and arbitrary paths are never logged.

Browser reports are posted to `POST /api/logs/events`. The server chooses their
scope from its closed event/page catalog, not from a browser-supplied workspace ID.
Workspace events require the captured active workspace ID in the request header and
are admitted like other workspace writes. Endpoint & Key is a workspace page, so
its create, rename, reveal, delete, and copy events are scoped to the key owner and
contain no key values. Global-page events and unscoped runtime errors are written
only to the global buffer. A runtime error with a validated workspace page is scoped
to that page's workspace. An event/page combination that does not match the catalog
is rejected rather than reassigned.

Reports cover committed provider/model/credential, Codex, routing, budget, pricing,
and persisted gateway-key actions; navigation; clipboard actions; local budget
settings; console controls; and runtime errors. Demo state changes are explicitly
labeled **local demo**. Browser events are best-effort, client-reported observations,
not authoritative server-side confirmations. Reports are bounded to 1 KiB and
120/minute per process. Search terms, drafts, keystrokes and secret values are never
captured.

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

`tracked(...)` in `src/index.ts` is for currently registered global management
routes. It uses `loggedRequest` with explicit global scope, preserves the original
response, and logs status, success, and duration even for rejected requests. Use
`failuresOnly = true` for background polling.

A future workspace API must first call `requireWorkspaceRequestScope(request)`,
capture its workspace ID, and run its scoped handler/log wrapper inside
`runWithWorkspaceScope(scope, ...)`. Use `loggedRequest(..., { scope:
"workspace" })` only there; it captures the scope at request start and obtains a
workspace write admission before recording. Pass the captured ID explicitly to
repositories regardless of logging. Do not use `tracked`, ambient UI selection, or
an absent scope to place a resource log in Default.

For browser actions, extend `browserEvents` in `src/lib/logging/types.ts` with a
constant message, then call `reportEvent(eventName, { page, workspaceId })` after
the action. Capture `workspaceId` when the action starts; the client sends it only
as the scope header, never in the report body. The server uses its own catalog and
accepts no browser-supplied messages, arbitrary metadata, or scope assignment.
Reports always carry `origin=browser`. For local collections, use `useLoggedState`
to report committed additions/removals/updates/reordering without sending values.
When a feature gains a backend, move authoritative logging into its server handler.

The store and request wrapper avoid database or CLIProxy lifecycle dependencies, allowing
future persistence or additional sinks to be implemented behind the store API.
