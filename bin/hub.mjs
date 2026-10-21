#!/usr/bin/env node
// hub — the build.qontinui.io hub's operator and agent commands.
// Plan 2026-10-17-build-qontinui-io-factory-hub, Phase 3.
//
// Publication (lib/hub/*; plan A1-A3, B1-B10, C1, C3, AD1-AD3, AE1-AE5, AF1,
// AF2, AG1, AG2, AH1, AI1-AI4, AJ1, AK2, AK4):
//   hub record-publish <slug> [--reactivate]   PUT is_public + POST publish (this tenant's products)
//   hub publish <slug> [--reactivate] [-- <studio launch run flags>]
//                                              D7-gated bundle -> PR on qontinui-factory/hub
//   hub unpublish <slug>                       record DELETE, studio unpublish, removal PR
//   hub preview <slug> [--no-build]            127.0.0.1:4330 preview + relay + one tab
//   hub verify <url> [--plain] [--dist <dir>]  UI Bridge read (or a plain request log), as JSON
// Exit codes (publication): 0 ok; 1 unexpected; 2 usage; 3 web auth failed
// (re-import; `hub unpublish` still did acts 2 and 3); 4 transient (retry);
// 5 refused (reserved slug, door, 404 route, retracted, dirty clone, open or
// newly opened hub PR, another tenant's record); 6 the studio refused or
// failed. `hub verify`: 0 pass; 6 no registered tab or page-health CRITICAL;
// 7 the deployed /_hub/ui-bridge.js is missing or differs from dist/;
// 8 (--plain) the page made a loopback or UI Bridge request.
//
// Credential (AJ1, AK1-AK4, AL1):
//   hub auth import <storage-state.json>   store the refresh token from a
//                                          `ui-bridge-login-web --storage-state-out` file
//   hub auth set                           store a refresh token read from stdin
//   hub auth check                         exchange it and require the admin role
//   hub auth refresh                       exchange it and rewrite the bearer file
//
// Exit codes: 0 ok; 1 an unexpected error; 2 usage or nothing stored; 3 the
// credential was refused (re-import needed); 4 a transient failure (retry);
// 6 stored and checked, but the expiry reminder gate was NOT registered;
// 7 stored, but the storage-state file could not be deleted; 8 both 6 and 7.
// Nothing is written unless the new token both exchanges and passes the admin
// check, so a refused or interrupted import leaves the stored credential as it was.
// A token is never printed and never accepted on argv.
import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bearerFile, refreshTokenFile } from '../lib/auth/config.mjs';
import { AuthError, exchange, refreshBearer, startRefresher, writeSecret } from '../lib/auth/token.mjs';
import { refreshTokenFromStorageState } from '../lib/auth/storage-state.mjs';
import { checkAdmin } from '../lib/auth/check.mjs';
import { makeCaller, postAuthFinding, registerReminder } from '../lib/auth/coord.mjs';
import { refreshValiditySecs } from '../lib/auth/validity.mjs';
import { EXIT as FLOW_EXIT, publish, recordPublish, studioChildEnv, unpublish } from '../lib/hub/flows.mjs';
import { makeGit } from '../lib/hub/git.mjs';
import { checkSlug } from '../lib/hub/product.mjs';
import { probePort, startPreview } from '../lib/hub/preview.mjs';
import { makePrs } from '../lib/hub/prs.mjs';
import { HubError, hubRoots } from '../lib/hub/roots.mjs';
import { makeStudio } from '../lib/hub/studio.mjs';
import { verifyPlain, verifyWithBridge } from '../lib/hub/verify.mjs';
import { makeWeb } from '../lib/hub/web.mjs';

const EXIT = { usage: 2, authoritative: 3, transient: 4 };

