import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './common/logger';
import { requestId } from './middleware/requestId';
import { rejectOperators } from './middleware/rejectOperators';
import { originCheck } from './middleware/originCheck';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { databaseReady } from './database/connection';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // Flat query strings only: no nested objects that could smuggle operators.
  app.set('query parser', 'simple');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      // Log method, path and status only — never bodies or query strings (may hold customer data).
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, path: req.url.split('?')[0], id: req.id }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.ALLOWED_ORIGINS.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-CSRF-Token', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  // Health endpoints: no credentials or topology details.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    const ok = await databaseReady();
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  app.use('/api', rejectOperators, originCheck);
  app.use('/api/v1', apiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
