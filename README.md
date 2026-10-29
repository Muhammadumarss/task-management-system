# Task Management System — Backend

Node.js + TypeScript + Express + MongoDB (Mongoose) API and background worker, implementing the
*Backend Architecture and Implementation Plan v1.0*. One backend serves the React website and the future React Native app.

## Quick start

Requirements: Node.js 22+, a MongoDB **replica set** (transactions are required; Atlas or a local single-node replica set).

```bash
npm install
cp .env.example .env        # fill in MONGODB_URI, keys, origins
npm run create-indexes
npm run bootstrap-admin -- --username owner --name "Business Owner"   # prints a one-time setup link
npm run dev                 # API on PORT (default 4000)
npm run worker              # background worker (scheduled backups)
```

Run tests (downloads a MongoDB binary on first run and starts an in-memory replica set):

```bash
npm test
```

## Layout

| Path | Purpose |
|---|---|
| `src/app.ts`, `src/server.ts`, `src/worker.ts` | Express app, API process, worker process |
| `src/config/` | Zod-validated environment |
| `src/common/` | Errors, logging, clock, crypto, validation, pagination, transactions |
| `src/middleware/` | Authentication + CSRF, role gate, origin check, operator rejection, errors |
| `src/modules/auth` | Login, sessions, setup/reset tokens, password lifecycle |
| `src/modules/users` | Account administration |
| `src/modules/people` | Customer records and the 10-minute correction window |
| `src/modules/tasks` | Assignment, reassignment, completion, cancellation |
| `src/modules/reminders` | Follow-up policy snapshots and reminder lifecycle |
| `src/modules/dashboard`, `settings`, `audit`, `idempotency` | Supporting modules |
| `src/modules/jobs` | Durable jobs with atomic claims, leases, retries |
| `src/modules/backups` | Snapshot export, AES-256-GCM encryption, Drive OAuth + resumable upload, retention, restore |
| `scripts/` | `bootstrap-admin`, `create-indexes`, `restore-backup` |
| `docs/openapi.yaml`, `docs/runbooks/` | API spec and operator runbooks |

Each module has routes (HTTP/controller), a service (business rules) and models. The models act as the
data-access layer; there is no separate repository class.

## How key rules are enforced

- **Login screens:** `/auth/admin/login` and `/auth/user/login` check the account's stored role; a mismatch gets the same generic 401.
- **Sessions:** opaque random tokens, only SHA-256 hashes stored. Web: HttpOnly cookie + per-session CSRF token + origin allowlist. Mobile: bearer token. 30 min idle / 12 h absolute, checked in code on every request along with account status.
- **Correction window:** `editableUntil = server now + 10 min` at creation. Creator reads/edits use one conditional update on id + creator + ACTIVE + version + `editableUntil > now`. Editing never extends it. There is no TTL index on it — expiry changes access, never deletes data.
- **Tasks:** state changes are conditional, version-checked updates inside transactions, so completion vs. reassignment races produce one winner. Completed and cancelled tasks disappear from the user API.
- **Reminders:** created in the completion transaction from the task's policy snapshot (unique per source task). "Due" is a query (`SCHEDULED` and `dueAt <= now`), so no worker has to run on time. Assignment uses a conditional reminder update plus a partial unique index, so two admins can't create two follow-ups.
- **Idempotency:** required on submissions, task creation, completion and reminder assignment. Stores an operation reference, not customer data; replays re-read through current authorization.
- **Backups:** consistent snapshot-session export (or `mongodump --oplog` when `MONGODUMP_PATH` is set) → gzip → AES-256-GCM with key id → SHA-256 → resumable Drive upload into an app-created folder (`drive.file` scope). Lock, heartbeat, upload reconciliation by run id, retention limited to app-recorded files. Restore only via the operator script into an isolated database.

## Not yet implemented / decisions to confirm

- **MFA for admins** — recommended before production exposure.
- **Bulk "apply new follow-up policy to pending tasks/reminders"** with preview — settings changes only affect new tasks today. Per-task policy edits are supported.
- **Shared rate-limit store** — login throttling is in-memory (fine for one API instance).
- **Email/SMS delivery** of setup/reset links — the admin gets the link and delivers it.
- The Google Drive integration is written against the Drive v3 API but **has not been exercised against a real Google account**; tests use the local-directory store. Verify with a staging Google project before launch.
- Follow-up tasks are assignable to active `USER` accounts only (not admins).
