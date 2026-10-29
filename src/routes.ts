import { Router } from 'express';
import { authenticate, requireRole } from './middleware/auth';
import { authRouter } from './modules/auth/auth.routes';
import { usersAdminRouter } from './modules/users/users.routes';
import { peopleAdminRouter, peopleRouter } from './modules/people/people.routes';
import { tasksAdminRouter, tasksRouter } from './modules/tasks/tasks.routes';
import { remindersAdminRouter } from './modules/reminders/reminders.routes';
import { settingsAdminRouter } from './modules/settings/settings.routes';
import { dashboardAdminRouter, dashboardRouter } from './modules/dashboard/dashboard.routes';
import { auditAdminRouter } from './modules/audit/audit.routes';
import { backupsAdminRouter, driveAdminRouter } from './modules/backups/backups.routes';

/** Versioned API: mounted at /api/v1. */
export function apiRouter(): Router {
  const api = Router();

  api.use('/auth', authRouter);

  // User-facing routes (role USER enforced inside each router).
  api.use('/people', authenticate, peopleRouter);
  api.use('/tasks', authenticate, tasksRouter);
  api.use('/dashboard', authenticate, dashboardRouter);

  // Admin routes: authentication + ADMIN role for everything under /admin.
  const admin = Router();
  admin.use(authenticate, requireRole('ADMIN'));
  admin.use('/users', usersAdminRouter);
  admin.use('/people', peopleAdminRouter);
  admin.use('/tasks', tasksAdminRouter);
  admin.use('/reminders', remindersAdminRouter);
  admin.use('/settings', settingsAdminRouter);
  admin.use('/dashboard', dashboardAdminRouter);
  admin.use('/audit-logs', auditAdminRouter);
  admin.use('/backups', backupsAdminRouter);
  admin.use('/integrations/drive', driveAdminRouter);
  api.use('/admin', admin);

  return api;
}
