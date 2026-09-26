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

Global settings, authentication, and CLIProxy lifecycle remain global and must
not infer a workspace from this header. Gateway keys are a persisted workspace resource:
`GET`/`POST /api/gateway-keys`, `PATCH`/`DELETE /api/gateway-keys/:keyId`, and
`POST /api/gateway-keys/:keyId/reveal` all require an active workspace header.
List responses contain metadata only; values are returned only from create and
explicit reveal responses.

## Gateway authentication and key storage

Recognized public `/v1` operations authenticate with either a Bearer credential
or an `X-API-Key` credential. Values are 32–256 printable non-whitespace ASCII
characters. Supplying both forms with different values is rejected with
401; the request's `X-RawRoute-Workspace-Id` never participates in gateway
authentication. A missing, invalid, revoked, deleted, or deleted-workspace key
also receives 401. Database/authentication failures receive 503 and never fall
back to CLIProxy's internal credential.

The allowlist is `GET /v1/models` plus `POST` to `/v1/chat/completions`,
`/v1/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings`,
`/v1/images/generations`, and `/v1/audio/transcriptions`. Other `/v1` paths are
404 and unsupported methods are 405. The `/v1` root is a stable 404 help error.
There is intentionally no wildcard forwarding. Until a provider, credential, and
routing ownership model is implemented, authenticated allowlisted operations
return a no-store 503 error with code `workspace_routing_not_ready`.

Gateway values are SHA-256 hashed for lookup and AES-256-GCM encrypted for
administrator reveal. The 32-byte encryption master is generated once at
`$RAWROUTE_DATA_DIR/gateway-keys/master-key`; its directory is mode 0700 and its
regular file is mode 0600. Back up this master key with the database and restore
them together. If encrypted rows exist and the master key is missing, startup
fails closed instead of generating a replacement. Custom values must be 32–256
printable ASCII characters with no whitespace. Hash uniqueness is global across
all workspaces, so the same value cannot be reused in another workspace.

Deleting a key writes a durable tombstone: it cannot authenticate, list, or
reveal, while its hash and ciphertext remain to preserve global uniqueness and
audit/retry safety. Workspace deletion removes all of that workspace's keys,
including tombstones. Gateway calls take workspace write admission before their
workspace log is written, so deletion drains accepted calls and a stale call
cannot recreate a deleted workspace log buffer.
Provider configuration is a persisted workspace resource. `GET`/`POST
`/api/providers`, `GET`/`PATCH`/`DELETE /api/providers/:providerId`, credential
CRUD/reordering under `/api/providers/:providerId/credentials` (with the
temporary `/api-keys` alias), and model CRUD under
`/api/providers/:providerId/models` require an active workspace header. Provider
and model IDs are stable UUIDs; prefixes and exposed `prefix/suffix` gateway
model IDs are scoped unique. Upstream credential values are AES-256-GCM encrypted
with a separate `$RAWROUTE_DATA_DIR/provider-credentials/master-key`, bound to
the credential, provider, and workspace. Responses only return the
`"__unchanged__"` mask and never disclose a stored upstream secret.

Provider configuration is reconciled through CLIProxy's authenticated private
loopback management API. Entries use a hashed workspace/provider namespace
(`rr-ws-…-p-…`) and a `rr-managed-…` name prefix, independent of the editable
public model prefix. RawRoute replaces only entries carrying both markers,
preserves unmanaged entries, and rejects an unmanaged namespace collision. Shared
management read/modify/write work is serialized with CLIProxy lifecycle operations.
The loopback URL and management secret never appear in browser DTOs or logs.

`openai-chat` projects to `openai-compatibility`; `anthropic-messages` projects to
`claude-api-key`. Only enabled providers, models, and credentials project. Credential
order is highest-priority first and CLIProxy routing is set to `fill-first`.
Anonymous OpenAI-compatible providers are supported. `openai-responses` is stored
but not projected because there is no native Responses executor; its state is
`native-execution-pending`.

Provider mutation responses contain a separate `sync` result, so a committed save
stays successful when CLIProxy is offline. `GET /api/providers/:providerId/sync`
returns `{ "sync": ProviderSyncStatus }`; `POST` to that path retries it with the
same authenticated workspace scope. `ProviderSyncStatus` is `{ providerId,
desiredRevision, appliedRevision, state, error, updatedAt, deleted }`; errors are
sanitised. Provider, credential, and model deletion return `{ "deleted": true,
"sync": ProviderSyncStatus }` (200), rather than an empty 204. A deleted provider's
sync endpoint remains available while its cleanup tombstone exists.
Startup, install, and restart reconcile active providers. Provider/workspace deletion
writes a durable cleanup tombstone before data is removed. Anthropic management
entries do not retain a name in current CLIProxy releases, so RawRoute writes a
SHA-256 fingerprint intent for the schema-retained entry before the management PUT
and verifies it after the write; cleanup only removes a matching fingerprint and
retains its tombstone if ownership cannot be proved. An offline cleanup remains durable for later reconciliation and never
recreates deleted workspace resources. The same scan is registered with CLIProxy's
automatic crash-recovery path and is drained before CLIProxy shutdown.

Projection fingerprints use CLIProxy's retained schema, not arbitrary response
fields: top-level Claude `name` and runtime auth state are excluded, empty generated
proxy URLs are normalized away, nonempty proxy URLs remain significant, and static
header values and Claude API keys are trimmed with empty headers omitted. A newly derived fingerprint is
persisted only after an in-lock read proves the namespace has no unowned entry.

The database is authoritative for provider configuration and projection intent. This
shared CLIProxy transport is administrative configuration isolation, not tenant-
isolated inference routing. Public `/v1` remains deliberately gated and does not use
provider data.

The in-memory console buffer is scoped now: `/api/logs` requires an active workspace
header, while `/api/logs/global` is the explicit global system view.

The current dashboard Providers controls are still separate browser-memory
fixtures and are not wired to the persisted provider API yet. Codex, routing,
budget, and pricing controls are also browser-memory fixtures. They survive page
navigation and switching back during that browser session, but they do not survive
a browser reload and are not server-side isolation. The selected workspace ID is
the only browser-persisted workspace preference. Do not represent those fixtures
as persisted configuration.

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
  CLIProxy lifecycle and its internal credential are global/private only. Public
  `/v1` authentication is key-derived and deliberately fails closed before
  routing until this ownership model exists.

Future stores that own workspace data must register an independent, idempotent cleanup handler
with `registerWorkspaceDeletionExtension` before creating workspace-owned rows.
Deletion claims the row atomically, blocks concurrent mutation, runs the handlers,
and removes the workspace only on success. A cleanup or final-delete failure
restores `active` only when the request still owns its durable claim. Startup
recovers claims left by a terminated process before accepting HTTP requests, so
the same deletion can be retried safely.
