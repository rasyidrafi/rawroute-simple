# Accounting contract

The accounting slice is workspace-owned. Browser administration requests require
`x-rawroute-workspace-id`; public inference never reads that header and derives
the workspace from the gateway key.

`model_pricing_groups`, memberships, versions, tiers, jobs, budgets, windows,
reservations, immutable usage events, and rollups all carry `workspace_id`.
Costs are integer USD micros. An event contains request/attempt identifiers,
timing, token completeness/confidence, token-presence flags, price group/version/
tier provenance, and request byte count. It deliberately does not retain prompts, response content,
credentials, or secrets.

Gateway admission reserves a conservative estimate transactionally when an
enabled key budget exists. Settlement is idempotent by `(workspace_id,
attempt_id)`: non-streaming JSON is normalized from OpenAI, Anthropic, Gemini,
and Bedrock-compatible usage shapes; streams are tee-monitored for first byte,
usage, and terminal markers. The original terminal outcome is persisted in a
durable settlement queue before ledger application. A bounded queue-write retry
uses a second durable handoff table when needed; both are replayed at startup.
When neither table is writable, accounting reports an explicit persistence error
while retaining its in-memory retry candidate. Failed/interrupted streams settle
at zero cost and release their reservation exactly once. Partial/missing
successful usage settles to the greater of observed cost and the reservation.
Every priced attempt also records a p50 settlement prediction, including when no
budget is enabled; budget holds use a separate p75 reservation prediction. Both
use at least three exact nearest payload samples with the durable fallback order
key/model/protocol, key/model, model/protocol, then model. Their source and
sample provenance are retained in the event cost source. Repricing does not turn
an assumed observation into an exact one.

Budget windows default to Monday weekly boundaries in `Asia/Jakarta` (override
with `TIMEZONE` or `NEXT_PUBLIC_TIMEZONE` when valid), retain any configured
positive duration, and advance by missed durations. An administrator may anchor a
workspace budget to an **owned enabled Codex account**. Saving that mode requires
a fresh future weekly quota reset; the provider reset is stored as a UTC instant
and defines the seven-day period, so ledger-timezone DST cannot shift it. A
bounded worker and budget reads refresh the anchor only while its workspace is
active. A failed refresh retains the last observed interval and surfaces an
error; choosing a custom window explicitly clears the anchor as its fallback.
Unlimited Mode has an audit
session, optional automatic window-end stop, requested-route and resolved-model
exclusions, and Beyond Limits allowlists (maximum 100). Combo route exclusions
are terminal while an excluded combo member is skipped so its next member can be
tried. Budget reporting uses exact stored window instants.

Admin endpoints are `/api/model-pricing`, `/api/model-pricing/groups`,
`/api/model-pricing/versions`, `/api/model-pricing/models`, `/api/budgets`, and
`/api/usage`. Repricing is persisted, claimed atomically, recovered as queued
at startup, rebuilt from immutable events in one write transaction, and
canceled/drained by workspace deletion or shutdown.
models.dev is discovery-only, uses a bounded one-hour cache, caps results at 100,
and safely fails without changing configured prices.

Unauthenticated public analytics is intentionally separate from the admin
dashboard. `GET /api/public/workspaces` returns active `{id,name}` choices and
`GET /api/public/dashboard?workspace=...` returns aggregate-only summary,
trend, key-name, and public model-label tables. It accepts the normal date
presets, including `budget`, and `hourly|daily|weekly|monthly` granularity; a
custom range is inclusive in the shared ledger timezone and capped at 366 days.
Responses are public-cacheable for 30 seconds in a bounded workspace-first
cache. Accounting settlement/repricing, pricing/budget, and gateway-key label
mutations invalidate that workspace immediately, as does workspace deletion. Durable IDs, provider
IDs, request/attempt IDs, credentials, prompts, and upstream configuration are
not in the DTO.
