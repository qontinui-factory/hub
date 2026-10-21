// The hub publication commands (plan AH2, AJ1, AG1, AH1, B1, B8, C3, AD3, AF2).
// Each scenario runs the real command against a temp bare git remote, a real
// clone, and a temp studio sqlite DB, with a stubbed web door, studio adapter
// and PR transport, and asserts the DB rows and the clone's tree afterwards,
// not only the exit code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { main } from '../bin/hub.mjs';
import { TENANT_ID } from '../lib/auth/config.mjs';
import { AuthError } from '../lib/auth/token.mjs';
import { addExhibit, removeExhibit } from '../lib/hub/exhibits.mjs';
import { studioChildEnv } from '../lib/hub/flows.mjs';
import { makeGit } from '../lib/hub/git.mjs';
import { parseBranch, removalBranch } from '../lib/hub/prs.mjs';
import { hubRoots, publishDir } from '../lib/hub/roots.mjs';
import { studioArgv } from '../lib/hub/studio.mjs';
import { exhibitsIn, isBridgeRequest } from '../lib/hub/verify.mjs';

const SLUG = 'hub-retraction-probe';
for (const [k, v] of Object.entries({
  GIT_AUTHOR_NAME: 'hub test',
  GIT_AUTHOR_EMAIL: 'hub@example.test',
  GIT_COMMITTER_NAME: 'hub test',
  GIT_COMMITTER_EMAIL: 'hub@example.test',
})) process.env[k] = v;

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const SCHEMA = `CREATE TABLE launches (
  id TEXT PRIMARY KEY, product_slug TEXT NOT NULL, product_path TEXT NOT NULL, bundle_dir TEXT NOT NULL,
  record_sha256 TEXT, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, publish_dir TEXT,
  published_files TEXT, published_at TEXT, unpublished_at TEXT, superseded_by TEXT, notified_at TEXT, operator_notes TEXT)`;

const PROBE_YAML = readFileSync(new URL('../probe/hub-retraction-probe.yaml', import.meta.url), 'utf8');
const EXHIBITS = '# exhibits\nexhibits:\n  - slug: example-widget\n    fixture: fixtures/example-widget.json\n';

/**
 * A studio host in a temp workspace: a bare remote whose main carries the
 * probe yaml and exhibits.yaml, the hub clone, the preview root, and a studio
 * root with an empty launches table.
 */
