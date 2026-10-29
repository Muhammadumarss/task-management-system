import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Windows cannot spawn executables whose full path exceeds 260 characters. When the project
 * lives in a deep folder, copy the cached mongod binary to a short temp path and use that.
 */
function shortBinaryPath(): string | undefined {
  if (process.env.MONGOMS_SYSTEM_BINARY || process.platform !== 'win32') return undefined;
  const cacheDir = path.resolve('node_modules/.cache/mongodb-memory-server');
  if (!existsSync(cacheDir)) return undefined;
  const exe = readdirSync(cacheDir).find((f) => /^mongod-.*\.exe$/.test(f));
  if (!exe) return undefined;
  const full = path.join(cacheDir, exe);
  if (full.length < 240) return undefined;
  const dir = path.join(os.tmpdir(), 'ptb-mongod');
  const target = path.join(dir, exe);
  if (!existsSync(target)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(full, target);
  }
  return target;
}

/** Real single-node replica set so transactions, snapshot reads and unique indexes behave as in production. */
export default async function setup(project: TestProject) {
  const systemBinary = shortBinaryPath();
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    ...(systemBinary && { binary: { systemBinary } }),
  });
  project.provide('mongoUri', rs.getUri());
  return async () => {
    await rs.stop();
  };
}
