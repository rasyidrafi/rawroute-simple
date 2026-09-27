# AI Gateway port inventory

**Scope:** port the verified AI Gateway behavior in `../rawroute` into this
single-package Bun/React/libSQL application. This is an inventory and delivery
plan only; it does not implement gateway behavior.

**Explicit exclusion:** Tool Gateway / Executor is out of scope. Do not port
`../rawroute/src/app/executor/**`, `../rawroute/src/lib/executor.ts`, Tool
Gateway pages, Executor environment variables, or its API proxy. References to
that feature below exist only to make the exclusion unambiguous.

## Baseline and non-negotiable architecture

| Area | Reference (`../rawroute`) | Target (`rawroute-simple`) | Port rule |
| --- | --- | --- | --- |
| Server/UI | Next 16 App Router, route handlers, SWR dashboard | Bun server in `src/index.ts`; React entry `src/frontend.tsx`; client views in `src/components/dashboard/` | Keep all HTTP routes in `src/index.ts`; replace Next `after`, cookies, and route files with Bun equivalents. Do not add Next, a backend service, or another bundler. |
| Durable storage | PostgreSQL JSON-document adapter plus Redis | libSQL/SQLite in `src/lib/db.ts` | Model each resource relationally with explicit `workspace_id`, composite ownership constraints, and transactional mutations. Redis-dependent coordination needs a safe local/persisted alternative or a deliberately documented optional service; never pretend process-local state coordinates replicas. |
| Execution boundary | Private remote CLIProxyAPI (`CLIPROXY_URL`), plus direct native Responses upstream execution | Locally managed private loopback CLIProxy on `127.0.0.1:8317` | Preserve the private management boundary. Projected/Codex requests proxy only to loopback/internal CLIProxy after RawRoute authentication and resolution; native Responses requests directly call their configured provider after the same checks. `/v0/management` remains blocked publicly. |
| Workspace scope | Key-derived for public gateway; admin header-derived for workspace administration | Same foundation is already present | Gateway must ignore all client workspace headers and derive the active workspace solely from the active gateway key. Admin repositories always receive the validated explicit workspace ID. |
| Existing safe persistence | Provider desired state/credentials encrypted and projection retry state; gateway keys encrypted and globally unique | Implemented in `src/lib/providers.ts`, `src/lib/provider-sync.ts`, `src/lib/gateway-keys.ts` | Extend, do not replace or weaken. Reuse encrypted provider snapshots for resolver/projection; keep browser credential values write-only. |

The current target worktree was clean at inventory start (`37221ee feat: persist
workspace providers and synchronize CLIProxy configuration`). No existing work
was changed other than this document.

## What is actually present today

### Already durable/usable foundation

* Login/session/password, workspace creation/rename/deletion and request scope:
  `src/lib/auth.ts`, `src/lib/workspaces.ts`, `src/lib/request-scope.ts`.
* Workspace-scoped gateway key CRUD, global SHA-256 uniqueness, AES-256-GCM
  at-rest encryption, revocation/tombstones, and key-derived public
  authentication: `src/lib/gateway-keys.ts`, `src/lib/gateway-keys-http.ts`.
  The product UI supports only the one-time create response; it does not expose
  a stored-key reveal control.
* Workspace-scoped providers, encrypted credentials, models, priorities,
  desired/applied revision, sync status, durable projection tombstones, and
  CLIProxy reconciliation: `src/lib/providers.ts`, `src/lib/provider-sync.ts`,
  `src/lib/providers-http.ts`.
* Managed CLIProxy binary installation/start/stop/recovery/private-management
  serialization: `src/lib/cliproxy/{service,http,management,store}.ts`.
* Process-local scoped/global operational logging and browser event logging:
  `src/lib/logging/**`.

### Implemented gateway surface and remaining verification

* The key-derived gateway resolves persisted models, aliases, combos, shares,
  budgets, pricing, and the durable usage ledger across the supported public
  protocol namespaces. Native Responses execution remains eligible while
  CLIProxy is unavailable; projected/Codex members fail closed until their
  private dependency recovers.
* Routing, budgets, pricing, Codex, and the lazy Usage dashboard use persisted
  scoped APIs. Gateway key values are create-once and the legacy reveal route is
  not part of the public/admin contract.
* Public analytics is available at the unauthenticated root and through the
  redacted `/api/public/workspaces` and `/api/public/dashboard` APIs.
* The controlled compiled coverage is mapped in `docs/e2e.md`, including the
  native/financial and private Codex/sharing matrices. It does not certify a
  live OAuth/provider account or a production deployment. Tool Gateway /
  Executor remains excluded from this port.

## Reference gateway behavior and historical port notes

The rightmost column in the comparison tables below records the original port
plan. It is not a current implementation-status claim; current controlled
coverage and its fixture boundaries are recorded in `docs/e2e.md` and the
status sections below.

### Public protocols, forwarding, cancellation, and error contracts

Reference paths:

* Generic forwarding: `../rawroute/src/app/v1/[...path]/route.ts`,
  `openai/v1/[...path]/route.ts`, `v1beta/[...path]/route.ts`,
  `backend-api/codex/[...path]/route.ts`.
* Gateway implementation: `../rawroute/src/lib/cliproxy.ts`.
* Root/catalog compatibility: `src/app/v1/route.ts`, `src/app/v1/model/info/route.ts`,
  `src/app/model/info/route.ts`, `src/lib/catalog.ts`.

