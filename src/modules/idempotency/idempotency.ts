import { Request } from 'express';
import { AppError } from '../../common/errors';
import { clock } from '../../common/clock';
import { sha256Hex } from '../../common/crypto';
import { IdempotencyKey } from './idempotency.model';

const TTL_MS = 24 * 3600 * 1000;

export interface OperationResult<R> {
  status: number;
  body: unknown;
  /** Reference to the created/affected entity, stored for replay. Never customer data. */
  ref: R;
}

/** Stable JSON for request hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Execute an operation at most once per (actor, route, Idempotency-Key).
 *  - Same key + same request → `replay(ref)`, which re-reads through current authorization.
 *  - Same key + different request → 409.
 *  - Concurrent duplicate while the first is running → 409 (client should retry).
 * If the operation fails, the key is released so the client can retry with the same key.
 */
export async function idempotent<R>(
  req: Request,
  route: string,
  run: () => Promise<OperationResult<R>>,
  replay: (ref: R) => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replayed: boolean }> {
  const key = req.header('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8-128 URL-safe characters) is required.');
  }
  const actorId = req.auth!.userId;
  const requestHash = sha256Hex(canonical({ params: req.params, body: req.body }));
  const now = clock.now();

  try {
    await IdempotencyKey.create({
      actorId,
      route,
      key,
      requestHash,
      state: 'IN_PROGRESS',
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    const existing = await IdempotencyKey.findOne({ actorId, route, key }).lean();
    if (!existing) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this key is being processed. Retry shortly.');
    if (existing.requestHash !== requestHash) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
    }
    if (existing.state !== 'DONE') {
      throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this key is being processed. Retry shortly.');
    }
    const replayed = await replay(existing.operationRef as R);
    return { ...replayed, replayed: true };
  }

  try {
    const result = await run();
    await IdempotencyKey.updateOne(
      { actorId, route, key },
      { $set: { state: 'DONE', operationRef: result.ref, responseStatus: result.status } },
    );
    return { status: result.status, body: result.body, replayed: false };
  } catch (e) {
    await IdempotencyKey.deleteOne({ actorId, route, key, state: 'IN_PROGRESS' });
    throw e;
  }
}
