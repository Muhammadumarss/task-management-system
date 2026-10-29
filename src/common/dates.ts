import { DateTime } from 'luxon';

/** Today's calendar date (YYYY-MM-DD) in the given timezone. */
export function todayIn(tz: string, now: Date): string {
  return DateTime.fromJSDate(now).setZone(tz).toISODate()!;
}

/**
 * Reminder due instant: take the calendar day of `from` in the business timezone,
 * add `days` calendar days, set the configured local time, and convert to UTC.
 * Calendar-day arithmetic keeps the local time stable across DST changes.
 */
export function dueAfterDays(from: Date, days: number, localTime: string, tz: string): Date {
  const [hour, minute] = localTime.split(':').map(Number);
  return DateTime.fromJSDate(from)
    .setZone(tz)
    .startOf('day')
    .plus({ days })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/** Today's occurrence (in `tz`) of a local wall-clock time, plus its local date key. */
export function scheduledOccurrence(now: Date, localTime: string, tz: string): { at: Date; dateKey: string } {
  const [hour, minute] = localTime.split(':').map(Number);
  const local = DateTime.fromJSDate(now).setZone(tz);
  const today = local.set({ hour, minute, second: 0, millisecond: 0 });
  return { at: today.toUTC().toJSDate(), dateKey: today.toISODate()! };
}
