// The refresh-token exchange (plan AJ1, AK1, AK4). It writes the ID token,
// never the access token: the web frontend sends the ID token as its bearer
// (token-refresh-service.ts stores `access_token: tokens.id_token`), and an
// access token carries no `email`, so coord would provision a fake
// `<provider>-<sub>@….sso.local` operator from it.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
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

/** The `exp` claim of a JWT, unverified (it is the hub's own token). */
export function jwtExp(token) {
  const part = token.split('.')[1];
  if (!part) throw new AuthError('authoritative', 'the token endpoint returned a malformed id_token');
  const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof payload.exp !== 'number') throw new AuthError('authoritative', 'id_token has no exp');
  return payload.exp;
}

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
  let body = {};
  try {
    body = await res.json();
  } catch {
    // A non-JSON body is classified by status below.
  }
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    // invalid_grant: the refresh token was revoked or has expired.
    const kind = body.error === 'invalid_grant' || res.status === 400 ? 'authoritative' : 'transient';
    throw new AuthError(kind, `refresh exchange refused: ${code}`);
  }
  if (typeof body.id_token !== 'string' || !body.id_token) {
    throw new AuthError('authoritative', 'the token endpoint returned no id_token');
  }
  return { idToken: body.id_token, exp: jwtExp(body.id_token) };
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
      const token = readFileSync(bearerFile(env), 'utf8').trim();
      if (jwtExp(token) - now() < marginSecs) await refreshBearer(env, fetchImpl);
    } catch (err) {
      onError?.(err);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
