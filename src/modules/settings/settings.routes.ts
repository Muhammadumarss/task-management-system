import { Router } from 'express';
import { h } from '../../common/http';
import { parse } from '../../common/validation';
import { ctxOf } from '../../common/context';
import { getSettings, settingsPatch, updateSettings } from './settings.service';

export const settingsAdminRouter = Router();

settingsAdminRouter.get(
  '/',
  h(async (_req, res) => {
    res.json(await getSettings());
  }),
);

settingsAdminRouter.patch(
  '/',
  h(async (req, res) => {
    const input = parse(settingsPatch, req.body);
    res.json(await updateSettings(ctxOf(req), input));
  }),
);
