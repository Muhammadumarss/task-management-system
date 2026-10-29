import { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { AppError, notFound, stateConflict, versionConflict } from '../../common/errors';
import { clock } from '../../common/clock';
import { withTransaction } from '../../common/transaction';
import { escapeRegex } from '../../common/validation';
import { normalizePhone } from '../../common/phone';
import { pageMeta, skip } from '../../common/pagination';
import type { Ctx } from '../../common/context';
import { CORRECTION_WINDOW_MS } from '../../config';
import { Person, PersonDoc } from './person.model';
import { adminListQuery, CreatePersonInput, UpdatePersonInput } from './people.validation';
import { auditCtx } from '../audit/audit.service';
import { Task } from '../tasks/task.model';
import { Reminder } from '../reminders/reminder.model';
import { dismissRemindersForPerson } from '../reminders/reminders.service';

type PersonLean = PersonDoc;

function locationView(l: PersonLean['location']) {
  if (!l) return null;
  return {
    addressText: l.addressText ?? null,
    latitude: l.latitude ?? null,
    longitude: l.longitude ?? null,
  };
}

/** What the submitting user may see: their own fields plus the server deadline. Nothing admin-only. */
export function toCreatorView(p: PersonLean) {
  return {
    id: String(p._id),
    name: p.name,
    phone: p.phoneOriginal,
    requestedWorkDate: p.requestedWorkDate,
    location: locationView(p.location),
    editableUntil: p.editableUntil,
    serverTime: clock.now(),
    version: p.version,
  };
}

export function toAdminView(p: PersonLean) {
  return {
    id: String(p._id),
    name: p.name,
    phone: p.phoneOriginal,
    phoneNormalized: p.phoneNormalized,
    requestedWorkDate: p.requestedWorkDate,
    location: locationView(p.location),
    createdBy: String(p.createdBy),
    creatorRole: p.creatorRole,
    editableUntil: p.editableUntil,
    status: p.status,
    possibleDuplicate: p.possibleDuplicate,
    archivedAt: p.archivedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    version: p.version,
  };
}

function toLocation(l: CreatePersonInput['location'] | null | undefined) {
  if (!l) return null;
  return { addressText: l.addressText ?? null, latitude: l.latitude ?? null, longitude: l.longitude ?? null };
}

/** Flag records sharing a phone number for admin review. Never surfaced to the submitter. */
async function flagDuplicates(personId: Types.ObjectId, phoneNormalized: string, session: ClientSession) {
  const others = await Person.find({ phoneNormalized, _id: { $ne: personId } }, { _id: 1 })
    .limit(50)
    .session(session)
    .lean();
  if (others.length === 0) return false;
  await Person.updateMany(
    { _id: { $in: [personId, ...others.map((o) => o._id)] }, possibleDuplicate: false },
    { $set: { possibleDuplicate: true } },
    { session },
  );
  return true;
}

export async function createPerson(ctx: Ctx, input: CreatePersonInput) {
  return withTransaction(async (session) => {
    const now = clock.now();
    const [p] = await Person.create(
      [
        {
          name: input.name,
          phoneOriginal: input.phone.original,
          phoneNormalized: input.phone.normalized,
          requestedWorkDate: input.requestedWorkDate,
          location: toLocation(input.location),
          createdBy: ctx.actorId,
          creatorRole: ctx.actorRole,
          editableUntil: new Date(now.getTime() + CORRECTION_WINDOW_MS),
          status: 'ACTIVE',
        },
      ],
      { session },
    );
    const dup = await flagDuplicates(p!._id, input.phone.normalized, session);
    await auditCtx(ctx, 'PERSON_CREATED', 'person', p!._id, { possibleDuplicate: dup }, session);
    const fresh = await Person.findById(p!._id).session(session).lean();
    return fresh!;
  });
}

// ---------- Creator (USER) access: own records within the correction window only ----------

function creatorFilter(ctx: Ctx, id: string | Types.ObjectId, now: Date) {
  return { _id: id, createdBy: ctx.actorId, status: 'ACTIVE', editableUntil: { $gt: now } };
}

export async function listRecentForCreator(ctx: Ctx) {
  const now = clock.now();
  const items = await Person.find({ createdBy: ctx.actorId, status: 'ACTIVE', editableUntil: { $gt: now } })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return { items: items.map(toCreatorView), serverTime: now };
}

export async function getForCreator(ctx: Ctx, id: string) {
  const p = await Person.findOne(creatorFilter(ctx, id, clock.now())).lean();
  if (!p) throw notFound();
  return toCreatorView(p);
}

function buildSet(input: Omit<UpdatePersonInput, 'version'>) {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.phone !== undefined) {
    set.phoneOriginal = input.phone.original;
    set.phoneNormalized = input.phone.normalized;
  }
  if (input.requestedWorkDate !== undefined) set.requestedWorkDate = input.requestedWorkDate;
  if (input.location !== undefined) set.location = toLocation(input.location);
  return set;
}

/**
 * Creator edit. A single conditional update requires: matching id, creator, ACTIVE,
 * current version and editableUntil > server now. Editing never extends editableUntil.
 */
export async function updateForCreator(ctx: Ctx, id: string, input: UpdatePersonInput) {
  const { version, ...fields } = input;
  const set = buildSet(fields);
  return withTransaction(async (session) => {
    const now = clock.now();
    const updated = await Person.findOneAndUpdate(
      { ...creatorFilter(ctx, id, now), version },
      { $set: set, $inc: { version: 1 } },
      { new: true, session, lean: true },
    );
    if (!updated) {
      // Explain the failure only to the creator; everyone else gets the uniform 404.
      const own = await Person.findOne({ _id: id, createdBy: ctx.actorId, status: 'ACTIVE' }).session(session).lean();
      if (!own) throw notFound();
      if (own.editableUntil.getTime() <= now.getTime()) {
        throw new AppError(409, 'EDIT_WINDOW_EXPIRED', 'The correction period has ended.');
      }
      throw versionConflict();
    }
    if (input.phone) await flagDuplicates(updated._id, input.phone.normalized, session);
    await auditCtx(ctx, 'PERSON_UPDATED', 'person', updated._id, { fields: Object.keys(set), by: 'creator' }, session);
    return toCreatorView(updated as PersonLean);
  });
}

