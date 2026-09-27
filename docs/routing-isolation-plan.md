# Routing ownership and isolation plan

This catalog slice is strictly workspace-local. `providers`, provider credentials,
provider models, aliases, combos, and combo members all carry `workspace_id` and
are queried with it explicitly. Browser DTOs are redacted and never contain an
encrypted credential, a decrypted credential, provider transport namespace, or
CLIProxy management material.

Cross-workspace sharing is implemented as the explicit grant model described in
[`model-sharing-ownership.md`](./model-sharing-ownership.md). The transport
boundary enforces the following:

1. A public gateway key resolves exactly one active workspace. Client workspace
   headers and raw client model targets cannot bypass that namespace.
2. A share is an owner-created, recipient-specific grant for one enabled owner
   model. Recipients can only resolve a local alias that names the qualified
   owner model from an active grant; no arbitrary owner/workspace/model path is
   accepted.
3. The owner controls provider credentials, private CLIProxy namespace,
   pricing, and budget reservation. The recipient receives redacted route DTOs
   only. Owner and recipient deletion/revocation must cancel/drain work, remove
   grants and aliases idempotently, and invalidate workspace-first caches.
4. Shared execution must use an owner-scoped transport namespace. It must never
   pass a client-supplied upstream URL, provider ID, auth-file name, or raw
   credential through to CLIProxy or an upstream.
5. OAuth/auth-file mappings need the same owner namespace and global private
   lifecycle lock. OAuth tokens remain only in CLIProxy; RawRoute stores a
   redacted mapping, never tokens.

Execution uses the owner transport and owner pricing. A consumer receives a
zero-cost mirrored usage event, and a recipient may only consume a grant through
a local alias that stores the grant ID. Codex OAuth models are intentionally not
shareable because no safe owner-isolated account selection is exposed.
