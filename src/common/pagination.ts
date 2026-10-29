import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function pageMeta(p: Pagination, total: number) {
  return { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) };
}

export function skip(p: Pagination): number {
  return (p.page - 1) * p.limit;
}

/** Allowlisted sort parsing: "field" or "-field". */
export function sortParam<T extends string>(allowed: readonly T[], fallback: `${'-' | ''}${T}`) {
  return z
    .string()
    .optional()
    .default(fallback)
    .refine((v) => allowed.includes(v.replace(/^-/, '') as T), `sort must be one of: ${allowed.join(', ')}`)
    .transform((v) => {
      const desc = v.startsWith('-');
      return { [v.replace(/^-/, '')]: desc ? -1 : 1 } as Record<string, 1 | -1>;
    });
}