function fixture({ mainBundle = null, exhibits = EXHIBITS } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  const remote = join(ws, 'remote.git');
  sh(ws, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  const seed = join(ws, 'seed');
  sh(ws, 'clone', '--quiet', remote, seed);
  mkdirSync(join(seed, 'probe'));
  writeFileSync(join(seed, 'probe', `${SLUG}.yaml`), PROBE_YAML);
  writeFileSync(join(seed, 'exhibits.yaml'), exhibits);
  writeFileSync(join(seed, '.gitignore'), '.studio-journal-*.json\n*.lock\n');
  if (mainBundle) {
    mkdirSync(join(seed, 'public', SLUG), { recursive: true });
    for (const [f, c] of Object.entries(mainBundle)) writeFileSync(join(seed, 'public', SLUG, f), c);
  }
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '--quiet', '--no-verify', '-m', 'seed');
  sh(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  mkdirSync(join(ws, '.studio', 'studio-host', '.studio'), { recursive: true });
  mkdirSync(join(ws, '.studio', 'studio-host', 'products'));
  sh(ws, 'clone', '--quiet', remote, join(ws, '.studio', 'hub-publish'));
  const roots = hubRoots({ QONTINUI_WORKSPACE_ROOT: ws });
  const db = new DatabaseSync(join(roots.STUDIO_ROOT, '.studio', 'studio.db'));
  db.exec(SCHEMA);
  return { ws, remote, roots, db, clone: roots.STUDIO_HUB_CLONE, dir: publishDir(roots, SLUG) };
}

const rows = (fx) => fx.db.prepare('SELECT id, status, superseded_by FROM launches ORDER BY created_at').all().map((r) => ({ ...r }));
const bundleFiles = (fx) => (existsSync(fx.dir) ? readdirSync(fx.dir).filter((f) => !f.startsWith('.')).sort() : []);
const mainHas = (fx, path) => {
  try {
    sh(fx.remote, 'cat-file', '-e', `main:${path}`);
    return true;
  } catch {
    return false;
  }
};

/** A studio stub with the real CLI's DB semantics (publish.py, AD3/AF2 readopt). */
function stubStudio(fx) {
  let n = 0;
  const calls = [];
  const files = (id) => ({ 'index.html': `<html>${id}</html>\n`, 'launch-manifest.json': `{"launch_id":"${id}"}\n` });
  const get = (id) => fx.db.prepare('SELECT * FROM launches WHERE id = ?').get(id);
  const now = () => new Date(Date.UTC(2026, 9, 21, 10, 0, n)).toISOString();
  const studio = {
    calls,
    files,
    /** A launch run: write the bundle, supersede the live one, record it published. */
    async launchRun(yaml) {
      calls.push(['run', yaml]);
      n += 1;
      const id = `${SLUG}-20261021T1000${String(n).padStart(2, '0')}`;
      mkdirSync(fx.dir, { recursive: true });
      const live = fx.db.prepare("SELECT * FROM launches WHERE status = 'published' AND publish_dir = ?").get(fx.dir);
      for (const rel of Object.keys(JSON.parse(live?.published_files ?? '{}'))) rmSync(join(fx.dir, rel), { force: true });
      const placed = {};
      for (const [f, c] of Object.entries(files(id))) {
        writeFileSync(join(fx.dir, f), c);
        placed[f] = sha256(c);
      }
      fx.db
        .prepare("UPDATE launches SET status = 'unpublished', unpublished_at = ?, superseded_by = ? WHERE status = 'published' AND publish_dir = ?")
        .run(now(), id, fx.dir);
      fx.db
        .prepare("INSERT INTO launches (id, product_slug, product_path, bundle_dir, status, created_at, publish_dir, published_files, published_at) VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)")
        .run(id, SLUG, yaml, '/tmp/b', now(), fx.dir, JSON.stringify(placed), now());
      return { code: 0, stdout: `launch ${id}: bundle at /tmp/b\n` };
    },
    async unpublish(id) {
      calls.push(['unpublish', id]);
      const r = get(id);
      if (r?.status !== 'published') return { code: 1, stdout: '' };
      for (const rel of Object.keys(JSON.parse(r.published_files))) rmSync(join(fx.dir, rel), { force: true });
      fx.db.prepare("UPDATE launches SET status = 'unpublished', unpublished_at = ? WHERE id = ?").run(now(), id);
      return { code: 0, stdout: `unpublished ${id}\n` };
    },
    async readopt(id) {
      calls.push(['readopt', id]);
      const r = get(id);
      if (!r || r.status !== 'unpublished') return { code: 2, stdout: '' };
      const atDir = fx.db.prepare('SELECT * FROM launches WHERE publish_dir = ? ORDER BY created_at DESC').all(fx.dir);
      if (atDir.some((x) => x.status === 'published')) return { code: 2, stdout: '' };
      if (!r.superseded_by && atDir[0]?.id !== id) return { code: 2, stdout: '' };
      const want = JSON.parse(r.published_files);
      const have = bundleFiles(fx);
      const same = have.length === Object.keys(want).length && have.every((f) => want[f] === sha256(readFileSync(join(fx.dir, f))));
      if (!same) return { code: 2, stdout: `${JSON.stringify({ code: 'bytes_differ', detail: 'x', launch_id: id, readopted: false })}\n` };
      fx.db.prepare("UPDATE launches SET status = 'published', superseded_by = NULL, unpublished_at = NULL WHERE id = ?").run(id);
      return { code: 0, stdout: '' };
    },
  };
  return studio;
}

/** A PR transport stub: rows as gh lists them, and refs/pull/<n>/head in the remote. */
function stubPrs(fx) {
  const prs = [];
  let n = 0;
  return {
    prs,
    list: (slug) =>
      prs
        .map((p) => ({ ...p, parsed: parseBranch(slug, p.headRefName) }))
        .filter((p) => p.parsed)
        .sort((a, b) => b.number - a.number),
    async open({ head, oid, title, body }) {
      n += 1;
      sh(fx.remote, 'update-ref', `refs/pull/${n}/head`, oid);
      const row = { number: n, headRefName: head, headRefOid: oid, state: 'OPEN', createdAt: `2026-10-21T10:00:${String(n).padStart(2, '0')}Z`, url: `https://github.com/qontinui-factory/hub/pull/${n}`, title, body };
      prs.push(row);
      return { number: n, url: row.url, via: 'stub' };
    },
    close: (number) => {
      prs.find((p) => p.number === number).state = 'CLOSED';
    },
    /** coord lands it: the head becomes main (a no-op rebase, so GitHub says MERGED). */
    land: (number) => {
      const p = prs.find((x) => x.number === number);
      sh(fx.remote, 'update-ref', 'refs/heads/main', p.headRefOid);
      p.state = 'MERGED';
    },
  };
}

function stubWeb({ unpublish = 200, route = 200, publication = null, onPublish } = {}) {
  const calls = [];
  const answer = (status, body) => ({ status, body, code: body?.detail?.error ?? null });
  const web = {
    calls,
    route,
    products: async () => (calls.push(['products']), answer(200, { products: [] })),
    putProduct: async (slug, body) => (calls.push(['put', slug, body]), answer(200, { slug, ...body })),
    publish: async (slug, reactivate) => {
      calls.push(['publish', slug, reactivate]);
      onPublish?.(web);
      return answer(201, { public_slug: slug, version: 2, content_sha256: 'a'.repeat(64) });
    },
    unpublish: async (slug) => {
      calls.push(['unpublish', slug]);
      const body = { 404: { detail: { error: 'build_record_not_published' } }, 409: { detail: { error: 'public_slug_owned_by_another_tenant' } }, 500: null }[unpublish] ?? { public_slug: slug, unpublished_at: '2026-10-21T10:00:00Z', latest_version: 1 };
      return answer(unpublish, body);
    },
    publication: async (slug) => (calls.push(['publication', slug]), answer(200, publication ?? { public_slug: slug, owned_by_caller_tenant: false, unpublished: false })),
    publicStatus: async () => web.route,
  };
  return web;
}

/** Run `hub <argv>` with every door stubbed except git and the DB. */
async function hub(fx, argv, { studio, prs, web, authCheck = async () => {}, env = {}, fetchImpl } = {}) {
  const logs = [];
  const findings = [];
  const preview = { started: 0, stopped: 0 };
  const code = await main(argv, {
    env: { QONTINUI_WORKSPACE_ROOT: fx.ws, ...env },
    fetchImpl: fetchImpl ?? (async () => {
      throw new Error('no network in tests');
    }),
    log: (m) => logs.push(m),
    roots: fx.roots,
    git: makeGit(fx.clone),
    studio,
    prs,
    web,
    call: (tool, args) => {
      findings.push({ tool, ...args });
      return { posted: true, finding: { finding_id: `f${findings.length}` } };
    },
    authCheck: env.STUDIO_WEB_REFRESH_TOKEN_FILE ? undefined : authCheck,
    startRefresher: () => () => {},
    startPreview: async () => {
      preview.started += 1;
      return { stop: async () => void (preview.stopped += 1) };
    },
    now: () => new Date(Date.UTC(2026, 9, 21, 11, 0, 0)),
  });
  return { code, logs, findings, preview };
}

/** A launch that already went live: published here, its bytes landed on main with the exhibit. */
async function landedLaunch(fx) {
  const studio = stubStudio(fx);
  const prs = stubPrs(fx);
  const web = stubWeb();
  const r = await hub(fx, ['publish', SLUG], { studio, prs, web });
  expect(r.code).toBe(0);
  prs.land(1);
  return { studio, prs, web };
}

describe('hub publish (A2, AI2, B9)', () => {
  it('publishes: preview started and stopped, studio run, bundle and exhibit committed, PR read back, one status finding', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    const prs = stubPrs(fx);
    const r = await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() });
    expect(r.code).toBe(0);
    expect(r.preview).toEqual({ started: 1, stopped: 1 });
    const [launch] = rows(fx);
    expect(launch.status).toBe('published');
    expect(sh(fx.clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`publish/${SLUG}-${launch.id}`);
    expect(sh(fx.clone, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['exhibits.yaml', `public/${SLUG}/index.html`, `public/${SLUG}/launch-manifest.json`]);
    expect(readFileSync(join(fx.clone, 'exhibits.yaml'), 'utf8')).toContain(`  - slug: ${SLUG}`);
    expect(prs.prs).toHaveLength(1);
    expect(prs.prs[0].body).toMatch(/^Plan: 2026-10-17-build-qontinui-io-factory-hub$/m);
    expect(sh(fx.remote, 'rev-parse', `refs/heads/publish/${SLUG}-${launch.id}`)).toBe(prs.prs[0].headRefOid);
    const status = r.findings.filter((f) => f.kind === 'status');
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ topic: 'studio-publication', resource_keys: [`hub:${SLUG}`, 'qontinui-factory/hub#1'] });
    expect(status[0].title).toMatch(/goes live when coord lands qontinui-factory\/hub#1/);
    expect(status[0].body).toContain(`hub unpublish ${SLUG}`);
    expect(studio.calls[0][1]).toBe(join(fx.clone, 'probe', `${SLUG}.yaml`));
  });

  it('refuses a slug whose public route 404s and names hub record-publish', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    const r = await hub(fx, ['publish', SLUG], { studio, prs: stubPrs(fx), web: stubWeb({ route: 404 }) });
    expect(r.code).toBe(5);
    expect(r.logs.join('\n')).toContain(`hub record-publish ${SLUG}`);
    expect(studio.calls).toEqual([]);
    expect(rows(fx)).toEqual([]);
  });

  it('stops the preview when the studio refuses, and proposes nothing', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    studio.launchRun = async () => ({ code: 2, stdout: 'launch x: bundle at /tmp/b\n' });
    const prs = stubPrs(fx);
    const r = await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() });
    expect(r.code).toBe(6);
    expect(r.preview).toEqual({ started: 1, stopped: 1 });
    expect(prs.prs).toEqual([]);
    expect(sh(fx.clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});

