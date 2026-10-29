import { createReadStream, createWriteStream } from 'fs';
import { createGunzip, createGzip } from 'zlib';
import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { once } from 'events';
import { BSON, Db, MongoClient } from 'mongodb';

const { EJSON } = BSON;
import { backupCollections } from '../../database/models';

export const SNAPSHOT_FORMAT = 'ptb-ejson-snapshot-v1+gzip';
export const MONGODUMP_FORMAT = 'mongodump-archive+gzip+oplog';

export interface ExportResult {
  method: 'snapshot-session' | 'mongodump';
  format: string;
  counts: Record<string, number>;
}

/**
 * Consistent export using a MongoDB snapshot session: every read sees the same point in
 * time, so concurrent writes cannot produce a torn backup. Requires a replica set
 * (MongoDB 5.0+) and must finish within minSnapshotHistoryWindowInSeconds (default 300s).
 * For large datasets, configure MONGODUMP_PATH to use mongodump --oplog instead.
 */
export async function exportSnapshot(client: MongoClient, dbName: string, dest: string): Promise<ExportResult> {
  const db = client.db(dbName);
  const session = client.startSession({ snapshot: true });
  const gzip = createGzip();
  const out = createWriteStream(dest, { mode: 0o600 });
  gzip.pipe(out);
  const write = async (line: string) => {
    if (!gzip.write(line + '\n')) await once(gzip, 'drain');
  };
  const counts: Record<string, number> = {};
  try {
    await write(JSON.stringify({ format: SNAPSHOT_FORMAT, database: dbName, createdAt: new Date().toISOString(), collections: backupCollections }));
    for (const name of backupCollections) {
      let n = 0;
      const cursor = db.collection(name).find({}, { session, batchSize: 1000 });
      for await (const doc of cursor) {
        await write(EJSON.stringify({ c: name, d: doc }, { relaxed: false }));
        n++;
      }
      counts[name] = n;
    }
    await write(JSON.stringify({ end: true, counts }));
  } finally {
    await session.endSession();
    gzip.end();
    await once(out, 'finish');
  }
  return { method: 'snapshot-session', format: SNAPSHOT_FORMAT, counts };
}

/** Full replica-set dump with oplog capture, for restore with mongorestore --oplogReplay. */
export async function exportMongodump(mongodumpPath: string, uri: string, dest: string): Promise<ExportResult> {
  const child = spawn(mongodumpPath, [`--uri=${uri}`, `--archive=${dest}`, '--gzip', '--oplog'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  const [code] = (await once(child, 'close')) as [number];
  if (code !== 0) {
    // Strip anything that looks like a connection string before surfacing the error.
    throw new Error(`mongodump failed (exit ${code}): ${stderr.replace(/mongodb(\+srv)?:\/\/\S+/g, '[uri]').slice(-300)}`);
  }
  return { method: 'mongodump', format: MONGODUMP_FORMAT, counts: {} };
}

/** Restore a snapshot export into `db` (which should be an isolated, empty database). */
export async function importSnapshot(src: string, db: Db): Promise<Record<string, number>> {
  const rl = createInterface({ input: createReadStream(src).pipe(createGunzip()), crlfDelay: Infinity });
  let headerSeen = false;
  let expected: Record<string, number> | null = null;
  const counts: Record<string, number> = {};
  const buffers = new Map<string, unknown[]>();
  const flush = async (name: string) => {
    const docs = buffers.get(name);
    if (docs && docs.length) {
      await db.collection(name).insertMany(docs as never[], { ordered: false });
      buffers.set(name, []);
    }
  };
  for await (const line of rl) {
    if (!line) continue;
    if (!headerSeen) {
      const h = JSON.parse(line) as { format?: string };
      if (h.format !== SNAPSHOT_FORMAT) throw new Error(`Unsupported archive format: ${h.format}`);
      headerSeen = true;
      continue;
    }
    const rec = EJSON.parse(line, { relaxed: false }) as { c?: string; d?: unknown; end?: boolean; counts?: Record<string, number> };
    if (rec.end) {
      expected = rec.counts ?? {};
      continue;
    }
    const name = rec.c!;
    if (!buffers.has(name)) buffers.set(name, []);
    buffers.get(name)!.push(rec.d);
    counts[name] = (counts[name] ?? 0) + 1;
    if (buffers.get(name)!.length >= 1000) await flush(name);
  }
  for (const name of buffers.keys()) await flush(name);
  if (!expected) throw new Error('Archive is truncated (no end marker)');
  for (const [name, n] of Object.entries(expected)) {
    if ((counts[name] ?? 0) !== Number(n)) throw new Error(`Count mismatch for ${name}: expected ${n}, got ${counts[name] ?? 0}`);
  }
  return counts;
}