| Contract | Reference behavior | Target gap / required port |
| --- | --- | --- |
| Gateway roots | `GET /v1` returns service/backend/endpoints JSON without authentication. `/v1/model/info` and `/model/info` require a gateway key and return LiteLLM-format chat-model metadata. | Target `/v1` deliberately returns a 404 error and has no model-info route. Port exact compatible success/error/cache behavior. |
| Forwarded namespaces | All methods (`GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD`) forward `/v1/*`, `/v1beta/*`, `/openai/v1/*`, `/backend-api/codex/*` after gateway-key authentication. | Add safe Bun wildcard dispatch. Do not turn private `/v0/management` into a wildcard. |
| Model catalog | `GET .../models` is generated locally from enabled providers/models plus resolvable aliases and combos; it is not CLIProxy's catalog. Output is OpenAI `{object:"list",data:[...]}` with `id`, `object`, epoch `created`, `owned_by`, `protocol`. | Build a persisted catalog and serve it from every relevant `.../models` path rather than forwarding stale/internal models. |
| Ingress protocols | Client endpoint determines ingress: messages → Anthropic, responses and Codex backend route → Responses, otherwise Chat. A saved provider protocol is the upstream executor format, not an ingress restriction. | Implement resolver and payload path classification. |
| Header/body forwarding | Drops hop-by-hop headers (`connection`, `host`, `content-length`, `expect`, etc.), preserves remaining request/response headers and query string, uses `request.signal`, and sets `duplex:"half"` for a forwarded stream. Replaces client authorization/x-api-key with private CLIProxy credential. | Implement an audited Bun forwarding helper. It must propagate cancellation downstream/upstream and must never pass gateway credentials to provider/CLIProxy. |
| Responses compatibility | For `/responses`, maps `max_completion_tokens`/`max_tokens` to `max_output_tokens`, turns `reasoning_effort` into `reasoning:{effort}`, then removes compatibility fields. Chat and Anthropic requests are converted to Responses for a native Responses provider. | Port `request-normalization.ts`, chat/Anthropic translation, and tests. |
| Streaming | Detects SSE success; `tee()`s the upstream body, returns one branch immediately, and asynchronously parses line-delimited SSE on the other. It recognizes `[DONE]`, event/type terminal markers, partial usage fields, first-byte time, bounded stream duration, and records 502 if no terminal event. Consumer disconnect/cancel must not block the monitor from settling the reservation. | No streaming gateway exists. Use `ReadableStream.tee()` or a Bun-correct equivalent; preserve headers/status and ensure monitor cleanup/timeout. |
| Non-streaming | Buffers response bytes once, extracts JSON usage, records outcome, returns bytes/status/headers unchanged apart from sanctioned normalization. | Implement without response-body double-consumption. |
| Invalid key | Reference accepts `Authorization: Bearer` or `X-API-Key`; unknown/inactive/deleting-workspace key returns `401 {error:{message:"Invalid gateway API key."}}`. | Target uses a stricter existing auth envelope. Decide and document exact compatibility transition; production gateway should retain the reference response for parity while preserving target's secure dual-header mismatch check. |
| Resolver failures | Unavailable/disabled/unconfigured model returns `400 {error:{message,code:"model_not_found"}}`; resolver storage failure returns `503 ... model_resolver_unavailable`. | No model resolver. |
| Upstream failure | Fetch exception returns 502 `Upstream request failed.` and releases reservation. JSON failures are bounded-read (8 KiB/250 ms) only for safe error code/retry extraction. Non-429 removes `Retry-After`; CLIProxy synthetic cooldown 429s become a generic 503 `upstream_unavailable` with no retry header; confirmed real quota/budget 429 remains 429. | Implement sanitizer and translation; never reflect provider body into server logs. |
| Public response hygiene | Internal combo control headers (`x-rawroute-combo-terminal`, `x-rawroute-combo-member-unavailable`) never escape to clients. | Implement on all inference exits. |

### Model routing: providers, aliases, fallback combos, and shares

Reference paths: `src/lib/cliproxy.ts`, `src/lib/catalog.ts`,
`src/lib/combo-reasoning.ts`, `src/lib/combo-circuit.ts`,
`src/lib/model-shares.ts`, `src/app/api/admin/{providers,aliases,combos,model-shares}/**`.

1. **Provider/model records.** Reference providers contain name, public prefix,
   base URL, `openai-chat | openai-responses | anthropic-messages`, compatible
   auth type, validated static headers, enabled state, optional prompt-cache-key
   support, and credential/model counts. Models have a persisted internal ID,
   `prefix/suffix` gateway ID, upstream ID, enabled state, source and optional
   reasoning capability. Target already persists the core provider/model subset,
   but lacks `supportPromptCacheKey`, model source/built-ins, and reasoning
   capability.
2. **Provider projection/execution and load balancing.** Non-Codex chat/Anthropic providers project
   only enabled models/credentials to a hashed workspace/provider namespace and
   `rr-managed-*` entry names. Reference preserves unmanaged entries, rejects a
   namespace collision, serializes management writes with a distributed lock,
   sets CLIProxy's provider routing strategy to `fill-first`, and retains delete
   cleanup tombstones. Credential priority is therefore ordered failover, not
   RawRoute round-robin/load balancing. CLIProxy owns projected-provider
   translation, retries and execution, but the configured credential
   `rpmLimit`/`maxConcurrency` fields are advisory persistence only in this
   reference snapshot and are not wired to CLIProxy or RawRoute enforcement. Target
   already has a stronger local desired/applied/tombstone implementation; extend
   it for actual gateway execution rather than replacing it. Native Responses
   providers are directly fetched in the reference using enabled credentials in
   priority order (not projected); target must make that a durable, scoped,
   non-leaking execution mode.
3. **Resolution rules.** Resolve an exact enabled model ID; then an alias; then
   an unprefixed upstream/suffix spelling only if exactly one active model
   matches. An alias targets a gateway model ID. Disabled provider/model and
   ambiguity are unavailable. Codex requests use an internal workspace namespace;
   other projected providers use workspace/provider namespace while the public
   catalog never exposes those internal names.
4. **Aliases.** Alias IDs permit lowercase `a-z0-9._/-`, collapse duplicate
   slashes, and are unique against models/combos. Alias save validates an active
   target and invalidates dashboard presentation caches. Reference includes
   aliases in both catalogs only when their target remains available.
5. **Combos.** A combo is a named ordered chain of **2–8 unique** enabled model
   IDs or aliases. Inference recognizes a requested combo and tries every member
   in order, falling through on all non-terminal failures. An exclusion applied
   to a directly requested model or the **requested combo** is terminal before
   inference/member iteration. An exclusion applied to an individual member returns the internal
   `x-rawroute-combo-member-unavailable` marker and is skipped so the next member
   is tried (`../rawroute/src/lib/cliproxy.ts:633-680`). Real member budget
   denial and price-unavailable failures are terminal. Preserve client abort
   between members.
