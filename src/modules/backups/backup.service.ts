import { promises as fs } from 'fs';
import path from 'path';
import mongoose, { Types } from 'mongoose';
import type { MongoClient } from 'mongodb';
import { config } from '../../config';
import { clock } from '../../common/clock';
import { logger } from '../../common/logger';
import { databaseReady } from '../../database/connection';
import { BackupRun, BackupRunDoc, DriveIntegration } from './backup.models';
import { exportMongodump, exportSnapshot } from './archive';
import { ENCRYPTION_FORMAT, encryptFile, fileDigests, secureDelete } from './encryption';
import { BackupStore, getBackupStore } from './store';
import { JobContext, PermanentJobError, enqueue } from '../jobs/jobs.service';
import { Job } from '../jobs/job.model';
import { getSettings } from '../settings/settings.service';
import { scheduledOccurrence } from '../../common/dates';

export const BACKUP_JOB = 'backup';
const STALE_RUN_MS = 15 * 60 * 1000;
const LOCK = 'backup';

function activeKey(): { keyId: string; key: Buffer } {
  const keyId = config.BACKUP_ACTIVE_KEY_ID;
  const key = keyId ? config.BACKUP_ENCRYPTION_KEYS[keyId] : undefined;
  if (!key) throw new PermanentJobError('Backup encryption key is not configured (BACKUP_ACTIVE_KEY_ID / BACKUP_ENCRYPTION_KEYS).');
  return { keyId, key };
}

/**
 * Acquire the backup lock by creating (or resuming) this job's BackupRun. The partial unique
 * index on activeLock means only one RUNNING run exists at a time. A run whose heartbeat is
 * stale (crashed worker) is failed and its lock released.
 */
async function acquireRun(jobId: Types.ObjectId, trigger: 'SCHEDULED' | 'MANUAL'): Promise<BackupRunDoc | 'ALREADY_DONE'> {
  const now = clock.now();
  const mine = await BackupRun.findOne({ jobId }).sort({ startedAt: -1 }).lean();
  if (mine?.status === 'SUCCEEDED') return 'ALREADY_DONE';
  if (mine?.status === 'RUNNING' && mine.activeLock === LOCK) {
    // Previous attempt of this job crashed mid-run: take it over (same run id → upload reconciliation).
    const resumed = await BackupRun.findOneAndUpdate({ _id: mine._id, status: 'RUNNING' }, { $set: { heartbeatAt: now } }, { new: true }).lean();
    if (resumed) return resumed as BackupRunDoc;
  }
  await BackupRun.updateMany(
    { status: 'RUNNING', activeLock: LOCK, heartbeatAt: { $lt: new Date(now.getTime() - STALE_RUN_MS) } },
    { $set: { status: 'FAILED', finishedAt: now, errorSummary: 'Abandoned (worker stopped responding)' }, $unset: { activeLock: 1 } },
  );
  try {
    if (mine?.status === 'FAILED') {
      // Retry of this job: reuse the run so an upload that succeeded before the failure is found, not repeated.
      const retried = await BackupRun.findOneAndUpdate(
        { _id: mine._id, status: 'FAILED' },
        { $set: { status: 'RUNNING', activeLock: LOCK, heartbeatAt: now, finishedAt: null, errorSummary: null } },
        { new: true },
      ).lean();
      if (retried) return retried as BackupRunDoc;
    }
    const run = await BackupRun.create({ status: 'RUNNING', trigger, jobId, activeLock: LOCK, heartbeatAt: now, startedAt: now });
    return run.toObject() as BackupRunDoc;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new Error('Another backup is already running; will retry.');
    throw e;
  }
}

