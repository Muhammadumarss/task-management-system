import mongoose, { ClientSession } from 'mongoose';

/**
 * Run `fn` inside a MongoDB transaction. The driver retries on transient errors,
 * so `fn` must be safe to re-run (no external side effects inside it).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result as T;
  } finally {
    await session.endSession();
  }
}
