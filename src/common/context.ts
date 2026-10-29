import { Request } from 'express';
import { Types } from 'mongoose';
import type { Role } from '../modules/users/user.model';
import { unauthenticated } from './errors';

export interface AuthContext {
  userId: Types.ObjectId;
  role: Role;
  name: string;
  username: string;
  sessionId: Types.ObjectId;
  client: 'web' | 'mobile';
  via: 'cookie' | 'bearer';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}

/** Actor context passed from controllers into services (for authorization filters and audit). */
export interface Ctx {
  actorId: Types.ObjectId;
  actorRole: Role;
  requestId: string;
}

export function ctxOf(req: Request): Ctx {
  if (!req.auth) throw unauthenticated();
  return { actorId: req.auth.userId, actorRole: req.auth.role, requestId: req.requestId };
}
