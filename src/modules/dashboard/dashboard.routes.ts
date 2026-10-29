import { Router } from 'express';
import { h } from '../../common/http';
import { ctxOf } from '../../common/context';
import { clock } from '../../common/clock';
import { todayIn } from '../../common/dates';
import { requireRole } from '../../middleware/auth';
import { Person } from '../people/person.model';
import { Task } from '../tasks/task.model';
import { Reminder } from '../reminders/reminder.model';
import { BackupRun } from '../backups/backup.models';
import { Job } from '../jobs/job.model';
import { getSettings } from '../settings/settings.service';

/** USER dashboard: own task totals and own unexpired entry count. Never reminder data. */
export const dashboardRouter = Router();
dashboardRouter.use(requireRole('USER'));

dashboardRouter.get(
  '/',
  h(async (req, res) => {
    const ctx = ctxOf(req);
    const now = clock.now();
    const today = todayIn((await getSettings()).timezone, now);
    const base = { assignedTo: ctx.actorId, status: 'ASSIGNED' };
    const [activeTasks, dueToday, overdue, recentEntries] = await Promise.all([
      Task.countDocuments(base),
      Task.countDocuments({ ...base, scheduledDate: today }),
      Task.countDocuments({ ...base, scheduledDate: { $lt: today } }),
      Person.countDocuments({ createdBy: ctx.actorId, status: 'ACTIVE', editableUntil: { $gt: now } }),
    ]);
    res.json({ today, serverTime: now, tasks: { active: activeTasks, dueToday, overdue }, recentEntries });
  }),
);

/** ADMIN dashboard: totals and attention items. */
export const dashboardAdminRouter = Router();

dashboardAdminRouter.get(
  '/',
  h(async (_req, res) => {
    const now = clock.now();
    const today = todayIn((await getSettings()).timezone, now);
    const [
      activePeople,
      possibleDuplicates,
      openTasks,
      tasksToday,
      overdueTasks,
      needsReassignment,
      completedToday,
      dueReminders,
      upcomingReminders,
      needsWorkOutcomes,
      lastBackup,
      lastFailedBackup,
      failedJobs,
    ] = await Promise.all([
      Person.countDocuments({ status: 'ACTIVE' }),
      Person.countDocuments({ status: 'ACTIVE', possibleDuplicate: true }),
      Task.countDocuments({ status: 'ASSIGNED' }),
      Task.countDocuments({ status: 'ASSIGNED', scheduledDate: today }),
      Task.countDocuments({ status: 'ASSIGNED', scheduledDate: { $lt: today } }),
      Task.countDocuments({ status: 'ASSIGNED', needsReassignment: true }),
      Task.countDocuments({ status: 'COMPLETED', completedAt: { $gte: new Date(now.getTime() - 24 * 3600_000) } }),
      Reminder.countDocuments({ status: 'SCHEDULED', dueAt: { $lte: now } }),
      Reminder.countDocuments({ status: 'SCHEDULED', dueAt: { $gt: now } }),
      Task.find({ type: 'FOLLOW_UP', followUpOutcome: 'NEEDS_WORK', outcomeReviewedAt: null }, { personId: 1, completedAt: 1 })
        .sort({ completedAt: -1 })
        .limit(20)
        .lean(),
      BackupRun.findOne({ status: 'SUCCEEDED' }).sort({ finishedAt: -1 }).lean(),
      BackupRun.findOne({ status: 'FAILED' }).sort({ finishedAt: -1 }).lean(),
      Job.countDocuments({ status: 'FAILED', updatedAt: { $gte: new Date(now.getTime() - 7 * 24 * 3600_000) } }),
    ]);
    res.json({
      today,
      serverTime: now,
      people: { active: activePeople, possibleDuplicates },
      tasks: { open: openTasks, dueToday: tasksToday, overdue: overdueTasks, needsReassignment, completedLast24h: completedToday },
      reminders: { due: dueReminders, upcoming: upcomingReminders },
      attention: {
        needsWorkOutcomes: needsWorkOutcomes.map((t) => ({ taskId: String(t._id), personId: String(t.personId), completedAt: t.completedAt })),
        tasksNeedingReassignment: needsReassignment,
        dueReminders,
        failedJobsLast7Days: failedJobs,
      },
      backups: {
        lastSuccessAt: lastBackup?.finishedAt ?? null,
        lastFailureAt: lastFailedBackup?.finishedAt ?? null,
        stale: !lastBackup || now.getTime() - (lastBackup.finishedAt?.getTime() ?? 0) > 36 * 3600_000,
      },
    });
  }),
);
