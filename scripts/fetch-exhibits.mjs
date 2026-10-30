// Build-time read of every declared exhibit (plan D1, D2, A1, AI4.5).
//
// - Each exhibit comes from qontinui-web's public snapshot route.
// - The snapshot's content_sha256 is RECOMPUTED; a mismatch fails the build.
// - A 404 (unpublished or retracted) drops the exhibit, with a log line.
// - `has_bundle` says whether public/<slug>/ holds both pages the gallery links
//   to, so it never links to a missing one (Portofino has no bundle, AI4.6).
// - A1 guard: a committed bundle at public/<slug>/ whose record 404s fails
//   the deploy build. In PR CI (HUB_GUARD=pr) it fails only when the PR's
//   own diff touches public/<slug>/ (HUB_PR_TOUCHED, space-separated slugs);
//   otherwise it warns.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { contentSha256 } from './canonical.mjs';

const API = process.env.HUB_API_BASE ?? 'https://api.qontinui.io/api/v1/public/build-records';
const GUARD = process.env.HUB_GUARD ?? 'deploy';
const TOUCHED = touchedSlugs();

// In PR CI, the bundles this PR's own diff touches (public/<slug>/...). An
// explicit HUB_PR_TOUCHED wins; otherwise the diff against origin/main. When
// the diff cannot be read the guard stays a warning in PR CI (the deploy
// build on main enforces it in full either way).
function touchedSlugs() {
  if (process.env.HUB_PR_TOUCHED !== undefined) {
    return new Set(process.env.HUB_PR_TOUCHED.split(/\s+/).filter(Boolean));
  }
  if ((process.env.HUB_GUARD ?? 'deploy') !== 'pr') return new Set();
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { encoding: 'utf8' });
    return new Set(
      out.split('\n').map((f) => f.match(/^public\/([^/]+)\//)?.[1]).filter((s) => s && s !== '_hub'),
    );
  } catch (err) {
    console.warn(`warning: could not diff against origin/main (${err.message.split('\n')[0]}); A1 guard warns only`);
    return new Set();
  }
}
const OUT = process.env.HUB_EXHIBITS_OUT ?? 'src/data/exhibits.json';
const BUNDLE_PAGES = ['index.html', 'how-it-was-built.html'];

export async function readSnapshot(entry, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/${encodeURIComponent(entry.slug)}`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error(`exhibit ${entry.slug}: public route answered ${res.status}`);
  return { status: 200, body: await res.json() };
}

export function verify(slug, snap) {
  const got = contentSha256(snap.document);
  if (got !== snap.content_sha256) {
    throw new Error(
      `exhibit ${slug}: content_sha256 mismatch (snapshot says ${snap.content_sha256}, recomputed ${got})`,
    );
  }
  return snap;
}

export function guard(slug, { guardMode = GUARD, touched = TOUCHED, bundleExists } = {}) {
  const present = bundleExists ?? existsSync(`public/${slug}`);
  if (!present) return 'ok';
  const msg = `public/${slug}/ is committed but its build record is not published (A1 guard)`;
  if (guardMode === 'deploy' || touched.has(slug)) throw new Error(msg);
  console.warn(`warning: ${msg}`);
  return 'warn';
}

// The A1 guard treats any public/<slug>/ as a bundle, so a stale partial
// directory still fails the deploy. A link needs both pages to be there.
export function hasBundle(slug, { bundleExists, publicRoot = 'public' } = {}) {
  if (bundleExists !== undefined) return bundleExists;
  const dir = join(publicRoot, slug);
  const complete = BUNDLE_PAGES.every((page) => existsSync(join(dir, page)));
  if (!complete && existsSync(dir)) {
    console.warn(`warning: ${dir}/ lacks a bundle page; the gallery shows no link to it`);
  }
  return complete;
}

export async function collect(entries, opts = {}) {
  const shown = [];
  for (const entry of entries) {
    const snap = await readSnapshot(entry, opts.fetchImpl);
    if (snap.status === 404) {
      console.log(`exhibit ${entry.slug}: not published (404); dropped from the gallery`);
      guard(entry.slug, opts);
      continue;
    }
    verify(entry.slug, snap.body);
    shown.push({ slug: entry.slug, ...snap.body, has_bundle: hasBundle(entry.slug, opts) });
  }
  return shown;
}

async function main() {
  const { exhibits = [] } = loadYaml(readFileSync('exhibits.yaml', 'utf8')) ?? {};
  const shown = await collect(exhibits);
  mkdirSync('src/data', { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(shown, null, 2)}\n`);
  console.log(`exhibits: ${shown.length} shown of ${exhibits.length} declared`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
