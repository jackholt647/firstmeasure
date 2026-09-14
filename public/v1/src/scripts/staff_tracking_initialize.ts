import { env } from '../config/env.js';
import { initializeTrackingSchema } from '../../staff_tracking/store.js';
import { closePostgresPools } from '../database/postgres.js';

// Development-only provisioning. Production activation requires a reviewed release.
if (process.argv[2] !== '--initialize-development' || !['development','test'].includes(env.dataEnvironment)) {
  throw new Error('Use --initialize-development with an explicitly isolated development/test environment. Production is not supported by this command.');
}
try {
  await initializeTrackingSchema();
  console.log('Development staff tracking tables and indexes are ready. No grants or historical events were imported.');
} finally { await closePostgresPools(); }