/** Backup job handler. Idempotent across retries: a SUCCEEDED run short-circuits, uploads are reconciled. */
export async function runBackupJob(ctx: JobContext, store: BackupStore = getBackupStore()): Promise<void> {
  const trigger = (ctx.job.payload as { trigger?: 'SCHEDULED' | 'MANUAL' })?.trigger ?? 'MANUAL';
  const acquired = await acquireRun(ctx.job._id, trigger);
  if (acquired === 'ALREADY_DONE') return;
  const run = acquired;
  const runId = String(run._id);
  const log = logger.child({ backupRunId: runId });

  const tmpDir = path.resolve(config.BACKUP_TMP_DIR);
  await fs.mkdir(tmpDir, { recursive: true });
  const plain = path.join(tmpDir, `${runId}.archive.gz`);
  const stamp = clock.now().toISOString().replace(/[:.]/g, '-');
  const encName = `ptb-backup-${stamp}-${runId}.enc`;
  const enc = path.join(tmpDir, encName);

  const heartbeat = setInterval(() => {
    void ctx.renewLease();
    void BackupRun.updateOne({ _id: run._id, status: 'RUNNING' }, { $set: { heartbeatAt: clock.now() } });
  }, 30_000);

  try {
    const { keyId, key } = activeKey();
    if (!(await databaseReady())) throw new Error('Database is not ready');
    await store.ensureReady();

    let uploaded = await store.findByRunId(runId);
    if (uploaded && (!run.checksumSha256 || run.fileSize !== uploaded.size)) {
      // Found an upload we never recorded metadata for; don't trust it, produce a fresh one.
      uploaded = null;
    }

    if (!uploaded) {
      const exportInfo = config.MONGODUMP_PATH
        ? await exportMongodump(config.MONGODUMP_PATH, config.MONGODB_URI, plain)
        : await exportSnapshot(mongoose.connection.getClient() as unknown as MongoClient, mongoose.connection.db!.databaseName, plain);
      await encryptFile(plain, enc, keyId, key);
      await secureDelete(plain);
      const digests = await fileDigests(enc);
      // Persist metadata before the external side effect so a retry can reconcile against it.
      await BackupRun.updateOne(
        { _id: run._id },
        {
          $set: {
            fileName: encName,
            fileSize: digests.size,
            checksumSha256: digests.sha256,
            keyId,
            method: exportInfo.method,
            format: `${exportInfo.format}|${ENCRYPTION_FORMAT}`,
            collections: exportInfo.counts,
          },
        },
      );
      await ctx.renewLease();
      const result = await store.upload(enc, encName, runId, digests.size, async () => {
        await ctx.renewLease();
      });
      if (result.size !== digests.size) throw new Error(`Uploaded size mismatch (${result.size} != ${digests.size})`);
      if (result.md5 && result.md5 !== digests.md5) throw new Error('Uploaded checksum mismatch');
      uploaded = { id: result.id, size: result.size };
    } else {
      log.info('backup already uploaded by a previous attempt; reconciling');
    }

    await BackupRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'SUCCEEDED',
          finishedAt: clock.now(),
          driveFileId: uploaded.id,
          errorSummary: null,
        },
        $unset: { activeLock: 1 },
      },
    );
    log.info('backup succeeded');
    await applyRetention(store).catch((e) => log.warn({ err: { message: (e as Error).message } }, 'retention failed'));
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? 'unknown error';
    await BackupRun.updateOne(
      { _id: run._id, status: 'RUNNING' },
      { $set: { status: 'FAILED', finishedAt: clock.now(), errorSummary: message }, $unset: { activeLock: 1 } },
    );
    throw err;
  } finally {
    clearInterval(heartbeat);
    await secureDelete(plain);
    await fs.rm(enc, { force: true });
  }
}

/**
 * Keep the newest `retentionCount` successful backups. Only files this app recorded in
 * backupRuns are ever deleted, and the newest successful backup is never deleted.
 */
export async function applyRetention(store: BackupStore) {
  const { backup } = await getSettings();
  const keep = Math.max(1, backup.retentionCount);
  const old = await BackupRun.find({ status: 'SUCCEEDED', driveFileId: { $ne: null }, deletedFromDriveAt: null })
    .sort({ finishedAt: -1 })
    .skip(keep)
    .lean();
  for (const r of old) {
    await store.delete(r.driveFileId!);
    await BackupRun.updateOne({ _id: r._id }, { $set: { deletedFromDriveAt: clock.now() } });
  }
  return old.length;
}

/** Queue a manual backup; if one is already queued or running, return that job. */
export async function queueManualBackup(actorId: Types.ObjectId) {
  const existing = await Job.findOne({ type: BACKUP_JOB, status: { $in: ['PENDING', 'RUNNING'] } }).lean();
  if (existing) return { jobId: String(existing._id), alreadyQueued: true };
  const { job } = await enqueue(BACKUP_JOB, { trigger: 'MANUAL', requestedBy: String(actorId) }, { maxAttempts: 4 });
  return { jobId: String(job._id), alreadyQueued: false };
}

/** Called by the worker every tick: create today's scheduled backup job once (unique key). */
export async function scheduleDailyBackup(storeKind: 'drive' | 'local' = config.BACKUP_STORE) {
  const s = await getSettings();
  if (!s.backup.enabled) return null;
  if (storeKind === 'drive') {
    const integ = await DriveIntegration.findById('drive').lean();
    if (integ?.status !== 'CONNECTED') return null; // paused until an admin reconnects
  }
  const now = clock.now();
  const occ = scheduledOccurrence(now, s.backup.scheduleTime, s.timezone);
  if (now.getTime() < occ.at.getTime()) return null;
  const { created } = await enqueue(BACKUP_JOB, { trigger: 'SCHEDULED', occurrence: occ.dateKey }, { uniqueKey: `backup:scheduled:${occ.dateKey}`, maxAttempts: 6 });
  return created ? occ.dateKey : null;
}