describe('the AH2 hub tests', () => {
  it('test_reserved_slug_refused', async () => {
    const fx = fixture();
    const before = sh(fx.clone, 'rev-parse', 'HEAD');
    for (const slug of ['tour', 'about', '_hub', '_astro', 'api', 'exhibits']) {
      const studio = stubStudio(fx);
      const r = await hub(fx, ['publish', slug], { studio, prs: stubPrs(fx), web: stubWeb() });
      expect(r.code).toBe(5);
      expect(r.logs.join('\n')).toMatch(/reserved/);
      expect(studio.calls).toEqual([]);
    }
    expect(rows(fx)).toEqual([]);
    expect(sh(fx.clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(fx.clone, 'status', '--porcelain')).toBe('');
  });

  it('test_dirty_clone_outside_slug_refuses', async () => {
    const fx = fixture();
    writeFileSync(join(fx.clone, 'exhibits.yaml'), `${EXHIBITS}  - slug: stray\n`);
    writeFileSync(join(fx.clone, 'notes.txt'), 'peer work\n');
    const studio = stubStudio(fx);
    const r = await hub(fx, ['publish', SLUG], { studio, prs: stubPrs(fx), web: stubWeb() });
    expect(r.code).toBe(5);
    expect(r.logs.join('\n')).toMatch(/dirty outside public\/hub-retraction-probe\/: exhibits.yaml, notes.txt/);
    expect(studio.calls).toEqual([]);
    expect(rows(fx)).toEqual([]);
    // Never stashed or cleaned.
    expect(readFileSync(join(fx.clone, 'notes.txt'), 'utf8')).toBe('peer work\n');
    expect(readFileSync(join(fx.clone, 'exhibits.yaml'), 'utf8')).toContain('stray');
  });

  it('test_open_hub_pr_blocks_reset', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    const prs = stubPrs(fx);
    expect((await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() })).code).toBe(0);
    const head = sh(fx.clone, 'rev-parse', 'HEAD');
    for (const argv of [['publish', SLUG], ['unpublish', SLUG]]) {
      const web = stubWeb();
      const r = await hub(fx, argv, { studio, prs, web });
      expect(r.code).toBe(5);
      expect(r.logs.join('\n')).toMatch(/hub PR #1 .* still open/);
      expect(web.calls.filter((c) => c[0] === 'unpublish')).toEqual([]);
    }
    expect(sh(fx.clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(rows(fx).map((r) => r.status)).toEqual(['published']);
    expect(bundleFiles(fx)).toEqual(['index.html', 'launch-manifest.json']);
    expect(studio.calls.map((c) => c[0])).toEqual(['run']);
  });

  it('test_publish_pr_closed_unlanded_unpublishes_then_resets', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    const prs = stubPrs(fx);
    expect((await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() })).code).toBe(0);
    const [l1] = rows(fx);
    prs.close(1); // closed, never landed
    const r = await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() });
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toMatch(/B8: publish PR #1/);
    // L1 was unpublished at its PR head before the reset, then L2 published.
    expect(studio.calls.map((c) => c[0])).toEqual(['run', 'unpublish', 'run']);
    const after = rows(fx);
    expect(after.map((x) => [x.id, x.status])).toEqual([
      [l1.id, 'unpublished'],
      [after[1].id, 'published'],
    ]);
    expect(after[0].superseded_by).toBeNull();
    expect(mainHas(fx, `public/${SLUG}`)).toBe(false);
    expect(sh(fx.clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`publish/${SLUG}-${after[1].id}`);
    expect(readFileSync(join(fx.dir, 'index.html'), 'utf8')).toContain(after[1].id);
    expect(prs.prs.map((p) => [p.number, p.state])).toEqual([[1, 'CLOSED'], [2, 'OPEN']]);
  });

  it('test_crash_before_pr_unpublishes_then_resets', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    const prs = stubPrs(fx);
    // The studio published, then the command died before the branch and PR.
    await studio.launchRun(join(fx.clone, 'probe', `${SLUG}.yaml`));
    const [l1] = rows(fx);
    expect(bundleFiles(fx)).toEqual(['index.html', 'launch-manifest.json']);
    const r = await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() });
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toMatch(new RegExp(`C3: launch ${l1.id}`));
    expect(studio.calls.map((c) => c[0])).toEqual(['run', 'unpublish', 'run']);
    const after = rows(fx);
    expect(after.map((x) => x.status)).toEqual(['unpublished', 'published']);
    expect(readFileSync(join(fx.dir, 'index.html'), 'utf8')).toContain(after[1].id);
    expect(prs.prs).toHaveLength(1);
    expect(prs.prs[0].headRefName).toBe(`publish/${SLUG}-${after[1].id}`);
  });

  it('test_unpublish_pr_closed_unlanded_readopts_and_reissues', async () => {
    const fx = fixture();
    const { studio, prs } = await landedLaunch(fx);
    const [l1] = rows(fx);
    const web = stubWeb();
    expect((await hub(fx, ['unpublish', SLUG], { studio, prs, web })).code).toBe(0);
    expect(rows(fx)[0].status).toBe('unpublished');
    expect(prs.prs[1].headRefName).toBe(`unpublish/${SLUG}-${l1.id}`);
    prs.close(2); // the removal never landed: main still serves L1's bytes

    const again = await hub(fx, ['unpublish', SLUG], { studio, prs, web });
    expect(again.code).toBe(0);
    // Reset restored L1's bytes; readopt-by-bytes made it live; the retraction was re-issued.
    expect(studio.calls.slice(1).map((c) => c.join(' '))).toEqual([`unpublish ${l1.id}`, `readopt ${l1.id}`, `unpublish ${l1.id}`]);
    expect(rows(fx).map((x) => x.status)).toEqual(['unpublished']);
    expect(prs.prs.map((p) => [p.number, p.state, p.headRefName])).toEqual([
      [1, 'MERGED', `publish/${SLUG}-${l1.id}`],
      [2, 'CLOSED', `unpublish/${SLUG}-${l1.id}`],
      [3, 'OPEN', `unpublish/${SLUG}-${l1.id}`],
    ]);
    expect(mainHas(fx, `public/${SLUG}/index.html`)).toBe(true); // still live until #3 lands
    expect(sh(fx.clone, 'ls-tree', '-r', '--name-only', 'HEAD', `public/${SLUG}`)).toBe('');
    expect(readFileSync(join(fx.clone, 'exhibits.yaml'), 'utf8')).not.toContain(SLUG);
    const f = again.findings.find((x) => x.kind === 'status');
    expect(f.body).toContain('unpublish PR #2 closed unlanded');
    expect(f.resource_keys).toEqual([`hub:${SLUG}`, 'qontinui-factory/hub#3']);
    // Act 1 ran again and is idempotent (AG1).
    expect(web.calls.filter((c) => c[0] === 'unpublish')).toHaveLength(2);
  });

  it('test_readopt_refusal_opens_removal_pr', async () => {
    // main serves bytes no launch here owns: L1 was superseded by L2, which
    // B8 unpublished, and main's bytes are neither's.
    const fx = fixture({ mainBundle: { 'index.html': '<html>foreign</html>\n' } });
    const studio = stubStudio(fx);
    const ins = fx.db.prepare("INSERT INTO launches (id, product_slug, product_path, bundle_dir, status, created_at, publish_dir, published_files, superseded_by) VALUES (?, ?, 'p', 'b', 'unpublished', ?, ?, ?, ?)");
    ins.run(`${SLUG}-20261020T090000`, SLUG, '2026-10-20T09:00:00Z', fx.dir, JSON.stringify({ 'index.html': sha256('l1') }), `${SLUG}-20261020T100000`);
    ins.run(`${SLUG}-20261020T100000`, SLUG, '2026-10-20T10:00:00Z', fx.dir, JSON.stringify({ 'index.html': sha256('l2') }), null);
    const prs = stubPrs(fx);
    const r = await hub(fx, ['publish', SLUG], { studio, prs, web: stubWeb() });
    expect(r.code).toBe(5);
    expect(studio.calls.map((c) => c.join(' '))).toEqual([`readopt ${SLUG}-20261020T090000`, `readopt ${SLUG}-20261020T100000`]);
    expect(rows(fx).map((x) => x.status)).toEqual(['unpublished', 'unpublished']);
    expect(prs.prs).toHaveLength(1);
    expect(prs.prs[0].headRefName).toBe(removalBranch(SLUG, new Date(Date.UTC(2026, 9, 21, 11, 0, 0))));
    expect(sh(fx.clone, 'show', '--name-status', '--format=', 'HEAD')).toBe(`D\tpublic/${SLUG}/index.html`);
    expect(existsSync(fx.dir)).toBe(false);
    expect(r.findings.find((f) => f.kind === 'status').title).toMatch(/removal PR #1/);
    expect(r.logs.join('\n')).toMatch(/refused launch .* bytes_differ/);
  });

  it.each([
    [200, 0, true],
    [404, 0, true],
    [409, 5, false],
    [500, 4, false],
  ])('test_unpublish_delete_200_and_404_are_done_409_and_500_stop (DELETE %i -> exit %i)', async (status, exit, proceeds) => {
    const fx = fixture();
    const { studio, prs } = await landedLaunch(fx);
    const head = sh(fx.clone, 'rev-parse', 'HEAD');
    const [l1] = rows(fx);
    const r = await hub(fx, ['unpublish', SLUG], { studio, prs, web: stubWeb({ unpublish: status }) });
    expect(r.code).toBe(exit);
    if (proceeds) {
      expect(studio.calls.at(-1)).toEqual(['unpublish', l1.id]);
      expect(rows(fx)[0].status).toBe('unpublished');
      expect(prs.prs.at(-1).headRefName).toBe(`unpublish/${SLUG}-${l1.id}`);
      expect(sh(fx.clone, 'ls-tree', '-r', '--name-only', 'HEAD', `public/${SLUG}`)).toBe('');
      expect(readFileSync(join(fx.clone, 'exhibits.yaml'), 'utf8')).not.toContain(SLUG);
    } else {
      expect(studio.calls.map((c) => c[0])).toEqual(['run']);
      expect(rows(fx)[0].status).toBe('published');
      expect(prs.prs).toHaveLength(1);
      expect(sh(fx.clone, 'rev-parse', 'HEAD')).toBe(head);
      expect(bundleFiles(fx)).toEqual(['index.html', 'launch-manifest.json']);
    }
    if (status === 409) expect(r.logs.join('\n')).toMatch(/Remaining act: DELETE \/api\/v1\/build-records\/hub-retraction-probe\/publish under the owning tenant/);
  });

  it('test_reactivate_flag_required_for_retracted_slug', async () => {
    const retracted = { public_slug: SLUG, owned_by_caller_tenant: true, unpublished: true };
    const fx = fixture();
    const studio = stubStudio(fx);
    const prs = stubPrs(fx);
    const web = stubWeb({ route: 404, publication: retracted });
    const refused = await hub(fx, ['publish', SLUG], { studio, prs, web });
    expect(refused.code).toBe(5);
    expect(refused.logs.join('\n')).toMatch(/build_record_retracted/);
    expect(web.calls.some((c) => c[0] === 'publish')).toBe(false);
    expect(studio.calls).toEqual([]);
    expect(rows(fx)).toEqual([]);

    const web2 = stubWeb({ route: 404, publication: retracted, onPublish: (w) => (w.route = 200) });
    const ok = await hub(fx, ['publish', SLUG, '--reactivate'], { studio, prs, web: web2 });
    expect(ok.code).toBe(0);
    expect(web2.calls.find((c) => c[0] === 'put')[2]).toMatchObject({ is_public: true, repos: ['qontinui/qontinui-studio'] });
    expect(web2.calls.find((c) => c[0] === 'publish')).toEqual(['publish', SLUG, true]);
    expect(rows(fx).map((x) => x.status)).toEqual(['published']);
    expect(readFileSync(join(fx.clone, 'exhibits.yaml'), 'utf8')).toContain(`  - slug: ${SLUG}`);
    expect(prs.prs).toHaveLength(1);
  });
});

