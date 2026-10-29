import { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { AppError, notFound, stateConflict, versionConflict } from '../../common/errors';
import { clock } from '../../common/clock';
import { withTransaction } from '../../common/transaction';
import { escapeRegex, text } from '../../common/validation';
import { normalizePhone } from '../../common/phone';
import { Pagination, pageMeta, skip } from '../../common/pagination';
import type { Ctx } from '../../common/context';
import { User, normalizeUsername, toSafeUser, Role } from './user.model';
import { issuePasswordToken } from '../auth/auth.service';
import { revokeAllSessions } from '../auth/session.service';
import { auditCtx } from '../audit/audit.service';
import { Task } from '../tasks/task.model';
import { Settings, SETTINGS_ID } from '../settings/settings.model';
import { getSettings } from '../settings/settings.service';

const phoneField = z
  .string()
  .max(32)
  .transform((v, c) => {
    const n = normalizePhone(v);
    if (!n) {
      c.addIssue({ code: 'custom', message: 'must be a valid phone number' });
      return z.NEVER;
    }
    return n;
  });

export const createUserBody = z.strictObject({
  name: text(120, 1),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'may contain letters, digits, dot, underscore and dash'),
  phone: phoneField.optional(),
});

export const updateUserBody = z.strictObject({
  version: z.number().int().nonnegative(),
  name: text(120, 1).optional(),
  phone: phoneField.nullable().optional(),
});

/** Admin creates an INVITED user (role USER) and receives a one-time setup link to deliver securely. */
export async function createUser(ctx: Ctx, input: z.infer<typeof createUserBody>) {
  return withTransaction(async (session) => {
    let user;
    try {
      [user] = await User.create(
        [
          {
            name: input.name,
            username: input.username,
            usernameNormalized: normalizeUsername(input.username),
            phone: input.phone ?? null,
            role: 'USER',
            status: 'INVITED',
            mustChangePassword: true,
            createdBy: ctx.actorId,
          },
        ],
        { session },
      );
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw stateConflict('That username is already taken.');
      throw e;
    }
    const setup = await issuePasswordToken(user!._id, 'SETUP', ctx.actorId, session);
    await auditCtx(ctx, 'USER_CREATED', 'user', user!._id, { role: 'USER' }, session);
    return { user: toSafeUser(user!), setupLink: { url: setup.url, expiresAt: setup.expiresAt } };
  });
}

export async function listUsers(q: Pagination & { status?: string; role?: string; search?: string }) {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.role) filter.role = q.role;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { usernameNormalized: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip(q)).limit(q.limit).lean(),
    User.countDocuments(filter),
  ]);
  return { items: items.map(toSafeUser), ...pageMeta(q, total) };
}

export async function getUser(id: string) {
  const u = await User.findById(id).lean();
  if (!u) throw notFound();
  const openTasks = await Task.countDocuments({ assignedTo: u._id, status: 'ASSIGNED' });
  return { ...toSafeUser(u), openTasks };
}

/** Allowlisted profile fields only. Role and status have dedicated operations. */
export async function updateUser(ctx: Ctx, id: string, input: z.infer<typeof updateUserBody>) {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.phone !== undefined) set.phone = input.phone;
  return withTransaction(async (session) => {
    const u = await User.findOneAndUpdate(
      { _id: id, version: input.version },
      { $set: set, $inc: { version: 1 } },
      { new: true, session },
    );
    if (!u) {
      if (await User.exists({ _id: id }).session(session)) throw versionConflict();
      throw notFound();
    }
    await auditCtx(ctx, 'USER_UPDATED', 'user', u._id, { fields: Object.keys(set) }, session);
    return toSafeUser(u);
  });
}

/** Serialize "last active admin" checks: touching the settings doc makes concurrent checks conflict. */
async function lockAdminSet(session: ClientSession) {
  await getSettings(session);
  await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { adminLockAt: clock.now() } }, { session });
}

async function assertNotLastActiveAdmin(userId: Types.ObjectId, session: ClientSession) {
  const others = await User.countDocuments({ role: 'ADMIN', status: 'ACTIVE', _id: { $ne: userId } }).session(session);
  if (others === 0) throw new AppError(409, 'LAST_ADMIN', 'The last active administrator cannot be removed.');
}

