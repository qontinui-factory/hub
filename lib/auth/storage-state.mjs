// Extract the web app's Cognito refresh token from a storage-state file written
// by `ui-bridge-login-web --storage-state-out` (@qontinui/ui-bridge-wrapper).
// Playwright's storageState carries cookies + localStorage only; the wrapper
// adds `__sessionStorage` (origin -> {key: value}), and qontinui-web keeps its
// refresh token in sessionStorage under `auth_bearer_refresh_token`.
import { SESSION_REFRESH_TOKEN_KEY } from './config.mjs';
import { AuthError } from './token.mjs';

export function refreshTokenFromStorageState(state) {
  const sessions = state && typeof state === 'object' ? state.__sessionStorage : undefined;
  if (!sessions || typeof sessions !== 'object') {
    throw new AuthError(
      'usage',
      'the file has no __sessionStorage map; write it with `ui-bridge-login-web --storage-state-out` (@qontinui/ui-bridge-wrapper >= 0.10.0)',
    );
  }
  const found = new Map();
  for (const [origin, kv] of Object.entries(sessions)) {
    const value = kv && typeof kv === 'object' ? kv[SESSION_REFRESH_TOKEN_KEY] : undefined;
    if (typeof value === 'string' && value.trim()) found.set(origin, value.trim());
  }
  if (found.size === 0) {
    throw new AuthError(
      'usage',
      `no ${SESSION_REFRESH_TOKEN_KEY} in any origin's sessionStorage (origins: ${Object.keys(sessions).join(', ') || 'none'}); the sign-in may not have completed`,
    );
  }
  const values = new Set(found.values());
  if (values.size > 1) {
    throw new AuthError('usage', `different refresh tokens under ${[...found.keys()].join(', ')}; sign in once, in one tab`);
  }
  return { token: [...values][0], origins: [...found.keys()] };
}
