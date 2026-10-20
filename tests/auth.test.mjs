import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, readStdinSecret } from '../bin/hub.mjs';
import { COGNITO_CLIENT_ID, SESSION_REFRESH_TOKEN_KEY, TENANT_ID } from '../lib/auth/config.mjs';
import { refreshTokenFromStorageState } from '../lib/auth/storage-state.mjs';
import { exchange, startRefresher } from '../lib/auth/token.mjs';
import { postAuthFinding, registerReminder } from '../lib/auth/coord.mjs';

const RT = 'refresh-token-value';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const AUTH_TIME = Math.floor(Date.now() / 1000) - 10 * 86400; // signed in ten days ago
const ID = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, auth_time: AUTH_TIME, email: 'op@example.test' });
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
const notJson = async () => {
  throw new SyntaxError('Unexpected token <');
};

function stubFetch({ grant = 'ok', roles = ['admin'], member = true, web = 'ok', calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/oauth2/token')) {
      if (grant === 'invalid') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      if (grant === '401') return { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) };
      if (grant === '400-html') return { ok: false, status: 400, json: notJson };
      if (grant === '503') return { ok: false, status: 503, json: notJson };
      if (grant === '200-html') return { ok: true, status: 200, json: notJson };
      if (grant === 'down') throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => ({ id_token: ID, access_token: ACCESS, expires_in: 3600 }) };
    }
    if (url.endsWith('/api/v1/operations/tenants')) {
      if (web === '502') return { ok: false, status: 502, json: notJson };
      if (web === 'html') return { ok: true, status: 200, json: notJson };
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
  it.each([
    ['invalid', 'authoritative'],
    ['401', 'authoritative'],
    ['400-html', 'transient'],
    ['503', 'transient'],
    ['200-html', 'transient'],
    ['down', 'transient'],
  ])('classifies a %s answer as %s (cognito-oauth.ts:478-480)', async (grant, kind) => {
    await expect(exchange(RT, stubFetch({ grant }))).rejects.toMatchObject({ kind });
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
      // The real row shape: the phase name sits under `anchor`.
      if (tool === 'coord_gate_list')
        return {
          gates: [
            { gate_id: 'new', anchor: { phase_name: 'hub auth: refresh token expires 2026-12-01 — re-run hub auth import' } },
            { gate_id: 'old', anchor: { phase_name: 'hub auth: refresh token expires 2026-11-01 — re-run hub auth import' } },
            { gate_id: 'other', anchor: { phase_name: 'Phase 3' } },
          ],
          truncated: false,
        };
      if (tool === 'coord_register_gate') return { gate_id: 'new' };
      return {};
    };
    const { d } = deps(e, { call });
    expect(await main(['auth', 'import', file], d)).toBe(0);
    expect(coordCalls[0][0]).toBe('coord_register_gate'); // registered before anything is withdrawn
    expect(coordCalls.filter(([t]) => t === 'coord_withdraw_gate').map(([, a]) => a.gate_id)).toEqual(['old']);
    const reg = coordCalls.find(([t]) => t === 'coord_register_gate')[1];
    // 30-day validity from a sign-in ten days ago, less three days' notice.
    expect(reg.predicate.kind).toBe('time_elapsed');
    expect(Math.abs(reg.predicate.duration_secs - 17 * 86400)).toBeLessThan(5);
    expect(reg.continuation).toEqual({ action: 'notify_only' });
    expect(reg.phase_name).toMatch(/^hub auth: refresh token expires \d{4}-\d{2}-\d{2} — re-run hub auth import$/);
    expect(JSON.stringify(coordCalls)).not.toContain(RT);
  });
});

describe('a refused or interrupted import keeps the stored credential', () => {
  const prior = async () => {
    const e = env();
    await main(['auth', 'set'], deps(e, { stdinToken: 'previous-good-token' }).d);
    return e;
  };
  it.each([
    ['a non-admin account', { roles: ['developer'] }, 3],
    ['a non-member', { member: false }, 3],
    ['a 502 from the web', { web: '502' }, 4],
    ['a web body that is not JSON', { web: 'html' }, 4],
    ['a dead refresh token', { grant: 'invalid' }, 3],
  ])('%s', async (_, extra, code) => {
    const e = await prior();
    const before = readFileSync(e.STUDIO_WEB_BEARER_FILE, 'utf8');
    const file = storageState(e.dir, { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } });
    expect(await main(['auth', 'import', file], deps(e, extra).d)).toBe(code);
    expect(readFileSync(e.STUDIO_WEB_REFRESH_TOKEN_FILE, 'utf8').trim()).toBe('previous-good-token');
    expect(readFileSync(e.STUDIO_WEB_BEARER_FILE, 'utf8')).toBe(before);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(join(e.dir, 'state')).sort()).toEqual(['bearer', 'refresh']); // no temp file left behind
  });
});

describe('a failed credential write', () => {
  it('exits 1 naming the error code', async () => {
    const e = env();
    await main(['auth', 'set'], deps(e).d);
    chmodSync(join(e.dir, 'state'), 0o500);
    try {
      const { d, logs } = deps(e);
      expect(await main(['auth', 'set'], d)).toBe(1);
      expect(logs.join('\n')).toMatch(/unexpected EACCES/);
    } finally {
      chmodSync(join(e.dir, 'state'), 0o700);
    }
  });
});

