#!/usr/bin/env node
// hub — the build.qontinui.io hub's operator and agent commands.
// Plan 2026-10-17-build-qontinui-io-factory-hub, Phase 3 (AJ1, AK1-AK4, AL1).
//
//   hub auth import <storage-state.json>   store the refresh token from a
//                                          `ui-bridge-login-web --storage-state-out` file
//   hub auth set                           store a refresh token read from stdin
//   hub auth check                         exchange it and require the admin role
//   hub auth refresh                       exchange it and rewrite the bearer file
//
// Exit codes: 0 ok; 1 an unexpected error; 2 usage or nothing stored; 3 the
// credential was refused (re-import needed); 4 a transient failure (retry);
// 6 stored and checked, but the expiry reminder gate was NOT registered;
// 7 stored, but the storage-state file could not be deleted.
// Nothing is written unless the new token both exchanges and passes the admin
// check, so a refused or interrupted import leaves the stored credential as it was.
// A token is never printed and never accepted on argv.
import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bearerFile, refreshTokenFile } from '../lib/auth/config.mjs';
import { AuthError, exchange, refreshBearer, writeSecret } from '../lib/auth/token.mjs';
import { refreshTokenFromStorageState } from '../lib/auth/storage-state.mjs';
import { checkAdmin } from '../lib/auth/check.mjs';
import { makeCaller, postAuthFinding, registerReminder } from '../lib/auth/coord.mjs';
import { refreshValiditySecs } from '../lib/auth/validity.mjs';

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
            // Skip an ANSI escape sequence (arrow keys and the like) to its final byte.
            if (/[A-Za-z~]/.test(ch)) escape = false;
            continue;
          }
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return value.trim();
          if (ch === '\u0003') throw new AuthError('usage', 'cancelled');
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else if (ch === '\u001b') escape = true;
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
  writeSecret(bearerFile(env), `${idToken}\n`);
  log(`stored the refresh token at ${refreshTokenFile(env)}; ID token valid until ${new Date(exp * 1000).toISOString()}; admin of ${admin.tenant}`);
  // The refresh token lives from the sign-in that issued it, which the ID
  // token's auth_time records (Cognito keeps it across refreshes); a token
  // copied from an old browser session expires sooner than one minted now.
  const { secs, assumed } = validity();
  const issued = authTime ?? now();
  const dueSecs = Math.max(3600, Math.round(issued + secs - 3 * 86400 - now()));
  const dueDate = new Date((now() + dueSecs) * 1000).toISOString().slice(0, 10);
  const r = registerReminder(call, { dueSecs, dueDate, assumed });
  if (!r.registered) {
    log(`WARNING: expiry reminder gate NOT registered (the previous reminder, if any, still stands): ${r.why}`);
    return 6;
  }
  const notes = [
    assumed ? 'validity unread, assumed 30 days' : null,
    authTime ? null : 'sign-in time unread, timed from now',
    r.withdrawn.length ? `withdrew ${r.withdrawn.join(', ')}` : null,
    r.notWithdrawn.length ? `could NOT withdraw ${r.notWithdrawn.join(', ')}` : null,
  ].filter(Boolean);
  log(`expiry reminder gate ${r.gateId} due ${dueDate}${notes.length ? ` (${notes.join('; ')})` : ''}`);
  return 0;
}

export async function main(argv, deps) {
  const { env, fetchImpl, log, stdin } = deps;
  const [group, cmd, ...rest] = argv;
  if (group !== 'auth' || !['import', 'set', 'check', 'refresh'].includes(cmd)) {
    log('usage: hub auth import <storage-state.json> | hub auth set | hub auth check | hub auth refresh');
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
        return 7;
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
  main(process.argv.slice(2), {
    env: process.env,
    fetchImpl: fetch,
    log: (m) => process.stderr.write(`${m}\n`),
    stdin: process.stdin,
    readSecret: readStdinSecret,
    validity: refreshValiditySecs,
  }).then((code) => process.exit(code));
}
