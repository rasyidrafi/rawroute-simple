# Operations and recovery

RawRoute upgrades its libSQL schemas before it starts accepting HTTP requests.
Startup runs the auth, workspace, key, provider, routing, sharing, accounting,
and Codex schema checks, then recovers interrupted workspace deletions,
accounting settlement/pricing work, and Codex cleanup/login state. A migration
failure stops startup; it does not leave a partially ready listener behind.

## Health and readiness

`GET /api/health` is unauthenticated and always returns a redacted dependency
summary with `Cache-Control: no-store`. It returns 200 only when the database
and the private loopback CLIProxy are ready; otherwise it returns 503. It never
includes paths, URLs, credentials, process IDs, or error text.

`executors.native` is `available` whenever the database-backed resolver can be
used, even if CLIProxy is unavailable. Native Responses traffic does not depend
on CLIProxy. `executors.projected` additionally requires healthy CLIProxy, so
projected/Codex traffic remains fail-closed while it is down and becomes ready
only after normal recovery/reconciliation. Health does not use browser cookies
or administrator authentication.

`GET /api/db/health` remains a database-only diagnostic and is also redacted.

## Backups and restore

There is no browser/API configuration export and no raw ledger export. Take a
consistent stopped-service backup or a volume/filesystem snapshot of the entire
data volume. At minimum, keep these together:

- the libSQL database (`rawroute.db` in Compose);
- `gateway-keys/master-key`;
- `provider-credentials/master-key`.

Those master keys must be restored with the database. Restoring encrypted rows
without their matching key fails closed; generating a replacement key cannot
recover the data. The CLIProxy directory in the same private volume can contain
OAuth refresh material. Include it only in an access-controlled encrypted
snapshot; do not copy it into a ticket, source repository, browser download, or
raw export.

For Compose, stop the service before a file copy, or use a storage-level
snapshot that guarantees consistency. Restore ownership to the `bun` user when
attaching a restored volume, then start normally and inspect `/api/health`.

## Targeted usage-ledger reconciliation

Use the maintenance command only with an explicit active workspace ID:

```sh
bun maintenance.js --workspace <workspace-id>
```

The compiled container entry lives at `/app/dist/maintenance.js`; the source
equivalent is `bun run maintenance:usage-ledger <workspace-id>`. It validates
that exact workspace, obtains normal workspace write admission,
rebuilds only that workspace's rollups from immutable usage events, reconciles
its budget counters, checks duplicate attempt IDs, and invalidates that
workspace's public analytics cache. It rejects unknown, deleting, and inactive
workspaces; it never falls back to `Default` or touches another workspace. Do
not run it against a raw database copy while the service is writing to it.

## Deployment checks

The container builds `dist/` and runs `bun index.js` from that directory. Source
startup (`bun run start`) is useful for direct host operation but is not the
container entrypoint. Production requires `DATABASE_URL`, `APP_ORIGIN`, and a
valid `AUTH_DEFAULT_PASSWORD`; Compose supplies the database URL and data root.
Keep port 8317 private on loopback and do not publish it.

Before a release, run `bun test`, `bun run lint`, `bunx tsc --noEmit`, and
`bun run build`, then perform a private-loopback smoke with CLIProxy unavailable
and a configured native Responses provider. Verify native traffic still works,
projected/Codex traffic is sanitized 503 until recovery, and health changes from
503 to 200 after the database/CLIProxy dependencies recover.
