import { describe, expect, it } from 'vitest';
import { api, createAccount, freezeClock, loginBearer, MIN, PASSWORD, useTestDatabase } from '../support/helpers';
import { Session } from '../../src/modules/auth/session.model';

useTestDatabase();

describe('authentication', () => {
  it('never issues an admin session through either endpoint to a USER, and vice versa', async () => {
    await createAccount('USER', 'worker');
    await createAccount('ADMIN', 'boss');

    const userAtAdmin = await api().post('/api/v1/auth/admin/login').send({ username: 'worker', password: PASSWORD });
    expect(userAtAdmin.status).toBe(401);
    expect(userAtAdmin.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(userAtAdmin.headers['set-cookie']).toBeUndefined();

    const adminAtUser = await api().post('/api/v1/auth/user/login').send({ username: 'boss', password: PASSWORD });
    expect(adminAtUser.status).toBe(401);

    // Same generic error for a wrong password and an unknown account.
    const wrong = await api().post('/api/v1/auth/user/login').send({ username: 'worker', password: 'nope-nope-nope' });
    const unknown = await api().post('/api/v1/auth/user/login').send({ username: 'ghost', password: 'nope-nope-nope' });
    expect(wrong.body.error.message).toBe(unknown.body.error.message);

    const ok = await api().post('/api/v1/auth/user/login').send({ username: 'worker', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('USER');
  });

  it('ignores a client-supplied role', async () => {
    await createAccount('USER', 'worker');
    const res = await api().post('/api/v1/auth/admin/login').send({ username: 'worker', password: PASSWORD, role: 'ADMIN' });
    expect(res.status).toBe(401);
  });

  it('web login sets an HttpOnly cookie and requires the CSRF token on writes', async () => {
    await createAccount('USER', 'worker');
    const login = await api().post('/api/v1/auth/user/login').send({ username: 'worker', password: PASSWORD });
    const cookie = login.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(login.body.token).toBeUndefined();
    const csrf = login.body.csrfToken as string;

    const me = await api().get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('tasks:complete:own');

    const noCsrf = await api().post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');

    const badOrigin = await api().post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'https://evil.example');
    expect(badOrigin.status).toBe(403);

    const ok = await api().post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:5173');
    expect(ok.status).toBe(204);
    expect((await api().get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('enforces idle and absolute session expiry with the server clock', async () => {
    const clock = freezeClock();
    await createAccount('USER', 'worker');
    const c = await loginBearer('USER', 'worker');
    clock.advance(29 * MIN);
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);
    clock.advance(29 * MIN); // within idle of the last request
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);
    clock.advance(31 * MIN); // idle timeout
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);

    const c2 = await loginBearer('USER', 'worker');
    for (let i = 0; i < 25; i++) {
      clock.advance(29 * MIN);
      await c2.get('/api/v1/auth/me');
    }
    // > 12h since creation despite activity
    expect((await c2.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('logout-all revokes every session for the account', async () => {
    await createAccount('USER', 'worker');
    const a = await loginBearer('USER', 'worker');
    const b = await loginBearer('USER', 'worker');
    expect((await a.post('/api/v1/auth/logout-all')).status).toBe(204);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('throttles repeated failed logins per account', async () => {
    await createAccount('USER', 'worker');
    for (let i = 0; i < 5; i++) {
      await api().post('/api/v1/auth/user/login').send({ username: 'worker', password: 'wrong-password!' });
    }
    const locked = await api().post('/api/v1/auth/user/login').send({ username: 'worker', password: PASSWORD });
    expect(locked.status).toBe(429);
  });
});

describe('account lifecycle', () => {
  it('invite → setup token (single use, expiring) → active → deactivate revokes sessions', async () => {
    const clock = freezeClock();
    await createAccount('ADMIN', 'boss');
    const admin = await loginBearer('ADMIN', 'boss');

    const created = await admin.post('/api/v1/admin/users', { name: 'Ayesha', username: 'ayesha' });
    expect(created.status).toBe(201);
    expect(created.body.user.status).toBe('INVITED');
    expect(created.body.user.passwordHash).toBeUndefined();
    const token = new URL(created.body.setupLink.url).searchParams.get('token')!;

    // Invited users cannot log in yet.
    expect((await api().post('/api/v1/auth/user/login').send({ username: 'ayesha', password: 'whatever-123' })).status).toBe(401);

    const short = await api().post('/api/v1/auth/set-password').send({ token, password: 'short' });
    expect(short.status).toBe(400);

    const set = await api().post('/api/v1/auth/set-password').send({ token, password: 'a-good-long-password' });
    expect(set.status).toBe(200);
    const again = await api().post('/api/v1/auth/set-password').send({ token, password: 'another-long-password' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');

    const user = await loginBearer('USER', 'ayesha', 'a-good-long-password');
    expect((await user.get('/api/v1/auth/me')).status).toBe(200);

    // Reset link expires.
    const reset = await admin.post(`/api/v1/admin/users/${created.body.user.id}/reset-password`);
    expect(reset.body.purpose).toBe('RESET');
    const resetToken = new URL(reset.body.link.url).searchParams.get('token')!;
    clock.advance(61 * MIN);
    const admin2 = await loginBearer('ADMIN', 'boss');
    expect((await api().post('/api/v1/auth/reset-password').send({ token: resetToken, password: 'brand-new-password' })).status).toBe(400);

    const user2 = await loginBearer('USER', 'ayesha', 'a-good-long-password');
    const deact = await admin2.post(`/api/v1/admin/users/${created.body.user.id}/deactivate`);
    expect(deact.status).toBe(200);
    expect((await user2.get('/api/v1/auth/me')).status).toBe(401);
    expect(await Session.countDocuments({ userId: created.body.user.id, revokedAt: null })).toBe(0);
  });

  it('password reset revokes existing sessions', async () => {
    await createAccount('ADMIN', 'boss');
    const u = await createAccount('USER', 'worker');
    const admin = await loginBearer('ADMIN', 'boss');
    const user = await loginBearer('USER', 'worker');
    const reset = await admin.post(`/api/v1/admin/users/${u._id}/reset-password`);
    const token = new URL(reset.body.link.url).searchParams.get('token')!;
    expect((await api().post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-password' })).status).toBe(200);
    expect((await user.get('/api/v1/auth/me')).status).toBe(401);
    await loginBearer('USER', 'worker', 'brand-new-password');
  });

  it('protects the last active admin', async () => {
    const boss = await createAccount('ADMIN', 'boss');
    const admin = await loginBearer('ADMIN', 'boss');
    const r = await admin.post(`/api/v1/admin/users/${boss._id}/deactivate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('LAST_ADMIN');
  });

  it('users cannot reach admin routes', async () => {
    await createAccount('USER', 'worker');
    const user = await loginBearer('USER', 'worker');
    expect((await user.get('/api/v1/admin/users')).status).toBe(403);
    expect((await user.post('/api/v1/admin/users', { name: 'x', username: 'xyz' })).status).toBe(403);
    expect((await user.get('/api/v1/admin/reminders')).status).toBe(403);
  });

  it('change-password keeps the current session and revokes others', async () => {
    await createAccount('USER', 'worker');
    const a = await loginBearer('USER', 'worker');
    const b = await loginBearer('USER', 'worker');
    const r = await a.post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'my-new-password-1' });
    expect(r.status).toBe(200);
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('platform', () => {
  it('health endpoints and error envelope', async () => {
    expect((await api().get('/health/live')).status).toBe(200);
    expect((await api().get('/health/ready')).body.status).toBe('ready');
    const nf = await api().get('/api/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.requestId).toBeTruthy();
    expect(nf.headers['cache-control']).toBe('no-store');
  });

  it('rejects MongoDB operator objects', async () => {
    const r = await api().post('/api/v1/auth/user/login').send({ username: { $ne: null }, password: { $ne: null } });
    expect(r.status).toBe(400);
  });
});
