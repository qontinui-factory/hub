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
  `https://api.qontinui.io/api/v1/public/build-records/<slug>`, and its
  `content_sha256` is recomputed (`scripts/canonical.mjs`); a mismatch fails the build.
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

- The token is read from stdin or the storage-state file only. No command takes
  a token argument, and none prints one.
- Nothing is stored until the new token both exchanges and passes the admin
  check, so a refused import leaves the previous credential in place.
- `import` reads sessionStorage key `auth_bearer_refresh_token` (the key
  qontinui-web's `token-storage.ts` writes) from the file's `__sessionStorage`
  map.
- After storing, the tool registers a coord reminder gate, due three days before
  the refresh token expires, and withdraws the previous one. It needs the coord
  door at `$QONTINUI_WORKSPACE_ROOT/qontinui-claude-config/.claude/skills/coord-revive/coord-revive.sh`,
  or `HUB_COORD_REVIVE`.
- Only a refusal of the token or the account posts a coord finding; a transient
  failure does not.
- Exit codes: 0 ok; 1 unexpected error; 2 usage; 3 the token or the account
  was refused (sign in again); 4 transient (retry); 6 stored and checked, but
  the reminder was not registered; 7 stored, but the storage-state file could
  not be deleted (delete it by hand); 8 both 6 and 7.

## Publishing to the hub (`hub publish` / `hub unpublish`)

These run on the one studio host (plan AO1), with `QONTINUI_WORKSPACE_ROOT`
set. The three roots are derived from it, and a disagreeing export is refused:
`STUDIO_HUB_CLONE` (`.studio/hub-publish`), `STUDIO_HUB_PREVIEW`
(`.studio/hub-preview`) and `STUDIO_ROOT` (`.studio/studio-host`, the studio
clone and its DB). The studio CLI is `HUB_STUDIO_CMD` (a JSON argv array), or
by default `poetry -C $STUDIO_ROOT run studio --root $STUDIO_ROOT`.

| Command | What it does |
|---|---|
| `hub record-publish <slug> [--reactivate]` | Sets the product `is_public` and publishes its record (this tenant's products only). |
| `hub publish <slug> [--reactivate] [-- <studio flags>]` | Recovers and resets the clone, then starts the preview and runs `studio launch run`. Commits `public/<slug>/` and `exhibits.yaml` and opens a PR. Coord lands it. |
| `hub unpublish <slug>` | Retracts the record, runs `studio launch unpublish`, and opens a PR that removes the bundle and the exhibit. |
| `hub preview <slug> [--no-build]` | Serves `dist/` on `127.0.0.1:4330`, with `${STUDIO_HUB_PREVIEW}/<slug>` at `/<slug>/` and the relay at `/api/ui-bridge`. Also opens one headless tab. |
| `hub verify <url> [--plain]` | Reads the page through UI Bridge and prints JSON: the snapshot, page-health and the `/_hub/ui-bridge.js` sha. `--plain` fails if a visitor's page would dial loopback or UI Bridge. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok |
| 2 | usage |
| 3 | web auth failed: re-run `hub auth import` |
| 4 | transient: retry |
| 5 | refused |
| 6 | the studio refused |

`hub verify` uses its own codes: 6 means no tab registered or a CRITICAL page-health result, 7 a boot-script mismatch, and 8 a `--plain` leak.