6. **Per-member policy.** Members can inherit request reasoning, remove it for
   provider defaults, or override with normalized effort; optionally deep-merge
   a canonical JSON custom payload. Payloads forbid prototype keys and top-level
   `model/messages/input/prompt/stream/stream_options`, max 16 KiB and depth 12.
   The administration test streams a tiny probe to upstream, stores validation
   result/config hash, rejects invalid policies, and requires a signed 5-minute
   confirmation before saving unverified policies.
7. **Circuit code discovery.** `combo-circuit.ts` implements a Redis distributed
   cooldown/probe circuit, but the current `proxyGatewayRequestInWorkspace`
   loop does not call it. Treat it as unintegrated reference code, **not** a
   required live feature until a later source audit proves a reachable caller.
   Do not claim combo cooldown skipping as reference parity.
8. **Cross-workspace model sharing (mandatory).** Reference lets an owner share an enabled
   model with active recipient workspaces; recipient aliases must explicitly
   reference the share and use a qualified `ownerWorkspaceId/gatewayModelId`.
   Resolution re-enters the owner workspace for transport/pricing, sends a
   namespaced target, bills the owner synthetic `shared-workspace:<consumer>` key,
   and records a zero-cost consumer counterpart. This real reference behavior
   needs careful adaptation to the target's contract: provider credentials and
   shared CLIProxy transport are currently explicitly not tenant-isolated. Slice
   0 must document and test the isolation design; later implementation must then
   deliver grant/revoke, owner billing, zero-cost consumer accounting, source or
   recipient deletion cleanup, cache invalidation, and redacted browser/admin
   DTOs. This is a dependency, not an optional feature or an approval gate.

### Gateway keys, budgets, policies, pricing, usage, and logs

Reference paths: `src/lib/{analytics,usage-metrics,usage-prediction,model-pricing,models-dev,logger}.ts`,
`src/app/api/admin/{api-keys,budgets,usage,model-pricing,logs}/**`, and
`src/app/api/public/dashboard/route.ts`.

| Capability | Verified reference semantics | Target gap |
| --- | --- | --- |
| Gateway keys | Key CRUD is admin/workspace scoped. Reference stores raw key in its document backend and globally indexed hash. | Retain target encryption/tombstones and use `GatewayKeyMetadata.id` for ledger/budget ownership. A generated/custom secret is returned once at creation only; remove/hard-disable the target's legacy post-create reveal HTTP handler to match `995b0f0`. |
| Admission reservation | Before inference, resolve a model price and calculate a conservative request estimate. Atomically reserve per-key budget spend; release after fetch failure or final response/stream monitor settlement. Denial is terminal 429 with window-end Retry-After; inability to determine budget/price is 503. | Entirely absent. Must be transactionally correct under concurrent requests; a process-local counter is inadequate. |
| Budget rows | Per gateway key weekly USD-micro limit, enabled flag, spent/remaining data. Validates selected local key or a cross-workspace synthetic share budget. | Mock-only UI. Implement local-key budgets first and the mandatory synthetic share budget immediately with the slice-7 sharing ownership model. |
| Budget window | Default window is a week, but custom windows are arbitrary positive durations and roll forward by their own elapsed duration (including multiple missed periods). It may be anchored to a Codex account's weekly reset and periodically refreshes under a distributed lock. All calendar bucketing/display is timezone-aware. | Mock date picker only. Implement custom arbitrary-duration rollover and then Codex anchor; the target has no shared server/browser timezone utility. |
| Unlimited Mode | A persisted bypass session starts/stops with audit history; optional auto-deactivate at window end. It bypasses limits, but a configured exclusion list yields terminal 403 `model_excluded_in_unlimited_mode` for a directly requested model or requested combo; an excluded combo member is skipped and fallback continues. | Mock-only. |
| Beyond Limits | When normal budget is exceeded, optionally admit configured enabled economical model IDs; validates at most 100 models. | Mock-only. |
| Usage ledger | Every outcome has immutable event ID, key/model/provider IDs, protocol, started/completed/duration/TTFT, status, request body bytes, input/output/cache token fields, exact/assumed/unpriced confidence, completeness, source/prediction provenance and price group/version/tier. Inserts are idempotent. | No durable ledger. |
| Usage extraction | Normalizes OpenAI, Anthropic, Gemini/Bedrock-like usage spellings; adds Anthropic cache input components correctly; complete/partial/missing is explicit. | Absent. |
| Cost | Integer micros per million rates for input/output/cache read/cache creation. Selects highest matching context tier; cached tokens are not double billed. Partial usage stays `assumed`, unknown price is `unpriced`. | Mock USD rate values only. |
| Missing usage | Successful incomplete output settles to the larger of observed lower bound and reservation/historical estimate. Exact events calibrate per-key/model/global quantiles; OpenAI/Codex uses payload-size nearest-neighbor p50 settlement/p75 reservation. | Absent. Generic conservative estimation and calibrated payload prediction are both mandatory completion criteria, not a deferred enhancement. |
| Rollups/dashboard | Each event updates hourly and daily rollups, with monthly rollups when configured; buckets, weekly/monthly ranges and labels use the configured application timezone. Queries choose storage granularity, reconcile partial boundaries with event ledger, expose summary/trend/keys/models/freshness/pricing confidence. Query presets: today, yesterday, week, lastWeek, month, lastMonth, year, all, custom, budget; custom max defaults to 3650 days. | Usage screen is fixture-only. |
| Repricing | Pricing groups are auto-fixed by gateway suffix across providers or custom; each model is in one group. Versioned effective prices and context tiers; replacing active version creates a persisted queued/running/completed/failed repricing job and recalculates qualifying events/rollups. | Mock pricing and fake history. Implement a persisted, workspace-owned, deletion-aware job queue; do not use Next `after`. |
| Canonical prices | Optional models.dev catalog fetch/cache (one hour), searchable max 100, parsed into canonical rates/context limits, can link a pricing group. It is a pricing discovery source, not provider/model discovery/probing. | No live catalog. |
| Public dashboard and landing | Unauthenticated `GET /api/public/dashboard?workspace=...` selects an active workspace, max custom range 366 days, returns 30-second public-cacheable aggregated data. `/api/public/workspaces` lists active workspace names/IDs. The reference browser landing uses the workspace selector with that API before fetching the public analytics view. | Missing. This is required parity: implement the browser landing, selector, both APIs, aggregate-only/redacted DTOs and bounded public cache invalidation as a mandatory final slice. |
| Logs | Reference has a process-local 500-entry per-process ring scoped by workspace and ETag; it logs safe gateway summaries (provider/model/protocol/key name/usage outcome), never secrets/prompts. | Target already has a bounded scoped/global logging framework; add safe structured gateway events and preserve its stronger 2,000/scope/10,000 total behavior. Durable usage is the audit source, not logs. |

