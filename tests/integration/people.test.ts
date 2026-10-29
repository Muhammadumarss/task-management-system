import { beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { api, Client, createAccount, freezeClock, loginBearer, MIN, samplePerson, useTestDatabase } from '../support/helpers';
import { Person } from '../../src/modules/people/person.model';

useTestDatabase();

let admin: Client;
let alice: Client;
let bob: Client;
let clock: ReturnType<typeof freezeClock>;

beforeEach(async () => {
  clock = freezeClock();
  await createAccount('ADMIN', 'boss');
  await createAccount('USER', 'alice');
  await createAccount('USER', 'bob');
  admin = await loginBearer('ADMIN', 'boss');
  alice = await loginBearer('USER', 'alice');
  bob = await loginBearer('USER', 'bob');
});

describe('person submission and correction window', () => {
  it('creator can read/edit for 10 minutes; at expiry access ends but admin keeps it', async () => {
    const created = await alice.postI('/api/v1/people', samplePerson);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const deadline = new Date(created.body.editableUntil).getTime();
    expect(deadline - clock.now().getTime()).toBe(10 * MIN);
    expect(created.body.possibleDuplicate).toBeUndefined();
    expect(created.body.createdBy).toBeUndefined();

    expect((await alice.get('/api/v1/people/recent')).body.items).toHaveLength(1);

    clock.advance(5 * MIN);
    const edit = await alice.patch(`/api/v1/people/${id}`, { version: 0, name: 'Muhammad Ali Khan' });
    expect(edit.status).toBe(200);
    // Editing does not restart the window.
    expect(new Date(edit.body.editableUntil).getTime()).toBe(deadline);

    clock.advance(5 * MIN - 1);
    expect((await alice.get(`/api/v1/people/${id}`)).status).toBe(200);

    clock.advance(1); // exactly at the deadline
    const late = await alice.patch(`/api/v1/people/${id}`, { version: 1, name: 'Too late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('EDIT_WINDOW_EXPIRED');
    expect((await alice.get(`/api/v1/people/${id}`)).status).toBe(404);
    expect((await alice.get('/api/v1/people/recent')).body.items).toHaveLength(0);

    const adminView = await admin.get(`/api/v1/admin/people/${id}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.name).toBe('Muhammad Ali Khan');
  });

  it('other users get a uniform 404 and cannot see or edit someone else’s entry', async () => {
    const { body } = await alice.postI('/api/v1/people', samplePerson);
    expect((await bob.get(`/api/v1/people/${body.id}`)).status).toBe(404);
    expect((await bob.patch(`/api/v1/people/${body.id}`, { version: 0, name: 'x' })).status).toBe(404);
    expect((await bob.get(`/api/v1/people/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect((await bob.get('/api/v1/people/recent')).body.items).toHaveLength(0);
    expect((await bob.get('/api/v1/admin/people')).status).toBe(403);
  });

  it('rejects server-controlled fields and invalid input', async () => {
    const forged = await alice.postI('/api/v1/people', { ...samplePerson, createdBy: new mongoose.Types.ObjectId(), editableUntil: '2099-01-01' });
    expect(forged.status).toBe(400);
    const { body } = await alice.postI('/api/v1/people', samplePerson);
    expect((await alice.patch(`/api/v1/people/${body.id}`, { version: 0, editableUntil: '2099-01-01' })).status).toBe(400);
    expect((await alice.postI('/api/v1/people', { ...samplePerson, phone: '123' })).status).toBe(400);
    expect((await alice.postI('/api/v1/people', { ...samplePerson, requestedWorkDate: '2026-02-30' })).status).toBe(400);
    expect((await alice.postI('/api/v1/people', { ...samplePerson, location: { latitude: 33.6 } })).status).toBe(400);
    expect((await alice.postI('/api/v1/people', { ...samplePerson, location: { latitude: 120, longitude: 73 } })).status).toBe(400);
  });

  it('users have no delete endpoint', async () => {
    const { body } = await alice.postI('/api/v1/people', samplePerson);
    const del = await api().delete(`/api/v1/people/${body.id}`).set('Authorization', `Bearer ${alice.token}`);
    expect(del.status).toBe(404);
    expect(await Person.countDocuments()).toBe(1);
  });

  it('concurrent edits: stale version returns conflict instead of overwriting', async () => {
    const { body } = await alice.postI('/api/v1/people', samplePerson);
    expect((await admin.patch(`/api/v1/admin/people/${body.id}`, { version: 0, name: 'Admin edit' })).status).toBe(200);
    const stale = await alice.patch(`/api/v1/people/${body.id}`, { version: 0, name: 'User edit' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await Person.findById(body.id).lean())!.name).toBe('Admin edit');
  });

  it('flags duplicate phones for admin only, without disclosing them to the submitter', async () => {
    await bob.postI('/api/v1/people', samplePerson);
    const second = await alice.postI('/api/v1/people', { ...samplePerson, name: 'Someone Else', phone: '0300 1234567' });
    expect(second.status).toBe(201);
    expect(JSON.stringify(second.body)).not.toMatch(/duplicate/i);
    const list = await admin.get('/api/v1/admin/people?possibleDuplicate=true');
    expect(list.body.items).toHaveLength(2);
    const detail = await admin.get(`/api/v1/admin/people/${second.body.id}`);
    expect(detail.body.possibleDuplicates).toHaveLength(1);
  });

  it('idempotency: same key replays, changed payload conflicts, no duplicate record', async () => {
    const key = randomUUID();
    const a = await alice.post('/api/v1/people', samplePerson, { 'Idempotency-Key': key });
    const b = await alice.post('/api/v1/people', samplePerson, { 'Idempotency-Key': key });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const c = await alice.post('/api/v1/people', { ...samplePerson, name: 'Changed' }, { 'Idempotency-Key': key });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await Person.countDocuments()).toBe(1);
    // Replay after the window does not re-expose customer details.
    clock.advance(11 * MIN);
    const alice2 = await loginBearer('USER', 'alice');
    const late = await alice2.post('/api/v1/people', samplePerson, { 'Idempotency-Key': key });
    expect(late.status).toBe(201); // different session, same actor: still the same operation
    expect(late.body).toEqual({ id: a.body.id, editable: false });
    const missing = await alice2.post('/api/v1/people', samplePerson);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('never has a TTL index on editableUntil', async () => {
    const indexes = await Person.collection.indexes();
    for (const ix of indexes) {
      if (ix.key.editableUntil !== undefined) expect(ix.expireAfterSeconds).toBeUndefined();
    }
  });

  it('admin can search, archive and restore', async () => {
    await alice.postI('/api/v1/people', samplePerson);
    await admin.postI('/api/v1/admin/people', { ...samplePerson, name: 'Zainab Bibi', phone: '+923331112222' });
    const search = await admin.get('/api/v1/admin/people?search=zain');
    expect(search.body.items).toHaveLength(1);
    const byPhone = await admin.get('/api/v1/admin/people?search=03331112222');
    expect(byPhone.body.items).toHaveLength(1);
    const id = search.body.items[0].id;
    expect((await admin.post(`/api/v1/admin/people/${id}/archive`)).body.status).toBe('ARCHIVED');
    expect((await admin.post(`/api/v1/admin/people/${id}/restore`)).body.status).toBe('ACTIVE');
    expect((await admin.get('/api/v1/admin/people?sort=-password')).status).toBe(400);
    expect((await admin.get('/api/v1/admin/people?limit=500')).status).toBe(400);
  });
});
