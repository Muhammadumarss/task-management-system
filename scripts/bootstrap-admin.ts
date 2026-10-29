/**
 * Bootstrap the first administrator. Operator-only; there are no default credentials.
 *
 *   npm run bootstrap-admin -- --username owner --name "Business Owner"
 *
 * Creates an INVITED admin and prints a one-time, expiring setup link. The operator opens
 * the link and chooses the password — it never passes through the command line or logs.
 * Also usable for admin recovery: with --recover, issues a fresh setup/reset link for an
 * existing admin account (see docs/runbooks/admin-recovery.md).
 */
import { parseArgs } from 'util';
import { connectDatabase, disconnectDatabase } from '../src/database/connection';
import { User, normalizeUsername } from '../src/modules/users/user.model';
import { issuePasswordToken } from '../src/modules/auth/auth.service';
import { revokeAllSessions } from '../src/modules/auth/session.service';
import { audit } from '../src/modules/audit/audit.service';
import { getSettings } from '../src/modules/settings/settings.service';

async function main() {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      name: { type: 'string' },
      recover: { type: 'boolean', default: false },
    },
  });
  if (!values.username) throw new Error('--username is required');
  await connectDatabase();
  await getSettings();
  const uname = normalizeUsername(values.username);

  if (values.recover) {
    const admin = await User.findOne({ usernameNormalized: uname, role: 'ADMIN' });
    if (!admin) throw new Error('No admin with that username');
    if (admin.status === 'INACTIVE') {
      admin.status = admin.get('passwordHash') ? 'ACTIVE' : 'INVITED';
      admin.version += 1;
      await admin.save();
    }
    await revokeAllSessions(admin._id);
    const purpose = admin.status === 'INVITED' ? 'SETUP' : 'RESET';
    const t = await issuePasswordToken(admin._id, purpose, null);
    await audit({ actorId: null, actorRole: 'OPERATOR', requestId: null, action: 'ADMIN_RECOVERY', entityType: 'user', entityId: admin._id });
    console.log(`\nRecovery link for "${admin.username}" (expires ${t.expiresAt.toISOString()}):\n\n  ${t.url}\n`);
    return;
  }

  if (!values.name) throw new Error('--name is required');
  const activeAdmins = await User.countDocuments({ role: 'ADMIN', status: { $in: ['ACTIVE', 'INVITED'] } });
  if (activeAdmins > 0) {
    throw new Error('An administrator already exists. Use the admin UI, or --recover for account recovery.');
  }
  const admin = await User.create({
    name: values.name,
    username: values.username,
    usernameNormalized: uname,
    role: 'ADMIN',
    status: 'INVITED',
    mustChangePassword: true,
  });
  const t = await issuePasswordToken(admin._id, 'SETUP', null);
  await audit({ actorId: null, actorRole: 'OPERATOR', requestId: null, action: 'ADMIN_BOOTSTRAPPED', entityType: 'user', entityId: admin._id });
  console.log(`\nAdmin "${admin.username}" created. Open this one-time link to set the password (expires ${t.expiresAt.toISOString()}):\n\n  ${t.url}\n`);
}

main()
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
