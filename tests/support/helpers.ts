import { afterAll, beforeAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { connectDatabase, syncAllIndexes } from '../../src/database/connection';
import { User, normalizeUsername } from '../../src/modules/users/user.model';
import { hashPassword } from '../../src/modules/auth/password';
import { resetClock, setClock } from '../../src/common/clock';
import { resetThrottle } from '../../src/modules/auth/throttle';

export const PASSWORD = 'correct-horse-battery';

let app: Express;

/** Each test file gets its own database on the shared replica set. */
export function useTestDatabase() {
  beforeAll(async () => {
    const uri = new URL(process.env.MONGODB_URI!);
    uri.pathname = `/t_${randomUUID().slice(0, 8)}`;
    await connectDatabase(uri.toString());
    await syncAllIndexes();
    app = createApp();
  });
  beforeEach(async () => {
    resetClock();
    resetThrottle();
    const db = mongoose.connection.db!;
    for (const c of await db.collections()) await c.deleteMany({});
  });
  afterAll(async () => {
    resetClock();
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
}

export function api() {
  return request(app);
}

/** Freeze the server clock at `start` and return a controller to move it. */
export function freezeClock(start = new Date('2026-11-02T06:00:00.000Z')) {
  let now = start.getTime();
  setClock(() => new Date(now));
  return {
    advance(ms: number) {
      now += ms;
    },
    set(d: Date) {
      now = d.getTime();
    },
    now: () => new Date(now),
  };
}

export const MIN = 60_000;
export const DAY = 24 * 3600_000;

export async function createAccount(role: 'ADMIN' | 'USER', username: string, status: 'ACTIVE' | 'INVITED' = 'ACTIVE') {
  return User.create({
    name: `${role} ${username}`,
    username,
    usernameNormalized: normalizeUsername(username),
    role,
    status,
    passwordHash: status === 'ACTIVE' ? await hashPassword(PASSWORD) : null,
    mustChangePassword: false,
  });
}

/** Bearer-token (mobile-style) client for concise tests. */
export async function loginBearer(role: 'ADMIN' | 'USER', username: string, password = PASSWORD) {
  const res = await api()
    .post(`/api/v1/auth/${role === 'ADMIN' ? 'admin' : 'user'}/login`)
    .send({ username, password, client: 'mobile' });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  const key = () => ({ 'Idempotency-Key': randomUUID() });
  return {
    token,
    get: (url: string) => api().get(url).set(auth),
    post: (url: string, body?: object, headers: Record<string, string> = {}) => api().post(url).set(auth).set(headers).send(body ?? {}),
    patch: (url: string, body: object) => api().patch(url).set(auth).send(body),
    /** POST with a fresh Idempotency-Key. */
    postI: (url: string, body?: object) => api().post(url).set(auth).set(key()).send(body ?? {}),
  };
}

export type Client = Awaited<ReturnType<typeof loginBearer>>;

export const samplePerson = {
  name: 'Muhammad Ali',
  phone: '+923001234567',
  requestedWorkDate: '2026-11-10',
  location: { addressText: 'Commercial Market, Rawalpindi' },
};
