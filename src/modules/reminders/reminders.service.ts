import { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { AppError, notFound, stateConflict } from '../../common/errors';
import { clock } from '../../common/clock';
import { dueAfterDays, todayIn } from '../../common/dates';
import { withTransaction } from '../../common/transaction';
import { dateOnly, objectId, text } from '../../common/validation';
import { Pagination, pageMeta, skip } from '../../common/pagination';
import type { Ctx } from '../../common/context';
import { Reminder, ReminderDoc } from './reminder.model';
import { Task, TaskDoc, FollowUpOutcome } from '../tasks/task.model';
import { Person } from '../people/person.model';
import { User } from '../users/user.model';
import { auditCtx } from '../audit/audit.service';
import { getSettings } from '../settings/settings.service';
import { FollowUpPolicy, plainPolicy, policyOverride } from './policy';

export function toReminderView(r: ReminderDoc, person?: { name: string; phoneOriginal: string } | null) {
  return {
    id: String(r._id),
    personId: String(r.personId),
    person: person ? { name: person.name, phone: person.phoneOriginal } : undefined,
    sourceTaskId: String(r.sourceTaskId),
    dueAt: r.dueAt,
    isDue: r.status === 'SCHEDULED' && r.dueAt.getTime() <= clock.now().getTime(),
    status: r.status,
    reason: r.reason,
    attempt: r.attempt,
    assignedTaskId: r.assignedTaskId ? String(r.assignedTaskId) : null,
    resolvedAt: r.resolvedAt,
    outcome: r.outcome,
    dismissalReason: r.dismissalReason,
    createdAt: r.createdAt,
    version: r.version,
  };
}

async function createReminder(
  task: TaskDoc,
  reason: 'AFTER_WORK' | 'REPEAT' | 'UNREACHABLE_RETRY',
  days: number,
  attempt: number,
  policy: FollowUpPolicy,
  completedAt: Date,
  session: ClientSession,
) {
  const dueAt = dueAfterDays(completedAt, days, policy.reminderTime, policy.timezone);
  // One reminder per completion. The unique index on sourceTaskId is the backstop; a write
  // error would abort the transaction, so check first rather than catching a duplicate.
  if (await Reminder.exists({ sourceTaskId: task._id }).session(session)) return null;
  const [r] = await Reminder.create(
    [{ personId: task.personId, sourceTaskId: task._id, dueAt, status: 'SCHEDULED', reason, attempt, policy: plainPolicy(policy) }],
    { session },
  );
  return r!;
}

/**
 * Called inside the completion transaction. Uses the task's policy snapshot, never live
 * settings, so a settings change cannot silently alter what happens on completion.
 */
export async function onTaskCompleted(task: TaskDoc, completedAt: Date, session: ClientSession) {
  const policy = task.followUpPolicySnapshot as FollowUpPolicy;
  if (task.type === 'WORK') {
    if (!policy.enabled) return null;
    return createReminder(task, 'AFTER_WORK', policy.intervalDays, 1, policy, completedAt, session);
  }

  const outcome = task.followUpOutcome as FollowUpOutcome;
  if (task.sourceReminderId) {
    await Reminder.updateOne(
      { _id: task.sourceReminderId, status: 'ASSIGNED', assignedTaskId: task._id },
      { $set: { status: 'RESOLVED', resolvedAt: completedAt, outcome }, $inc: { version: 1 } },
      { session },
    );
  }
  switch (outcome) {
    case 'NEEDS_WORK':
      // Surfaced to admin on the dashboard; admin creates a distinct WORK task.
      return null;
    case 'NO_WORK_NEEDED':
      if (policy.enabled && policy.repeatFollowUps) {
        return createReminder(task, 'REPEAT', policy.intervalDays, 1, policy, completedAt, session);
      }
      return null;
    case 'UNREACHABLE': {
      const attempt = task.attempt ?? 1;
      if (policy.unreachableRetryDays > 0 && attempt < policy.maxUnreachableAttempts) {
        return createReminder(task, 'UNREACHABLE_RETRY', policy.unreachableRetryDays, attempt + 1, policy, completedAt, session);
      }
      return null;
    }
  }
}

// ---------- Admin operations ----------

export const listQuery = z.object({
  view: z.enum(['due', 'upcoming', 'all']).default('due'),
  status: z.enum(['SCHEDULED', 'ASSIGNED', 'RESOLVED', 'DISMISSED']).optional(),
});

/** Due = SCHEDULED with dueAt <= server now. Correct regardless of whether any worker ran. */
export async function listReminders(q: Pagination & z.infer<typeof listQuery>) {
  const now = clock.now();
  const filter: Record<string, unknown> = {};
  if (q.view === 'due') Object.assign(filter, { status: 'SCHEDULED', dueAt: { $lte: now } });
  else if (q.view === 'upcoming') Object.assign(filter, { status: 'SCHEDULED', dueAt: { $gt: now } });
  if (q.status && q.view === 'all') filter.status = q.status;
  const [items, total] = await Promise.all([
    Reminder.find(filter).sort({ dueAt: 1 }).skip(skip(q)).limit(q.limit).lean(),
    Reminder.countDocuments(filter),
  ]);
  const people = await Person.find({ _id: { $in: items.map((r) => r.personId) } }, { name: 1, phoneOriginal: 1 }).lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  return { items: items.map((r) => toReminderView(r, byId.get(String(r.personId)))), serverTime: now, ...pageMeta(q, total) };
}

export const assignBody = z.strictObject({
  assignedTo: objectId,
  scheduledDate: dateOnly.optional(),
  instructions: text(2000).optional(),
  followUpPolicy: policyOverride.optional(),
});

export async function assertAssignableUser(userId: string | Types.ObjectId, session: ClientSession) {
  const u = await User.findOne({ _id: userId, role: 'USER', status: 'ACTIVE' }).session(session).lean();
  if (!u) throw new AppError(400, 'VALIDATION_FAILED', 'The assignee must be an active user.');
  return u;
}

/** Touch the person inside the transaction so archive and task creation cannot interleave. */
export async function lockActivePerson(personId: Types.ObjectId | string, session: ClientSession) {
  const p = await Person.findOneAndUpdate(
    { _id: personId, status: 'ACTIVE' },
    { $set: { taskLockAt: clock.now() } },
    { session, new: true },
  ).lean();
  if (!p) throw stateConflict('The person is archived or unavailable.');
  return p;
}

/**
 * Assign: one transaction creates exactly one FOLLOW_UP task and marks the reminder ASSIGNED.
 * The conditional reminder update plus the partial unique index on tasks.sourceReminderId
 * guarantee that two admins assigning concurrently produce a single task.
 */
export async function assignReminder(ctx: Ctx, id: string, input: z.infer<typeof assignBody>) {
  const settings = await getSettings();
  return withTransaction(async (session) => {
    const reminder = await Reminder.findById(id).session(session).lean();
    if (!reminder) throw notFound();
    if (reminder.status !== 'SCHEDULED') throw stateConflict('This reminder is no longer awaiting assignment.');
    await assertAssignableUser(input.assignedTo, session);
    await lockActivePerson(reminder.personId, session);

    const taskId = new Types.ObjectId();
    const claimed = await Reminder.findOneAndUpdate(
      { _id: reminder._id, status: 'SCHEDULED', version: reminder.version },
      { $set: { status: 'ASSIGNED', assignedTaskId: taskId }, $inc: { version: 1 } },
      { session, new: true },
    );
    if (!claimed) throw stateConflict('This reminder is no longer awaiting assignment.');

    const [task] = await Task.create(
      [
        {
          _id: taskId,
          personId: reminder.personId,
          type: 'FOLLOW_UP',
          assignedTo: input.assignedTo,
          assignedBy: ctx.actorId,
          scheduledDate: input.scheduledDate ?? todayIn(settings.timezone, clock.now()),
          instructions: input.instructions ?? '',
          status: 'ASSIGNED',
          sourceReminderId: reminder._id,
          attempt: reminder.attempt,
          // The follow-up chain keeps the policy that produced this reminder (no silent drift
          // from later settings changes); the admin may override it explicitly when assigning.
          followUpPolicySnapshot: { ...plainPolicy(reminder.policy as FollowUpPolicy), ...(input.followUpPolicy ?? {}) },
        },
      ],
      { session },
    );
    await auditCtx(ctx, 'REMINDER_ASSIGNED', 'reminder', reminder._id, { taskId: String(taskId), assignedTo: input.assignedTo }, session);
    await auditCtx(ctx, 'TASK_CREATED', 'task', taskId, { type: 'FOLLOW_UP', assignedTo: input.assignedTo }, session);
    return { reminderId: String(reminder._id), taskId: String(task!._id) };
  });
}

export const snoozeBody = z
  .strictObject({
    until: z.coerce.date().optional(),
    days: z.number().int().min(1).max(365).optional(),
  })
  .refine((b) => (b.until === undefined) !== (b.days === undefined), { message: 'provide exactly one of until or days' });

export async function snoozeReminder(ctx: Ctx, id: string, input: z.infer<typeof snoozeBody>) {
  const now = clock.now();
  return withTransaction(async (session) => {
    const r = await Reminder.findById(id).session(session).lean();
    if (!r) throw notFound();
    if (r.status !== 'SCHEDULED') throw stateConflict('Only unassigned reminders can be snoozed.');
    const policy = r.policy as FollowUpPolicy;
    const dueAt = input.until ?? dueAfterDays(now, input.days!, policy.reminderTime, policy.timezone);
    if (dueAt.getTime() <= now.getTime()) throw new AppError(400, 'VALIDATION_FAILED', 'The new due time must be in the future.');
    const updated = await Reminder.findOneAndUpdate(
      { _id: r._id, status: 'SCHEDULED', version: r.version },
      { $set: { dueAt }, $inc: { version: 1 } },
      { session, new: true },
    ).lean();
    if (!updated) throw stateConflict('The reminder changed concurrently. Reload and try again.');
    await auditCtx(ctx, 'REMINDER_SNOOZED', 'reminder', r._id, { from: r.dueAt, to: dueAt }, session);
    return toReminderView(updated);
  });
}

export const dismissBody = z.strictObject({ reason: text(500, 3) });

export async function dismissReminder(ctx: Ctx, id: string, input: z.infer<typeof dismissBody>) {
  return withTransaction(async (session) => {
    const updated = await Reminder.findOneAndUpdate(
      { _id: id, status: 'SCHEDULED' },
      { $set: { status: 'DISMISSED', dismissedBy: ctx.actorId, dismissalReason: input.reason }, $inc: { version: 1 } },
      { session, new: true },
    ).lean();
    if (!updated) {
      if (!(await Reminder.exists({ _id: id }).session(session))) throw notFound();
      throw stateConflict('Only unassigned reminders can be dismissed. Cancel the follow-up task instead.');
    }
    await auditCtx(ctx, 'REMINDER_DISMISSED', 'reminder', updated._id, { reason: input.reason }, session);
    return toReminderView(updated);
  });
}

/** When a follow-up task is cancelled the admin must choose what happens to its reminder. */
export async function onFollowUpCancelled(
  ctx: Ctx,
  task: TaskDoc,
  action: 'RESCHEDULE' | 'DISMISS',
  reason: string,
  rescheduleTo: Date | undefined,
  session: ClientSession,
) {
  if (!task.sourceReminderId) return;
  const set =
    action === 'RESCHEDULE'
      ? { status: 'SCHEDULED', assignedTaskId: null, dueAt: rescheduleTo ?? clock.now() }
      : { status: 'DISMISSED', dismissedBy: ctx.actorId, dismissalReason: reason };
  await Reminder.updateOne(
    { _id: task.sourceReminderId, status: 'ASSIGNED', assignedTaskId: task._id },
    { $set: set, $inc: { version: 1 } },
    { session },
  );
  await auditCtx(ctx, action === 'RESCHEDULE' ? 'REMINDER_RESCHEDULED' : 'REMINDER_DISMISSED', 'reminder', task.sourceReminderId, { reason, viaTaskCancel: true }, session);
}

/** Dismiss open reminders when a person is archived, so they don't surface on the dashboard. */
export async function dismissRemindersForPerson(ctx: Ctx, personId: Types.ObjectId, session: ClientSession) {
  const r = await Reminder.updateMany(
    { personId, status: 'SCHEDULED' },
    { $set: { status: 'DISMISSED', dismissedBy: ctx.actorId, dismissalReason: 'Person archived' }, $inc: { version: 1 } },
    { session },
  );
  return r.modifiedCount;
}
