# Runbook: deployment and operations

## Processes
- **API:** `npm run build && npm start` (`dist/src/server.js`). Stateless; run behind HTTPS with `TRUST_PROXY=true` when a proxy terminates TLS.
- **Worker:** `npm run start:worker` (`dist/src/worker.js`). Runs scheduled backups. Several workers are safe (atomic claims, leases, unique occurrence keys) but one is enough.
- Run both under a supervisor with automatic restart. Separate development, staging and production environments, databases and Drive folders.

## Release steps
1. CI: `npm run typecheck && npm test`, `npm audit`, OpenAPI validation (e.g. `npx @redocly/cli lint docs/openapi.yaml`).
2. Apply index changes explicitly: `npm run create-indexes -- --dry`, review, then `npm run create-indexes`. Production does not auto-create indexes.
3. Deploy the API, then the worker. Check `/health/ready`.
4. Rollback: redeploy the previous immutable artifact. Keep schema changes backward compatible so the previous version can run on the new data.

## Configuration
See `.env.example`. Required in production: `MONGODB_URI` (replica set), `ALLOWED_ORIGINS`, `COOKIE_SECURE=true`, Google OAuth settings, `DRIVE_TOKEN_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEYS` + `BACKUP_ACTIVE_KEY_ID`. Configuration is validated at startup; the process exits on invalid values without printing them.

Generate a 32-byte key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Monitoring (minimum)
- API error rate/latency, `/health/ready`.
- Failed logins (`LOGIN_FAILED` audit events), `ACCESS_DENIED` events.
- Jobs: `GET /api/v1/admin/backups` → `jobs` (`pendingDue`, `oldestPendingAgeSeconds`, `expiredLeases`, `failed`); worker logs `job lag detected`.
- Last successful backup: admin dashboard `backups.stale` is true after 36h without success. Alert on it.
- Restore drill status (record date and measured time).

## Scaling notes
Login throttling and per-IP rate limits are in-memory. When running more than one API instance, move them to a shared store (Redis or a MongoDB collection).
