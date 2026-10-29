import { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { AppError, notFound, stateConflict, versionConflict } from '../../common/errors';
import { clock } from '../../common/clock';
import { todayIn } from '../../common/dates';
import { withTransaction } from '../../common/transaction';
import { dateOnly, objectId, text } from '../../common/validation';
import { pageMeta, paginationQuery, skip, sortParam } from '../../common/pagination';
import type { Ctx } from '../../common/context';
import { Task, TaskDoc, FOLLOW_UP_OUTCOMES } from './task.model';
import { Person } from '../people/person.model';
import { Reminder } from '../reminders/reminder.model';
import { auditCtx } from '../audit/audit.service';
import { getSettings } from '../settings/settings.service';
import { effectivePolicy, FollowUpPolicy, policyOverride } from '../reminders/policy';
import {
  assertAssignableUser,
  lockActivePerson,
  onFollowUpCancelled,
  onTaskCompleted,
  toReminderView,
} from '../reminders/reminders.service';

// ---------- Views ----------

type PersonSlice = { _id: Types.ObjectId; name: string; phoneOriginal: string; requestedWorkDate: string; location?: unknown };

/**
 * Assignee view: task-scoped customer access only (name, phone, work date, location).
 * No customer history, duplicates or other admin-only details.
 */
function toAssigneeView(t: TaskDoc, p: PersonSlice | null) {
  return {
    id: String(t._id),
    type: t.type,
    status: t.status,
    scheduledDate: t.scheduledDate,
    instructions: t.instructions,
    person: p
      ? { name: p.name, phone: p.phoneOriginal, requestedWorkDate: p.requestedWorkDate, location: p.location ?? null }
      : null,
    requiresOutcome: t.type === 'FOLLOW_UP',
    version: t.version,
  };
}

export function toAdminTaskView(t: TaskDoc) {
  return {
    id: String(t._id),
    personId: String(t.personId),
    type: t.type,
    status: t.status,
    assignedTo: String(t.assignedTo),
    assignedBy: String(t.assignedBy),
    scheduledDate: t.scheduledDate,
    instructions: t.instructions,
    sourceReminderId: t.sourceReminderId ? String(t.sourceReminderId) : null,
    attempt: t.attempt,
    completedAt: t.completedAt,
    completedBy: t.completedBy ? String(t.completedBy) : null,
    completionNotes: t.completionNotes,
    followUpOutcome: t.followUpOutcome,
    adminOverrideReason: t.adminOverrideReason,
    outcomeReviewedAt: t.outcomeReviewedAt,
    cancelledAt: t.cancelledAt,
    cancellationReason: t.cancellationReason,
    needsReassignment: t.needsReassignment,
    followUpPolicySnapshot: t.followUpPolicySnapshot,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    version: t.version,
  };
}

function receipt(t: Pick<TaskDoc, '_id' | 'status' | 'completedAt'>) {
  return { taskId: String(t._id), status: t.status, completedAt: t.completedAt };
}

const PERSON_SLICE = { name: 1, phoneOriginal: 1, requestedWorkDate: 1, location: 1 } as const;

// ---------- Admin: create ----------

export const createTaskBody = z.strictObject({
  personId: objectId,
  assignedTo: objectId,
  scheduledDate: dateOnly,
  instructions: text(2000).optional(),
  followUpPolicy: policyOverride.optional(),
  /** When this WORK task answers a NEEDS_WORK follow-up outcome, mark that outcome reviewed. */
  fromFollowUpTaskId: objectId.optional(),
});

export async function createTask(ctx: Ctx, input: z.infer<typeof createTaskBody>) {
  const settings = await getSettings();
  return withTransaction(async (session) => {
    await assertAssignableUser(input.assignedTo, session);
    await lockActivePerson(input.personId, session);
    const [task] = await Task.create(
      [
        {
          personId: input.personId,
          type: 'WORK',
          assignedTo: input.assignedTo,
          assignedBy: ctx.actorId,
          scheduledDate: input.scheduledDate,
          instructions: input.instructions ?? '',
          status: 'ASSIGNED',
          followUpPolicySnapshot: effectivePolicy(settings, input.followUpPolicy),
        },
      ],
      { session },
    );
    if (input.fromFollowUpTaskId) {
      await Task.updateOne(
        { _id: input.fromFollowUpTaskId, personId: input.personId, followUpOutcome: 'NEEDS_WORK', outcomeReviewedAt: null },
        { $set: { outcomeReviewedAt: clock.now() } },
        { session },
      );
    }
    await auditCtx(ctx, 'TASK_CREATED', 'task', task!._id, { type: 'WORK', assignedTo: input.assignedTo }, session);
    const warnings = input.scheduledDate < todayIn(settings.timezone, clock.now()) ? ['SCHEDULED_DATE_IN_PAST'] : [];
    return { task: task!.toObject() as TaskDoc, warnings };
  });
}

// ---------- Assignee (USER) ----------

export async function listMine(ctx: Ctx) {
  const tasks = await Task.find({ assignedTo: ctx.actorId, status: 'ASSIGNED' })
    .sort({ scheduledDate: 1, createdAt: 1 })
    .limit(200)
    .lean();
  const people = await Person.find({ _id: { $in: tasks.map((t) => t.personId) } }, PERSON_SLICE).lean();
  const byId = new Map(people.map((p) => [String(p._id), p as PersonSlice]));
  return { items: tasks.map((t) => toAssigneeView(t, byId.get(String(t.personId)) ?? null)) };
}

export async function getMine(ctx: Ctx, id: string) {
  const t = await Task.findOne({ _id: id, assignedTo: ctx.actorId, status: 'ASSIGNED' }).lean();
  if (!t) throw notFound();
  const p = await Person.findById(t.personId, PERSON_SLICE).lean();
  return toAssigneeView(t, p as PersonSlice | null);
}

export const completeBody = z.strictObject({
  completionNotes: text(2000).optional(),
  followUpOutcome: z.enum(FOLLOW_UP_OUTCOMES).optional(),
});

export const adminCompleteBody = completeBody.extend({ reason: text(500, 3) });

/**
 * Completion transaction: conditional ASSIGNED→COMPLETED transition (version-checked so a
 * concurrent reassignment makes exactly one of them win), reminder per policy snapshot,
 * and audit — all committed together.
 */
async function completeCore(
  ctx: Ctx,
  t: TaskDoc,
  input: z.infer<typeof completeBody>,
  overrideReason: string | null,
  session: ClientSession,
) {
  if (t.type === 'FOLLOW_UP' && !input.followUpOutcome) {
    throw new AppError(400, 'VALIDATION_FAILED', 'A follow-up outcome is required.');
  }
  if (t.type === 'WORK' && input.followUpOutcome) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Work tasks do not take a follow-up outcome.');
  }
  const now = clock.now();
  const updated = await Task.findOneAndUpdate(
    { _id: t._id, status: 'ASSIGNED', assignedTo: t.assignedTo, version: t.version },
    {
      $set: {
        status: 'COMPLETED',
        completedAt: now,
        completedBy: ctx.actorId,
        completionNotes: input.completionNotes ?? null,
        followUpOutcome: input.followUpOutcome ?? null,
        adminOverrideReason: overrideReason,
        needsReassignment: false,
      },
      $inc: { version: 1 },
    },
    { new: true, session },
  ).lean();
  if (!updated) return null;
  const reminder = await onTaskCompleted(updated as TaskDoc, now, session);
  await auditCtx(
    ctx,
    overrideReason ? 'TASK_COMPLETED_BY_ADMIN' : 'TASK_COMPLETED',
    'task',
    t._id,
    { type: t.type, outcome: input.followUpOutcome ?? null, reminderId: reminder ? String(reminder._id) : null, ...(overrideReason && { reason: overrideReason }) },
    session,
  );
  return { task: updated as TaskDoc, reminder };
}

