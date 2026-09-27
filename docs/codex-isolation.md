# Codex auth-file ownership

Codex OAuth tokens are created, refreshed, and stored only by the private
loopback CLIProxy. RawRoute stores no access, refresh, or ID token and does not
place callback values in logs. A workspace account is only a mapping to an
auth-file name and CLIProxy auth index.

CLIProxy owns the provider's fixed callback URI and exchanges the authorization
code privately. If a browser cannot reach that listener, the workspace flow may
submit the complete `http://localhost:1455/auth/callback` URL for its matching
login state; RawRoute forwards only the state plus code/error to CLIProxy. It
does not rewrite provider redirect URIs or claim OAuth completion until
CLIProxy's subsequent status/poll result is terminal.

Each successful mapping receives the stable `rr-codex-<workspace-id>` prefix.
The durable `codex_login_lease` serializes both workspace and global Codex web
logins for five minutes; `codex_logins` carries the initiating workspace,
state, pre-login auth-file signatures, and expiry through restarts. Polling
requires both remote prefix/priority writes before it commits the local mapping;
a failed transition restores the prior prefix. Reauthorization atomically
supersedes a pending deletion tombstone. Timeout, cancel, workspace deletion,
and startup recovery cancel the remote session and remove the durable lease.

Every account mutation resolves the account by both workspace and account ID
before it calls CLIProxy. The public gateway generates the workspace prefix
itself and forwards Codex requests only to CLIProxy; it never makes a direct
native Codex request. Global CLIProxy management routes show redacted metadata
and refuse to change/delete a mapped Codex auth file, so a global administrator
cannot accidentally reassign a workspace account through the generic wrapper.

An owner may explicitly grant an enabled built-in Codex model to another
workspace. The grant resolves the owner model and a live owner mapping at
request time, then uses only `rr-codex-<owner-workspace>/<model-suffix>` at
CLIProxy's Responses endpoint. CLIProxy continues to own token refresh and
account selection within that owner prefix. A recipient cannot select an auth
file, auth index, account, prefix, or credential, and cannot use its own Codex
mapping for an owner's grant. A missing, disabled, deleting, reauthorization-
required, expired, or ownership-lost owner mapping hides the shared alias and
rejects execution. Owner budget/pricing settlement is mirrored as a zero-cost
consumer event as for other shares.

Quota reads call CLIProxy's `api-call` with `$TOKEN$`, cache redacted parsed
windows for five minutes in a workspace-first table, and retain a stale result
on refresh failure. A per-account refresh lock coalesces reads; a 401 marks
reauthorization required. Reset credits require the phrase `use my codex reset`,
a fresh exhausted weekly window, and an unused credit. Their durable idempotency
record reuses the upstream redemption request ID after an uncertain failure.
Pending auth-file deletions retain ownership protection and are retried after
CLIProxy startup, automatic recovery, and periodically while it is ready.
