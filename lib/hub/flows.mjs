// `hub record-publish`, `hub publish` and `hub unpublish` (plan A1-A3, A7, B1,
// B5, B6, B8, B9, C3, AD3, AF2, AG1, AH1, AI1, AI2, AI4.7, AJ1, AK2, AK4).
//
// Every web-writing command runs the auth check first (refreshBearer, then
// the admin role on this tenant; AK2). A token is never printed and never put
// on argv: the studio reads the bearer FILE, which a refresher keeps fresh for
// the whole studio subprocess (AK4).
//
// Before the clone is reset to origin/main, its state is recovered so a reset
// never restores old bytes under a live studio row, and never leaves bytes on
// disk with no live row (which would wedge `gate_foreign_file`):
//   B8   a publish PR that closed unlanded: unpublish its launch at the PR head;
//   C3   a crash before the PR (a `published` row here, no PR for its branch):
//        unpublish it on the clone as it stands;
//   AF2  an unpublish PR that closed unlanded: after the reset, readopt the
//        launch by bytes and re-issue the retraction;
//   AD3  after the reset, readopt the launch the newest one superseded; when
//        readopt refuses, `git rm` public/<slug>/ and open a removal PR.
// "Landed" is never read from GitHub's state alone: a coord land that rebased
// the PR closes it as CLOSED (coord-ff-lands.md). A PR counts as landed when
// it is MERGED or when its head's public/<slug>/ tree is what origin/main has.
import { AuthError } from '../auth/token.mjs';
import { TENANT_ID, bearerFile } from '../auth/config.mjs';
import { postAuthFinding } from '../auth/coord.mjs';
import { addExhibit, editExhibits, removeExhibit } from './exhibits.mjs';
import { assertCleanOutsideSlug } from './git.mjs';
import { postStatusFinding } from './notify.mjs';
import { OWN_PRODUCTS, checkSlug, resolveProduct } from './product.mjs';
import { PLAN_LINE, branchFor, removalBranch } from './prs.mjs';
import { HubError, publishDir } from './roots.mjs';
import { lastJson, launchById, launchIdFromOutput, launchesAt } from './studio.mjs';
import { isAuthStatus } from './web.mjs';

export const SITE = 'https://build.qontinui.io';
/** `studio launch readopt --json` refusal codes (exit 2); anything else is an error. */
export const READOPT_REFUSALS = ['not_unpublished', 'no_publish_dir', 'launch_live', 'not_newest', 'bytes_differ', 'foreign_file'];
export const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, transient: 4, refused: 5, studio: 6 };

const statusExit = (status) => (status === 0 || status >= 500 ? EXIT.transient : EXIT.refused);

/** The studio subprocess's environment: the roots, the bearer FILE and the pinned tenant; never a token. */
export function studioChildEnv(env, roots) {
  return {
    STUDIO_ROOT: roots.STUDIO_ROOT,
    STUDIO_HUB_CLONE: roots.STUDIO_HUB_CLONE,
    STUDIO_HUB_PREVIEW: roots.STUDIO_HUB_PREVIEW,
    STUDIO_WEB_BEARER_FILE: bearerFile(env),
    STUDIO_WEB_ACTIVE_TENANT: TENANT_ID,
    STUDIO_WEB_BEARER: undefined,
  };
}

/** AK2 before every web write. Returns null on success, or the AuthError. */
async function authCheck(deps) {
  try {
    await deps.authCheck();
    return null;
  } catch (err) {
    if (err instanceof AuthError) return err;
    throw err;
  }
}

function loudAuth(deps, command, slug, notDone, detail) {
  const f = postAuthFinding(deps.call, command, notDone, detail, slug);
  deps.log(f.posted ? `posted coord finding ${f.id} (web auth failed)` : `coord finding NOT posted: ${f.why}`);
}

// ---- record-publish (AI4.7) ------------------------------------------------------

