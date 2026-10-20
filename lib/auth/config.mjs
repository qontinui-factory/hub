// The web app's Cognito client and the tenant the hub publishes under.
// Every value is read from qontinui-web origin/main, not guessed (plan AJ1, AK2):
// - client id and hosted-UI domain: frontend/src/services/auth/cognito-oauth.ts:25-33
//   (the backend accepts this client: backend/app/core/config.py:309);
// - user pool: backend/app/core/config.py:284-286 (COGNITO_USER_POOL_ID);
// - storage key: frontend/src/services/auth/token-storage.ts:54
//   (SESSION_REFRESH_TOKEN_KEY, a sessionStorage key);
// - active-tenant header: backend/app/api/v1/endpoints/operations/__init__.py
//   (ACTIVE_TENANT_HEADER, read by require_coord_tenant_admin).
import { homedir } from 'node:os';
import { join } from 'node:path';

export const COGNITO_CLIENT_ID = process.env.HUB_COGNITO_CLIENT_ID ?? 'q6ns1a8bokf2np1mj8v8arl31';
export const COGNITO_TOKEN_ENDPOINT =
  process.env.HUB_COGNITO_TOKEN_ENDPOINT ?? 'https://auth.qontinui.io/oauth2/token';
export const COGNITO_USER_POOL_ID = 'us-east-1_rgTB9dbZ1';
export const COGNITO_REGION = 'us-east-1';
export const SESSION_REFRESH_TOKEN_KEY = 'auth_bearer_refresh_token';
export const WEB_API = process.env.HUB_WEB_API ?? 'https://api.qontinui.io';
export const ACTIVE_TENANT_HEADER = 'X-Qontinui-Active-Tenant';
export const TENANT_ID = 'c231d9da-0ca8-4fe4-bd81-0e3d6c20339a';
export const WORK_UNIT_ID = '62a75e16-36fc-4506-9067-85a9e4fad03c';
export const REMINDER_PREFIX = 'hub auth: refresh token expires';

export function refreshTokenFile(env = process.env) {
  return env.STUDIO_WEB_REFRESH_TOKEN_FILE ?? join(homedir(), '.qontinui', 'studio', 'web-refresh-token');
}

export function bearerFile(env = process.env) {
  return env.STUDIO_WEB_BEARER_FILE ?? join(homedir(), '.qontinui', 'studio', 'web-bearer');
}
