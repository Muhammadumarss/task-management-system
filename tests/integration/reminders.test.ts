import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { Client, createAccount, DAY, freezeClock, loginBearer, samplePerson, useTestDatabase } from '../support/helpers';
import { Reminder } from '../../src/modules/reminders/reminder.model';
import { Task } from '../../src/modules/tasks/task.model';

useTestDatabase();

let clock: ReturnType<typeof freezeClock>;
let aliceId: string;
let bobId: string;
let personId: string;

async function admin() {
  return loginBearer('ADMIN', 'boss');
}
async function alice() {
  return loginBearer('USER', 'alice');
}

beforeEach(async () => {
  clock = freezeClock(new Date('2026-11-02T06:00:00.000Z')); // 11:00 Asia/Karachi
  await createAccount('ADMIN', 'boss');
  aliceId = String((await createAccount('USER', 'alice'))._id);
  bobId = String((await createAccount('USER', 'bob'))._id);
  personId = (await (await admin()).postI('/api/v1/admin/people', samplePerson)).body.id;
});

/** Create and complete a WORK task; returns the generated reminder id. */
async function completeWork(a: Client, policy?: object) {
  const t = await a.postI('/api/v1/admin/tasks', { personId, assignedTo: aliceId, scheduledDate: '2026-11-02', ...(policy && { followUpPolicy: policy }) });
  const u = await alice();
  await u.postI(`/api/v1/tasks/${t.body.id}/complete`, {});
  const r = await Reminder.findOne({ sourceTaskId: t.body.id }).lean();
  return { taskId: t.body.id as string, reminder: r };
}

async function assignAndComplete(reminderId: string, outcome: string) {
  const a = await admin();
  const asg = await a.postI(`/api/v1/admin/reminders/${reminderId}/assign`, { assignedTo: aliceId });
  expect(asg.status).toBe(201);
  const u = await alice();
  const done = await u.postI(`/api/v1/tasks/${asg.body.taskId}/complete`, { followUpOutcome: outcome });
  expect(done.status).toBe(200);
  return asg.body.taskId as string;
}

