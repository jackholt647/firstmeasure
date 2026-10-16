import { env } from '../config/env.js';
import { listOrganizations } from '../../platform/storage.js';
import { migrateOrganizationContacts, removeStandaloneContactRecords } from '../../contacts/migration.js';
import { closeSqlStores } from '../../platform/sql_store.js';
import { closePostgresPools } from '../database/postgres.js';

// Copies contacts embedded in projects into the contact store, then removes the standalone
// (`contact_only`) project records they lived in (docs/architecture/contacts.md).
// Development and test only; production activation requires a reviewed release.
if (process.argv[2] !== '--migrate-development' || !['development', 'test'].includes(env.dataEnvironment)) {
  throw new Error('Use --migrate-development with an explicitly isolated development/test environment. Production is not supported by this command.');
}
try {
  for (const organization of await listOrganizations()) {
    const id = String((organization as Record<string, unknown>).id || '');
    if (!id) continue;
    console.log(id, JSON.stringify({ ...(await migrateOrganizationContacts(id)), ...(await removeStandaloneContactRecords(id)) }));
  }
} finally { await closeSqlStores(); await closePostgresPools(); }
