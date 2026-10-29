import { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource is not available.'));
};

function isDbUnavailable(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return (
    name === 'MongoServerSelectionError' ||
    name === 'MongoNetworkError' ||
    name === 'MongoNotConnectedError' ||
    (err instanceof mongoose.Error && name === 'MongooseServerSelectionError')
  );
}

/** Uniform error envelope. Never leaks stack traces or internal messages. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;
  if (err instanceof AppError) {
    appErr = err;
  } else if ((err as { type?: string })?.type === 'entity.too.large') {
    appErr = new AppError(400, 'VALIDATION_FAILED', 'The request body is too large.');
  } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
    appErr = new AppError(400, 'VALIDATION_FAILED', 'The request body is not valid JSON.');
  } else if (isDbUnavailable(err)) {
    logger.error({ err: { name: (err as Error).name }, requestId: req.requestId }, 'database unavailable');
    appErr = new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'The service is temporarily unavailable. Please retry.');
  } else if ((err as { code?: number })?.code === 11000) {
    appErr = new AppError(409, 'STATE_CONFLICT', 'The request conflicts with the current state.');
  } else {
    logger.error({ err, requestId: req.requestId }, 'unhandled error');
    appErr = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong.');
  }

  const body: Record<string, unknown> = {
    code: appErr.code,
    message: appErr.message,
    requestId: req.requestId,
  };
  if (appErr.details !== undefined) body.details = appErr.details;
  res.status(appErr.status).json({ error: body });
};
