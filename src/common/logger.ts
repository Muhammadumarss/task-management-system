import pino from 'pino';
import { config } from '../config';

/**
 * Structured logger. Secrets and customer data are redacted by path; callers should
 * still avoid logging request bodies.
 */
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.currentPassword',
      '*.newPassword',
      '*.token',
      '*.refreshToken',
      '*.phone',
      '*.name',
      '*.location',
    ],
    censor: '[redacted]',
  },
});