describe('findings', () => {
  it('posts one for an authoritative refusal, none for a transient failure', async () => {
    for (const [grant, posts] of [['invalid', true], ['503', false]]) {
      const posted = [];
      const e = env();
      const file = storageState(e.dir, { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } });
      const call = (tool, args) => (posted.push([tool, args]), { posted: true, finding: { finding_id: 'f1' } });
      const { d, logs } = deps(e, { grant, call });
      await main(['auth', 'import', file], d);
      expect(posted.some(([t]) => t === 'coord_post_finding')).toBe(posts);
      if (posts) expect(logs.join('\n')).toContain('posted coord finding f1');
      expect(JSON.stringify(posted)).not.toContain(RT);
    }
  });
  it("reads coord's {posted:false, reason} as not posted", () => {
    expect(postAuthFinding(() => ({ posted: false, reason: 'not provisioned' }), 'x', 'y', 'z')).toEqual({ posted: false, why: 'not provisioned' });
  });
});

describe('the token never reaches the log', () => {
  it('when pasted where the storage-state path goes', async () => {
    const { d, logs } = deps(env());
    expect(await main(['auth', 'import', RT], d)).toBe(2);
    expect(logs.join('\n')).not.toContain(RT);
  });
  it('when the storage-state file is malformed around it', async () => {
    const e = env();
    const file = join(e.dir, 'bad.json');
    writeFileSync(file, `{"auth_bearer_refresh_token":"${RT}",}`);
    const { d, logs } = deps(e);
    expect(await main(['auth', 'import', file], d)).toBe(2);
    expect(logs.join('\n')).not.toContain('token-value');
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
  it('reads a TTY hidden, honouring backspace and ignoring arrow keys', async () => {
    const tty = Readable.from(['refresh-tokeX', '\u007f', 'n\u001b[D-val', '\u001bOAue', '\r']);
    const modes = [];
    tty.isTTY = true;
    tty.setRawMode = (m) => modes.push(m);
    const err = { written: '', write(s) { this.written += s; } };
    expect(await readStdinSecret(tty, err)).toBe(RT);
    expect(modes).toEqual([true, false]);
    expect(err.written).not.toContain('tokeX');
    expect(err.written).not.toContain(RT);
  });
  it('refuses arguments on check and refresh too', async () => {
    for (const cmd of ['check', 'refresh']) expect(await main(['auth', cmd, RT], deps(env()).d)).toBe(2);
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
  it('refreshes when the bearer file is missing', async () => {
    const e = env();
    await main(['auth', 'set'], deps(e).d);
    writeFileSync(e.STUDIO_WEB_BEARER_FILE, 'not a jwt');
    const stop = startRefresher({ env: e, fetchImpl: stubFetch(), intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(readFileSync(e.STUDIO_WEB_BEARER_FILE, 'utf8').trim()).toBe(ID);
  });
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

describe('the reminder', () => {
  it('stays registered when an old one cannot be withdrawn', () => {
    const call = (tool) => {
      if (tool === 'coord_register_gate') return { gate_id: 'new' };
      if (tool === 'coord_gate_list') return { gates: [{ gate_id: 'foreign', anchor: { phase_name: 'hub auth: refresh token expires 2026-11-01' } }] };
      throw new Error('registered by another device');
    };
    const r = registerReminder(call, { dueSecs: 1, dueDate: 'x', assumed: false });
    expect(r).toMatchObject({ registered: true, gateId: 'new', withdrawn: [] });
    expect(r.notWithdrawn[0]).toMatch(/foreign .*another device/);
  });
  it('withdraws nothing when the new one fails to register', () => {
    const tools = [];
    const r = registerReminder((t) => (tools.push(t), (() => { throw new Error('503'); })()), { dueSecs: 1, dueDate: 'x', assumed: false });
    expect(r.registered).toBe(false);
    expect(tools).toEqual(['coord_register_gate']);
  });
});

describe('the storage-state file', () => {
  it('exits 8 (6 and 7) when it cannot be deleted and the reminder was not registered', async () => {
    const e = env();
    const sub = join(e.dir, 'ro');
    mkdirSync(sub);
    const file = join(sub, 'auth.json');
    writeFileSync(file, JSON.stringify({ __sessionStorage: { 'https://qontinui.io': { [SESSION_REFRESH_TOKEN_KEY]: RT } } }));
    chmodSync(sub, 0o500);
    try {
      const { d, logs } = deps(e);
      expect(await main(['auth', 'import', file], d)).toBe(8); // no coord door in the test: also not registered
      expect(logs.join('\n')).toMatch(/delete it by hand/);
    } finally {
      chmodSync(sub, 0o700);
    }
  });
});

describe('the reminder timing', () => {
  it('reads an auth_time at the refresh itself as unknown, not as a fresh sign-in', async () => {
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, auth_time: Math.floor(Date.now() / 1000) });
    const e = env();
    const regs = [];
    const call = (tool, args) => (tool === 'coord_register_gate' ? (regs.push(args), { gate_id: 'g' }) : { gates: [] });
    const { d, logs } = deps(e, { call });
    d.fetchImpl = async (url) =>
      url.endsWith('/oauth2/token')
        ? { ok: true, status: 200, json: async () => ({ id_token: fresh }) }
        : { ok: true, status: 200, json: async () => ({ tenants: [{ id: TENANT_ID, roles: ['admin'] }] }) };
    expect(await main(['auth', 'set'], d)).toBe(0);
    expect(Math.abs(regs[0].predicate.duration_secs - 27 * 86400)).toBeLessThan(5);
    expect(logs.join('\n')).toMatch(/sign-in time unknown/);
  });
});

describe('the reminder with no door', () => {
  it('reports NOT registered rather than failing silently', () => {
    expect(registerReminder(null, { dueSecs: 1, dueDate: 'x', assumed: false })).toEqual({ registered: false, why: 'no coord door' });
  });
});
