import { Router } from 'express';
import { z } from 'zod';
import { h } from '../../common/http';
import { objectId, parse } from '../../common/validation';
import { pageMeta, paginationQuery, skip } from '../../common/pagination';
import { AuditLog } from './audit.model';

export const auditAdminRouter = Router();

const query = paginationQuery.extend({
  action: z.string().regex(/^[A-Z_]{2,64}$/).optional(),
  entityType: z.string().regex(/^[a-zA-Z]{2,32}$/).optional(),
  entityId: z.string().max(64).optional(),
  actorId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditAdminRouter.get(
  '/',
  h(async (req, res) => {
    const q = parse(query, req.query);
    const filter: Record<string, unknown> = {};
    if (q.action) filter.action = q.action;
    if (q.entityType) filter.entityType = q.entityType;
    if (q.entityId) filter.entityId = q.entityId;
    if (q.actorId) filter.actorId = q.actorId;
    if (q.from || q.to) filter.timestamp = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip(q)).limit(q.limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({
      items: items.map((a) => ({
        id: String(a._id),
        actorId: a.actorId ? String(a.actorId) : null,
        actorRole: a.actorRole,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        summary: a.summary,
        requestId: a.requestId,
        timestamp: a.timestamp,
      })),
      ...pageMeta(q, total),
    });
  }),
);
