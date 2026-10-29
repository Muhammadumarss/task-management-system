import { beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { createAccount, DAY, freezeClock, loginBearer, MIN, samplePerson, useTestDatabase } from '../support/helpers';
import { config } from '../../src/config';
import { Job } from '../../src/modules/jobs/job.model';
import { claimNext, enqueue, JobHandler, LEASE_MS, PermanentJobError, runJob } from '../../src/modules/jobs/jobs.service';
import { BackupRun } from '../../src/modules/backups/backup.models';
import { BACKUP_JOB, applyRetention, runBackupJob, scheduleDailyBackup } from '../../src/modules/backups/backup.service';
import { BackupStore, LocalDirStore } from '../../src/modules/backups/store';
import { restoreEncryptedArchive } from '../../src/modules/backups/restore';

useTestDatabase();

const storeDir = path.resolve(config.BACKUP_LOCAL_DIR);
let store: LocalDirStore;

beforeEach(async () => {
  await fs.rm(storeDir, { recursive: true, force: true });
  store = new LocalDirStore(storeDir);
});

async function runOneBackup(s: BackupStore = store) {
  const { job } = await enqueue(BACKUP_JOB, { trigger: 'MANUAL' });
  const claimed = await claimNext('w1', [BACKUP_JOB]);
  expect(String(claimed!._id)).toBe(String(job._id));
  await runJob(claimed!, 'w1', { [BACKUP_JOB]: (ctx) => runBackupJob(ctx, s) });
  return Job.findById(job._id).lean();
}

describe('backups', () => {
  it('produces an encrypted archive that restores into an isolated database', async () => {
    await createAccount('ADMIN', 'boss');
    await createAccount('USER', 'alice');
    const admin = await loginBearer('ADMIN', 'boss');
    await loginBearer('USER', 'alice'); // creates a session that restore must revoke
    for (let i = 0; i < 3; i++) await admin.postI('/api/v1/admin/people', { ...samplePerson, name: `Person ${i}` });

    const job = await runOneBackup();
    expect(job!.status).toBe('SUCCEEDED');
    const run = await BackupRun.findOne({ status: 'SUCCEEDED' }).lean();
    expect(run!.keyId).toBe('test1');
    expect(run!.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run!.activeLock).toBeUndefined();
    expect((run!.collections as Record<string, number>).people).toBe(3);

    const file = path.join(storeDir, run!.driveFileId!);
    const bytes = await fs.readFile(file);
    expect(bytes.subarray(0, 4).toString()).toBe('PTBK');
    expect(bytes.includes(Buffer.from('Person 0'))).toBe(false); // not plaintext
    // No plaintext left behind in the temp directory.
    const tmpLeft = await fs.readdir(path.resolve(config.BACKUP_TMP_DIR)).catch(() => []);
    expect(tmpLeft).toHaveLength(0);

    const targetDb = `restore_${randomUUID().slice(0, 8)}`;
    const result = await restoreEncryptedArchive({ encryptedFile: file, expectedSha256: run!.checksumSha256, targetUri: process.env.MONGODB_URI!, targetDb });
    expect(result.counts.people).toBe(3);
    expect(result.counts.users).toBe(2);
    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(2);

    const client = await MongoClient.connect(process.env.MONGODB_URI!);
    try {
      const db = client.db(targetDb);
      expect(await db.collection('people').countDocuments()).toBe(3);
      expect(await db.collection('sessions').countDocuments({ revokedAt: null })).toBe(0);
      expect(await db.collection('jobs').countDocuments({ status: { $in: ['PENDING', 'RUNNING'] } })).toBe(0);
      const p = await db.collection('people').findOne({ name: 'Person 1' });
      expect(p!._id).toBeInstanceOf(mongoose.mongo.ObjectId);
      expect(p!.editableUntil).toBeInstanceOf(Date);
      await db.dropDatabase();
    } finally {
      await client.close();
    }

    // Tampering is detected (authenticated encryption / checksum).
    bytes[bytes.length - 40] ^= 0xff;
    await fs.writeFile(file + '.bad', bytes);
    await expect(
      restoreEncryptedArchive({ encryptedFile: file + '.bad', expectedSha256: null, targetUri: process.env.MONGODB_URI!, targetDb: `bad_${randomUUID().slice(0, 6)}` }),
    ).rejects.toThrow();
  });

  it('retention keeps the newest N successful backups and never touches other files', async () => {
    const admin = await (async () => {
      await createAccount('ADMIN', 'boss');
      return loginBearer('ADMIN', 'boss');
    })();
    const s = (await admin.get('/api/v1/admin/settings')).body;
    await admin.patch('/api/v1/admin/settings', { version: s.version, backup: { retentionCount: 2 } });
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(path.join(storeDir, 'unrelated.txt'), 'keep me');
    for (let i = 0; i < 4; i++) await runOneBackup();
    const files = (await fs.readdir(storeDir)).filter((f) => f.endsWith('.enc'));
    expect(files).toHaveLength(2);
    expect(await fs.readFile(path.join(storeDir, 'unrelated.txt'), 'utf8')).toBe('keep me');
    expect(await BackupRun.countDocuments({ deletedFromDriveAt: { $ne: null } })).toBe(2);
    expect(await applyRetention(store)).toBe(0);
  });

  it('a retried job reconciles an upload that already happened instead of re-uploading', async () => {
    let uploads = 0;
    let failAfterUpload = true;
    const flaky: BackupStore = {
      kind: 'local',
      ensureReady: () => store.ensureReady(),
      findByRunId: (id) => store.findByRunId(id),
      upload: async (...args) => {
        uploads++;
        await store.upload(args[0], args[1]);
        if (failAfterUpload) {
          failAfterUpload = false;
          throw new Error('network reset after upload');
        }
        return store.upload(args[0], args[1]);
      },
      download: (id, d) => store.download(id, d),
      delete: (id) => store.delete(id),
    };
    const clock = freezeClock();
    const { job } = await enqueue(BACKUP_JOB, { trigger: 'MANUAL' });
    const handlers: Record<string, JobHandler> = { [BACKUP_JOB]: (ctx) => runBackupJob(ctx, flaky) };
    await runJob((await claimNext('w1', [BACKUP_JOB]))!, 'w1', handlers);
    expect((await Job.findById(job._id).lean())!.status).toBe('PENDING'); // retry scheduled with backoff
    expect(await BackupRun.findOne({ jobId: job._id }).lean()).toMatchObject({ status: 'FAILED' });

    clock.advance(10 * MIN);
    await runJob((await claimNext('w1', [BACKUP_JOB]))!, 'w1', handlers);
    expect((await Job.findById(job._id).lean())!.status).toBe('SUCCEEDED');
    expect(uploads).toBe(1); // the retry found the existing upload by run id
    expect(await BackupRun.countDocuments({ jobId: job._id })).toBe(1);
    const run = await BackupRun.findOne({ jobId: job._id }).lean();
    expect(run).toMatchObject({ status: 'SUCCEEDED' });
    expect(run!.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('only one backup runs at a time', async () => {
    await BackupRun.create({ status: 'RUNNING', trigger: 'MANUAL', activeLock: 'backup', heartbeatAt: new Date(), startedAt: new Date() });
    const job = await runOneBackup();
    expect(job!.status).toBe('PENDING');
    expect(job!.lastError).toMatch(/already running/);
  });

  it('missing encryption key / unavailable store fails permanently and visibly', async () => {
    const broken: BackupStore = { ...store, kind: 'local', ensureReady: async () => { throw new PermanentJobError('Google Drive is not connected.'); }, findByRunId: async () => null, upload: async () => ({ id: '', size: 0 }), download: async () => undefined, delete: async () => undefined };
    const job = await runOneBackup(broken);
    expect(job!.status).toBe('FAILED');
    expect((await BackupRun.findOne().lean())!.errorSummary).toMatch(/not connected/);
  });

  it('scheduled backups are created once per local day after the configured time', async () => {
    const clock = freezeClock(new Date('2026-11-02T20:00:00.000Z')); // 01:00 Karachi on Nov 3
    expect(await scheduleDailyBackup('local')).toBeNull();
    clock.advance(61 * MIN); // 02:01 Karachi
    expect(await scheduleDailyBackup('local')).toBe('2026-11-03');
    expect(await scheduleDailyBackup('local')).toBeNull();
    expect(await Job.countDocuments({ type: BACKUP_JOB })).toBe(1);
    clock.advance(DAY);
    expect(await scheduleDailyBackup('local')).toBe('2026-11-04');
    // Drive store: paused while not connected.
    clock.advance(DAY);
    expect(await scheduleDailyBackup('drive')).toBeNull();
  });

  it('admin can queue a manual backup (202) and see history', async () => {
    await createAccount('ADMIN', 'boss');
    const admin = await loginBearer('ADMIN', 'boss');
    const r = await admin.post('/api/v1/admin/backups');
    expect(r.status).toBe(202);
    const r2 = await admin.post('/api/v1/admin/backups');
    expect(r2.body).toMatchObject({ jobId: r.body.jobId, alreadyQueued: true });
    const list = await admin.get('/api/v1/admin/backups');
    expect(list.status).toBe(200);
    expect(list.body.jobs.pendingDue).toBe(1);
    const drive = await admin.get('/api/v1/admin/integrations/drive/status');
    expect(drive.body).toMatchObject({ serverConfigured: false, status: 'DISCONNECTED' });
  });
});

describe('durable jobs', () => {
  it('recovers expired leases after a worker crash', async () => {
    const clock = freezeClock();
    await enqueue('noop', {});
    const first = await claimNext('crashed-worker', ['noop']);
    expect(first).toBeTruthy();
    expect(await claimNext('w2', ['noop'])).toBeNull(); // still leased
    clock.advance(LEASE_MS + 1);
    const recovered = await claimNext('w2', ['noop']);
    expect(recovered!.leaseOwner).toBe('w2');
    expect(recovered!.attempts).toBe(2);
    // The crashed worker can no longer record an outcome.
    await runJob(first!, 'crashed-worker', { noop: async () => undefined });
    expect((await Job.findById(first!._id).lean())!.status).toBe('RUNNING');
  });

  it('retries with backoff, then fails after max attempts', async () => {
    const clock = freezeClock();
    await enqueue('flaky', {}, { maxAttempts: 2 });
    const handlers = { flaky: async () => { throw new Error('boom'); } };
    await runJob((await claimNext('w', ['flaky']))!, 'w', handlers);
    expect(await claimNext('w', ['flaky'])).toBeNull(); // backoff not elapsed
    clock.advance(10 * MIN);
    const second = await claimNext('w', ['flaky']);
    await runJob(second!, 'w', handlers);
    expect((await Job.findById(second!._id).lean())!.status).toBe('FAILED');
  });

  it('unique occurrence keys prevent duplicate scheduled jobs', async () => {
    const a = await enqueue('x', {}, { uniqueKey: 'x:2026-11-02' });
    const b = await enqueue('x', {}, { uniqueKey: 'x:2026-11-02' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await Job.countDocuments()).toBe(1);
  });
});