### Provider configuration, discovery, probe/import findings

* **No provider model discovery/import/probe workflow was found** in the
  reference application source. Providers, credentials, and models are added
  manually through `src/app/api/admin/providers/**`; model discovery exists only
  for models.dev pricing metadata. Do not invent a claim that RawRoute imports
  upstream models or probes a provider during CRUD.
* The only verified upstream probe is the combo-member streaming policy test in
  `src/lib/cliproxy.ts:testComboMemberPolicy`.
* Provider validation normalizes an Anthropic `/v1` base URL to its root;
  `x-api-key` is permitted only for first-party `https://api.anthropic.com`;
  OpenAI-compatible endpoints permit bearer or no auth. Static headers are
  validated and reserved auth/hop-by-hop names are blocked.
* Provider credential forms/API accept positive integer `rpmLimit` and
  `maxConcurrency` and persist them with each credential in the reference data
  model. The checked projection/native-execution source does **not** pass either
  control to CLIProxy or enforce it in RawRoute. Port the fields, validation,
  masked admin DTO/UI editing and migration as stored advisory configuration;
  do not claim request-time enforcement until an executor mapping is separately
  implemented and tested.
* Target provider CRUD already validates the core equivalent, encrypts secrets,
  masks browser responses, has priority ordering and reports projection state.
  Missing for parity: `supportPromptCacheKey`, persisted credential
  `rpmLimit`/`maxConcurrency`, provider-specific native Responses executor,
  request-time resolution/ensure-projection, and gateway-facing model
  metadata/reasoning fields.

### Codex and CLIProxy OAuth lifecycle

Reference paths: `src/lib/{codex,cliproxy-codex,codex-cli-login,codex-usage,codex-reset}.ts`,
`src/app/api/admin/oauth-providers/**`, `src/app/{codex,anthropic,antigravity}/callback/route.ts`,
and `src/app/api/admin/cliproxy/**`.

1. A workspace gets a fixed `codex` Responses provider and built-in, non-editable
   `codex/gpt-*` models on first access. The reference snapshot currently lists
   eight GPT-6/GPT-5.3–5.6 model IDs; port the mechanism/data source deliberately
   rather than hard-coding stale names without an update policy.
2. CLIProxy owns Codex token creation, refresh, and auth files. RawRoute stores
   only a mapping to auth-file name/index and live account metadata. It never
   stores/re-uploads Codex access, refresh, or ID token.
3. The primary UI flow is CLIProxy web OAuth: `POST .../codex/device/start`
   reserves a **global Redis lock** plus 5-minute session; CLIProxy provides URL
   and state; callback URL may be manually pasted but must be
   `http://localhost:1455/auth/callback` with matching state; poll maps exactly
   one changed auth file to the initiating workspace prefix; cancel cleans both
   remote/session state. Mapping collision with another workspace rolls back.
4. Account list overlays live CLIProxy auth-file status. Enable/disable/deletion
   mutates both the mapped auth file and local mapping with rollback on local
   failure. Account priority is represented in mapping/CLIProxy. Legacy local
   token records are migration-only and converted to CLIProxy mappings.
5. Quota reads use CLIProxy management `api-call` with auth index and `$TOKEN$`,
   parse five-hour/weekly windows and reset credits, cache five minutes with
   distributed refresh lock/stale data, and mark 401 as reauthorization needed.
   Reset credit requires confirmation phrase, an exhausted weekly quota, an
   unused credit, and a per-workspace/account lock; it invalidates quota cache.
6. General CLIProxy OAuth UI supports Anthropic, Codex, Antigravity, Kimi, and
    xAI start/status/cancel wrappers. CLIProxy keeps the provider's fixed callback
    URI and performs the authorization-code exchange privately. A user may paste
    a complete callback URL for a manual/device-compatible flow; RawRoute forwards
    only its state/code or error to private management and never rewrites a
    provider redirect URI. This is management/OAuth support, not a substitute for
    a workspace-scoped provider credential isolation design.
7. **Target constraint:** current AGENTS explicitly says provider credentials,
   OAuth accounts, and shared CLIProxy transport require a documented ownership
   and isolation design before becoming workspace scoped. Thus, first port a
   global/private CLIProxy OAuth management slice or a fully designed scoped
   mapping slice; do not wire the demo Codex UI to cross-workspace shared auth
   files until slice 0 has documented the concrete mapping/isolation lifecycle.

### Admin HTTP API inventory

Reference administration routes use cookie-admin auth. Workspace resource routes
select header `x-rawroute-workspace-id`; global account/settings/CLIProxy routes
ignore it. In this target, map them to `/api/...` naming only after preserving
the target request-scope/CORS/origin checks.