describe('AJ1: hub unpublish with a dead web credential', () => {
  it('exits non-zero, still opens the removal PR, and posts the loud finding naming the DELETE owed', async () => {
    const fx = fixture();
    const { studio, prs } = await landedLaunch(fx);
    const [l1] = rows(fx);
    const state = join(fx.ws, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'refresh'), 'refresh-token-value\n', { mode: 0o600 });
    const fetchImpl = async (url) => {
      if (url.endsWith('/oauth2/token')) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      throw new Error(`unexpected ${url}`);
    };
    const web = stubWeb();
    const r = await hub(fx, ['unpublish', SLUG], {
      studio,
      prs,
      web,
      fetchImpl,
      env: { STUDIO_WEB_REFRESH_TOKEN_FILE: join(state, 'refresh'), STUDIO_WEB_BEARER_FILE: join(state, 'bearer') },
    });
    expect(r.code).toBe(3);
    expect(web.calls.filter((c) => c[0] === 'unpublish')).toEqual([]);
    expect(rows(fx)[0].status).toBe('unpublished');
    expect(prs.prs.at(-1)).toMatchObject({ number: 2, state: 'OPEN', headRefName: `unpublish/${SLUG}-${l1.id}` });
    expect(sh(fx.clone, 'ls-tree', '-r', '--name-only', 'HEAD', `public/${SLUG}`)).toBe('');
    const loud = r.findings.find((f) => f.kind === 'caveat');
    expect(loud).toMatchObject({ topic: 'studio-publication', resource_keys: [`hub:${SLUG}`, 'hub-auth'] });
    expect(loud.title).toMatch(new RegExp(`^hub unpublish ${SLUG}: web auth failed — the record DELETE is still owed`));
    expect(loud.body).toContain(`DELETE /api/v1/build-records/${SLUG}/publish`);
    expect(JSON.stringify(r.findings)).not.toContain('refresh-token-value');
    expect(r.findings.find((f) => f.kind === 'status').body).toMatch(/STILL OWED: DELETE/);
  });

  it('a web-writing command checks auth first: hub publish writes nothing when the check fails', async () => {
    const fx = fixture();
    const studio = stubStudio(fx);
    const prs = stubPrs(fx);
    const r = await hub(fx, ['publish', SLUG], {
      studio,
      prs,
      web: stubWeb(),
      authCheck: async () => {
        throw new AuthError('authoritative', 'refresh exchange refused: invalid_grant');
      },
    });
    expect(r.code).toBe(3);
    expect(studio.calls).toEqual([]);
    expect(prs.prs).toEqual([]);
    expect(r.findings[0].kind).toBe('caveat');
  });
});