// ---------- Admin access ----------

export async function adminList(q: z.infer<typeof adminListQuery>) {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.possibleDuplicate) filter.possibleDuplicate = q.possibleDuplicate === 'true';
  if (q.createdBy) filter.createdBy = q.createdBy;
  if (q.workDateFrom || q.workDateTo) {
    filter.requestedWorkDate = { ...(q.workDateFrom && { $gte: q.workDateFrom }), ...(q.workDateTo && { $lte: q.workDateTo }) };
  }
  if (q.search) {
    const phone = /\d{5,}/.test(q.search) ? normalizePhone(q.search) : null;
    filter.$or = [
      { name: new RegExp(escapeRegex(q.search), 'i') },
      ...(phone ? [{ phoneNormalized: phone }] : []),
    ];
  }
  const [items, total] = await Promise.all([
    Person.find(filter).sort(q.sort).skip(skip(q)).limit(q.limit).lean(),
    Person.countDocuments(filter),
  ]);
  return { items: items.map((p) => toAdminView(p)), ...pageMeta(q, total) };
}

export async function adminGet(id: string) {
  const p = await Person.findById(id).lean();
  if (!p) throw notFound();
  const [tasks, reminders, duplicates] = await Promise.all([
    Task.find({ personId: p._id }).sort({ createdAt: -1 }).limit(100).lean(),
    Reminder.find({ personId: p._id }).sort({ createdAt: -1 }).limit(100).lean(),
    p.possibleDuplicate
      ? Person.find({ phoneNormalized: p.phoneNormalized, _id: { $ne: p._id } }, { name: 1, status: 1, createdAt: 1 }).limit(20).lean()
      : Promise.resolve([]),
  ]);
  return {
    ...toAdminView(p),
    tasks: tasks.map((t) => ({
      id: String(t._id),
      type: t.type,
      status: t.status,
      assignedTo: String(t.assignedTo),
      scheduledDate: t.scheduledDate,
      completedAt: t.completedAt,
      followUpOutcome: t.followUpOutcome,
    })),
    reminders: reminders.map((r) => ({
      id: String(r._id),
      status: r.status,
      dueAt: r.dueAt,
      reason: r.reason,
      assignedTaskId: r.assignedTaskId ? String(r.assignedTaskId) : null,
    })),
    possibleDuplicates: duplicates.map((d) => ({ id: String(d._id), name: d.name, status: d.status, createdAt: d.createdAt })),
  };
}

export async function adminUpdate(ctx: Ctx, id: string, input: UpdatePersonInput) {
  const { version, ...fields } = input;
  const set = buildSet(fields);
  return withTransaction(async (session) => {
    const updated = await Person.findOneAndUpdate(
      { _id: id, version },
      { $set: set, $inc: { version: 1 } },
      { new: true, session, lean: true },
    );
    if (!updated) {
      if (await Person.exists({ _id: id }).session(session)) throw versionConflict();
      throw notFound();
    }
    if (input.phone) await flagDuplicates(updated._id, input.phone.normalized, session);
    await auditCtx(ctx, 'PERSON_UPDATED', 'person', updated._id, { fields: Object.keys(set), by: 'admin' }, session);
    return toAdminView(updated as PersonLean);
  });
}

/** Archive is blocked while the person has open tasks. */
export async function archivePerson(ctx: Ctx, id: string) {
  return withTransaction(async (session) => {
    const p = await Person.findById(id).session(session).lean();
    if (!p) throw notFound();
    if (p.status === 'ARCHIVED') return toAdminView(p);
    const open = await Task.countDocuments({ personId: p._id, status: 'ASSIGNED' }).session(session);
    if (open > 0) {
      throw new AppError(409, 'ACTIVE_TASKS_EXIST', 'Complete or cancel this person’s open tasks before archiving.', {
        openTasks: open,
      });
    }
    // Writing the person doc makes a concurrent task-creation transaction conflict.
    const updated = await Person.findOneAndUpdate(
      { _id: p._id, status: 'ACTIVE' },
      { $set: { status: 'ARCHIVED', archivedAt: clock.now() }, $inc: { version: 1 } },
      { new: true, session, lean: true },
    );
    if (!updated) throw stateConflict('The record changed concurrently. Reload and try again.');
    const remindersDismissed = await dismissRemindersForPerson(ctx, p._id, session);
    await auditCtx(ctx, 'PERSON_ARCHIVED', 'person', p._id, { remindersDismissed }, session);
    return toAdminView(updated as PersonLean);
  });
}

export async function restorePerson(ctx: Ctx, id: string) {
  return withTransaction(async (session) => {
    const updated = await Person.findOneAndUpdate(
      { _id: id, status: 'ARCHIVED' },
      { $set: { status: 'ACTIVE', archivedAt: null }, $inc: { version: 1 } },
      { new: true, session, lean: true },
    );
    if (!updated) {
      const p = await Person.findById(id).session(session).lean();
      if (!p) throw notFound();
      return toAdminView(p);
    }
    await auditCtx(ctx, 'PERSON_RESTORED', 'person', updated._id, undefined, session);
    return toAdminView(updated as PersonLean);
  });
}