| Reference endpoint group | Behavior to port |
| --- | --- |
| `/api/admin/providers`, `/:providerId`, `/:providerId/api-keys`, `.../reorder`, `.../models` | Provider/model/credential CRUD, validation, masked stored secrets, sync/reconcile. Target has closely analogous `/api/providers/**` endpoints; enhance in place rather than create a second admin namespace. |
| `/api/admin/aliases`, `/[aliasId]` | List aliases/combos/available providers/models/shared models; create/update/delete alias. Missing. |
| `/api/admin/combos`, `/[comboId]`, `/test` | Combo save/delete and upstream member-policy probe/confirmation. Missing. |
| `/api/admin/model-shares` | List/change source-model sharing targets. Mandatory after slice 0's documented isolation design; includes grant/revoke, redaction, owner/consumer accounting and deletion cleanup. |
| `/api/admin/api-keys`, `/[apiKeyId]`, `/endpoint-key` | Gateway key create/rename/delete/list endpoint metadata. Target has richer scoped key endpoints but needs any desired compatibility/UI adapter. |
| `/api/admin/budgets/**` | Budget CRUD; custom/Codex windows; unlimited/bypass and history; beyond-limit and unlimited exclusion policies. Missing. |
| `/api/admin/usage` | Authenticated aggregated usage dashboard query. Missing. |
| `/api/admin/model-pricing`, `/models`, `/jobs/:jobId` | Pricing group/version actions, models.dev search, background repricing status. Missing. |
| `/api/public/dashboard`, `/api/public/workspaces` | Mandatory unauthenticated public analytics landing/workspace selector APIs. Return only aggregate/redacted data, enforce the reference range limit and cache contract, and invalidate/withhold deleted workspaces. |
| `/api/admin/oauth-providers/**` | Codex accounts, OAuth lifecycle, quota/reset. Missing. |
| `/api/admin/cliproxy/**` | Port **all** verified authenticated private-management wrappers: `GET/PUT api-keys` (masked values); `GET/PATCH/DELETE auth-files`; `GET/DELETE logs`; `GET oauth/:provider/start`, `GET oauth/status`, and `POST oauth/cancel`; and callback forwarding for `/anthropic/callback`, `/codex/callback`, `/antigravity/callback`. The start wrapper supports all five providers: Anthropic, Codex, Antigravity, Kimi and xAI. Target has lifecycle routes but none of these wrappers. |
| `/api/admin/settings`, `/api/admin/limits` | CLIProxy config fields (debug, file logging, usage statistics, retry/interval, routing strategy) and Codex quota overview. Target Settings is UI/local behavior only. |
| `/api/admin/logs` | Workspace console log with ETag/304, safe clear. Target `/api/logs` already has scoped logs but should gain any required ETag compatibility. |
| `/api/admin/account`, `/password`, `/api/auth/login`, `/logout` | Account/password/session. Target already owns analogous auth and must not regress it. |

### Dashboard/UI behavior inventory

Reference pages dispatch from `src/app/dashboard/**`, primarily via
`src/components/dashboard/{management-views,aliases-view,usage-view,oauth-providers-view,settings-view}.tsx`
and SWR provider/workspace state. Port the behavior, not Next/SWR implementation:

* **Endpoint & Key:** display `/v1`, one-time key create/copy, rename and
  delete; no plaintext key is stored in normal list state and there is no later
  reveal action.
* **Providers:** provider list/detail, create/edit/delete; protocol/auth/header
  form validation; credentials (masked, enabled, limit/concurrency/priority)
  and models; sync/pending/error/cleanup statuses and manual retry; share button
  per model. Target provider UI already speaks persisted APIs but needs gateway
  fields/status parity and a real execution/readiness explanation.
* **Routing:** aliases, ordered combos, per-member reasoning/custom payload,
  validation state and confirmation dialog, shared-model target chooser. Target
  Routing is mock-only and currently shows fabricated shares.
* **Usage:** range/granularity filters, summary, trend, key/model tables,
  pricing-confidence/freshness and budget presentation based on live aggregate
  API. Target Usage is mock-only; retain lazy import in `views.tsx`.
* **Budgets:** key budgets, accounting window/Codex anchor, Unlimited Mode
  confirmation and auto-end choice/history, exclusion and Beyond Limits model
  selectors. Target is mock-only.
* **Model pricing:** fixed/custom group management, canonical models.dev search
  and link, versions/context tiers, repricing progress/error polling. Target is
  mock-only.
* **Codex/OAuth:** account statuses, priority/enable/delete, quota windows,
  authorize/paste callback/poll/cancel and reset-credit confirmation; built-in
  model state. Target is explicitly demo-only.
* **Settings/CLIProxy:** private CLIProxy settings, management auth-file/API-key
  state and logs must be clearly global, never rendered as workspace-isolated.
* Replace SWR with existing React hooks/local state or a minimal fetch/cache hook
  appropriate to this app. Preserve stale request cancellation, error/retry
  messaging and cache invalidation after mutations. Do not add SWR merely to
  imitate the reference.

## Data and operations inventory

### Target tables/resources to add

Every workspace-owned table must use non-null `workspace_id`; every read/update/
delete must predicate it; parent/child ownership must be composite where possible.
No repository may use a browser-selected/default workspace implicitly.

1. `routing_aliases`, `routing_combos`, `routing_combo_members` (and optional
   validation snapshots); unique public IDs across enabled models/aliases/combos
   within workspace must be transactionally enforced.
2. `model_pricing_groups`, memberships, versions, context tiers, and
   `pricing_jobs` carrying `workspace_id`, cancellation/deletion state and
   durable progress.
3. `gateway_budgets`, `budget_windows`, `budget_bypass_sessions`,
   `budget_counters`, unlimited and beyond-limit settings. Reservation/admission
   needs a durable transaction-safe ledger/counter strategy.
4. `usage_events` and indexed hourly/daily/(configured monthly) `usage_rollups`.
   Idempotency key must survive stream-monitor retry. Keep `cost_micros` integer,
   not binary floating point.
5. Codex mapping/login/quota metadata only after ownership design; never persist
   raw OAuth tokens. Pending login state requires durable TTL/lock semantics if
   multi-process support is claimed.
6. `model_shares` after slice 0's independent credential/transport isolation
   design. Include owner/recipient indexes, durable grant/revoke state,
   redacted views, share-aware owner/consumer usage linkage, cache invalidation,
   and idempotent source/recipient workspace deletion cleanup.

Register each resource with `registerWorkspaceDeletionExtension` before its first
write. Jobs must retain workspace ID, re-check active state before execution, be
canceled/drained during deletion, and perform idempotent cleanup. Extend the
existing shutdown ordering: stop accepting new gateway mutations/requests,
drain active gateway streams/reservations and queued work as appropriate, then
shut down CLIProxy. Do not let a late async stream monitor recreate a deleted
workspace row or write orphaned usage.

### Timezone and calendar contract

Reference `../rawroute/src/lib/timezone.ts` defaults to **`Asia/Jakarta`** and
uses `NEXT_PUBLIC_TIMEZONE` then `TIMEZONE` when valid. It uses the same IANA
zone for server calculations and browser display: hourly/daily/monthly bucket
starts, week starts, budget window dates, range parsing, rollover and labels.
The target currently has no equivalent; add one shared source-of-truth module
with a validated configurable server value exposed safely to the browser. Do not
use the browser's local timezone for a dashboard whose server ledger uses another
zone. Test default/fallback/configured zones, DST transitions, custom arbitrary
duration windows rolling across one and multiple elapsed periods, and hourly,
weekly, and monthly query/label boundaries.

