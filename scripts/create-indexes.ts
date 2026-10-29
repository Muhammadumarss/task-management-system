/**
 * Apply indexes explicitly (production does not auto-create indexes).
 *   npm run create-indexes            # create/sync
 *   npm run create-indexes -- --dry   # show differences only
 */
import { parseArgs } from 'util';
import mongoose from 'mongoose';
import { allModels } from '../src/database/models';

async function main() {
  const { values } = parseArgs({ options: { dry: { type: 'boolean', default: false } } });
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { autoIndex: false });
  for (const m of allModels) {
    if (values.dry) {
      const diff = await m.diffIndexes();
      console.log(`${m.collection.collectionName}: create=${JSON.stringify(diff.toCreate)} drop=${JSON.stringify(diff.toDrop)}`);
    } else {
      await m.createCollection().catch(() => undefined);
      const dropped = await m.syncIndexes();
      console.log(`${m.collection.collectionName}: indexes synced${dropped.length ? ` (dropped: ${dropped.join(', ')})` : ''}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
