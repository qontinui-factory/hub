# build.qontinui.io

The visitors' gallery of the Qontinui software factory: every exhibit is a real
production run, replayed from its frozen public build record.

Plan: `2026-10-17-build-qontinui-io-factory-hub` (qontinui-dev-notes).

## Build

```bash
pnpm install --frozen-lockfile
pnpm build        # scene assets, the UI Bridge boot script, exhibits, then astro build
pnpm test
```

- `exhibits.yaml` lists the exhibits. Each is read at build time from
  `https://api.qontinui.io/api/v1/public/build-records/<slug>` (or a committed
  fixture, until real records are public), and its `content_sha256` is
  recomputed (`scripts/canonical.mjs`); a mismatch fails the build.
- A record that is not published is dropped. A committed launch bundle at
  `public/<slug>/` whose record is not published fails the deploy build.
- `/_hub/ui-bridge.js` mounts the UI Bridge on every page. It connects to a
  relay only when a verifier sets `window.__QONTINUI_UI_BRIDGE_RELAY__` to a
  `127.0.0.1` URL before the page loads; an ordinary visitor's page opens no
  connection.
- Animations are `@qontinui/studio-scenes` scenes, mounted through its own web
  player; this repo draws none of its own.