export async function readStdinSecret(stdin = process.stdin, stderr = process.stderr) {
  if (stdin.isTTY) {
    stderr.write('Paste the refresh token, then press Enter (input is hidden): ');
    stdin.setRawMode(true);
    let value = '';
    let escape = false;
    try {
      for await (const chunk of stdin) {
        for (const ch of chunk.toString('utf8')) {
          if (escape) {
            // Skip an ANSI escape sequence (arrow keys and the like) to its
            // final byte; `[` and `O` (application cursor mode) introduce one.
            if (escape === 'start' && (ch === '[' || ch === 'O')) escape = 'body';
            else if (/[A-Za-z~]/.test(ch)) escape = false;
            else escape = 'body';
            continue;
          }
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return value.trim();
          if (ch === '\u0003') throw new AuthError('usage', 'cancelled');
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else if (ch === '\u001b') escape = 'start';
          else if (ch >= ' ') value += ch; // other control characters are not part of a token
        }
      }
      return value.trim();
    } finally {
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    }
  }
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim();
}

/**
 * Prove a refresh token (exchange, then the admin check on the ID token it
 * yields) and only then store it and that ID token. A refusal at either step
 * writes nothing.
 */
export async function storeAndCheck(refreshToken, deps) {
  const { env, fetchImpl, call, validity, log, now = () => Date.now() / 1000 } = deps;
  if (!refreshToken) throw new AuthError('usage', 'no refresh token given');
  const { idToken, exp, authTime } = await exchange(refreshToken, fetchImpl);
  const admin = await checkAdmin(env, fetchImpl, idToken);
  writeSecret(refreshTokenFile(env), `${refreshToken}\n`);
  try {
    writeSecret(bearerFile(env), `${idToken}\n`);
  } catch (err) {
    log(`WARNING: the refresh token was stored but the bearer file was NOT updated (${err.code ?? err.message}); run \`hub auth refresh\``);
    throw err;
  }
  log(`stored the refresh token at ${refreshTokenFile(env)}; ID token valid until ${new Date(exp * 1000).toISOString()}; admin of ${admin.tenant}`);
  // The refresh token lives from the sign-in that issued it. The ID token's
  // auth_time is the sign-in time per OIDC Core §2, and we ASSUME Cognito
  // carries it across refresh grants; an auth_time at the refresh itself is
  // read as unknown, not as a fresh sign-in, and the log says so either way.
  const { secs, assumed } = validity();
  const signedIn = authTime !== null && authTime < now() - 120 ? authTime : null;
  const issued = signedIn ?? now();
  const dueSecs = Math.max(3600, Math.round(issued + secs - 3 * 86400 - now()));
  const dueDate = new Date((now() + dueSecs) * 1000).toISOString().slice(0, 10);
  const r = registerReminder(call, { dueSecs, dueDate, assumed });
  if (!r.registered) {
    log(`WARNING: expiry reminder gate NOT registered (the previous reminder, if any, still stands): ${r.why}`);
    return 6;
  }
  const notes = [
    assumed ? 'validity unread, assumed 30 days' : null,
    signedIn ? null : 'timed from now: right for a fresh sign-in; if this token came from an older browser session, re-run sooner',
    r.withdrawn.length ? `withdrew ${r.withdrawn.join(', ')}` : null,
    r.notWithdrawn.length ? `could NOT withdraw ${r.notWithdrawn.join(', ')}` : null,
  ].filter(Boolean);
  log(`expiry reminder gate ${r.gateId} due ${dueDate}${notes.length ? ` (${notes.join('; ')})` : ''}`);
  return 0;
}

