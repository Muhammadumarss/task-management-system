import { Types } from 'mongoose';
import { clock } from '../../common/clock';
import { logger } from '../../common/logger';
import { Job, JobDoc } from './job.model';

/** Throw from a handler for failures that retrying cannot fix (e.g. revoked authorization). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface JobContext {
  job: JobDoc;
  /** Extend the lease during long work. Returns false if the lease was lost. */
  renewLease: () => Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export const LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export async function enqueue(type: string, payload: Record<string, unknown>, opts: { runAt?: Date; uniqueKey?: string; maxAttempts?: number } = {}) {
  try {
    const job = await Job.create({
      type,
      payload,
      runAt: opts.runAt ?? clock.now(),
      uniqueKey: opts.uniqueKey,
      maxAttempts: opts.maxAttempts ?? 5,
    });
    return { job, created: true };
  } catch (e) {
    // Unique occurrence key: scheduling the same occurrence twice is a no-op.
    if ((e as { code?: number }).code === 11000 && opts.uniqueKey) {
      const job = await Job.findOne({ uniqueKey: opts.uniqueKey }).lean();
      return { job: job!, created: false };
    }
    throw e;
  }
}

/**
 * Atomically claim one due job: a PENDING job whose runAt has passed, or a RUNNING job whose
 * lease expired (its worker crashed). Leases do not give exactly-once execution, so handlers
 * must be idempotent.
 */
export async function claimNext(workerId: string, types: string[]): Promise<JobDoc | null> {
  const now = clock.now();
  return Job.findOneAndUpdate(
    {
      type: { $in: types },
      $or: [
        { status: 'PENDING', runAt: { $lte: now } },
        { status: 'RUNNING', leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: 'RUNNING', leaseOwner: workerId, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true },
  ).lean() as Promise<JobDoc | null>;
}

export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

async function finish(job: JobDoc, workerId: string, update: Record<string, unknown>) {
  // Only the current lease holder may record the outcome.
  await Job.updateOne({ _id: job._id, leaseOwner: workerId, status: 'RUNNING' }, { $set: { ...update, leaseOwner: null, leaseUntil: null } });
}

export async function runJob(job: JobDoc, workerId: string, handlers: Record<string, JobHandler>) {
  const handler = handlers[job.type];
  const log = logger.child({ jobId: String(job._id), type: job.type, attempt: job.attempts });
  if (!handler) {
    await finish(job, workerId, { status: 'FAILED', lastError: 'No handler registered', finishedAt: clock.now() });
    return;
  }
  const renewLease = async () => {
    const r = await Job.updateOne(
      { _id: job._id, leaseOwner: workerId, status: 'RUNNING' },
      { $set: { leaseUntil: new Date(clock.now().getTime() + LEASE_MS) } },
    );
    return r.modifiedCount === 1;
  };
  try {
    await handler({ job, renewLease });
    await finish(job, workerId, { status: 'SUCCEEDED', lastError: null, finishedAt: clock.now() });
    log.info('job succeeded');
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? 'unknown error';
    const permanent = err instanceof PermanentJobError;
    if (permanent || job.attempts >= job.maxAttempts) {
      await finish(job, workerId, { status: 'FAILED', lastError: message, finishedAt: clock.now() });
      log.error({ err: { message } }, permanent ? 'job failed permanently' : 'job exhausted retries');
    } else {
      const runAt = new Date(clock.now().getTime() + backoffMs(job.attempts));
      await finish(job, workerId, { status: 'PENDING', lastError: message, runAt });
      log.warn({ err: { message }, retryAt: runAt }, 'job failed; will retry');
    }
  }
}

export async function jobStats() {
  const now = clock.now();
  const [pending, oldestPending, expiredLeases, failed] = await Promise.all([
    Job.countDocuments({ status: 'PENDING', runAt: { $lte: now } }),
    Job.findOne({ status: 'PENDING', runAt: { $lte: now } }).sort({ runAt: 1 }).lean(),
    Job.countDocuments({ status: 'RUNNING', leaseUntil: { $lt: now } }),
    Job.countDocuments({ status: 'FAILED' }),
  ]);
  return {
    pendingDue: pending,
    oldestPendingAgeSeconds: oldestPending ? Math.round((now.getTime() - oldestPending.runAt.getTime()) / 1000) : 0,
    expiredLeases,
    failed,
  };
}

export function newWorkerId(): string {
  return `${process.pid}-${new Types.ObjectId().toHexString()}`;
}
