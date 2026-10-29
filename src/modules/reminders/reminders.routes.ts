import { Router } from 'express';
import { z } from 'zod';
import { h } from '../../common/http';
import { objectId, parse } from '../../common/validation';
import { paginationQuery } from '../../common/pagination';
import { ctxOf } from '../../common/context';
import { idempotent } from '../idempotency/idempotency';
import {
  assignBody,
  assignReminder,
  dismissBody,
  dismissReminder,
  listQuery,
  listReminders,
  snoozeBody,
  snoozeReminder,
} from './reminders.service';

/** Admin only (mounted under /api/v1/admin/reminders). Users have no reminder routes. */
export const remindersAdminRouter = Router();
const idParam = z.object({ id: objectId });

remindersAdminRouter.get(
  '/',
  h(async (req, res) => {
    res.json(await listReminders(parse(paginationQuery.extend(listQuery.shape), req.query)));
  }),
);

remindersAdminRouter.post(
  '/:id/assign',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const input = parse(assignBody, req.body);
    const ctx = ctxOf(req);
    const result = await idempotent(
      req,
      'admin:reminders:assign',
      async () => {
        const r = await assignReminder(ctx, id, input);
        return { status: 201, body: r, ref: r };
      },
      async (ref) => ({ status: 201, body: ref }),
    );
    res.status(result.status).json(result.body);
  }),
);

remindersAdminRouter.post(
  '/:id/snooze',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await snoozeReminder(ctxOf(req), id, parse(snoozeBody, req.body)));
  }),
);

remindersAdminRouter.post(
  '/:id/dismiss',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await dismissReminder(ctxOf(req), id, parse(dismissBody, req.body)));
  }),
);