### Cache/coordination requirements

* Bounded, workspace-first caches only, with explicit invalidation on provider,
  model, alias, combo, price, budget, key, and workspace mutation/deletion.
* Key lookup may use the existing direct hashed libSQL lookup; never cache an
  ambiguous key-to-workspace result. Gateway keys remain globally unique.
* In-process single-flight is acceptable only as an optimization. Budget
  reservation, repricing claims, OAuth/login locks, and cross-instance cleanup
  must be transactional/persisted (or clearly require an optional coordination
  service). Redis is not currently a target dependency.
* Preserve provider-sync locking against CLIProxy lifecycle and existing durable
  cleanup tombstones. A failed projection must be visible/retryable but must not
  make the public gateway claim the provider is executable.

### Backup/import/export finding

No RawRoute browser/API backup, restore, configuration export, or provider import
feature exists in the checked reference source. Do **not** add one as parity.
Reference operations documents only external PostgreSQL/volume backups and has
maintenance scripts: API-key index backfill, usage reconciliation/integrity
sanitization, and missing-usage prediction. Later target operations work should
provide libSQL-safe backup guidance for the database **and both persisted master
keys** (`gateway-keys/master-key`, `provider-credentials/master-key`), but that
is an operational hardening task, not an import/export UI slice.

## Ordered implementation slices

Each slice is independently testable; do not start a dependent UI slice against
fixtures after its server counterpart exists.

### Delivery discipline and end-to-end matrix (mandatory for every slice)

Use **red → green → refactor**: first add a failing focused unit/API/browser test
for the behavior, implement the smallest change to pass it, then refactor only
with the full suite green. A feature is not complete when only a table, route or
screen exists. Its required matrix is:

1. browser UI/form/state/error/reload behavior;
2. Bun HTTP auth, validation, response/error and cancellation behavior;
3. libSQL schema, transactional persistence, cache invalidation and workspace
   isolation/deletion behavior; and
4. an end-to-end chain from **configuration → inference → accounting** using a
   controllable private CLIProxy/provider fixture.

The E2E matrix must cover normal and failure/recovery paths: server restart
while data/jobs/streams exist; database unavailable; a projected/Codex CLIProxy
member unavailable then recovered/reconciled while native Responses remains
eligible; provider projection retry; key/workspace mutation races;
sharing grant/revoke/delete/owner billing/consumer accounting; and the public
analytics landing/workspace selector/redaction/cache/deleted-workspace behavior.
Run the applicable browser, server and database tests before moving to the next
slice; a mock-only dashboard mutation is not evidence of parity.

### 0. Contract tests and schema plan (prerequisite)

Define target DTOs/errors, endpoint dispatch ownership, relational migrations,
test doubles for private CLIProxy/provider HTTP, and deletion/job lifecycle
hooks. Inventory/migrate existing mock data only if it has a real source; do not
seed fake production routing data. Document the scoped OAuth/credential and
shared CLIProxy transport isolation design before Codex/share implementation:
credential/auth-file ownership, namespace isolation, grant/revoke authorization,
owner/consumer billing, redaction, cache invalidation, revocation and deletion.
Define the shared `Asia/Jakarta`-default timezone contract and all management
wrapper DTOs here. Define dependency state/readiness: database or key lookup
failure, and resolver/provider-state failure, must fail closed with sanitized
gateway 503 for every execution mode. CLIProxy unavailable/uninitialized state
must yield sanitized 503 only for a projected/Codex member; a correctly resolved
native Responses provider remains eligible without CLIProxy. Recovery must
re-check CLIProxy health and reconcile projections before a projected member is
considered ready.

**Accept:** red tests exist for scope/isolation, timezone defaults/rollover and
dependency-unavailable recovery; `bunx tsc --noEmit` and existing tests pass;
new tests prove every repository accepts explicit workspace ID and
cross-workspace IDs cannot authorize an object. No public inference route has
been enabled yet.

### 1. Persisted routing catalog and resolver

Add aliases/combos/member policy persistence and catalog builders; extend models
with reasoning/source metadata as needed; map active persisted provider models to
public IDs. Preserve target provider projection state and use request-time
projection readiness. Build scoped admin APIs and replace Routing fixtures with
server data. Add persisted advisory `rpmLimit`/`maxConcurrency` form/API fields
without claiming executor enforcement. Implement the documented share resource
foundation (not browser fixtures) when its slice-0 contract is ready.

**Accept:** enabled/disabled provider/model behavior, exact/unique suffix
resolution, alias resolution, ambiguity rejection, catalog contents, credential
limit persistence/masking and all cross-workspace rejection cases are
unit/API/browser tested; page reload preserves routes.

**Current implementation status (2026-09-27):** The scoped persisted catalog
and the core local public gateway are implemented. Gateway keys select the
workspace exclusively; `/v1/*`, `/openai/v1/*`, `/v1beta/*`, and
`/backend-api/codex/*` are authenticated dispatch namespaces, while management
remains private. Local catalog/model-info responses, exact model/alias/unique
suffix resolution, ordered local combo fallback, request header hygiene,
native Responses direct execution/credential priority, Chat/Anthropic request
and response translations, bounded 429 normalization, cancellation, and
stream passthrough are present. Native Responses providers now reconcile as
`applied` without requiring CLIProxy; projected providers still require both a
current projection and healthy private CLIProxy.

**Reviewer follow-up (2026-09-26):** Path-selected Gemini models are decoded
once, locally resolved, and rebuilt with the owned encoded CLIProxy namespace;
client path and JSON model disagreements fail closed. `gateway-native.ts` owns
Chat/Anthropic ↔ Responses request/response/SSE conversion, including tools,
tool-call history, images, function arguments, usage and terminal events.
`gateway-protocol.ts` owns safe protocol URL/model rewriting and canonical
native `/v1/responses` URLs. Native providers explicitly reject unsupported
embeddings/images/audio/Gemini operations instead of fabricating chat output;
projected providers retain those request bodies and rewrite only their owned
model selector. Gateway request controllers now cover fetch, first byte and
stream lifetime, and shutdown aborts/drains them with a bounded wait.

