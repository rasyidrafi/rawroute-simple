# Compiled browser E2E

Run the release fixture suite with:

```sh
bun run test:e2e
```

Prerequisites are Bun and the `agent-browser` CLI with a local Chromium
installation (`agent-browser install`). The command builds `dist/`, starts
`dist/index.js` with `NODE_ENV=test`, and never starts HMR.

Each run creates an isolated temporary libSQL database and RawRoute data
directory, selects ephemeral application and test-only CLIProxy loopback ports,
and removes them on exit. `RAWROUTE_CLIPROXY_TEST_PORT` is set only for the
test process; production remains pinned to `127.0.0.1:8317`. The only fake is a
loopback upstream/CLIProxy boundary. Authentication, browser UI, management
routes, persistence, resolver, gateway, usage ledger, and public landing run
in the compiled app. Failure screenshots are written to ignored
`artifacts/e2e/`.

The suite intentionally does not claim live third-party OAuth or provider
credentials: those require real external accounts and are covered with the
controlled private transport fixtures in the focused tests.
