import { z } from 'zod';
import { dateOnly, objectId, text } from '../../common/validation';
import { normalizePhone } from '../../common/phone';
import { paginationQuery, sortParam } from '../../common/pagination';

export const phoneInput = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .transform((v, c) => {
    const normalized = normalizePhone(v);
    if (!normalized) {
      c.addIssue({ code: 'custom', message: 'must be a valid phone number (include country code if outside the default country)' });
      return z.NEVER;
    }
    return { original: v, normalized };
  });

export const locationInput = z
  .strictObject({
    addressText: text(300).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .refine((l) => (l.latitude === undefined) === (l.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
  })
  .refine((l) => l.addressText || l.latitude !== undefined, { message: 'location must include an address or coordinates' });

/** Explicit allowlist: createdBy, role, deadline and status are server-controlled. */
export const createPersonBody = z.strictObject({
  name: text(120, 1),
  phone: phoneInput,
  requestedWorkDate: dateOnly,
  location: locationInput.optional(),
});

export const updatePersonBody = z
  .strictObject({
    version: z.number().int().nonnegative(),
    name: text(120, 1).optional(),
    phone: phoneInput.optional(),
    requestedWorkDate: dateOnly.optional(),
    location: locationInput.nullable().optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'version'), { message: 'no fields to update' });

export type CreatePersonInput = z.infer<typeof createPersonBody>;
export type UpdatePersonInput = z.infer<typeof updatePersonBody>;

export const adminListQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  possibleDuplicate: z.enum(['true', 'false']).optional(),
  createdBy: objectId.optional(),
  workDateFrom: dateOnly.optional(),
  workDateTo: dateOnly.optional(),
  sort: sortParam(['createdAt', 'name', 'requestedWorkDate'] as const, '-createdAt'),
});
