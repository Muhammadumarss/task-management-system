import { User } from '../modules/users/user.model';
import { Session } from '../modules/auth/session.model';
import { PasswordToken } from '../modules/auth/passwordToken.model';
import { Person } from '../modules/people/person.model';
import { Task } from '../modules/tasks/task.model';
import { Reminder } from '../modules/reminders/reminder.model';
import { Settings } from '../modules/settings/settings.model';
import { AuditLog } from '../modules/audit/audit.model';
import { Job } from '../modules/jobs/job.model';
import { BackupRun, DriveIntegration } from '../modules/backups/backup.models';
import { IdempotencyKey } from '../modules/idempotency/idempotency.model';

/** Every model, used for explicit index creation and backups. */
export const allModels = [
  User,
  Session,
  PasswordToken,
  Person,
  Task,
  Reminder,
  Settings,
  AuditLog,
  Job,
  BackupRun,
  DriveIntegration,
  IdempotencyKey,
];

/** Collections included in backups (business data plus technical state that restore revokes). */
export const backupCollections = [
  'users',
  'people',
  'tasks',
  'reminders',
  'settings',
  'auditLogs',
  'sessions',
  'passwordTokens',
  'jobs',
  'backupRuns',
];
