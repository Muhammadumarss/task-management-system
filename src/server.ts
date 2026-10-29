import { Server } from 'http';
import { config } from './config';
import { logger } from './common/logger';
import { connectDatabase, disconnectDatabase } from './database/connection';
import { getSettings } from './modules/settings/settings.service';
import { createApp } from './app';

async function main() {
  await connectDatabase();
  await getSettings(); // ensure the settings document exists
  const app = createApp();
  const server: Server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down api');
    // Stop accepting new connections, let in-flight requests finish, then close the DB.
    server.close(async () => {
      await disconnectDatabase().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 20_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: { message: (err as Error).message } }, 'api failed to start');
  process.exit(1);
});
