import { ClientSession, Types } from 'mongoose';
import { Session } from './session.model';
import { User } from '../users/user.model';
import { clock } from '../../common/clock';
import { hashToken, randomToken } from '../../common/crypto';
import { config } from '../../config';

const idleMs = () => config.SESSION_IDLE_MINUTES * 60 * 1000;
const absoluteMs = () => config.SESSION_ABSOLUTE_HOURS * 3600 * 1000;
const TOUCH_INTERVAL_MS = 30 * 1000;

export async function createSession(userId: Types.ObjectId, client: 'web' | 'mobile') {
  const token = randomToken();
  const csrfToken = client === 'web' ? randomToken() : null;
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + absoluteMs());
  await Session.create({
    tokenHash: hashToken(token),
    csrfHash: csrfToken ? hashToken(csrfToken) : null,
    userId,
    client,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    revokedAt: null,
  });
  return { token, csrfToken, absoluteExpiresAt: expiresAt, idleExpiresAt: new Date(now.getTime() + idleMs()) };
}

/**
 * Validate a session token: not revoked, within absolute and idle limits, and the
 * account is still ACTIVE. Slides the idle window.
 */
export async function resolveSession(token: string) {
  const session = await Session.findOne({ tokenHash: hashToken(token), revokedAt: null }).lean();
  if (!session) return null;
  const now = clock.now().getTime();
  if (now >= session.expiresAt.getTime()) return null;
  if (now - session.lastSeenAt.getTime() >= idleMs()) return null;

  const user = await User.findById(session.userId).lean();
  if (!user || user.status !== 'ACTIVE') return null;

  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await Session.updateOne({ _id: session._id, revokedAt: null }, { $set: { lastSeenAt: new Date(now) } });
  }
  return { session, user };
}

export async function revokeSession(sessionId: Types.ObjectId): Promise<void> {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: clock.now() } });
}

export async function revokeAllSessions(
  userId: Types.ObjectId,
  opts: { except?: Types.ObjectId; session?: ClientSession } = {},
): Promise<number> {
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (opts.except) filter._id = { $ne: opts.except };
  const r = await Session.updateMany(filter, { $set: { revokedAt: clock.now() } }, { session: opts.session });
  return r.modifiedCount;
}
