export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'CSRF_FAILED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'EDIT_WINDOW_EXPIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'LAST_ADMIN'
  | 'ACTIVE_TASKS_EXIST'
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_FAILED', message, details);
export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required.');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
/** Consistent "unavailable" response — never reveals whether a resource exists. */
export const notFound = () => new AppError(404, 'NOT_FOUND', 'The requested resource is not available.');
export const versionConflict = () =>
  new AppError(409, 'VERSION_CONFLICT', 'The record was changed by someone else. Reload and try again.');
export const stateConflict = (message: string) => new AppError(409, 'STATE_CONFLICT', message);