When a projected provider becomes native, stale managed CLIProxy entries are
removed immediately or recorded in `provider_native_cleanup_pending` for retry;
native execution remains independent of that cleanup. Invalid combo policies
cannot be resaved or executed. `/v1/model/info` now returns the LiteLLM nested
`litellm_params`/`model_info` shape for eligible projected Chat models only.

The Routing page has a real saved-member **Test** action and now probes changed
draft policies before save. Each uses a tiny 20-second streaming request;
saved tests persist only policy config hash/outcome/time, while a draft test
issues the five-minute confirmation required to save. `invalid` is rejected;
the confirmation endpoint cannot mint an acknowledgement without that probe.
Gateway accounting is now connected to `GatewayAccountingHooks`: durable price
groups/versions/tiers, immutable event/rollup recording, stream terminal/TTFT
monitoring, transactional budget reservations, unlimited/beyond policies,
timezone-aware windows, models.dev discovery, and persisted repricing jobs are
implemented in `src/lib/accounting.ts`. The browser Pricing, Budgets, and lazy
Usage pages use scoped APIs rather than fixtures. The detailed, intentionally
limited contract (including the deferred Codex anchor) is in
`docs/accounting-contract.md`.

Cross-workspace sharing/grants, Codex/OAuth, and public analytics are now
implemented as subsequent slices. Codex anchored budget windows use owned account
quota observations rather than fabricated quota/reset data.

**Controlled verification:** `docs/e2e.md` is the current feature-to-assertion
map. Its compiled test-mode native/financial matrices exercise the browser,
gateway, accounting, restart, and loopback upstream boundaries; its separate
private CLIProxy matrix exercises Codex and sharing. These are controlled
fixtures, not production deployment certification or live-provider/OAuth
certification.

An isolated real source-server/browser smoke also signed in, created a native
Responses provider, credential, model, and gateway key through the dashboard,
then called `/v1/chat/completions` over HTTP and received translated output
from a fake upstream while no CLIProxy was started by the smoke.

### 2. Core authenticated gateway proxy

Replace `gatewayUnavailable` behind the existing key-derived scope with a
method/path dispatcher for reference namespaces. Add safe header/query/body
forwarding, model rewrite, public catalog/model-info routes, native Responses
execution, client abort propagation, no public management proxy, and reference
error normalization. Add dependency-aware readiness/health so an unavailable DB,
key lookup, resolver or provider state returns a sanitized 503 before **any**
execution. For projected/Codex routes, an unavailable CLIProxy process/health
endpoint or unapplied required projection returns a sanitized 503 rather than
forwarding blindly, and recovery must reconcile before that member is ready.
Native Responses execution is independent of CLIProxy health and remains
available when its direct provider, credentials and database-backed resolver are
healthy. Keep target's key encryption/auth and provider projection admission,
but remove the legacy post-create key reveal endpoint.

**Accept:** integration tests with mock CLIProxy/provider cover Bearer and
X-API-Key, mismatched headers, deleted/revoked keys, ignored workspace header,
all forwarded methods/namespaces, exact model/alias/suffix behavior, upstream
body/header passthrough, hop-by-hop stripping, abort, 400/502/503/429 conversion,
DB/auth/resolver fail-closed 503, projected CLIProxy/projection 503 and
recovered-ready transition, native Responses acceptance while CLIProxy is down,
and no secret reaches mock upstream/log assertion.

### 3. Ordered combos and request transformations

Implement combo inference loop, member policy validation/probe/confirmation,
reasoning custom-payload protections and format transformations. Keep the
reference's per-request ordered fallback semantics; do not introduce unverified
circuit skipping.

**Accept:** tests prove policy validation limits/prototype safety, Chat/Anthropic
to Responses mapping, fallback on nonterminal failure, terminal exclusion of the
requested combo, skipped excluded member with fallback continuation, no fallback
on budget-like terminal marker, a projected member blocked by CLIProxy health
falling through to an accepting native Responses member, internal headers are
removed, member order is exact, and abort prevents another member attempt.

### 4. Durable pricing and usage recording

Implement integer-micros price groups/versions/context tiers, usage normalization,
nonstream event recording and timezone-aware hourly/daily/configured-monthly
rollups. Add models.dev canonical catalog as a bounded external fetch cache.
Replace Pricing mock state with APIs. Repricing is a persisted workspace-owned
job runner, with startup recovery and deletion drain.

**Accept:** unit tests cover cost math/cache tokens/context tiers/partial and
unpriced confidence; timezone tests cover hourly/weekly/monthly boundary
selection and labels; integration tests prove idempotent event/rollup writes,
price-version provenance, job resume/failure status, no duplicate repricing and
workspace deletion cancellation. No user request contents are persisted.

### 5. Streaming usage and budget admission

Implement stream tee/terminal parsing/TTFT, reservation/settlement and budget
windows/counters, including unlimited exclusion and Beyond Limits. Replace
Budgets and Usage mock state; retain lazy Usage loading. Implement custom
arbitrary-duration timezone-aware windows and **complete** both conservative
generic missing-usage estimation and calibrated OpenAI/Codex payload-size
prediction in this slice: p50 settlement, p75 reservation, exact-history sample
selection, cache-write observation only, provenance and bounded sample storage.

**Accept:** real streaming test fixture verifies immediate downstream chunks,
terminal vs interrupted status, partial usage, single settlement/release, and
client cancellation. Concurrent requests cannot exceed a configured budget;
denial is terminal 429 with correct Retry-After; unlimited/exclusion and
beyond-limit routes have durable reload behavior; prediction fixtures prove
generic and calibrated p50/p75 outcomes, no invented cache-write charge and
correct exact/assumed provenance.

### 6. Codex and private CLIProxy administration

After slice 0's explicit OAuth ownership design, port built-in Codex
provider/model management, safe auth-file mapping, web/device callback flow,
enable/priority/delete rollback, quota cache/reset credit, budget anchor, and
**all** verified private management/settings/log/OAuth wrappers (including all
five OAuth starts). Replace demo Codex UI. Never expose OAuth tokens, management
key, or `/v0/management` publicly.

