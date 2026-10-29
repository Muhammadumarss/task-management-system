import { z } from 'zod';
import { Types } from 'mongoose';
import { DateTime } from 'luxon';
import { badRequest } from './errors';

export const objectId = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v) && /^[a-f\d]{24}$/i.test(v), 'must be a valid id');

/** Calendar date in YYYY-MM-DD form; interpreted in the business timezone. */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((v) => DateTime.fromISO(v).isValid, 'must be a real calendar date');

/** Bounded plain text: trimmed, no control characters. */
export const text = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v), 'contains invalid characters');

export const version = z.number().int().nonnegative();

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'The request is invalid.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Escape a user-supplied string for use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
