// The loopback UI Bridge relay server `hub preview` (127.0.0.1:4330) and
// `hub verify` (127.0.0.1:4331) run (plan AD2, AE5, AI4.1, AI4.2).
//
// One `CommandRelay`, served by `createNextRouteHandlers(createRelayHandlers(relay), { relay })`
// at `/api/ui-bridge/*`: the relay SSE routes (`/heartbeat`, `/commands/stream`,
// `/commands`, `GET /tabs`) plus the relay-backed `/control/*` routes D7 drives.
// Node's request is wrapped as a web `Request` carrying `nextUrl`, and the
// handler gets `params.path`; the streamed `Response` body is piped back.
// Everything else is a static file server (a site root, plus optional mounts).
//
// It binds 127.0.0.1 ONLY: the relay trusts a header-less caller (AI4.1), so
// it must never be reachable off this machine.
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { CommandRelay, createRelayHandlers } from '@qontinui/ui-bridge/server';
import { createNextRouteHandlers } from '@qontinui/ui-bridge/server/nextjs';

export const BRIDGE_PREFIX = '/api/ui-bridge';
export const LOOPBACK = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

/**
 * Resolve a URL path to a file under `root`, or null. Refuses anything that
 * escapes the root (`..`, an encoded separator, a symlink out of it).
 */
export function resolveStatic(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.split('/').some((seg) => seg === '..')) return null;
  let base;
  try {
    base = realpathSync(root);
  } catch {
    return null;
  }
  let p = join(base, rel);
  if (rel.endsWith('/')) p = join(p, 'index.html');
  else if (existsSync(p) && statSync(p).isDirectory()) return { redirect: true };
  if (!existsSync(p)) {
    // Astro's directory-format pages: /about -> /about/index.html.
    if (existsSync(`${p}.html`)) p = `${p}.html`;
    else return null;
  }
  const real = realpathSync(p);
  if (real !== base && !real.startsWith(base + sep)) return null;
  if (!statSync(real).isFile()) return null;
  return { file: real };
}

function corsHeaders(corsOrigin, reqOrigin) {
  if (!corsOrigin || reqOrigin !== corsOrigin) return {};
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Caller-User-Id, X-UI-Bridge-Tab-Id, X-Requested-With, Cache-Control, Last-Event-ID',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

async function toWebRequest(req, res, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    init.body = Buffer.concat(chunks);
  }
  // Abort when the CLIENT goes away; `req` 'close' fires once its body is read.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  init.signal = ac.signal;
  const request = new Request(url, init);
  // The Next.js adapter reads request.nextUrl.searchParams.
  Object.defineProperty(request, 'nextUrl', { value: url });
  return request;
}

async function pipeWebResponse(response, res, extraHeaders) {
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, { ...headers, ...extraHeaders });
  if (!response.body) return res.end();
  const body = Readable.fromWeb(response.body);
  res.on('close', () => body.destroy());
  body.on('error', () => res.destroy());
  body.pipe(res);
}

/**
 * Start the server. `siteRoot` serves `/`; `mounts` maps a URL prefix
 * (`/<slug>/`) to a directory. `corsOrigin` (hub verify) is the ONE origin
 * whose page may call the relay cross-origin.
 */
export async function startBridgeServer({ port, siteRoot = null, mounts = {}, corsOrigin = null, log = () => {} }) {
  const relay = new CommandRelay();
  const handlers = createNextRouteHandlers(createRelayHandlers(relay), { relay });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${LOOPBACK}:${actualPort}`);
    const cors = corsHeaders(corsOrigin, req.headers.origin);
    // DNS rebinding and cross-site callers: the Host must be this loopback
    // socket, and an Origin, when sent, must be this server or the CORS origin.
    const self = `http://${LOOPBACK}:${actualPort}`;
    if (req.headers.host !== `${LOOPBACK}:${actualPort}` || (req.headers.origin && req.headers.origin !== self && req.headers.origin !== corsOrigin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('forbidden\n');
    }
    try {
      if (url.pathname === BRIDGE_PREFIX || url.pathname.startsWith(`${BRIDGE_PREFIX}/`)) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          return res.end();
        }
        const handler = handlers[req.method];
        if (!handler) {
          res.writeHead(405, cors);
          return res.end();
        }
        const path = url.pathname.slice(BRIDGE_PREFIX.length).split('/').filter(Boolean);
        const response = await handler(await toWebRequest(req, res, url), { params: { path } });
        return await pipeWebResponse(response, res, cors);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      let hit = null;
      let mounted = false;
      for (const [prefix, dir] of Object.entries(mounts)) {
        if (url.pathname === prefix.replace(/\/$/, '')) {
          hit = { redirect: prefix };
          break;
        }
        if (url.pathname.startsWith(prefix)) {
          mounted = true;
          hit = resolveStatic(dir, `/${url.pathname.slice(prefix.length)}`);
          break;
        }
      }
      if (!mounted && !hit && siteRoot) hit = resolveStatic(siteRoot, url.pathname);
      if (hit?.redirect) {
        // Relative to the REQUEST path, so a directory inside a mount stays in it.
        res.writeHead(301, { Location: hit.redirect === true ? `${url.pathname}/${url.search}` : hit.redirect });
        return res.end();
      }
      if (!hit) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found\n');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[extname(hit.file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': statSync(hit.file).size,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(hit.file).pipe(res);
    } catch (err) {
      log(`server error on ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    }
  });
  let actualPort = port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, resolve);
  });
  actualPort = server.address().port;
  return {
    port: actualPort,
    base: `http://${LOOPBACK}:${actualPort}`,
    bridgeBase: `http://${LOOPBACK}:${actualPort}${BRIDGE_PREFIX}`,
    relay,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
