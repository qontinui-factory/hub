// Hub PRs: the listing the recovery reads, and opening one over named
// transports (plan B5).
//
//   1. coord's remote MCP door, POST https://coord.qontinui.io/mcp,
//      `tools/call coord_create_pr`, with the device JWT from
//      ~/.qontinui/coord-device-jwt (its `exp` checked first). The request is
//      made in-process, so the bearer never reaches argv or a file.
//   2. on any failure there, `gh pr create`, attributed to the operator's
//      GitHub account (the finding says which transport opened it).
//   3. either way the PR exists only when
//      `gh pr list --repo qontinui-factory/hub --head <branch> --state all`
//      returns a row whose headRefOid is the pushed head; one re-read after
//      ~10 s, then failure.
//
// gh is rate-limited fleet-wide, so a command makes at most four gh calls:
// one listing, one create (fallback only), one or two read-backs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubError } from './roots.mjs';

export const HUB_REPO = 'qontinui-factory/hub';
export const PLAN_LINE = 'Plan: 2026-10-17-build-qontinui-io-factory-hub';
const COORD_MCP = process.env.HUB_COORD_MCP_URL ?? 'https://coord.qontinui.io/mcp';
const FIELDS = 'number,headRefName,headRefOid,state,createdAt,url';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse a hub branch name for `slug`: {act, launchId}, or null when it is not one. */
export function parseBranch(slug, name) {
  const id = `${esc(slug)}-\\d{8}T\\d{6}(?:-\\d+)?`;
  let m = name.match(new RegExp(`^(publish|unpublish)/${esc(slug)}-(${id})$`));
  if (m) return { act: m[1], launchId: m[2] };
  m = name.match(new RegExp(`^remove/${esc(slug)}-(\\d{8}T\\d{6}Z)$`));
  if (m) return { act: 'remove', launchId: null };
  return null;
}

export const branchFor = (act, slug, launchId) => `${act}/${slug}-${launchId}`;
export const removalBranch = (slug, now = new Date()) =>
  `remove/${slug}-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;

function ghJson(run, args) {
  let out;
  try {
    out = run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  } catch (err) {
    throw new HubError('transient', `gh ${args.slice(0, 2).join(' ')} failed: ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new HubError('transient', `gh ${args.slice(0, 2).join(' ')} answered something that is not JSON`);
  }
}

function jwtExp(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
  } catch {
    return null;
  }
}

/** Read a JSON-RPC answer that may come back as JSON or as an SSE stream. */
function rpcBody(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const data = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  return JSON.parse(data);
}

export function makePrs({ env = process.env, run = execFileSync, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() / 1000 } = {}) {
  const jwtPath = env.HUB_COORD_DEVICE_JWT_FILE ?? join(homedir(), '.qontinui', 'coord-device-jwt');

  async function viaCoord({ head, title, body }) {
    let token;
    try {
      token = readFileSync(jwtPath, 'utf8').trim();
    } catch (err) {
      throw new Error(`no device JWT at ${jwtPath} (${err.code})`);
    }
    const exp = jwtExp(token);
    if (!exp) throw new Error('the device JWT has no readable exp');
    if (exp - now() < 60) throw new Error(`the device JWT expired or expires within a minute (exp ${new Date(exp * 1000).toISOString()})`);
    const res = await fetchImpl(COORD_MCP, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'coord_create_pr', arguments: { repo: HUB_REPO, head, base: 'main', title, body } },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`coord /mcp answered HTTP ${res.status}`);
    const rpc = rpcBody(text);
    if (rpc.error) throw new Error(`coord_create_pr: ${rpc.error.message ?? JSON.stringify(rpc.error)}`);
    const content = rpc.result?.content?.[0]?.text ?? '';
    if (rpc.result?.isError) throw new Error(`coord_create_pr refused: ${content.slice(0, 300)}`);
    let parsed = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      // Not JSON: the read-back decides whether a PR exists.
    }
    return { number: parsed.number ?? parsed.pr_number ?? null, url: parsed.url ?? parsed.html_url ?? null };
  }

  function viaGh({ head, title, body }) {
    const dir = mkdtempSync(join(tmpdir(), 'hub-pr-'));
    const file = join(dir, 'body.md');
    try {
      writeFileSync(file, body, { mode: 0o600 });
      const out = run('gh', ['pr', 'create', '--repo', HUB_REPO, '--base', 'main', '--head', head, '--title', title, '--body-file', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      const url = out.trim().split('\n').pop();
      return { number: Number(url.match(/\/pull\/(\d+)/)?.[1]) || null, url };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    /** Every hub PR whose head branch is one of this slug's (publish/, unpublish/, remove/), newest first. */
    list(slug) {
      // One call for every hub PR (the repo is small); the limit is far above
      // its PR count, and a full page is refused rather than read as complete.
      const limit = 1000;
      const rows = ghJson(run, ['pr', 'list', '--repo', HUB_REPO, '--state', 'all', '--limit', String(limit), '--json', FIELDS]);
      if (rows.length >= limit) throw new HubError('failed', `gh pr list returned ${limit} PRs, its limit: older hub PRs may be missing, so recovery cannot trust it`);
      return rows
        .map((r) => ({ ...r, parsed: parseBranch(slug, r.headRefName) }))
        .filter((r) => r.parsed)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.number - a.number));
    },
    /** Open a PR (coord first, then gh) and read it back by head sha. */
    async open({ head, oid, title, body, log = () => {} }) {
      let via = 'coord_create_pr';
      try {
        await viaCoord({ head, title, body });
      } catch (err) {
        log(`coord_create_pr did not open the PR (${err.message}); falling back to gh pr create`);
        via = 'gh pr create (the operator\'s GitHub account)';
        try {
          viaGh({ head, title, body });
        } catch (ghErr) {
          // A PR may still exist (a coord create whose answer was lost); the read-back decides.
          log(`gh pr create failed: ${(ghErr.stderr || ghErr.message).toString().trim().split('\n')[0]}`);
        }
      }
      const read = () =>
        ghJson(run, ['pr', 'list', '--repo', HUB_REPO, '--head', head, '--state', 'all', '--json', FIELDS]).find((r) => r.headRefOid === oid);
      let row = read();
      if (!row) {
        await sleep(10_000);
        row = read();
      }
      if (!row) throw new HubError('failed', `no PR for ${head} at ${oid} after a re-read (B5): nothing was opened`);
      return { number: row.number, url: row.url, via };
    },
  };
}
