# Compiled browser E2E

Run the release fixture suite with:

```sh
bun run test:e2e
```

Run the extended ordinary-provider administration browser matrix with:

```sh
bun run test:e2e:admin
```

Run the routing and accounting browser extension with:

```sh
bun run test:e2e:accounting
```

Run the controlled financial browser matrix with:

```sh
bun run test:e2e:financial
```

It includes the admin/accounting extension and uses the same isolated native
loopback fake. Its named assertions include
`native-sse-incomplete-terminal-usage`, `browser-reprice`,
`unlimited-autoend-same-audit-session`,
`unlimited-requested-combo-no-upstream`,
`unlimited-member-exclusion-skips-first`, and
`beyond-limits-allowlist-admission-and-terminal-denial`.

Run the private Codex/global-management/model-sharing matrix with:

```sh
bun run test:e2e:oauth-sharing
```

This command stages a compiled, loopback-only CLIProxy fixture as a managed
version on an ephemeral test port. It covers browser Codex callback and sharing,
workspace auth-file ownership, quotas/reset idempotency/cleanup, global OAuth
and settings/key/log wrappers, owner-billed shared Codex streams, revocation,
and compiled-app restart persistence. It is a controlled private-transport
fixture, not a claim that third-party OAuth providers were contacted.

It includes the admin matrix, then persists a local alias, an ordered two-model
combo (including a member reorder), a custom pricing group, a timezone-local
budget window save, and an All-time Usage filter through the compiled browser.

The admin matrix keeps the base suite's isolated compiled fixture and adds
browser-driven workspace create/rename/switch/delete, gateway-key rename with
one-time-secret protection, ordinary provider creation, write-only credential
create/edit/reorder, and model create/rename/reasoning/delete flows. The base
suite retains its separate isolated native-fixture setup for gateway and
accounting assertions; the added administration mutations are browser UI
actions.

## Feature-to-assertion map

| Feature | Compiled E2E assertion |
| --- | --- |
| Authentication and key protection | initial-password rotation, one-time key reveal/reload protection, programmatic origin login, revoked-key rejection |
| Workspaces | browser create/rename/switch/delete plus cross-workspace provider invisibility and gateway workspace-header isolation |
| Ordinary providers | browser provider, write-only credentials, priority movement, model IDs/reasoning metadata and delete |
| Native gateway | strict loopback upstream validates endpoint, replaced authorization, normalized Responses payloads/SSE, original upstream-ledger settlement, and invalid ingress failure. Focused native tests separately cover Responses-inclusive to Anthropic-exclusive cache usage conversion. |
| Routing/accounting | `native-sse-incomplete-terminal-usage` polls one exact 3-in/5-out/13-micro incomplete SSE ledger settlement and released hold. The browser combo policy test captures a fresh bounded 8-token probe, requires its edited hash to persist as verified, and rejects protected top-level custom JSON before a probe or save. |
| Pricing/budgets/usage | `browser-reprice` snapshots job IDs/version, requires a new non-empty completed replacement job, pins its base/cache/tier rates, and independently prices every historical fixture row from explicit rates/tiers. It requires the exact 48-micro summary delta and independently derived key-window spend before verifying summary/ledger/current version membership after restart. Browser canonical selection persists fixture rates and prices a new request at 13 micros; fixed membership exclude/add survives reload. |
| Usage browser | All-time selected-range labels and exact/assumed/unpriced totals are rendered after deterministic fake traffic. `Order rows by` is exercised for name/recent/usage against rendered table order; custom today/yesterday ranges differ; the key row renders selected-range cost separately from the exact current-window spend. |
| Browser routing/accounting extension | local alias and reordered two-member combo, custom group, custom-window save, canonical pricing selection, fixed membership persistence, and Usage range/sort controls |
| Private CLIProxy, Codex, and sharing | `test:e2e:oauth-sharing` uses a managed loopback CLIProxy lookalike to cover callback state handling, account ownership, owner-billed shared native/Codex requests, revocation, and restart persistence. It does not contact a third-party identity or provider. |

The base/admin/accounting phases do not claim Codex/global shared-transport or
public model sharing; those are covered only by `test:e2e:oauth-sharing`'s
dedicated private transport fixture. None of these phases certifies live
third-party OAuth.

Prerequisites are Bun, the `agent-browser` CLI, and `/usr/bin/chromium`. The
harness selects that executable explicitly rather than using an installed
browser cache, user profile, or agent-browser defaults. The command builds `dist/`, starts
`dist/index.js` with `NODE_ENV=test`, and never starts HMR.

Each run creates an isolated temporary libSQL database and RawRoute data
directory, selects ephemeral application and test-only CLIProxy loopback ports,
and removes them on exit. `RAWROUTE_CLIPROXY_TEST_PORT` and the health identity
nonce are set only for the test process; production remains pinned to
`127.0.0.1:8317`. The only fake is a loopback upstream/CLIProxy boundary.
Authentication, browser UI, management routes, persistence, resolver, gateway,
usage ledger, and public landing run in the compiled app. Failure screenshots are written to ignored
`artifacts/e2e/`.

This is a compiled **test-mode** bundle check, not a standalone production
executable or a live-provider certification. The suite intentionally does not
claim live third-party OAuth or provider credentials: those require real
external accounts and are covered with controlled private transport fixtures in
the focused tests.
