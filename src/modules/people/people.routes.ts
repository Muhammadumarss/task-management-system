import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { h } from '../../common/http';
import { objectId, parse } from '../../common/validation';
import { ctxOf } from '../../common/context';
import { clock } from '../../common/clock';
import { requireRole } from '../../middleware/auth';
import { idempotent } from '../idempotency/idempotency';
import { Person } from './person.model';
import { adminListQuery, createPersonBody, updatePersonBody } from './people.validation';
import {
  adminGet,
  adminList,
  adminUpdate,
  archivePerson,
  createPerson,
  getForCreator,
  listRecentForCreator,
  restorePerson,
  toAdminView,
  toCreatorView,
  updateForCreator,
} from './people.service';

const idParam = z.object({ id: objectId });

// ----- USER routes (/api/v1/people) -----
export const peopleRouter = Router();
peopleRouter.use(requireRole('USER'));

peopleRouter.post(
  '/',
  h(async (req, res) => {
    const input = parse(createPersonBody, req.body);
    const ctx = ctxOf(req);
    const result = await idempotent(
      req,
      'people:create',
      async () => {
        const p = await createPerson(ctx, input);
        return { status: 201, body: toCreatorView(p), ref: { personId: String(p._id) } };
      },
      async (ref) => {
        // Re-check authorization: after the correction window only a minimal receipt is returned.
        const p = await Person.findOne({
          _id: new Types.ObjectId(ref.personId),
          createdBy: ctx.actorId,
          status: 'ACTIVE',
          editableUntil: { $gt: clock.now() },
        }).lean();
        return p ? { status: 201, body: toCreatorView(p) } : { status: 201, body: { id: ref.personId, editable: false } };
      },
    );
    res.status(result.status).json(result.body);
  }),
);

peopleRouter.get(
  '/recent',
  h(async (req, res) => {
    res.json(await listRecentForCreator(ctxOf(req)));
  }),
);

peopleRouter.get(
  '/:id',
  h(async (req, res) => {
    res.json(await getForCreator(ctxOf(req), parse(idParam, req.params).id));
  }),
);

peopleRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await updateForCreator(ctxOf(req), id, parse(updatePersonBody, req.body)));
  }),
);

// ----- ADMIN routes (/api/v1/admin/people) -----
export const peopleAdminRouter = Router();

peopleAdminRouter.post(
  '/',
  h(async (req, res) => {
    const input = parse(createPersonBody, req.body);
    const ctx = ctxOf(req);
    const result = await idempotent(
      req,
      'admin:people:create',
      async () => {
        const p = await createPerson(ctx, input);
        return { status: 201, body: toAdminView(p), ref: { personId: String(p._id) } };
      },
      async (ref) => {
        const p = await Person.findById(ref.personId).lean();
        return { status: 201, body: p ? toAdminView(p) : { id: ref.personId } };
      },
    );
    res.status(result.status).json(result.body);
  }),
);

peopleAdminRouter.get(
  '/',
  h(async (req, res) => {
    res.json(await adminList(parse(adminListQuery, req.query)));
  }),
);

peopleAdminRouter.get(
  '/:id',
  h(async (req, res) => {
    res.json(await adminGet(parse(idParam, req.params).id));
  }),
);

peopleAdminRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await adminUpdate(ctxOf(req), id, parse(updatePersonBody, req.body)));
  }),
);

peopleAdminRouter.post(
  '/:id/archive',
  h(async (req, res) => {
    res.json(await archivePerson(ctxOf(req), parse(idParam, req.params).id));
  }),
);

peopleAdminRouter.post(
  '/:id/restore',
  h(async (req, res) => {
    res.json(await restorePerson(ctxOf(req), parse(idParam, req.params).id));
  }),
);