const USAGE = [
  'usage: hub auth import <storage-state.json> | hub auth set | hub auth check | hub auth refresh',
  '       hub record-publish <slug> [--reactivate]',
  '       hub publish <slug> [--reactivate] [-- <studio launch run flags>]',
  '       hub unpublish <slug>',
  '       hub preview <slug> [--no-build]',
  '       hub verify <url> [--plain] [--dist <dir>]',
].join('\n');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The publication commands' dependencies, real by default; tests override any of them. */
export function hubDeps(deps, need) {
  const { env, fetchImpl, log } = deps;
  const roots = deps.roots ?? hubRoots(env, { need });
  return {
    env,
    log,
    roots,
    git: deps.git ?? makeGit(roots.STUDIO_HUB_CLONE),
    studio: deps.studio ?? makeStudio({ env, roots, childEnv: studioChildEnv(env, roots), log }),
    prs: deps.prs ?? makePrs({ env, fetchImpl }),
    web: deps.web ?? makeWeb({ env, fetchImpl }),
    call: deps.call !== undefined ? deps.call : makeCaller(env),
    now: deps.now ?? (() => new Date()),
    authCheck:
      deps.authCheck ??
      (async () => {
        await refreshBearer(env, fetchImpl);
        return checkAdmin(env, fetchImpl);
      }),
    startRefresher: deps.startRefresher ?? ((onError) => startRefresher({ env, fetchImpl, onError })),
    startPreview: deps.startPreview ?? ((slug) => startPreview({ roots, slug, log })),
    probePort: deps.probePort ?? probePort,
    acquireLock: deps.acquireLock,
  };
}

