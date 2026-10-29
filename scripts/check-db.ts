/**
 * Check that the configured MongoDB is reachable and is a replica set (required for transactions).
 *   npm run check-db
 * Never prints the connection string.
 */
import mongoose from 'mongoose';
import { connectDatabase, databaseReady } from '../src/database/connection';

async function main() {
  await connectDatabase();
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  const ready = await databaseReady();
  console.log(`Connected. Database: ${mongoose.connection.db!.databaseName}, replica set: ${hello.setName ?? 'n/a'}, ready: ${ready}`);
}

main()
  .catch((e: Error) => {
    console.error(`Connection failed: ${e.name}: ${String(e.message).replace(/mongodb(\+srv)?:\/\/\S+/g, '[uri]').slice(0, 400)}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