export async function completeMine(ctx: Ctx, id: string, input: z.infer<typeof completeBody>) {
  return withTransaction(async (session) => {
    const t = await Task.findOne({ _id: id, assignedTo: ctx.actorId }).session(session).lean();
    if (!t || t.status === 'CANCELLED') throw notFound();
    // Repeated authorized completion: safe receipt, no customer data, no second reminder.
    if (t.status === 'COMPLETED') {
      if (String(t.completedBy) === String(ctx.actorId)) return receipt(t);
      throw notFound();
    }
    const done = await completeCore(ctx, t, input, null, session);
    if (!done) throw stateConflict('This task was changed (for example reassigned). Reload your tasks.');
    return receipt(done.task);
  });
}

// ---------- Admin: list / detail / update ----------

export const adminListQuery = paginationQuery.extend({
  status: z.enum(['ASSIGNED', 'COMPLETED', 'CANCELLED']).optional(),
  type: z.enum(['WORK', 'FOLLOW_UP']).optional(),
  assignedTo: objectId.optional(),
  personId: objectId.optional(),
  needsReassignment: z.enum(['true', 'false']).optional(),
  followUpOutcome: z.enum(FOLLOW_UP_OUTCOMES).optional(),
  scheduledFrom: dateOnly.optional(),
  scheduledTo: dateOnly.optional(),
  overdue: z.enum(['true']).optional(),
  sort: sortParam(['scheduledDate', 'createdAt', 'completedAt'] as const, '-createdAt'),
});

