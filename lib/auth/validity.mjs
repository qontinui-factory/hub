// The refresh token's lifetime is the app client's RefreshTokenValidity
// (plan AJ1). Read it from Cognito with the AWS CLI the studio host carries;
// when that read fails the reminder is timed on Cognito's 30-day default and
// SAYS it assumed so (AK3).
import { execFileSync } from 'node:child_process';
import { COGNITO_CLIENT_ID, COGNITO_REGION, COGNITO_USER_POOL_ID } from './config.mjs';

const UNIT_SECS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

export function refreshValiditySecs(run = execFileSync) {
  try {
    const out = run(
      'aws',
      ['cognito-idp', 'describe-user-pool-client', '--region', COGNITO_REGION, '--user-pool-id', COGNITO_USER_POOL_ID,
        '--client-id', COGNITO_CLIENT_ID, '--query', '[UserPoolClient.RefreshTokenValidity, UserPoolClient.TokenValidityUnits.RefreshToken]', '--output', 'json'],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const [n, unit] = JSON.parse(out);
    const mult = UNIT_SECS[unit ?? 'days'];
    if (typeof n === 'number' && n > 0 && mult) return { secs: n * mult, assumed: false };
  } catch {
    // Fall through to the labelled default.
  }
  return { secs: 30 * 86400, assumed: true };
}
