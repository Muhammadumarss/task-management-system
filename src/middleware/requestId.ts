import { RequestHandler } from 'express';
import { randomUUID } from 'crypto';

/** Accept a well-formed caller request ID (for tracing) or generate one. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};
