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
  --native-min 1 --native-max 1 \
  --schema-min 44 --schema-max 44 \
  --bridge-capability database.sqlite \
  --bridge-capability keychain.secrets \
  --bridge-capability http.native \
  --bridge-capability mcp.native \
  --bridge-capability media.sandbox \
  --bridge-capability notifications.local \
  --bridge-capability ota.updater
(cd build/ota && zip -qry ../bundle.zip bundle)
```

The manifest records every bundle file, SHA-256, byte count, native bridge
range, schema range and required bridge capabilities. The app rejects a
manifest outside those gates and records pending/last-good state through the
native updater. A production host must publish the manifest and matching
`bundle.zip` as static HTTPS files; the app only checks an explicitly stored
`ota.manifestUrl` preference.

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