async function recordPublishInner(slug, { reactivate }, deps) {
  const { web, log } = deps;
  const listing = await web.products();
  if (isAuthStatus(listing.status)) return { auth: `GET /products answered HTTP ${listing.status}` };
  if (listing.status !== 200) return { exit: statusExit(listing.status), why: `GET /api/v1/build-records/products answered HTTP ${listing.status}${listing.code ? ` ${listing.code}` : ''}` };
  const row = (listing.body?.products ?? []).find((p) => p.slug === slug);
  let title = row?.title;
  let repos = row?.repos;
  if (!row) {
    // A product coord does not know yet is defined from its yaml.
    let product;
    try {
      product = resolveProduct(deps.roots, slug);
    } catch (err) {
      return { exit: EXIT.refused, why: `no coord product '${slug}' and no product yaml to define it from (${err.message})` };
    }
    title = product.title;
    repos = product.repos;
  }
  const put = await web.putProduct(slug, {
    title,
    repos,
    window_start: row?.window_start ?? null,
    window_end: row?.window_end ?? null,
    is_public: true,
  });
  if (isAuthStatus(put.status)) return { auth: `PUT /products/${slug} answered HTTP ${put.status}` };
  if (put.status !== 200) return { exit: statusExit(put.status), why: `PUT /api/v1/build-records/products/${slug} answered HTTP ${put.status}${put.code ? ` ${put.code}` : ''}` };
  log(`product ${slug}: is_public true (${row ? 'updated' : 'created'}; repos ${repos.join(', ')})`);
  const pub = await web.publish(slug, reactivate);
  if (isAuthStatus(pub.status)) return { auth: `POST /${slug}/publish answered HTTP ${pub.status}` };
  if (pub.status === 409 && pub.code === 'build_record_retracted') {
    return { exit: EXIT.refused, why: `${slug} is retracted (build_record_retracted): republishing is deliberate, re-run with --reactivate (AH1)` };
  }
  if (pub.status !== 201 && pub.status !== 200) {
    return { exit: statusExit(pub.status), why: `POST /api/v1/build-records/${slug}/publish answered HTTP ${pub.status}${pub.code ? ` ${pub.code}` : ''}` };
  }
  log(`record ${slug}: published version ${pub.body?.version} sha256 ${pub.body?.content_sha256}${reactivate ? ' (reactivated)' : ''}`);
  return { exit: EXIT.ok, version: pub.body?.version };
}

export async function recordPublish(slug, { reactivate = false } = {}, deps) {
  checkSlug(slug);
  if (!OWN_PRODUCTS.includes(slug)) {
    throw new HubError('refused', `'${slug}' is not one of this tenant's products (${OWN_PRODUCTS.join(', ')}); another tenant's record is published under its own credential (A5, AI4.7)`);
  }
  const authErr = await authCheck(deps);
  if (authErr) {
    deps.log(`hub record-publish ${slug}: ${authErr.message}`);
    loudAuth(deps, 'record-publish', slug, 'the record was NOT published', authErr.message);
    return authErr.kind === 'transient' ? EXIT.transient : EXIT.auth;
  }
  const r = await recordPublishInner(slug, { reactivate }, deps);
  if (r.auth) {
    deps.log(`hub record-publish ${slug}: ${r.auth}`);
    loudAuth(deps, 'record-publish', slug, 'the record was NOT published', r.auth);
    return EXIT.auth;
  }
  if (r.exit !== EXIT.ok) deps.log(`hub record-publish ${slug}: ${r.why}`);
  return r.exit;
}

// ---- clone recovery and reset ------------------------------------------------------

/**
 * A reset keeps untracked files; under public/<slug>/ they are bytes no launch
 * owns, which the studio's foreign-file gate refuses and a later `git add`
 * would commit. Refused, never cleaned (A3).
 */
function refuseStrays(slug, deps) {
  const strays = deps.git.untracked(`public/${slug}`);
  if (strays.length) {
    throw new HubError('refused', `after the reset, ${strays.length} untracked file(s) remain under public/${slug}/ that no launch removed: ${strays.slice(0, 10).join(', ')}; inspect and delete them by hand`);
  }
}

