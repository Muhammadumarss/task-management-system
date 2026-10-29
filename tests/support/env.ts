import { inject } from 'vitest';
import { randomBytes } from 'crypto';

// Must run before any src module loads its config.
const base = inject('mongoUri');
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = base;
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.WEB_BASE_URL = 'http://localhost:5173';
process.env.BUSINESS_TIMEZONE = 'Asia/Karachi';
process.env.COOKIE_SECURE = 'false';
process.env.BACKUP_STORE = 'local';
process.env.BACKUP_ENCRYPTION_KEYS = JSON.stringify({ test1: randomBytes(32).toString('base64') });
process.env.BACKUP_ACTIVE_KEY_ID = 'test1';
process.env.BACKUP_TMP_DIR = `./tmp/test-${process.pid}/work`;
process.env.BACKUP_LOCAL_DIR = `./tmp/test-${process.pid}/store`;