export async function adminList(q: z.infer<typeof adminListQuery>) {
  const filter: Record<string, unknown> = {};
  for (const k of ['status', 'type', 'assignedTo', 'personId', 'followUpOutcome'] as const) if (q[k]) filter[k] = q[k];
  if (q.needsReassignment) filter.needsReassignment = q.needsReassignment === 'true';
  const range: Record<string, string> = {};
  if (q.scheduledFrom) range.$gte = q.scheduledFrom;
  if (q.scheduledTo) range.$lte = q.scheduledTo;
  if (q.overdue) {
    const settings = await getSettings();
    filter.status = 'ASSIGNED';
    range.$lt = todayIn(settings.timezone, clock.now());
  }
  if (Object.keys(range).length) filter.scheduledDate = range;
  const [items, total] = await Promise.all([
    Task.find(filter).sort(q.sort).skip(skip(q)).limit(q.limit).lean(),
    Task.countDocuments(filter),
  ]);
  return { items: items.map((t) => toAdminTaskView(t)), ...pageMeta(q, total) };
}

export async function adminGet(id: string) {
  const t = await Task.findById(id).lean();
  if (!t) throw notFound();
  const [person, reminder] = await Promise.all([
    Person.findById(t.personId, { ...PERSON_SLICE, status: 1 }).lean(),
    Reminder.findOne({ sourceTaskId: t._id }).lean(),
  ]);
  return {
    ...toAdminTaskView(t),
    person: person
      ? { id: String(person._id), name: person.name, phone: person.phoneOriginal, status: person.status }
      : null,
    generatedReminder: reminder ? toReminderView(reminder) : null,
  };
}

export const updateTaskBody = z
  .strictObject({
    version: z.number().int().nonnegative(),
    scheduledDate: dateOnly.optional(),
    instructions: text(2000).optional(),
    followUpPolicy: policyOverride.optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'version'), { message: 'no fields to update' });

/** Update an open task. Policy changes are explicit and only affect this task's snapshot. */
export async function adminUpdate(ctx: Ctx, id: string, input: z.infer<typeof updateTaskBody>) {
  return withTransaction(async (session) => {
    const t = await Task.findById(id).session(session).lean();
    if (!t) throw notFound();
    if (t.status !== 'ASSIGNED') throw stateConflict('Only open tasks can be edited. Create a new task instead.');
    const set: Record<string, unknown> = {};
    if (input.scheduledDate) set.scheduledDate = input.scheduledDate;
    if (input.instructions !== undefined) set.instructions = input.instructions;
    if (input.followUpPolicy) {
      set.followUpPolicySnapshot = { ...(t.followUpPolicySnapshot as FollowUpPolicy), ...input.followUpPolicy };
    }
    const updated = await Task.findOneAndUpdate(
      { _id: t._id, status: 'ASSIGNED', version: input.version },
      { $set: set, $inc: { version: 1 } },
      { new: true, session },
    ).lean();
    if (!updated) throw versionConflict();
    await auditCtx(ctx, 'TASK_UPDATED', 'task', t._id, { fields: Object.keys(set) }, session);
    return toAdminTaskView(updated as TaskDoc);
  });
}

