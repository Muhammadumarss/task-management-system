import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../common/logger';
import { allModels } from './models';

// Operator injection is prevented by Zod validation of every input plus the reject-operators
// middleware; filters are always built from validated primitives, never raw request objects.
mongoose.set('strictQuery', true);

export async function connectDatabase(uri = config.MONGODB_URI): Promise<void> {
  await mongoose.connect(uri, {
    // Production indexes are applied explicitly with scripts/create-indexes.ts.
    autoIndex: config.NODE_ENV === 'development' || config.NODE_ENV === 'test',
    serverSelectionTimeoutMS: 10_000,
  });
  await assertReplicaSet();
  logger.info('database connected');
}

/** Transactions require a replica set; fail fast rather than silently losing atomicity. */
async function assertReplicaSet(): Promise<void> {
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error('MongoDB must be a replica set (or sharded cluster) so transactions work.');
  }
}

export async function syncAllIndexes(): Promise<void> {
  for (const m of allModels) {
    await m.syncIndexes();
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export async function databaseReady(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db!.admin().ping();
    return true;
  } catch {
    return false;
  }
}
