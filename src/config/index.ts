import 'dotenv/config';
import { z } from 'zod';
import { IANAZone } from 'luxon';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be a base64-encoded 32-byte key');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1),
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
  BUSINESS_TIMEZONE: z
    .string()
    .default('Asia/Karachi')
    .refine((tz) => IANAZone.isValidZone(tz), 'invalid IANA timezone'),
  DEFAULT_PHONE_COUNTRY: z.string().length(2).default('PK'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECURE: bool,
  TRUST_PROXY: bool,
  SETUP_TOKEN_HOURS: z.coerce.number().int().positive().default(72),
  RESET_TOKEN_MINUTES: z.coerce.number().int().positive().default(60),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),
  DRIVE_TOKEN_ENCRYPTION_KEY: z.union([base64Key, z.literal('')]).optional().default(''),
  BACKUP_ENCRYPTION_KEYS: z
    .string()
    .optional()
    .default('{}')
    .transform((v, ctx) => {
      try {
        const parsed = JSON.parse(v) as Record<string, string>;
        const out: Record<string, Buffer> = {};
        for (const [id, key] of Object.entries(parsed)) {
          const buf = Buffer.from(key, 'base64');
          if (buf.length !== 32) {
            // Placeholder values are allowed in development; they are rejected when used.
            continue;
          }
          out[id] = buf;
        }
        return out;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BACKUP_ENCRYPTION_KEYS must be JSON' });
        return z.NEVER;
      }
    }),
  BACKUP_ACTIVE_KEY_ID: z.string().optional().default(''),
  BACKUP_TMP_DIR: z.string().default('./tmp/backups'),
  MONGODUMP_PATH: z.string().optional().default(''),
  // "drive" in staging/production. "local" writes encrypted archives to BACKUP_LOCAL_DIR (dev/restore drills).
  BACKUP_STORE: z.enum(['drive', 'local']).default('drive'),
  BACKUP_LOCAL_DIR: z.string().default('./tmp/backup-store'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // Fail fast at startup; never print values (they may be secrets).
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = result.data;
  if (cfg.NODE_ENV === 'production') {
    if (!cfg.COOKIE_SECURE) throw new Error('Invalid configuration: COOKIE_SECURE must be true in production');
    if (cfg.ALLOWED_ORIGINS.length === 0) throw new Error('Invalid configuration: ALLOWED_ORIGINS is required in production');
  }
  return cfg;
}

export const config: Config = load();

/** The 10-minute correction window is a confirmed product requirement, not a setting. */
export const CORRECTION_WINDOW_MS = 10 * 60 * 1000;
