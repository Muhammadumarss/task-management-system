import { Router } from 'express';
import { z } from 'zod';
import { h } from '../../common/http';
import { objectId, parse } from '../../common/validation';
import { ctxOf } from '../../common/context';
import { requireRole } from '../../middleware/auth';
import { idempotent } from '../idempotency/idempotency';
import { Task, TaskDoc } from './task.model';
import {
  adminComplete,
  adminCompleteBody,
  adminGet,
  adminList,
  adminListQuery,
  adminUpdate,
  cancelBody,
  cancelTask,
  completeBody,
  completeMine,
  createTask,
  createTaskBody,
  getMine,
  listMine,
  reassign,
  reassignBody,
  receiptFor,
  toAdminTaskView,
  updateTaskBody,
} from './tasks.service';

const idParam = z.object({ id: objectId });

// ----- USER routes (/api/v1/tasks) -----
export const tasksRouter = Router();
tasksRouter.use(requireRole('USER'));

tasksRouter.get(
  '/mine',
  h(async (req, res) => {
    res.json(await listMine(ctxOf(req)));
  }),
);

tasksRouter.get(
  '/:id',
  h(async (req, res) => {
    res.json(await getMine(ctxOf(req), parse(idParam, req.params).id));
  }),
);

tasksRouter.post(
  '/:id/complete',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const input = parse(completeBody, req.body);
    const ctx = ctxOf(req);
    const result = await idempotent(
      req,
      'tasks:complete',
      async () => {
        const r = await completeMine(ctx, id, input);
        return { status: 200, body: r, ref: { taskId: id } };
      },
      // Receipt only: no customer details, so replay cannot bypass later authorization.
      async (ref) => ({ status: 200, body: await receiptFor(ref.taskId) }),
    );
    res.status(result.status).json(result.body);
  }),
);

// ----- ADMIN routes (/api/v1/admin/tasks) -----
export const tasksAdminRouter = Router();

tasksAdminRouter.post(
  '/',
  h(async (req, res) => {
    const input = parse(createTaskBody, req.body);
    const ctx = ctxOf(req);
    const result = await idempotent(
      req,
      'admin:tasks:create',
      async () => {
        const { task, warnings } = await createTask(ctx, input);
        return { status: 201, body: { ...toAdminTaskView(task), warnings }, ref: { taskId: String(task._id), warnings } };
      },
      async (ref) => {
        const t = await Task.findById(ref.taskId).lean();
        return { status: 201, body: t ? { ...toAdminTaskView(t as TaskDoc), warnings: ref.warnings } : { id: ref.taskId } };
      },
    );
    res.status(result.status).json(result.body);
  }),
);

tasksAdminRouter.get(
  '/',
  h(async (req, res) => {
    res.json(await adminList(parse(adminListQuery, req.query)));
  }),
);

tasksAdminRouter.get(
  '/:id',
  h(async (req, res) => {
    res.json(await adminGet(parse(idParam, req.params).id));
  }),
);

tasksAdminRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await adminUpdate(ctxOf(req), id, parse(updateTaskBody, req.body)));
  }),
);

tasksAdminRouter.post(
  '/:id/reassign',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await reassign(ctxOf(req), id, parse(reassignBody, req.body)));
  }),
);

tasksAdminRouter.post(
  '/:id/cancel',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await cancelTask(ctxOf(req), id, parse(cancelBody, req.body)));
  }),
);

tasksAdminRouter.post(
  '/:id/complete',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await adminComplete(ctxOf(req), id, parse(adminCompleteBody, req.body)));
  }),
);
