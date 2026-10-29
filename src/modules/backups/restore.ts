import { promises as fs } from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import { config } from '../../config';
import { decryptFile, fileDigests, secureDelete } from './encryption';
import { importSnapshot } from './archive';

export interface RestoreResult {
  counts: Record<string, number>;
  sessionsRevoked: number;
  tokensRevoked: number;
  jobsQuarantined: number;
}

/**
 * Restore an encrypted snapshot archive into an ISOLATED database, then make it safe:
 * revoke restored sessions and password tokens, and quarantine restored background jobs
 * so nothing replays unintended side effects. Index creation is done afterwards with
 * scripts/create-indexes.ts against the restored database.
 */
export async function restoreEncryptedArchive(opts: {
  encryptedFile: string;
  expectedSha256?: string | null;
  targetUri: string;
  targetDb: string;
  keys?: Record<string, Buffer>;
}): Promise<RestoreResult> {
  const digests = await fileDigests(opts.encryptedFile);
  if (opts.expectedSha256 && digests.sha256 !== opts.expectedSha256) {
    throw new Error('Checksum mismatch: the backup file is corrupt or not the expected one.');
  }
  const plain = path.join(path.dirname(opts.encryptedFile), `${path.basename(opts.encryptedFile)}.restore.gz`);
  const client = new MongoClient(opts.targetUri);
  try {
    await decryptFile(opts.encryptedFile, plain, opts.keys ?? config.BACKUP_ENCRYPTION_KEYS);
    await client.connect();
    const db = client.db(opts.targetDb);
    const existing = await db.listCollections({}, { nameOnly: true }).toArray();
    if (existing.length > 0) throw new Error(`Target database "${opts.targetDb}" is not empty. Restore into an empty, isolated database.`);
    const counts = await importSnapshot(plain, db);
    const now = new Date();
    const s = await db.collection('sessions').updateMany({ revokedAt: null }, { $set: { revokedAt: now } });
    const t = await db.collection('passwordTokens').updateMany({ consumedAt: null }, { $set: { consumedAt: now } });
    const j = await db.collection('jobs').updateMany(
      { status: { $in: ['PENDING', 'RUNNING'] } },
      { $set: { status: 'QUARANTINED', leaseOwner: null, leaseUntil: null, lastError: 'Quarantined by restore' } },
    );
    // A restored RUNNING backup run must not hold the lock.
    await db.collection('backupRuns').updateMany({ status: 'RUNNING' }, { $set: { status: 'FAILED', errorSummary: 'Interrupted (restored from backup)' }, $unset: { activeLock: 1 } });
    return { counts, sessionsRevoked: s.modifiedCount, tokensRevoked: t.modifiedCount, jobsQuarantined: j.modifiedCount };
  } finally {
    await secureDelete(plain);
    await client.close();
    await fs.rm(`${plain}.partial`, { force: true });
  }
}
