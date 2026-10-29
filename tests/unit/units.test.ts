import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { dueAfterDays, scheduledOccurrence, todayIn } from '../../src/common/dates';
import { decryptSecret, encryptSecret, hashToken } from '../../src/common/crypto';
import { normalizePhone } from '../../src/common/phone';
import { decryptFile, encryptFile, readKeyId } from '../../src/modules/backups/encryption';
import { backoffMs } from '../../src/modules/jobs/jobs.service';

describe('dates', () => {
  it('computes due dates on local calendar days at the configured local time', () => {
    // 23:30 Karachi on Nov 2 is 18:30Z; +1 day at 10:00 local = Nov 3 05:00Z.
    expect(dueAfterDays(new Date('2026-11-02T18:30:00Z'), 1, '10:00', 'Asia/Karachi').toISOString()).toBe('2026-11-03T05:00:00.000Z');
    // 00:30 Karachi on Nov 3 is still Nov 2 in UTC; local day wins.
    expect(dueAfterDays(new Date('2026-11-02T19:30:00Z'), 1, '10:00', 'Asia/Karachi').toISOString()).toBe('2026-11-04T05:00:00.000Z');
  });

  it('keeps local wall time across DST changes', () => {
    // US DST ends 2026-11-01.
    const d = dueAfterDays(new Date('2026-10-31T15:00:00Z'), 2, '09:00', 'America/New_York');
    expect(d.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('today and scheduled occurrence use the business timezone', () => {
    expect(todayIn('Asia/Karachi', new Date('2026-11-02T19:30:00Z'))).toBe('2026-11-03');
    expect(scheduledOccurrence(new Date('2026-11-02T19:30:00Z'), '02:00', 'Asia/Karachi')).toEqual({
      at: new Date('2026-11-02T21:00:00Z'),
      dateKey: '2026-11-03',
    });
  });
});

describe('crypto', () => {
  it('hashes tokens deterministically and encrypts secrets with authentication', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    const key = randomBytes(32);
    const sealed = encryptSecret('refresh-token', key);
    expect(decryptSecret(sealed, key)).toBe('refresh-token');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
  });

  it('encrypts and decrypts backup files, rejecting wrong keys and tampering', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptb-'));
    const src = path.join(dir, 'plain');
    const enc = path.join(dir, 'enc');
    const out = path.join(dir, 'out');
    const data = randomBytes(3 * 1024 * 1024 + 7);
    await fs.writeFile(src, data);
    const key = randomBytes(32);
    await encryptFile(src, enc, 'k2026', key);
    expect(await readKeyId(enc)).toBe('k2026');
    expect(await decryptFile(enc, out, { k2026: key })).toBe('k2026');
    expect((await fs.readFile(out)).equals(data)).toBe(true);

    await expect(decryptFile(enc, out + '2', { k2026: randomBytes(32) })).rejects.toThrow();
    await expect(decryptFile(enc, out + '3', {})).rejects.toThrow(/not available/);
    const bytes = await fs.readFile(enc);
    bytes[100] ^= 1;
    await fs.writeFile(enc, bytes);
    await expect(decryptFile(enc, out + '4', { k2026: key })).rejects.toThrow();
    await expect(fs.stat(out + '4')).rejects.toThrow(); // no unauthenticated plaintext left
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('phone normalization', () => {
  it('normalizes with the default country and rejects invalid numbers', () => {
    expect(normalizePhone('0300 1234567')).toBe('+923001234567');
    expect(normalizePhone('+92 300 1234567')).toBe('+923001234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('12')).toBeNull();
  });
});

describe('job backoff', () => {
  it('grows exponentially and is bounded', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(50)).toBe(3_600_000);
  });
});
