import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../../config';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { DriveIntegration } from './backup.models';
import { PermanentJobError } from '../jobs/jobs.service';

/** Where encrypted archives go. Abstracted so tests and restore drills can use a local directory. */
export interface BackupStore {
  readonly kind: 'drive' | 'local';
  ensureReady(): Promise<void>;
  /** Reconciliation: find an archive previously uploaded for this backup run. */
  findByRunId(runId: string): Promise<{ id: string; size: number } | null>;
  upload(file: string, name: string, runId: string, size: number, onProgress?: () => Promise<void>): Promise<{ id: string; size: number; md5?: string }>;
  download(id: string, dest: string): Promise<void>;
  delete(id: string): Promise<void>;
}

const APP_TAG = 'task-management-system';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ---------- Local directory store ----------

export class LocalDirStore implements BackupStore {
  readonly kind = 'local' as const;
  constructor(private readonly dir: string) {}
  async ensureReady() {
    await fs.mkdir(this.dir, { recursive: true });
  }
  async findByRunId(runId: string) {
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    const f = files.find((n) => n.includes(runId) && n.endsWith('.enc'));
    if (!f) return null;
    const st = await fs.stat(path.join(this.dir, f));
    return { id: f, size: st.size };
  }
  async upload(file: string, name: string) {
    await fs.copyFile(file, path.join(this.dir, name));
    const st = await fs.stat(path.join(this.dir, name));
    return { id: name, size: st.size };
  }
  async download(id: string, dest: string) {
    await fs.copyFile(path.join(this.dir, path.basename(id)), dest);
  }
  async delete(id: string) {
    await fs.rm(path.join(this.dir, path.basename(id)), { force: true });
  }
}

// ---------- Google Drive store ----------

export function driveConfigured(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI && config.DRIVE_TOKEN_ENCRYPTION_KEY);
}

export function oauthClient(): OAuth2Client {
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI) as unknown as OAuth2Client;
}

export function tokenKey(): Buffer {
  return Buffer.from(config.DRIVE_TOKEN_ENCRYPTION_KEY, 'base64');
}

export function sealRefreshToken(token: string): string {
  return encryptSecret(token, tokenKey());
}

function isAuthFailure(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
  return e?.response?.data?.error === 'invalid_grant' || e?.response?.status === 401 || /invalid_grant/.test(e?.message ?? '');
}

function isQuotaFailure(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } } };
  const reasons = e?.response?.data?.error?.errors?.map((x) => x.reason) ?? [];
  return reasons.includes('storageQuotaExceeded') || reasons.includes('quotaExceeded');
}

const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB, as the resumable protocol requires

export class GoogleDriveStore implements BackupStore {
  readonly kind = 'drive' as const;
  private client!: OAuth2Client;
  private folderId!: string;

  async ensureReady() {
    if (!driveConfigured()) throw new PermanentJobError('Google Drive is not configured on the server.');
    const integ = await DriveIntegration.findById('drive').select('+encryptedRefreshToken').lean();
    if (!integ || integ.status !== 'CONNECTED' || !integ.encryptedRefreshToken || !integ.folderId) {
      throw new PermanentJobError('Google Drive is not connected. Reconnect it in admin settings.');
    }
    this.client = oauthClient();
    this.client.setCredentials({ refresh_token: decryptSecret(integ.encryptedRefreshToken, tokenKey()) });
    this.folderId = integ.folderId;
    try {
      await this.client.getAccessToken();
    } catch (err) {
      await this.markNeedsReconnect(err);
      throw new PermanentJobError('Google Drive authorization was revoked or expired. Reconnect it in admin settings.');
    }
  }

  private async markNeedsReconnect(err: unknown) {
    if (isAuthFailure(err)) {
      await DriveIntegration.updateOne({ _id: 'drive' }, { $set: { status: 'NEEDS_RECONNECT', lastError: 'Authorization revoked or expired' } });
    }
  }

