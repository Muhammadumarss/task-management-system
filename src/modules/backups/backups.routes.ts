import { Router } from 'express';
import { z } from 'zod';
import { h } from '../../common/http';
import { parse } from '../../common/validation';
import { AppError } from '../../common/errors';
import { clock } from '../../common/clock';
import { hashToken, randomToken, safeEqual } from '../../common/crypto';
import { pageMeta, paginationQuery, skip } from '../../common/pagination';
import { ctxOf } from '../../common/context';
import { config } from '../../config';
import { logger } from '../../common/logger';
import { auditCtx } from '../audit/audit.service';
import { BackupRun, DriveIntegration } from './backup.models';
import { queueManualBackup } from './backup.service';
import { createBackupFolder, DRIVE_SCOPE, driveConfigured, oauthClient, sealRefreshToken, tokenKey } from './store';
import { decryptSecret } from '../../common/crypto';
import { jobStats } from '../jobs/jobs.service';

// ----- /api/v1/admin/backups -----
export const backupsAdminRouter = Router();

backupsAdminRouter.get(
  '/',
  h(async (req, res) => {
    const q = parse(paginationQuery, req.query);
    const [items, total, lastSuccess, jobs] = await Promise.all([
      BackupRun.find().sort({ startedAt: -1 }).skip(skip(q)).limit(q.limit).lean(),
      BackupRun.countDocuments(),
      BackupRun.findOne({ status: 'SUCCEEDED' }).sort({ finishedAt: -1 }).lean(),
      jobStats(),
    ]);
    res.json({
      lastSuccessAt: lastSuccess?.finishedAt ?? null,
      jobs,
      items: items.map((r) => ({
        id: String(r._id),
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        method: r.method,
        format: r.format,
        fileName: r.fileName,
        fileSize: r.fileSize,
        checksumSha256: r.checksumSha256,
        keyId: r.keyId,
        driveFileId: r.driveFileId,
        deletedFromDriveAt: r.deletedFromDriveAt,
        collections: r.collections,
        errorSummary: r.errorSummary,
      })),
      ...pageMeta(q, total),
    });
  }),
);

backupsAdminRouter.post(
  '/',
  h(async (req, res) => {
    const ctx = ctxOf(req);
    if (config.BACKUP_STORE === 'drive') {
      const integ = await DriveIntegration.findById('drive').lean();
      if (integ?.status !== 'CONNECTED') {
        throw new AppError(409, 'INTEGRATION_NOT_CONFIGURED', 'Connect Google Drive before running a backup.');
      }
    }
    const r = await queueManualBackup(ctx.actorId);
    await auditCtx(ctx, 'BACKUP_REQUESTED', 'job', r.jobId, { alreadyQueued: r.alreadyQueued });
    res.status(202).json(r);
  }),
);

// ----- /api/v1/admin/integrations/drive -----
export const driveAdminRouter = Router();

driveAdminRouter.get(
  '/status',
  h(async (_req, res) => {
    const integ = await DriveIntegration.findById('drive').lean();
    res.json({
      serverConfigured: driveConfigured(),
      status: integ?.status ?? 'DISCONNECTED',
      folderId: integ?.folderId ?? null,
      connectedAt: integ?.connectedAt ?? null,
      lastError: integ?.lastError ?? null,
    });
  }),
);

/** Start server-side OAuth (offline access, drive.file scope). State is random, single-use, admin-bound. */
driveAdminRouter.post(
  '/connect',
  h(async (req, res) => {
    if (!driveConfigured()) throw new AppError(409, 'INTEGRATION_NOT_CONFIGURED', 'Google OAuth is not configured on the server.');
    const ctx = ctxOf(req);
    const state = randomToken();
    await DriveIntegration.updateOne(
      { _id: 'drive' },
      {
        $set: { oauthStateHash: hashToken(state), oauthStateExpiresAt: new Date(clock.now().getTime() + 10 * 60_000), oauthStartedBy: ctx.actorId },
        $setOnInsert: { status: 'DISCONNECTED' },
      },
      { upsert: true },
    );
    const url = oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [DRIVE_SCOPE],
      state,
      include_granted_scopes: false,
    });
    await auditCtx(ctx, 'DRIVE_CONNECT_STARTED', 'integration', 'drive');
    res.json({ authUrl: url });
  }),
);

const callbackQuery = z.object({
  state: z.string().min(20).max(200),
  code: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
});

driveAdminRouter.get(
  '/callback',
  h(async (req, res) => {
    const ctx = ctxOf(req);
    const q = parse(callbackQuery, req.query);
    const integ = await DriveIntegration.findById('drive').lean();
    const valid =
      integ?.oauthStateHash &&
      safeEqual(integ.oauthStateHash, hashToken(q.state)) &&
      integ.oauthStateExpiresAt &&
      integ.oauthStateExpiresAt.getTime() > clock.now().getTime() &&
      String(integ.oauthStartedBy) === String(ctx.actorId);
    // Single use: clear state whatever happens next.
    await DriveIntegration.updateOne({ _id: 'drive' }, { $set: { oauthStateHash: null, oauthStateExpiresAt: null } });
    const redirect = (result: string) => res.redirect(302, `${config.WEB_BASE_URL}/admin/settings/backups?drive=${result}`);
    if (!valid) return redirect('invalid_state');
    if (q.error || !q.code) return redirect('denied');

    try {
      const client = oauthClient();
      const { tokens } = await client.getToken(q.code);
      if (!tokens.refresh_token) return redirect('no_refresh_token');
      client.setCredentials(tokens);
      const folderId = integ.folderId ?? (await createBackupFolder(client));
      await DriveIntegration.updateOne(
        { _id: 'drive' },
        { $set: { status: 'CONNECTED', encryptedRefreshToken: sealRefreshToken(tokens.refresh_token), folderId, connectedAt: clock.now(), lastError: null } },
      );
      await auditCtx(ctx, 'DRIVE_CONNECTED', 'integration', 'drive');
      return redirect('connected');
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'drive oauth exchange failed');
      return redirect('error');
    }
  }),
);

driveAdminRouter.post(
  '/disconnect',
  h(async (req, res) => {
    const ctx = ctxOf(req);
    const integ = await DriveIntegration.findById('drive').select('+encryptedRefreshToken').lean();
    if (integ?.encryptedRefreshToken && driveConfigured()) {
      try {
        await oauthClient().revokeToken(decryptSecret(integ.encryptedRefreshToken, tokenKey()));
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'drive token revocation failed; removing locally anyway');
      }
    }
    await DriveIntegration.updateOne(
      { _id: 'drive' },
      { $set: { status: 'DISCONNECTED', encryptedRefreshToken: null, connectedAt: null } },
      { upsert: true },
    );
    await auditCtx(ctx, 'DRIVE_DISCONNECTED', 'integration', 'drive');
    res.json({ status: 'DISCONNECTED' });
  }),
);
