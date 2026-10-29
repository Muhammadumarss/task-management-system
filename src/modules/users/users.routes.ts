import { Router } from 'express';
import { z } from 'zod';
import { h } from '../../common/http';
import { objectId, parse } from '../../common/validation';
import { paginationQuery } from '../../common/pagination';
import { ctxOf } from '../../common/context';
import {
  activateUser,
  changeRole,
  changeRoleBody,
  createUser,
  createUserBody,
  deactivateUser,
  getUser,
  issueReset,
  listUsers,
  updateUser,
  updateUserBody,
} from './users.service';

export const usersAdminRouter = Router();

const idParam = z.object({ id: objectId });
const listQuery = paginationQuery.extend({
  status: z.enum(['INVITED', 'ACTIVE', 'INACTIVE']).optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  search: z.string().trim().min(1).max(64).optional(),
});

usersAdminRouter.post(
  '/',
  h(async (req, res) => {
    res.status(201).json(await createUser(ctxOf(req), parse(createUserBody, req.body)));
  }),
);

usersAdminRouter.get(
  '/',
  h(async (req, res) => {
    res.json(await listUsers(parse(listQuery, req.query)));
  }),
);

usersAdminRouter.get(
  '/:id',
  h(async (req, res) => {
    res.json(await getUser(parse(idParam, req.params).id));
  }),
);

usersAdminRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await updateUser(ctxOf(req), id, parse(updateUserBody, req.body)));
  }),
);

usersAdminRouter.post(
  '/:id/deactivate',
  h(async (req, res) => {
    res.json(await deactivateUser(ctxOf(req), parse(idParam, req.params).id));
  }),
);

usersAdminRouter.post(
  '/:id/activate',
  h(async (req, res) => {
    res.json(await activateUser(ctxOf(req), parse(idParam, req.params).id));
  }),
);

usersAdminRouter.post(
  '/:id/reset-password',
  h(async (req, res) => {
    res.json(await issueReset(ctxOf(req), parse(idParam, req.params).id));
  }),
);

usersAdminRouter.post(
  '/:id/change-role',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await changeRole(ctxOf(req), id, parse(changeRoleBody, req.body)));
  }),
);
