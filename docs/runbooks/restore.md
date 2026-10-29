# Runbook: restore from backup

MongoDB is the live source of truth; backups are encrypted recovery archives. There is no HTTP restore endpoint — restores are operator actions.

## Prerequisites
- The backup decryption key for the backup's `keyId` (kept **outside** Drive, with a separately secured recovery copy).
- An **isolated, empty** replica set or database to restore into (never restore directly over production).
- Application config/secrets restored separately — database backups cannot recreate them.

## Procedure
1. **Select a backup.** In the admin UI (or `GET /api/v1/admin/backups`), pick a `SUCCEEDED` run. Note its id, `fileName`, `fileSize`, `checksumSha256`, `keyId` and `finishedAt`.
2. **Download, verify, decrypt, restore into isolation:**
   ```bash
   npm run restore-backup -- --run <backupRunId> --target-uri "<isolated-uri>" --target-db task_management_restore
   ```
   Or, with a file downloaded manually from Drive:
   ```bash
   npm run restore-backup -- --file ./ptb-backup-....enc --sha256 <checksum> --target-uri "<isolated-uri>" --target-db task_management_restore
   ```
   The script verifies the SHA-256 checksum, decrypts (AES-256-GCM, authenticated), checks per-collection counts against the archive manifest, then **revokes all restored sessions and password tokens** and **quarantines restored background jobs**.
   - Backups taken with `mongodump` (`method: mongodump`): decrypt with the same tooling, then `mongorestore --gzip --archive=<file> --oplogReplay` into the isolated deployment, then apply the same session/token/job clean-up (see `src/modules/backups/restore.ts`).
3. **Recreate indexes** on the restored database: `MONGODB_URI=<isolated-uri-with-db> npm run create-indexes`.
4. **Verify:** collection counts, indexes, references (tasks → people/users, reminders → tasks), and representative workflows (log in as a test admin via a fresh reset link, list people, open tasks, due reminders).
5. **Reconcile:** review restored reminders (they are recomputed from dates, so overdue ones appear immediately) and `backupRuns` records so retention does not act on files that no longer match.
6. **Safety backup** of current production before any replacement (`POST /api/v1/admin/backups`, wait for success).
7. **Switch over** during an approved maintenance window: stop API and worker, point `MONGODB_URI` at the verified database, start the API.
8. **Smoke test**, then start the worker only after reconciliation. Users must log in again (all sessions were revoked).

## Restore drills
Run a full drill before launch and periodically (e.g. quarterly) using `BACKUP_STORE=local` or a staging Drive folder. Record the measured recovery time; do not promise an untested recovery-time objective.
