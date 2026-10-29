import { RequestHandler } from 'express';
import { badRequest } from '../common/errors';

function hasOperatorKey(value: unknown, depth = 0): boolean {
  if (depth > 10) return true; // unreasonably deep input
  if (Array.isArray(value)) return value.some((v) => hasOperatorKey(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor') return true;
      if (hasOperatorKey(v, depth + 1)) return true;
    }
  }
  return false;
}

/** Reject MongoDB operator objects anywhere in body, query or params. */
export const rejectOperators: RequestHandler = (req, _res, next) => {
  if (hasOperatorKey(req.body) || hasOperatorKey(req.query) || hasOperatorKey(req.params)) {
    return next(badRequest('The request contains disallowed keys.'));
  }
  next();
};