describe('follow-up reminders', () => {
  it('due date uses local calendar days and configured local time; due list is query-based', async () => {
    const a = await admin();
    const { reminder } = await completeWork(a);
    // 30 days later at 10:00 Asia/Karachi (UTC+5) = 05:00Z.
    expect(reminder!.dueAt.toISOString()).toBe('2026-12-02T05:00:00.000Z');

    expect((await a.get('/api/v1/admin/reminders?view=due')).body.items).toHaveLength(0);
    expect((await a.get('/api/v1/admin/reminders?view=upcoming')).body.items).toHaveLength(1);

    // "Downtime": no worker runs, yet once time passes the reminder is due (and stays overdue).
    clock.set(new Date('2026-12-20T00:00:00.000Z'));
    const a2 = await admin();
    const due = await a2.get('/api/v1/admin/reminders?view=due');
    expect(due.body.items).toHaveLength(1);
    expect(due.body.items[0].isDue).toBe(true);
    expect(due.body.items[0].person.name).toBe(samplePerson.name);
    expect((await a2.get('/api/v1/admin/dashboard')).body.reminders.due).toBe(1);
  });

  it('reminders never reach users', async () => {
    const a = await admin();
    const { reminder } = await completeWork(a);
    const u = await alice();
    expect((await u.get('/api/v1/admin/reminders')).status).toBe(403);
    expect((await u.post(`/api/v1/admin/reminders/${reminder!._id}/assign`, { assignedTo: aliceId })).status).toBe(403);
    expect((await u.get('/api/v1/tasks/mine')).body.items).toHaveLength(0);
  });

  it('two admins assigning the same reminder create exactly one follow-up task', async () => {
    await createAccount('ADMIN', 'boss2');
    const a = await admin();
    const b = await loginBearer('ADMIN', 'boss2');
    const { reminder } = await completeWork(a);
    const id = String(reminder!._id);
    const [r1, r2] = await Promise.all([
      a.postI(`/api/v1/admin/reminders/${id}/assign`, { assignedTo: aliceId }),
      b.postI(`/api/v1/admin/reminders/${id}/assign`, { assignedTo: bobId }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await Task.countDocuments({ sourceReminderId: id })).toBe(1);
    expect((await Reminder.findById(id).lean())!.status).toBe('ASSIGNED');
  });

  it('assignment is idempotent per key', async () => {
    const a = await admin();
    const { reminder } = await completeWork(a);
    const key = randomUUID();
    const r1 = await a.post(`/api/v1/admin/reminders/${reminder!._id}/assign`, { assignedTo: aliceId }, { 'Idempotency-Key': key });
    const r2 = await a.post(`/api/v1/admin/reminders/${reminder!._id}/assign`, { assignedTo: aliceId }, { 'Idempotency-Key': key });
    expect(r1.status).toBe(201);
    expect(r2.body.taskId).toBe(r1.body.taskId);
  });

  it('follow-up task requires an outcome; NEEDS_WORK resolves and surfaces to admin', async () => {
    const a = await admin();
    const { reminder } = await completeWork(a);
    const asg = await a.postI(`/api/v1/admin/reminders/${reminder!._id}/assign`, { assignedTo: aliceId });
    const u = await alice();
    expect((await u.postI(`/api/v1/tasks/${asg.body.taskId}/complete`, {})).status).toBe(400);
    expect((await u.postI(`/api/v1/tasks/${asg.body.taskId}/complete`, { followUpOutcome: 'NEEDS_WORK' })).status).toBe(200);
    expect((await Reminder.findById(reminder!._id).lean())!.status).toBe('RESOLVED');
    const dash = await a.get('/api/v1/admin/dashboard');
    expect(dash.body.attention.needsWorkOutcomes).toHaveLength(1);
    // Admin answers with a distinct WORK task; the outcome is then marked reviewed.
    await a.postI('/api/v1/admin/tasks', { personId, assignedTo: aliceId, scheduledDate: '2026-11-05', fromFollowUpTaskId: asg.body.taskId });
    expect((await a.get('/api/v1/admin/dashboard')).body.attention.needsWorkOutcomes).toHaveLength(0);
  });

  it('NO_WORK_NEEDED schedules a repeat only when the repeat policy is enabled', async () => {
    const a = await admin();
    const first = await completeWork(a);
    const ft = await assignAndComplete(String(first.reminder!._id), 'NO_WORK_NEEDED');
    expect(await Reminder.countDocuments({ sourceTaskId: ft })).toBe(0);

    const second = await completeWork(a, { repeatFollowUps: true });
    const ft2 = await assignAndComplete(String(second.reminder!._id), 'NO_WORK_NEEDED');
    const repeat = await Reminder.findOne({ sourceTaskId: ft2 }).lean();
    expect(repeat?.reason).toBe('REPEAT');
  });

  it('UNREACHABLE retries per policy and stops after the maximum attempts', async () => {
    const a = await admin();
    // The per-task override on the WORK task carries through the whole follow-up chain.
    const { reminder } = await completeWork(a, { unreachableRetryDays: 2, maxUnreachableAttempts: 2 });

    const ft1 = await assignAndComplete(String(reminder!._id), 'UNREACHABLE');
    const retry = await Reminder.findOne({ sourceTaskId: ft1 }).lean();
    expect(retry!.reason).toBe('UNREACHABLE_RETRY');
    expect(retry!.attempt).toBe(2);
    expect(retry!.dueAt.toISOString()).toBe('2026-11-04T05:00:00.000Z');

    const ft2 = await assignAndComplete(String(retry!._id), 'UNREACHABLE');
    expect(await Reminder.countDocuments({ sourceTaskId: ft2 })).toBe(0); // no endless cycle
  });

  it('settings changes do not rewrite existing tasks or reminders', async () => {
    const a = await admin();
    const t = await a.postI('/api/v1/admin/tasks', { personId, assignedTo: aliceId, scheduledDate: '2026-11-02' });
    const s = (await a.get('/api/v1/admin/settings')).body;
    const upd = await a.patch('/api/v1/admin/settings', { version: s.version, followUp: { intervalDays: 7 } });
    expect(upd.status).toBe(200);
    expect((await a.patch('/api/v1/admin/settings', { version: s.version, followUp: { intervalDays: 9 } })).status).toBe(409);
    const u = await alice();
    await u.postI(`/api/v1/tasks/${t.body.id}/complete`, {});
    const r = await Reminder.findOne({ sourceTaskId: t.body.id }).lean();
    expect(r!.dueAt.toISOString()).toBe('2026-12-02T05:00:00.000Z'); // still the 30-day snapshot
  });

  it('disabled follow-ups create no reminder', async () => {
    const a = await admin();
    const { reminder } = await completeWork(a, { enabled: false });
    expect(reminder).toBeNull();
  });

  it('snooze, dismiss and cancel-with-reschedule', async () => {
    const a = await admin();
    const { reminder } = await completeWork(a);
    const id = String(reminder!._id);
    const snoozed = await a.post(`/api/v1/admin/reminders/${id}/snooze`, { days: 3 });
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.dueAt).toBe('2026-11-05T05:00:00.000Z');
    expect((await a.post(`/api/v1/admin/reminders/${id}/dismiss`, {})).status).toBe(400); // reason required

    const asg = await a.postI(`/api/v1/admin/reminders/${id}/assign`, { assignedTo: aliceId });
    expect((await a.post(`/api/v1/admin/reminders/${id}/dismiss`, { reason: 'not needed' })).status).toBe(409);
    expect((await a.post(`/api/v1/admin/tasks/${asg.body.taskId}/cancel`, { reason: 'wrong person' })).status).toBe(400);
    const cancel = await a.post(`/api/v1/admin/tasks/${asg.body.taskId}/cancel`, { reason: 'wrong person', reminderAction: 'RESCHEDULE' });
    expect(cancel.status).toBe(200);
    expect((await Reminder.findById(id).lean())!.status).toBe('SCHEDULED');
    // Can be assigned again (partial unique index only covers open tasks).
    const again = await a.postI(`/api/v1/admin/reminders/${id}/assign`, { assignedTo: bobId });
    expect(again.status).toBe(201);
    const cancel2 = await a.post(`/api/v1/admin/tasks/${again.body.taskId}/cancel`, { reason: 'no longer needed', reminderAction: 'DISMISS' });
    expect(cancel2.status).toBe(200);
    expect((await Reminder.findById(id).lean())!.status).toBe('DISMISSED');
    clock.advance(DAY);
  });
});
