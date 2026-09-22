# Repository guidance

## Shape and ownership

- This is one repository with two parts, not a workspace: root `src/` is the Bun/React fullstack app; `spacetimedb/` is the SpacetimeDB TypeScript module.
- Root `src/index.ts` serves the React HTML and Bun API routes on port `3001`; `/api/health` is the focused smoke-check endpoint.
- `spacetimedb/src/index.ts` owns the database schema and reducers. `src/module_bindings/` is generated client code; never hand-edit it.
- `spacetime.json` maps local database `rawroute-simple` to `./spacetimedb` and defines the development app command.

## Commands

Run root commands with Bun:

```bash
bun install
bun run dev                 # Bun HMR server, http://127.0.0.1:3001
bun run build               # current reliable root verification; writes ignored dist/
bun run start               # production server
bun run spacetime:generate  # regenerate root client bindings after module schema changes
```

For the module:

```bash
cd spacetimedb
bun install
bun run build
bun run publish             # only when an actual publish is intended
```

For local end-to-end development, run `spacetime dev` from the repository root so the local SpacetimeDB database/module and configured app command are coordinated. Do not publish to Maincloud as part of a local smoke check.

Focused check:

```bash
curl --fail http://127.0.0.1:3001/api/health
```

There are no root test or lint scripts. `bunx tsc --noEmit` is currently not a passing check: it reports the CSS side-effect import and TS2882 errors in generated bindings.

## Environment and browser bundling

- The browser defaults to `ws://localhost:3000` and database `rawroute-simple`.
- Override browser-visible settings with `BUN_PUBLIC_SPACETIMEDB_HOST` and `BUN_PUBLIC_SPACETIMEDB_DB_NAME`.
- `bunfig.toml` exposes only `BUN_PUBLIC_*` to frontend bundles. Keep frontend references as literal `process.env.BUN_PUBLIC_*` expressions; Bun's HTML bundler inlines those literals. Indirect or guarded access can leave `process` undefined in the browser.
- `.env*`, `spacetime.local.json`, `.spacetimedb-token`, `dist/`, and `node_modules/` are local/ignored artifacts and must not be committed.

## Preview tunnels

- `bun run dev:preview` runs the HMR server plus a Cloudflare Quick Tunnel.
- `bun run preview` builds first, then runs the production server plus a Quick Tunnel.
- Both scripts require `curl` and `cloudflared`, use port `3001` by default, wait on `/api/health`, and rewrite the origin Host header with `--http-host-header` for Bun dev-server compatibility.
- Set `PORT` to change the app port. Set `BUN_PUBLIC_SPACETIMEDB_HOST`/`BUN_PUBLIC_SPACETIMEDB_DB_NAME` before preview when the browser must use a non-default database endpoint.
- A Quick Tunnel only exposes the Bun HTTP app. A remote browser cannot reach `ws://localhost:3000` on the VPS; expose/configure a public SpacetimeDB WebSocket endpoint separately before testing realtime features remotely.

## Change workflow

- Change schema/reducers in `spacetimedb/src/index.ts`, then run `bun run spacetime:generate` from the root and rebuild the module.
- Trust executable configuration and scripts over stale prose. Keep generated bindings and build artifacts out of manual edits and commits.

## Reference resources

- SpacetimeDB overview: https://spacetimedb.com/docs/intro/what-is-spacetimedb/
- SpacetimeDB getting started: https://spacetimedb.com/docs/
- SpacetimeDB Bun quickstart: https://spacetimedb.com/docs/quickstarts/bun
- SpacetimeDB TypeScript modules: https://spacetimedb.com/docs/modules/typescript/
- Bun React guide: https://bun.sh/guides/ecosystem/react
- Bun fullstack server: https://bun.sh/docs/bundler/fullstack
- Bun HTML/static bundling and frontend env inlining: https://bun.sh/docs/bundler/html-static
- Bun runtime environment variables: https://bun.sh/docs/runtime/env
- Bun bundler: https://bun.sh/docs/bundler
- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
