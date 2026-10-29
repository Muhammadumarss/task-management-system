# Runbook: first admin and admin recovery

## Bootstrap (first deployment)
```bash
npm run bootstrap-admin -- --username owner --name "Business Owner"
```
Creates an `INVITED` admin and prints a one-time setup link (expires after `SETUP_TOKEN_HOURS`). Open it and set the password. There are no default credentials, and the command refuses to run if an admin already exists.

## Recovery (admin locked out, forgot password, or deactivated)
Operator with database access runs:
```bash
npm run bootstrap-admin -- --username owner --recover
```
This reactivates the admin if needed, revokes all of its sessions, writes an `ADMIN_RECOVERY` audit event and prints a fresh setup/reset link. Deliver it to the account owner over a secure channel; never paste it into tickets or chat logs.

## Notes
- The API refuses to deactivate or demote the last active admin.
- Role changes use `POST /api/v1/admin/users/:id/change-role` (reason required, audited, sessions revoked).
- Recommend MFA for admin accounts before production exposure (not yet implemented).
