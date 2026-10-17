import { ipAddress } from '@vercel/functions';
import { createApiAbuseGuard, equalSecret } from './api-abuse-guard.mjs';

const guard = createApiAbuseGuard({ application: 'rein', isTrustedInternal(request: Request) {
  const path = new URL(request.url).pathname;
  const internalPath = ['/api/races', '/api/analyze', '/api/nar/races', '/api/nar/analyze',
    '/api/cron/rein-live', '/api/internal/history-profile'].includes(path);
  return internalPath && equalSecret(request.headers.get('authorization'),
    process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '');
} });

export function protectApiRequest(request: Request) {
  return guard(request, { clientIp: ipAddress(request) || 'unknown' });
}

// Only call after getClaims has verified the JWT. A user cannot evade this second
// allowance by moving between networks or running the same session on many IPs.
export function protectMemberApiRequest(request: Request, userId: string) {
  return guard(request, { subject: userId });
}