/** Deactivate: revoke sessions immediately and flag open tasks for reassignment. */
export async function deactivateUser(ctx: Ctx, id: string) {
  return withTransaction(async (session) => {
    const target = await User.findById(id).session(session);
    if (!target) throw notFound();
    if (target.status === 'INACTIVE') return { user: toSafeUser(target), tasksFlagged: 0 };
    if (target.role === 'ADMIN') {
      await lockAdminSet(session);
      await assertNotLastActiveAdmin(target._id, session);
    }
    const u = await User.findOneAndUpdate(
      { _id: target._id, status: { $ne: 'INACTIVE' } },
      { $set: { status: 'INACTIVE' }, $inc: { version: 1 } },
      { new: true, session },
    );
    if (!u) throw stateConflict('The account changed concurrently. Reload and try again.');
    await revokeAllSessions(u._id, { session });
    const flagged = await Task.updateMany(
      { assignedTo: u._id, status: 'ASSIGNED' },
      { $set: { needsReassignment: true }, $inc: { version: 1 } },
      { session },
    );
    await auditCtx(ctx, 'USER_DEACTIVATED', 'user', u._id, { tasksFlagged: flagged.modifiedCount }, session);
    return { user: toSafeUser(u), tasksFlagged: flagged.modifiedCount };
  });
}

/** Reactivate an INACTIVE account. Users who never set a password return to INVITED. */
export async function activateUser(ctx: Ctx, id: string) {
  return withTransaction(async (session) => {
    const target = await User.findById(id).select('+passwordHash').session(session);
    if (!target) throw notFound();
    if (target.status !== 'INACTIVE') return toSafeUser(target);
    const status = target.passwordHash ? 'ACTIVE' : 'INVITED';
    const u = await User.findOneAndUpdate(
      { _id: target._id, status: 'INACTIVE' },
      { $set: { status }, $inc: { version: 1 } },
      { new: true, session },
    );
    if (!u) throw stateConflict('The account changed concurrently. Reload and try again.');
    await auditCtx(ctx, 'USER_ACTIVATED', 'user', u._id, { status }, session);
    return toSafeUser(u);
  });
}

/** Issue an expiring reset link. For an INVITED user this is a fresh setup link. */
export async function issueReset(ctx: Ctx, id: string) {
  return withTransaction(async (session) => {
    const u = await User.findById(id).session(session);
    if (!u) throw notFound();
    if (u.status === 'INACTIVE') throw stateConflict('Reactivate the account before issuing a reset link.');
    const purpose = u.status === 'INVITED' ? 'SETUP' : 'RESET';
    const t = await issuePasswordToken(u._id, purpose, ctx.actorId, session);
    await auditCtx(ctx, 'PASSWORD_RESET_ISSUED', 'user', u._id, { purpose }, session);
    return { purpose, link: { url: t.url, expiresAt: t.expiresAt } };
  });
}

export const changeRoleBody = z.strictObject({
  role: z.enum(['ADMIN', 'USER']),
  reason: text(500, 3),
  version: z.number().int().nonnegative(),
});

/** Dedicated, audited role change with last-admin protection. Sessions are revoked. */
export async function changeRole(ctx: Ctx, id: string, input: z.infer<typeof changeRoleBody>) {
  return withTransaction(async (session) => {
    const target = await User.findById(id).session(session);
    if (!target) throw notFound();
    if (target.role === input.role) return toSafeUser(target);
    await lockAdminSet(session);
    if (target.role === 'ADMIN' && target.status === 'ACTIVE') await assertNotLastActiveAdmin(target._id, session);
    if (input.role === 'ADMIN' && (await Task.exists({ assignedTo: target._id, status: 'ASSIGNED' }).session(session))) {
      throw stateConflict('Reassign or complete this user’s open tasks before promoting them.');
    }
    const u = await User.findOneAndUpdate(
      { _id: target._id, version: input.version },
      { $set: { role: input.role as Role }, $inc: { version: 1 } },
      { new: true, session },
    );
    if (!u) throw versionConflict();
    await revokeAllSessions(u._id, { session });
    await auditCtx(ctx, 'USER_ROLE_CHANGED', 'user', u._id, { from: target.role, to: input.role, reason: input.reason }, session);
    return toSafeUser(u);
  });
}
