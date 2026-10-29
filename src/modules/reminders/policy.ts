import { z } from 'zod';
import type { SettingsView } from '../settings/settings.service';

export interface FollowUpPolicy {
  enabled: boolean;
  intervalDays: number;
  reminderTime: string;
  repeatFollowUps: boolean;
  unreachableRetryDays: number;
  maxUnreachableAttempts: number;
  timezone: string;
}

/** Optional per-task override of the global follow-up policy. */
export const policyOverride = z
  .strictObject({
    enabled: z.boolean(),
    intervalDays: z.number().int().min(1).max(3650),
    reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    repeatFollowUps: z.boolean(),
    unreachableRetryDays: z.number().int().min(0).max(365),
    maxUnreachableAttempts: z.number().int().min(1).max(20),
  })
  .partial();

export type PolicyOverride = z.infer<typeof policyOverride>;

/** The effective policy, snapshotted onto a task when it is created. */
export function effectivePolicy(settings: SettingsView, override?: PolicyOverride): FollowUpPolicy {
  return { ...settings.followUp, ...(override ?? {}), timezone: settings.timezone };
}

export function plainPolicy(p: FollowUpPolicy): FollowUpPolicy {
  return {
    enabled: p.enabled,
    intervalDays: p.intervalDays,
    reminderTime: p.reminderTime,
    repeatFollowUps: p.repeatFollowUps,
    unreachableRetryDays: p.unreachableRetryDays,
    maxUnreachableAttempts: p.maxUnreachableAttempts,
    timezone: p.timezone,
  };
}
