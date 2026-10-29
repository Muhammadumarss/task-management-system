import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { h } from '../../common/http';
import { parse } from '../../common/validation';
import { AppError } from '../../common/errors';
import { config } from '../../config';
import { authenticate, SESSION_COOKIE } from '../../middleware/auth';
import { changePassword, consumePasswordToken, login, PERMISSIONS } from './auth.service';
import { passwordSchema } from './password';
import { revokeAllSessions, revokeSession } from './session.service';
import { User, Role } from '../users/user.model';
import { auditCtx } from '../audit/audit.service';
import { ctxOf } from '../../common/context';

export const authRouter = Router();

/** Per-IP limit for credential endpoints. Use a shared store when running multiple instances. */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.', requestId: req.requestId },
    }),
});

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  client: z.enum(['web', 'mobile']).default('web'),
});

function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

function loginHandler(role: Role) {
  return h(async (req, res) => {
    const body = parse(loginBody, req.body);
    const result = await login(role, body.username, body.password, body.client, {
      ip: req.ip,
      requestId: req.requestId,
    });
    const payload: Record<string, unknown> = {
      user: { id: String(result.user._id), name: result.user.name, username: result.user.username, role: result.user.role },
      mustChangePassword: result.user.mustChangePassword,
      absoluteExpiresAt: result.absoluteExpiresAt,
      idleExpiresAt: result.idleExpiresAt,
      idleTimeoutMinutes: config.SESSION_IDLE_MINUTES,
    };
    if (body.client === 'web') {
      setSessionCookie(res, result.token, result.absoluteExpiresAt);
      payload.csrfToken = result.csrfToken;
    } else {
      // Mobile: return a bearer token to be kept in device secure storage.
      payload.token = result.token;
    }
    res.status(200).json(payload);
  });
}

authRouter.post('/admin/login', credentialLimiter, loginHandler('ADMIN'));
authRouter.post('/user/login', credentialLimiter, loginHandler('USER'));

authRouter.post(
  '/logout',
  authenticate,
  h(async (req, res) => {
    await revokeSession(req.auth!.sessionId);
    await auditCtx(ctxOf(req), 'LOGOUT', 'auth', null);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  }),
);

authRouter.post(
  '/logout-all',
  authenticate,
  h(async (req, res) => {
    const count = await revokeAllSessions(req.auth!.userId);
    await auditCtx(ctxOf(req), 'LOGOUT_ALL', 'auth', null, { sessionsRevoked: count });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  h(async (req, res) => {
    const user = await User.findById(req.auth!.userId).lean();
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required.');
    res.json({
      id: String(user._id),
      name: user.name,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      permissions: PERMISSIONS[user.role as Role],
    });
  }),
);

const tokenBody = z.object({ token: z.string().min(20).max(200), password: passwordSchema });

authRouter.post(
  '/set-password',
  credentialLimiter,
  h(async (req, res) => {
    const body = parse(tokenBody, req.body);
    await consumePasswordToken('SETUP', body.token, body.password, req.requestId);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/reset-password',
  credentialLimiter,
  h(async (req, res) => {
    const body = parse(tokenBody, req.body);
    await consumePasswordToken('RESET', body.token, body.password, req.requestId);
    res.json({ ok: true });
  }),
);

const changeBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });

authRouter.post(
  '/change-password',
  credentialLimiter,
  authenticate,
  h(async (req, res) => {
    const body = parse(changeBody, req.body);
    await changePassword(req.auth!.userId, req.auth!.sessionId, body.currentPassword, body.newPassword, req.requestId);
    res.json({ ok: true });
  }),
);
