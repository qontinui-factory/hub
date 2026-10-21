// `hub preview <slug>` (plan D5, AD2, AE5, AF1, AG2, B9): the D7 preview.
//
// A Node server on 127.0.0.1:4330 only, serving the hub's built site (the
// clone's `dist/`, after `pnpm build`) with `${STUDIO_HUB_PREVIEW}/<slug>`
// mounted at `/<slug>/`, and the UI Bridge relay at `/api/ui-bridge/*`. Then
// ONE headless tab, opted in to the relay by an init script (AF1: the boot
// script never sets the relay itself), and a wait until `GET /tabs` reports it.
//
// The product yaml's preview fields are therefore:
//   ui_bridge_url:        http://127.0.0.1:4330/api/ui-bridge
//   preview_url:          http://127.0.0.1:4330/<slug>/
//   preview_manifest_url: http://127.0.0.1:4330/<slug>/launch-manifest.json
//   preview_dir:          ${STUDIO_HUB_PREVIEW}/<slug>
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { startBridgeServer } from './bridge-server.mjs';
import { previewDir, HubError } from './roots.mjs';
import { runChild } from './studio.mjs';

export const PREVIEW_PORT = 4330;
export const VERIFIER_USER = 'hub-verifier';

/** True when 127.0.0.1:`port` can be bound right now. */
export function probePort(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export const relayInitScript = (bridgeBase) => `window.__QONTINUI_UI_BRIDGE_RELAY__=${JSON.stringify(bridgeBase)}`;

export async function launchTab(options) {
  const { launchHeadlessTab } = await import('@qontinui/ui-bridge-headless');
  return launchHeadlessTab({ headless: true, forwardConsole: false, ...options });
}

/** Build the site in `siteDir` (the PR-CI guard mode: a stale bundle warns, never blocks a preview). */
export async function buildSite(siteDir, { log = () => {}, run = runChild } = {}) {
  const r = await run(['pnpm', 'run', 'build'], { cwd: siteDir, env: { ...process.env, HUB_GUARD: 'pr', HUB_PR_TOUCHED: '' }, log });
  if (r.code !== 0) throw new HubError('failed', `pnpm run build in ${siteDir} exited ${r.code}`);
}

/** GET <bridge>/tabs as D7 reads it (header-less, AI4.1): the registered tabs. */
export async function registeredTabs(bridgeBase, fetchImpl = fetch) {
  const res = await fetchImpl(`${bridgeBase}/tabs`);
  if (!res.ok) return [];
  const body = await res.json();
  const tabs = body?.data?.tabs ?? body?.tabs ?? body?.data ?? [];
  return Array.isArray(tabs) ? tabs : [];
}

/**
 * Start the preview and its tab. Returns {base, bridgeBase, tabId, stop}.
 * `stop` is idempotent and closes the tab before the server.
 */
export async function startPreview({ roots, slug, port = PREVIEW_PORT, build = true, log = () => {}, launch = launchTab, buildImpl = buildSite, waitMs = 30_000 }) {
  const siteDir = roots.STUDIO_HUB_CLONE;
  if (build) await buildImpl(siteDir, { log });
  const dist = join(siteDir, 'dist');
  if (!existsSync(join(dist, 'index.html'))) throw new HubError('failed', `${dist}/index.html is missing: run pnpm build in ${siteDir}`);
  const mount = previewDir(roots, slug);
  mkdirSync(mount, { recursive: true });
  const server = await startBridgeServer({ port, siteRoot: dist, mounts: { [`/${slug}/`]: mount }, log });
  let tab = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await tab?.close();
    } catch {}
    await server.close();
  };
  try {
    // The hub's own page carries the boot script, so the tab registers before
    // the studio has written anything under /<slug>/; D7 navigates it there.
    tab = await launch({
      url: `${server.base}/`,
      uiBridgeBase: server.bridgeBase,
      callerUserId: VERIFIER_USER,
      initScripts: [relayInitScript(server.bridgeBase)],
      waitForUiBridgeMs: waitMs,
    });
    const tabs = await registeredTabs(server.bridgeBase);
    if (!tabs.length) throw new HubError('failed', `no tab registered at ${server.bridgeBase}/tabs within ${waitMs} ms`);
    log(`preview: ${server.base}/ (bundle ${mount} at /${slug}/), relay ${server.bridgeBase}, tab ${tab.tabId ?? tabs[0]?.tabId ?? tabs[0]?.id}`);
    return { base: server.base, bridgeBase: server.bridgeBase, tabId: tab.tabId, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
