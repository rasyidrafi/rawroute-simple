# Repository guidance

## Runtime and ownership

- This is a single-package Bun/React app; do not add another bundler or backend runtime. `src/index.ts` imports `src/index.html` and owns the Bun server, API routes, and CLIProxy startup/shutdown. The browser entry is `src/index.html` → `src/frontend.tsx` → `src/App.tsx`.
- Keep API routes in `src/index.ts` and browser auth/UI behavior in `src/App.tsx` and feature components. Docker builds `dist/` and runs `bun index.js` from there; `bun run start` runs source and is not the container entrypoint.
- `src/components/dashboard/views.tsx` dispatches pages and owns mock collections shared across pages. Keep shared provider/model/routing/pricing state there so edits survive navigation; page-local dialogs and drafts belong in their page modules.
- Keep the Usage page lazy-loaded in `views.tsx`; this isolates Recharts in a split chunk (`doctor.config.json` relies on this boundary).
- `src/lib/cliproxy/index.ts` is the public CLIProxy API. `service.ts` coordinates lifecycle/locking/recovery; `store.ts` owns persisted state/config; `process-ownership.ts` inspects `/proc` without signaling; `version-store.ts` manages version staging/current links; `http.ts` handles routes/admission; `release.ts` downloads and verifies binaries.
- UI components are source-owned under `src/components/ui/`; `components.json` configures shadcn `base-nova` / Base UI, Tailwind v4, and Lucide. Reuse these components and consult the shadcn skill before adding or changing UI primitives.
- For Bun-specific API questions, use the `ask-bun` skill before external documentation.

## Environment and persistence

- Bun loads `.env`; copy `.env.example` and set `AUTH_DEFAULT_PASSWORD` (8–128 characters) before starting. Development defaults to `file:./dev.db`; production requires `DATABASE_URL` and `APP_ORIGIN` (see `src/lib/env.ts`). `.env.example` targets Compose and does not supply `DATABASE_URL` for a local `bun run start`.
- Auth schema setup/migrations and default-password initialization run in `src/lib/auth.ts` before the server listens. Changing `AUTH_DEFAULT_PASSWORD` does not reset a password already changed by the user.
- `RAWROUTE_DATA_DIR` defaults to `~/.local/share/rawroute`; Compose persists the database at `/data/rawroute.db` and CLIProxy state at `/data/cliproxy`. CLIProxy binds to `127.0.0.1:8317`; do not publish that port. See `README.md` for deployment and volume ownership.
- Preserve SIGINT/SIGTERM ordering in `src/index.ts`: reject new CLIProxy mutations and stop accepting HTTP connections, drain initialization/mutations, shut down CLIProxy, then force-stop remaining HTTP connections.

## Workspace foundation contract

- Workspaces are persisted administration resources. Global routes (auth, Settings, and CLIProxy lifecycle) deliberately ignore workspace headers. Public `/v1` authentication derives its active workspace only from the gateway key and ignores client workspace headers; it is currently gated until workspace routing exists. Only an administrator-scoped API may call `requireWorkspaceRequestScope(request)`; it must pass `scope.workspace.id` explicitly into every repository operation and never fall back to Default.
- Workspace-owned database tables need a non-null `workspace_id`; keep uniqueness and ownership relationships scoped with composite keys/constraints where appropriate, and include `workspace_id` in every query predicate. Do not authorize a workspace row from an unscoped resource ID.
- Scoped caches are opt-in, bounded, keyed by workspace first, and explicitly invalidated after mutations and workspace deletion. Do not add a cache without an invalidation plan or use an ambient/default workspace cache.
- Background jobs must persist/carry a workspace ID, re-check that it is active when they execute, and participate in deletion cancellation/draining or idempotent deletion cleanup. Process-local request scope is not job ownership.
- Provider credentials, OAuth accounts, and any shared CLIProxy transport require a documented ownership/isolation design before becoming workspace-scoped. Current provider controls are browser-only mock fixtures; do not imply that they, CLIProxy, or public `/v1` routing are tenant-isolated.

## Commands

```bash
bun install
bun run dev                 # HMR server; default port 3001
bun run build               # Bun.build + Tailwind; output in ignored dist/
bun run start               # source server with NODE_ENV=production
bun run lint                # oxlint, then React Doctor (no-restyle is a warning)
bunx tsc --noEmit           # strict typecheck; build does not typecheck
bun run doctor             # React diagnostics; exceptions in doctor.config.json
bun test                    # all Bun tests
bun test src/lib/auth.test.ts
bun test src/lib/cliproxy
bun test src/lib/cliproxy/service.test.ts
```

- CLIProxy lifecycle tests use Linux `/proc`, compiled child-process fixtures, and port `8317`; keep that port free and do not run concurrent copies of the suite.
- Preview commands require `cloudflared`: `bun run dev:preview` tunnels the HMR server; `bun run preview` requires `curl` and builds first but runs source via `start`, requiring production env settings. Both default to port `3001`; set `PORT` to change it.
