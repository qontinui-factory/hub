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

## Studio credential (`hub auth`)

The studio publishes as the operator through qontinui-web. It holds the
operator's Cognito **refresh token** in a mode-600 file
(`STUDIO_WEB_REFRESH_TOKEN_FILE`, default `~/.qontinui/studio/web-refresh-token`)
and exchanges it for an **ID token** (never the access token) at
`https://auth.qontinui.io/oauth2/token` with the web app's public client. Every
web request carries `X-Qontinui-Active-Tenant`.

```bash
node bin/hub.mjs auth import <storage-state.json>  # from ui-bridge-login-web --storage-state-out; the file is deleted after
node bin/hub.mjs auth set                          # paste the token at the hidden prompt, or pipe it on stdin
node bin/hub.mjs auth check                        # admin role on the studio tenant?
node bin/hub.mjs auth refresh                      # exchange once, rewrite the bearer file
```

- The token is read from stdin or the storage-state file only. A token on argv
  is refused, and no command prints it.
- `import` reads sessionStorage key `auth_bearer_refresh_token` (the key
  qontinui-web's `token-storage.ts` writes) from the file's `__sessionStorage`
  map.
- After storing, the tool registers a coord reminder gate, due three days before
  the refresh token expires, and withdraws the previous one. It needs the coord
  door at `$QONTINUI_WORKSPACE_ROOT/qontinui-claude-config/.claude/skills/coord-revive/coord-revive.sh`,
  or `HUB_COORD_REVIVE`.
- Exit codes: 0 ok; 2 usage or nothing stored; 3 the token or the account was
  refused (re-sign-in needed); 4 transient; 6 stored and checked, but the
  reminder was not registered.
