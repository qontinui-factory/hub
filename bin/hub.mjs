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
// Exit codes: 0 ok; 2 usage; 3 the credential was refused (re-import needed);
// 4 a transient failure (retry); 6 stored and checked, but the expiry reminder
// gate was NOT registered.
// A token is never printed and never accepted on argv.
import { readFileSync, unlinkSync } from 'node:fs';
import { refreshTokenFile } from '../lib/auth/config.mjs';
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
    for await (const chunk of stdin) {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write('\n');
          return value.trim();
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          throw new AuthError('usage', 'cancelled');
        }
        value += ch;
      }
    }
    return value.trim();
  }
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim();
}

/** Validate a refresh token by exchanging it, then store it and the bearer. */
export async function storeAndCheck(refreshToken, deps) {
  const { env, fetchImpl, call, validity, log } = deps;
  if (!refreshToken) throw new AuthError('usage', 'no refresh token given');
  const { exp } = await exchange(refreshToken, fetchImpl); // proves it before anything is written
  writeSecret(refreshTokenFile(env), `${refreshToken}\n`);
  await refreshBearer(env, fetchImpl);
  const admin = await checkAdmin(env, fetchImpl);
  log(`stored the refresh token at ${refreshTokenFile(env)}; ID token valid until ${new Date(exp * 1000).toISOString()}; admin of ${admin.tenant}`);
  const { secs, assumed } = validity();
  const dueSecs = Math.max(3600, secs - 3 * 86400);
  const dueDate = new Date(Date.now() + dueSecs * 1000).toISOString().slice(0, 10);
  const r = registerReminder(call, { dueSecs, dueDate, assumed });
  if (r.registered) {
    log(`expiry reminder gate ${r.gateId} due ${dueDate}${assumed ? ' (validity unread, assumed 30 days)' : ''}${r.withdrawn.length ? `; withdrew ${r.withdrawn.join(', ')}` : ''}`);
    return 0;
  }
  log(`WARNING: expiry reminder gate NOT registered: ${r.why}`);
  return 6;
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
        throw new AuthError('usage', `cannot read ${path}: ${err.message}`);
      }
      const { token, origins } = refreshTokenFromStorageState(state);
      log(`found the refresh token in sessionStorage of ${origins.join(', ')}`);
      const code = await storeAndCheck(token, { ...deps, call });
      unlinkSync(path); // it holds live session tokens; the hub keeps only the refresh token
      log(`deleted ${path}`);
      return code;
    }
    if (cmd === 'set') {
      if (rest.length) throw new AuthError('usage', 'hub auth set takes no arguments: the token is read from stdin, never argv');
      return await storeAndCheck(await deps.readSecret(stdin), { ...deps, call });
    }
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
    if (!(err instanceof AuthError)) throw err;
    log(`hub auth ${cmd}: ${err.message}`);
    if (err.kind !== 'usage') {
      const f = postAuthFinding(call, `auth ${cmd}`, 'the credential is not usable', err.message);
      log(f.posted ? `posted coord finding ${f.id}` : `coord finding NOT posted: ${f.why}`);
    }
    return EXIT[err.kind] ?? 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/hub')) {
  main(process.argv.slice(2), {
    env: process.env,
    fetchImpl: fetch,
    log: (m) => process.stderr.write(`${m}\n`),
    stdin: process.stdin,
    readSecret: readStdinSecret,
    validity: refreshValiditySecs,
  }).then((code) => process.exit(code));
}
