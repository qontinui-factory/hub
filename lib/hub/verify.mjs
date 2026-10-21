// `hub verify <url> [--plain]` (plan AD1, AE3, AI4.2, AI4.4, B10).
//
// Verifier mode: a loopback relay on 127.0.0.1:4331 that answers CORS for
// exactly the origin of <url> (with Access-Control-Allow-Private-Network), and
// a headless tab opted in by an init script, with the Chromium flags that let
// an https page reach a loopback relay (AE3). It reads `/control/snapshot`
// (page URL, exhibits found) and `/control/page-health`, all as
// `X-Caller-User-Id: hub-verifier`. It also checks the deployed
// `/_hub/ui-bridge.js` answers 200 and matches the locally built one (B10).
//
// Plain mode (--plain): the page in a plain Playwright tab with no init
// script; prints the request log and fails when any request goes to a
// loopback host or a UI Bridge path (AD1: a visitor's page dials nothing).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBridgeServer } from './bridge-server.mjs';
import { launchTab, relayInitScript, VERIFIER_USER } from './preview.mjs';
import { HubError } from './roots.mjs';

export const VERIFY_PORT = 4331;
export const LNA_FLAGS = ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults'];
export const BOOT_SCRIPT = '/_hub/ui-bridge.js';
export const EXIT = { pass: 0, health: 6, script: 7, plain: 8 };

const HEADERS = { 'X-Caller-User-Id': VERIFIER_USER, 'Content-Type': 'application/json' };

async function bridge(fetchImpl, base, method, path, body) {
  const res = await fetchImpl(`${base}${path}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) throw new HubError('failed', `${method} ${path}: HTTP ${res.status} ${json?.error ?? ''}`.trim());
  return json?.data ?? json;
}

/**
 * Exhibits in a snapshot: an element carrying `data-exhibit` (the exhibit
 * heading, Exhibit.astro), else exhibit headings found by their semantic path.
 */
export function exhibitsIn(snapshot) {
  const elements = snapshot?.elements ?? [];
  const bySlug = [...new Set(elements.map((e) => e.state?.dataset?.exhibit).filter(Boolean))];
  if (bySlug.length) return bySlug.map((slug) => ({ slug }));
  return elements
    .filter((e) => /\barticle\.exhibit\b/.test(e.stableRef?.semanticPath ?? '') && (e.type === 'heading' || /^h\d$/.test(e.tagName ?? '')))
    .map((e) => ({ slug: null, title: e.label ?? e.text }));
}

export async function bootScriptCheck(origin, distDir, fetchImpl = fetch) {
  const out = { url: `${origin}${BOOT_SCRIPT}`, status: 0, sha256: null, localSha256: null, matches: null };
  try {
    const res = await fetchImpl(out.url, { cache: 'no-store' });
    out.status = res.status;
    if (res.ok) out.sha256 = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  } catch (err) {
    out.error = err.message;
  }
  const local = join(distDir, BOOT_SCRIPT);
  if (existsSync(local)) {
    out.localSha256 = createHash('sha256').update(readFileSync(local)).digest('hex');
    out.matches = out.sha256 !== null && out.sha256 === out.localSha256;
  } else {
    out.note = `no local build at ${local} (run pnpm build): the sha is reported, not compared`;
  }
  out.ok = out.status === 200 && out.matches !== false;
  return out;
}

export async function verifyWithBridge(url, { port = VERIFY_PORT, distDir, launch = launchTab, fetchImpl = fetch, waitMs = 30_000, log = () => {} } = {}) {
  const origin = new URL(url).origin;
  const server = await startBridgeServer({ port, corsOrigin: origin, log });
  let tab = null;
  try {
    tab = await launch({
      url,
      uiBridgeBase: server.bridgeBase,
      callerUserId: VERIFIER_USER,
      initScripts: [relayInitScript(server.bridgeBase)],
      launchArgs: LNA_FLAGS,
      waitForUiBridgeMs: waitMs,
    });
    const result = { url, finalUrl: tab.finalUrl ?? null, relay: server.bridgeBase, corsOrigin: origin, registered: Boolean(tab.uiBridgeRegistered), tabId: tab.tabId ?? null };
    if (result.registered) {
      // Let auto-registration settle so the snapshot sees the page's elements.
      await bridge(fetchImpl, server.bridgeBase, 'POST', '/control/wait-for-idle', { timeout: 10_000 }).catch(() => null);
      const snap = await bridge(fetchImpl, server.bridgeBase, 'GET', '/control/snapshot');
      result.snapshot = {
        pageUrl: snap.page?.url ?? null,
        title: snap.page?.title ?? null,
        elements: snap.elements?.length ?? 0,
        exhibits: exhibitsIn(snap),
      };
      const health = await bridge(fetchImpl, server.bridgeBase, 'POST', '/control/page-health', {});
      const v = health?.value ?? health;
      result.pageHealth = {
        status: health?.status ?? null,
        summary: v?.summary ?? null,
        findings: (v?.findings ?? []).map((f) => ({ check: f.check, severity: f.severity, detail: f.detail })),
      };
    }
    result.bootScript = await bootScriptCheck(origin, distDir, fetchImpl);
    result.pass = result.registered && ['OK', 'WARNING'].includes(result.pageHealth?.summary);
    result.exit = !result.pass ? EXIT.health : !result.bootScript.ok ? EXIT.script : EXIT.pass;
    return result;
  } finally {
    try {
      await tab?.close();
    } catch {}
    await server.close();
  }
}

/** A request a visitor's page must never make: a loopback host or a UI Bridge relay path. */
export function isBridgeRequest(rawUrl, pageOrigin = null) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // A locally served page's own origin is loopback by construction; only its
  // UI Bridge paths count there.
  if (u.origin !== pageOrigin && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.'))) return true;
  return /\/api\/ui-bridge(\/|$)|\/ui-bridge\/(control|tabs|heartbeat|commands)|^\/(control|commands)\/|\/heartbeat$/.test(u.pathname);
}

export async function verifyPlain(url, { settleMs = 3_000, chromiumImpl } = {}) {
  const chromium = chromiumImpl ?? (await import('playwright')).chromium;
  const browser = await chromium.launch({ headless: true });
  const requests = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), type: r.resourceType() }));
    page.on('websocket', (ws) => requests.push({ method: 'WEBSOCKET', url: ws.url(), type: 'websocket' }));
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(settleMs);
    const offending = requests.filter((r) => isBridgeRequest(r.url, new URL(url).origin));
    return { url, status: res?.status() ?? null, requests, offending, pass: offending.length === 0, exit: offending.length ? EXIT.plain : EXIT.pass };
  } finally {
    await browser.close();
  }
}
