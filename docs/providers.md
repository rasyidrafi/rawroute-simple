# Providers administration

The Providers screen persists ordinary provider desired state in the selected
workspace. Provider credentials are write-only: the browser receives only a
configured sentinel and never displays or stores upstream secret material.

`GET /api/providers/models` is the scoped aggregate collection used by model
selectors. It returns stable internal model IDs alongside public
`gatewayModelId` values; Routing and Pricing use the public gateway ID.
`GET /api/providers/cleanup` reads durable tombstones for the selected active
workspace, so failed deleted-provider cleanup remains visible after reload.

Saving a provider, credential, or model is separate from private CLIProxy
projection. The UI displays pending, error, native-execution-pending, and
deleted-provider cleanup status with a manual retry. A successful configuration
save does not make `/v1` available; public gateway routing remains gated.
