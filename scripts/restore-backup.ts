/**
 * Operator restore into an ISOLATED database (never directly over production).
 * There is deliberately no HTTP restore endpoint.
 *
 *   # From a backup run recorded in the live database (downloads from the configured store):
 *   npm run restore-backup -- --run <backupRunId> --target-uri <uri> --target-db task_management_restore
 *
 *   # From a local encrypted file (e.g. downloaded manually from Drive):
 *   npm run restore-backup -- --file ./ptb-backup-....enc --sha256 <checksum> --target-uri <uri> --target-db task_management_restore
 *
 * Follow docs/runbooks/restore.md for the full procedure (verification, safety backup,
 * maintenance-window switch-over).
 */
import { parseArgs } from 'util';
import path from 'path';
import { promises as fs } from 'fs';
import mongoose from 'mongoose';
import { config } from '../src/config';
import { BackupRun } from '../src/modules/backups/backup.models';
import { getBackupStore } from '../src/modules/backups/store';
import { restoreEncryptedArchive } from '../src/modules/backups/restore';

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      file: { type: 'string' },
      sha256: { type: 'string' },
      'target-uri': { type: 'string' },
      'target-db': { type: 'string' },
    },
  });
  const targetUri = values['target-uri'];
  const targetDb = values['target-db'];
  if (!targetUri || !targetDb) throw new Error('--target-uri and --target-db are required');

  let file = values.file;
  let sha = values.sha256 ?? null;
  let downloaded: string | null = null;

  if (values.run) {
    await mongoose.connect(config.MONGODB_URI);
    const run = await BackupRun.findById(values.run).lean();
    if (!run || run.status !== 'SUCCEEDED' || !run.driveFileId) throw new Error('Backup run not found or not successful');
    if (run.method === 'mongodump') {
      throw new Error('This backup was taken with mongodump. Decrypt it, then use mongorestore --gzip --archive --oplogReplay (see runbook).');
    }
    console.log(`Backup ${run._id}: ${run.fileName}, ${run.fileSize} bytes, key ${run.keyId}, finished ${run.finishedAt?.toISOString()}`);
    const store = getBackupStore();
    await store.ensureReady();
    await fs.mkdir(path.resolve(config.BACKUP_TMP_DIR), { recursive: true });
    downloaded = path.resolve(config.BACKUP_TMP_DIR, `restore-${run._id}.enc`);
    await store.download(run.driveFileId, downloaded);
    file = downloaded;
    sha = run.checksumSha256 ?? null;
    await mongoose.disconnect();
  }
  if (!file) throw new Error('Provide --run or --file');
  if (!sha) console.warn('Warning: no checksum supplied; integrity will rely on the authenticated encryption tag only.');

  const result = await restoreEncryptedArchive({ encryptedFile: file, expectedSha256: sha, targetUri, targetDb });
  console.log('Restore complete into isolated database:', targetDb);
  console.table(result.counts);
  console.log(`Sessions revoked: ${result.sessionsRevoked}, tokens revoked: ${result.tokensRevoked}, jobs quarantined: ${result.jobsQuarantined}`);
  console.log('Next: run create-indexes against the restored DB, then verify per docs/runbooks/restore.md.');
  if (downloaded) await fs.rm(downloaded, { force: true });
}

main()
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
