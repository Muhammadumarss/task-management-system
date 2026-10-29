import { RequestHandler } from 'express';
import { AppError, forbidden, unauthenticated } from '../common/errors';
import { h } from '../common/http';
import { safeEqual, hashToken } from '../common/crypto';
import { config } from '../config';
import { resolveSession } from '../modules/auth/session.service';
import type { Role } from '../modules/users/user.model';
import { audit } from '../modules/audit/audit.service';

export const SESSION_COOKIE = config.COOKIE_SECURE ? '__Host-sid' : 'sid';
export const CSRF_HEADER = 'x-csrf-token';

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  return m ? m[1]! : null;
}

/**
 * Resolve the session from a Bearer token (mobile) or the session cookie (web).
 * Re-checks session revocation/expiry and account status on every request.
 */
export const authenticate: RequestHandler = h(async (req, _res, next) => {
  const bearer = bearerToken(req.header('authorization'));
  const cookie = typeof req.cookies?.[SESSION_COOKIE] === 'string' ? (req.cookies[SESSION_COOKIE] as string) : null;
  const token = bearer ?? cookie;
  if (!token) throw unauthenticated();

  const resolved = await resolveSession(token);
  if (!resolved) throw unauthenticated();
  const { session, user } = resolved;

  const via = bearer ? 'bearer' : 'cookie';
  // CSRF: cookie-authenticated writes must echo the per-session CSRF token.
  if (via === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const sent = req.header(CSRF_HEADER);
    if (!sent || !session.csrfHash || !safeEqual(hashToken(sent), session.csrfHash)) {
      throw new AppError(403, 'CSRF_FAILED', 'The request could not be verified.');
    }
  }

  req.auth = {
    userId: user._id,
    role: user.role as Role,
    name: user.name,
    username: user.username,
    sessionId: session._id,
    client: session.client as 'web' | 'mobile',
    via,
  };
  next();
});

/** Role gate. Denials are audited without request content. */
export function requireRole(role: Role): RequestHandler {
  return h(async (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    if (req.auth.role !== role) {
      await audit({
        actorId: req.auth.userId,
        actorRole: req.auth.role,
        requestId: req.requestId,
        action: 'ACCESS_DENIED',
        entityType: 'route',
        entityId: null,
        summary: { method: req.method, route: req.baseUrl + (req.route?.path ?? '') },
      });
      throw forbidden();
    }
    next();
  });
}
