# Model sharing ownership and isolation

Model sharing is an explicit, owner-created grant. A grant binds one active
owner `provider_models.id` to one active recipient workspace. It is never a
general `owner-workspace-id/model-id` routing mechanism. The internal model ID
is stable, so provider-prefix and model-suffix changes update the displayed
qualified target without changing the grant.

Recipients see redacted share views (grant ID, source workspace name, current
qualified model ID, display name, protocol, and availability). They cannot see
the owner provider ID, base URL, credentials, CLIProxy namespace, auth-file
name, grant metadata beyond their own grant, or any secret. A recipient may
only create a local alias by submitting both the qualified target and its own
grant ID. The server verifies both values and stores the grant ID with the
alias. Direct qualified model requests and arbitrary qualified alias targets
are rejected. Combos may use such a local alias, never a raw shared target.

At execution the recipient gateway key establishes the consumer workspace;
workspace headers remain ignored. The grant is re-read immediately before
transport selection, including active owner/consumer, owner model, provider,
and enabled credential checks. Execution then uses the owner's private native
or projected transport namespace. The consumer cannot alter the owner provider
or credential.

Enabled built-in Codex models may be shared. A Codex grant still binds the
owner's built-in `provider_models.id`, not a public `codex/...` string. Both
catalog resolution and execution require a live, enabled owner Codex mapping
whose CLIProxy auth file retains that owner's `rr-codex-<workspace>` prefix.
The recipient receives only the normal grant alias and model metadata; it
never receives an auth-file name, auth index, account ID, token, or provider
snapshot. Requests are normalized to Responses and forwarded through the
private CLIProxy using the owner-generated Codex prefix. Disabling, deleting,
reauthorizing, losing, or making that owner mapping unavailable makes the
grant unavailable before transport; it cannot fall back to a consumer account
or another provider. The owner workspace admission is held through completion
or stream drain so account/workspace revocation cannot race a shared request.

The owner is charged under the synthetic, non-secret budget identity
`shared-workspace:<consumer-workspace-id>`. The owner model's current pricing
and budget admission are authoritative and terminal; a budget denial cannot
fall through a combo member or credential retry. Settlement writes the priced
owner event and an idempotent, zero-cost mirrored consumer event with the same
request ID. Neither event contains prompts, responses, secrets, or transport
metadata. Synthetic identities are exposed only to the owning workspace's
budget/usage selectors, labeled by the recipient workspace name.

Revoking a grant deletes it and makes dependent aliases unavailable without
altering any owner configuration. Workspace deletion removes grants where the
workspace is owner or recipient, dependent recipient aliases, and associated
cross-workspace accounting work. Runtime resolution performs no ambient or
unbounded sharing cache, so revocation and deletion take effect on the next
request.
