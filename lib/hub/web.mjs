// qontinui-web's build-record door, as the hub calls it (plan AI4.7, AG1, AH1).
// Shapes are read from qontinui-web origin/main
// backend/app/api/v1/endpoints/build_records.py:
//   GET    /api/v1/build-records/products          -> {products: [coord ProductRow]}
//   PUT    /api/v1/build-records/products/{slug}   body BuildRecordProductWrite
//          {title, repos, window_start, window_end, is_public} (extra=forbid)
//   POST   /api/v1/build-records/{slug}/publish    optional body {reactivate}; 201
//          {public_slug, version, content_sha256}; 409 build_record_retracted
//   DELETE /api/v1/build-records/{slug}/publish    200 {public_slug, unpublished_at,
//          latest_version}; 404 build_record_not_published; 409
//          public_slug_owned_by_another_tenant
//   GET    /api/v1/build-records/{slug}/publication -> {owned_by_caller_tenant, unpublished, …}
// Refusals come back as FastAPI's {"detail": {"error": <code>, "slug": …}}.
// Every authed call carries the bearer file's ID token and pins the tenant
// (webHeaders, AK2).
import { WEB_API } from '../auth/config.mjs';
import { webHeaders } from '../auth/check.mjs';

export const PUBLIC_ROUTE = `${WEB_API}/api/v1/public/build-records`;

/** The web's error code from a refusal body, or null. */
export function errorCode(body) {
  const d = body?.detail ?? body;
  if (d && typeof d === 'object' && typeof d.error === 'string') return d.error;
  return null;
}

export function makeWeb({ env = process.env, fetchImpl = fetch } = {}) {
  async function call(method, path, body) {
    const headers = webHeaders(env);
    const init = { method, headers };
    if (body !== undefined) {
      init.headers = { ...headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchImpl(`${WEB_API}/api/v1/build-records${path}`, init);
    } catch (err) {
      return { status: 0, body: null, code: null, network: err.message };
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      // A body that is not JSON is classified by status alone.
    }
    return { status: res.status, body: parsed, code: errorCode(parsed) };
  }
  return {
    products: () => call('GET', '/products'),
    putProduct: (slug, body) => call('PUT', `/products/${encodeURIComponent(slug)}`, body),
    publish: (slug, reactivate) => call('POST', `/${encodeURIComponent(slug)}/publish`, reactivate ? { reactivate: true } : undefined),
    unpublish: (slug) => call('DELETE', `/${encodeURIComponent(slug)}/publish`),
    publication: (slug) => call('GET', `/${encodeURIComponent(slug)}/publication`),
    /** The anonymous public snapshot route: 200 or 404 is the answer; anything else is UNKNOWN. */
    async publicStatus(slug) {
      try {
        const res = await fetchImpl(`${PUBLIC_ROUTE}/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
        return res.status;
      } catch {
        return 0;
      }
    },
  };
}

export const isAuthStatus = (s) => s === 401 || s === 403;
