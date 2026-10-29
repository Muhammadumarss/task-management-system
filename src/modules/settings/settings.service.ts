import { ClientSession } from 'mongoose';
import { z } from 'zod';
import { IANAZone } from 'luxon';
import { Settings, SETTINGS_ID } from './settings.model';
import { config } from '../../config';
import { versionConflict } from '../../common/errors';
import type { Ctx } from '../../common/context';
import { auditCtx } from '../audit/audit.service';
import { withTransaction } from '../../common/transaction';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm (24h)');

export const settingsPatch = z
  .object({
    version: z.number().int().nonnegative(),
    timezone: z.string().refine((tz) => IANAZone.isValidZone(tz), 'invalid IANA timezone').optional(),
    followUp: z
      .object({
        enabled: z.boolean(),
        intervalDays: z.number().int().min(1).max(3650),
        reminderTime: hhmm,
        repeatFollowUps: z.boolean(),
        unreachableRetryDays: z.number().int().min(0).max(365),
        maxUnreachableAttempts: z.number().int().min(1).max(20),
      })
      .partial()
      .strict()
      .optional(),
    backup: z
      .object({
        enabled: z.boolean(),
        scheduleTime: hhmm,
        retentionCount: z.number().int().min(1).max(365),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export type SettingsView = Awaited<ReturnType<typeof getSettings>>;

/** Read settings, creating defaults on first use. */
export async function getSettings(session?: ClientSession) {
  let s = await Settings.findById(SETTINGS_ID).session(session ?? null).lean();
  if (!s) {
    try {
      await Settings.create([{ _id: SETTINGS_ID, timezone: config.BUSINESS_TIMEZONE }], { session });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    s = await Settings.findById(SETTINGS_ID).session(session ?? null).lean();
  }
  return {
    timezone: s!.timezone,
    followUp: {
      enabled: s!.followUp!.enabled!,
      intervalDays: s!.followUp!.intervalDays!,
      reminderTime: s!.followUp!.reminderTime!,
      repeatFollowUps: s!.followUp!.repeatFollowUps!,
      unreachableRetryDays: s!.followUp!.unreachableRetryDays!,
      maxUnreachableAttempts: s!.followUp!.maxUnreachableAttempts!,
    },
    backup: {
      enabled: s!.backup!.enabled!,
      scheduleTime: s!.backup!.scheduleTime!,
      retentionCount: s!.backup!.retentionCount!,
    },
    version: s!.version,
    updatedAt: s!.updatedAt,
  };
}

/**
 * Update settings with optimistic concurrency. Changes apply to tasks created afterwards;
 * existing tasks keep their policy snapshot and existing reminders are not rewritten.
 */
export async function updateSettings(ctx: Ctx, input: z.infer<typeof settingsPatch>) {
  await getSettings();
  return withTransaction(async (session) => {
    const set: Record<string, unknown> = {};
    if (input.timezone) set.timezone = input.timezone;
    for (const [k, v] of Object.entries(input.followUp ?? {})) set[`followUp.${k}`] = v;
    for (const [k, v] of Object.entries(input.backup ?? {})) set[`backup.${k}`] = v;
    const updated = await Settings.findOneAndUpdate(
      { _id: SETTINGS_ID, version: input.version },
      { $set: set, $inc: { version: 1 } },
      { new: true, session },
    );
    if (!updated) throw versionConflict();
    await auditCtx(ctx, 'SETTINGS_UPDATED', 'settings', SETTINGS_ID, { fields: Object.keys(set) }, session);
    return getSettings(session);
  });
}