**Accept:** mocked CLIProxy integration tests cover start/poll/callback/cancel
TTL and workspace mismatch, one changed file mapping, collision rollback,
enable/delete rollback, quota stale/reauth behavior, reset preconditions/lock,
and no token persistence/logging. Browser flow is tested with callback URL
validation.

**Current implementation status (2026-09-27):** Codex mappings, durable login
lease/session recovery, callback validation, live auth-file overlays, mapped
account controls, quota/reset calls, the private Codex CLIProxy gateway path,
and global redacted management/settings wrappers are implemented. The ownership
contract is documented in `docs/codex-isolation.md`. The controlled compiled
private-transport matrix in `docs/e2e.md` covers browser callback, ownership,
sharing, restart, and selected lifecycle faults without contacting live OAuth
providers or certifying production deployment.

### 7. Cross-workspace sharing and public analytics landing

Implement the slice-0 reviewed credential/transport isolation design in full:
owner grant/revoke controls and recipient read-only visibility, explicit alias
selection, owner transport/pricing/budget ownership, zero-cost consumer usage
counterpart, redacted admin/browser/public DTOs, and source/recipient deletion
drain/cache invalidation. Implement the required unauthenticated analytics
browser landing and workspace selector using `/api/public/workspaces` and
`/api/public/dashboard`; it presents only intended aggregate/redacted metrics,
enforces active-workspace/range semantics and uses bounded public caching.

**Accept:** browser/server/database E2E tests prove recipient authorization,
grant/revoke visible after reload, source revocation, owner billing/consumer
zero-cost event, source/recipient deletion behavior, cache invalidation and no
cross-workspace credential leakage. Public landing E2E proves workspace
selection, aggregate redaction, cache headers/range limits, no deleted workspace
selection, and no secret/key/credential/model-internal ID disclosure.

**Current implementation status (2026-09-27):** Owner/consumer model sharing,
owner billed and consumer zero-cost counterpart events, grant/revoke and deletion
cleanup, and aggregate-only public analytics are implemented. The public landing
keeps workspace selection in the URL, aborts stale workspace/dashboard requests,
uses no admin cookies, and keeps Recharts in the existing lazy authenticated
Usage boundary. Focused API tests cover redaction, range validation, workspace
cache isolation, immediate repricing invalidation, and deleted-workspace
withholding; the compiled controlled matrices listed in `docs/e2e.md` add
browser workspace and sharing flows. They do not certify a production deployment
or any live OAuth/provider account.

### 8. Operations, compatibility, and release verification

Add migration/recovery diagnostics, master-key backup/restore documentation,
safe maintenance commands appropriate to libSQL, dependency-aware database and
CLIProxy health/readiness/recovery telemetry, bounded metrics/logging, and deploy
smoke tests. Do not port reference PostgreSQL/Redis scripts literally.

**Accept:** fresh install and upgrade migrations, restart during stream/job/
workspace deletion, database unavailable/recovery, projected/Codex CLIProxy
unavailable/recovery and projection reconciliation while native Responses stays
available, `bun test`, `bun run lint`, `bunx tsc --noEmit`,
`bun run build`, and a private-loopback production smoke test pass. Confirm Tool
Gateway remains excluded from routes, schemas, UI, and deployment configuration.

**Current implementation status (2026-09-27):** Startup migrations/recovery,
redacted dependency health, private-loopback readiness semantics, backup guidance
for libSQL and both encryption master keys, and the explicit-workspace ledger
reconciliation command are implemented in `docs/operations.md`. Focused health
tests cover database/CLIProxy failure and recovery semantics. Full production
container/browser fault-matrix verification remains a release task.

## Reference test and source map for subsequent slices

Use these as behavioral specifications, not just README claims:

* Gateway/stream/error/format/fallback: `../rawroute/src/lib/cliproxy.test.ts`,
  `upstream-failure.test.ts`, `request-normalization.ts`, `catalog.test.ts`,
  `tests/e2e/fallback.e2e.ts`.
* Routing policy/combos: `combo.test.ts`, `combo-reasoning.test.ts`,
  `combo-circuit.test.ts`, `tests/e2e/aliases.e2e.ts`.
* Budgets/usage/pricing: `analytics.test.ts`, `usage-metrics.test.ts`,
  `usage-prediction.test.ts`, `model-pricing.test.ts`,
  `models-dev.test.ts`, `tests/e2e/budgets.e2e.ts`.
* Codex: `codex-cli-login.test.ts`, `cliproxy-codex.test.ts`,
  `codex-usage.test.ts`, `codex-recovery.test.ts`, `codex-reset.ts`,
  `oauth-providers-view.test.ts`, `tests/e2e/oauth-providers.e2e.ts`.
* Scope/deletion/cache controls: `workspaces.test.ts`,
  `workspace-audit.test.ts`, `usage-isolation.test.ts`,
  `tests/e2e/workspaces.e2e.ts`.
* Current target safety baseline: `src/lib/gateway-keys.test.ts`,
  `src/lib/providers.test.ts`, `src/lib/provider-sync.test.ts`,
  `src/lib/cliproxy/**/*.test.ts`, `src/lib/workspaces.test.ts`.

## Significant discoveries / guardrails

* Reference public routing is primarily a RawRoute wrapper around CLIProxy, with
  a deliberate native Responses direct-provider execution path. RawRoute owns
  key authentication, workspace selection, aliases/combos, budget admission,
  pricing, usage and catalog; CLIProxy owns translation/retries/execution for
  projected traffic. Stored `rpmLimit`/`maxConcurrency` are not enforced by
  either path in the checked reference snapshot. Preserve that split.
* Reference `openai-responses` providers bypass CLIProxy projection and are
  fetched natively, with local credential failover. The target implements this
  path; native readiness is intentionally independent of CLIProxy health.
* Reference combo fallback tries all members every request; the unused circuit
  helper must not be mistaken for active behavior.
* Reference has no actual provider discovery/import feature and no UI/API
  backup/import/export feature. models.dev is pricing metadata only.
* Cross-workspace sharing and Codex mappings require the documented ownership
  design. The target now carries owner/consumer accounting and public analytics;
  retain the isolation, deletion, and redaction checks as those paths evolve.
* The reference's Next/SWR background idioms (`after`, route files, SWR cache)
  must become explicit Bun lifecycle ownership and React hooks. The target's
  Usage lazy boundary is an existing build/doctor contract.