/** B8 + A3: the refusals that come before anything is touched. Returns the slug's hub PRs. */
function preflight(slug, deps) {
  assertCleanOutsideSlug(deps.git, slug);
  const prs = deps.prs.list(slug);
  const open = prs.filter((p) => p.state === 'OPEN');
  if (open.length) {
    throw new HubError('refused', `hub PR ${open.map((p) => `#${p.number} (${p.headRefName})`).join(', ')} for ${slug} is still open; the clone is not reset while it is (B8). Re-run once coord lands or closes it.`);
  }
  return prs;
}

function makeLanded(slug, deps) {
  const path = `public/${slug}`;
  const cache = new Map();
  return (pr) => {
    if (pr.state === 'MERGED') return true;
    if (!cache.has(pr.number)) {
      const head = deps.git.fetchPr(pr.number);
      cache.set(pr.number, deps.git.treeAt(head, path) === deps.git.treeAt('refs/remotes/origin/main', path));
    }
    return cache.get(pr.number);
  };
}

/** The clone's public/<slug>/ differs from origin/main's (committed locally or not). */
function differsFromMain(slug, deps) {
  const path = `public/${slug}`;
  if (deps.git.dirtyPaths().some((p) => p.startsWith(`${path}/`))) return true;
  return deps.git.treeAt('HEAD', path) !== deps.git.treeAt('refs/remotes/origin/main', path);
}

async function studioOk(promise, what) {
  const r = await promise;
  if (r.code !== 0) throw new HubError('failed', `${what} exited ${r.code}${r.error ? ` (${r.error})` : ''}`, EXIT.studio);
  return r;
}

/** Commit, push and open a PR; returns {number, url, via, head}. */
async function proposeBranch(deps, { branch, message, title, body }) {
  const head = deps.git.commitPaths(deps.commitPaths, message);
  if (!head) return null;
  deps.git.push(branch);
  const pr = await deps.prs.open({ head: branch, oid: head, title, body: `${body}\n\n${PLAN_LINE}\n`, log: deps.log });
  deps.log(`opened PR #${pr.number} (${pr.url}) via ${pr.via}, head ${head}`);
  return { ...pr, head };
}

/** AD3 fallback: `git rm` public/<slug>/ (and, retracting, the exhibit) on a fresh branch, as a removal PR. */
async function removalPr(slug, deps, { dropExhibit, why }) {
  const branch = removalBranch(slug, deps.now());
  deps.git.newBranch(branch);
  deps.git.raw(['rm', '-r', '-q', '--', `public/${slug}`]);
  if (dropExhibit) editExhibits(deps.roots.STUDIO_HUB_CLONE, (t) => removeExhibit(t, slug));
  const pr = await proposeBranch(
    { ...deps, commitPaths: [`public/${slug}`, 'exhibits.yaml'] },
    {
      branch,
      message: `chore: remove public/${slug}/ (no studio launch owns these bytes)`,
      title: `remove: ${slug} bundle no studio launch owns`,
      body: `Removes \`public/${slug}/\`${dropExhibit ? ` and the \`${slug}\` exhibit` : ''}. ${why}\n\nNo studio launch could be re-adopted for the bytes on main (plan AD3), so they are removed; once this lands the directory is empty and the next \`hub publish ${slug}\` passes the studio's foreign-file gate.`,
    },
  );
  const f = postStatusFinding(deps.call, {
    slug,
    pr: pr.number,
    title: `hub ${slug}: removal PR #${pr.number} opened; ${SITE}/${slug}/ is removed when coord lands it`,
    body: `${why}\n\nNo studio launch could be re-adopted for the bytes on origin/main at public/${slug}/ (AD3), so PR ${pr.url} removes them${dropExhibit ? ' and the exhibit' : ''} (opened via ${pr.via}). The next \`hub publish ${slug}\` can run once it lands. Unpublish command: \`hub unpublish ${slug}\`.`,
  });
  deps.log(f.posted ? `posted coord finding ${f.id}` : `coord finding NOT posted: ${f.why}`);
  return pr;
}

/**
 * Recover, reset to origin/main, and re-adopt. Returns
 *   {removal: pr}           a removal PR was opened (the caller stops);
 *   {reissue: {closed}}     AF2: an unpublish PR closed unlanded and its launch was re-adopted;
 *   {}                      the clone is at origin/main and consistent.
 */
