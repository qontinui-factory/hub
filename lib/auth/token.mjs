// The refresh-token exchange (plan AJ1, AK1, AK4). It writes the ID token,
// never the access token: the web frontend sends the ID token as its bearer
// (token-refresh-service.ts stores `access_token: tokens.id_token`), and an
// access token carries no `email`, so coord would provision a fake
// `<provider>-<sub>@….sso.local` operator from it.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { COGNITO_CLIENT_ID, COGNITO_TOKEN_ENDPOINT, bearerFile, refreshTokenFile } from './config.mjs';

export class AuthError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'authoritative' (re-import needed) | 'transient' | 'usage'
  }
}

/** Write `contents` atomically, mode 600, creating the directory mode 700. */
export function writeSecret(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A fresh random name opened with O_EXCL: never an existing file or a
  // planted symlink, so the secret is mode 600 from its first byte.
  const tmp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600); // the umask can only narrow 600; this pins it exactly
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function readRefreshToken(env = process.env) {
  const path = refreshTokenFile(env);
  let value;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    throw new AuthError('usage', `no refresh token at ${path}: run \`hub auth import\` or \`hub auth set\``);
  }
  if (!value) throw new AuthError('usage', `${path} is empty`);
  return value;
}

/** The claims of a JWT, unverified (it is the hub's own token). */
export function jwtClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.exp !== 'number') throw new Error('no exp');
    return claims;
  } catch {
    // Not a sign-in problem: the endpoint answered something unexpected.
    throw new AuthError('transient', 'the token is not a readable JWT');
  }
}

export const jwtExp = (token) => jwtClaims(token).exp;

/** Exchange a refresh token for an ID token. Never logs either. */
export async function exchange(refreshToken, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(COGNITO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: COGNITO_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    throw new AuthError('transient', `token endpoint unreachable: ${err.message}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body is classified by status below.
  }
  const error = typeof body?.error === 'string' ? body.error : null;
  if (!res.ok) {
    // The web's own rule (cognito-oauth.ts:478-480): only a 401, or a 400
    // invalid_grant (revoked or expired), means the token is dead. A 400 page
    // from a proxy or any 5xx is retried, not a re-sign-in.
    const kind = res.status === 401 || (res.status === 400 && error === 'invalid_grant') ? 'authoritative' : 'transient';
    throw new AuthError(kind, `refresh exchange refused: ${error ?? `HTTP ${res.status}`}`);
  }
  if (typeof body?.id_token !== 'string' || !body.id_token) {
    throw new AuthError('transient', 'the token endpoint answered 200 with no readable id_token');
  }
  const claims = jwtClaims(body.id_token);
  return { idToken: body.id_token, exp: claims.exp, authTime: typeof claims.auth_time === 'number' ? claims.auth_time : null };
}

/** Exchange the stored refresh token and write the ID token to the bearer file. */
export async function refreshBearer(env = process.env, fetchImpl = fetch) {
  const { idToken, exp } = await exchange(readRefreshToken(env), fetchImpl);
  writeSecret(bearerFile(env), `${idToken}\n`);
  return { exp, path: bearerFile(env) };
}

/**
 * Keep the bearer file fresh while `child` runs (AK4): every `intervalMs`,
 * re-exchange when fewer than `marginSecs` remain. Returns a stop function.
 */
export function startRefresher({ env = process.env, fetchImpl = fetch, intervalMs = 60_000, marginSecs = 600, onError, now = () => Date.now() / 1000 } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let exp = 0; // a missing or unreadable bearer file is refreshed, not reported forever
      try {
        exp = jwtExp(readFileSync(bearerFile(env), 'utf8').trim());
      } catch {}
      if (exp - now() < marginSecs) await refreshBearer(env, fetchImpl);
    } catch (err) {
      onError?.(err);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
