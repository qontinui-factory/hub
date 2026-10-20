// The AK2 credential check: the account must hold the admin role in this
// tenant, read from GET /api/v1/operations/tenants (list_user_tenants, the
// same per-tenant roles require_coord_tenant_admin checks). Every hub web
// call pins the write tenant with X-Qontinui-Active-Tenant.
import { readFileSync } from 'node:fs';
import { ACTIVE_TENANT_HEADER, TENANT_ID, WEB_API, bearerFile } from './config.mjs';
import { AuthError } from './token.mjs';

export function webHeaders(env = process.env, token = readFileSync(bearerFile(env), 'utf8').trim()) {
  return { Authorization: `Bearer ${token}`, [ACTIVE_TENANT_HEADER]: TENANT_ID, Accept: 'application/json' };
}

/** `idToken` checks a token before it is stored; omitted, the bearer file is read. */
export async function checkAdmin(env = process.env, fetchImpl = fetch, idToken) {
  let res;
  try {
    res = await fetchImpl(`${WEB_API}/api/v1/operations/tenants`, { headers: webHeaders(env, idToken) });
  } catch (err) {
    throw new AuthError('transient', `qontinui-web unreachable: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError('authoritative', `qontinui-web refused the token (HTTP ${res.status})`);
  }
  if (!res.ok) throw new AuthError('transient', `GET /api/v1/operations/tenants answered HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new AuthError('transient', 'GET /api/v1/operations/tenants answered a body that is not JSON');
  }
  const tenant = (body?.tenants ?? []).find((t) => t.id === TENANT_ID);
  if (!tenant) throw new AuthError('authoritative', `the signed-in account is not a member of tenant ${TENANT_ID}`);
  if (!(tenant.roles ?? []).includes('admin')) {
    throw new AuthError('authoritative', `the signed-in account is not an admin of tenant ${TENANT_ID} (roles: ${(tenant.roles ?? []).join(', ') || 'none'})`);
  }
  return { tenant: tenant.slug ?? TENANT_ID, roles: tenant.roles };
}
