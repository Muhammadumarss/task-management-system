import { ClientSession, Types } from 'mongoose';
import { AppError } from '../../common/errors';
import { clock } from '../../common/clock';
import { hashToken, randomToken } from '../../common/crypto';
import { withTransaction } from '../../common/transaction';
import { config } from '../../config';
import { User, normalizeUsername, Role } from '../users/user.model';
import { PasswordToken, TokenPurpose } from './passwordToken.model';
import { hashPassword, verifyPassword } from './password';
import { createSession, revokeAllSessions } from './session.service';
import { clearFailures, isAccountLocked, recordFailure } from './throttle';
import { audit } from '../audit/audit.service';

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'The username or password is incorrect.');

export const PERMISSIONS: Record<Role, string[]> = {
  ADMIN: [
    'users:manage',
    'people:create',
    'people:read:all',
    'people:update:all',
    'people:archive',
    'tasks:manage',
    'tasks:read:all',
    'reminders:manage',
    'settings:manage',
    'backups:manage',
    'audit:read',
  ],
  USER: ['people:create', 'people:read:own-recent', 'people:update:own-recent', 'tasks:read:own', 'tasks:complete:own'],
};

/**
 * Authenticate for a specific login screen. The role comes from the account, never the
 * client: a USER at the admin endpoint (or vice versa) gets the same generic failure.
 */
export async function login(
  expectedRole: Role,
  username: string,
  password: string,
  client: 'web' | 'mobile',
  meta: { ip: string | undefined; requestId: string },
) {
  const uname = normalizeUsername(username);
  if (isAccountLocked(uname)) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.');
  }
  const user = await User.findOne({ usernameNormalized: uname }).select('+passwordHash').lean();
  const ok = await verifyPassword(user?.passwordHash, password);
  if (!user || !ok || user.status !== 'ACTIVE' || user.role !== expectedRole) {
    recordFailure(uname);
    await audit({
      actorId: user?._id ?? null,
      actorRole: null,
      requestId: meta.requestId,
      action: 'LOGIN_FAILED',
      entityType: 'auth',
      entityId: null,
      summary: { endpoint: expectedRole.toLowerCase() },
    });
    throw invalidCredentials();
  }
  clearFailures(uname);
  const s = await createSession(user._id, client);
  await audit({
    actorId: user._id,
    actorRole: user.role,
    requestId: meta.requestId,
    action: 'LOGIN_SUCCEEDED',
    entityType: 'auth',
    entityId: null,
    summary: { client },
  });
  return { user, ...s };
}

/** Create a single-use, expiring setup/reset token. Only its hash is stored. */
export async function issuePasswordToken(
  userId: Types.ObjectId,
  purpose: TokenPurpose,
  createdBy: Types.ObjectId | null,
  session?: ClientSession,
) {
  const now = clock.now();
  // Supersede any outstanding tokens for this user.
  await PasswordToken.updateMany(
    { userId, consumedAt: null },
    { $set: { consumedAt: now } },
    { session },
  );
  const token = randomToken();
  const ttlMs = purpose === 'SETUP' ? config.SETUP_TOKEN_HOURS * 3600_000 : config.RESET_TOKEN_MINUTES * 60_000;
  const expiresAt = new Date(now.getTime() + ttlMs);
  await PasswordToken.create(
    [{ tokenHash: hashToken(token), userId, purpose, expiresAt, consumedAt: null, createdBy, createdAt: now }],
    { session },
  );
  const path = purpose === 'SETUP' ? 'set-password' : 'reset-password';
  return { token, expiresAt, url: `${config.WEB_BASE_URL}/${path}?token=${encodeURIComponent(token)}` };
}

/**
 * Consume a setup or reset token and set the password. Atomic single-use: the token is
 * claimed with a conditional update inside the transaction. All sessions are revoked.
 */
export async function consumePasswordToken(
  purpose: TokenPurpose,
  token: string,
  newPassword: string,
  requestId: string,
) {
  const passwordHash = await hashPassword(newPassword); // outside the transaction (expensive, retry-safe)
  return withTransaction(async (session) => {
    const now = clock.now();
    const pt = await PasswordToken.findOneAndUpdate(
      { tokenHash: hashToken(token), purpose, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { session, new: true },
    );
    if (!pt) throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has expired.');

    const allowedStatus = purpose === 'SETUP' ? ['INVITED'] : ['INVITED', 'ACTIVE'];
    const user = await User.findOneAndUpdate(
      { _id: pt.userId, status: { $in: allowedStatus } },
      { $set: { passwordHash, status: 'ACTIVE', mustChangePassword: false }, $inc: { version: 1 } },
      { session, new: true },
    );
    if (!user) throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has expired.');
    await revokeAllSessions(user._id, { session });
    await audit(
      {
        actorId: user._id,
        actorRole: user.role,
        requestId,
        action: purpose === 'SETUP' ? 'PASSWORD_SET' : 'PASSWORD_RESET',
        entityType: 'user',
        entityId: user._id,
      },
      session,
    );
    return { ok: true };
  });
}

export async function changePassword(
  userId: Types.ObjectId,
  currentSessionId: Types.ObjectId,
  currentPassword: string,
  newPassword: string,
  requestId: string,
) {
  const user = await User.findById(userId).select('+passwordHash').lean();
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw invalidCredentials();
  }
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (session) => {
    await User.updateOne(
      { _id: userId },
      { $set: { passwordHash, mustChangePassword: false }, $inc: { version: 1 } },
      { session },
    );
    // Keep the current session, revoke all others.
    await revokeAllSessions(userId, { except: currentSessionId, session });
    await audit(
      { actorId: userId, actorRole: user.role, requestId, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: userId },
      session,
    );
  });
}