export const reassignBody = z.strictObject({ assignedTo: objectId, version: z.number().int().nonnegative() });

/** Atomic reassignment; the previous assignee loses access immediately. */
export async function reassign(ctx: Ctx, id: string, input: z.infer<typeof reassignBody>) {
  return withTransaction(async (session) => {
    await assertAssignableUser(input.assignedTo, session);
    const t = await Task.findById(id).session(session).lean();
    if (!t) throw notFound();
    if (t.status !== 'ASSIGNED') throw stateConflict('Only open tasks can be reassigned.');
    const updated = await Task.findOneAndUpdate(
      { _id: t._id, status: 'ASSIGNED', version: input.version },
      { $set: { assignedTo: input.assignedTo, needsReassignment: false }, $inc: { version: 1 } },
      { new: true, session },
    ).lean();
    if (!updated) throw versionConflict();
    await auditCtx(ctx, 'TASK_REASSIGNED', 'task', t._id, { from: String(t.assignedTo), to: input.assignedTo }, session);
    return toAdminTaskView(updated as TaskDoc);
  });
}

export const cancelBody = z.strictObject({
  reason: text(500, 3),
  version: z.number().int().nonnegative().optional(),
  /** Required for follow-up tasks: return the reminder to SCHEDULED or dismiss it. */
  reminderAction: z.enum(['RESCHEDULE', 'DISMISS']).optional(),
  rescheduleTo: z.coerce.date().optional(),
});

export async function cancelTask(ctx: Ctx, id: string, input: z.infer<typeof cancelBody>) {
  return withTransaction(async (session) => {
    const t = await Task.findById(id).session(session).lean();
    if (!t) throw notFound();
    if (t.status !== 'ASSIGNED') throw stateConflict('Only open tasks can be cancelled.');
    if (t.sourceReminderId && !input.reminderAction) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose whether to reschedule or dismiss the follow-up reminder.', [
        { path: 'reminderAction', message: 'required for follow-up tasks' },
      ]);
    }
    const updated = await Task.findOneAndUpdate(
      { _id: t._id, status: 'ASSIGNED', version: input.version ?? t.version },
      {
        $set: { status: 'CANCELLED', cancelledAt: clock.now(), cancelledBy: ctx.actorId, cancellationReason: input.reason, needsReassignment: false },
        $inc: { version: 1 },
      },
      { new: true, session },
    ).lean();
    if (!updated) throw versionConflict();
    if (t.sourceReminderId) {
      await onFollowUpCancelled(ctx, t, input.reminderAction!, input.reason, input.rescheduleTo, session);
    }
    await auditCtx(ctx, 'TASK_CANCELLED', 'task', t._id, { reason: input.reason, reminderAction: input.reminderAction ?? null }, session);
    return toAdminTaskView(updated as TaskDoc);
  });
}

/** Audited admin override: completes on the assignee's behalf with a mandatory reason. */
export async function adminComplete(ctx: Ctx, id: string, input: z.infer<typeof adminCompleteBody>) {
  const { reason, ...rest } = input;
  return withTransaction(async (session) => {
    const t = await Task.findById(id).session(session).lean();
    if (!t) throw notFound();
    if (t.status === 'COMPLETED') return receipt(t);
    if (t.status !== 'ASSIGNED') throw stateConflict('Only open tasks can be completed.');
    const done = await completeCore(ctx, t, rest, reason, session);
    if (!done) throw stateConflict('The task changed concurrently. Reload and try again.');
    return receipt(done.task);
  });
}

export async function receiptFor(taskId: string) {
  const t = await Task.findById(taskId, { status: 1, completedAt: 1 }).lean();
  return t ? receipt(t as TaskDoc) : { taskId, status: 'UNKNOWN', completedAt: null };
}
