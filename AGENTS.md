# Repository guidance

## Shape and ownership

- This repository is a Bun fullstack React app.
- `src/index.ts` owns the Bun server, HTML import, and API routes on port `3001`.
- `src/index.html` is the browser entry document and `src/frontend.tsx` mounts the React application.
- `src/App.tsx` is the client demo. It fetches `/api/hello` from the same Bun server.
- `src/index.css` contains the application styles. Build output is written to ignored `dist/`.

## Skills

- Use the `ask-bun` skill for questions related to Bun (Prefer this first before fetching resources).

## Commands

Run root commands with Bun:

```bash
bun install
bun run dev                 # Bun HMR server, http://127.0.0.1:3001
bun run build               # production Bun bundle in ignored dist/
bun run start               # production server
```

Focused checks:

```bash
curl --fail http://127.0.0.1:3001/api/health
curl --fail http://127.0.0.1:3001/api/hello
```

There are no root test or lint scripts. The build is the reliable application verification command.

## Preview tunnels

- `bun run dev:preview` runs the HMR server plus a Cloudflare Quick Tunnel.
- `bun run preview` builds first, then runs the production server plus a Quick Tunnel.
- Both scripts require `curl` and `cloudflared`, use port `3001` by default, wait on `/api/health`, and rewrite the origin Host header with `--http-host-header` for Bun dev-server compatibility.
- Set `PORT` to change the app port. The preview scripts do not require browser-specific environment variables.

## Change workflow

- Keep server routes in `src/index.ts` and browser behavior in `src/App.tsx`.
- Use Bun's HTML import and `Bun.serve`; do not add another frontend bundler or backend runtime.
- Keep `.env*`, `dist/`, and `node_modules/` local and out of commits.

## Reference resources

- Bun React guide: https://bun.sh/guides/ecosystem/react
- Bun fullstack server: https://bun.sh/docs/bundler/fullstack
- Bun HTML/static bundling: https://bun.sh/docs/bundler/html-static
- Bun runtime environment variables: https://bun.sh/docs/runtime/env
- Bun bundler: https://bun.sh/docs/bundler
- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
