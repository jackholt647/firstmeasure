import path from "node:path";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";

// The contact store. Raise schemaVersion with every table or column change, or
// Postgres hosts never run the new initialize.
let database: SqlStore | undefined;
export function contactStore() {
  return database ??= openSqlStore({ id: "contacts", filename: path.resolve(env.platformStorageRoot, "contacts.sqlite"), schemaVersion: 1, initialize: async db => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        organization_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', name_key TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]', time_zone TEXT NOT NULL DEFAULT '',
        custom_field_values_json TEXT NOT NULL DEFAULT '{}', extra_json TEXT NOT NULL DEFAULT '{}',
        merged_into TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS contacts_name ON contacts(organization_id, merged_into, name_key, id);
      CREATE INDEX IF NOT EXISTS contacts_updated ON contacts(organization_id, updated_at);
      CREATE TABLE IF NOT EXISTS contact_points (
        organization_id TEXT NOT NULL, contact_id TEXT NOT NULL, kind TEXT NOT NULL,
        value TEXT NOT NULL, normalized TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (organization_id, contact_id, kind, normalized)
      );
      CREATE INDEX IF NOT EXISTS contact_points_match ON contact_points(organization_id, kind, normalized);
      CREATE TABLE IF NOT EXISTS contact_branches (
        organization_id TEXT NOT NULL, contact_id TEXT NOT NULL, branch_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, contact_id, branch_id)
      );
      CREATE INDEX IF NOT EXISTS contact_branches_branch ON contact_branches(organization_id, branch_id, contact_id);
      CREATE TABLE IF NOT EXISTS contact_links (
        organization_id TEXT NOT NULL, project_id TEXT NOT NULL, contact_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '', is_primary INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, project_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS contact_links_contact ON contact_links(organization_id, contact_id, project_id);
    `);
  } });
}