async function recoverAndReset(slug, prs, deps, { retracting }) {
  const { git, studio, roots, log } = deps;
  const dir = publishDir(roots, slug);
  git.fetch();
  const landed = makeLanded(slug, deps);

  for (const l of launchesAt(roots, dir, { log }).filter((x) => x.status === 'published')) {
    const pr = prs.find((p) => p.parsed.act === 'publish' && p.parsed.launchId === l.id);
    if (pr && pr.state === 'CLOSED' && !landed(pr)) {
      log(`B8: publish PR #${pr.number} for launch ${l.id} closed unlanded; unpublishing it at the PR head before the reset`);
      try {
        git.checkoutDetached(git.fetchPr(pr.number));
      } catch (err) {
        throw new HubError('refused', `B8: cannot check out PR #${pr.number}'s head to unpublish launch ${l.id}: ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
      }
      await studioOk(studio.unpublish(l.id), `studio launch unpublish --launch ${l.id}`);
    } else if (!pr && differsFromMain(slug, deps)) {
      log(`C3: launch ${l.id} is published here with no hub PR (a crash before the PR); unpublishing it on the clone as it stands`);
      await studioOk(studio.unpublish(l.id), `studio launch unpublish --launch ${l.id}`);
    }
  }

  const newestPr = prs[0];
  const af2 = newestPr && newestPr.parsed.act === 'unpublish' && newestPr.state === 'CLOSED' && !landed(newestPr) ? newestPr : null;

  git.resetToMain();
  log(`clone reset to origin/main ${git.mainSha().slice(0, 12)}`);
  refuseStrays(slug, deps);

  const launches = launchesAt(roots, dir, { log });
  if (launches.some((l) => l.status === 'published') || !git.treeAt('HEAD', `public/${slug}`)) return {};

  // Bytes on main with no live row: re-adopt the launch they belong to.
  const newest = launches[0];
  const candidates = [];
  if (newest) {
    const superseded = launches.find((l) => l.status === 'unpublished' && l.superseded_by === newest.id);
    if (superseded) candidates.push({ id: superseded.id, arm: 'AD3 (superseded)' });
    if (newest.status === 'unpublished' && !newest.superseded_by) candidates.push({ id: newest.id, arm: 'AF2 (by bytes)' });
  }
  for (const c of candidates) {
    const r = await studio.readopt(c.id);
    if (r.code === 0) {
      log(`readopt ${c.arm}: launch ${c.id} is live again for the bytes on main`);
      return af2 ? { reissue: { closed: af2, launchId: c.id } } : {};
    }
    const why = lastJson(r.stdout);
    if (r.code !== 2 || why?.readopted !== false || !READOPT_REFUSALS.includes(why?.code)) {
      // Not a refusal the studio documents (a missing `readopt` command, a
      // crash, not_found): never turn that into a removal PR of a live page.
      throw new HubError('failed', `studio launch readopt --launch ${c.id} exited ${r.code} without a documented refusal${why?.code ? ` (${why.code})` : ''}; nothing was removed`, EXIT.studio);
    }
    log(`readopt ${c.arm} refused launch ${c.id} (${why.code}${why.detail ? `: ${why.detail}` : ''})`);
  }
  const why = af2
    ? `Unpublish PR #${af2.number} closed unlanded and its launch could not be re-adopted.`
    : `public/${slug}/ is on origin/main but no studio launch on this host owns it${candidates.length ? ' (readopt refused)' : ''}.`;
  return { removal: await removalPr(slug, deps, { dropExhibit: retracting || Boolean(af2), why }) };
}

// ---- unpublish (A1, AG1, AJ1, B6) ------------------------------------------------

/** A1 act 1. Returns {done, owed?, stop?}. */
async function retractRecord(slug, deps, authErr) {
  if (authErr) return { done: false, owed: `DELETE /api/v1/build-records/${slug}/publish (web auth failed: ${authErr.message})` };
  const r = await deps.web.unpublish(slug);
  if (r.status === 200) {
    deps.log(`act 1: record ${slug} retracted (unpublished_at ${r.body?.unpublished_at})`);
    return { done: true };
  }
  if (r.status === 404 && r.code === 'build_record_not_published') {
    deps.log(`act 1: nothing was ever published under ${slug} (404 build_record_not_published): done`);
    return { done: true };
  }
  if (isAuthStatus(r.status)) return { done: false, owed: `DELETE /api/v1/build-records/${slug}/publish (answered HTTP ${r.status})`, authFailed: true };
  if (r.status === 409) return { done: false, crossTenant: true, code: r.code };
  return { stop: true, why: `DELETE /api/v1/build-records/${slug}/publish answered ${r.status === 0 ? 'nothing (unreachable)' : `HTTP ${r.status}`}${r.code ? ` ${r.code}` : ''}; acts 2 and 3 NOT done (every act is idempotent: re-run)`, exit: statusExit(r.status) };
}

/** Acts 2 and 3 on a reset clone: studio unpublish, then the removal PR with the exhibit dropped. */
async function retractBundle(slug, deps, { act1, note = '' }) {
  const { git, studio, roots, log } = deps;
  const dir = publishDir(roots, slug);
  const live = launchesAt(roots, dir, { log }).find((l) => l.status === 'published');
  let act2 = 'no published launch here (nothing for the studio to remove)';
  if (live) {
    await studioOk(studio.unpublish(live.id), `studio launch unpublish --launch ${live.id}`);
    const after = launchById(roots, live.id);
    if (after?.status !== 'unpublished') throw new HubError('failed', `studio unpublish of ${live.id} exited 0 but its row reads '${after?.status}'`, EXIT.studio);
    act2 = `studio launch ${live.id} unpublished`;
  }
  log(`act 2: ${act2}`);
  const branch = live ? branchFor('unpublish', slug, live.id) : removalBranch(slug, deps.now());
  git.newBranch(branch);
  editExhibits(roots.STUDIO_HUB_CLONE, (t) => removeExhibit(t, slug));
  const owed = act1.owed ? `\n\nSTILL OWED: ${act1.owed}. Until it is made the snapshot stays readable at api.qontinui.io.` : '';
  const pr = await proposeBranch(
    { ...deps, commitPaths: [`public/${slug}`, 'exhibits.yaml'] },
    {
      branch,
      message: `chore: unpublish ${slug} from the hub${live ? ` (launch ${live.id})` : ''}`,
      title: `unpublish: ${slug}`,
      body: `Retracts \`${slug}\` from build.qontinui.io: removes \`public/${slug}/\` and the exhibit (plan A1, B6).\n\n- act 1 (record): ${act1.done ? 'retracted' : 'NOT done'}\n- act 2 (studio): ${act2}${note ? `\n\n${note}` : ''}${owed}`,
    },
  );
  if (!pr) {
    log(`act 3: origin/main already carries neither public/${slug}/ nor the exhibit: nothing to propose`);
    return { pr: null, act2 };
  }
  const f = postStatusFinding(deps.call, {
    slug,
    pr: pr.number,
    title: `hub unpublish ${slug}: PR #${pr.number} removes the page; it leaves ${SITE} when coord lands it`,
    body: `Removal PR ${pr.url} (opened via ${pr.via}, head ${pr.head}) removes public/${slug}/ and the ${slug} exhibit. ${SITE}/${slug}/ keeps serving until coord lands it (the merge train's pace).\n\nAct 1 (record DELETE): ${act1.done ? 'done — the public route 404s now' : 'NOT done'}. Act 2: ${act2}.${note ? `\n\n${note}` : ''}${owed}`,
  });
  log(f.posted ? `posted coord finding ${f.id}` : `coord finding NOT posted: ${f.why}`);
  return { pr, act2 };
}

export async function unpublish(slug, deps) {
  checkSlug(slug);
  const authErr = await authCheck(deps);
  if (authErr) deps.log(`hub unpublish ${slug}: web auth failed (${authErr.message}); acts 2 and 3 still run, the DELETE stays owed (AJ1)`);
  const prs = preflight(slug, deps);

  const act1 = await retractRecord(slug, deps, authErr);
  if (act1.stop) {
    deps.log(`hub unpublish ${slug}: ${act1.why}`);
    return act1.exit;
  }
  if (act1.crossTenant) {
    // B6/AI4.6: another tenant owns the record. Our own bundle under it is an
    // inconsistency to stop on; otherwise only the exhibit is ours to drop.
    const remaining = `DELETE /api/v1/build-records/${slug}/publish under the owning tenant's tenant-admin credential (the operator or the owner)`;
    const ours = launchesAt(deps.roots, publishDir(deps.roots, slug), { log: deps.log }).filter((l) => l.status === 'published');
    if (ours.length) {
      deps.log(`hub unpublish ${slug}: 409 ${act1.code ?? ''}: another tenant owns this record, yet launch ${ours[0].id} is published here; refusing, nothing changed. Remaining act: ${remaining}`);
      return EXIT.refused;
    }
    deps.git.fetch();
    deps.git.resetToMain();
    refuseStrays(slug, deps);
    const out = await retractBundle(slug, deps, { act1: { done: false, owed: remaining } });
    deps.log(`hub unpublish ${slug}: the record is another tenant's (409 ${act1.code ?? ''}). ${out.pr ? `PR #${out.pr.number} drops the exhibit.` : 'No exhibit to drop.'} REMAINING ACT: ${remaining}`);
    return EXIT.refused;
  }
  const authFailed = Boolean(authErr || act1.authFailed);

  const rec = await recoverAndReset(slug, prs, deps, { retracting: true });
  let out = { pr: rec.removal ?? null };
  if (!rec.removal) {
    const note = rec.reissue ? `Re-issues the retraction: unpublish PR #${rec.reissue.closed.number} closed unlanded, and launch ${rec.reissue.launchId} was re-adopted from the bytes on main (AF2).` : '';
    out = await retractBundle(slug, deps, { act1, note });
  }
  if (authFailed) {
    loudAuth(deps, 'unpublish', slug, `the record DELETE is still owed; ${out.pr ? `PR #${out.pr.number} removes the bundle and exhibit` : 'the bundle and exhibit are already off main'}`, `${act1.owed}. The live site is retracted by the PR; the snapshot stays readable at api.qontinui.io until the DELETE is made.`);
    return EXIT.auth;
  }
  return EXIT.ok;
}

// ---- publish (A2, A3, B9, AH1, AI1, AI2) ------------------------------------------

/** The public route must answer 200; a retracted record is named by the web's own code (AH1). */
async function requirePublicRecord(slug, deps) {
  const route = await deps.web.publicStatus(slug);
  if (route === 404) {
    const pubn = await deps.web.publication(slug);
    if (pubn.status === 200 && pubn.body?.owned_by_caller_tenant && pubn.body?.unpublished) {
      throw new HubError('refused', `${slug}: build_record_retracted — the record was retracted; republishing is deliberate: \`hub publish ${slug} --reactivate\` (AH1)`);
    }
    throw new HubError('refused', `${slug}: the public record route answers 404; publish the record first with \`hub record-publish ${slug}\` (AI4.7)`);
  }
  if (route !== 200) throw new HubError('transient', `${slug}: the public record route answered ${route || 'nothing'}; UNKNOWN whether the record is public, retry`);
}

export async function publish(slug, { reactivate = false, studioArgs = [] } = {}, deps) {
  const { roots, log } = deps;
  checkSlug(slug);
  const product = resolveProduct(roots, slug);
  const authErr = await authCheck(deps);
  if (authErr) {
    log(`hub publish ${slug}: ${authErr.message}`);
    loudAuth(deps, 'publish', slug, 'nothing was published', authErr.message);
    return authErr.kind === 'transient' ? EXIT.transient : EXIT.auth;
  }
  if (reactivate && !OWN_PRODUCTS.includes(slug)) {
    throw new HubError('refused', `--reactivate publishes the record, which only this tenant's products may (${OWN_PRODUCTS.join(', ')})`);
  }
  // Without --reactivate the route is checked before anything is touched.
  // With it, the record is republished only AFTER the clone is recovered, so
  // a refusal there (dirty clone, open PR, AF2) never leaves a live record
  // with no bundle and no exhibit.
  if (!reactivate) await requirePublicRecord(slug, deps);

  const prs = preflight(slug, deps);
  const rec = await recoverAndReset(slug, prs, deps, { retracting: false });
  if (rec.removal) {
    log(`hub publish ${slug}: removal PR #${rec.removal.number} must land first; re-run after it does`);
    return EXIT.refused;
  }
  if (rec.reissue) {
    // AF2 wins over --reactivate: the last act on this slug was a retraction
    // whose PR closed unlanded, so it is completed before any republish.
    const act1 = await retractRecord(slug, deps, null);
    const note = `Re-issues the retraction: unpublish PR #${rec.reissue.closed.number} closed unlanded, and launch ${rec.reissue.launchId} was re-adopted from the bytes on main (AF2). The \`hub publish ${slug}\` that found this did NOT publish.`;
    const owed = act1.stop || act1.crossTenant ? { done: false, owed: act1.why ?? 'the record DELETE' } : act1;
    const out = await retractBundle(slug, deps, { act1: owed, note });
    if (act1.authFailed) loudAuth(deps, 'publish', slug, 'the re-issued retraction\'s record DELETE is still owed', act1.owed);
    log(`hub publish ${slug}: refused — ${slug} was being retracted; re-issued as PR #${out.pr?.number}. Publish again after it lands, with --reactivate.`);
    return EXIT.refused;
  }
  if (reactivate) {
    const r = await recordPublishInner(slug, { reactivate: true }, deps);
    if (r.auth) {
      loudAuth(deps, 'publish', slug, 'the record was NOT reactivated; nothing was published', r.auth);
      return EXIT.auth;
    }
    if (r.exit !== EXIT.ok) {
      log(`hub publish ${slug} --reactivate: ${r.why}`);
      return r.exit;
    }
    // The POST answered 201: the record is public again. The route is not
    // re-read here (a lagging read would strand a public record with no
    // bundle); the studio's own D1 gates read it during the run.
  }

  // B9: the preview and its tab first, on every exit path stopped.
  const preview = await deps.startPreview(slug);
  let stopRefresher = () => {};
  let launchId;
  try {
    let warned = false;
    stopRefresher = deps.startRefresher((err) => {
      if (warned) return;
      warned = true;
      log(`refresher: ${err.message}; the studio run continues and fails on its own 401 if the token lapses (AK4)`);
      loudAuth(deps, 'publish', slug, 'the bearer could not be refreshed during the studio run', err.message);
    });
    const run = await deps.studio.launchRun(product.path, studioArgs);
    launchId = launchIdFromOutput(run.stdout);
    if (run.code !== 0) {
      log(`hub publish ${slug}: studio launch run exited ${run.code}${launchId ? ` (launch ${launchId})` : ''}; nothing proposed`);
      return EXIT.studio;
    }
  } finally {
    stopRefresher();
    await preview.stop();
  }
  const row = launchId ? launchById(roots, launchId) : null;
  if (!row || row.status !== 'published' || row.publish_dir !== publishDir(roots, slug)) {
    throw new HubError('failed', `studio launch run exited 0 but launch ${launchId ?? '(id not printed)'} is not published at ${publishDir(roots, slug)} (row: ${row ? `${row.status} at ${row.publish_dir}` : 'none'})`, EXIT.studio);
  }

  const branch = branchFor('publish', slug, launchId);
  deps.git.newBranch(branch);
  const added = editExhibits(roots.STUDIO_HUB_CLONE, (t) => addExhibit(t, slug));
  const pr = await proposeBranch(
    { ...deps, commitPaths: [`public/${slug}`, 'exhibits.yaml'] },
    {
      branch,
      message: `feat: publish ${slug} to the hub (launch ${launchId})`,
      title: `publish: ${slug} (launch ${launchId})`,
      body: `Publishes the \`${slug}\` launch bundle at \`public/${slug}/\`${added ? ` and adds the \`${slug}\` exhibit` : ''} (plan A2, AI2). \`studio launch run\` passed every D7 gate against the 127.0.0.1:4330 preview.\n\nLive at ${SITE}/${slug}/ once coord lands this. Unpublish: \`hub unpublish ${slug}\`.`,
    },
  );
  if (!pr) {
    log(`hub publish ${slug}: launch ${launchId} is byte-identical to origin/main and the exhibit is listed; nothing to propose`);
    return EXIT.ok;
  }
  const f = postStatusFinding(deps.call, {
    slug,
    pr: pr.number,
    title: `hub publish ${slug}: the page goes live when coord lands qontinui-factory/hub#${pr.number}`,
    body: `Launch ${launchId} passed every D7 gate and is committed on ${branch} (head ${pr.head}); PR ${pr.url} was opened via ${pr.via}. ${SITE}/${slug}/ goes live when coord lands PR #${pr.number} and the Pages deploy runs.\n\nUnpublish command: \`hub unpublish ${slug}\` (record DELETE, studio unpublish, removal PR).`,
  });
  log(f.posted ? `posted coord finding ${f.id}` : `coord finding NOT posted: ${f.why}`);
  return EXIT.ok;
}
