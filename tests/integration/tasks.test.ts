import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { Client, createAccount, freezeClock, loginBearer, samplePerson, useTestDatabase } from '../support/helpers';
import { Reminder } from '../../src/modules/reminders/reminder.model';
import { Task } from '../../src/modules/tasks/task.model';

useTestDatabase();

let admin: Client;
let alice: Client;
let bob: Client;
let aliceId: string;
let bobId: string;
let personId: string;

beforeEach(async () => {
  freezeClock();
  await createAccount('ADMIN', 'boss');
  aliceId = String((await createAccount('USER', 'alice'))._id);
  bobId = String((await createAccount('USER', 'bob'))._id);
  admin = await loginBearer('ADMIN', 'boss');
  alice = await loginBearer('USER', 'alice');
  bob = await loginBearer('USER', 'bob');
  personId = (await admin.postI('/api/v1/admin/people', samplePerson)).body.id;
});

async function assign(to: string, extra: object = {}) {
  const r = await admin.postI('/api/v1/admin/tasks', { personId, assignedTo: to, scheduledDate: '2026-11-10', instructions: 'Fix the pump', ...extra });
  expect(r.status).toBe(201);
  return r.body;
}

describe('task assignment and completion', () => {
  it('assignee sees only their own active tasks with task-scoped customer details', async () => {
    const t = await assign(aliceId);
    const mine = await alice.get('/api/v1/tasks/mine');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].person).toMatchObject({ name: samplePerson.name, phone: samplePerson.phone });
    expect(mine.body.items[0].person.possibleDuplicate).toBeUndefined();
    expect((await bob.get('/api/v1/tasks/mine')).body.items).toHaveLength(0);
    expect((await bob.get(`/api/v1/tasks/${t.id}`)).status).toBe(404);
    // Customer record itself is not browsable by the assignee.
    expect((await alice.get(`/api/v1/people/${personId}`)).status).toBe(404);
  });

  it('completion removes the task, creates exactly one reminder, and repeats return a safe receipt', async () => {
    const t = await assign(aliceId);
    const key = randomUUID();
    const done = await alice.post(`/api/v1/tasks/${t.id}/complete`, { completionNotes: 'Done' }, { 'Idempotency-Key': key });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ taskId: t.id, status: 'COMPLETED' });
    expect(done.body.person).toBeUndefined();

    expect((await alice.get('/api/v1/tasks/mine')).body.items).toHaveLength(0);
    expect((await alice.get(`/api/v1/tasks/${t.id}`)).status).toBe(404);

    const replay = await alice.post(`/api/v1/tasks/${t.id}/complete`, { completionNotes: 'Done' }, { 'Idempotency-Key': key });
    expect(replay.body).toMatchObject({ taskId: t.id, status: 'COMPLETED' });
    const again = await alice.postI(`/api/v1/tasks/${t.id}/complete`, {});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('COMPLETED');
    expect(await Reminder.countDocuments({ sourceTaskId: t.id })).toBe(1);

    const history = await admin.get(`/api/v1/admin/tasks?status=COMPLETED`);
    expect(history.body.items).toHaveLength(1);
  });

  it('reassignment immediately removes access from the previous assignee', async () => {
    const t = await assign(aliceId);
    const r = await admin.post(`/api/v1/admin/tasks/${t.id}/reassign`, { assignedTo: bobId, version: 0 });
    expect(r.status).toBe(200);
    expect((await alice.get(`/api/v1/tasks/${t.id}`)).status).toBe(404);
    expect((await alice.postI(`/api/v1/tasks/${t.id}/complete`, {})).status).toBe(404);
    expect((await bob.get(`/api/v1/tasks/${t.id}`)).status).toBe(200);
  });

  it('completion racing reassignment: exactly one transition wins', async () => {
    const t = await assign(aliceId);
    const [c, r] = await Promise.all([
      alice.postI(`/api/v1/tasks/${t.id}/complete`, {}),
      admin.post(`/api/v1/admin/tasks/${t.id}/reassign`, { assignedTo: bobId, version: 0 }),
    ]);
    const wins = [c.status === 200 && c.body.status === 'COMPLETED', r.status === 200].filter(Boolean).length;
    expect(wins).toBe(1);
    const final = await Task.findById(t.id).lean();
    if (r.status === 200) expect(final!.status).toBe('ASSIGNED');
    else expect(final!.status).toBe('COMPLETED');
    expect(await Reminder.countDocuments()).toBe(final!.status === 'COMPLETED' ? 1 : 0);
  });

  it('admin override completion requires a reason and is audited', async () => {
    const t = await assign(aliceId);
    expect((await admin.post(`/api/v1/admin/tasks/${t.id}/complete`, {})).status).toBe(400);
    const ok = await admin.post(`/api/v1/admin/tasks/${t.id}/complete`, { reason: 'Customer confirmed by phone' });
    expect(ok.status).toBe(200);
    const audit = await admin.get(`/api/v1/admin/audit-logs?action=TASK_COMPLETED_BY_ADMIN`);
    expect(audit.body.items).toHaveLength(1);
  });

  it('cancel removes the task from the assignee; completed tasks cannot be edited or reopened', async () => {
    const t = await assign(aliceId);
    expect((await admin.post(`/api/v1/admin/tasks/${t.id}/cancel`, { reason: 'Customer cancelled' })).status).toBe(200);
    expect((await alice.get('/api/v1/tasks/mine')).body.items).toHaveLength(0);
    const t2 = await assign(aliceId);
    await alice.postI(`/api/v1/tasks/${t2.id}/complete`, {});
    expect((await admin.patch(`/api/v1/admin/tasks/${t2.id}`, { version: 1, instructions: 'x' })).status).toBe(409);
    expect((await admin.post(`/api/v1/admin/tasks/${t2.id}/cancel`, { reason: 'nope' })).status).toBe(409);
  });

  it('archive is blocked while tasks are open', async () => {
    const t = await assign(aliceId);
    const blocked = await admin.post(`/api/v1/admin/people/${personId}/archive`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACTIVE_TASKS_EXIST');
    await alice.postI(`/api/v1/tasks/${t.id}/complete`, {});
    expect((await admin.post(`/api/v1/admin/people/${personId}/archive`)).status).toBe(200);
    // Archived people cannot receive new tasks; their pending reminders are dismissed.
    const r = await admin.postI('/api/v1/admin/tasks', { personId, assignedTo: aliceId, scheduledDate: '2026-11-10' });
    expect(r.status).toBe(409);
    expect((await Reminder.findOne({ sourceTaskId: t.id }).lean())!.status).toBe('DISMISSED');
  });

  it('deactivating a user flags their open tasks for reassignment', async () => {
    const t = await assign(aliceId);
    await admin.post(`/api/v1/admin/users/${aliceId}/deactivate`);
    const flagged = await admin.get('/api/v1/admin/tasks?needsReassignment=true');
    expect(flagged.body.items.map((x: { id: string }) => x.id)).toEqual([t.id]);
    const dash = await admin.get('/api/v1/admin/dashboard');
    expect(dash.body.tasks.needsReassignment).toBe(1);
    // Inactive users cannot be assigned.
    expect((await admin.postI('/api/v1/admin/tasks', { personId, assignedTo: aliceId, scheduledDate: '2026-11-10' })).status).toBe(400);
  });

  it('warns on past scheduled dates', async () => {
    const t = await assign(aliceId, { scheduledDate: '2026-01-01' });
    expect(t.warnings).toContain('SCHEDULED_DATE_IN_PAST');
  });

  it('user dashboard counts only own data and never reminders', async () => {
    await assign(aliceId);
    await alice.postI('/api/v1/people', samplePerson);
    const d = await alice.get('/api/v1/dashboard');
    expect(d.body.tasks.active).toBe(1);
    expect(d.body.recentEntries).toBe(1);
    expect(JSON.stringify(d.body)).not.toMatch(/reminder/i);
    expect((await alice.get('/api/v1/admin/dashboard')).status).toBe(403);
  });
});
