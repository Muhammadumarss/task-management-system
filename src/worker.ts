import { logger } from './common/logger';
import { connectDatabase, disconnectDatabase } from './database/connection';
import { claimNext, JobHandler, newWorkerId, runJob, jobStats } from './modules/jobs/jobs.service';
import { BACKUP_JOB, runBackupJob, scheduleDailyBackup } from './modules/backups/backup.service';

const handlers: Record<string, JobHandler> = {
  [BACKUP_JOB]: (ctx) => runBackupJob(ctx),
};

const POLL_MS = 5_000;
const SCHEDULE_MS = 60_000;

async function main() {
  await connectDatabase();
  const workerId = newWorkerId();
  const log = logger.child({ workerId });
  log.info('worker started');

  let stopping = false;
  let busy: Promise<void> | null = null;

  const scheduleTick = async () => {
    try {
      const created = await scheduleDailyBackup();
      if (created) log.info({ occurrence: created }, 'scheduled backup job created');
      const stats = await jobStats();
      if (stats.oldestPendingAgeSeconds > 900 || stats.expiredLeases > 0) log.warn({ stats }, 'job lag detected');
    } catch (err) {
      log.error({ err: { message: (err as Error).message } }, 'schedule tick failed');
    }
  };

  const pollTick = async () => {
    if (stopping || busy) return;
    busy = (async () => {
      try {
        // Drain due jobs one at a time (backups are heavy; one per worker is enough).
        for (let job = await claimNext(workerId, Object.keys(handlers)); job && !stopping; job = await claimNext(workerId, Object.keys(handlers))) {
          await runJob(job, workerId, handlers);
        }
      } catch (err) {
        log.error({ err: { message: (err as Error).message } }, 'poll failed');
      } finally {
        busy = null;
      }
    })();
  };

  await scheduleTick();
  const scheduleTimer = setInterval(scheduleTick, SCHEDULE_MS);
  const pollTimer = setInterval(pollTick, POLL_MS);
  void pollTick();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker stopping; finishing current job');
    clearInterval(scheduleTimer);
    clearInterval(pollTimer);
    // Let the current job finish; if we are killed first, its lease expires and another worker resumes it.
    const hard = setTimeout(() => process.exit(1), 5 * 60_000);
    hard.unref();
    if (busy) await busy;
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: { message: (err as Error).message } }, 'worker failed to start');
  process.exit(1);
});
