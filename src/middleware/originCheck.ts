import { RequestHandler } from 'express';
import { AppError } from '../common/errors';
import { config } from '../config';

/**
 * Origin validation for browser writes. Requests that carry an Origin header (browsers do on
 * cross-site and most same-site writes) must come from an allowlisted origin. Mobile/native
 * clients send no Origin and authenticate with bearer tokens, which are not CSRF-prone.
 */
export const originCheck: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.header('origin');
  if (origin && !config.ALLOWED_ORIGINS.includes(origin)) {
    return next(new AppError(403, 'CSRF_FAILED', 'The request could not be verified.'));
  }
  next();
};
