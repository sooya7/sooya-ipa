# Local iPhone runtime and OTA

The iOS build installs the React bundle and `@sooya/core` in one IPA. After
bootstrap, native mode uses `LocalCore` directly; the browser/PWA keeps the
existing HTTP client.

## Local boundaries

- SQLite, messages, memory, Life, moments, media metadata and admin state stay
  on the device.
- Provider keys and MCP bearer references are opaque Keychain references.
  JavaScript can test presence, but never reads the secret value.
- Provider HTTP, MCP, media and database operations cross the Swift bridge.
- New MCP tools are registered disabled. They require an explicit local policy
  decision before the reply tool runtime can call them.
- Notifications are capability-probed only. No business notification,
  APNs registration or permission request is performed during first launch.

## OTA package

Build a bundle only after typecheck and the web build pass:

```bash
node scripts/build-ota.mjs \
  --bundle packages/web/dist \
  --out build/ota \
  --release-id ota-20260813-01 \
  --native-min 5 --native-max 5 \
  --schema-min 46 --schema-max 46 \
  --bridge-capability database.sqlite \
  --bridge-capability keychain.secrets \
  --bridge-capability http.native \
  --bridge-capability mcp.native \
  --bridge-capability media.sandbox \
  --bridge-capability notifications.local \
  --bridge-capability ota.updater \
  --bridge-capability ota.signature.ed25519 \
  --signing-key /secure/path/ota-ed25519-private.pem
(cd build/ota && zip -qry ../bundle.zip bundle)
```

The manifest records every bundle file, SHA-256, byte count, native bridge
range, schema range and required bridge capabilities. The app rejects a
manifest outside those gates and records pending/last-good state through the
native updater. A production host must publish the manifest and matching
`bundle.zip` as static HTTPS files; the app only checks an explicitly stored
`ota.manifestUrl` preference. The configured production endpoint is
`https://sooya.icu/ota`, so the stable manifest is
`https://sooya.icu/ota/stable.json`. CI signs the canonical manifest with
Ed25519 when `OTA_PRIVATE_KEY` is configured and publishes immutable bundles
plus `stable.json` when `OTA_PUBLISH_URL` and `OTA_PUBLISH_TOKEN` are
configured. The server accepts authenticated PUTs only under `/ota/` and
serves the resulting files over HTTPS.

## Optional Ombre memory sync

Local SQLite remains the durability source of truth. If an MCP server with id
`ombre` is configured in local admin settings, memory recall uses Ombre and
local results together, while new local memories are queued for background
sync. Timeouts, authentication errors and disconnects degrade to local-only
recall; the durable outbox and tombstones retry push/forget operations after
the service returns. Without an `ombre` server entry, the app remains fully
local and does not attempt a network connection.

## Verification

```bash
npm run typecheck
npm run build
npm run test
npm run check:freeze
```

The core SQLite tests use Node 22 in CI because the test-only
`better-sqlite3` binary must match the runner ABI. The production iOS bundle
does not import or ship `better-sqlite3`.