function parseFlags(rest, known) {
  const flags = {};
  const positional = [];
  let passthrough = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--') {
      passthrough = rest.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const [name, value] = a.slice(2).split(/=(.*)/s);
      if (!(name in known)) throw new HubError('usage', `unknown option --${name}\n${USAGE}`);
      if (known[name] === 'value') {
        const v = value ?? rest[(i += 1)];
        if (v === undefined) throw new HubError('usage', `--${name} needs a value`);
        flags[name] = v;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { flags, positional, passthrough };
}

async function hubMain(argv, deps) {
  const { log } = deps;
  const [cmd, ...rest] = argv;
  if (!cmd) {
    log(USAGE);
    return EXIT.usage;
  }
  try {
    if (cmd === 'verify') {
      const { flags, positional } = parseFlags(rest, { plain: 'flag', dist: 'value' });
      if (positional.length !== 1) throw new HubError('usage', USAGE);
      const url = positional[0];
      try {
        new URL(url);
      } catch {
        throw new HubError('usage', `not a URL: ${url}`);
      }
      const result = flags.plain
        ? await (deps.verifyPlain ?? verifyPlain)(url)
        : await (deps.verifyWithBridge ?? verifyWithBridge)(url, { distDir: flags.dist ?? join(REPO_ROOT, 'dist'), log });
      (deps.out ?? ((s) => process.stdout.write(s)))(`${JSON.stringify(result, null, 2)}\n`);
      return result.exit;
    }
    const known = { 'record-publish': { reactivate: 'flag' }, publish: { reactivate: 'flag' }, unpublish: {}, preview: { 'no-build': 'flag' } }[cmd];
    if (!known) throw new HubError('usage', USAGE);
    const { flags, positional, passthrough } = parseFlags(rest, known);
    if (positional.length !== 1 || (passthrough.length && cmd !== 'publish')) throw new HubError('usage', USAGE);
    const slug = checkSlug(positional[0]); // B1 before anything else is read
    if (cmd === 'record-publish') return await recordPublish(slug, { reactivate: Boolean(flags.reactivate) }, hubDeps(deps, ['STUDIO_HUB_CLONE', 'STUDIO_ROOT']));
    if (cmd === 'unpublish') return await unpublish(slug, hubDeps(deps, ['STUDIO_HUB_CLONE', 'STUDIO_ROOT']));
    if (cmd === 'publish') {
      return await publish(slug, { reactivate: Boolean(flags.reactivate), studioArgs: passthrough }, hubDeps(deps, ['STUDIO_HUB_CLONE', 'STUDIO_HUB_PREVIEW', 'STUDIO_ROOT']));
    }
    // preview
    const roots = deps.roots ?? hubRoots(deps.env, { need: ['STUDIO_HUB_CLONE', 'STUDIO_HUB_PREVIEW'] });
    const p = await (deps.startPreviewImpl ?? startPreview)({ roots, slug, build: !flags['no-build'], log });
    log(`hub preview ${slug}: serving until interrupted (Ctrl-C)`);
    await (deps.waitForSignal ?? (() => new Promise((r) => {
      process.once('SIGINT', r);
      process.once('SIGTERM', r);
    })))();
    await p.stop();
    return FLOW_EXIT.ok;
  } catch (err) {
    if (err instanceof HubError) {
      log(`hub ${cmd}: ${err.message}`);
      return err.code;
    }
    if (err instanceof AuthError) {
      log(`hub ${cmd}: ${err.message}`);
      return EXIT[err.kind] ?? 1;
    }
    log(`hub ${cmd}: unexpected ${err.code ?? err.name}: ${err.message}`);
    return FLOW_EXIT.failed;
  }
}

export async function main(argv, deps) {
  const { env, fetchImpl, log, stdin } = deps;
  const [group, cmd, ...rest] = argv;
  if (group !== 'auth') return hubMain(argv, deps);
  if (!['import', 'set', 'check', 'refresh'].includes(cmd)) {
    log(USAGE);
    return EXIT.usage;
  }
  const call = deps.call ?? makeCaller(env);
  try {
    if (cmd === 'import') {
      if (rest.length !== 1) throw new AuthError('usage', 'usage: hub auth import <storage-state.json>');
      const path = rest[0];
      let state;
      try {
        state = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        // Neither the path nor the parse error is echoed: a token pasted where
        // the path goes, or a parse error's quoted context, would print it.
        throw new AuthError('usage', `cannot read the storage-state file (${err.code ?? 'not valid JSON'}); pass the path ui-bridge-login-web wrote`);
      }
      const { token, origins } = refreshTokenFromStorageState(state);
      log(`found the refresh token in sessionStorage of ${origins.join(', ')}`);
      const code = await storeAndCheck(token, { ...deps, call });
      try {
        unlinkSync(path); // it holds live session tokens; the hub keeps only the refresh token
      } catch (err) {
        log(`WARNING: could not delete ${path} (${err.code ?? err.message}); it holds live session tokens, delete it by hand`);
        return code === 6 ? 8 : 7;
      }
      log(`deleted ${path}`);
      return code;
    }
    if (rest.length) throw new AuthError('usage', `hub auth ${cmd} takes no arguments${cmd === 'set' ? ': the token is read from stdin, never argv' : ''}`);
    if (cmd === 'set') return await storeAndCheck(await deps.readSecret(stdin), { ...deps, call });
    if (cmd === 'refresh') {
      const { exp, path } = await refreshBearer(env, fetchImpl);
      log(`bearer refreshed at ${path}; valid until ${new Date(exp * 1000).toISOString()}`);
      return 0;
    }
    await refreshBearer(env, fetchImpl);
    const admin = await checkAdmin(env, fetchImpl);
    log(`ok: admin of ${admin.tenant} (roles: ${admin.roles.join(', ')})`);
    return 0;
  } catch (err) {
    if (!(err instanceof AuthError)) {
      log(`hub auth ${cmd}: unexpected ${err.code ?? err.name}: ${err.message}`);
      return 1;
    }
    log(`hub auth ${cmd}: ${err.message}`);
    // Only a refusal of the credential itself is worth the operator's
    // attention; a transient failure is retried, never reported as dead.
    if (err.kind === 'authoritative') {
      const f = postAuthFinding(call, `auth ${cmd}`, 'the credential is not usable', err.message);
      log(f.posted ? `posted coord finding ${f.id}` : `coord finding NOT posted: ${f.why}`);
    }
    return EXIT[err.kind] ?? 1;
  }
}

function invokedDirectly() {
  try {
    // realpath: a package-manager bin is a symlink to this file.
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // stdout carries only machine output (`hub verify`'s JSON); the UI Bridge
  // relay logs through console.log, so every console channel goes to stderr.
  for (const k of ['log', 'info', 'debug', 'warn']) console[k] = (...a) => process.stderr.write(`${format(...a)}\n`);
  main(process.argv.slice(2), {
    env: process.env,
    fetchImpl: fetch,
    log: (m) => process.stderr.write(`${m}\n`),
    stdin: process.stdin,
    readSecret: readStdinSecret,
    validity: refreshValiditySecs,
  }).then((code) => process.exit(code));
}
