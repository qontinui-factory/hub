import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, readStdinSecret } from '../bin/hub.mjs';
import { COGNITO_CLIENT_ID, SESSION_REFRESH_TOKEN_KEY, TENANT_ID } from '../lib/auth/config.mjs';
import { refreshTokenFromStorageState } from '../lib/auth/storage-state.mjs';
import { exchange, startRefresher } from '../lib/auth/token.mjs';
import { registerReminder } from '../lib/auth/coord.mjs';

const RT = 'refresh-token-value';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const ID = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'op@example.test' });
const ACCESS = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, token_use: 'access' });

function env() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-auth-'));
  return {
    dir,
    STUDIO_WEB_REFRESH_TOKEN_FILE: join(dir, 'state', 'refresh'),
    STUDIO_WEB_BEARER_FILE: join(dir, 'state', 'bearer'),
  };
}

// A stub of the Cognito token endpoint and qontinui-web.
function stubFetch({ grant = 'ok', roles = ['admin'], member = true, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/oauth2/token')) {
      if (grant === 'invalid') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      return { ok: true, status: 200, json: async () => ({ id_token: ID, access_token: ACCESS, expires_in: 3600 }) };
    }
    if (url.endsWith('/api/v1/operations/tenants')) {
      const tenants = member ? [{ id: TENANT_ID, slug: 'qontinui', roles }] : [];
      return { ok: true, status: 200, json: async () => ({ tenants }) };
    }
    throw new Error(`unexpected ${url}`);
  };
}

function deps(e, extra = {}) {
  const logs = [];
  const calls = [];
  return {
    logs,
    calls,
    d: {
      env: e,
      fetchImpl: stubFetch({ calls, ...extra }),
      log: (m) => logs.push(m),
      call: extra.call ?? null,
      validity: () => ({ secs: 30 * 86400, assumed: false }),
      readSecret: async () => extra.stdinToken ?? RT,
    },
  };
}

function storageState(dir, kv) {
  const p = join(dir, 'auth.json');
  writeFileSync(p, JSON.stringify({ cookies: [], origins: [], __sessionStorage: kv }));
  return p;
}

describe('storage-state extraction (AJ1)', () => {
  it(`reads ${SESSION_REFRESH_TOKEN_KEY} from the __sessionStorage map`, () => {
    const r = refreshTokenFromStorageState({ __sessionStorage: { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT, other: 'x' } } });
    expect(r).toEqual({ token: RT, origins: ['https://qontinui.io'] });
  });
  it('refuses a plain Playwright storageState with no __sessionStorage', () => {
    expect(() => refreshTokenFromStorageState({ cookies: [], origins: [] })).toThrow(/no __sessionStorage/);
  });
  it('refuses when no origin holds the key', () => {
    expect(() => refreshTokenFromStorageState({ __sessionStorage: { 'https://qontinui.io': { a: 'b' } } })).toThrow(/no auth_bearer_refresh_token/);
  });
  it('refuses two different tokens', () => {
    expect(() =>
      refreshTokenFromStorageState({ __sessionStorage: { a: { [SESSION_REFRESH_TOKEN_KEY]: 'x' }, b: { [SESSION_REFRESH_TOKEN_KEY]: 'y' } } }),
    ).toThrow(/different refresh tokens/);
  });
});