describe('hub record-publish (AI4.7)', () => {
  it('PUTs is_public true, then POSTs publish with no body unless --reactivate', async () => {
    const fx = fixture();
    const web = stubWeb();
    expect((await hub(fx, ['record-publish', SLUG], { web, studio: stubStudio(fx), prs: stubPrs(fx) })).code).toBe(0);
    expect(web.calls.map((c) => c[0])).toEqual(['products', 'put', 'publish']);
    expect(web.calls[1][2]).toEqual({ title: SLUG, repos: ['qontinui/qontinui-studio'], window_start: null, window_end: null, is_public: true });
    expect(web.calls[2]).toEqual(['publish', SLUG, false]);
  });
  it("refuses another tenant's product", async () => {
    const fx = fixture();
    const web = stubWeb();
    const r = await hub(fx, ['record-publish', 'portofino'], { web, studio: stubStudio(fx), prs: stubPrs(fx) });
    expect(r.code).toBe(5);
    expect(web.calls).toEqual([]);
  });
});

describe('pieces', () => {
  it('roots: derived from the workspace, and a disagreeing export is refused (C1, AG2)', () => {
    const fx = fixture();
    expect(fx.roots.STUDIO_HUB_CLONE).toBe(join(fx.ws, '.studio', 'hub-publish'));
    expect(() => hubRoots({ QONTINUI_WORKSPACE_ROOT: fx.ws, STUDIO_HUB_CLONE: '/elsewhere' })).toThrow(/not .*hub-publish/);
    expect(() => hubRoots({})).toThrow(/QONTINUI_WORKSPACE_ROOT/);
  });
  it('the studio adapter: one argv, overridable by HUB_STUDIO_CMD; its env carries the bearer FILE and tenant, never a token', () => {
    const roots = { STUDIO_ROOT: '/s', STUDIO_HUB_CLONE: '/c', STUDIO_HUB_PREVIEW: '/p' };
    expect(studioArgv({}, roots)).toEqual(['poetry', '-C', '/s', 'run', 'studio', '--root', '/s']);
    expect(studioArgv({ HUB_STUDIO_CMD: '["studio","--root","/x"]' }, roots)).toEqual(['studio', '--root', '/x']);
    const e = studioChildEnv({ STUDIO_WEB_BEARER_FILE: '/b' }, roots);
    expect(e).toMatchObject({ STUDIO_WEB_BEARER_FILE: '/b', STUDIO_WEB_ACTIVE_TENANT: TENANT_ID, STUDIO_HUB_CLONE: '/c', STUDIO_HUB_PREVIEW: '/p', STUDIO_ROOT: '/s' });
    expect(e.STUDIO_WEB_BEARER).toBeUndefined();
  });
  it('branch names parse per act and never cross slugs', () => {
    expect(parseBranch('a', 'publish/a-a-20261021T100000')).toEqual({ act: 'publish', launchId: 'a-20261021T100000' });
    expect(parseBranch('a', 'unpublish/a-a-20261021T100000-2')).toEqual({ act: 'unpublish', launchId: 'a-20261021T100000-2' });
    expect(parseBranch('a', 'publish/a-b-a-b-20261021T100000')).toBeNull();
    expect(parseBranch('a-b', 'publish/a-b-a-b-20261021T100000')).toEqual({ act: 'publish', launchId: 'a-b-20261021T100000' });
    expect(parseBranch('a', 'remove/a-20261021T110000Z')).toEqual({ act: 'remove', launchId: null });
  });
  it('exhibits.yaml: add appends once, remove drops the entry and its fields, comments survive', () => {
    const added = addExhibit(EXHIBITS, 'x');
    expect(added).toBe(`${EXHIBITS}  - slug: x\n`);
    expect(addExhibit(added, 'x')).toBe(added);
    expect(removeExhibit(added, 'example-widget')).toBe('# exhibits\nexhibits:\n  - slug: x\n');
    expect(addExhibit('exhibits: []\n', 'y')).toBe('exhibits:\n  - slug: y\n');
  });
  it('verify: loopback and UI Bridge requests are flagged, the page origin itself is not', () => {
    expect(isBridgeRequest('http://127.0.0.1:4331/api/ui-bridge/heartbeat', 'https://build.qontinui.io')).toBe(true);
    expect(isBridgeRequest('https://build.qontinui.io/api/ui-bridge/tabs', 'https://build.qontinui.io')).toBe(true);
    expect(isBridgeRequest('https://build.qontinui.io/_hub/ui-bridge.js', 'https://build.qontinui.io')).toBe(false);
    expect(isBridgeRequest('http://127.0.0.1:4400/_astro/x.js', 'http://127.0.0.1:4400')).toBe(false);
    expect(isBridgeRequest('ws://localhost:9876/x', 'http://127.0.0.1:4400')).toBe(true);
  });
  it('verify: exhibits are read from data-exhibit, else from exhibit headings', () => {
    expect(exhibitsIn({ elements: [{ state: { dataset: { exhibit: 'a' } } }, { state: { dataset: {} } }] })).toEqual([{ slug: 'a' }]);
    expect(exhibitsIn({ elements: [{ type: 'heading', label: 'A', stableRef: { semanticPath: 'main > article.exhibit > header > h3' } }] })).toEqual([{ slug: null, title: 'A' }]);
  });
});
