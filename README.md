# RawRoute Docker Deployment

This deployment builds one image from the official Bun image and runs the Bun application directly. CLIProxy is managed as a subprocess inside that container and binds only to `127.0.0.1:8317`; Compose does not publish that port.

## Console Log

The dashboard Console Log shows live server and dashboard activity, with severity
filters, search, copy, and shared history clearing. It retains the latest 2,000
events in memory for the running server; restarting the server resets the history.
See [Logging](docs/logging.md) for event coverage and how to instrument new features.

## Private Testing

From the repository root:

```sh
cp -n .env.example .env
```

Edit `.env` before starting. Replace `AUTH_DEFAULT_PASSWORD` with a unique password between 8 and 128 characters. For private testing on the same machine, keep `APP_ORIGIN=http://localhost:3001`, `AUTH_COOKIE_SECURE=false`, and `TRUST_PROXY_HEADERS=false`.

Build and start the app:

```sh
docker compose up --build -d
docker compose ps
```

Open <http://localhost:3001>. The app database and CLIProxy configuration, credentials, downloaded binary, and lifecycle state persist together in the `rawroute-data` named volume mounted at `/data`. Compose sets `RAWROUTE_DATA_DIR=/data`, so CLIProxy state lives at `/data/cliproxy` and the database at `/data/rawroute.db`.

Compose publishes `3001:3001` on the host for private testing. Restrict access with the host firewall when testing from another machine. Set `APP_ORIGIN` to the exact origin used by the browser, including the scheme and port, for example `http://192.0.2.10:3001`. Do not use `localhost` when accessing the app through a remote IP or hostname.

## Public Use

Do not expose this HTTP setup publicly. Before public use, deploy HTTPS at a trusted network edge, use a strong unique `AUTH_DEFAULT_PASSWORD`, set `APP_ORIGIN` to the public `https://` origin, and set `AUTH_COOKIE_SECURE=true`. Keep `TRUST_PROXY_HEADERS=false` unless a trusted proxy strips incoming client-supplied forwarding headers and writes its own; only then set it to `true`.

The Compose service intentionally contains no TLS proxy. Keep CLIProxy on its private loopback address; do not add a published port for `8317`.

## Image And Data

The Dockerfile uses the same pinned official Bun image for dependency installation, asset building, and runtime. Dependencies are installed from `bun.lock` with `--frozen-lockfile`, and the build runs before only the compiled `dist/` output and production dependencies are copied into the runtime image. The container runs `bun index.js` from `/app/dist` as the non-root `bun` user so Bun resolves the generated HTML and frontend chunks from the build directory; the package's `start` script runs source directly and is not the container entry point.

The named volume is initialized from the image's `/data` directory, which is owned by `bun`. If you restore or attach a volume with different ownership, repair it once with:

```sh
docker compose run --rm --user root rawroute chown -R bun:bun /data
```

Keep `/data` persistent and backed up. The image itself is immutable; application and CLIProxy state are written only to the mounted data volume. To stop the service without removing its data, run `docker compose down`. Do not use `docker compose down -v` unless you intend to delete the database and CLIProxy state.