  private drive() {
    return google.drive({ version: 'v3', auth: this.client as never });
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isAuthFailure(err)) {
        await this.markNeedsReconnect(err);
        throw new PermanentJobError('Google Drive authorization was revoked. Reconnect it in admin settings.');
      }
      if (isQuotaFailure(err)) throw new Error('Google Drive storage quota exceeded.');
      throw err;
    }
  }

  async findByRunId(runId: string) {
    return this.wrap(async () => {
      const q = `'${this.folderId}' in parents and trashed = false and appProperties has { key='ptbRunId' and value='${runId.replace(/[^a-f0-9]/gi, '')}' }`;
      const r = await this.drive().files.list({ q, fields: 'files(id,size)', pageSize: 5, spaces: 'drive' });
      const f = r.data.files?.[0];
      return f?.id ? { id: f.id, size: Number(f.size ?? 0) } : null;
    });
  }

  /** Resumable upload in chunks; resumes from the server-acknowledged offset after interruptions. */
  async upload(file: string, name: string, runId: string, size: number, onProgress?: () => Promise<void>) {
    return this.wrap(async () => {
      const init = await this.client.request<unknown>({
        url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum',
        method: 'POST',
        headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size), 'Content-Type': 'application/json; charset=UTF-8' },
        data: { name, parents: [this.folderId], mimeType: 'application/octet-stream', appProperties: { ptbApp: APP_TAG, ptbRunId: runId } },
      });
      const location = (init.headers as unknown as Record<string, string>)['location'] ?? (init.headers as unknown as Headers).get?.('location');
      if (!location) throw new Error('Drive did not return a resumable upload URL');

      const fh = await fs.open(file, 'r');
      try {
        let offset = 0;
        let failures = 0;
        while (true) {
          const end = Math.min(offset + CHUNK, size);
          const buf = Buffer.alloc(end - offset);
          await fh.read(buf, 0, buf.length, offset);
          try {
            const res = await this.client.request<{ id: string; size: string; md5Checksum?: string }>({
              url: location,
              method: 'PUT',
              headers: { 'Content-Range': size === 0 ? 'bytes */0' : `bytes ${offset}-${end - 1}/${size}`, 'Content-Length': String(buf.length) },
              data: buf,
              validateStatus: (s) => s === 308 || (s >= 200 && s < 300),
            });
            if (res.status === 200 || res.status === 201) {
              return { id: res.data.id, size: Number(res.data.size), md5: res.data.md5Checksum };
            }
            offset = this.nextOffset(res.headers);
            failures = 0;
            if (onProgress) await onProgress();
          } catch (err) {
            if (isAuthFailure(err) || isQuotaFailure(err) || ++failures > 5) throw err;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
            // Ask the server how much it has before resending.
            const status = await this.client.request({
              url: location,
              method: 'PUT',
              headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
              validateStatus: (s) => s === 308 || (s >= 200 && s < 300),
            });
            if (status.status === 200 || status.status === 201) {
              const d = status.data as { id: string; size: string; md5Checksum?: string };
              return { id: d.id, size: Number(d.size), md5: d.md5Checksum };
            }
            offset = this.nextOffset(status.headers);
          }
        }
      } finally {
        await fh.close();
      }
    });
  }

  private nextOffset(headers: unknown): number {
    const h = headers as Record<string, string> & { get?: (k: string) => string | null };
    const range = h.get?.('range') ?? h['range'];
    if (!range) return 0;
    const m = /bytes=0-(\d+)/.exec(range);
    return m ? Number(m[1]) + 1 : 0;
  }

  async download(id: string, dest: string) {
    await this.wrap(async () => {
      const res = await this.drive().files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
      await pipeline(res.data as NodeJS.ReadableStream, createWriteStream(dest, { mode: 0o600 }));
    });
  }

  async delete(id: string) {
    await this.wrap(async () => {
      // Only files this app created are visible under the drive.file scope.
      const meta = await this.drive().files.get({ fileId: id, fields: 'id,appProperties' });
      if (meta.data.appProperties?.ptbApp !== APP_TAG) throw new Error('Refusing to delete a file not created by this application');
      await this.drive().files.delete({ fileId: id });
    });
  }
}

/** Create the dedicated private backup folder after OAuth succeeds. */
export async function createBackupFolder(client: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: client as never });
  const r = await drive.files.create({
    requestBody: { name: 'Task Management System Backups', mimeType: 'application/vnd.google-apps.folder', appProperties: { ptbApp: APP_TAG } },
    fields: 'id',
  });
  return r.data.id!;
}

let factory: () => BackupStore = () =>
  config.BACKUP_STORE === 'local' ? new LocalDirStore(path.resolve(config.BACKUP_LOCAL_DIR)) : new GoogleDriveStore();

export function getBackupStore(): BackupStore {
  return factory();
}

/** Test seam. */
export function setBackupStoreFactory(f: () => BackupStore) {
  factory = f;
}
