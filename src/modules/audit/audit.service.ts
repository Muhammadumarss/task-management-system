import { ClientSession, Types } from 'mongoose';
import { AuditLog } from './audit.model';
import { clock } from '../../common/clock';
import type { Ctx } from '../../common/context';

export interface AuditEntry {
  actorId: Types.ObjectId | null;
  actorRole: string | null;
  requestId: string | null;
  action: string;
  entityType: string;
  entityId: string | Types.ObjectId | null;
  summary?: Record<string, unknown> | null;
}

/** Write an audit event. Pass the transaction session so the event commits with the change. */
export async function audit(entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLog.create(
    [
      {
        ...entry,
        entityId: entry.entityId ? String(entry.entityId) : null,
        summary: entry.summary ?? null,
        timestamp: clock.now(),
      },
    ],
    { session },
  );
}

export function auditCtx(
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: string | Types.ObjectId | null,
  summary?: Record<string, unknown>,
  session?: ClientSession,
) {
  return audit(
    { actorId: ctx.actorId, actorRole: ctx.actorRole, requestId: ctx.requestId, action, entityType, entityId, summary },
    session,
  );
}