describe('the exchange (AJ1, AK1)', () => {
  it('posts the refresh_token grant with the web client id and returns the ID token, never the access token', async () => {
    const calls = [];
    const r = await exchange(RT, stubFetch({ calls }));
    expect(r.idToken).toBe(ID);
    const body = new URLSearchParams(calls[0].init.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(COGNITO_CLIENT_ID);
    expect(body.get('refresh_token')).toBe(RT);
    expect(body.has('client_secret')).toBe(false);
  });
  it('classifies invalid_grant as authoritative', async () => {
    await expect(exchange(RT, stubFetch({ grant: 'invalid' }))).rejects.toMatchObject({ kind: 'authoritative' });
  });
});

describe('hub auth import', () => {
  it('stores the refresh token mode 600, writes the ID token as the bearer, checks admin with the tenant header, deletes the file', async () => {
    const e = env();
    const file = storageState(e.dir, { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } });
    const { d, calls } = deps(e);
    const code = await main(['auth', 'import', file], d);
    expect(code).toBe(6); // stored and checked; no coord door in the test, so the reminder is not registered
    expect(readFileSync(e.STUDIO_WEB_REFRESH_TOKEN_FILE, 'utf8').trim()).toBe(RT);
    expect(statSync(e.STUDIO_WEB_REFRESH_TOKEN_FILE).mode & 0o777).toBe(0o600);
    expect(readFileSync(e.STUDIO_WEB_BEARER_FILE, 'utf8').trim()).toBe(ID);
    expect(statSync(e.STUDIO_WEB_BEARER_FILE).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(false);
    const web = calls.find((c) => c.url.endsWith('/api/v1/operations/tenants'));
    expect(web.init.headers.Authorization).toBe(`Bearer ${ID}`);
    expect(web.init.headers['X-Qontinui-Active-Tenant']).toBe(TENANT_ID);
  });
  it('writes nothing and keeps the file when the token is refused', async () => {
    const e = env();
    const file = storageState(e.dir, { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } });
    const { d, logs } = deps(e, { grant: 'invalid' });
    expect(await main(['auth', 'import', file], d)).toBe(3);
    expect(existsSync(e.STUDIO_WEB_REFRESH_TOKEN_FILE)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(logs.join('\n')).not.toContain(RT);
    expect(logs.join('\n')).toMatch(/coord finding NOT posted/);
  });
  it('refuses a non-admin account', async () => {
    const e = env();
    const file = storageState(e.dir, { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } });
    const { d } = deps(e, { roles: ['developer'] });
    expect(await main(['auth', 'import', file], d)).toBe(3);
  });
  it('registers the reminder through the coord door, withdrawing the previous one', async () => {
    const e = env();
    const file = storageState(e.dir, { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } });
    const coordCalls = [];
    const call = (tool, args) => {
      coordCalls.push([tool, args]);
      if (tool === 'coord_gate_list') return { gates: [{ gate_id: 'old', phase_name: 'hub auth: refresh token expires 2026-11-01 — re-run hub auth import' }, { gate_id: 'other', phase_name: 'Phase 3' }] };
      if (tool === 'coord_register_gate') return { gate_id: 'new' };
      return {};
    };
    const { d } = deps(e, { call });
    expect(await main(['auth', 'import', file], d)).toBe(0);
    expect(coordCalls.filter(([t]) => t === 'coord_withdraw_gate').map(([, a]) => a.gate_id)).toEqual(['old']);
    const reg = coordCalls.find(([t]) => t === 'coord_register_gate')[1];
    expect(reg.predicate).toEqual({ kind: 'time_elapsed', duration_secs: 27 * 86400 });
    expect(reg.continuation).toEqual({ action: 'notify_only' });
    expect(reg.phase_name).toMatch(/^hub auth: refresh token expires \d{4}-\d{2}-\d{2} — re-run hub auth import$/);
    expect(JSON.stringify(coordCalls)).not.toContain(RT);
  });
});

describe('hub auth set', () => {
  it('refuses a token on argv', async () => {
    const e = env();
    const { d } = deps(e);
    expect(await main(['auth', 'set', RT], d)).toBe(2);
    expect(existsSync(e.STUDIO_WEB_REFRESH_TOKEN_FILE)).toBe(false);
  });
  it('stores a token read from stdin', async () => {
    const e = env();
    const { d } = deps(e);
    expect(await main(['auth', 'set'], d)).toBe(6);
    expect(readFileSync(e.STUDIO_WEB_REFRESH_TOKEN_FILE, 'utf8').trim()).toBe(RT);
  });
  it('reads piped stdin', async () => {
    expect(await readStdinSecret(Readable.from([`${RT}\n`]))).toBe(RT);
  });
});

describe('hub auth check', () => {
  it('fails with exit 2 when no refresh token is stored', async () => {
    const { d } = deps(env());
    expect(await main(['auth', 'check'], d)).toBe(2);
  });
  it('passes for an admin', async () => {
    const e = env();
    const { d } = deps(e);
    await main(['auth', 'set'], d);
    expect(await main(['auth', 'check'], d)).toBe(0);
  });
  it('fails for a non-member', async () => {
    const e = env();
    await main(['auth', 'set'], deps(e).d);
    expect(await main(['auth', 'check'], deps(e, { member: false }).d)).toBe(3);
  });
});

describe('the refresher (AK4)', () => {
  it('re-exchanges when the bearer is within the margin of expiry', async () => {
    const e = env();
    await main(['auth', 'set'], deps(e).d);
    writeFileSync(e.STUDIO_WEB_BEARER_FILE, jwt({ exp: Math.floor(Date.now() / 1000) + 60 }));
    const calls = [];
    const stop = startRefresher({ env: e, fetchImpl: stubFetch({ calls }), intervalMs: 10, marginSecs: 600 });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(readFileSync(e.STUDIO_WEB_BEARER_FILE, 'utf8').trim()).toBe(ID);
    expect(calls.some((c) => c.url.endsWith('/oauth2/token'))).toBe(true);
  });
});

describe('the reminder with no door', () => {
  it('reports NOT registered rather than failing silently', () => {
    expect(registerReminder(null, { dueSecs: 1, dueDate: 'x', assumed: false })).toEqual({ registered: false, why: 'no coord door' });
  });
});
