# Workspaces

`workspaces` is persisted in the application libSQL database. Startup creates the
immutable `default` / `Default` workspace once. Other workspaces have UUIDv4 IDs,
an active/deleting state, and case-insensitive (NFKC-normalized) unique names.

All workspace-management endpoints use the global administrator scope and ignore
`X-RawRoute-Workspace-Id`:

- `GET /api/workspaces` returns `{ "workspaces": Workspace[] }`.
- `POST /api/workspaces` accepts `{ "name": string }` and returns
  `{ "workspace": Workspace }` (201).
- `PATCH /api/workspaces/:workspaceId` accepts `{ "name": string }` and returns
  `{ "workspace": Workspace }`.
- `DELETE /api/workspaces/:workspaceId` accepts `{ "confirmation": string }`
  and returns 204. The confirmation must exactly match the current display name.

These APIs require an authenticated administrator whose initial default password
has been changed. Mutations require the configured same origin and JSON bodies.
Names are 1–80 Unicode code points after trimming; controls are rejected.

Future workspace-scoped APIs must call `requireWorkspaceRequestScope(request)`
from `src/lib/request-scope.ts`. It requires a valid active
`X-RawRoute-Workspace-Id` and returns 400 for a missing/invalid scope, 404 for an
unknown workspace, and 409 while deletion is in progress. It never falls back to
Default. Pass `scope.workspace.id` explicitly to repositories. The optional
`runWithWorkspaceScope` helper is only for cross-cutting process-local concerns;
it also has no implicit Default.

Global settings, authentication, CLIProxy lifecycle, and native `/v1` remain
global and must not infer a workspace from this header. Native `/v1` is legacy
and is not workspace-isolated. Provider credentials, OAuth accounts, and gateway
keys are future scoped-resource work. The in-memory console buffer is scoped now:
`/api/logs` requires an active workspace header, while `/api/logs/global` is the
explicit global system view.

The provider, Codex, routing, budget, and pricing controls shown in the dashboard
are separate browser-memory fixtures for each selected workspace. They survive
page navigation and switching back during that browser session, but they do not
survive a browser reload and are not server-side isolation. The selected workspace
ID is the only browser-persisted workspace preference. Do not represent these
fixtures as persisted provider or OAuth configuration.

## Contract for future scoped resources

- A repository method that reads or writes workspace data takes a concrete
  `workspaceId`; it does not obtain a default from UI state, request context, or
  `currentWorkspaceScope()`. Request handlers validate the header first with
  `requireWorkspaceRequestScope(request)` and pass its ID through every layer.
- Workspace-owned tables include a non-null `workspace_id`. Use composite keys or
  unique constraints beginning with `workspace_id` where a value is only unique
  within a workspace. Child relationships must include the same workspace ID (or
  use composite foreign keys) so a row cannot reference an owner in another
  workspace. Queries, updates, and deletes include `workspace_id` in their
  predicates; an ID alone is never sufficient authorization.
- There is no ambient cache fallback. If a scoped cache is needed, its key starts
  with the workspace ID, its size and lifetime are bounded, and each successful
  mutation explicitly invalidates or replaces that workspace's entry. Workspace
  deletion must invalidate all entries for that ID through its deletion extension.
  Do not add speculative caches before a measured need and an invalidation plan.
- A background job stores and carries its workspace ID explicitly. Before doing
  work it resolves that workspace as active, and deletion either cancels/drains
  the job or makes its idempotent cleanup part of a registered deletion extension.
  `AsyncLocalStorage` scope is not durable job ownership.
- Provider credentials and OAuth grants need an explicit durable ownership model
  before they become scoped: workspace ID, credential/grant IDs, secret handling,
  revocation, migration, and deletion cleanup. A shared CLIProxy transport has
  not been proven safe for tenant/workspace isolation. Until that work exists,
  CLIProxy lifecycle, its credentials, and native `/v1` are global only.

Future stores that own workspace data must register an independent, idempotent cleanup handler
with `registerWorkspaceDeletionExtension` before creating workspace-owned rows.
Deletion claims the row atomically, blocks concurrent mutation, runs the handlers,
and removes the workspace only on success. A cleanup or final-delete failure
restores `active` only when the request still owns its durable claim. Startup
recovers claims left by a terminated process before accepting HTTP requests, so
the same deletion can be retried safely.
