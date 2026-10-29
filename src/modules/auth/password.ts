import argon2 from 'argon2';
import { z } from 'zod';

// OWASP-recommended Argon2id baseline (19 MiB, t=2, p=1). Revisit on production hardware.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `must be at most ${PASSWORD_MAX} characters`);

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/** Verify a password. When there is no hash, verify against a dummy to keep timing similar. */
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= argon2.hash('dummy-password-for-timing', OPTIONS);
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
