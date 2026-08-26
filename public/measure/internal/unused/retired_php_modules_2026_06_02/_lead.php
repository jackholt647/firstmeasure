<?php
require_once __DIR__ . '/_storage.php';

const LEAD_SCHEMA_MAINTENANCE_VERSION = '2026-04-27-hotpath-1';

function leadDbPath() {
    return storageExistingPath('databases/leads.sqlite', __DIR__ . '/leads.sqlite', true);
}

function leadSchemaMetaEnsure(SQLite3 $db) {
    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_schema_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
        )
    ");
}

function leadSchemaMetaGet(SQLite3 $db, $key) {
    leadSchemaMetaEnsure($db);
    $stmt = $db->prepare('SELECT meta_value FROM lead_schema_meta WHERE meta_key = :meta_key LIMIT 1');
    $stmt->bindValue(':meta_key', (string)$key, SQLITE3_TEXT);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return $row ? (string)($row['meta_value'] ?? '') : '';
}

function leadSchemaMetaSet(SQLite3 $db, $key, $value) {
    leadSchemaMetaEnsure($db);
    $stmt = $db->prepare("
        INSERT INTO lead_schema_meta (meta_key, meta_value, updated_at)
        VALUES (:meta_key, :meta_value, :updated_at)
        ON CONFLICT(meta_key) DO UPDATE SET
            meta_value = excluded.meta_value,
            updated_at = excluded.updated_at
    ");
    $stmt->bindValue(':meta_key', (string)$key, SQLITE3_TEXT);
    $stmt->bindValue(':meta_value', (string)$value, SQLITE3_TEXT);
    $stmt->bindValue(':updated_at', time(), SQLITE3_INTEGER);
    $stmt->execute();
}

function leadEnsureColumn(SQLite3 $db, $table, $column, $definition) {
    $res = $db->query("PRAGMA table_info($table)");
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        if (($row['name'] ?? '') === $column) return;
    }
    $db->exec("ALTER TABLE $table ADD COLUMN $column $definition");
}

function leadDb() {
    static $db = null;
    if ($db instanceof SQLite3) return $db;
    if (!class_exists('SQLite3')) {
        throw new Exception('SQLite3 extension not available');
    }

    $db = new SQLite3(leadDbPath());
    $db->busyTimeout(5000);
    $db->exec('PRAGMA journal_mode=WAL;');
    $db->exec('PRAGMA synchronous=NORMAL;');
    $db->exec('PRAGMA foreign_keys=ON;');

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_lists (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            region TEXT NOT NULL DEFAULT '',
            region_code TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT 'manual',
            source_kind TEXT NOT NULL DEFAULT '',
            source_key TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            assigned_to_email TEXT NOT NULL DEFAULT '',
            assigned_by_email TEXT NOT NULL DEFAULT '',
            exported_at INTEGER,
            exported_by_email TEXT NOT NULL DEFAULT '',
            exported_count INTEGER NOT NULL DEFAULT 0,
            lead_count INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_entities (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL DEFAULT '',
            external_key TEXT NOT NULL DEFAULT '',
            region TEXT NOT NULL DEFAULT '',
            region_code TEXT NOT NULL DEFAULT '',
            lead_name TEXT NOT NULL DEFAULT '',
            company TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            address TEXT NOT NULL DEFAULT '',
            city TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT '',
            postal_code TEXT NOT NULL DEFAULT '',
            website TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT
        )
    ");

    leadMigrateLegacyLeadStorage($db);

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_memberships (
            id TEXT PRIMARY KEY,
            list_id TEXT NOT NULL,
            lead_entity_id TEXT NOT NULL DEFAULT '',
            organization_id TEXT NOT NULL DEFAULT '',
            external_key TEXT NOT NULL DEFAULT '',
            region TEXT NOT NULL DEFAULT '',
            region_code TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            lead_name TEXT NOT NULL DEFAULT '',
            company TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            address TEXT NOT NULL DEFAULT '',
            city TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT '',
            postal_code TEXT NOT NULL DEFAULT '',
            website TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            assigned_to_email TEXT NOT NULL DEFAULT '',
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT,
            FOREIGN KEY(list_id) REFERENCES lead_lists(id) ON DELETE CASCADE,
            FOREIGN KEY(lead_entity_id) REFERENCES lead_entities(id) ON DELETE CASCADE
        )
    ");

    leadCreateLeadsCompatibilityView($db);

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_exports (
            id TEXT PRIMARY KEY,
            list_id TEXT NOT NULL,
            exported_by_email TEXT NOT NULL DEFAULT '',
            exported_at INTEGER NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT,
            FOREIGN KEY(list_id) REFERENCES lead_lists(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_notes (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            owner_email TEXT NOT NULL DEFAULT '',
            note_text TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_followups (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            list_id TEXT NOT NULL DEFAULT '',
            owner_email TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            due_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'open',
            priority TEXT NOT NULL DEFAULT 'normal',
            completed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_dial_events (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            owner_email TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            context_json TEXT,
            dialed_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_contacts (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            owner_email TEXT NOT NULL DEFAULT '',
            full_name TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_contact_notes (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            contact_id TEXT NOT NULL,
            owner_email TEXT NOT NULL DEFAULT '',
            note_text TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE,
            FOREIGN KEY(contact_id) REFERENCES lead_contacts(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_dial_event_contacts (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            dial_event_id TEXT NOT NULL,
            contact_id TEXT NOT NULL,
            owner_email TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE,
            FOREIGN KEY(contact_id) REFERENCES lead_contacts(id) ON DELETE CASCADE
        )
    ");

    leadSchemaMetaEnsure($db);
    $schemaReady = leadSchemaMetaGet($db, 'schema_maintenance_version') === LEAD_SCHEMA_MAINTENANCE_VERSION;
    if (!$schemaReady) {
    $db->exec('BEGIN IMMEDIATE');
    try {
    $schemaReady = leadSchemaMetaGet($db, 'schema_maintenance_version') === LEAD_SCHEMA_MAINTENANCE_VERSION;
    if (!$schemaReady) {

    leadEnsureColumn($db, 'lead_entities', 'external_key', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_entities', 'organization_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_entities', 'website', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_memberships', 'lead_entity_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_memberships', 'external_key', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_memberships', 'organization_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_memberships', 'website', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'type', "TEXT NOT NULL DEFAULT 'manual'");
    leadEnsureColumn($db, 'lead_lists', 'source_kind', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'source_key', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'assigned_to_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'assigned_by_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'exported_at', 'INTEGER');
    leadEnsureColumn($db, 'lead_lists', 'exported_by_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'exported_count', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_lists', 'lead_count', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_notes', 'dial_event_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_followups', 'dial_event_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_followups', 'metadata_json', 'TEXT');
    leadEnsureColumn($db, 'lead_dial_events', 'event_token', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dial_events', 'selected_contact_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dial_events', 'selected_contact_unknown', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_contacts', 'metadata_json', 'TEXT');

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_activity_items (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            owner_email TEXT NOT NULL DEFAULT '',
            activity_type TEXT NOT NULL DEFAULT '',
            direction TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL DEFAULT '',
            body_text TEXT NOT NULL DEFAULT '',
            related_id TEXT NOT NULL DEFAULT '',
            metadata_json TEXT,
            happened_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT,
            FOREIGN KEY(lead_id) REFERENCES lead_memberships(id) ON DELETE CASCADE
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_dashboard_tasks (
            id TEXT PRIMARY KEY,
            owner_email TEXT NOT NULL DEFAULT '',
            assigned_to_email TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            due_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'open',
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS lead_import_runs (
            id TEXT PRIMARY KEY,
            import_type TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL DEFAULT '',
            preview_token TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'previewed',
            total_rows INTEGER NOT NULL DEFAULT 0,
            matched_rows INTEGER NOT NULL DEFAULT 0,
            unmatched_rows INTEGER NOT NULL DEFAULT 0,
            created_records INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            created_by_email TEXT,
            updated_by_email TEXT
        )
    ");

    leadEnsureColumn($db, 'lead_dashboard_tasks', 'owner_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'assigned_to_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'title', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'due_at', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'status', "TEXT NOT NULL DEFAULT 'open'");
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'metadata_json', 'TEXT');
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'created_by_email', 'TEXT');
    leadEnsureColumn($db, 'lead_dashboard_tasks', 'updated_by_email', 'TEXT');
    leadEnsureColumn($db, 'lead_import_runs', 'import_type', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_import_runs', 'filename', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_import_runs', 'preview_token', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_import_runs', 'status', "TEXT NOT NULL DEFAULT 'previewed'");
    leadEnsureColumn($db, 'lead_import_runs', 'total_rows', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_import_runs', 'matched_rows', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_import_runs', 'unmatched_rows', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_import_runs', 'created_records', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_import_runs', 'metadata_json', 'TEXT');
    leadEnsureColumn($db, 'lead_import_runs', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_import_runs', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_import_runs', 'created_by_email', 'TEXT');
    leadEnsureColumn($db, 'lead_import_runs', 'updated_by_email', 'TEXT');

    foreach ([
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_region_sort ON lead_lists(region, sort_order, name)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_type_region ON lead_lists(type, region, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_assigned ON lead_lists(assigned_to_email, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_status ON lead_lists(status, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_source ON lead_lists(source_kind, source_key)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_updated_at ON lead_lists(updated_at)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_lists_unique_source ON lead_lists(source_kind, source_key) WHERE source_kind <> \'\' AND source_key <> \'\'',
        'CREATE INDEX IF NOT EXISTS idx_lead_entities_external_key ON lead_entities(external_key)',
        'CREATE INDEX IF NOT EXISTS idx_lead_entities_organization_id ON lead_entities(organization_id)',
        'CREATE INDEX IF NOT EXISTS idx_lead_entities_region ON lead_entities(region)',
        'CREATE INDEX IF NOT EXISTS idx_lead_entities_region_code ON lead_entities(region_code)',
        'CREATE INDEX IF NOT EXISTS idx_lead_entities_updated_at ON lead_entities(updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_lead_entities_company ON lead_entities(company COLLATE NOCASE)',
        'CREATE INDEX IF NOT EXISTS idx_leads_list_id ON lead_memberships(list_id)',
        'CREATE INDEX IF NOT EXISTS idx_leads_external_key ON lead_memberships(external_key)',
        'CREATE INDEX IF NOT EXISTS idx_leads_organization_id ON lead_memberships(organization_id)',
        'CREATE INDEX IF NOT EXISTS idx_leads_region ON lead_memberships(region)',
        'CREATE INDEX IF NOT EXISTS idx_leads_region_code ON lead_memberships(region_code)',
        'CREATE INDEX IF NOT EXISTS idx_leads_status ON lead_memberships(status)',
        'CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON lead_memberships(assigned_to_email)',
        'CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON lead_memberships(updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_leads_list_region ON lead_memberships(list_id, region)',
        'CREATE INDEX IF NOT EXISTS idx_leads_list_updated ON lead_memberships(list_id, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_leads_company ON lead_memberships(company COLLATE NOCASE)',
        'CREATE INDEX IF NOT EXISTS idx_lead_memberships_entity_id ON lead_memberships(lead_entity_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_memberships_list_entity ON lead_memberships(list_id, lead_entity_id)',
        'CREATE INDEX IF NOT EXISTS idx_lead_exports_list_id ON lead_exports(list_id, exported_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_exports_email ON lead_exports(exported_by_email, exported_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_created ON lead_notes(lead_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_notes_owner_created ON lead_notes(owner_email, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_notes_dial_event ON lead_notes(dial_event_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_followups_owner_status_due ON lead_followups(owner_email, status, due_at)',
        'CREATE INDEX IF NOT EXISTS idx_lead_followups_lead_status_due ON lead_followups(lead_id, status, due_at)',
        'CREATE INDEX IF NOT EXISTS idx_lead_followups_list_status_due ON lead_followups(list_id, status, due_at)',
        'CREATE INDEX IF NOT EXISTS idx_lead_followups_dial_event ON lead_followups(dial_event_id, due_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead_updated ON lead_contacts(lead_id, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_contacts_owner_updated ON lead_contacts(owner_email, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_contact_notes_contact_created ON lead_contact_notes(contact_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_contact_notes_lead_created ON lead_contact_notes(lead_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dial_event_contacts_dial ON lead_dial_event_contacts(dial_event_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dial_event_contacts_contact ON lead_dial_event_contacts(contact_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dial_events_lead_dialed ON lead_dial_events(lead_id, dialed_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dial_events_owner_dialed ON lead_dial_events(owner_email, dialed_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dial_events_event_token ON lead_dial_events(lead_id, owner_email, source, event_token)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_dial_events_unique_token ON lead_dial_events(lead_id, owner_email, source, event_token) WHERE event_token <> \'\'',
        'CREATE INDEX IF NOT EXISTS idx_lead_activity_items_lead_happened ON lead_activity_items(lead_id, happened_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_activity_items_related ON lead_activity_items(lead_id, activity_type, related_id)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dashboard_tasks_owner ON lead_dashboard_tasks(owner_email, status, due_at)',
        'CREATE INDEX IF NOT EXISTS idx_lead_dashboard_tasks_assigned ON lead_dashboard_tasks(assigned_to_email, status, due_at)',
        'CREATE INDEX IF NOT EXISTS idx_lead_import_runs_type_created ON lead_import_runs(import_type, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_import_runs_preview_token ON lead_import_runs(preview_token)'
    ] as $sql) {
        $db->exec($sql);
    }

    leadBackfillLeadEntitiesFromMemberships($db);
    leadBackfillOrganizationIds($db);
    leadCreateLeadsCompatibilityView($db);
    leadSchemaMetaSet($db, 'schema_maintenance_version', LEAD_SCHEMA_MAINTENANCE_VERSION);

    }
    $db->exec('COMMIT');
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }
    }
    return $db;
}

function leadActorEmail() {
    return strtolower(trim((string)($_SESSION['user_email'] ?? '')));
}

function leadActorData() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $email = leadActorEmail();
    $cached = ($email !== '' && function_exists('readUserDataByEmail'))
        ? readUserDataByEmail($email)
        : null;
    return $cached;
}

function leadActorPerms() {
    $u = leadActorData();
    return is_array($u['permissions'] ?? null) ? $u['permissions'] : [];
}

function leadUserDisplayNameByEmail($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('readUserDataByEmail')) return '';
    $user = readUserDataByEmail($email);
    if (!is_array($user)) return '';
    return trim((string)($user['name'] ?? ''));
}

function canAccessLeadSystem() {
    $email = leadActorEmail();
    if ($email === '') return false;
    $u = leadActorData();
    if (!is_array($u)) return false;
    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'customer') return false;
    return true;
}

function leadRequireAccess() {
    if (!canAccessLeadSystem()) {
        die(json_encode(['success' => false, 'error' => 'Unauthorized']));
    }
}

function leadCanManageLists() {
    $perms = leadActorPerms();
    if (
        !empty($perms['manage_users']) ||
        !empty($perms['manage_sales_users']) ||
        !empty($perms['create_users']) ||
        !empty($perms['sales_view_all_callers_list_progress']) ||
        !empty($perms['sales_manage_manual_lead_lists']) ||
        !empty($perms['sales_manage_caller_accounts']) ||
        !empty($perms['sales_manage_sequence_templates']) ||
        !empty($perms['sales_manage_email_templates'])
    ) {
        return true;
    }
    $role = strtolower(trim((string)(leadActorData()['role'] ?? '')));
    return in_array($role, ['admin', 'lead', 'sales_manager'], true);
}

function leadId($prefix = 'lead') {
    return $prefix . '_' . bin2hex(random_bytes(8));
}

function leadText($key, $fallback = '') {
    return trim((string)($_POST[$key] ?? $fallback));
}

function leadInt($key, $fallback = 0) {
    return (int)($_POST[$key] ?? $fallback);
}

function leadJson($key) {
    $raw = trim((string)($_POST[$key] ?? ''));
    if ($raw === '') return null;
    $tmp = json_decode($raw, true);
    return json_last_error() === JSON_ERROR_NONE ? $tmp : null;
}

function leadNormalizeStatus($val, $fallback) {
    $val = strtolower(trim((string)$val));
    if ($val === '') return $fallback;
    return preg_replace('/[^a-z0-9_\-]/', '', $val) ?: $fallback;
}

function leadNormalizeType($val, $fallback = 'manual') {
    $val = strtolower(trim((string)$val));
    if ($val === '') return $fallback;
    return in_array($val, ['manual', 'territory', 'daily', 'followup'], true) ? $val : $fallback;
}

function leadNormalizeRegion($val) {
    return trim((string)$val);
}

function leadBindText($stmt, $key, $value) {
    $stmt->bindValue($key, (string)$value, SQLITE3_TEXT);
}

function leadFinalizeResult($res) {
    if ($res instanceof SQLite3Result) {
        $res->finalize();
    }
}

function leadDecodeJsonRowField($row, $key) {
    $raw = $row[$key] ?? null;
    if (!is_string($raw) || trim($raw) === '') return null;
    $data = json_decode($raw, true);
    return json_last_error() === JSON_ERROR_NONE ? $data : null;
}

function leadJsonEncode($value) {
    if ($value === null) return null;
    $flags = 0;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    if (defined('JSON_UNESCAPED_UNICODE')) $flags |= JSON_UNESCAPED_UNICODE;
    $json = json_encode($value, $flags);
    return $json === false ? null : $json;
}

function leadMetadataArray($row) {
    if (is_array($row['metadata'] ?? null)) return $row['metadata'];
    $decoded = leadDecodeJsonRowField($row, 'metadata_json');
    return is_array($decoded) ? $decoded : [];
}

function leadMetadataValue($row) {
    return leadMetadataArray($row);
}

function leadSetMetadataNestedValue($meta, array $path, $value) {
    $meta = is_array($meta) ? $meta : [];
    if (!$path) return $meta;
    $cursor =& $meta;
    $last = count($path) - 1;
    foreach ($path as $idx => $segment) {
        $segment = (string)$segment;
        if ($segment === '') continue;
        if ($idx === $last) {
            if ($value === null) {
                if (is_array($cursor) && array_key_exists($segment, $cursor)) unset($cursor[$segment]);
            } else {
                $cursor[$segment] = $value;
            }
            break;
        }
        if (!isset($cursor[$segment]) || !is_array($cursor[$segment])) $cursor[$segment] = [];
        $cursor =& $cursor[$segment];
    }
    return $meta;
}

function leadUpdateLeadMetadata(SQLite3 $db, $leadId, $metadata, $actor, $now) {
    $leadRow = leadRowById($db, $leadId);
    if (!$leadRow) return false;
    $entityId = trim((string)($leadRow['lead_entity_id'] ?? ''));
    if ($entityId === '') return false;
    $json = leadJsonEncode(is_array($metadata) ? $metadata : []);
    $stmt = $db->prepare("
        UPDATE lead_entities
        SET metadata_json = :metadata_json,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    if ($json === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $json);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $entityId);
    $ok = (bool)$stmt->execute();
    if ($ok) leadSyncMembershipCacheFromEntity($db, $entityId, $actor, $now);
    return $ok;
}

function leadNormalizeStageStatus($val, $fallback = 'contacted') {
    $normalized = strtolower(trim((string)$val));
    $normalized = str_replace(['&', '/', '.'], ' ', $normalized);
    $normalized = preg_replace('/[^a-z0-9]+/', '_', $normalized);
    $normalized = trim((string)$normalized, '_');
    $map = [
        'new' => 'new',
        'attempted_contact' => 'attempted_contact',
        'attempted' => 'attempted_contact',
        'contacted' => 'contacted',
        'decision_maker' => 'decision_maker',
        'info_sent' => 'info_sent',
        'infosent' => 'info_sent',
        'info_received' => 'info_received',
        'inforeceived' => 'info_received',
        'signed_up' => 'signed_up',
        'signedup' => 'signed_up',
        'do_not_contact' => 'do_not_contact',
        'dnc' => 'do_not_contact',
    ];
    if ($normalized !== '' && isset($map[$normalized])) return $map[$normalized];
    return $fallback !== '' ? leadNormalizeStageStatus($fallback, 'contacted') : 'contacted';
}

function leadStageLabel($status) {
    static $labels = [
        'new' => 'New',
        'attempted_contact' => 'Attempted Contact',
        'contacted' => 'Contacted',
        'decision_maker' => 'Decision Maker',
        'info_sent' => 'Info Sent',
        'info_received' => 'Info Received',
        'signed_up' => 'Signed Up',
        'do_not_contact' => 'Do Not Contact',
    ];
    $normalized = leadNormalizeStageStatus($status, 'contacted');
    return $labels[$normalized] ?? ucwords(str_replace('_', ' ', $normalized));
}

function leadUpdateStage(SQLite3 $db, $leadId, $stage, $actor, $now) {
    $normalized = leadNormalizeStageStatus($stage, 'contacted');
    $stmt = $db->prepare("
        UPDATE lead_memberships
        SET status = :status,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    leadBindText($stmt, ':status', $normalized);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $leadId);
    return (bool)$stmt->execute();
}

function leadMaybeAutoAdvanceStage(SQLite3 $db, $leadRow, $targetStage, $reason, $now, $metaExtra = []) {
    $leadRow = is_array($leadRow) ? $leadRow : [];
    $leadId = trim((string)($leadRow['id'] ?? ''));
    if ($leadId === '') return ['success' => false, 'error' => 'Lead not found'];

    $actor = strtolower(trim((string)($metaExtra['actor'] ?? ($leadRow['updated_by_email'] ?? $leadRow['assigned_to_email'] ?? $leadRow['created_by_email'] ?? 'system'))));
    $previous = leadNormalizeStageStatus($leadRow['status'] ?? 'contacted', 'contacted');
    $next = leadNormalizeStageStatus($targetStage, $previous);
    if ($next === '' || $next === $previous) {
        return ['success' => true, 'changed' => false, 'stage' => $previous];
    }
    if (leadAnalyticsStageRank($previous) >= leadAnalyticsStageRank($next)) {
        return ['success' => true, 'changed' => false, 'stage' => $previous];
    }
    if (!leadUpdateStage($db, $leadId, $next, $actor, $now)) {
        return ['success' => false, 'error' => 'Could not auto-advance stage'];
    }

    $meta = leadMetadataArray($leadRow);
    if (!isset($meta['crm']) || !is_array($meta['crm'])) $meta['crm'] = [];
    $sequence = leadSequenceTemplateForStage($next);
    $meta['crm']['active_sequence'] = $sequence ? [
        'sequence_key' => $sequence['sequence_key'],
        'sequence_label' => $sequence['sequence_label'],
        'status' => 'active',
        'next_step' => 'Waiting for next touch',
        'pause_reason' => '',
        'updated_at' => (int)$now,
    ] : null;
    if (!leadUpdateLeadMetadata($db, $leadId, $meta, $actor, $now)) {
        return ['success' => false, 'error' => 'Could not update auto-stage metadata'];
    }

    $activityMeta = array_merge([
        'from' => leadStageLabel($previous),
        'to' => leadStageLabel($next),
        'trigger' => (string)($metaExtra['trigger'] ?? 'automation'),
        'automatic' => true,
    ], is_array($metaExtra) ? $metaExtra : []);
    unset($activityMeta['actor']);

    leadInsertActivity($db, $leadId, $actor, [
        'activity_type' => 'stage',
        'subject' => leadStageLabel($next),
        'body_text' => trim((string)$reason),
        'metadata' => $activityMeta,
        'happened_at' => (int)$now,
    ], $now);

    return ['success' => true, 'changed' => true, 'stage' => $next];
}

function leadActivityRowByRelatedId(SQLite3 $db, $leadId, $activityType, $relatedId) {
    $leadId = trim((string)$leadId);
    $activityType = trim((string)$activityType);
    $relatedId = trim((string)$relatedId);
    if ($leadId === '' || $activityType === '' || $relatedId === '') return null;
    $stmt = $db->prepare("
        SELECT *
        FROM lead_activity_items
        WHERE lead_id = :lead_id
          AND activity_type = :activity_type
          AND related_id = :related_id
        LIMIT 1
    ");
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':activity_type', $activityType);
    leadBindText($stmt, ':related_id', $relatedId);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    if (!$row) return null;
    $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
    return $row;
}

function leadInsertActivity(SQLite3 $db, $leadId, $actor, $payload, $now) {
    $payload = is_array($payload) ? $payload : [];
    $metadataJson = null;
    if (array_key_exists('metadata', $payload)) {
        $metadataJson = leadJsonEncode(is_array($payload['metadata']) ? $payload['metadata'] : []);
    }
    $stmt = $db->prepare("
        INSERT INTO lead_activity_items (
            id, lead_id, owner_email, activity_type, direction, subject, body_text,
            related_id, metadata_json, happened_at, created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, :lead_id, :owner_email, :activity_type, :direction, :subject, :body_text,
            :related_id, :metadata_json, :happened_at, :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    $id = trim((string)($payload['id'] ?? ''));
    if ($id === '') $id = leadId('activity');
    leadBindText($stmt, ':id', $id);
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':owner_email', (string)($payload['owner_email'] ?? $actor));
    leadBindText($stmt, ':activity_type', (string)($payload['activity_type'] ?? 'note'));
    leadBindText($stmt, ':direction', (string)($payload['direction'] ?? ''));
    leadBindText($stmt, ':subject', (string)($payload['subject'] ?? ''));
    leadBindText($stmt, ':body_text', (string)($payload['body_text'] ?? ''));
    leadBindText($stmt, ':related_id', (string)($payload['related_id'] ?? ''));
    if ($metadataJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metadataJson);
    $happenedAt = (int)($payload['happened_at'] ?? $now);
    $stmt->bindValue(':happened_at', $happenedAt, SQLITE3_INTEGER);
    $stmt->bindValue(':created_at', (int)$now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':created_by_email', $actor);
    leadBindText($stmt, ':updated_by_email', $actor);
    return (bool)$stmt->execute();
}

function leadActivityRows(SQLite3 $db, $leadId, $limit = 250) {
    $stmt = $db->prepare("
        SELECT *
        FROM lead_activity_items
        WHERE lead_id = :lead_id
        ORDER BY happened_at DESC, created_at DESC
        LIMIT :limit
    ");
    leadBindText($stmt, ':lead_id', $leadId);
    $stmt->bindValue(':limit', max(1, min(500, (int)$limit)), SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
        $rows[] = $row;
    }
    return $rows;
}

function leadEchoJson($payload) {
    $flags = 0;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    if (defined('JSON_UNESCAPED_UNICODE')) $flags |= JSON_UNESCAPED_UNICODE;
    $json = json_encode($payload, $flags);
    if ($json === false) {
        echo json_encode(['success' => false, 'error' => 'Could not encode response']);
        return;
    }
    echo $json;
}

function leadRunJsonGuard($label, $callback) {
    $previous = set_error_handler(function($severity, $message, $file, $line) {
        if (!(error_reporting() & $severity)) return false;
        throw new ErrorException($message, 0, $severity, $file, $line);
    });
    try {
        return $callback();
    } catch (Throwable $e) {
        error_log('[lead-json-guard][' . $label . '] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        leadEchoJson([
            'success' => false,
            'error' => $label . ' failed: ' . $e->getMessage(),
        ]);
        return true;
    } finally {
        restore_error_handler();
    }
}

function leadDbObjectType(SQLite3 $db, $name) {
    $stmt = $db->prepare("
        SELECT type
        FROM sqlite_master
        WHERE name = :name
          AND type IN ('table', 'view')
        LIMIT 1
    ");
    leadBindText($stmt, ':name', $name);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return strtolower(trim((string)($row['type'] ?? '')));
}

function leadDbHasColumn(SQLite3 $db, $table, $column) {
    $res = $db->query("PRAGMA table_info($table)");
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        if (($row['name'] ?? '') === $column) return true;
    }
    return false;
}

function leadCreateLeadsCompatibilityView(SQLite3 $db) {
    $type = leadDbObjectType($db, 'leads');
    if ($type === 'table') return;
    if ($type === 'view') $db->exec('DROP VIEW IF EXISTS leads');
    $db->exec("
        CREATE VIEW IF NOT EXISTS leads AS
        SELECT
            id,
            list_id,
            lead_entity_id,
            organization_id,
            external_key,
            region,
            region_code,
            status,
            lead_name,
            company,
            email,
            phone,
            address,
            city,
            state,
            postal_code,
            website,
            notes,
            source,
            assigned_to_email,
            metadata_json,
            created_at,
            updated_at,
            created_by_email,
            updated_by_email
        FROM lead_memberships
    ");
}

function leadMigrateLegacyLeadStorage(SQLite3 $db) {
    if (leadDbObjectType($db, 'leads') !== 'table') return;
    if (leadDbObjectType($db, 'lead_memberships') === 'table') return;

    $db->exec('PRAGMA foreign_keys=OFF');
    $db->exec('BEGIN IMMEDIATE');
    try {
        $db->exec('ALTER TABLE leads RENAME TO lead_memberships');
        leadEnsureColumn($db, 'lead_memberships', 'lead_entity_id', "TEXT NOT NULL DEFAULT ''");
        $db->exec("
            CREATE TABLE IF NOT EXISTS lead_entities (
                id TEXT PRIMARY KEY,
                organization_id TEXT NOT NULL DEFAULT '',
                external_key TEXT NOT NULL DEFAULT '',
                region TEXT NOT NULL DEFAULT '',
                region_code TEXT NOT NULL DEFAULT '',
                lead_name TEXT NOT NULL DEFAULT '',
                company TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                address TEXT NOT NULL DEFAULT '',
                city TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL DEFAULT '',
                postal_code TEXT NOT NULL DEFAULT '',
                website TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                created_by_email TEXT,
                updated_by_email TEXT
            )
        ");
        $db->exec("
            INSERT OR IGNORE INTO lead_entities (
                id, organization_id, external_key, region, region_code, lead_name, company, email, phone, address,
                city, state, postal_code, website, notes, source, metadata_json,
                created_at, updated_at, created_by_email, updated_by_email
            )
            SELECT
                id, organization_id, external_key, region, region_code, lead_name, company, email, phone, address,
                city, state, postal_code, website, notes, source, metadata_json,
                created_at, updated_at, created_by_email, updated_by_email
            FROM lead_memberships
        ");
        $db->exec("UPDATE lead_memberships SET lead_entity_id = id WHERE COALESCE(lead_entity_id, '') = ''");
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        $db->exec('PRAGMA foreign_keys=ON');
        throw $e;
    }
    $db->exec('PRAGMA foreign_keys=ON');
}

function leadBackfillLeadEntitiesFromMemberships(SQLite3 $db) {
    if (leadDbObjectType($db, 'lead_memberships') !== 'table' || leadDbObjectType($db, 'lead_entities') !== 'table') {
        return;
    }
    if (!leadDbHasColumn($db, 'lead_memberships', 'company')) return;

    $res = $db->query("
        SELECT m.*
        FROM lead_memberships m
        LEFT JOIN lead_entities e ON e.id = m.lead_entity_id
        WHERE COALESCE(m.lead_entity_id, '') = ''
           OR e.id IS NULL
    ");
    if (!$res) return;

    $insert = $db->prepare("
        INSERT OR IGNORE INTO lead_entities (
            id, organization_id, external_key, region, region_code, lead_name, company, email, phone, address,
            city, state, postal_code, website, notes, source, metadata_json,
            created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, :organization_id, :external_key, :region, :region_code, :lead_name, :company, :email, :phone, :address,
            :city, :state, :postal_code, :website, :notes, :source, :metadata_json,
            :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    $update = $db->prepare('UPDATE lead_memberships SET lead_entity_id = :lead_entity_id WHERE id = :id');
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $entityId = trim((string)($row['lead_entity_id'] ?? ''));
        if ($entityId === '') $entityId = trim((string)($row['id'] ?? ''));
        if ($entityId === '') continue;

        leadBindText($insert, ':id', $entityId);
        leadBindText($insert, ':organization_id', (string)($row['organization_id'] ?? ''));
        leadBindText($insert, ':external_key', (string)($row['external_key'] ?? ''));
        leadBindText($insert, ':region', (string)($row['region'] ?? ''));
        leadBindText($insert, ':region_code', (string)($row['region_code'] ?? ''));
        leadBindText($insert, ':lead_name', (string)($row['lead_name'] ?? ''));
        leadBindText($insert, ':company', (string)($row['company'] ?? ''));
        leadBindText($insert, ':email', (string)($row['email'] ?? ''));
        leadBindText($insert, ':phone', (string)($row['phone'] ?? ''));
        leadBindText($insert, ':address', (string)($row['address'] ?? ''));
        leadBindText($insert, ':city', (string)($row['city'] ?? ''));
        leadBindText($insert, ':state', (string)($row['state'] ?? ''));
        leadBindText($insert, ':postal_code', (string)($row['postal_code'] ?? ''));
        leadBindText($insert, ':website', (string)($row['website'] ?? ''));
        leadBindText($insert, ':notes', (string)($row['notes'] ?? ''));
        leadBindText($insert, ':source', (string)($row['source'] ?? ''));
        $metaJson = (string)($row['metadata_json'] ?? '');
        if ($metaJson === '') $insert->bindValue(':metadata_json', null, SQLITE3_NULL);
        else leadBindText($insert, ':metadata_json', $metaJson);
        $insert->bindValue(':created_at', (int)($row['created_at'] ?? time()), SQLITE3_INTEGER);
        $insert->bindValue(':updated_at', (int)($row['updated_at'] ?? time()), SQLITE3_INTEGER);
        leadBindText($insert, ':created_by_email', (string)($row['created_by_email'] ?? ''));
        leadBindText($insert, ':updated_by_email', (string)($row['updated_by_email'] ?? ''));
        $insert->execute();

        leadBindText($update, ':lead_entity_id', $entityId);
        leadBindText($update, ':id', (string)($row['id'] ?? ''));
        $update->execute();
    }
}

function leadBackfillOrganizationIds(SQLite3 $db) {
    $res = $db->query("
        SELECT id, metadata_json
        FROM lead_entities
        WHERE organization_id = ''
          AND metadata_json <> ''
    ");
    if (!$res) return;

    $stmt = $db->prepare("
        UPDATE lead_entities
        SET organization_id = :organization_id
        WHERE id = :id
          AND organization_id = ''
    ");
    $changed = [];
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $metadata = leadDecodeJsonRowField($row, 'metadata_json');
        if (!is_array($metadata)) continue;
        $orgId = trim((string)($metadata['organization_id'] ?? ''));
        if ($orgId === '') continue;
        leadBindText($stmt, ':organization_id', $orgId);
        leadBindText($stmt, ':id', (string)($row['id'] ?? ''));
        $stmt->execute();
        $changed[(string)($row['id'] ?? '')] = true;
    }
    foreach (array_keys($changed) as $entityId) {
        leadSyncMembershipCacheFromEntity($db, $entityId);
    }
}

function leadLegacyBaseDir() {
    return storageDir('lists/data/fetcher');
}

function leadLegacyFiltersDir() {
    return leadLegacyBaseDir() . 'filters/';
}

function leadLegacyDetailsDir() {
    return leadLegacyBaseDir() . 'details/';
}

function leadLegacyTilesDir() {
    return leadLegacyBaseDir() . 'tiles/';
}

function leadLegacySafeName($name) {
    $name = preg_replace('/[^A-Za-z0-9._-]+/', '_', (string)$name);
    return trim($name, '_');
}

function leadLegacyFilterFile($listName) {
    return leadLegacyFiltersDir() . leadLegacySafeName($listName) . '.json';
}

function leadLegacyFilterLists() {
    $rows = [];
    foreach (glob(leadLegacyFiltersDir() . '*.json') as $path) {
        $data = json_decode((string)@file_get_contents($path), true);
        if (!is_array($data)) continue;
        $rows[] = [
            'list_name' => (string)($data['list_name'] ?? basename($path, '.json')),
            'count' => (int)($data['count'] ?? count($data['place_ids'] ?? [])),
            'created_at' => (string)($data['created_at'] ?? ''),
            'filter' => is_array($data['filter'] ?? null) ? $data['filter'] : [],
        ];
    }
    usort($rows, function($a, $b) {
        return strcmp((string)$a['list_name'], (string)$b['list_name']);
    });
    return $rows;
}

function leadLegacyDetailByPlaceId($placeId) {
    $path = leadLegacyDetailsDir() . leadLegacySafeName($placeId) . '.json';
    if (!file_exists($path)) return [];
    $data = json_decode((string)@file_get_contents($path), true);
    return is_array($data) ? $data : [];
}

function leadLegacyRawBusinessesByPlaceIds($placeIds) {
    $need = [];
    foreach ($placeIds as $placeId) {
        $placeId = trim((string)$placeId);
        if ($placeId !== '') $need[$placeId] = true;
    }
    if (!$need) return [];

    $found = [];
    foreach (glob(leadLegacyTilesDir() . '*.json') as $path) {
        $tile = json_decode((string)@file_get_contents($path), true);
        if (!is_array($tile)) continue;
        $tileKey = (string)($tile['tile_key'] ?? basename($path, '.json'));
        foreach (($tile['places'] ?? []) as $place) {
            $placeId = trim((string)($place['place_id'] ?? ''));
            if ($placeId === '' || !isset($need[$placeId]) || isset($found[$placeId])) continue;
            if (!is_array($place)) $place = [];
            $place['_tile'] = $tileKey;
            $found[$placeId] = $place;
            if (count($found) >= count($need)) break 2;
        }
    }
    return $found;
}

function leadLegacyParseStateZip($value) {
    $value = trim((string)$value);
    $state = '';
    $zip = '';
    if ($value !== '' && preg_match('/\b(\d{5})(?:-\d{4})?\b/', $value, $m)) {
        $zip = $m[1];
    }
    if ($value !== '' && preg_match('/\b([A-Z]{2})\b/', strtoupper($value), $m)) {
        $abbr = strtoupper($m[1]);
        static $stateAbbrs = [
            'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
            'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
            'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
        ];
        if (in_array($abbr, $stateAbbrs, true)) $state = $abbr;
    }
    return ['state' => $state, 'zip' => $zip];
}

function leadRegionCodeFromName($region) {
    $region = trim((string)$region);
    if ($region === '') return '';
    $stateMap = [
        'alabama' => 'AL', 'alaska' => 'AK', 'arizona' => 'AZ', 'arkansas' => 'AR', 'california' => 'CA',
        'colorado' => 'CO', 'connecticut' => 'CT', 'delaware' => 'DE', 'florida' => 'FL', 'georgia' => 'GA',
        'hawaii' => 'HI', 'idaho' => 'ID', 'illinois' => 'IL', 'indiana' => 'IN', 'iowa' => 'IA',
        'kansas' => 'KS', 'kentucky' => 'KY', 'louisiana' => 'LA', 'maine' => 'ME', 'maryland' => 'MD',
        'massachusetts' => 'MA', 'michigan' => 'MI', 'minnesota' => 'MN', 'mississippi' => 'MS', 'missouri' => 'MO',
        'montana' => 'MT', 'nebraska' => 'NE', 'nevada' => 'NV', 'new hampshire' => 'NH', 'new jersey' => 'NJ',
        'new mexico' => 'NM', 'new york' => 'NY', 'north carolina' => 'NC', 'north dakota' => 'ND', 'ohio' => 'OH',
        'oklahoma' => 'OK', 'oregon' => 'OR', 'pennsylvania' => 'PA', 'rhode island' => 'RI', 'south carolina' => 'SC',
        'south dakota' => 'SD', 'tennessee' => 'TN', 'texas' => 'TX', 'utah' => 'UT', 'vermont' => 'VT',
        'virginia' => 'VA', 'washington' => 'WA', 'west virginia' => 'WV', 'wisconsin' => 'WI', 'wyoming' => 'WY'
    ];
    $key = strtolower($region);
    if (isset($stateMap[$key])) return $stateMap[$key];
    if (preg_match('/\b([A-Z]{2})\b/', $region, $m)) return strtoupper($m[1]);
    return strtoupper(substr(preg_replace('/[^A-Za-z]/', '', $region), 0, 2));
}

function leadStateFromAddress($address, $fallback = '') {
    $address = trim((string)$address);
    if ($address !== '' && preg_match('/,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?(?:,|$)/', $address, $m)) {
        return strtoupper($m[1]);
    }
    return strtoupper(trim((string)$fallback));
}

function leadCityFromAddress($address) {
    $parts = array_map('trim', explode(',', (string)$address));
    if (count($parts) >= 2) return $parts[count($parts) - 2];
    return '';
}

function leadCsvEscape($value) {
    $s = str_replace('"', '""', (string)$value);
    return '"' . $s . '"';
}

function leadBuildCsvLinesFromRows(array $rows) {
    $headers = ['Name', 'Email', 'Phone', 'Website', 'Address', 'City', 'State', 'Zip', 'Region', 'Notes', 'Source', 'Callback URL'];
    $csvLines = [implode(',', array_map('leadCsvEscape', $headers))];
    foreach ($rows as $row) {
        $csvLines[] = implode(',', array_map('leadCsvEscape', [
            $row['company'] ?? '',
            $row['email'] ?? '',
            $row['phone'] ?? '',
            $row['website'] ?? '',
            $row['address'] ?? '',
            $row['city'] ?? '',
            $row['state'] ?? '',
            $row['postal_code'] ?? '',
            $row['region_code'] ?: ($row['region'] ?? ''),
            $row['notes'] ?? '',
            $row['source'] ?? '',
            leadCallbackUrl($row['id'] ?? '')
        ]));
    }
    return implode("\r\n", $csvLines) . "\r\n";
}

function leadPublicBaseUrl() {
    $scheme = 'http';
    $https = strtolower((string)($_SERVER['HTTPS'] ?? ''));
    $forwardedProto = strtolower(trim((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')));
    if ($https === 'on' || $https === '1' || $forwardedProto === 'https') $scheme = 'https';
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '') return '';
    $scriptName = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/server.php'));
    $basePath = rtrim(str_replace('/server.php', '', $scriptName), '/');
    return $scheme . '://' . $host . ($basePath !== '' ? $basePath : '');
}

function leadCallbackUrl($leadId, $source = 'orum') {
    $leadId = trim((string)$leadId);
    if ($leadId === '') return '';
    $base = leadPublicBaseUrl();
    $query = http_build_query([
        'lead_id' => $leadId,
        'source' => $source,
    ]);
    if ($base === '') return 'lead_callback.php?' . $query;
    return rtrim($base, '/') . '/lead_callback.php?' . $query;
}

function leadListRowById(SQLite3 $db, $id) {
    $stmt = $db->prepare("
        SELECT
            ll.*,
            (SELECT COUNT(1) FROM leads l WHERE l.list_id = ll.id) AS computed_lead_count
        FROM lead_lists ll
        WHERE ll.id = :id
        LIMIT 1
    ");
    leadBindText($stmt, ':id', $id);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    leadFinalizeResult($res);
    if ($row) {
        $row['list_assigned_to_name'] = leadUserDisplayNameByEmail($row['list_assigned_to_email'] ?? '');
    }
    return $row;
}

function leadListCanView($listRow) {
    if (!is_array($listRow)) return false;
    $actor = leadActorEmail();
    if ($actor === '') return false;
    if (leadCanManageLists()) return true;
    $assigned = strtolower(trim((string)($listRow['assigned_to_email'] ?? '')));
    return $assigned !== '' && $assigned === $actor;
}

function leadListCanExport($listRow) {
    if (!is_array($listRow)) return false;
    $actor = leadActorEmail();
    if ($actor === '') return false;
    if (leadCanManageLists()) return true;
    $assigned = strtolower(trim((string)($listRow['assigned_to_email'] ?? '')));
    return $assigned !== '' && $assigned === $actor;
}

function leadRequireListView($listRow) {
    if (!leadListCanView($listRow)) {
        die(json_encode(['success' => false, 'error' => 'Unauthorized for this list']));
    }
}

function leadSyncListLeadCount(SQLite3 $db, $listId) {
    $stmt = $db->prepare('SELECT COUNT(1) AS c FROM leads WHERE list_id = :list_id');
    leadBindText($stmt, ':list_id', $listId);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : ['c' => 0];
    leadFinalizeResult($res);
    $count = (int)($row['c'] ?? 0);
    $up = $db->prepare('UPDATE lead_lists SET lead_count = :lead_count, updated_at = :updated_at WHERE id = :id');
    $up->bindValue(':lead_count', $count, SQLITE3_INTEGER);
    $up->bindValue(':updated_at', time(), SQLITE3_INTEGER);
    leadBindText($up, ':id', $listId);
    $up->execute();
    return $count;
}

function leadRowById(SQLite3 $db, $id) {
    $stmt = $db->prepare("
        SELECT
            l.*,
            ll.name AS list_name,
            ll.type AS list_type,
            ll.assigned_to_email AS list_assigned_to_email,
            ll.exported_at AS list_exported_at,
            ll.exported_by_email AS list_exported_by_email
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE l.id = :id
        LIMIT 1
    ");
    leadBindText($stmt, ':id', $id);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    leadFinalizeResult($res);
    return $row;
}

function leadCanViewLeadRow($leadRow) {
    if (!is_array($leadRow)) return false;
    if (leadCanManageLists()) return true;
    $actor = leadActorEmail();
    if ($actor === '') return false;
    $assigned = strtolower(trim((string)($leadRow['list_assigned_to_email'] ?? $leadRow['assigned_to_email'] ?? '')));
    return $assigned !== '' && $assigned === $actor;
}

function leadRequireLeadView($leadRow) {
    if (!leadCanViewLeadRow($leadRow)) {
        die(json_encode(['success' => false, 'error' => 'Unauthorized for this lead']));
    }
}

function leadNoteRows(SQLite3 $db, $leadId) {
    $stmt = $db->prepare('SELECT * FROM lead_notes WHERE lead_id = :lead_id ORDER BY created_at DESC');
    leadBindText($stmt, ':lead_id', $leadId);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
    return $rows;
}

function leadFollowupRows(SQLite3 $db, $leadId) {
    $stmt = $db->prepare('SELECT * FROM lead_followups WHERE lead_id = :lead_id ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, due_at ASC, created_at DESC');
    leadBindText($stmt, ':lead_id', $leadId);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
        $rows[] = $row;
    }
    return $rows;
}

function leadDialEventRows(SQLite3 $db, $leadId, $limit = 20) {
    $limit = max(1, min(100, (int)$limit));
    $stmt = $db->prepare('SELECT * FROM lead_dial_events WHERE lead_id = :lead_id ORDER BY dialed_at DESC LIMIT :limit');
    leadBindText($stmt, ':lead_id', $leadId);
    $stmt->bindValue(':limit', $limit, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['context'] = leadDecodeJsonRowField($row, 'context_json');
        $rows[] = $row;
    }
    return $rows;
}

function leadContactRows(SQLite3 $db, $leadId) {
    $stmt = $db->prepare('SELECT * FROM lead_contacts WHERE lead_id = :lead_id ORDER BY updated_at DESC, created_at DESC');
    leadBindText($stmt, ':lead_id', $leadId);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
        $row['secondary_emails'] = array_values(array_filter(array_map('strval', (array)($row['metadata']['secondary_emails'] ?? []))));
        $row['secondary_phones'] = array_values(array_filter(array_map('strval', (array)($row['metadata']['secondary_phones'] ?? []))));
        $rows[] = $row;
    }
    $hasPrimary = false;
    foreach ($rows as $row) {
        if (!empty($row['metadata']['is_primary'])) {
            $hasPrimary = true;
            break;
        }
    }
    if (!$hasPrimary && $rows) {
        $oldestId = '';
        $oldestCreatedAt = PHP_INT_MAX;
        foreach ($rows as $row) {
            $createdAt = (int)($row['created_at'] ?? 0);
            if ($createdAt > 0 && $createdAt < $oldestCreatedAt) {
                $oldestCreatedAt = $createdAt;
                $oldestId = (string)($row['id'] ?? '');
            }
        }
        if ($oldestId === '') $oldestId = (string)($rows[count($rows) - 1]['id'] ?? '');
        foreach ($rows as &$row) {
            if ((string)($row['id'] ?? '') === $oldestId) {
                $row['metadata']['is_primary'] = true;
                break;
            }
        }
        unset($row);
    }
    return $rows;
}

function leadContactAllEmails($contact) {
    $contact = is_array($contact) ? $contact : [];
    $emails = [];
    $primary = strtolower(trim((string)($contact['email'] ?? '')));
    if ($primary !== '' && filter_var($primary, FILTER_VALIDATE_EMAIL)) $emails[] = $primary;
    foreach ((array)($contact['secondary_emails'] ?? []) as $email) {
        $normalized = strtolower(trim((string)$email));
        if ($normalized !== '' && filter_var($normalized, FILTER_VALIDATE_EMAIL)) $emails[] = $normalized;
    }
    return array_values(array_unique($emails));
}

function leadFindContactByEmail(SQLite3 $db, $leadId, $email) {
    $leadId = trim((string)$leadId);
    $normalized = strtolower(trim((string)$email));
    if ($leadId === '' || $normalized === '' || !filter_var($normalized, FILTER_VALIDATE_EMAIL)) {
        return null;
    }
    foreach (leadContactRows($db, $leadId) as $contact) {
        if (in_array($normalized, leadContactAllEmails($contact), true)) {
            return $contact;
        }
    }
    return null;
}

function leadEnsureEmailOnlyContact(SQLite3 $db, $leadId, $email, $actor, $now) {
    $leadId = trim((string)$leadId);
    $actor = strtolower(trim((string)$actor));
    $normalized = strtolower(trim((string)$email));
    if ($leadId === '' || $normalized === '' || !filter_var($normalized, FILTER_VALIDATE_EMAIL)) {
        return ['success' => false, 'error' => 'Valid email required'];
    }
    $existing = leadFindContactByEmail($db, $leadId, $normalized);
    if (is_array($existing) && !empty($existing['id'])) {
        return ['success' => true, 'contact_id' => (string)$existing['id'], 'created' => false];
    }
    $existingContacts = leadContactRows($db, $leadId);
    $metadata = !$existingContacts ? ['is_primary' => true] : [];
    $metadataJson = leadJsonEncode($metadata);
    $contactId = leadId('contact');
    $stmt = $db->prepare("
        INSERT INTO lead_contacts (
            id, lead_id, owner_email, full_name, title, email, phone, notes, metadata_json,
            created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, :lead_id, :owner_email, :full_name, :title, :email, :phone, :notes, :metadata_json,
            :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    leadBindText($stmt, ':id', $contactId);
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':owner_email', $actor);
    leadBindText($stmt, ':full_name', '');
    leadBindText($stmt, ':title', '');
    leadBindText($stmt, ':email', $normalized);
    leadBindText($stmt, ':phone', '');
    leadBindText($stmt, ':notes', '');
    if ($metadataJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metadataJson);
    $stmt->bindValue(':created_at', (int)$now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':created_by_email', $actor);
    leadBindText($stmt, ':updated_by_email', $actor);
    if (!$stmt->execute()) {
        return ['success' => false, 'error' => 'Could not create contact'];
    }
    return ['success' => true, 'contact_id' => $contactId, 'created' => true];
}

function leadNormalizeEmailList($emails) {
    if (is_string($emails)) {
        $emails = preg_split('/[\s,;]+/', $emails) ?: [];
    }
    $out = [];
    foreach ((array)$emails as $email) {
        $normalized = strtolower(trim((string)$email));
        if ($normalized === '' || !filter_var($normalized, FILTER_VALIDATE_EMAIL)) continue;
        $out[$normalized] = true;
    }
    return array_values(array_keys($out));
}

function leadContactAllPhones($contact) {
    $contact = is_array($contact) ? $contact : [];
    $phones = [];
    $primary = trim((string)($contact['phone'] ?? ''));
    if ($primary !== '') $phones[] = $primary;
    foreach ((array)($contact['secondary_phones'] ?? []) as $phone) {
        $normalized = trim((string)$phone);
        if ($normalized !== '') $phones[] = $normalized;
    }
    return array_values(array_unique($phones));
}

function leadContactNoteMap(SQLite3 $db, $leadId) {
    $stmt = $db->prepare('SELECT * FROM lead_contact_notes WHERE lead_id = :lead_id ORDER BY created_at DESC');
    leadBindText($stmt, ':lead_id', $leadId);
    $res = $stmt->execute();
    $map = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $contactId = (string)($row['contact_id'] ?? '');
        if ($contactId === '') continue;
        if (!isset($map[$contactId])) $map[$contactId] = [];
        $map[$contactId][] = $row;
    }
    return $map;
}

function leadDialEventContactMap(SQLite3 $db, $leadId) {
    $stmt = $db->prepare("
        SELECT
            dec.dial_event_id,
            c.*
        FROM lead_dial_event_contacts dec
        JOIN lead_contacts c ON c.id = dec.contact_id
        WHERE dec.lead_id = :lead_id
        ORDER BY dec.created_at DESC, c.updated_at DESC
    ");
    leadBindText($stmt, ':lead_id', $leadId);
    $res = $stmt->execute();
    $map = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $dialEventId = (string)($row['dial_event_id'] ?? '');
        if ($dialEventId === '') continue;
        unset($row['dial_event_id']);
        if (!isset($map[$dialEventId])) $map[$dialEventId] = [];
        $map[$dialEventId][] = $row;
    }
    return $map;
}

function leadAttachContactToDialEvent(SQLite3 $db, $leadId, $dialEventId, $contactId, $actor, $now) {
    if ($leadId === '' || $dialEventId === '' || $contactId === '') return;
    $check = $db->prepare('SELECT id FROM lead_dial_event_contacts WHERE dial_event_id = :dial_event_id AND contact_id = :contact_id LIMIT 1');
    leadBindText($check, ':dial_event_id', $dialEventId);
    leadBindText($check, ':contact_id', $contactId);
    $res = $check->execute();
    if ($res && $res->fetchArray(SQLITE3_ASSOC)) return;

    $stmt = $db->prepare("
        INSERT INTO lead_dial_event_contacts (id, lead_id, dial_event_id, contact_id, owner_email, created_at)
        VALUES (:id, :lead_id, :dial_event_id, :contact_id, :owner_email, :created_at)
    ");
    leadBindText($stmt, ':id', leadId('dialcontact'));
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':dial_event_id', $dialEventId);
    leadBindText($stmt, ':contact_id', $contactId);
    leadBindText($stmt, ':owner_email', $actor);
    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
    $stmt->execute();
}

function leadSetDialEventSelection(SQLite3 $db, $leadId, $dialEventId, $contactId, $unknown, $actor, $now) {
    if ($leadId === '' || $dialEventId === '') return;

    $clear = $db->prepare('DELETE FROM lead_dial_event_contacts WHERE lead_id = :lead_id AND dial_event_id = :dial_event_id');
    leadBindText($clear, ':lead_id', $leadId);
    leadBindText($clear, ':dial_event_id', $dialEventId);
    $clear->execute();

    $up = $db->prepare("
        UPDATE lead_dial_events
        SET selected_contact_id = :selected_contact_id,
            selected_contact_unknown = :selected_contact_unknown,
            context_json = COALESCE(context_json, context_json)
        WHERE id = :id AND lead_id = :lead_id
    ");
    leadBindText($up, ':selected_contact_id', $unknown ? '' : $contactId);
    $up->bindValue(':selected_contact_unknown', $unknown ? 1 : 0, SQLITE3_INTEGER);
    leadBindText($up, ':id', $dialEventId);
    leadBindText($up, ':lead_id', $leadId);
    $up->execute();

    if (!$unknown && $contactId !== '') {
      leadAttachContactToDialEvent($db, $leadId, $dialEventId, $contactId, $actor, $now);
    }
}

function leadRecordDialEvent(SQLite3 $db, $leadId, $actor, $source, $context, $now) {
    $source = preg_replace('/[^a-z0-9_\-]/', '', strtolower(trim((string)$source)));
    if ($source === '') $source = 'manual';
    $context = is_array($context) ? $context : [];
    $eventToken = trim((string)($context['event_token'] ?? ''));

    if ($eventToken !== '') {
        $existingStmt = $db->prepare("
            SELECT id
            FROM lead_dial_events
            WHERE lead_id = :lead_id
              AND owner_email = :owner_email
              AND source = :source
              AND event_token = :event_token
            LIMIT 1
        ");
        leadBindText($existingStmt, ':lead_id', $leadId);
        leadBindText($existingStmt, ':owner_email', $actor);
        leadBindText($existingStmt, ':source', $source);
        leadBindText($existingStmt, ':event_token', $eventToken);
    } else {
        $existingStmt = $db->prepare("
            SELECT id
            FROM lead_dial_events
            WHERE lead_id = :lead_id
              AND owner_email = :owner_email
              AND source = :source
              AND dialed_at >= :recent_cutoff
            ORDER BY dialed_at DESC
            LIMIT 1
        ");
        leadBindText($existingStmt, ':lead_id', $leadId);
        leadBindText($existingStmt, ':owner_email', $actor);
        leadBindText($existingStmt, ':source', $source);
        $existingStmt->bindValue(':recent_cutoff', $now - 30, SQLITE3_INTEGER);
    }
    $existingRes = $existingStmt->execute();
    $existing = $existingRes ? $existingRes->fetchArray(SQLITE3_ASSOC) : false;
    leadFinalizeResult($existingRes);
    if ($existing) {
        return ['success' => true, 'deduped' => true, 'dial_events' => leadDialEventRows($db, $leadId)];
    }

    $stmt = $db->prepare("
        INSERT INTO lead_dial_events (
            id, lead_id, owner_email, source, event_token, selected_contact_id, selected_contact_unknown, context_json, dialed_at, created_at
        ) VALUES (
            :id, :lead_id, :owner_email, :source, :event_token, '', 0, :context_json, :dialed_at, :created_at
        )
    ");
    leadBindText($stmt, ':id', leadId('dial'));
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':owner_email', $actor);
    leadBindText($stmt, ':source', $source);
    leadBindText($stmt, ':event_token', $eventToken);
    $ctxJson = json_encode($context ?: null);
    if ($ctxJson === 'null') $stmt->bindValue(':context_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':context_json', $ctxJson);
    $stmt->bindValue(':dialed_at', $now, SQLITE3_INTEGER);
    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
    $ok = $stmt->execute();
    if (!$ok) return ['success' => false, 'error' => 'Could not record dial event'];
    return ['success' => true, 'deduped' => false, 'dial_events' => leadDialEventRows($db, $leadId)];
}

function leadUpdateCompanyEmail(SQLite3 $db, $leadId, $email, $actor, $now) {
    $leadRow = leadRowById($db, $leadId);
    if (!$leadRow) return false;
    $entityId = trim((string)($leadRow['lead_entity_id'] ?? ''));
    if ($entityId === '') return false;
    $stmt = $db->prepare("
        UPDATE lead_entities
        SET email = :email,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    leadBindText($stmt, ':email', strtolower(trim((string)$email)));
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $entityId);
    $ok = (bool)$stmt->execute();
    if ($ok) leadSyncMembershipCacheFromEntity($db, $entityId, $actor, $now);
    return $ok;
}

function leadOrganizationSnapshotForLead($organizationId, $actor) {
    $organizationId = strtolower(trim((string)$organizationId));
    if ($organizationId === '') return null;

    if (function_exists('orgCustomerDataSnapshot')) {
        $orgs = orgCustomerDataSnapshot($actor, [
            'org_id' => $organizationId,
            'include_credit_ledger' => true,
            'include_billing_events' => true,
            'include_orders' => true,
        ]);
        if (is_array($orgs)) {
            foreach ($orgs as $org) {
                if (strtolower(trim((string)($org['id'] ?? ''))) === $organizationId) {
                    return $org;
                }
            }
        }
    }

    if (!function_exists('orgRead')) return null;
    $org = orgRead($organizationId);
    if (!is_array($org)) return null;
    return $org;
}

function leadNormalizePhoneForMatch($phone) {
    $digits = preg_replace('/\D+/', '', (string)$phone);
    if (strlen($digits) === 11 && strpos($digits, '1') === 0) $digits = substr($digits, 1);
    return $digits;
}

function leadCsvHeadersNormalized(array $row) {
    $out = [];
    foreach ($row as $key => $value) {
        $normalized = strtolower(trim((string)$key));
        $normalized = preg_replace('/[^a-z0-9]+/', '_', $normalized);
        $normalized = trim($normalized, '_');
        if ($normalized === '') continue;
        $out[$normalized] = $value;
    }
    return $out;
}

function leadOrumRowValue(array $row, array $keys) {
    foreach ($keys as $key) {
        if (!array_key_exists($key, $row)) continue;
        $value = trim((string)$row[$key]);
        if ($value !== '') return $value;
    }
    return '';
}

function leadOrumTimestampFromRow(array $row) {
    $raw = leadOrumRowValue($row, [
        'called_at', 'call_started_at', 'call_started', 'started_at', 'start_time', 'call_time',
        'timestamp', 'time', 'date_time', 'date'
    ]);
    if ($raw === '') return 0;
    $ts = strtotime($raw);
    return $ts ? (int)$ts : 0;
}

function leadExtractLeadIdFromCallbackUrl($url) {
    $url = trim((string)$url);
    if ($url === '') return '';
    $parts = @parse_url($url);
    if (!is_array($parts)) return '';
    $query = [];
    parse_str((string)($parts['query'] ?? ''), $query);
    return trim((string)($query['lead_id'] ?? ''));
}

function leadFindByMatch(SQLite3 $db, array $match) {
    $leadId = trim((string)($match['lead_id'] ?? ''));
    if ($leadId !== '') {
        $row = leadRowById($db, $leadId);
        if ($row) return $row;
    }

    $email = strtolower(trim((string)($match['email'] ?? '')));
    if ($email !== '') {
        $stmt = $db->prepare("
            SELECT l.*, ll.name AS list_name, ll.type AS list_type, ll.assigned_to_email AS list_assigned_to_email
            FROM leads l
            JOIN lead_lists ll ON ll.id = l.list_id
            WHERE LOWER(l.email) = :email
            ORDER BY l.updated_at DESC
            LIMIT 1
        ");
        leadBindText($stmt, ':email', $email);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        leadFinalizeResult($res);
        if ($row) return $row;
    }

    $phone = leadNormalizePhoneForMatch($match['phone'] ?? '');
    if ($phone !== '') {
        $stmt = $db->prepare("
            SELECT l.*, ll.name AS list_name, ll.type AS list_type, ll.assigned_to_email AS list_assigned_to_email
            FROM leads l
            JOIN lead_lists ll ON ll.id = l.list_id
            ORDER BY l.updated_at DESC
        ");
        $res = $stmt->execute();
        $matchedRow = false;
        while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
            if (leadNormalizePhoneForMatch($row['phone'] ?? '') === $phone) {
                $matchedRow = $row;
                break;
            }
        }
        leadFinalizeResult($res);
        if ($matchedRow) return $matchedRow;
    }

    $company = strtolower(trim((string)($match['company'] ?? '')));
    if ($company !== '') {
        $stmt = $db->prepare("
            SELECT l.*, ll.name AS list_name, ll.type AS list_type, ll.assigned_to_email AS list_assigned_to_email
            FROM leads l
            JOIN lead_lists ll ON ll.id = l.list_id
            WHERE LOWER(l.company) = :company
            ORDER BY l.updated_at DESC
            LIMIT 1
        ");
        leadBindText($stmt, ':company', $company);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        leadFinalizeResult($res);
        if ($row) return $row;
    }

    return false;
}

function leadUpsertImportedDialEvent(SQLite3 $db, array $leadRow, $ownerEmail, array $context, $dialedAt, $eventToken) {
    $leadId = (string)($leadRow['id'] ?? '');
    $ownerEmail = strtolower(trim((string)$ownerEmail));
    if ($leadId === '' || $ownerEmail === '') return ['success' => false, 'error' => 'Missing lead or owner'];
    $now = time();
    $source = 'orum_import';
    $eventToken = trim((string)$eventToken);
    if ($eventToken === '') {
        $eventToken = sha1(json_encode([$leadId, $ownerEmail, $source, $dialedAt, $context]));
    }

    $check = $db->prepare("
        SELECT id FROM lead_dial_events
        WHERE lead_id = :lead_id
          AND owner_email = :owner_email
          AND source = :source
          AND event_token = :event_token
        LIMIT 1
    ");
    leadBindText($check, ':lead_id', $leadId);
    leadBindText($check, ':owner_email', $ownerEmail);
    leadBindText($check, ':source', $source);
    leadBindText($check, ':event_token', $eventToken);
    $existingRes = $check->execute();
    $existing = $existingRes ? $existingRes->fetchArray(SQLITE3_ASSOC) : false;
    leadFinalizeResult($existingRes);
    $ctxJson = json_encode($context ?: null);

    if ($existing) {
        $up = $db->prepare("
            UPDATE lead_dial_events
            SET context_json = :context_json,
                dialed_at = :dialed_at
            WHERE id = :id
        ");
        if ($ctxJson === 'null') $up->bindValue(':context_json', null, SQLITE3_NULL);
        else leadBindText($up, ':context_json', $ctxJson);
        $up->bindValue(':dialed_at', $dialedAt, SQLITE3_INTEGER);
        leadBindText($up, ':id', (string)$existing['id']);
        $up->execute();
        return ['success' => true, 'id' => (string)$existing['id'], 'created' => false];
    }

    $stmt = $db->prepare("
        INSERT INTO lead_dial_events (
            id, lead_id, owner_email, source, event_token, selected_contact_id,
            selected_contact_unknown, context_json, dialed_at, created_at
        ) VALUES (
            :id, :lead_id, :owner_email, :source, :event_token, '', 0, :context_json, :dialed_at, :created_at
        )
    ");
    $id = leadId('dial');
    leadBindText($stmt, ':id', $id);
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':owner_email', $ownerEmail);
    leadBindText($stmt, ':source', $source);
    leadBindText($stmt, ':event_token', $eventToken);
    if ($ctxJson === 'null') $stmt->bindValue(':context_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':context_json', $ctxJson);
    $stmt->bindValue(':dialed_at', $dialedAt, SQLITE3_INTEGER);
    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
    if (!$stmt->execute()) return ['success' => false, 'error' => 'Could not save imported call'];
    return ['success' => true, 'id' => $id, 'created' => true];
}

function leadInsertImportedCallNote(SQLite3 $db, $leadId, $dialEventId, $ownerEmail, $noteText, $now) {
    $noteText = trim((string)$noteText);
    if ($leadId === '' || $dialEventId === '' || $noteText === '') return;
    $check = $db->prepare('SELECT id FROM lead_notes WHERE lead_id = :lead_id AND dial_event_id = :dial_event_id AND note_text = :note_text LIMIT 1');
    leadBindText($check, ':lead_id', $leadId);
    leadBindText($check, ':dial_event_id', $dialEventId);
    leadBindText($check, ':note_text', $noteText);
    $existingRes = $check->execute();
    $existing = $existingRes ? $existingRes->fetchArray(SQLITE3_ASSOC) : false;
    leadFinalizeResult($existingRes);
    if ($existing) return;

    $stmt = $db->prepare("
        INSERT INTO lead_notes (
            id, lead_id, dial_event_id, owner_email, note_text, created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, :lead_id, :dial_event_id, :owner_email, :note_text, :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    leadBindText($stmt, ':id', leadId('note'));
    leadBindText($stmt, ':lead_id', $leadId);
    leadBindText($stmt, ':dial_event_id', $dialEventId);
    leadBindText($stmt, ':owner_email', $ownerEmail);
    leadBindText($stmt, ':note_text', $noteText);
    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':created_by_email', $ownerEmail);
    leadBindText($stmt, ':updated_by_email', $ownerEmail);
    $stmt->execute();
}

function leadOrumImportOwnerEmail(array $row, $actor) {
    $candidate = strtolower(trim((string)leadOrumRowValue($row, [
        'rep_email', 'owner_email', 'user_email', 'salesperson_email', 'email_owner'
    ])));
    if ($candidate === '') return $actor;
    if (!function_exists('readUserDataByEmail')) return $actor;
    $user = readUserDataByEmail($candidate);
    return is_array($user) ? $candidate : $actor;
}

function leadImportOrumCsv(SQLite3 $db, $csvPath, $actor) {
    $handle = @fopen($csvPath, 'r');
    if (!$handle) return ['success' => false, 'error' => 'Could not read uploaded CSV'];
    $headers = fgetcsv($handle, 0, ',', '"', '');
    if (!is_array($headers) || !$headers) {
        fclose($handle);
        return ['success' => false, 'error' => 'CSV file is missing a header row'];
    }

    $matched = 0;
    $created = 0;
    $unmatched = [];
    $rowCount = 0;
    $now = time();

    if (!$db->exec('BEGIN IMMEDIATE')) {
        fclose($handle);
        return ['success' => false, 'error' => 'Could not start the import transaction'];
    }

    try {
    while (($values = fgetcsv($handle, 0, ',', '"', '')) !== false) {
        $rowCount++;
        $assoc = [];
        foreach ($headers as $idx => $header) $assoc[(string)$header] = $values[$idx] ?? '';
        $row = leadCsvHeadersNormalized($assoc);
        $callbackUrl = leadOrumRowValue($row, ['crm_contact_page_link', 'callback_url', 'crm_url', 'open_link', 'url', 'record_url']);
        $company = leadOrumRowValue($row, ['prospect', 'name', 'company', 'company_name', 'account_name', 'business_name', 'organization']);
        $email = strtolower(leadOrumRowValue($row, ['email', 'lead_email', 'company_email', 'contact_email']));
        $phone = leadOrumRowValue($row, ['phone', 'phone_number', 'lead_phone', 'company_phone', 'number']);
        $leadId = leadExtractLeadIdFromCallbackUrl($callbackUrl);
        if ($leadId === '') $leadId = leadOrumRowValue($row, ['lead_id', 'crm_lead_id']);
        $match = leadFindByMatch($db, [
            'lead_id' => $leadId,
            'email' => $email,
            'phone' => $phone,
            'company' => $company
        ]);
        if (!$match) {
            $unmatched[] = [
                'company' => $company,
                'email' => $email,
                'phone' => $phone
            ];
            continue;
        }

        if (!leadCanViewLeadRow($match)) continue;

        $dialedAt = leadOrumTimestampFromRow($row);
        if ($dialedAt <= 0) $dialedAt = $now;
        $ownerEmail = leadOrumImportOwnerEmail($row, $actor);
        $contactName = leadOrumRowValue($row, ['contact_name', 'person_name', 'prospect_name']);
        $contactTitle = leadOrumRowValue($row, ['contact_title', 'title', 'job_title']);
        $notes = leadOrumRowValue($row, ['notes', 'note']);
        $disposition = leadOrumRowValue($row, ['disposition', 'call_outcome', 'outcome', 'result', 'status']);
        $duration = leadOrumRowValue($row, ['duration_secs', 'duration', 'call_duration', 'talk_time']);
        $eventToken = leadOrumRowValue($row, ['entry_id', 'call_id', 'id', 'activity_id', 'conversation_id']);
        $context = [
            'import_type' => 'orum_csv',
            'company' => $company,
            'email' => $email,
            'phone' => $phone,
            'contact_name' => $contactName,
            'contact_title' => $contactTitle,
            'disposition' => $disposition,
            'duration' => $duration,
            'list' => leadOrumRowValue($row, ['list']),
            'call_type' => leadOrumRowValue($row, ['call_type']),
            'reason_ended' => leadOrumRowValue($row, ['reason_ended']),
            'recording' => leadOrumRowValue($row, ['recording']),
            'counted_as_a_dial' => leadOrumRowValue($row, ['counted_as_a_dial']),
            'led_to_a_connect' => leadOrumRowValue($row, ['led_to_a_connect']),
            'led_to_a_conversation' => leadOrumRowValue($row, ['led_to_a_conversation']),
            'led_to_a_meeting' => leadOrumRowValue($row, ['led_to_a_meeting']),
            'objections' => leadOrumRowValue($row, ['objections']),
            'rep_name' => leadOrumRowValue($row, ['rep']),
            'rep_phone' => leadOrumRowValue($row, ['rep_phone']),
            'callback_url' => $callbackUrl,
            'raw' => $row
        ];
        $saved = leadUpsertImportedDialEvent($db, $match, $ownerEmail, $context, $dialedAt, $eventToken);
        if (empty($saved['success'])) continue;
        $matched++;
        if (!empty($saved['created'])) $created++;
        $dialEventId = (string)($saved['id'] ?? '');

        if ($contactName !== '' || $email !== '' || $phone !== '') {
            $contactStmt = $db->prepare("
                SELECT id FROM lead_contacts
                WHERE lead_id = :lead_id
                  AND LOWER(COALESCE(full_name, '')) = :full_name
                  AND LOWER(COALESCE(email, '')) = :email
                  AND COALESCE(phone, '') = :phone
                LIMIT 1
            ");
            leadBindText($contactStmt, ':lead_id', (string)$match['id']);
            leadBindText($contactStmt, ':full_name', strtolower($contactName));
            leadBindText($contactStmt, ':email', strtolower($email));
            leadBindText($contactStmt, ':phone', $phone);
            $contactRes = $contactStmt->execute();
            $contact = $contactRes ? $contactRes->fetchArray(SQLITE3_ASSOC) : false;
            leadFinalizeResult($contactRes);
            $contactId = (string)($contact['id'] ?? '');
            if ($contactId === '') {
                $contactId = leadId('contact');
                $ins = $db->prepare("
                    INSERT INTO lead_contacts (
                        id, lead_id, owner_email, full_name, title, email, phone, notes,
                        created_at, updated_at, created_by_email, updated_by_email
                    ) VALUES (
                        :id, :lead_id, :owner_email, :full_name, :title, :email, :phone, '',
                        :created_at, :updated_at, :created_by_email, :updated_by_email
                    )
                ");
                leadBindText($ins, ':id', $contactId);
                leadBindText($ins, ':lead_id', (string)$match['id']);
                leadBindText($ins, ':owner_email', $ownerEmail);
                leadBindText($ins, ':full_name', $contactName);
                leadBindText($ins, ':title', $contactTitle);
                leadBindText($ins, ':email', strtolower($email));
                leadBindText($ins, ':phone', $phone);
                $ins->bindValue(':created_at', $dialedAt, SQLITE3_INTEGER);
                $ins->bindValue(':updated_at', $dialedAt, SQLITE3_INTEGER);
                leadBindText($ins, ':created_by_email', $ownerEmail);
                leadBindText($ins, ':updated_by_email', $ownerEmail);
                $ins->execute();
            }
            if ($contactId !== '') {
                leadSetDialEventSelection($db, (string)$match['id'], $dialEventId, $contactId, false, $ownerEmail, $dialedAt);
            }
        }

        leadInsertImportedCallNote($db, (string)$match['id'], $dialEventId, $ownerEmail, $notes, $dialedAt);
    }
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        fclose($handle);
        throw $e;
    }
    fclose($handle);
    if (!$db->exec('COMMIT')) {
        return ['success' => false, 'error' => 'Could not finish the import transaction'];
    }

    return [
        'success' => true,
        'rows' => $rowCount,
        'matched' => $matched,
        'created_calls' => $created,
        'unmatched' => array_slice($unmatched, 0, 50)
    ];
}

function leadImportRunsRecent(SQLite3 $db, $importType, $limit = 20) {
    $stmt = $db->prepare("
        SELECT *
        FROM lead_import_runs
        WHERE import_type = :import_type
        ORDER BY created_at DESC
        LIMIT :limit
    ");
    leadBindText($stmt, ':import_type', $importType);
    $stmt->bindValue(':limit', max(1, min(100, (int)$limit)), SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
        $rows[] = $row;
    }
    return $rows;
}

function leadImportRunByPreviewToken(SQLite3 $db, $importType, $previewToken) {
    $stmt = $db->prepare("
        SELECT *
        FROM lead_import_runs
        WHERE import_type = :import_type
          AND preview_token = :preview_token
        LIMIT 1
    ");
    leadBindText($stmt, ':import_type', $importType);
    leadBindText($stmt, ':preview_token', $previewToken);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    leadFinalizeResult($res);
    if (!$row) return null;
    $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
    return $row;
}

function leadSaveImportRun(SQLite3 $db, array $run) {
    $stmt = $db->prepare("
        INSERT INTO lead_import_runs (
            id, import_type, filename, preview_token, status,
            total_rows, matched_rows, unmatched_rows, created_records,
            metadata_json, created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, :import_type, :filename, :preview_token, :status,
            :total_rows, :matched_rows, :unmatched_rows, :created_records,
            :metadata_json, :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    leadBindText($stmt, ':id', (string)$run['id']);
    leadBindText($stmt, ':import_type', (string)$run['import_type']);
    leadBindText($stmt, ':filename', (string)($run['filename'] ?? ''));
    leadBindText($stmt, ':preview_token', (string)($run['preview_token'] ?? ''));
    leadBindText($stmt, ':status', (string)($run['status'] ?? 'previewed'));
    $stmt->bindValue(':total_rows', (int)($run['total_rows'] ?? 0), SQLITE3_INTEGER);
    $stmt->bindValue(':matched_rows', (int)($run['matched_rows'] ?? 0), SQLITE3_INTEGER);
    $stmt->bindValue(':unmatched_rows', (int)($run['unmatched_rows'] ?? 0), SQLITE3_INTEGER);
    $stmt->bindValue(':created_records', (int)($run['created_records'] ?? 0), SQLITE3_INTEGER);
    $metadataJson = leadJsonEncode($run['metadata'] ?? []);
    if ($metadataJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metadataJson);
    $stmt->bindValue(':created_at', (int)($run['created_at'] ?? time()), SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', (int)($run['updated_at'] ?? time()), SQLITE3_INTEGER);
    leadBindText($stmt, ':created_by_email', (string)($run['created_by_email'] ?? ''));
    leadBindText($stmt, ':updated_by_email', (string)($run['updated_by_email'] ?? ''));
    return (bool)$stmt->execute();
}

function leadUpdateImportRun(SQLite3 $db, $id, array $updates) {
    $fields = [];
    $binds = [':id' => $id];
    foreach ([
        'filename', 'preview_token', 'status', 'created_by_email', 'updated_by_email'
    ] as $key) {
        if (!array_key_exists($key, $updates)) continue;
        $fields[] = $key . ' = :' . $key;
        $binds[':' . $key] = (string)$updates[$key];
    }
    foreach (['total_rows', 'matched_rows', 'unmatched_rows', 'created_records', 'created_at', 'updated_at'] as $key) {
        if (!array_key_exists($key, $updates)) continue;
        $fields[] = $key . ' = :' . $key;
        $binds[':' . $key] = (int)$updates[$key];
    }
    if (array_key_exists('metadata', $updates)) {
        $fields[] = 'metadata_json = :metadata_json';
        $binds[':metadata_json'] = leadJsonEncode($updates['metadata'] ?? []);
    }
    if (!$fields) return false;
    $stmt = $db->prepare('UPDATE lead_import_runs SET ' . implode(', ', $fields) . ' WHERE id = :id');
    foreach ($binds as $key => $value) {
        if ($key === ':metadata_json') {
            if ($value === null) $stmt->bindValue($key, null, SQLITE3_NULL);
            else leadBindText($stmt, $key, $value);
        } elseif (is_int($value)) {
            $stmt->bindValue($key, $value, SQLITE3_INTEGER);
        } else {
            leadBindText($stmt, $key, $value);
        }
    }
    return (bool)$stmt->execute();
}

function leadOrumPreviewDir() {
    $dir = storageDir('meta/orum_import_previews');
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return $dir;
}

function leadOrumPreviewPath($previewToken) {
    return leadOrumPreviewDir() . preg_replace('/[^a-z0-9]/', '', strtolower((string)$previewToken)) . '.csv';
}

function leadOrumListProgressSummary(SQLite3 $db, $listId, array $extraLeadIds = []) {
    $listRow = leadListRowById($db, $listId);
    if (!$listRow) return null;
    $calledStmt = $db->prepare("
        SELECT COUNT(DISTINCT l.id) AS c
        FROM leads l
        JOIN lead_dial_events de ON de.lead_id = l.id
        WHERE l.list_id = :list_id
    ");
    leadBindText($calledStmt, ':list_id', $listId);
    $calledRes = $calledStmt->execute();
    $called = (int)(($calledRes ? $calledRes->fetchArray(SQLITE3_ASSOC) : ['c' => 0])['c'] ?? 0);
    leadFinalizeResult($calledRes);
    if ($extraLeadIds) {
        $extraLeadIds = array_values(array_unique(array_filter(array_map('strval', $extraLeadIds))));
        $alreadyStmt = $db->prepare("
            SELECT DISTINCT l.id
            FROM leads l
            JOIN lead_dial_events de ON de.lead_id = l.id
            WHERE l.list_id = :list_id
        ");
        leadBindText($alreadyStmt, ':list_id', $listId);
        $alreadyRes = $alreadyStmt->execute();
        $already = [];
        while ($alreadyRes && ($row = $alreadyRes->fetchArray(SQLITE3_ASSOC))) {
            $already[(string)($row['id'] ?? '')] = true;
        }
        leadFinalizeResult($alreadyRes);
        foreach ($extraLeadIds as $leadId) {
            if (!isset($already[$leadId])) $called += 1;
        }
    }
    return [
        'id' => (string)($listRow['id'] ?? ''),
        'name' => (string)($listRow['name'] ?? 'List'),
        'assigned_to_email' => (string)($listRow['assigned_to_email'] ?? ''),
        'lead_count' => (int)($listRow['computed_lead_count'] ?? $listRow['lead_count'] ?? 0),
        'called_count' => $called,
    ];
}

function leadPreviewOrumCsv(SQLite3 $db, $csvPath, $actor, $filename, $previewToken) {
    $handle = @fopen($csvPath, 'r');
    if (!$handle) return ['success' => false, 'error' => 'Could not read uploaded CSV'];
    $headers = fgetcsv($handle, 0, ',', '"', '');
    if (!is_array($headers) || !$headers) {
        fclose($handle);
        return ['success' => false, 'error' => 'CSV file is missing a header row'];
    }

    $matched = 0;
    $rowCount = 0;
    $unmatched = [];
    $matchedLeadIdsByList = [];
    while (($values = fgetcsv($handle, 0, ',', '"', '')) !== false) {
        $rowCount++;
        $assoc = [];
        foreach ($headers as $idx => $header) $assoc[(string)$header] = $values[$idx] ?? '';
        $row = leadCsvHeadersNormalized($assoc);
        $callbackUrl = leadOrumRowValue($row, ['crm_contact_page_link', 'callback_url', 'crm_url', 'open_link', 'url', 'record_url']);
        $company = leadOrumRowValue($row, ['prospect', 'name', 'company', 'company_name', 'account_name', 'business_name', 'organization']);
        $email = strtolower(leadOrumRowValue($row, ['email', 'lead_email', 'company_email', 'contact_email']));
        $phone = leadOrumRowValue($row, ['phone', 'phone_number', 'lead_phone', 'company_phone', 'number']);
        $leadId = leadExtractLeadIdFromCallbackUrl($callbackUrl);
        if ($leadId === '') $leadId = leadOrumRowValue($row, ['lead_id', 'crm_lead_id']);
        $match = leadFindByMatch($db, [
            'lead_id' => $leadId,
            'email' => $email,
            'phone' => $phone,
            'company' => $company,
        ]);
        if (!$match || !leadCanViewLeadRow($match)) {
            $unmatched[] = [
                'company' => $company,
                'email' => $email,
                'phone' => $phone,
                'disposition' => leadOrumRowValue($row, ['disposition', 'call_outcome', 'outcome', 'result', 'status']),
                'called_at' => leadOrumRowValue($row, ['called_at', 'call_started_at', 'start_time', 'date_time', 'date']),
            ];
            continue;
        }
        $matched += 1;
        $listId = (string)($match['list_id'] ?? '');
        $matchLeadId = (string)($match['id'] ?? '');
        if ($listId !== '' && $matchLeadId !== '') {
            if (!isset($matchedLeadIdsByList[$listId])) $matchedLeadIdsByList[$listId] = [];
            $matchedLeadIdsByList[$listId][$matchLeadId] = true;
        }
    }
    fclose($handle);

    $affectedLists = [];
    foreach ($matchedLeadIdsByList as $listId => $leadIds) {
        $summary = leadOrumListProgressSummary($db, $listId, array_keys($leadIds));
        if ($summary) $affectedLists[] = $summary;
    }
    usort($affectedLists, function($a, $b) {
        return strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? ''));
    });

    $preview = [
        'preview_token' => $previewToken,
        'rows' => $rowCount,
        'matched' => $matched,
        'unmatched_count' => count($unmatched),
        'unmatched' => array_slice($unmatched, 0, 80),
        'affected_lists' => $affectedLists,
    ];
    $now = time();
    leadSaveImportRun($db, [
        'id' => leadId('import'),
        'import_type' => 'orum_csv',
        'filename' => $filename,
        'preview_token' => $previewToken,
        'status' => 'previewed',
        'total_rows' => $rowCount,
        'matched_rows' => $matched,
        'unmatched_rows' => count($unmatched),
        'created_records' => 0,
        'metadata' => $preview + ['csv_path' => $csvPath],
        'created_at' => $now,
        'updated_at' => $now,
        'created_by_email' => $actor,
        'updated_by_email' => $actor,
    ]);
    return ['success' => true] + $preview;
}

function leadSortSql($sort, $dir) {
    $dir = strtoupper($dir) === 'DESC' ? 'DESC' : 'ASC';
    $map = [
        'company' => "l.company COLLATE NOCASE $dir, l.updated_at DESC",
        'status' => "l.status COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'assigned_to_email' => "ll.assigned_to_email COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'region' => "l.region_code COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'city' => "l.city COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'state' => "l.state COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'phone' => "l.phone COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'website' => "l.website COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'contact_count' => "contact_count $dir, l.company COLLATE NOCASE ASC",
        'organization_id' => "CASE WHEN COALESCE(l.organization_id, '') = '' THEN 1 ELSE 0 END ASC, l.organization_id COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'list_name' => "ll.name COLLATE NOCASE $dir, l.company COLLATE NOCASE ASC",
        'updated_at' => "l.updated_at $dir, l.company COLLATE NOCASE ASC",
        'created_at' => "l.created_at $dir, l.company COLLATE NOCASE ASC",
        'latest_callback_at' => "CASE WHEN latest_callback_at IS NULL OR latest_callback_at = 0 THEN 1 ELSE 0 END ASC, latest_callback_at $dir, l.company COLLATE NOCASE ASC",
        'next_followup_at' => "CASE WHEN next_followup_at IS NULL OR next_followup_at = 0 THEN 1 ELSE 0 END ASC, next_followup_at $dir, l.company COLLATE NOCASE ASC"
    ];
    return $map[$sort] ?? $map['updated_at'];
}

function leadMyLeadsQuery(SQLite3 $db, $actor, $page, $perPage, $search, $sort, $dir, $followupScope = 'all') {
    $page = max(1, (int)$page);
    $perPage = max(1, min(200, (int)$perPage));
    $offset = ($page - 1) * $perPage;
    $search = trim((string)$search);
    $followupScope = strtolower(trim((string)$followupScope));
    if (!in_array($followupScope, ['all', 'due', 'open', 'none'], true)) $followupScope = 'all';

    $subOpen = "(SELECT COUNT(1) FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :actor_sub AND fu.status = 'open')";
    $subNext = "(SELECT MIN(fu.due_at) FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :actor_sub AND fu.status = 'open')";

    $where = ["ll.assigned_to_email = :actor"];
    $binds = [':actor' => $actor, ':actor_sub' => $actor];
    if ($search !== '') {
        $where[] = "(l.company LIKE :q OR l.email LIKE :q OR l.phone LIKE :q OR l.address LIKE :q OR l.city LIKE :q OR l.state LIKE :q OR l.website LIKE :q OR ll.name LIKE :q)";
        $binds[':q'] = '%' . $search . '%';
    }
    if ($followupScope === 'due') {
        $where[] = "EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :actor_due AND fu.status = 'open' AND fu.due_at > 0 AND fu.due_at <= :now_due)";
        $binds[':actor_due'] = $actor;
        $binds[':now_due'] = time();
    } elseif ($followupScope === 'open') {
        $where[] = "EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :actor_open AND fu.status = 'open')";
        $binds[':actor_open'] = $actor;
    } elseif ($followupScope === 'none') {
        $where[] = "NOT EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :actor_none AND fu.status = 'open')";
        $binds[':actor_none'] = $actor;
    }

    $countSql = "
        SELECT COUNT(1) AS c
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where);
    $countStmt = $db->prepare($countSql);
    foreach ($binds as $key => $val) {
        if (is_int($val)) $countStmt->bindValue($key, $val, SQLITE3_INTEGER);
        else leadBindText($countStmt, $key, $val);
    }
    $countRes = $countStmt->execute();
    $total = (int)(($countRes ? $countRes->fetchArray(SQLITE3_ASSOC) : ['c' => 0])['c'] ?? 0);

    $sql = "
        SELECT
            l.*,
            ll.name AS list_name,
            ll.type AS list_type,
            ll.exported_at AS list_exported_at,
            ll.exported_by_email AS list_exported_by_email,
            $subOpen AS open_followup_count,
            $subNext AS next_followup_at
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY " . leadSortSql($sort, $dir) . "
        LIMIT :limit OFFSET :offset
    ";
    $stmt = $db->prepare($sql);
    foreach ($binds as $key => $val) {
        if (is_int($val)) $stmt->bindValue($key, $val, SQLITE3_INTEGER);
        else leadBindText($stmt, $key, $val);
    }
    $stmt->bindValue(':limit', $perPage, SQLITE3_INTEGER);
    $stmt->bindValue(':offset', $offset, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
        $rows[] = $row;
    }

    return [
        'success' => true,
        'leads' => $rows,
        'page' => $page,
        'per_page' => $perPage,
        'total' => $total,
        'total_pages' => max(1, (int)ceil($total / $perPage))
    ];
}

function leadViewerTarget($actor) {
    $mode = strtolower(leadText('target_mode'));
    $requested = strtolower(leadText('target_email'));
    if ($requested === '') {
        $requested = strtolower(trim((string)($_POST['target'] ?? '')));
    }
    if ($mode === 'all') {
        $requested = '__all__';
    } elseif ($mode === 'mine') {
        $requested = 'mine';
    } elseif ($mode === 'user' && $requested === '') {
        $requested = strtolower(trim((string)($_POST['assigned_to_email'] ?? '')));
    }
    if ($requested === '' || $requested === 'me' || $requested === 'mine') return ['mode' => 'mine', 'email' => $actor];
    if (!leadCanManageLists()) return ['mode' => 'mine', 'email' => $actor];
    if ($requested === '__all__' || $requested === 'all') return ['mode' => 'all', 'email' => ''];
    return ['mode' => 'user', 'email' => $requested];
}

function leadSampleFavoriteConfigs() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $path = storageExistingPath('data/sample_report_favorites.json', __DIR__ . '/sample_report_favorites.json', true);
    $decoded = is_file($path) ? json_decode((string)@file_get_contents($path), true) : [];
    $rows = is_array($decoded['favorites'] ?? null) ? $decoded['favorites'] : (is_array($decoded) ? $decoded : []);
    $out = [];
    foreach ($rows as $entry) {
        if (is_array($entry)) {
            $id = preg_replace('/[^a-f0-9]/', '', strtolower(trim((string)($entry['id'] ?? ($entry['folder'] ?? ($entry['folder_id'] ?? ''))))));
            $label = trim((string)($entry['label'] ?? ($entry['name'] ?? '')));
        } else {
            $id = preg_replace('/[^a-f0-9]/', '', strtolower(trim((string)$entry)));
            $label = '';
        }
        if ($id === '') continue;
        $out[] = ['id' => $id, 'label' => $label !== '' ? $label : $id];
    }
    $cached = $out;
    return $cached;
}

function leadMilestoneHasFundingHistory($org) {
    if (!is_array($org)) return false;
    if ((int)($org['lifetimeRevenue'] ?? 0) > 0) return true;
    foreach ((array)($org['credits_ledger'] ?? []) as $entry) {
        if (!is_array($entry)) continue;
        $reason = strtolower(trim((string)($entry['reason'] ?? '')));
        $delta = (int)($entry['delta'] ?? $entry['amount'] ?? 0);
        if ($delta <= 0) continue;
        if (strpos($reason, 'stripe') !== false || strpos($reason, 'checkout') !== false || strpos($reason, 'topup') !== false || strpos($reason, 'payment') !== false) {
            return true;
        }
    }
    return false;
}

function leadMilestonesForLead($leadRow, $orgSnapshot = null) {
    $meta = leadMetadataArray($leadRow);
    $custom = is_array($meta['crm']['milestones_custom'] ?? null) ? $meta['crm']['milestones_custom'] : [];
    $milestones = [];
    foreach ($custom as $key => $value) {
        $milestones[(string)$key] = !empty($value);
    }
    $milestones['account_funded'] = leadMilestoneHasFundingHistory($orgSnapshot);
    $milestones['ten_orders'] = (int)($orgSnapshot['lifetimeOrders'] ?? count((array)($orgSnapshot['orders'] ?? []))) >= 10;
    return $milestones;
}

function leadSequenceTemplateForStage($stage) {
    $normalized = leadNormalizeStageStatus($stage, '');
    $map = [
        'info_sent' => ['sequence_key' => 'info_sent_followup', 'sequence_label' => 'Info Sent Follow-Up'],
        'info_received' => ['sequence_key' => 'info_received_followup', 'sequence_label' => 'Info Received Follow-Up'],
        'signed_up' => ['sequence_key' => 'signed_up_onboarding', 'sequence_label' => 'Signed Up'],
    ];
    return $map[$normalized] ?? null;
}

function leadSequenceStateForLead($leadRow) {
    $meta = leadMetadataArray($leadRow);
    $saved = is_array($meta['crm']['active_sequence'] ?? null) ? $meta['crm']['active_sequence'] : [];
    if ($saved) return $saved;
    $template = leadSequenceTemplateForStage($leadRow['status'] ?? '');
    if (!$template) return null;
    return [
        'sequence_key' => $template['sequence_key'],
        'sequence_label' => $template['sequence_label'],
        'status' => 'active',
        'next_step' => 'Waiting for next touch',
        'pause_reason' => '',
        'updated_at' => (int)($leadRow['updated_at'] ?? time()),
    ];
}

function leadEmailAssetsForLead($leadRow) {
    $meta = leadMetadataArray($leadRow);
    $branding = is_array($meta['crm']['email_branding'] ?? null) ? $meta['crm']['email_branding'] : [];
    return [
        'branding' => [
            'primaryColor' => (string)($branding['primaryColor'] ?? ($branding['primary_color'] ?? '')),
            'secondaryColor' => (string)($branding['secondaryColor'] ?? ($branding['secondary_color'] ?? '')),
            'logoDataUrl' => (string)($branding['logoDataUrl'] ?? ($branding['logo_data_url'] ?? '')),
        ],
        'report_templates' => leadSampleFavoriteConfigs(),
    ];
}

function leadHydratedRow(SQLite3 $db, $leadId, $actor, $options = []) {
    $leadRow = is_array($options['lead_row'] ?? null) ? $options['lead_row'] : leadRowById($db, $leadId);
    if (!$leadRow) return null;
    $leadRow['metadata'] = leadMetadataArray($leadRow);
    $leadRow['contacts'] = leadContactRows($db, $leadId);
    $leadRow['contact_notes'] = leadContactNoteMap($db, $leadId);
    $leadRow['dial_event_contacts'] = leadDialEventContactMap($db, $leadId);
    $leadRow['notes_items'] = leadNoteRows($db, $leadId);
    $leadRow['followups'] = leadFollowupRows($db, $leadId);
    $leadRow['dial_events'] = leadDialEventRows($db, $leadId, 100);
    $leadRow['activity_items'] = leadActivityRows($db, $leadId, 250);
    $leadRow['organization_snapshot'] = leadOrganizationSnapshotForLead($leadRow['organization_id'] ?? '', $actor);
    $leadRow['crm'] = [
        'gmail' => function_exists('gmailConnectionPublicStateForActor') ? gmailConnectionPublicStateForActor($actor) : ['connected' => false],
        'calendar' => function_exists('gmailCalendarConnectionPublicStateForActor') ? gmailCalendarConnectionPublicStateForActor($actor) : ['connected' => false],
        'ringcentral' => function_exists('ringcentralConnectionPublicStateForActor') ? ringcentralConnectionPublicStateForActor($actor) : ['connected' => false],
        'settings' => function_exists('crmSettingsPublicSnapshotForActor') ? crmSettingsPublicSnapshotForActor($actor) : [],
        'milestones' => leadMilestonesForLead($leadRow, $leadRow['organization_snapshot']),
        'active_sequence' => leadSequenceStateForLead($leadRow),
        'email_assets' => leadEmailAssetsForLead($leadRow),
    ];
    return $leadRow;
}

function leadDashboardTaskRows(SQLite3 $db, $target, $actor) {
    $where = [];
    if ($target['mode'] === 'all') {
        $where[] = '1=1';
    } elseif ($target['mode'] === 'user') {
        $where[] = 'assigned_to_email = :assigned_to_email';
    } else {
        $where[] = 'assigned_to_email = :assigned_to_email';
    }
    $stmt = $db->prepare("
        SELECT *
        FROM lead_dashboard_tasks
        WHERE " . implode(' AND ', $where) . "
        ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, CASE WHEN due_at = 0 THEN 1 ELSE 0 END ASC, due_at ASC, created_at DESC
        LIMIT 200
    ");
    if ($target['mode'] !== 'all') leadBindText($stmt, ':assigned_to_email', (string)($target['email'] ?: $actor));
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json') ?: [];
        $rows[] = $row;
    }
    return $rows;
}

function leadLatestTouchTs(SQLite3 $db, $leadId) {
    $latest = 0;
    foreach (leadActivityRows($db, $leadId, 25) as $item) $latest = max($latest, (int)($item['happened_at'] ?? 0));
    foreach (leadNoteRows($db, $leadId) as $item) $latest = max($latest, (int)($item['created_at'] ?? 0));
    foreach (leadDialEventRows($db, $leadId, 5) as $item) $latest = max($latest, (int)($item['dialed_at'] ?? 0));
    return $latest;
}

function leadAllRowsForTarget(SQLite3 $db, $target, $actor, $options = []) {
    $where = ['1=1'];
    $includeMetadata = !empty($options['include_metadata']);
    if ($target['mode'] === 'mine') {
        $where[] = 'll.assigned_to_email = :assigned_to_email';
    } elseif ($target['mode'] === 'user') {
        $where[] = 'll.assigned_to_email = :assigned_to_email';
    }
    $stmt = $db->prepare("
        SELECT
            l.*,
            ll.name AS list_name,
            ll.type AS list_type,
            ll.assigned_to_email AS list_assigned_to_email
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY l.updated_at DESC
    ");
    if ($target['mode'] !== 'all') leadBindText($stmt, ':assigned_to_email', (string)($target['email'] ?: $actor));
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        if ($includeMetadata) {
            $row['metadata'] = leadMetadataArray($row);
        }
        $rows[] = $row;
    }
    return $rows;
}

function leadDashboardLeaderboardRows(SQLite3 $db, $actor) {
    $actor = strtolower(trim((string)$actor));
    $actorTeamId = '';
    if (!leadCanManageLists() && function_exists('getUserTeamId')) {
        $actorTeamId = strtolower(trim((string)getUserTeamId($actor)));
    }

    $stmt = $db->prepare("
        SELECT
            ll.assigned_to_email AS assigned_email,
            COUNT(*) AS stage_progress
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE COALESCE(ll.assigned_to_email, '') <> ''
        GROUP BY ll.assigned_to_email
    ");
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $assignedEmail = strtolower(trim((string)($row['assigned_email'] ?? '')));
        if ($assignedEmail === '') continue;
        if ($actorTeamId !== '' && function_exists('getUserTeamId')) {
            $assignedTeamId = strtolower(trim((string)getUserTeamId($assignedEmail)));
            if ($assignedTeamId === '' || $assignedTeamId !== $actorTeamId) continue;
        }
        $assignedName = leadUserDisplayNameByEmail($assignedEmail);
        $rows[] = [
            'email' => $assignedEmail,
            'name' => $assignedName !== '' ? $assignedName : $assignedEmail,
            'stage_progress' => (int)($row['stage_progress'] ?? 0),
            'funded_value' => 0,
        ];
    }

    usort($rows, function($a, $b) {
        $cmp = (int)($b['stage_progress'] ?? 0) <=> (int)($a['stage_progress'] ?? 0);
        if ($cmp !== 0) return $cmp;
        return (int)($b['funded_value'] ?? 0) <=> (int)($a['funded_value'] ?? 0);
    });
    foreach ($rows as $idx => &$row) {
        $row['rank'] = $idx + 1;
        $row['is_me'] = strtolower((string)($row['email'] ?? '')) === $actor;
    }
    unset($row);
    return $rows;
}

function leadDashboardPipelineRows(SQLite3 $db, $target, $actor, array $stages, $limit = 25) {
    $where = ['1=1'];
    $stageBinds = [];
    foreach (array_values($stages) as $idx => $stage) {
        $key = ':stage_' . $idx;
        $stageBinds[$key] = leadNormalizeStageStatus($stage, 'contacted');
    }
    if ($stageBinds) {
        $where[] = 'l.status IN (' . implode(', ', array_keys($stageBinds)) . ')';
    }
    if ($target['mode'] === 'mine') {
        $where[] = 'll.assigned_to_email = :assigned_to_email';
    } elseif ($target['mode'] === 'user') {
        $where[] = 'll.assigned_to_email = :assigned_to_email';
    }
    $stmt = $db->prepare("
        SELECT
            l.id,
            l.company,
            l.lead_name,
            l.status,
            l.updated_at
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY l.updated_at DESC
        " . ((int)$limit > 0 ? "LIMIT :limit" : "") . "
    ");
    foreach ($stageBinds as $key => $stage) leadBindText($stmt, $key, $stage);
    if ($target['mode'] !== 'all') leadBindText($stmt, ':assigned_to_email', (string)($target['email'] ?: $actor));
    if ((int)$limit > 0) $stmt->bindValue(':limit', max(1, min(500, (int)$limit)), SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    $now = time();
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $latestTouch = (int)($row['updated_at'] ?? 0);
        $stage = leadNormalizeStageStatus($row['status'] ?? 'contacted', 'contacted');
        $rows[] = [
            'lead_id' => (string)($row['id'] ?? ''),
            'company' => (string)($row['company'] ?? ($row['lead_name'] ?? 'Lead')),
            'stage' => $stage,
            'stage_label' => leadStageLabel($stage),
            'days_since_touch' => $latestTouch > 0 ? (int)floor(($now - $latestTouch) / 86400) : 999,
        ];
    }
    return $rows;
}

function leadDashboardPayload(SQLite3 $db, $actor, $target) {
    $today = date('Y-m-d');
    $cards = [
        'meetings' => [],
        'unread' => [],
        'morning' => [],
        'afternoon' => [],
        'other' => [],
    ];
    $leaderboard = [];
    $pipelineHot = leadDashboardPipelineRows($db, $target, $actor, ['info_sent', 'info_received'], 25);
    $pipelineCold = leadDashboardPipelineRows($db, $target, $actor, ['new', 'attempted_contact', 'contacted', 'decision_maker', 'signed_up', 'do_not_contact'], 25);

    $targetWhere = '1=1';
    $targetBindEmail = '';
    if ($target['mode'] === 'mine') {
        $targetWhere = 'll.assigned_to_email = :assigned_to_email';
        $targetBindEmail = (string)$actor;
    } elseif ($target['mode'] === 'user') {
        $targetWhere = 'll.assigned_to_email = :assigned_to_email';
        $targetBindEmail = (string)($target['email'] ?? '');
    }

    $activityStmt = $db->prepare("
        SELECT ai.*, l.company
        FROM lead_activity_items ai
        JOIN leads l ON l.id = ai.lead_id
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE $targetWhere
          AND ai.activity_type IN ('email', 'sms')
          AND LOWER(COALESCE(ai.direction, '')) = 'in'
        ORDER BY ai.happened_at DESC
        LIMIT 250
    ");
    if ($targetBindEmail !== '') leadBindText($activityStmt, ':assigned_to_email', $targetBindEmail);
    $activityRes = $activityStmt->execute();
    while ($activityRes && ($item = $activityRes->fetchArray(SQLITE3_ASSOC))) {
        $meta = leadDecodeJsonRowField($item, 'metadata_json') ?: [];
        if (!empty($meta['read_status']) || !empty($meta['is_read'])) continue;
        $cards['unread'][] = [
            'lead_id' => (string)($item['lead_id'] ?? ''),
            'company' => (string)($item['company'] ?? 'Lead'),
            'activity_type' => strtolower((string)($item['activity_type'] ?? '')),
            'sender' => (string)($meta['from'] ?? $meta['from_phone'] ?? $meta['contact_name'] ?? ''),
            'preview' => trim((string)($item['body_text'] ?? $item['subject'] ?? '')),
            'happened_at' => (int)($item['happened_at'] ?? 0),
        ];
    }

    $followupStmt = $db->prepare("
        SELECT fu.*, l.company
        FROM lead_followups fu
        JOIN leads l ON l.id = fu.lead_id
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE $targetWhere
          AND LOWER(COALESCE(fu.status, 'open')) = 'open'
          AND COALESCE(fu.due_at, 0) > 0
        ORDER BY fu.due_at ASC
        LIMIT 400
    ");
    if ($targetBindEmail !== '') leadBindText($followupStmt, ':assigned_to_email', $targetBindEmail);
    $followupRes = $followupStmt->execute();
    while ($followupRes && ($followup = $followupRes->fetchArray(SQLITE3_ASSOC))) {
        $meta = leadDecodeJsonRowField($followup, 'metadata_json') ?: [];
        $dueAt = (int)($followup['due_at'] ?? 0);
        if ($dueAt <= 0) continue;
        $provider = strtolower(trim((string)($meta['provider'] ?? '')));
        if ($provider === 'google_calendar') {
            $cards['meetings'][] = [
                'lead_id' => (string)($followup['lead_id'] ?? ''),
                'company' => (string)($followup['company'] ?? 'Lead'),
                'contact_name' => (string)($meta['contact_name'] ?? ''),
                'title' => (string)($followup['title'] ?? ''),
                'due_at' => $dueAt,
                'calendar_meet_link' => (string)($meta['calendar_meet_link'] ?? ''),
            ];
            continue;
        }
        $slot = 'other';
        $hour = (int)date('G', $dueAt);
        if ($hour < 12) $slot = 'morning';
        elseif ($hour < 17) $slot = 'afternoon';
        $cards[$slot][] = [
            'lead_id' => (string)($followup['lead_id'] ?? ''),
            'company' => (string)($followup['company'] ?? 'Lead'),
            'contact_name' => (string)($meta['contact_name'] ?? ''),
            'title' => (string)($followup['title'] ?? ''),
            'body' => (string)($followup['body'] ?? ''),
            'due_at' => $dueAt,
            'slot' => $slot,
            'provider' => (string)($meta['provider'] ?? ''),
            'is_overdue' => date('Y-m-d', $dueAt) < $today,
        ];
    }

    usort($cards['meetings'], fn($a, $b) => (int)($a['due_at'] ?? 0) <=> (int)($b['due_at'] ?? 0));
    usort($cards['unread'], fn($a, $b) => (int)($b['happened_at'] ?? 0) <=> (int)($a['happened_at'] ?? 0));
    foreach (['morning', 'afternoon', 'other'] as $slot) {
        usort($cards[$slot], fn($a, $b) => (int)($a['due_at'] ?? 0) <=> (int)($b['due_at'] ?? 0));
    }
    $leaderboard = leadDashboardLeaderboardRows($db, $actor);
    return [
        'success' => true,
        'today' => date('c'),
        'cards' => [
            'meetings' => array_slice($cards['meetings'], 0, 25),
            'unread' => array_slice($cards['unread'], 0, 25),
            'morning' => array_slice($cards['morning'], 0, 25),
            'afternoon' => array_slice($cards['afternoon'], 0, 25),
            'other' => array_slice($cards['other'], 0, 25),
        ],
        'tasks' => leadDashboardTaskRows($db, $target, $actor),
        'task_assignee' => $target['mode'] === 'user' ? (string)$target['email'] : $actor,
        'leaderboard' => array_slice($leaderboard, 0, 20),
        'pipeline' => [
            'hot' => array_slice($pipelineHot, 0, 25),
            'cold' => array_slice($pipelineCold, 0, 25),
        ],
        'sales_users' => leadSalesUsers(),
    ];
}

function leadPipelinePayload(SQLite3 $db, $actor, $target) {
    $rows = leadAllRowsForTarget($db, $target, $actor);
    $columns = [];
    foreach (['new','attempted_contact','contacted','decision_maker','info_sent','info_received','signed_up','do_not_contact'] as $stage) {
        $columns[$stage] = ['key' => $stage, 'label' => leadStageLabel($stage), 'count' => 0, 'leads' => []];
    }
    foreach ($rows as $row) {
        $stage = leadNormalizeStageStatus($row['status'] ?? 'contacted', 'contacted');
        if (!isset($columns[$stage])) $columns[$stage] = ['key' => $stage, 'label' => leadStageLabel($stage), 'count' => 0, 'leads' => []];
        $activeSequence = leadSequenceStateForLead($row);
        $nextFollowup = 0;
        foreach (leadFollowupRows($db, (string)$row['id']) as $followup) {
            if (strtolower((string)($followup['status'] ?? 'open')) !== 'open') continue;
            $dueAt = (int)($followup['due_at'] ?? 0);
            if ($dueAt > 0 && ($nextFollowup === 0 || $dueAt < $nextFollowup)) $nextFollowup = $dueAt;
        }
        $columns[$stage]['leads'][] = [
            'lead_id' => (string)($row['id'] ?? ''),
            'company' => (string)($row['company'] ?? ($row['lead_name'] ?? 'Lead')),
            'assigned_to_email' => (string)($row['list_assigned_to_email'] ?? $row['assigned_to_email'] ?? ''),
            'assigned_to_name' => leadUserDisplayNameByEmail((string)($row['list_assigned_to_email'] ?? $row['assigned_to_email'] ?? '')),
            'list_name' => (string)($row['list_name'] ?? ''),
            'city' => (string)($row['city'] ?? ''),
            'state' => (string)($row['state'] ?? ''),
            'updated_at' => (int)($row['updated_at'] ?? 0),
            'next_followup_at' => $nextFollowup,
            'active_sequence' => $activeSequence,
        ];
        $columns[$stage]['count'] += 1;
    }
    return [
        'success' => true,
        'columns' => array_values($columns),
        'sales_users' => leadSalesUsers(),
    ];
}

function leadSequencesPayload(SQLite3 $db, $actor, $target) {
    $rows = leadAllRowsForTarget($db, $target, $actor);
    $summaryMap = [];
    $detail = [];
    foreach ($rows as $row) {
        $sequence = leadSequenceStateForLead($row);
        if (!$sequence) continue;
        $key = (string)($sequence['sequence_key'] ?? 'sequence');
        if (!isset($summaryMap[$key])) {
            $summaryMap[$key] = [
                'key' => $key,
                'label' => (string)($sequence['sequence_label'] ?? $key),
                'total' => 0,
                'active' => 0,
                'paused' => 0,
                'completed' => 0,
            ];
        }
        $summaryMap[$key]['total'] += 1;
        $status = strtolower(trim((string)($sequence['status'] ?? 'active')));
        if (isset($summaryMap[$key][$status])) $summaryMap[$key][$status] += 1;
        $detail[] = [
            'lead_id' => (string)($row['id'] ?? ''),
            'company' => (string)($row['company'] ?? ($row['lead_name'] ?? 'Lead')),
            'sequence_key' => $key,
            'sequence_label' => (string)($sequence['sequence_label'] ?? $key),
            'status' => $status,
            'next_step' => (string)($sequence['next_step'] ?? ''),
            'pause_reason' => (string)($sequence['pause_reason'] ?? ''),
            'assigned_to_email' => (string)($row['list_assigned_to_email'] ?? $row['assigned_to_email'] ?? ''),
            'assigned_to_name' => leadUserDisplayNameByEmail((string)($row['list_assigned_to_email'] ?? $row['assigned_to_email'] ?? '')),
            'lead_status' => leadStageLabel($row['status'] ?? 'contacted'),
            'updated_at' => (int)($sequence['updated_at'] ?? $row['updated_at'] ?? 0),
        ];
    }
    usort($detail, fn($a, $b) => (int)($b['updated_at'] ?? 0) <=> (int)($a['updated_at'] ?? 0));
    return [
        'success' => true,
        'summary' => array_values($summaryMap),
        'rows' => $detail,
        'sales_users' => leadSalesUsers(),
    ];
}

function leadSaveContactMetadata(SQLite3 $db, $contactId, array $metadata, $actor, $now) {
    $stmt = $db->prepare("
        UPDATE lead_contacts
        SET metadata_json = :metadata_json,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    $json = leadJsonEncode($metadata);
    if ($json === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $json);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $contactId);
    return (bool)$stmt->execute();
}

function leadAddOrgCredits($organizationId, $amount, $actor, $note = '') {
    if (!function_exists('orgRead') || !function_exists('orgWrite')) return ['ok' => false, 'error' => 'Organizations module unavailable'];
    $organizationId = strtolower(trim((string)$organizationId));
    if ($organizationId === '') return ['ok' => false, 'error' => 'Lead is not paired to an account'];
    $org = orgRead($organizationId);
    if (!is_array($org)) return ['ok' => false, 'error' => 'Customer account not found'];
    if (!function_exists('orgEnsureCreditsFields')) return ['ok' => false, 'error' => 'Credits support unavailable'];
    orgEnsureCreditsFields($org);
    $amount = (int)$amount;
    if ($amount < 1) return ['ok' => false, 'error' => 'Enter a credit amount greater than 0'];
    $org['credits_balance'] = (int)($org['credits_balance'] ?? 0) + $amount;
    $org['credits_ledger'][] = [
        'ts' => date('c'),
        'delta' => $amount,
        'reason' => 'crm_free_credits',
        'by_email' => $actor,
        'meta' => ['note' => $note],
        'unit' => 'usd_dollars',
    ];
    if (!orgWrite($organizationId, $org)) return ['ok' => false, 'error' => 'Could not save the account credits'];
    return ['ok' => true];
}

function leadAnalyticsMetricDefs() {
    return [
        'info_sent' => ['label' => 'Info Sent', 'color' => '#2563eb', 'currency' => false],
        'info_received' => ['label' => 'Info Received', 'color' => '#059669', 'currency' => false],
        'sign_ups' => ['label' => 'Sign Ups', 'color' => '#7c3aed', 'currency' => false],
        'funded_500_plus' => ['label' => 'Funded $500+', 'color' => '#d97706', 'currency' => false],
        'funded_value' => ['label' => 'Funded Value', 'color' => '#16a34a', 'currency' => true],
        'calls_made' => ['label' => 'Calls Made', 'color' => '#dc2626', 'currency' => false],
        'conversations' => ['label' => 'Conversations', 'color' => '#0891b2', 'currency' => false],
    ];
}

function leadAnalyticsDefaultDates($mode) {
    $todayStart = strtotime(date('Y-m-d 00:00:00'));
    if ($mode === 'day') {
        return ['start_date' => date('Y-m-d', $todayStart), 'end_date' => date('Y-m-d', $todayStart)];
    }
    if ($mode === 'month') {
        $first = strtotime(date('Y-m-01 00:00:00'));
        $last = strtotime(date('Y-m-t 00:00:00'));
        return ['start_date' => date('Y-m-d', $first), 'end_date' => date('Y-m-d', $last)];
    }
    $weekday = (int)date('N', $todayStart);
    $monday = strtotime('-' . ($weekday - 1) . ' days', $todayStart);
    $sunday = strtotime('+6 days', $monday);
    return ['start_date' => date('Y-m-d', $monday), 'end_date' => date('Y-m-d', $sunday)];
}

function leadAnalyticsNormalizePeriod($mode, $startDate, $endDate) {
    $mode = strtolower(trim((string)$mode));
    if (!in_array($mode, ['day', 'week', 'month'], true)) $mode = 'week';
    $defaults = leadAnalyticsDefaultDates($mode);
    $startDate = trim((string)$startDate) !== '' ? trim((string)$startDate) : $defaults['start_date'];
    $endDate = trim((string)$endDate) !== '' ? trim((string)$endDate) : $defaults['end_date'];
    $startTs = strtotime($startDate . ' 00:00:00');
    $endTs = strtotime($endDate . ' 23:59:59');
    if (!$startTs || !$endTs) {
        $startTs = strtotime($defaults['start_date'] . ' 00:00:00');
        $endTs = strtotime($defaults['end_date'] . ' 23:59:59');
        $startDate = $defaults['start_date'];
        $endDate = $defaults['end_date'];
    }
    if ($endTs < $startTs) {
        $tmpTs = $startTs;
        $startTs = strtotime(date('Y-m-d 00:00:00', $endTs));
        $endTs = strtotime(date('Y-m-d 23:59:59', $tmpTs));
        $tmpDate = $startDate;
        $startDate = $endDate;
        $endDate = $tmpDate;
    }
    return [
        'mode' => $mode,
        'start_date' => date('Y-m-d', $startTs),
        'end_date' => date('Y-m-d', $endTs),
        'start_ts' => $startTs,
        'end_ts' => $endTs,
        'span_days' => max(1, (int)floor(($endTs - $startTs) / 86400) + 1),
    ];
}

function leadAnalyticsComparePeriod(array $period, $compare) {
    $compare = strtolower(trim((string)$compare));
    if ($compare === '' || $compare === 'none') {
        return ['compare' => 'none', 'compare_label' => '', 'start_ts' => 0, 'end_ts' => 0, 'offset_seconds' => 0];
    }
    if ($compare === 'last_week') {
        $offset = 7 * 86400;
        return [
            'compare' => 'last_week',
            'compare_label' => 'Last Week',
            'start_ts' => $period['start_ts'] - $offset,
            'end_ts' => $period['end_ts'] - $offset,
            'offset_seconds' => $offset,
        ];
    }
    $offset = $period['span_days'] * 86400;
    return [
        'compare' => 'previous_period',
        'compare_label' => 'Previous Period',
        'start_ts' => $period['start_ts'] - $offset,
        'end_ts' => $period['end_ts'] - $offset,
        'offset_seconds' => $offset,
    ];
}

function leadAnalyticsBuckets(array $period) {
    $buckets = [];
    if ($period['mode'] === 'day' && $period['span_days'] <= 1) {
        $dayStart = strtotime(date('Y-m-d 00:00:00', $period['start_ts']));
        for ($i = 0; $i < 8; $i++) {
            $start = $dayStart + ($i * 3 * 3600);
            $end = min($start + (3 * 3600) - 1, $dayStart + 86399);
            $buckets[] = [
                'label' => date('gA', $start),
                'start_ts' => $start,
                'end_ts' => $end,
            ];
        }
        return $buckets;
    }
    $cursor = strtotime(date('Y-m-d 00:00:00', $period['start_ts']));
    $last = strtotime(date('Y-m-d 00:00:00', $period['end_ts']));
    while ($cursor <= $last) {
        $buckets[] = [
            'label' => date($period['mode'] === 'month' ? 'M j' : 'D', $cursor),
            'start_ts' => $cursor,
            'end_ts' => min($cursor + 86399, $period['end_ts']),
        ];
        $cursor = strtotime('+1 day', $cursor);
    }
    return $buckets;
}

function leadAnalyticsBucketIndex($ts, array $buckets) {
    $ts = (int)$ts;
    foreach ($buckets as $idx => $bucket) {
        if ($ts >= (int)$bucket['start_ts'] && $ts <= (int)$bucket['end_ts']) return $idx;
    }
    return -1;
}

function leadAnalyticsTrendMeta($current, $previous) {
    $current = (float)$current;
    $previous = (float)$previous;
    if (abs($current - $previous) < 0.0001) return ['trend' => 'flat', 'delta_text' => '0%'];
    if ($previous <= 0.0) {
        return ['trend' => $current > 0 ? 'up' : 'flat', 'delta_text' => $current > 0 ? '+100%' : '0%'];
    }
    $pct = (($current - $previous) / $previous) * 100;
    $rounded = (int)round($pct);
    return [
        'trend' => $rounded > 0 ? 'up' : ($rounded < 0 ? 'down' : 'flat'),
        'delta_text' => ($rounded > 0 ? '+' : '') . $rounded . '%',
    ];
}

function leadAnalyticsStageRank($stage) {
    static $ranks = [
        'new' => 0,
        'attempted_contact' => 1,
        'contacted' => 2,
        'decision_maker' => 3,
        'info_sent' => 4,
        'info_received' => 5,
        'signed_up' => 6,
        'do_not_contact' => 7,
    ];
    return $ranks[leadNormalizeStageStatus($stage, 'new')] ?? 0;
}

function leadAnalyticsDialIsConversation($context) {
    $context = is_array($context) ? $context : [];
    foreach (['led_to_a_conversation', 'led_to_a_connect', 'conversation', 'connected'] as $key) {
        $value = strtolower(trim((string)($context[$key] ?? '')));
        if (in_array($value, ['1', 'true', 'yes', 'y'], true)) return true;
    }
    $disposition = strtolower(trim((string)($context['disposition'] ?? '')));
    if ($disposition !== '') {
        foreach (['decision maker', 'gatekeeper', 'conversation', 'info sent', 'info received', 'objection'] as $needle) {
            if (strpos($disposition, $needle) !== false) return true;
        }
    }
    return false;
}

function leadAnalyticsFundingEventRows($org) {
    $org = is_array($org) ? $org : [];
    $ledger = is_array($org['credits_ledger'] ?? null) ? $org['credits_ledger'] : [];
    $events = [];
    foreach ($ledger as $entry) {
        if (!is_array($entry)) continue;
        $delta = (int)($entry['delta'] ?? $entry['amount'] ?? 0);
        if ($delta <= 0) continue;
        $reason = strtolower(trim((string)($entry['reason'] ?? '')));
        if ($reason === 'crm_free_credits') continue;
        $isFunding = false;
        foreach (['stripe', 'checkout', 'payment', 'topup', 'top_up', 'purchase', 'auto_topup'] as $needle) {
            if (strpos($reason, $needle) !== false) {
                $isFunding = true;
                break;
            }
        }
        if (!$isFunding) continue;
        $rawTs = $entry['ts'] ?? $entry['created_at'] ?? $entry['timestamp'] ?? 0;
        $ts = is_numeric($rawTs) ? (int)$rawTs : (strtotime((string)$rawTs) ?: 0);
        if ($ts <= 0) continue;
        $events[] = ['ts' => $ts, 'delta' => $delta, 'reason' => $reason];
    }
    usort($events, fn($a, $b) => (int)$a['ts'] <=> (int)$b['ts']);
    return $events;
}

function leadAnalyticsOrgSummary($org) {
    $events = leadAnalyticsFundingEventRows($org);
    $lifetimeRevenue = (int)($org['lifetimeRevenue'] ?? 0);
    if ($lifetimeRevenue <= 0) {
        foreach ($events as $event) $lifetimeRevenue += (int)$event['delta'];
    }
    $running = 0;
    $crossTs = 0;
    foreach ($events as $event) {
        $running += (int)$event['delta'];
        if ($crossTs === 0 && $running >= 500) {
            $crossTs = (int)$event['ts'];
            break;
        }
    }
    return [
        'funded' => $running > 0 || $lifetimeRevenue > 0,
        'lifetime_revenue' => $lifetimeRevenue,
        'orders_10' => (int)($org['lifetimeOrders'] ?? count((array)($org['orders'] ?? []))) >= 10,
        'events' => $events,
        'cross_500_ts' => $crossTs,
    ];
}

function leadAnalyticsListOptions(array $rows) {
    $lists = [];
    foreach ($rows as $row) {
        $id = (string)($row['list_id'] ?? '');
        if ($id === '') continue;
        if (!isset($lists[$id])) {
            $lists[$id] = ['id' => $id, 'name' => (string)($row['list_name'] ?? 'Unnamed List')];
        }
    }
    usort($lists, function($a, $b) {
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    return array_values($lists);
}

function leadAnalyticsPayload(SQLite3 $db, $actor, $target) {
    $period = leadAnalyticsNormalizePeriod(
        leadText('mode', 'week'),
        leadText('start_date'),
        leadText('end_date')
    );
    $compareWindow = leadAnalyticsComparePeriod($period, leadText('compare', 'last_week'));
    $selectedListId = leadText('list_id');

    $rows = leadAllRowsForTarget($db, $target, $actor);
    if ($selectedListId !== '') {
        $rows = array_values(array_filter($rows, function($row) use ($selectedListId) {
            return (string)($row['list_id'] ?? '') === $selectedListId;
        }));
    }

    $lists = leadAnalyticsListOptions($rows);
    $metrics = leadAnalyticsMetricDefs();
    $buckets = leadAnalyticsBuckets($period);
    $labels = array_map(fn($bucket) => (string)$bucket['label'], $buckets);
    $currentSeries = [];
    $previousSeries = [];
    $currentTotals = [];
    $previousTotals = [];
    foreach (array_keys($metrics) as $metricKey) {
        $currentSeries[$metricKey] = array_fill(0, count($buckets), 0);
        $previousSeries[$metricKey] = $compareWindow['compare'] === 'none' ? [] : array_fill(0, count($buckets), 0);
        $currentTotals[$metricKey] = 0;
        $previousTotals[$metricKey] = 0;
    }

    $orgCache = [];
    foreach ($rows as $row) {
        $orgId = strtolower(trim((string)($row['organization_id'] ?? '')));
        if ($orgId !== '' && !isset($orgCache[$orgId])) {
            $orgCache[$orgId] = leadAnalyticsOrgSummary(leadOrganizationSnapshotForLead($orgId, $actor));
        }
    }

    $stageRowsByLead = [];
    $stageStmt = $db->prepare("
        SELECT ai.lead_id, ai.subject, ai.metadata_json, ai.happened_at
        FROM lead_activity_items ai
        JOIN leads l ON l.id = ai.lead_id
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE ai.activity_type = 'stage'
          AND ai.happened_at >= :min_happened_at
          AND ai.happened_at <= :max_happened_at
          AND (
            :target_mode = 'all'
            OR ll.assigned_to_email = :target_email
          )
          AND (:list_id = '' OR l.list_id = :list_id)
        ORDER BY ai.lead_id ASC, ai.happened_at ASC, ai.created_at ASC
    ");
    leadBindText($stageStmt, ':target_mode', (string)$target['mode']);
    leadBindText($stageStmt, ':target_email', (string)($target['email'] ?? ''));
    leadBindText($stageStmt, ':list_id', $selectedListId);
    $stageStmt->bindValue(':min_happened_at', min($period['start_ts'], $compareWindow['start_ts'] ?: $period['start_ts']), SQLITE3_INTEGER);
    $stageStmt->bindValue(':max_happened_at', max($period['end_ts'], $compareWindow['end_ts'] ?: $period['end_ts']), SQLITE3_INTEGER);
    $stageRes = $stageStmt->execute();
    while ($stageRes && ($item = $stageRes->fetchArray(SQLITE3_ASSOC))) {
        $meta = leadDecodeJsonRowField($item, 'metadata_json') ?: [];
        $stage = leadNormalizeStageStatus((string)($meta['to'] ?? $item['subject'] ?? ''), '');
        if ($stage === '') continue;
        $ts = (int)($item['happened_at'] ?? 0);
        $leadId = (string)($item['lead_id'] ?? '');
        if ($leadId !== '') $stageRowsByLead[$leadId][] = ['stage' => $stage, 'ts' => $ts];
        $bucketIdx = leadAnalyticsBucketIndex($ts, $buckets);
        $previousIdx = $compareWindow['compare'] === 'none' ? -1 : leadAnalyticsBucketIndex($ts + $compareWindow['offset_seconds'], $buckets);
        if ($stage === 'info_sent') {
            if ($bucketIdx >= 0 && $ts >= $period['start_ts'] && $ts <= $period['end_ts']) {
                $currentSeries['info_sent'][$bucketIdx] += 1;
                $currentTotals['info_sent'] += 1;
            } elseif ($previousIdx >= 0 && $ts >= $compareWindow['start_ts'] && $ts <= $compareWindow['end_ts']) {
                $previousSeries['info_sent'][$previousIdx] += 1;
                $previousTotals['info_sent'] += 1;
            }
        } elseif ($stage === 'info_received') {
            if ($bucketIdx >= 0 && $ts >= $period['start_ts'] && $ts <= $period['end_ts']) {
                $currentSeries['info_received'][$bucketIdx] += 1;
                $currentTotals['info_received'] += 1;
            } elseif ($previousIdx >= 0 && $ts >= $compareWindow['start_ts'] && $ts <= $compareWindow['end_ts']) {
                $previousSeries['info_received'][$previousIdx] += 1;
                $previousTotals['info_received'] += 1;
            }
        } elseif ($stage === 'signed_up') {
            if ($bucketIdx >= 0 && $ts >= $period['start_ts'] && $ts <= $period['end_ts']) {
                $currentSeries['sign_ups'][$bucketIdx] += 1;
                $currentTotals['sign_ups'] += 1;
            } elseif ($previousIdx >= 0 && $ts >= $compareWindow['start_ts'] && $ts <= $compareWindow['end_ts']) {
                $previousSeries['sign_ups'][$previousIdx] += 1;
                $previousTotals['sign_ups'] += 1;
            }
        }
    }

    $dialStmt = $db->prepare("
        SELECT de.context_json, de.dialed_at
        FROM lead_dial_events de
        JOIN leads l ON l.id = de.lead_id
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE de.dialed_at >= :min_dialed_at
          AND de.dialed_at <= :max_dialed_at
          AND (
            :target_mode = 'all'
            OR ll.assigned_to_email = :target_email
          )
          AND (:list_id = '' OR l.list_id = :list_id)
        ORDER BY de.dialed_at ASC
    ");
    leadBindText($dialStmt, ':target_mode', (string)$target['mode']);
    leadBindText($dialStmt, ':target_email', (string)($target['email'] ?? ''));
    leadBindText($dialStmt, ':list_id', $selectedListId);
    $dialStmt->bindValue(':min_dialed_at', min($period['start_ts'], $compareWindow['start_ts'] ?: $period['start_ts']), SQLITE3_INTEGER);
    $dialStmt->bindValue(':max_dialed_at', max($period['end_ts'], $compareWindow['end_ts'] ?: $period['end_ts']), SQLITE3_INTEGER);
    $dialRes = $dialStmt->execute();
    while ($dialRes && ($item = $dialRes->fetchArray(SQLITE3_ASSOC))) {
        $ts = (int)($item['dialed_at'] ?? 0);
        $bucketIdx = leadAnalyticsBucketIndex($ts, $buckets);
        $previousIdx = $compareWindow['compare'] === 'none' ? -1 : leadAnalyticsBucketIndex($ts + $compareWindow['offset_seconds'], $buckets);
        $isCurrent = $ts >= $period['start_ts'] && $ts <= $period['end_ts'];
        $isPrevious = $compareWindow['compare'] !== 'none' && $ts >= $compareWindow['start_ts'] && $ts <= $compareWindow['end_ts'];
        $isConversation = leadAnalyticsDialIsConversation(leadDecodeJsonRowField($item, 'context_json') ?: []);
        if ($isCurrent && $bucketIdx >= 0) {
            $currentSeries['calls_made'][$bucketIdx] += 1;
            $currentTotals['calls_made'] += 1;
            if ($isConversation) {
                $currentSeries['conversations'][$bucketIdx] += 1;
                $currentTotals['conversations'] += 1;
            }
        } elseif ($isPrevious && $previousIdx >= 0) {
            $previousSeries['calls_made'][$previousIdx] += 1;
            $previousTotals['calls_made'] += 1;
            if ($isConversation) {
                $previousSeries['conversations'][$previousIdx] += 1;
                $previousTotals['conversations'] += 1;
            }
        }
    }

    foreach ($rows as $row) {
        $orgId = strtolower(trim((string)($row['organization_id'] ?? '')));
        if ($orgId === '' || !isset($orgCache[$orgId])) continue;
        $orgSummary = $orgCache[$orgId];
        foreach ($orgSummary['events'] as $event) {
            $ts = (int)$event['ts'];
            $bucketIdx = leadAnalyticsBucketIndex($ts, $buckets);
            $previousIdx = $compareWindow['compare'] === 'none' ? -1 : leadAnalyticsBucketIndex($ts + $compareWindow['offset_seconds'], $buckets);
            if ($ts >= $period['start_ts'] && $ts <= $period['end_ts'] && $bucketIdx >= 0) {
                $currentSeries['funded_value'][$bucketIdx] += (int)$event['delta'];
                $currentTotals['funded_value'] += (int)$event['delta'];
            } elseif ($compareWindow['compare'] !== 'none' && $ts >= $compareWindow['start_ts'] && $ts <= $compareWindow['end_ts'] && $previousIdx >= 0) {
                $previousSeries['funded_value'][$previousIdx] += (int)$event['delta'];
                $previousTotals['funded_value'] += (int)$event['delta'];
            }
        }
        $crossTs = (int)($orgSummary['cross_500_ts'] ?? 0);
        if ($crossTs > 0) {
            $bucketIdx = leadAnalyticsBucketIndex($crossTs, $buckets);
            $previousIdx = $compareWindow['compare'] === 'none' ? -1 : leadAnalyticsBucketIndex($crossTs + $compareWindow['offset_seconds'], $buckets);
            if ($crossTs >= $period['start_ts'] && $crossTs <= $period['end_ts'] && $bucketIdx >= 0) {
                $currentSeries['funded_500_plus'][$bucketIdx] += 1;
                $currentTotals['funded_500_plus'] += 1;
            } elseif ($compareWindow['compare'] !== 'none' && $crossTs >= $compareWindow['start_ts'] && $crossTs <= $compareWindow['end_ts'] && $previousIdx >= 0) {
                $previousSeries['funded_500_plus'][$previousIdx] += 1;
                $previousTotals['funded_500_plus'] += 1;
            }
        }
    }

    $pipelineGroups = [];
    $geoGroups = [];
    $sequenceGroups = [];
    foreach ($rows as $row) {
        $repEmail = strtolower(trim((string)($row['list_assigned_to_email'] ?? $row['assigned_to_email'] ?? '')));
        $repKey = $repEmail !== '' ? $repEmail : '__unassigned__';
        if (!isset($pipelineGroups[$repKey])) {
            $name = $repEmail !== '' ? leadUserDisplayNameByEmail($repEmail) : 'Unassigned';
            $pipelineGroups[$repKey] = [
                'rep_name' => $name !== '' ? $name : ($repEmail !== '' ? $repEmail : 'Unassigned'),
                'avatar_color' => ['#2563eb','#7c3aed','#dc2626','#059669','#d97706','#4f46e5','#0891b2','#be185d'][count($pipelineGroups) % 8],
                'avatar_initials' => '',
                'leads' => 0,
                'contacted' => 0,
                'info_sent' => 0,
                'info_received' => 0,
                'sign_ups' => 0,
                'funded' => 0,
                'funded_value' => 0,
                'orders_10' => 0,
                '_seen_orgs' => [],
            ];
            $parts = preg_split('/\s+/', trim((string)$pipelineGroups[$repKey]['rep_name']));
            $initials = '';
            foreach ($parts as $part) {
                if ($part === '') continue;
                $initials .= strtoupper(substr($part, 0, 1));
                if (strlen($initials) >= 2) break;
            }
            $pipelineGroups[$repKey]['avatar_initials'] = $initials !== '' ? $initials : 'R';
        }
        $stateKey = strtoupper(trim((string)($row['state'] ?? '')));
        if ($stateKey === '') $stateKey = 'Unknown';
        if (!isset($geoGroups[$stateKey])) {
            $geoGroups[$stateKey] = [
                'label' => $stateKey,
                'state' => $stateKey,
                'leads' => 0,
                'info_sent' => 0,
                'info_received' => 0,
                'sign_ups' => 0,
                'funded' => 0,
                'funded_value' => 0,
                '_seen_orgs' => [],
            ];
        }

        $stage = leadNormalizeStageStatus($row['status'] ?? 'new', 'new');
        $rank = leadAnalyticsStageRank($stage);
        $pipelineGroups[$repKey]['leads'] += 1;
        $geoGroups[$stateKey]['leads'] += 1;
        if ($rank >= leadAnalyticsStageRank('contacted')) $pipelineGroups[$repKey]['contacted'] += 1;
        if ($rank >= leadAnalyticsStageRank('info_sent')) {
            $pipelineGroups[$repKey]['info_sent'] += 1;
            $geoGroups[$stateKey]['info_sent'] += 1;
        }
        if ($rank >= leadAnalyticsStageRank('info_received')) {
            $pipelineGroups[$repKey]['info_received'] += 1;
            $geoGroups[$stateKey]['info_received'] += 1;
        }
        if ($stage === 'signed_up') {
            $pipelineGroups[$repKey]['sign_ups'] += 1;
            $geoGroups[$stateKey]['sign_ups'] += 1;
        }

        $orgId = strtolower(trim((string)($row['organization_id'] ?? '')));
        if ($orgId !== '' && isset($orgCache[$orgId])) {
            $orgSummary = $orgCache[$orgId];
            if (!isset($pipelineGroups[$repKey]['_seen_orgs'][$orgId])) {
                $pipelineGroups[$repKey]['_seen_orgs'][$orgId] = true;
                if ($orgSummary['funded']) $pipelineGroups[$repKey]['funded'] += 1;
                $pipelineGroups[$repKey]['funded_value'] += (int)($orgSummary['lifetime_revenue'] ?? 0);
                if (!empty($orgSummary['orders_10'])) $pipelineGroups[$repKey]['orders_10'] += 1;
            }
            if (!isset($geoGroups[$stateKey]['_seen_orgs'][$orgId])) {
                $geoGroups[$stateKey]['_seen_orgs'][$orgId] = true;
                if ($orgSummary['funded']) $geoGroups[$stateKey]['funded'] += 1;
                $geoGroups[$stateKey]['funded_value'] += (int)($orgSummary['lifetime_revenue'] ?? 0);
            }
        }

        $sequence = leadSequenceStateForLead($row);
        if ($sequence) {
            $key = strtolower(trim((string)($sequence['sequence_key'] ?? 'sequence')));
            if (!isset($sequenceGroups[$key])) {
                $sequenceGroups[$key] = [
                    'name' => (string)($sequence['sequence_label'] ?? $key),
                    'active' => 0,
                    'completed' => 0,
                    'paused' => 0,
                    'stopped' => 0,
                    'total' => 0,
                ];
            }
            $status = strtolower(trim((string)($sequence['status'] ?? 'active')));
            if (!isset($sequenceGroups[$key][$status])) $sequenceGroups[$key][$status] = 0;
            $sequenceGroups[$key][$status] += 1;
            $sequenceGroups[$key]['total'] += 1;
        }
    }

    $pipelineRows = array_values(array_map(function($row) {
        $leads = max(1, (int)$row['leads']);
        $row['contacted_pct'] = round(((int)$row['contacted'] / $leads) * 100);
        $row['info_sent_pct'] = round(((int)$row['info_sent'] / $leads) * 100);
        $row['info_received_pct'] = round(((int)$row['info_received'] / $leads) * 100);
        unset($row['_seen_orgs']);
        return $row;
    }, $pipelineGroups));
    usort($pipelineRows, fn($a, $b) => (int)($b['sign_ups'] ?? 0) <=> (int)($a['sign_ups'] ?? 0));
    if ($pipelineRows) {
        $total = [
            'rep_name' => 'Team Total',
            'avatar_color' => '#1a1f2e',
            'avatar_initials' => 'TT',
            'leads' => 0,
            'contacted' => 0,
            'info_sent' => 0,
            'info_received' => 0,
            'sign_ups' => 0,
            'funded' => 0,
            'funded_value' => 0,
            'orders_10' => 0,
            'is_total' => true,
        ];
        foreach ($pipelineRows as $row) {
            foreach (['leads', 'contacted', 'info_sent', 'info_received', 'sign_ups', 'funded', 'funded_value', 'orders_10'] as $field) {
                $total[$field] += (int)($row[$field] ?? 0);
            }
        }
        $total['contacted_pct'] = $total['leads'] > 0 ? round(($total['contacted'] / $total['leads']) * 100) : 0;
        $total['info_sent_pct'] = $total['leads'] > 0 ? round(($total['info_sent'] / $total['leads']) * 100) : 0;
        $total['info_received_pct'] = $total['leads'] > 0 ? round(($total['info_received'] / $total['leads']) * 100) : 0;
        $pipelineRows[] = $total;
    }

    $geoRows = array_values(array_map(function($row) {
        unset($row['_seen_orgs']);
        return $row;
    }, $geoGroups));
    usort($geoRows, fn($a, $b) => (int)($b['sign_ups'] ?? 0) <=> (int)($a['sign_ups'] ?? 0));
    if ($geoRows) {
        $total = ['label' => 'Total', 'state' => 'Total', 'leads' => 0, 'info_sent' => 0, 'info_received' => 0, 'sign_ups' => 0, 'funded' => 0, 'funded_value' => 0, 'is_total' => true];
        foreach ($geoRows as $row) {
            foreach (['leads', 'info_sent', 'info_received', 'sign_ups', 'funded', 'funded_value'] as $field) {
                $total[$field] += (int)($row[$field] ?? 0);
            }
        }
        $geoRows[] = $total;
    }

    $sequenceRows = array_values($sequenceGroups);
    usort($sequenceRows, fn($a, $b) => strcmp((string)$a['name'], (string)$b['name']));
    if ($sequenceRows) {
        $total = ['name' => 'All Sequences', 'active' => 0, 'completed' => 0, 'paused' => 0, 'stopped' => 0, 'total' => 0, 'is_total' => true];
        foreach ($sequenceRows as $row) {
            foreach (['active', 'completed', 'paused', 'stopped', 'total'] as $field) {
                $total[$field] += (int)($row[$field] ?? 0);
            }
        }
        $sequenceRows[] = $total;
    }

    $velocityRows = [];
    foreach ($stageRowsByLead as $leadId => $events) {
        usort($events, fn($a, $b) => (int)$a['ts'] <=> (int)$b['ts']);
        for ($i = 1; $i < count($events); $i++) {
            $prev = $events[$i - 1];
            $curr = $events[$i];
            if ($curr['stage'] === $prev['stage']) continue;
            if ((int)$curr['ts'] < $period['start_ts'] || (int)$curr['ts'] > $period['end_ts']) continue;
            $label = leadStageLabel($prev['stage']) . ' -> ' . leadStageLabel($curr['stage']);
            $days = max(0, (($curr['ts'] - $prev['ts']) / 86400));
            if (!isset($velocityRows[$label])) $velocityRows[$label] = [];
            $velocityRows[$label][] = $days;
        }
    }
    $velocityTable = [];
    foreach ($velocityRows as $label => $values) {
        sort($values);
        $count = count($values);
        if ($count === 0) continue;
        $mid = (int)floor($count / 2);
        $median = $count % 2 ? $values[$mid] : (($values[$mid - 1] + $values[$mid]) / 2);
        $velocityTable[] = [
            'label' => $label,
            'avg_days' => round(array_sum($values) / $count, 1),
            'median_days' => round($median, 1),
            'min_days' => round(min($values), 1),
            'max_days' => round(max($values), 1),
            'count' => $count,
        ];
    }
    usort($velocityTable, fn($a, $b) => strcmp((string)$a['label'], (string)$b['label']));

    $summaryCards = [];
    foreach ($metrics as $metricKey => $def) {
        $trend = leadAnalyticsTrendMeta($currentTotals[$metricKey] ?? 0, $previousTotals[$metricKey] ?? 0);
        $summaryCards[] = [
            'label' => $def['label'],
            'current' => $currentTotals[$metricKey] ?? 0,
            'previous' => $compareWindow['compare'] === 'none' ? 0 : ($previousTotals[$metricKey] ?? 0),
            'currency' => !empty($def['currency']),
            'color' => $def['color'],
            'trend' => $trend['trend'],
            'delta_text' => $trend['delta_text'],
        ];
    }

    $maxValue = 0;
    foreach ($metrics as $metricKey => $_def) {
        foreach ((array)($currentSeries[$metricKey] ?? []) as $value) $maxValue = max($maxValue, (float)$value);
        foreach ((array)($previousSeries[$metricKey] ?? []) as $value) $maxValue = max($maxValue, (float)$value);
    }

    return [
        'success' => true,
        'mode' => $period['mode'],
        'start_date' => $period['start_date'],
        'end_date' => $period['end_date'],
        'compare' => $compareWindow['compare'],
        'compare_label' => $compareWindow['compare_label'],
        'summary_cards' => $summaryCards,
        'chart' => [
            'labels' => $labels,
            'metrics' => $metrics,
            'current' => $currentSeries,
            'previous' => $previousSeries,
            'max_value' => $maxValue,
            'pacing_note' => [
                'through_label' => date('M j, Y', $period['end_ts']),
                'current' => (int)($currentTotals['sign_ups'] ?? 0),
                'previous' => (int)($previousTotals['sign_ups'] ?? 0),
                'metric' => 'sign-ups',
                'compare_label' => $compareWindow['compare_label'] !== '' ? strtolower($compareWindow['compare_label']) : 'same range',
            ],
        ],
        'tables' => [
            'pipeline' => $pipelineRows,
            'geographic' => $geoRows,
            'sequences' => $sequenceRows,
            'velocity' => $velocityTable,
        ],
        'sales_users' => leadSalesUsers(),
        'lists' => $lists,
    ];
}

function leadModernActionHandled($action, SQLite3 $db, $actor, $now) {
    switch ($action) {
        case 'lead_analytics': {
            return leadRunJsonGuard('lead_analytics', function() use ($db, $actor) {
                leadEchoJson(leadAnalyticsPayload($db, $actor, leadViewerTarget($actor)));
                return true;
            });
        }
        case 'lead_orum_import_history': {
            if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
            leadEchoJson([
                'success' => true,
                'history' => leadImportRunsRecent($db, 'orum_csv'),
            ]);
            return true;
        }
        case 'lead_preview_orum_csv': {
            if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
            $tmp = (string)($_FILES['csv_file']['tmp_name'] ?? '');
            if ($tmp === '' || !is_file($tmp)) die(json_encode(['success' => false, 'error' => 'Upload a CSV file first']));
            $previewToken = bin2hex(random_bytes(16));
            $previewPath = leadOrumPreviewPath($previewToken);
            if (!@move_uploaded_file($tmp, $previewPath) && !@copy($tmp, $previewPath)) {
                die(json_encode(['success' => false, 'error' => 'Could not stage the uploaded CSV']));
            }
            $result = leadPreviewOrumCsv($db, $previewPath, $actor, (string)($_FILES['csv_file']['name'] ?? 'orum-import.csv'), $previewToken);
            if (empty($result['success'])) die(json_encode($result));
            $result['history'] = leadImportRunsRecent($db, 'orum_csv');
            leadEchoJson($result);
            return true;
        }
        case 'lead_confirm_orum_import': {
            return leadRunJsonGuard('lead_confirm_orum_import', function() use ($db, $actor, $now) {
            if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
            $previewToken = preg_replace('/[^a-f0-9]/', '', strtolower(leadText('preview_token')));
            if ($previewToken === '') die(json_encode(['success' => false, 'error' => 'Preview token missing']));
            $run = leadImportRunByPreviewToken($db, 'orum_csv', $previewToken);
            if (!$run) die(json_encode(['success' => false, 'error' => 'Preview not found or expired']));
            $meta = is_array($run['metadata'] ?? null) ? $run['metadata'] : [];
            $csvPath = (string)($meta['csv_path'] ?? '');
            if ($csvPath === '' || !is_file($csvPath)) die(json_encode(['success' => false, 'error' => 'Preview file no longer exists. Preview the CSV again.']));
            $import = leadImportOrumCsv($db, $csvPath, $actor);
            if (empty($import['success'])) die(json_encode($import));
            $affectedLists = [];
            foreach ((array)($meta['affected_lists'] ?? []) as $listSummary) {
                $listId = (string)($listSummary['id'] ?? '');
                if ($listId === '') continue;
                $summary = leadOrumListProgressSummary($db, $listId);
                if ($summary) $affectedLists[] = $summary;
            }
            usort($affectedLists, fn($a, $b) => strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? '')));
            $confirmedResult = [
                'rows' => (int)($import['rows'] ?? 0),
                'matched' => (int)($import['matched'] ?? 0),
                'unmatched_count' => (int)($run['unmatched_rows'] ?? count((array)($import['unmatched'] ?? []))),
                'created_calls' => (int)($import['created_calls'] ?? 0),
                'affected_lists' => $affectedLists,
            ];
            $meta['confirmed_result'] = $confirmedResult;
            unset($meta['csv_path']);
            leadUpdateImportRun($db, (string)$run['id'], [
                'status' => 'imported',
                'total_rows' => (int)($import['rows'] ?? 0),
                'matched_rows' => (int)($import['matched'] ?? 0),
                'unmatched_rows' => (int)($run['unmatched_rows'] ?? count((array)($import['unmatched'] ?? []))),
                'created_records' => (int)($import['created_calls'] ?? 0),
                'updated_at' => $now,
                'updated_by_email' => $actor,
                'metadata' => $meta,
            ]);
            @unlink($csvPath);
            leadEchoJson([
                'success' => true,
                'rows' => (int)($import['rows'] ?? 0),
                'matched' => (int)($import['matched'] ?? 0),
                'unmatched_count' => (int)($run['unmatched_rows'] ?? count((array)($import['unmatched'] ?? []))),
                'history' => leadImportRunsRecent($db, 'orum_csv'),
            ]);
            return true;
            });
        }
        case 'lead_get': {
            $id = leadText('id');
            if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing id']));
            $row = leadRowById($db, $id);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $seed = $row;
            $seed['contacts'] = leadContactRows($db, $id);
            $skipExternalSync = !empty($_POST['skip_external_sync']);
            if (!$skipExternalSync && function_exists('gmailSyncLeadActivity')) gmailSyncLeadActivity($db, $seed, $actor, $now, false);
            if (!$skipExternalSync && function_exists('ringcentralSyncForActor')) ringcentralSyncForActor($db, $actor, !empty($_POST['force_ringcentral_sync']), 'lead_get');
            $lead = leadHydratedRow($db, $id, $actor, ['lead_row' => leadRowById($db, $id)]);
            leadEchoJson(['success' => true, 'lead' => $lead]);
            return true;
        }
        case 'lead_sync_gmail': {
            $id = leadText('lead_id');
            $row = leadRowById($db, $id);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $row['contacts'] = leadContactRows($db, $id);
            if (!function_exists('gmailSyncLeadActivity')) die(json_encode(['success' => false, 'error' => 'Gmail integration is unavailable']));
            gmailSyncLeadActivity($db, $row, $actor, $now, true);
            leadEchoJson(['success' => true, 'lead' => leadHydratedRow($db, $id, $actor, ['lead_row' => leadRowById($db, $id)])]);
            return true;
        }
        case 'lead_calendar_day_events': {
            $leadId = leadText('lead_id');
            $date = leadText('date');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            if (!function_exists('gmailCalendarListEventsForDateForActor')) die(json_encode(['success' => false, 'error' => 'Google Calendar integration unavailable']));
            $events = gmailCalendarListEventsForDateForActor($actor, $date, leadText('viewer_timezone'));
            if (empty($events['ok']) && empty($events['success'])) die(json_encode(['success' => false, 'error' => $events['error'] ?? 'Could not load Google Calendar events']));
            $payload = [];
            if (isset($events['data']) && is_array($events['data'])) {
                $payload = $events['data'];
            } elseif (is_array($events)) {
                $payload = $events;
            }
            $eventItems = $payload['items'] ?? $payload['events'] ?? [];
            if (!is_array($eventItems)) $eventItems = [];
            leadEchoJson(['success' => true, 'date' => $date, 'events' => array_values($eventItems)]);
            return true;
        }
        case 'lead_schedule_calendar': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            if (!function_exists('gmailCalendarCreateEventForActor')) die(json_encode(['success' => false, 'error' => 'Google Calendar integration unavailable']));
            $payload = [
                'summary' => leadText('title', 'Scheduled follow-up'),
                'description' => leadText('body'),
                'start_ts' => (int)leadText('start_ts'),
                'end_ts' => (int)leadText('end_ts'),
                'duration_minutes' => max(15, (int)leadText('duration_minutes', 30)),
                'timezone' => leadText('viewer_timezone'),
                'add_meet' => !empty($_POST['add_meet']),
                'attendees' => [],
            ];
            $created = gmailCalendarCreateEventForActor($actor, $payload);
            if (empty($created['ok']) && empty($created['success'])) die(json_encode(['success' => false, 'error' => $created['error'] ?? 'Could not create Google Calendar event']));
            $event = is_array($created['event'] ?? null) ? $created['event'] : $created;
            $scheduledAt = (int)leadText('start_ts');
            $meta = [
                'provider' => 'google_calendar',
                'calendar_event_id' => (string)($event['id'] ?? ''),
                'scheduled_at' => $scheduledAt,
                'calendar_meet_link' => (string)($event['hangoutLink'] ?? ($event['htmlLink'] ?? '')),
            ];
            $stmt = $db->prepare("
                INSERT INTO lead_followups (
                    id, lead_id, list_id, dial_event_id, owner_email, title, body, due_at, status, priority, completed_at,
                    metadata_json, created_at, updated_at, created_by_email, updated_by_email
                ) VALUES (
                    :id, :lead_id, :list_id, '', :owner_email, :title, :body, :due_at, 'open', 'normal', NULL,
                    :metadata_json, :created_at, :updated_at, :created_by_email, :updated_by_email
                )
            ");
            leadBindText($stmt, ':id', leadId('followup'));
            leadBindText($stmt, ':lead_id', $leadId);
            leadBindText($stmt, ':list_id', (string)($row['list_id'] ?? ''));
            leadBindText($stmt, ':owner_email', $actor);
            leadBindText($stmt, ':title', leadText('title', 'Scheduled follow-up'));
            leadBindText($stmt, ':body', leadText('body'));
            $stmt->bindValue(':due_at', $scheduledAt, SQLITE3_INTEGER);
            leadBindText($stmt, ':metadata_json', leadJsonEncode($meta) ?: '{}');
            $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
            $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
            leadBindText($stmt, ':created_by_email', $actor);
            leadBindText($stmt, ':updated_by_email', $actor);
            $stmt->execute();
            leadInsertActivity($db, $leadId, $actor, [
                'activity_type' => 'calendar',
                'subject' => leadText('title', 'Scheduled follow-up'),
                'body_text' => leadText('body'),
                'related_id' => (string)($event['id'] ?? ''),
                'metadata' => $meta,
                'happened_at' => $scheduledAt > 0 ? $scheduledAt : $now,
            ], $now);
            leadEchoJson(['success' => true, 'event' => $event]);
            return true;
        }
        case 'lead_update_core_fields': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $displayName = leadText('display_name');
            $saved = leadSaveEntityRecord($db, (string)($row['lead_entity_id'] ?? ''), [
                'lead_name' => $displayName,
                'company' => $displayName,
                'email' => strtolower(leadText('email')),
                'phone' => leadText('phone'),
                'website' => leadText('website'),
                'address' => leadText('address'),
            ], $actor, $now);
            if (empty($saved['success'])) die(json_encode(['success' => false, 'error' => $saved['error'] ?? 'Could not save lead details']));
            leadSyncMembershipCacheFromEntity($db, (string)$saved['id'], $actor, $now);
            leadEchoJson(['success' => true, 'lead' => leadHydratedRow($db, $leadId, $actor, ['lead_row' => leadRowById($db, $leadId)])]);
            return true;
        }
        case 'lead_set_primary_contact': {
            $leadId = leadText('lead_id');
            $contactId = leadText('contact_id');
            $leadRow = leadRowById($db, $leadId);
            if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($leadRow);
            $contacts = leadContactRows($db, $leadId);
            $found = false;
            foreach ($contacts as $contact) {
                $meta = is_array($contact['metadata'] ?? null) ? $contact['metadata'] : [];
                $meta['is_primary'] = ((string)($contact['id'] ?? '') === $contactId);
                if ($meta['is_primary']) $found = true;
                leadSaveContactMetadata($db, (string)($contact['id'] ?? ''), $meta, $actor, $now);
            }
            if (!$found) die(json_encode(['success' => false, 'error' => 'Contact not found']));
            leadEchoJson(['success' => true, 'contacts' => leadContactRows($db, $leadId)]);
            return true;
        }
        case 'lead_save_stage': {
            $leadId = leadText('lead_id');
            $stage = leadText('stage', 'contacted');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $previous = leadNormalizeStageStatus($row['status'] ?? 'contacted', 'contacted');
            $next = leadNormalizeStageStatus($stage, $previous);
            if (!leadUpdateStage($db, $leadId, $next, $actor, $now)) die(json_encode(['success' => false, 'error' => 'Could not update stage']));
            $meta = leadMetadataArray($row);
            $sequence = leadSequenceTemplateForStage($next);
            $meta['crm']['active_sequence'] = $sequence ? [
                'sequence_key' => $sequence['sequence_key'],
                'sequence_label' => $sequence['sequence_label'],
                'status' => 'active',
                'next_step' => 'Waiting for next touch',
                'pause_reason' => '',
                'updated_at' => $now,
            ] : null;
            leadUpdateLeadMetadata($db, $leadId, $meta, $actor, $now);
            leadInsertActivity($db, $leadId, $actor, [
                'activity_type' => 'stage',
                'subject' => leadStageLabel($next),
                'body_text' => '',
                'metadata' => ['from' => leadStageLabel($previous), 'to' => leadStageLabel($next)],
                'happened_at' => $now,
            ], $now);
            leadEchoJson(['success' => true, 'stage' => $next]);
            return true;
        }
        case 'lead_save_milestone': {
            $leadId = leadText('lead_id');
            $key = preg_replace('/[^a-z0-9_]+/i', '_', leadText('key'));
            $value = !empty($_POST['value']);
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $meta = leadMetadataArray($row);
            if (!isset($meta['crm'])) $meta['crm'] = [];
            if (!isset($meta['crm']['milestones_custom']) || !is_array($meta['crm']['milestones_custom'])) $meta['crm']['milestones_custom'] = [];
            $meta['crm']['milestones_custom'][$key] = $value;
            leadUpdateLeadMetadata($db, $leadId, $meta, $actor, $now);
            leadInsertActivity($db, $leadId, $actor, [
                'activity_type' => 'milestone',
                'subject' => ucwords(str_replace('_', ' ', $key)),
                'body_text' => $value ? 'Marked complete' : 'Marked incomplete',
                'metadata' => ['key' => $key, 'value' => $value],
                'happened_at' => $now,
            ], $now);
            $fresh = leadHydratedRow($db, $leadId, $actor, ['lead_row' => leadRowById($db, $leadId)]);
            leadEchoJson(['success' => true, 'milestones' => $fresh['crm']['milestones']]);
            return true;
        }
        case 'lead_assign_org_credits': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $result = leadAddOrgCredits((string)($row['organization_id'] ?? ''), (int)leadText('amount'), $actor, leadText('note'));
            if (empty($result['ok'])) die(json_encode(['success' => false, 'error' => $result['error'] ?? 'Could not assign credits']));
            $fresh = leadHydratedRow($db, $leadId, $actor, ['lead_row' => leadRowById($db, $leadId)]);
            leadEchoJson([
                'success' => true,
                'organization_snapshot' => $fresh['organization_snapshot'],
                'milestones' => $fresh['crm']['milestones'],
            ]);
            return true;
        }
        case 'lead_save_email_branding': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $branding = leadJson('branding_json');
            if (!is_array($branding)) $branding = [];
            $meta = leadMetadataArray($row);
            if (!isset($meta['crm'])) $meta['crm'] = [];
            $meta['crm']['email_branding'] = $branding;
            leadUpdateLeadMetadata($db, $leadId, $meta, $actor, $now);
            leadEchoJson(['success' => true, 'branding' => $branding]);
            return true;
        }
        case 'lead_email_sample_bundle': {
            $leadId = leadText('lead_id');
            $folder = preg_replace('/[^a-f0-9]/', '', strtolower(leadText('folder')));
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            if ($folder === '') die(json_encode(['success' => false, 'error' => 'Missing folder']));
            if (!function_exists('fm_fetch_project_bundle')) die(json_encode(['success' => false, 'error' => 'Sample reports are unavailable']));
            $bundle = fm_fetch_project_bundle($folder);
            if (!is_array($bundle)) die(json_encode(['success' => false, 'error' => 'Sample report not found']));
            $template = null;
            foreach (leadSampleFavoriteConfigs() as $config) {
                if ((string)($config['id'] ?? '') === $folder) {
                    $template = $config;
                    break;
                }
            }
            leadEchoJson([
                'success' => true,
                'folder' => $folder,
                'template' => $template ?: ['id' => $folder, 'label' => $folder],
                'manifest' => $bundle['manifest'] ?? [],
                'organization' => is_array($bundle['organization'] ?? null) ? $bundle['organization'] : null,
                'pdf_state_asset' => function_exists('fm_project_doc_url') ? fm_project_doc_url($folder, 'pdf_state') : '',
            ]);
            return true;
        }
        case 'lead_send_sms': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            if (!function_exists('ringcentralSendSmsForLead')) die(json_encode(['success' => false, 'error' => 'RingCentral integration unavailable']));
            $sent = ringcentralSendSmsForLead($db, $row, $actor, leadText('phone'), leadText('body'), leadText('thread_id'), $now);
            if (empty($sent['ok']) && empty($sent['success'])) die(json_encode(['success' => false, 'error' => $sent['error'] ?? 'Could not send text']));
            leadEchoJson(['success' => true, 'contacts' => leadContactRows($db, $leadId)]);
            return true;
        }
        case 'lead_send_email': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            if (!function_exists('gmailSendMessageForActor')) die(json_encode(['success' => false, 'error' => 'Gmail integration unavailable']));
            $recipients = leadJson('recipient_contacts_json');
            $to = [];
            $contactEmailsToEnsure = [];
            foreach ((array)$recipients as $recipient) {
                $email = strtolower(trim((string)($recipient['email'] ?? '')));
                if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) continue;
                $to[] = $email;
                if (!empty($recipient['create_contact'])) {
                    $contactEmailsToEnsure[$email] = true;
                }
            }
            $to = array_values(array_unique($to));
            if (!$to) die(json_encode(['success' => false, 'error' => 'Choose at least one recipient']));
            $attachments = [];
            if (!empty($_FILES['email_attachment_files']) && is_array($_FILES['email_attachment_files']['tmp_name'] ?? null)) {
                $count = count($_FILES['email_attachment_files']['tmp_name']);
                for ($i = 0; $i < $count; $i++) {
                    $tmp = (string)($_FILES['email_attachment_files']['tmp_name'][$i] ?? '');
                    if ($tmp === '' || !is_file($tmp)) continue;
                    $attachments[] = [
                        'filename' => (string)($_FILES['email_attachment_files']['name'][$i] ?? ('attachment_' . ($i + 1))),
                        'mime_type' => (string)($_FILES['email_attachment_files']['type'][$i] ?? 'application/octet-stream'),
                        'content_base64' => base64_encode((string)file_get_contents($tmp)),
                    ];
                }
            }
            $payload = [
                'to' => implode(', ', $to),
                'bcc' => leadText('bcc'),
                'subject' => leadText('subject'),
                'body_text' => leadText('body'),
                'body_html' => leadText('body_html'),
                'signature_html' => leadText('signature_html'),
                'thread_id' => leadText('thread_id'),
                'in_reply_to' => leadText('in_reply_to'),
                'references' => leadText('references'),
                'attachments' => $attachments,
            ];
            if (function_exists('gmailAppendSignatureHtml')) {
                $payload['body_html'] = gmailAppendSignatureHtml($payload['body_html'] ?? '', $payload['signature_html'] ?? '');
            }
            if (function_exists('gmailAppendSignatureText')) {
                $payload['body_text'] = gmailAppendSignatureText($payload['body_text'] ?? '', $payload['signature_html'] ?? '');
            }
            $sent = gmailSendMessageForActor($actor, $payload);
            if (empty($sent['ok']) && empty($sent['success'])) die(json_encode(['success' => false, 'error' => $sent['error'] ?? 'Could not send email']));
            $sentData = is_array($sent['data'] ?? null) ? $sent['data'] : [];
            $sentMessageId = (string)($sent['id'] ?? ($sentData['id'] ?? ''));
            $sentThreadId = (string)($sent['threadId'] ?? ($sentData['threadId'] ?? leadText('thread_id')));
            $sentMessageHeaderId = (string)($sent['message_id_header'] ?? '');
            $sentInReplyTo = (string)($sent['in_reply_to'] ?? ($payload['in_reply_to'] ?? ''));
            $sentReferences = (string)($sent['references'] ?? ($payload['references'] ?? ''));
            foreach (array_keys($contactEmailsToEnsure) as $contactEmail) {
                $ensured = leadEnsureEmailOnlyContact($db, $leadId, $contactEmail, $actor, $now);
                if (empty($ensured['success'])) {
                    error_log('[lead_send_email] Email sent but contact creation failed for ' . $contactEmail . ' on lead ' . $leadId);
                }
            }
            leadInsertActivity($db, $leadId, $actor, [
                'activity_type' => 'email',
                'direction' => 'out',
                'subject' => leadText('subject'),
                'body_text' => leadText('body'),
                'related_id' => $sentMessageId,
                'metadata' => [
                    'direction' => 'out',
                    'to' => implode(', ', $to),
                    'to_emails' => $to,
                    'from_email' => $actor,
                    'transport' => 'gmail',
                    'template' => leadText('template'),
                    'gmail_thread_id' => $sentThreadId,
                    'gmail_message_id' => $sentMessageId,
                    'message_id_header' => $sentMessageHeaderId,
                    'in_reply_to' => $sentInReplyTo,
                    'references' => $sentReferences,
                ],
                'happened_at' => $now,
            ], $now);
            if (function_exists('gmailCacheSentMessageForLead')) {
                gmailCacheSentMessageForLead($db, $actor, $leadId, [
                    'gmail_message_id' => $sentMessageId,
                    'gmail_thread_id' => $sentThreadId,
                    'message_id_header' => $sentMessageHeaderId,
                    'subject' => leadText('subject'),
                    'body_text' => leadText('body'),
                    'from_email' => $actor,
                    'to' => implode(', ', $to),
                    'to_emails' => $to,
                    'cc' => '',
                    'cc_emails' => [],
                    'references' => $sentReferences,
                    'in_reply_to' => $sentInReplyTo,
                    'happened_at' => $now,
                ], $now);
            }
            $updatedLeadRow = leadRowById($db, $leadId) ?: $row;
            $stageAdvance = leadMaybeAutoAdvanceStage(
                $db,
                $updatedLeadRow,
                'info_sent',
                'System auto-transition after outbound Gmail send.',
                $now,
                [
                    'actor' => $actor,
                    'trigger' => 'gmail_outbound_send',
                    'template' => leadText('template'),
                    'related_activity_id' => $sentMessageId,
                ]
            );
            leadEchoJson([
                'success' => true,
                'contacts' => leadContactRows($db, $leadId),
                'stage' => $stageAdvance['stage'] ?? leadNormalizeStageStatus($updatedLeadRow['status'] ?? 'contacted', 'contacted'),
                'stage_changed' => !empty($stageAdvance['changed']),
            ]);
            return true;
        }
        case 'lead_dashboard': {
            return leadRunJsonGuard('lead_dashboard', function() use ($db, $actor) {
                $target = leadViewerTarget($actor);
                leadEchoJson(leadDashboardPayload($db, $actor, $target));
                return true;
            });
        }
        case 'lead_dashboard_task_save': {
            return leadRunJsonGuard('lead_dashboard_task_save', function() use ($db, $actor, $now) {
                $target = leadViewerTarget($actor);
                $title = trim((string)($_POST['title'] ?? ''));
                if ($title === '') die(json_encode(['success' => false, 'error' => 'Task title required']));
                $assignedTo = strtolower(trim((string)($_POST['assigned_to_email'] ?? '')));
                if ($assignedTo === '') $assignedTo = $actor;
                $dueRaw = trim((string)($_POST['due_at'] ?? ''));
                $dueAt = $dueRaw !== '' ? (strtotime($dueRaw) ?: 0) : 0;
                $stmt = $db->prepare("
                    INSERT INTO lead_dashboard_tasks (
                        id, owner_email, assigned_to_email, title, due_at, status, metadata_json, created_at, updated_at, created_by_email, updated_by_email
                    ) VALUES (
                        :id, :owner_email, :assigned_to_email, :title, :due_at, 'open', NULL, :created_at, :updated_at, :created_by_email, :updated_by_email
                    )
                ");
                leadBindText($stmt, ':id', leadId('task'));
                leadBindText($stmt, ':owner_email', $actor);
                leadBindText($stmt, ':assigned_to_email', $assignedTo);
                leadBindText($stmt, ':title', $title);
                $stmt->bindValue(':due_at', $dueAt, SQLITE3_INTEGER);
                $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
                $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
                leadBindText($stmt, ':created_by_email', $actor);
                leadBindText($stmt, ':updated_by_email', $actor);
                if (!$stmt->execute()) die(json_encode(['success' => false, 'error' => 'Could not save the task']));
                leadEchoJson(leadDashboardPayload($db, $actor, $target));
                return true;
            });
        }
        case 'lead_dashboard_task_toggle': {
            return leadRunJsonGuard('lead_dashboard_task_toggle', function() use ($db, $actor, $now) {
                $taskId = leadText('task_id');
                $status = strtolower(trim((string)($_POST['status'] ?? 'open'))) === 'done' ? 'done' : 'open';
                $stmt = $db->prepare('UPDATE lead_dashboard_tasks SET status = :status, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE id = :id');
                leadBindText($stmt, ':status', $status);
                $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
                leadBindText($stmt, ':updated_by_email', $actor);
                leadBindText($stmt, ':id', $taskId);
                $stmt->execute();
                leadEchoJson(leadDashboardPayload($db, $actor, leadViewerTarget($actor)));
                return true;
            });
        }
        case 'lead_dashboard_task_delete': {
            return leadRunJsonGuard('lead_dashboard_task_delete', function() use ($db, $actor) {
                $stmt = $db->prepare('DELETE FROM lead_dashboard_tasks WHERE id = :id');
                leadBindText($stmt, ':id', leadText('task_id'));
                $stmt->execute();
                leadEchoJson(leadDashboardPayload($db, $actor, leadViewerTarget($actor)));
                return true;
            });
        }
        case 'lead_pipeline_snapshot': {
            return leadRunJsonGuard('lead_pipeline_snapshot', function() use ($db, $actor) {
                leadEchoJson(leadPipelinePayload($db, $actor, leadViewerTarget($actor)));
                return true;
            });
        }
        case 'lead_sequences_snapshot': {
            return leadRunJsonGuard('lead_sequences_snapshot', function() use ($db, $actor) {
                leadEchoJson(leadSequencesPayload($db, $actor, leadViewerTarget($actor)));
                return true;
            });
        }
        case 'lead_sequence_action': {
            $leadId = leadText('lead_id');
            $row = leadRowById($db, $leadId);
            if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
            leadRequireLeadView($row);
            $meta = leadMetadataArray($row);
            $sequence = is_array($meta['crm']['active_sequence'] ?? null) ? $meta['crm']['active_sequence'] : (leadSequenceStateForLead($row) ?: []);
            $operation = strtolower(trim((string)($_POST['operation'] ?? '')));
            if ($operation === 'pause') {
                $sequence['status'] = 'paused';
                $sequence['pause_reason'] = 'Manually paused';
            } elseif ($operation === 'resume') {
                $sequence['status'] = 'active';
                $sequence['pause_reason'] = '';
            } elseif ($operation === 'stop') {
                $sequence['status'] = 'stopped';
                $sequence['pause_reason'] = 'Stopped manually';
            }
            $sequence['updated_at'] = $now;
            if (!isset($meta['crm'])) $meta['crm'] = [];
            $meta['crm']['active_sequence'] = $sequence;
            leadUpdateLeadMetadata($db, $leadId, $meta, $actor, $now);
            leadInsertActivity($db, $leadId, $actor, [
                'activity_type' => 'sequence',
                'subject' => (string)($sequence['sequence_label'] ?? 'Sequence'),
                'body_text' => ucfirst($operation),
                'metadata' => $sequence,
                'happened_at' => $now,
            ], $now);
            leadEchoJson(['success' => true, 'active_sequence' => $sequence]);
            return true;
        }
    }
    return false;
}

function leadMyLeadsQueryForTarget(SQLite3 $db, $actor, $target, $page, $perPage, $search, $sort, $dir, $followupScope = 'all') {
    $page = max(1, (int)$page);
    $perPage = max(1, min(200, (int)$perPage));
    $offset = ($page - 1) * $perPage;
    $search = trim((string)$search);
    $followupScope = strtolower(trim((string)$followupScope));
    if (!in_array($followupScope, ['all', 'due', 'open', 'none'], true)) $followupScope = 'all';

    $followupOwner = $target['mode'] === 'all' ? '' : (string)($target['email'] ?? $actor);
    if ($followupOwner === '' && !leadCanManageLists()) $followupOwner = $actor;

    $subOpen = $followupOwner !== ''
        ? "(SELECT COUNT(1) FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :followup_owner_sub AND fu.status = 'open')"
        : "(SELECT COUNT(1) FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.status = 'open')";
    $subNext = $followupOwner !== ''
        ? "(SELECT MIN(fu.due_at) FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :followup_owner_sub AND fu.status = 'open')"
        : "(SELECT MIN(fu.due_at) FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.status = 'open')";
    $subLatestCallback = "(SELECT MAX(de.dialed_at) FROM lead_dial_events de WHERE de.lead_id = l.id)";
    $subContactCount = "(SELECT COUNT(1) FROM lead_contacts lc WHERE lc.lead_id = l.id)";

    $where = ['1=1'];
    $binds = [];
    if ($followupOwner !== '') $binds[':followup_owner_sub'] = $followupOwner;

    if ($target['mode'] === 'mine') {
        $where[] = 'll.assigned_to_email = :assigned_to_email';
        $binds[':assigned_to_email'] = $actor;
    } elseif ($target['mode'] === 'user') {
        $where[] = 'll.assigned_to_email = :assigned_to_email';
        $binds[':assigned_to_email'] = (string)$target['email'];
    }

    if ($search !== '') {
        $where[] = "(l.company LIKE :q OR l.email LIKE :q OR l.phone LIKE :q OR l.address LIKE :q OR l.city LIKE :q OR l.state LIKE :q OR l.website LIKE :q OR ll.name LIKE :q OR ll.assigned_to_email LIKE :q)";
        $binds[':q'] = '%' . $search . '%';
    }

    if ($followupScope === 'due') {
        if ($followupOwner !== '') {
            $where[] = "EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :followup_owner_due AND fu.status = 'open' AND fu.due_at > 0 AND fu.due_at <= :now_due)";
            $binds[':followup_owner_due'] = $followupOwner;
        } else {
            $where[] = "EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.status = 'open' AND fu.due_at > 0 AND fu.due_at <= :now_due)";
        }
        $binds[':now_due'] = time();
    } elseif ($followupScope === 'open') {
        if ($followupOwner !== '') {
            $where[] = "EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :followup_owner_open AND fu.status = 'open')";
            $binds[':followup_owner_open'] = $followupOwner;
        } else {
            $where[] = "EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.status = 'open')";
        }
    } elseif ($followupScope === 'none') {
        if ($followupOwner !== '') {
            $where[] = "NOT EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.owner_email = :followup_owner_none AND fu.status = 'open')";
            $binds[':followup_owner_none'] = $followupOwner;
        } else {
            $where[] = "NOT EXISTS (SELECT 1 FROM lead_followups fu WHERE fu.lead_id = l.id AND fu.status = 'open')";
        }
    }

    $countSql = "
        SELECT COUNT(1) AS c
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where);
    $countStmt = $db->prepare($countSql);
    foreach ($binds as $key => $val) {
        if (is_int($val)) $countStmt->bindValue($key, $val, SQLITE3_INTEGER);
        else leadBindText($countStmt, $key, $val);
    }
    $countRes = $countStmt->execute();
    $total = (int)(($countRes ? $countRes->fetchArray(SQLITE3_ASSOC) : ['c' => 0])['c'] ?? 0);

    $sql = "
        SELECT
            l.*,
            ll.name AS list_name,
            ll.type AS list_type,
            ll.assigned_to_email AS list_assigned_to_email,
            ll.exported_at AS list_exported_at,
            ll.exported_by_email AS list_exported_by_email,
            $subContactCount AS contact_count,
            $subOpen AS open_followup_count,
            $subNext AS next_followup_at,
            $subLatestCallback AS latest_callback_at
        FROM leads l
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY " . leadSortSql($sort, $dir) . "
        LIMIT :limit OFFSET :offset
    ";
    $stmt = $db->prepare($sql);
    foreach ($binds as $key => $val) {
        if (is_int($val)) $stmt->bindValue($key, $val, SQLITE3_INTEGER);
        else leadBindText($stmt, $key, $val);
    }
    $stmt->bindValue(':limit', $perPage, SQLITE3_INTEGER);
    $stmt->bindValue(':offset', $offset, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
        $rows[] = $row;
    }

    return [
        'success' => true,
        'leads' => $rows,
        'page' => $page,
        'per_page' => $perPage,
        'total' => $total,
        'total_pages' => max(1, (int)ceil($total / $perPage)),
        'target' => $target
    ];
}

function leadGenerateFollowupLists(SQLite3 $db, $chunkSize, $actor) {
    $chunkSize = max(1, min(5000, (int)$chunkSize));
    $now = time();
    $stmt = $db->prepare("
        SELECT
            l.*,
            ll.name AS list_name,
            ll.type AS list_type,
            MIN(fu.due_at) AS next_due_at,
            COUNT(1) AS due_followup_count
        FROM lead_followups fu
        JOIN leads l ON l.id = fu.lead_id
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE fu.owner_email = :owner_email
          AND fu.status = 'open'
          AND fu.due_at > 0
          AND fu.due_at <= :now_due
          AND ll.assigned_to_email = :assigned_to_email
        GROUP BY fu.lead_id
        ORDER BY COALESCE(l.region_code, l.region) COLLATE NOCASE ASC, next_due_at ASC, l.company COLLATE NOCASE ASC
    ");
    leadBindText($stmt, ':owner_email', $actor);
    $stmt->bindValue(':now_due', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':assigned_to_email', $actor);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
    if (!$rows) {
        return ['success' => true, 'lists' => [], 'candidate_count' => 0];
    }

    $byRegion = [];
    foreach ($rows as $row) {
        $region = trim((string)($row['region_code'] ?: $row['region'] ?? '')) ?: 'UNASSIGNED';
        if (!isset($byRegion[$region])) $byRegion[$region] = [];
        $byRegion[$region][] = $row;
    }

    $created = [];
    $dayKey = date('Y-m-d');
    foreach ($byRegion as $region => $leads) {
        $chunks = array_chunk($leads, $chunkSize);
        foreach ($chunks as $idx => $chunk) {
            $sourceKey = 'followup:' . $dayKey . ':' . strtolower($actor) . ':' . strtolower($region) . ':' . ($idx + 1);
            $name = 'Follow-up List - ' . $region . ' - ' . date('M j') . ' #' . ($idx + 1);
            $payload = [
                'id' => leadId('list'),
                'name' => $name,
                'region' => $region,
                'region_code' => leadRegionCodeFromName($region),
                'type' => 'followup',
                'source_kind' => 'followup_due',
                'source_key' => $sourceKey,
                'description' => 'Generated from due lead follow-ups.',
                'status' => 'active',
                'assigned_to_email' => $actor,
                'assigned_by_email' => $actor,
                'sort_order' => $idx + 1,
                'metadata_json' => [
                    'generated_on' => $dayKey,
                    'owner_email' => $actor,
                    'region' => $region,
                    'chunk_size' => count($chunk)
                ]
            ];
            $saved = leadUpsertGeneratedList($db, $payload, $actor, $now);
            if (empty($saved['success'])) return $saved;
            $listId = $saved['id'];
            leadDeleteListLeads($db, $listId);
            foreach ($chunk as $row) {
                $metadata = leadDecodeJsonRowField($row, 'metadata_json');
                if (!is_array($metadata)) $metadata = [];
                $metadata['original_lead_id'] = $row['id'];
                $metadata['followup_due_at'] = (int)($row['next_due_at'] ?? 0);
                $metadata['due_followup_count'] = (int)($row['due_followup_count'] ?? 0);
                $normalized = leadNormalizeLeadPayload([
                    'external_key' => $row['external_key'] ?? '',
                    'region' => $row['region'] ?? '',
                    'region_code' => $row['region_code'] ?? '',
                    'status' => 'open',
                    'lead_name' => $row['lead_name'] ?? '',
                    'company' => $row['company'] ?? '',
                    'email' => $row['email'] ?? '',
                    'phone' => $row['phone'] ?? '',
                    'address' => $row['address'] ?? '',
                    'city' => $row['city'] ?? '',
                    'state' => $row['state'] ?? '',
                    'postal_code' => $row['postal_code'] ?? '',
                    'website' => $row['website'] ?? '',
                    'notes' => $row['notes'] ?? '',
                    'source' => 'followup_due_list',
                    'assigned_to_email' => $actor,
                    'metadata' => $metadata
                ], $row['region'] ?? '', $row['region_code'] ?? '', $actor, 'followup_due_list');
                leadInsertLead($db, $listId, $normalized, $actor, $now);
            }
            $count = leadSyncListLeadCount($db, $listId);
            $created[] = ['id' => $listId, 'name' => $name, 'lead_count' => $count];
        }
    }

    return ['success' => true, 'lists' => $created, 'candidate_count' => count($rows)];
}

function leadNormalizeLeadPayload($payload, $fallbackRegion, $fallbackRegionCode, $fallbackAssigned, $source) {
    $company = trim((string)($payload['company'] ?? $payload['name'] ?? ''));
    $phone = trim((string)($payload['phone'] ?? $payload['formatted_phone_number'] ?? ''));
    $website = trim((string)($payload['website'] ?? ''));
    $address = trim((string)($payload['address'] ?? $payload['formatted_address'] ?? ''));
    $state = strtoupper(trim((string)($payload['state'] ?? leadStateFromAddress($address, $fallbackRegionCode))));
    $city = trim((string)($payload['city'] ?? leadCityFromAddress($address)));
    $postal = trim((string)($payload['postal_code'] ?? ''));
    if ($postal === '' && preg_match('/\b(\d{5}(?:-\d{4})?)\b/', $address, $m)) $postal = $m[1];

    $metadata = is_array($payload['metadata'] ?? null) ? $payload['metadata'] : [];
    foreach (['place_id', 'rating', 'user_ratings_total', 'business_status', 'google_maps_url', 'types', 'weekday_text', 'lat', 'lng', 'detailed_at', 'filter'] as $key) {
        if (array_key_exists($key, $payload)) $metadata[$key] = $payload[$key];
    }

    return [
        'organization_id' => trim((string)($payload['organization_id'] ?? ($metadata['organization_id'] ?? ''))),
        'external_key' => trim((string)($payload['external_key'] ?? $payload['place_id'] ?? '')),
        'region' => trim((string)($payload['region'] ?? $fallbackRegion)),
        'region_code' => strtoupper(trim((string)($payload['region_code'] ?? ($state !== '' ? $state : $fallbackRegionCode)))),
        'status' => leadNormalizeStatus($payload['status'] ?? 'new', 'new'),
        'lead_name' => trim((string)($payload['lead_name'] ?? '')),
        'company' => $company,
        'email' => strtolower(trim((string)($payload['email'] ?? ''))),
        'phone' => $phone,
        'address' => $address,
        'city' => $city,
        'state' => $state,
        'postal_code' => $postal,
        'website' => $website,
        'notes' => trim((string)($payload['notes'] ?? '')),
        'source' => trim((string)($payload['source'] ?? $source)),
        'assigned_to_email' => strtolower(trim((string)($payload['assigned_to_email'] ?? $fallbackAssigned))),
        'metadata_json' => $metadata
    ];
}

function leadEntityRowById(SQLite3 $db, $entityId) {
    $entityId = trim((string)$entityId);
    if ($entityId === '') return false;
    $stmt = $db->prepare('SELECT * FROM lead_entities WHERE id = :id LIMIT 1');
    leadBindText($stmt, ':id', $entityId);
    $res = $stmt->execute();
    return $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
}

function leadEntityPayloadFromLeadData($leadData) {
    $leadData = is_array($leadData) ? $leadData : [];
    return [
        'organization_id' => trim((string)($leadData['organization_id'] ?? '')),
        'external_key' => trim((string)($leadData['external_key'] ?? '')),
        'region' => trim((string)($leadData['region'] ?? '')),
        'region_code' => strtoupper(trim((string)($leadData['region_code'] ?? ''))),
        'lead_name' => trim((string)($leadData['lead_name'] ?? '')),
        'company' => trim((string)($leadData['company'] ?? '')),
        'email' => strtolower(trim((string)($leadData['email'] ?? ''))),
        'phone' => trim((string)($leadData['phone'] ?? '')),
        'address' => trim((string)($leadData['address'] ?? '')),
        'city' => trim((string)($leadData['city'] ?? '')),
        'state' => strtoupper(trim((string)($leadData['state'] ?? ''))),
        'postal_code' => trim((string)($leadData['postal_code'] ?? '')),
        'website' => trim((string)($leadData['website'] ?? '')),
        'notes' => trim((string)($leadData['notes'] ?? '')),
        'source' => trim((string)($leadData['source'] ?? '')),
        'metadata_json' => is_array($leadData['metadata_json'] ?? null) ? $leadData['metadata_json'] : [],
    ];
}

function leadMergeEntityMetadata($existingJson, $incoming) {
    $existing = leadDecodeJsonRowField(['metadata_json' => $existingJson], 'metadata_json');
    if (!is_array($existing)) $existing = [];
    $incoming = is_array($incoming) ? $incoming : [];
    return array_replace_recursive($existing, $incoming);
}

function leadFindEntityIdForLeadData(SQLite3 $db, $leadData, $excludeEntityId = '') {
    $payload = leadEntityPayloadFromLeadData($leadData);
    $excludeEntityId = trim((string)$excludeEntityId);
    $checks = [];
    if ($payload['organization_id'] !== '') {
        $checks[] = ['sql' => 'SELECT id FROM lead_entities WHERE organization_id = :value AND id <> :exclude LIMIT 1', 'value' => $payload['organization_id']];
    }
    if ($payload['external_key'] !== '') {
        $checks[] = ['sql' => 'SELECT id FROM lead_entities WHERE external_key = :value AND id <> :exclude LIMIT 1', 'value' => $payload['external_key']];
    }
    if ($payload['email'] !== '' && $payload['company'] !== '') {
        $checks[] = [
            'sql' => 'SELECT id FROM lead_entities WHERE email = :email AND company = :company AND id <> :exclude LIMIT 1',
            'email' => $payload['email'],
            'company' => $payload['company'],
        ];
    }
    if ($payload['phone'] !== '' && $payload['company'] !== '') {
        $checks[] = [
            'sql' => 'SELECT id FROM lead_entities WHERE phone = :phone AND company = :company AND id <> :exclude LIMIT 1',
            'phone' => $payload['phone'],
            'company' => $payload['company'],
        ];
    }

    foreach ($checks as $check) {
        $stmt = $db->prepare($check['sql']);
        if (!$stmt) continue;
        foreach ($check as $key => $value) {
            if ($key === 'sql') continue;
            leadBindText($stmt, ':' . $key, (string)$value);
        }
        leadBindText($stmt, ':exclude', $excludeEntityId);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if ($row && trim((string)($row['id'] ?? '')) !== '') return (string)$row['id'];
    }
    return '';
}

function leadSaveEntityRecord(SQLite3 $db, $entityId, $leadData, $actor, $now) {
    $entityId = trim((string)$entityId);
    if ($entityId === '') $entityId = leadId('lead_entity');
    $preserveExisting = !empty($leadData['__preserve_existing_core']);
    $payload = leadEntityPayloadFromLeadData($leadData);
    $existing = leadEntityRowById($db, $entityId);
    if ($existing) {
        if ($preserveExisting) {
            $payload = [
                'organization_id' => $payload['organization_id'] !== '' ? $payload['organization_id'] : (string)($existing['organization_id'] ?? ''),
                'external_key' => $payload['external_key'] !== '' ? $payload['external_key'] : (string)($existing['external_key'] ?? ''),
                'region' => $payload['region'] !== '' ? $payload['region'] : (string)($existing['region'] ?? ''),
                'region_code' => $payload['region_code'] !== '' ? $payload['region_code'] : (string)($existing['region_code'] ?? ''),
                'lead_name' => $payload['lead_name'] !== '' ? $payload['lead_name'] : (string)($existing['lead_name'] ?? ''),
                'company' => $payload['company'] !== '' ? $payload['company'] : (string)($existing['company'] ?? ''),
                'email' => $payload['email'] !== '' ? $payload['email'] : (string)($existing['email'] ?? ''),
                'phone' => $payload['phone'] !== '' ? $payload['phone'] : (string)($existing['phone'] ?? ''),
                'address' => $payload['address'] !== '' ? $payload['address'] : (string)($existing['address'] ?? ''),
                'city' => $payload['city'] !== '' ? $payload['city'] : (string)($existing['city'] ?? ''),
                'state' => $payload['state'] !== '' ? $payload['state'] : (string)($existing['state'] ?? ''),
                'postal_code' => $payload['postal_code'] !== '' ? $payload['postal_code'] : (string)($existing['postal_code'] ?? ''),
                'website' => $payload['website'] !== '' ? $payload['website'] : (string)($existing['website'] ?? ''),
                'notes' => $payload['notes'] !== '' ? $payload['notes'] : (string)($existing['notes'] ?? ''),
                'source' => $payload['source'] !== '' ? $payload['source'] : (string)($existing['source'] ?? ''),
                'metadata_json' => leadMergeEntityMetadata($existing['metadata_json'] ?? null, $payload['metadata_json']),
            ];
        } else {
            $payload['metadata_json'] = leadMergeEntityMetadata($existing['metadata_json'] ?? null, $payload['metadata_json']);
        }
    }

    $metaJson = leadJsonEncode($payload['metadata_json']);
    if ($existing) {
        $stmt = $db->prepare("
            UPDATE lead_entities
            SET organization_id = :organization_id,
                external_key = :external_key,
                region = :region,
                region_code = :region_code,
                lead_name = :lead_name,
                company = :company,
                email = :email,
                phone = :phone,
                address = :address,
                city = :city,
                state = :state,
                postal_code = :postal_code,
                website = :website,
                notes = :notes,
                source = :source,
                metadata_json = :metadata_json,
                updated_at = :updated_at,
                updated_by_email = :updated_by_email
            WHERE id = :id
        ");
    } else {
        $stmt = $db->prepare("
            INSERT INTO lead_entities (
                id, organization_id, external_key, region, region_code, lead_name, company, email, phone, address,
                city, state, postal_code, website, notes, source, metadata_json,
                created_at, updated_at, created_by_email, updated_by_email
            ) VALUES (
                :id, :organization_id, :external_key, :region, :region_code, :lead_name, :company, :email, :phone, :address,
                :city, :state, :postal_code, :website, :notes, :source, :metadata_json,
                :created_at, :updated_at, :created_by_email, :updated_by_email
            )
        ");
        $stmt->bindValue(':created_at', (int)$now, SQLITE3_INTEGER);
        leadBindText($stmt, ':created_by_email', $actor);
    }

    leadBindText($stmt, ':id', $entityId);
    leadBindText($stmt, ':organization_id', $payload['organization_id']);
    leadBindText($stmt, ':external_key', $payload['external_key']);
    leadBindText($stmt, ':region', $payload['region']);
    leadBindText($stmt, ':region_code', $payload['region_code']);
    leadBindText($stmt, ':lead_name', $payload['lead_name']);
    leadBindText($stmt, ':company', $payload['company']);
    leadBindText($stmt, ':email', $payload['email']);
    leadBindText($stmt, ':phone', $payload['phone']);
    leadBindText($stmt, ':address', $payload['address']);
    leadBindText($stmt, ':city', $payload['city']);
    leadBindText($stmt, ':state', $payload['state']);
    leadBindText($stmt, ':postal_code', $payload['postal_code']);
    leadBindText($stmt, ':website', $payload['website']);
    leadBindText($stmt, ':notes', $payload['notes']);
    leadBindText($stmt, ':source', $payload['source']);
    if ($metaJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metaJson);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    if (!$stmt->execute()) return ['success' => false, 'error' => 'Could not save lead entity'];
    return ['success' => true, 'id' => $entityId, 'payload' => $payload];
}

function leadMembershipRowByListAndEntity(SQLite3 $db, $listId, $entityId) {
    $listId = trim((string)$listId);
    $entityId = trim((string)$entityId);
    if ($listId === '' || $entityId === '') return false;
    $stmt = $db->prepare('SELECT * FROM lead_memberships WHERE list_id = :list_id AND lead_entity_id = :lead_entity_id LIMIT 1');
    leadBindText($stmt, ':list_id', $listId);
    leadBindText($stmt, ':lead_entity_id', $entityId);
    $res = $stmt->execute();
    return $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
}

function leadSyncMembershipCacheFromEntity(SQLite3 $db, $entityId, $actor = '', $now = null) {
    $entity = leadEntityRowById($db, $entityId);
    if (!$entity) return false;
    if ($now === null) $now = (int)($entity['updated_at'] ?? time());
    if ($actor === '') $actor = (string)($entity['updated_by_email'] ?? '');
    $stmt = $db->prepare("
        UPDATE lead_memberships
        SET organization_id = :organization_id,
            external_key = :external_key,
            region = :region,
            region_code = :region_code,
            lead_name = :lead_name,
            company = :company,
            email = :email,
            phone = :phone,
            address = :address,
            city = :city,
            state = :state,
            postal_code = :postal_code,
            website = :website,
            notes = :notes,
            source = :source,
            metadata_json = :metadata_json,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE lead_entity_id = :lead_entity_id
    ");
    leadBindText($stmt, ':organization_id', (string)($entity['organization_id'] ?? ''));
    leadBindText($stmt, ':external_key', (string)($entity['external_key'] ?? ''));
    leadBindText($stmt, ':region', (string)($entity['region'] ?? ''));
    leadBindText($stmt, ':region_code', (string)($entity['region_code'] ?? ''));
    leadBindText($stmt, ':lead_name', (string)($entity['lead_name'] ?? ''));
    leadBindText($stmt, ':company', (string)($entity['company'] ?? ''));
    leadBindText($stmt, ':email', (string)($entity['email'] ?? ''));
    leadBindText($stmt, ':phone', (string)($entity['phone'] ?? ''));
    leadBindText($stmt, ':address', (string)($entity['address'] ?? ''));
    leadBindText($stmt, ':city', (string)($entity['city'] ?? ''));
    leadBindText($stmt, ':state', (string)($entity['state'] ?? ''));
    leadBindText($stmt, ':postal_code', (string)($entity['postal_code'] ?? ''));
    leadBindText($stmt, ':website', (string)($entity['website'] ?? ''));
    leadBindText($stmt, ':notes', (string)($entity['notes'] ?? ''));
    leadBindText($stmt, ':source', (string)($entity['source'] ?? ''));
    $metaJson = (string)($entity['metadata_json'] ?? '');
    if ($metaJson === '') $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metaJson);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':lead_entity_id', (string)$entityId);
    return (bool)$stmt->execute();
}

function leadDeleteOrphanEntity(SQLite3 $db, $entityId) {
    $entityId = trim((string)$entityId);
    if ($entityId === '') return;
    $stmt = $db->prepare('SELECT 1 FROM lead_memberships WHERE lead_entity_id = :lead_entity_id LIMIT 1');
    leadBindText($stmt, ':lead_entity_id', $entityId);
    $res = $stmt->execute();
    if ($res && $res->fetchArray(SQLITE3_ASSOC)) return;
    $del = $db->prepare('DELETE FROM lead_entities WHERE id = :id');
    leadBindText($del, ':id', $entityId);
    $del->execute();
}

function leadPruneOrphanEntities(SQLite3 $db) {
    $db->exec("
        DELETE FROM lead_entities
        WHERE id NOT IN (
            SELECT DISTINCT lead_entity_id
            FROM lead_memberships
            WHERE COALESCE(lead_entity_id, '') <> ''
        )
    ");
}

function leadSaveMembershipRecord(SQLite3 $db, $membershipId, $listId, $leadData, $actor, $now) {
    $membershipId = trim((string)$membershipId);
    $listId = trim((string)$listId);
    if ($listId === '') return ['success' => false, 'error' => 'Missing list_id'];

    $current = $membershipId !== '' ? leadRowById($db, $membershipId) : false;
    $currentEntityId = trim((string)($current['lead_entity_id'] ?? ''));
    $matchedEntityId = leadFindEntityIdForLeadData($db, $leadData, $currentEntityId);
    $entityId = $currentEntityId !== '' ? $currentEntityId : $matchedEntityId;
    $savedEntity = leadSaveEntityRecord($db, $entityId, $leadData, $actor, $now);
    if (empty($savedEntity['success'])) return $savedEntity;
    $entityId = (string)$savedEntity['id'];
    $payload = (array)($savedEntity['payload'] ?? []);
    $status = leadNormalizeStatus($leadData['status'] ?? ($current['status'] ?? 'new'), 'new');
    $assignedTo = strtolower(trim((string)($leadData['assigned_to_email'] ?? ($current['assigned_to_email'] ?? ''))));
    $existingInTarget = leadMembershipRowByListAndEntity($db, $listId, $entityId);
    if ($membershipId !== '' && $existingInTarget && (string)($existingInTarget['id'] ?? '') !== $membershipId) {
        return ['success' => false, 'error' => 'Lead already exists in that list'];
    }

    if ($membershipId === '' && $existingInTarget) {
        $membershipId = (string)($existingInTarget['id'] ?? '');
        $current = $existingInTarget;
    }

    $metaJson = leadJsonEncode($payload['metadata_json'] ?? []);
    if ($membershipId === '') {
        $membershipId = leadId('lead');
        $stmt = $db->prepare("
            INSERT INTO lead_memberships (
                id, list_id, lead_entity_id, organization_id, external_key, region, region_code, status, lead_name, company,
                email, phone, address, city, state, postal_code, website, notes, source, assigned_to_email, metadata_json,
                created_at, updated_at, created_by_email, updated_by_email
            ) VALUES (
                :id, :list_id, :lead_entity_id, :organization_id, :external_key, :region, :region_code, :status, :lead_name, :company,
                :email, :phone, :address, :city, :state, :postal_code, :website, :notes, :source, :assigned_to_email, :metadata_json,
                :created_at, :updated_at, :created_by_email, :updated_by_email
            )
        ");
        $stmt->bindValue(':created_at', (int)$now, SQLITE3_INTEGER);
        leadBindText($stmt, ':created_by_email', $actor);
    } else {
        $stmt = $db->prepare("
            UPDATE lead_memberships
            SET list_id = :list_id,
                lead_entity_id = :lead_entity_id,
                organization_id = :organization_id,
                external_key = :external_key,
                region = :region,
                region_code = :region_code,
                status = :status,
                lead_name = :lead_name,
                company = :company,
                email = :email,
                phone = :phone,
                address = :address,
                city = :city,
                state = :state,
                postal_code = :postal_code,
                website = :website,
                notes = :notes,
                source = :source,
                assigned_to_email = :assigned_to_email,
                metadata_json = :metadata_json,
                updated_at = :updated_at,
                updated_by_email = :updated_by_email
            WHERE id = :id
        ");
    }

    leadBindText($stmt, ':id', $membershipId);
    leadBindText($stmt, ':list_id', $listId);
    leadBindText($stmt, ':lead_entity_id', $entityId);
    leadBindText($stmt, ':organization_id', (string)($payload['organization_id'] ?? ''));
    leadBindText($stmt, ':external_key', (string)($payload['external_key'] ?? ''));
    leadBindText($stmt, ':region', (string)($payload['region'] ?? ''));
    leadBindText($stmt, ':region_code', (string)($payload['region_code'] ?? ''));
    leadBindText($stmt, ':status', $status);
    leadBindText($stmt, ':lead_name', (string)($payload['lead_name'] ?? ''));
    leadBindText($stmt, ':company', (string)($payload['company'] ?? ''));
    leadBindText($stmt, ':email', (string)($payload['email'] ?? ''));
    leadBindText($stmt, ':phone', (string)($payload['phone'] ?? ''));
    leadBindText($stmt, ':address', (string)($payload['address'] ?? ''));
    leadBindText($stmt, ':city', (string)($payload['city'] ?? ''));
    leadBindText($stmt, ':state', (string)($payload['state'] ?? ''));
    leadBindText($stmt, ':postal_code', (string)($payload['postal_code'] ?? ''));
    leadBindText($stmt, ':website', (string)($payload['website'] ?? ''));
    leadBindText($stmt, ':notes', (string)($payload['notes'] ?? ''));
    leadBindText($stmt, ':source', (string)($payload['source'] ?? ''));
    leadBindText($stmt, ':assigned_to_email', $assignedTo);
    if ($metaJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metaJson);
    $stmt->bindValue(':updated_at', (int)$now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    if (!$stmt->execute()) return ['success' => false, 'error' => 'Could not save lead membership'];

    leadSyncMembershipCacheFromEntity($db, $entityId, $actor, $now);
    if ($currentEntityId !== '' && $currentEntityId !== $entityId) {
        leadDeleteOrphanEntity($db, $currentEntityId);
    }
    return ['success' => true, 'id' => $membershipId, 'lead_entity_id' => $entityId];
}

function leadInsertLead(SQLite3 $db, $listId, $leadData, $actor, $now) {
    $leadData['__preserve_existing_core'] = true;
    $saved = leadSaveMembershipRecord($db, '', $listId, $leadData, $actor, $now);
    return !empty($saved['success']);
}

function leadLinkOrganization(SQLite3 $db, $leadId, $orgId, $actor, $salesEmail = '') {
    $leadId = trim((string)$leadId);
    $orgId = function_exists('orgNormalizeId') ? orgNormalizeId($orgId) : trim((string)$orgId);
    if ($leadId === '' || $orgId === '') return false;
    $lead = leadRowById($db, $leadId);
    if (!$lead) return false;
    $entityId = trim((string)($lead['lead_entity_id'] ?? ''));
    if ($entityId === '') return false;
    $entity = leadEntityRowById($db, $entityId);
    if (!$entity) return false;
    $metadata = leadDecodeJsonRowField($entity, 'metadata_json');
    if (!is_array($metadata)) $metadata = [];
    $metadata['organization_id'] = $orgId;
    if (function_exists('orgRead')) {
        $org = orgRead($orgId);
        if (is_array($org)) $metadata['organization_name'] = (string)($org['name'] ?? '');
    }
    $stmt = $db->prepare("
        UPDATE lead_entities
        SET organization_id = :organization_id,
            metadata_json = :metadata_json,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    leadBindText($stmt, ':organization_id', $orgId);
    leadBindText($stmt, ':metadata_json', json_encode($metadata));
    $stmt->bindValue(':updated_at', time(), SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $entityId);
    $ok = (bool)$stmt->execute();
    if ($ok) {
        leadSyncMembershipCacheFromEntity($db, $entityId, $actor, time());
        if (($salesEmail = strtolower(trim((string)$salesEmail))) !== '') {
            $up = $db->prepare('UPDATE lead_memberships SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE lead_entity_id = :lead_entity_id');
            leadBindText($up, ':assigned_to_email', $salesEmail);
            $up->bindValue(':updated_at', time(), SQLITE3_INTEGER);
            leadBindText($up, ':updated_by_email', $actor);
            leadBindText($up, ':lead_entity_id', $entityId);
            $up->execute();
        }
    }
    return $ok;
}

function leadUpsertGeneratedList(SQLite3 $db, $payload, $actor, $now) {
    $existing = null;
    if (($payload['source_kind'] ?? '') !== '' && ($payload['source_key'] ?? '') !== '') {
        $stmt = $db->prepare('SELECT * FROM lead_lists WHERE source_kind = :source_kind AND source_key = :source_key LIMIT 1');
        leadBindText($stmt, ':source_kind', $payload['source_kind']);
        leadBindText($stmt, ':source_key', $payload['source_key']);
        $res = $stmt->execute();
        $existing = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    }

    if ($existing) {
        $stmt = $db->prepare("
            UPDATE lead_lists
            SET
                name = :name,
                region = :region,
                region_code = :region_code,
                type = :type,
                description = :description,
                status = :status,
                assigned_to_email = :assigned_to_email,
                assigned_by_email = :assigned_by_email,
                sort_order = :sort_order,
                metadata_json = :metadata_json,
                updated_at = :updated_at,
                updated_by_email = :updated_by_email
            WHERE id = :id
        ");
        leadBindText($stmt, ':id', $existing['id']);
    } else {
        $stmt = $db->prepare("
            INSERT INTO lead_lists (
                id, name, region, region_code, type, source_kind, source_key, description, status,
                assigned_to_email, assigned_by_email, exported_at, exported_by_email, exported_count,
                lead_count, sort_order, metadata_json, created_at, updated_at, created_by_email, updated_by_email
            ) VALUES (
                :id, :name, :region, :region_code, :type, :source_kind, :source_key, :description, :status,
                :assigned_to_email, :assigned_by_email, NULL, '', 0, 0, :sort_order, :metadata_json,
                :created_at, :updated_at, :created_by_email, :updated_by_email
            )
        ");
        leadBindText($stmt, ':id', $payload['id']);
        leadBindText($stmt, ':source_kind', $payload['source_kind'] ?? '');
        leadBindText($stmt, ':source_key', $payload['source_key'] ?? '');
        $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':created_by_email', $actor);
    }

    leadBindText($stmt, ':name', $payload['name']);
    leadBindText($stmt, ':region', $payload['region'] ?? '');
    leadBindText($stmt, ':region_code', $payload['region_code'] ?? '');
    leadBindText($stmt, ':type', $payload['type'] ?? 'manual');
    leadBindText($stmt, ':description', $payload['description'] ?? '');
    leadBindText($stmt, ':status', $payload['status'] ?? 'active');
    leadBindText($stmt, ':assigned_to_email', $payload['assigned_to_email'] ?? '');
    leadBindText($stmt, ':assigned_by_email', $payload['assigned_by_email'] ?? '');
    $stmt->bindValue(':sort_order', (int)($payload['sort_order'] ?? 0), SQLITE3_INTEGER);
    $metaJson = json_encode($payload['metadata_json'] ?? null);
    if ($metaJson === 'null') $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metaJson);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);

    $ok = $stmt->execute();
    if (!$ok) return ['success' => false, 'error' => 'Could not save list'];
    return ['success' => true, 'id' => $existing ? $existing['id'] : $payload['id'], 'was_existing' => (bool)$existing];
}

function leadDeleteListLeads(SQLite3 $db, $listId) {
    $stmt = $db->prepare('DELETE FROM lead_memberships WHERE list_id = :list_id');
    leadBindText($stmt, ':list_id', $listId);
    $stmt->execute();
    leadPruneOrphanEntities($db);
}

function leadImportLegacyList(SQLite3 $db, $listName, $chunkSize, $actor, $assignmentEmails = []) {
    $path = leadLegacyFilterFile($listName);
    if (!file_exists($path)) return ['success' => false, 'error' => 'Legacy list not found'];
    $data = json_decode((string)@file_get_contents($path), true);
    if (!is_array($data)) return ['success' => false, 'error' => 'Bad legacy list JSON'];

    $region = trim((string)($data['filter']['state'] ?? $data['list_name'] ?? ''));
    if ($region === '') $region = (string)($data['list_name'] ?? 'Legacy Territory');
    $regionCode = leadRegionCodeFromName($region);
    $placeIds = array_values(array_filter(array_map('strval', $data['place_ids'] ?? [])));
    $chunks = $chunkSize > 0 ? array_chunk($placeIds, $chunkSize) : [$placeIds];
    $now = time();
    $created = [];

    foreach ($chunks as $idx => $chunk) {
        if (!$chunk) continue;
        $chunkNo = $idx + 1;
        $assignedTo = $assignmentEmails ? $assignmentEmails[$idx % count($assignmentEmails)] : '';
        $listNameChunk = count($chunks) > 1 ? ($listName . ' - ' . $regionCode . ' #' . $chunkNo) : ($listName . ' - ' . $regionCode);
        $sourceKey = leadLegacySafeName($listName) . ':' . $chunkNo . ':' . md5(json_encode($chunk));
        $payload = [
            'id' => leadId('list'),
            'name' => $listNameChunk,
            'region' => $region,
            'region_code' => $regionCode,
            'type' => 'territory',
            'source_kind' => 'legacy_filter_chunk',
            'source_key' => $sourceKey,
            'description' => 'Imported from legacy territory filter list.',
            'status' => 'active',
            'assigned_to_email' => $assignedTo,
            'assigned_by_email' => $assignedTo !== '' ? $actor : '',
            'sort_order' => $chunkNo,
            'metadata_json' => [
                'legacy_list_name' => $listName,
                'legacy_filter' => $data['filter'] ?? [],
                'legacy_count' => count($chunk),
                'chunk_index' => $chunkNo,
                'chunk_size' => count($chunk)
            ]
        ];

        $saved = leadUpsertGeneratedList($db, $payload, $actor, $now);
        if (empty($saved['success'])) return $saved;
        $listId = $saved['id'];
        leadDeleteListLeads($db, $listId);

        $inserted = 0;
        foreach ($chunk as $placeId) {
            $detailPath = leadLegacyDetailsDir() . leadLegacySafeName($placeId) . '.json';
            $detail = file_exists($detailPath) ? json_decode((string)@file_get_contents($detailPath), true) : [];
            if (!is_array($detail)) $detail = [];
            $leadData = leadNormalizeLeadPayload(
                array_merge($detail, [
                    'external_key' => $placeId,
                    'source' => 'legacy_territory_import',
                    'region' => $region,
                    'region_code' => $regionCode,
                    'assigned_to_email' => $assignedTo,
                    'metadata' => ['legacy_list_name' => $listName]
                ]),
                $region,
                $regionCode,
                $assignedTo,
                'legacy_territory_import'
            );
            if (leadInsertLead($db, $listId, $leadData, $actor, $now)) $inserted++;
        }

        leadSyncListLeadCount($db, $listId);
        $created[] = ['id' => $listId, 'name' => $listNameChunk, 'lead_count' => $inserted];
    }

    return ['success' => true, 'lists' => $created];
}

function leadCreateTerritoryLists(SQLite3 $db, $territoryName, $placeIds, $chunkSize, $actor, $filterMeta = [], $builderConfig = []) {
    $placeIds = array_values(array_unique(array_filter(array_map('strval', $placeIds))));
    if (!$placeIds) return ['success' => false, 'error' => 'No territory businesses were selected'];

    $rawById = leadLegacyRawBusinessesByPlaceIds($placeIds);
    $byRegion = [];
    $detailedCount = 0;
    $missingCount = 0;

    foreach ($placeIds as $placeId) {
        $raw = is_array($rawById[$placeId] ?? null) ? $rawById[$placeId] : [];
        $detail = leadLegacyDetailByPlaceId($placeId);
        if ($detail) $detailedCount++;
        if (!$raw && !$detail) {
            $missingCount++;
            continue;
        }

        $address = trim((string)($detail['formatted_address'] ?? $raw['vicinity'] ?? ''));
        $parsed = leadLegacyParseStateZip($address);
        $regionCode = strtoupper(trim((string)($parsed['state'] ?? '')));
        if ($regionCode === '') {
            $regionCode = strtoupper(trim((string)($builderConfig['region_code'] ?? '')));
        }
        if ($regionCode === '') $regionCode = 'UNASSIGNED';

        $payload = [
            'external_key' => $placeId,
            'company' => trim((string)($detail['name'] ?? $raw['name'] ?? '')),
            'phone' => trim((string)($detail['formatted_phone_number'] ?? '')),
            'website' => trim((string)($detail['website'] ?? '')),
            'address' => $address,
            'city' => trim((string)leadCityFromAddress($address)),
            'state' => $regionCode !== 'UNASSIGNED' ? $regionCode : '',
            'postal_code' => trim((string)($parsed['zip'] ?? '')),
            'rating' => $detail['rating'] ?? $raw['rating'] ?? null,
            'user_ratings_total' => $detail['user_ratings_total'] ?? $raw['user_ratings_total'] ?? null,
            'business_status' => trim((string)($detail['business_status'] ?? $raw['business_status'] ?? '')),
            'types' => is_array($detail['types'] ?? null) ? $detail['types'] : (is_array($raw['types'] ?? null) ? $raw['types'] : []),
            'lat' => $detail['lat'] ?? $raw['lat'] ?? null,
            'lng' => $detail['lng'] ?? $raw['lng'] ?? null,
            'google_maps_url' => trim((string)($detail['google_maps_url'] ?? '')),
            'source' => 'territory_builder',
            'region' => $regionCode,
            'region_code' => $regionCode,
            'metadata' => [
                'detail_available' => $detail ? true : false,
                'legacy_tile_key' => $raw['_tile'] ?? '',
                'vicinity' => $raw['vicinity'] ?? '',
                'search_types' => $raw['types'] ?? [],
                'territory_filter' => $filterMeta,
                'territory_builder' => $builderConfig
            ]
        ];

        if (!isset($byRegion[$regionCode])) $byRegion[$regionCode] = [];
        $byRegion[$regionCode][] = $payload;
    }

    if (!$byRegion) {
        return ['success' => false, 'error' => 'None of the selected territory businesses could be loaded from the territory cache'];
    }

    $created = [];
    $now = time();
    $runKey = date('Ymd_His') . '_' . substr(md5($territoryName . '|' . implode(',', $placeIds)), 0, 8);

    ksort($byRegion);
    foreach ($byRegion as $regionCode => $leads) {
        usort($leads, function($a, $b) {
            return strcmp((string)($a['company'] ?? ''), (string)($b['company'] ?? ''));
        });
        $chunks = $chunkSize > 0 ? array_chunk($leads, $chunkSize) : [$leads];
        foreach ($chunks as $idx => $chunk) {
            if (!$chunk) continue;
            $chunkNo = $idx + 1;
            $name = count($chunks) > 1
                ? ($territoryName . ' - ' . $regionCode . ' #' . $chunkNo)
                : ($territoryName . ' - ' . $regionCode);
            $payload = [
                'id' => leadId('list'),
                'name' => $name,
                'region' => $regionCode,
                'region_code' => $regionCode,
                'type' => 'territory',
                'source_kind' => 'territory_builder_run',
                'source_key' => $runKey . ':' . strtolower($regionCode) . ':' . $chunkNo,
                'description' => 'Created from the in-app territory builder.',
                'status' => 'active',
                'assigned_to_email' => '',
                'assigned_by_email' => '',
                'sort_order' => $chunkNo,
                'metadata_json' => [
                    'territory_name' => $territoryName,
                    'territory_filter' => $filterMeta,
                    'territory_builder' => $builderConfig,
                    'place_count' => count($chunk),
                    'detailed_available_count' => count(array_filter($chunk, function($row) {
                        return !empty($row['metadata']['detail_available']);
                    })),
                    'created_from_run' => $runKey
                ]
            ];
            $saved = leadUpsertGeneratedList($db, $payload, $actor, $now);
            if (empty($saved['success'])) return $saved;
            $listId = $saved['id'];
            leadDeleteListLeads($db, $listId);

            foreach ($chunk as $lead) {
                $normalized = leadNormalizeLeadPayload($lead, $regionCode, $regionCode, '', 'territory_builder');
                leadInsertLead($db, $listId, $normalized, $actor, $now);
            }
            $count = leadSyncListLeadCount($db, $listId);
            $created[] = ['id' => $listId, 'name' => $name, 'lead_count' => $count];
        }
    }

    return [
        'success' => true,
        'lists' => $created,
        'selected_count' => count($placeIds),
        'missing_count' => $missingCount,
        'detailed_count' => $detailedCount
    ];
}

function leadBuildDailyCallCandidates() {
    $candidates = [];
    if (!function_exists('orgCustomerDataSnapshot')) return [];

    $now = time();
    $orgs = orgCustomerDataSnapshot(leadActorEmail());
    foreach ($orgs as $org) {
        if (!is_array($org)) continue;
        if (!empty($org['is_test'])) continue;

        $orgId = trim((string)($org['id'] ?? ''));
        if ($orgId === '') continue;
        $createdAt = strtotime((string)($org['created_at'] ?? ''));
        if (!$createdAt) continue;

        $ageDays = floor(($now - $createdAt) / 86400);
        $orders = (int)($org['lifetimeOrders'] ?? 0);
        $lastOrderTs = 0;
        foreach (($org['orders'] ?? []) as $order) {
            $ts = strtotime((string)($order['created_at'] ?? ''));
            if ($ts > $lastOrderTs) $lastOrderTs = $ts;
        }
        $reason = '';
        if ($orders === 0 && $ageDays >= 2) {
            $reason = 'No order after 2+ days';
        } elseif ($orders > 0 && $orders <= 3 && $lastOrderTs > 0 && (($now - $lastOrderTs) / 86400) >= 3) {
            $reason = 'Initial order only, inactive for 3+ days';
        } else {
            continue;
        }

        $company = trim((string)($org['name'] ?? ''));
        $phone = trim((string)($org['contact']['phone'] ?? ''));
        if ($phone === '' && !empty($org['users'][0]['phone'])) $phone = trim((string)$org['users'][0]['phone']);
        $addr = trim((string)($org['contact']['address'] ?? ''));
        $regionCode = leadStateFromAddress($addr);

        $region = $regionCode !== '' ? $regionCode : 'UNASSIGNED';
        $salesOwner = strtolower(trim((string)($org['assigned_sales_email'] ?? '')));
        $contactEmail = strtolower(trim((string)($org['contact']['email'] ?? '')));
        if ($contactEmail === '' && !empty($org['users'][0]['email'])) $contactEmail = strtolower(trim((string)$org['users'][0]['email']));
        $candidates[] = [
            'organization_id' => $orgId,
            'external_key' => 'customer_org:' . $orgId,
            'company' => $company !== '' ? $company : $orgId,
            'lead_name' => '',
            'email' => $contactEmail,
            'phone' => $phone,
            'address' => $addr,
            'region' => $region,
            'region_code' => $regionCode,
            'status' => 'open',
            'source' => 'daily_customer_call_list',
            'notes' => $reason,
            'assigned_to_email' => $salesOwner,
            'metadata' => [
                'customer_created_at' => $org['created_at'] ?? null,
                'organization_id' => $orgId,
                'project_count' => $orders,
                'last_completed_order_at' => $lastOrderTs > 0 ? date('c', $lastOrderTs) : null,
                'reason' => $reason,
                'sales_owner_email' => $salesOwner !== '' ? $salesOwner : null
            ]
        ];
    }

    usort($candidates, function($a, $b) {
        return strcmp((string)$a['company'], (string)$b['company']);
    });
    return $candidates;
}

function leadGenerateDailyLists(SQLite3 $db, $chunkSize, $actor, $assignmentEmails = [], $selfOnly = false) {
    $candidates = leadBuildDailyCallCandidates();
    if ($selfOnly) {
        $candidates = array_values(array_filter($candidates, function($lead) use ($actor) {
            return strtolower(trim((string)($lead['assigned_to_email'] ?? ''))) === $actor;
        }));
    }
    if (!$candidates) return ['success' => true, 'lists' => [], 'candidate_count' => 0];

    $byBucket = [];
    foreach ($candidates as $lead) {
        $region = trim((string)($lead['region'] ?? '')) ?: 'UNASSIGNED';
        $owner = strtolower(trim((string)($lead['assigned_to_email'] ?? '')));
        $bucket = ($owner !== '' ? $owner : '__unassigned__') . '|' . $region;
        if (!isset($byBucket[$bucket])) $byBucket[$bucket] = ['region' => $region, 'owner' => $owner, 'leads' => []];
        $byBucket[$bucket]['leads'][] = $lead;
    }

    $created = [];
    $now = time();
    $assignmentIndex = 0;
    foreach ($byBucket as $bucket) {
        $region = $bucket['region'];
        $leads = $bucket['leads'];
        $regionCode = leadRegionCodeFromName($region);
        $chunks = $chunkSize > 0 ? array_chunk($leads, $chunkSize) : [$leads];
        foreach ($chunks as $idx => $chunk) {
            if (!$chunk) continue;
            $assignedTo = strtolower(trim((string)($bucket['owner'] ?? '')));
            if (!$selfOnly && $assignedTo === '' && $assignmentEmails) {
                $assignedTo = $assignmentEmails[$assignmentIndex % count($assignmentEmails)];
                $assignmentIndex++;
            }
            if ($selfOnly && $assignedTo !== $actor) continue;
            $dayKey = date('Y-m-d');
            $sourceKey = 'daily:' . $dayKey . ':' . strtolower($region) . ':' . ($assignedTo !== '' ? $assignedTo : 'unassigned') . ':' . ($idx + 1);
            $name = 'Daily Call List - ' . $region . ' - ' . date('M j') . ' #' . ($idx + 1);
            if ($assignedTo === '') $name .= ' (Unassigned)';
            $payload = [
                'id' => leadId('list'),
                'name' => $name,
                'region' => $region,
                'region_code' => $regionCode,
                'type' => 'daily',
                'source_kind' => 'daily_customer_call',
                'source_key' => $sourceKey,
                'description' => 'Generated from customer accounts needing sales follow-up.',
                'status' => 'active',
                'assigned_to_email' => $assignedTo,
                'assigned_by_email' => $assignedTo !== '' ? $actor : '',
                'sort_order' => $idx + 1,
                'metadata_json' => [
                    'generated_on' => $dayKey,
                    'region' => $region,
                    'chunk_index' => $idx + 1,
                    'chunk_size' => count($chunk),
                    'auto_assigned_sales_owner' => $assignedTo !== '' ? $assignedTo : null
                ]
            ];
            $saved = leadUpsertGeneratedList($db, $payload, $actor, $now);
            if (empty($saved['success'])) return $saved;
            $listId = $saved['id'];
            leadDeleteListLeads($db, $listId);
            foreach ($chunk as $lead) {
                $normalized = leadNormalizeLeadPayload($lead, $region, $regionCode, $assignedTo, 'daily_customer_call_list');
                leadInsertLead($db, $listId, $normalized, $actor, $now);
            }
            $count = leadSyncListLeadCount($db, $listId);
            $created[] = ['id' => $listId, 'name' => $name, 'lead_count' => $count];
        }
    }

    return ['success' => true, 'lists' => $created, 'candidate_count' => count($candidates)];
}

function leadSalesUsers() {
    $rows = [];
    $userDir = storageDir('users');
    if (!is_dir($userDir)) return [];
    foreach (glob($userDir . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) === 'customer') continue;
        if (!empty($u['deleted']) || !empty($u['disabled'])) continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        if ($email === '') continue;
        $department = strtolower(trim((string)($u['department'] ?? 'production')));
        $role = strtolower(trim((string)($u['role'] ?? 'user')));
        $perms = is_array($u['permissions'] ?? null) ? $u['permissions'] : [];
        if ($department !== 'sales' && empty($perms['manage_sales_users']) && !in_array($role, ['sales_manager', 'salesperson'], true)) {
            continue;
        }
        $rows[] = [
            'email' => $email,
            'name' => (string)($u['name'] ?? $email),
            'department' => $department,
            'role' => $role
        ];
    }
    usort($rows, function($a, $b) {
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    return $rows;
}

function leadResolveCustomerSalesOwner($userData, $orgData = null) {
    $candidates = [
        strtolower(trim((string)($userData['sales_owner_email'] ?? ''))),
        strtolower(trim((string)($userData['sales_rep_email'] ?? ''))),
        strtolower(trim((string)($userData['account_manager_email'] ?? ''))),
        strtolower(trim((string)($orgData['sales_owner_email'] ?? ''))),
        strtolower(trim((string)($orgData['sales_rep_email'] ?? ''))),
        strtolower(trim((string)($orgData['account_manager_email'] ?? ''))),
    ];
    foreach ($candidates as $email) {
        if ($email !== '') return $email;
    }
    return '';
}

function leadBuildCsvExport(SQLite3 $db, $listId, $actor, $now) {
    $listRow = leadListRowById($db, $listId);
    if (!$listRow) return ['success' => false, 'error' => 'List not found'];
    if (!leadListCanExport($listRow)) {
        return ['success' => false, 'error' => 'Only the assigned salesperson can export this list'];
    }

    $stmt = $db->prepare('SELECT * FROM leads WHERE list_id = :list_id ORDER BY company COLLATE NOCASE ASC, lead_name COLLATE NOCASE ASC');
    leadBindText($stmt, ':list_id', $listId);
    $res = $stmt->execute();
    $rows = [];
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) $rows[] = $row;

    $csv = leadBuildCsvLinesFromRows($rows);

    $exportId = leadId('export');
    $expStmt = $db->prepare("
        INSERT INTO lead_exports (id, list_id, exported_by_email, exported_at, row_count, metadata_json)
        VALUES (:id, :list_id, :exported_by_email, :exported_at, :row_count, :metadata_json)
    ");
    leadBindText($expStmt, ':id', $exportId);
    leadBindText($expStmt, ':list_id', $listId);
    leadBindText($expStmt, ':exported_by_email', $actor);
    $expStmt->bindValue(':exported_at', $now, SQLITE3_INTEGER);
    $expStmt->bindValue(':row_count', count($rows), SQLITE3_INTEGER);
    leadBindText($expStmt, ':metadata_json', json_encode(['type' => 'orum_csv']));
    $expStmt->execute();

    $up = $db->prepare("
        UPDATE lead_lists
        SET exported_at = :exported_at, exported_by_email = :exported_by_email, exported_count = exported_count + 1, updated_at = :updated_at
        WHERE id = :id
    ");
    $up->bindValue(':exported_at', $now, SQLITE3_INTEGER);
    leadBindText($up, ':exported_by_email', $actor);
    $up->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($up, ':id', $listId);
    $up->execute();

    return [
        'success' => true,
        'filename' => leadLegacySafeName(($listRow['name'] ?? 'lead-list')) . '.csv',
        'csv' => $csv,
        'row_count' => count($rows),
        'exported_at' => $now,
        'exported_by_email' => $actor
    ];
}

function leadExportRowsByIds(SQLite3 $db, array $leadIds) {
    $rows = [];
    foreach ($leadIds as $leadId) {
        $row = leadRowById($db, $leadId);
        if (!$row || !leadCanViewLeadRow($row)) continue;
        $rows[] = $row;
    }
    usort($rows, function($a, $b) {
        return strcmp((string)($a['company'] ?? ''), (string)($b['company'] ?? ''));
    });
    return $rows;
}

function leadExportDueRowsForTarget(SQLite3 $db, $actor, $target) {
    $ownerEmail = $target['mode'] === 'all' ? '' : ($target['email'] ?? $actor);
    if ($ownerEmail === '' && !leadCanManageLists()) $ownerEmail = $actor;
    $where = ['fu.status = \'open\'', 'fu.due_at > 0', 'fu.due_at <= :now_due'];
    if ($ownerEmail !== '') $where[] = 'fu.owner_email = :owner_email';
    if ($target['mode'] === 'mine') $where[] = 'll.assigned_to_email = :assigned_to_email';
    elseif ($target['mode'] === 'user') $where[] = 'll.assigned_to_email = :assigned_to_email';

    $stmt = $db->prepare("
        SELECT DISTINCT
            l.*,
            ll.name AS list_name,
            ll.type AS list_type,
            ll.assigned_to_email AS list_assigned_to_email
        FROM lead_followups fu
        JOIN leads l ON l.id = fu.lead_id
        JOIN lead_lists ll ON ll.id = l.list_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY l.company COLLATE NOCASE ASC
    ");
    $stmt->bindValue(':now_due', time(), SQLITE3_INTEGER);
    if ($ownerEmail !== '') leadBindText($stmt, ':owner_email', $ownerEmail);
    if ($target['mode'] === 'mine') leadBindText($stmt, ':assigned_to_email', $actor);
    elseif ($target['mode'] === 'user') leadBindText($stmt, ':assigned_to_email', (string)$target['email']);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        if (!leadCanViewLeadRow($row)) continue;
        $rows[] = $row;
    }
    return $rows;
}

function leadBuildLeadSelectionCsv(SQLite3 $db, $actor, array $leadIds, $target, $mode = 'selected') {
    $rows = $mode === 'due'
        ? leadExportDueRowsForTarget($db, $actor, $target)
        : leadExportRowsByIds($db, $leadIds);
    if (!$rows) return ['success' => false, 'error' => 'No leads matched this export'];
    $csv = leadBuildCsvLinesFromRows($rows);
    $suffix = $mode === 'due' ? 'due-followups' : 'selected-leads';
    return [
        'success' => true,
        'csv' => $csv,
        'filename' => 'orum-' . $suffix . '-' . date('Ymd_His') . '.csv',
        'row_count' => count($rows)
    ];
}

function handleLeadActions($action) {
    $leadActions = [
        'lead_list_list',
        'lead_list_get',
        'lead_list_save',
        'lead_list_delete',
        'lead_list_leads',
        'lead_get',
        'lead_save',
        'lead_delete',
        'lead_my_leads',
        'lead_save_contact',
        'lead_save_contact_note',
        'lead_select_contact',
        'lead_add_note',
        'lead_save_followup',
        'lead_update_company_email',
        'lead_import_orum_csv',
        'lead_my_followups',
        'lead_mark_dialed',
        'lead_analytics',
        'lead_dashboard',
        'lead_dashboard_task_save',
        'lead_dashboard_task_toggle',
        'lead_dashboard_task_delete',
        'lead_orum_import_history',
        'lead_preview_orum_csv',
        'lead_confirm_orum_import',
        'lead_sync_gmail',
        'lead_calendar_day_events',
        'lead_schedule_calendar',
        'lead_update_core_fields',
        'lead_set_primary_contact',
        'lead_save_stage',
        'lead_save_milestone',
        'lead_assign_org_credits',
        'lead_save_email_branding',
        'lead_email_sample_bundle',
        'lead_send_sms',
        'lead_send_email',
        'lead_pipeline_snapshot',
        'lead_sequences_snapshot',
        'lead_sequence_action',
        'lead_export_csv',
        'lead_export_leads_csv',
        'lead_export_history',
        'lead_sales_users',
        'lead_legacy_lists',
        'lead_import_legacy',
        'lead_create_territory_lists',
        'lead_generate_daily_lists',
        'lead_generate_followup_lists',
        'lead_assign_list',
        'lead_distribute_unassigned'
        ,'lead_pair_search'
    ];
    if (!in_array($action, $leadActions, true)) return false;

    leadRequireAccess();
    $db = leadDb();
    $now = time();
    $actor = leadActorEmail();

    if (leadModernActionHandled($action, $db, $actor, $now)) {
        return true;
    }

    if ($action === 'lead_sales_users') {
        echo json_encode(['success' => true, 'users' => leadSalesUsers()]);
        return true;
    }

    if ($action === 'lead_pair_search') {
        if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Only managers can search leads for pairing']));
        $q = trim((string)($_POST['q'] ?? ''));
        if ($q === '') {
            echo json_encode(['success' => true, 'leads' => []]);
            return true;
        }
        $stmt = $db->prepare("
            SELECT
                l.id,
                l.company,
                l.email,
                l.phone,
                l.organization_id,
                l.updated_at,
                ll.name AS list_name,
                ll.assigned_to_email
            FROM leads l
            JOIN lead_lists ll ON ll.id = l.list_id
            WHERE (
                l.company LIKE :q OR
                l.email LIKE :q OR
                l.phone LIKE :q OR
                l.website LIKE :q OR
                l.address LIKE :q OR
                ll.name LIKE :q
            )
            ORDER BY
                CASE WHEN COALESCE(l.organization_id, '') = '' THEN 0 ELSE 1 END ASC,
                l.updated_at DESC,
                l.company COLLATE NOCASE ASC
            LIMIT 50
        ");
        leadBindText($stmt, ':q', '%' . $q . '%');
        $res = $stmt->execute();
        $rows = [];
        while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
        echo json_encode(['success' => true, 'leads' => $rows]);
        return true;
    }

    if ($action === 'lead_legacy_lists') {
        echo json_encode(['success' => true, 'lists' => leadLegacyFilterLists()]);
        return true;
    }

    if ($action === 'lead_my_leads') {
        echo json_encode(leadMyLeadsQueryForTarget(
            $db,
            $actor,
            leadViewerTarget($actor),
            leadInt('page', 1),
            leadInt('per_page', 50),
            leadText('q'),
            leadText('sort', 'updated_at'),
            leadText('dir', 'desc'),
            leadText('followup_scope', 'all')
        ));
        return true;
    }

    if ($action === 'lead_my_followups') {
        $target = leadViewerTarget($actor);
        $ownerEmail = $target['mode'] === 'all' ? '' : ($target['email'] ?? $actor);
        $status = leadNormalizeStatus(leadText('status', 'open'), 'open');
        $scope = strtolower(leadText('scope', 'due'));
        $where = ['1=1'];
        if ($ownerEmail !== '') $where[] = 'fu.owner_email = :owner_email';
        if ($target['mode'] === 'mine') {
            $where[] = 'll.assigned_to_email = :assigned_to_email';
        } elseif ($target['mode'] === 'user') {
            $where[] = 'll.assigned_to_email = :assigned_to_email';
        }
        if ($status !== '') {
            $where[] = 'fu.status = :status';
        }
        if ($scope === 'due') {
            $where[] = 'fu.due_at > 0 AND fu.due_at <= :now_due';
        }
        $stmt = $db->prepare("
            SELECT
                fu.*,
                l.company,
                l.phone,
                l.email,
                l.region,
                l.region_code,
                l.city,
                l.state,
                l.website,
                ll.name AS list_name
            FROM lead_followups fu
            JOIN leads l ON l.id = fu.lead_id
            JOIN lead_lists ll ON ll.id = l.list_id
            WHERE " . implode(' AND ', $where) . "
            ORDER BY
                CASE fu.status WHEN 'open' THEN 0 ELSE 1 END,
                CASE WHEN fu.due_at IS NULL OR fu.due_at = 0 THEN 1 ELSE 0 END ASC,
                fu.due_at ASC,
                fu.created_at DESC
            LIMIT 500
        ");
        if ($ownerEmail !== '') leadBindText($stmt, ':owner_email', $ownerEmail);
        if ($target['mode'] === 'mine') leadBindText($stmt, ':assigned_to_email', $actor);
        elseif ($target['mode'] === 'user') leadBindText($stmt, ':assigned_to_email', (string)$target['email']);
        if ($status !== '') leadBindText($stmt, ':status', $status);
        if ($scope === 'due') $stmt->bindValue(':now_due', $now, SQLITE3_INTEGER);
        $res = $stmt->execute();
        $rows = [];
        while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
        echo json_encode(['success' => true, 'followups' => $rows, 'target' => $target]);
        return true;
    }

    if ($action === 'lead_dashboard') {
        $stmt = $db->prepare("
            SELECT ll.*
            FROM lead_lists ll
            WHERE ll.assigned_to_email = :email
            ORDER BY COALESCE(ll.exported_at, 0) ASC, ll.updated_at DESC
        ");
        leadBindText($stmt, ':email', $actor);
        $res = $stmt->execute();
        $lists = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
            $lists[] = $row;
        }
        echo json_encode(['success' => true, 'lists' => $lists]);
        return true;
    }

    if ($action === 'lead_list_list') {
        $type = leadNormalizeType(leadText('type'), '');
        $region = leadNormalizeRegion(leadText('region'));
        $assignedTo = strtolower(leadText('assigned_to_email'));
        $status = leadNormalizeStatus(leadText('status'), '');
        $search = leadText('q');
        $onlyMine = filter_var($_POST['only_mine'] ?? '0', FILTER_VALIDATE_BOOLEAN);

        $where = ['1=1'];
        $binds = [];
        if ($type !== '') {
            $where[] = 'll.type = :type';
            $binds[':type'] = $type;
        }
        if ($region !== '') {
            $where[] = '(ll.region = :region OR ll.region_code = :region_code)';
            $binds[':region'] = $region;
            $binds[':region_code'] = strtoupper($region);
        }
        if ($assignedTo !== '') {
            $where[] = 'll.assigned_to_email = :assigned_to_email';
            $binds[':assigned_to_email'] = $assignedTo;
        }
        if ($status !== '') {
            $where[] = 'll.status = :status';
            $binds[':status'] = $status;
        }
        if ($search !== '') {
            $where[] = '(ll.name LIKE :q OR ll.region LIKE :q OR ll.region_code LIKE :q)';
            $binds[':q'] = '%' . $search . '%';
        }
        if (!leadCanManageLists() || $onlyMine) {
            $where[] = 'll.assigned_to_email = :actor_email';
            $binds[':actor_email'] = $actor;
        }

        $sql = "
            SELECT ll.*
            FROM lead_lists ll
            WHERE " . implode(' AND ', $where) . "
            ORDER BY
                CASE ll.type WHEN 'daily' THEN 0 WHEN 'territory' THEN 1 ELSE 2 END,
                CASE WHEN ll.assigned_to_email = :actor_order THEN 0 ELSE 1 END,
                ll.region COLLATE NOCASE ASC,
                ll.sort_order ASC,
                ll.name COLLATE NOCASE ASC
        ";
        $stmt = $db->prepare($sql);
        foreach ($binds as $key => $val) leadBindText($stmt, $key, $val);
        leadBindText($stmt, ':actor_order', $actor);
        $res = $stmt->execute();
        $rows = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
            $rows[] = $row;
        }
        echo json_encode(['success' => true, 'lists' => $rows]);
        return true;
    }

    if ($action === 'lead_list_get') {
        $id = leadText('id');
        if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing id']));
        $row = leadListRowById($db, $id);
        if (!$row) die(json_encode(['success' => false, 'error' => 'List not found']));
        leadRequireListView($row);
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
        echo json_encode(['success' => true, 'list' => $row]);
        return true;
    }

    if ($action === 'lead_list_save') {
        $id = leadText('id');
        $name = leadText('name');
        if ($name === '') die(json_encode(['success' => false, 'error' => 'Name required']));

        $existing = $id !== '' ? leadListRowById($db, $id) : false;
        if ($existing && !leadListCanView($existing)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $region = leadNormalizeRegion(leadText('region'));
        $regionCode = strtoupper(leadText('region_code'));
        if ($regionCode === '' && $region !== '') $regionCode = leadRegionCodeFromName($region);
        $description = leadText('description');
        $status = leadNormalizeStatus(leadText('status', 'active'), 'active');
        $type = leadNormalizeType(leadText('type', 'manual'), 'manual');
        $sortOrder = leadInt('sort_order', 0);
        $sourceKind = leadText('source_kind');
        $sourceKey = leadText('source_key');
        $assignedTo = strtolower(leadText('assigned_to_email', $existing['assigned_to_email'] ?? ''));
        if (!leadCanManageLists()) {
            if ($assignedTo !== '' && $assignedTo !== $actor) {
                die(json_encode(['success' => false, 'error' => 'Only managers can assign lists to others']));
            }
            $assignedTo = $assignedTo !== '' ? $assignedTo : $actor;
        }
        $metadata = leadJson('metadata_json');
        $metaJson = $metadata !== null ? json_encode($metadata) : null;

        if ($id === '') {
            $id = leadId('list');
            $stmt = $db->prepare("
                INSERT INTO lead_lists (
                    id, name, region, region_code, type, source_kind, source_key, description, status,
                    assigned_to_email, assigned_by_email, exported_at, exported_by_email, exported_count,
                    lead_count, sort_order, metadata_json, created_at, updated_at, created_by_email, updated_by_email
                ) VALUES (
                    :id, :name, :region, :region_code, :type, :source_kind, :source_key, :description, :status,
                    :assigned_to_email, :assigned_by_email, NULL, '', 0, 0, :sort_order, :metadata_json,
                    :created_at, :updated_at, :created_by_email, :updated_by_email
                )
            ");
            leadBindText($stmt, ':id', $id);
            $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
            leadBindText($stmt, ':created_by_email', $actor);
        } else {
            $stmt = $db->prepare("
                UPDATE lead_lists
                SET
                    name = :name,
                    region = :region,
                    region_code = :region_code,
                    type = :type,
                    source_kind = :source_kind,
                    source_key = :source_key,
                    description = :description,
                    status = :status,
                    assigned_to_email = :assigned_to_email,
                    assigned_by_email = :assigned_by_email,
                    sort_order = :sort_order,
                    metadata_json = :metadata_json,
                    updated_at = :updated_at,
                    updated_by_email = :updated_by_email
                WHERE id = :id
            ");
            leadBindText($stmt, ':id', $id);
        }

        leadBindText($stmt, ':name', $name);
        leadBindText($stmt, ':region', $region);
        leadBindText($stmt, ':region_code', $regionCode);
        leadBindText($stmt, ':type', $type);
        leadBindText($stmt, ':source_kind', $sourceKind !== '' ? $sourceKind : ($existing['source_kind'] ?? ''));
        leadBindText($stmt, ':source_key', $sourceKey !== '' ? $sourceKey : ($existing['source_key'] ?? ''));
        leadBindText($stmt, ':description', $description);
        leadBindText($stmt, ':status', $status);
        leadBindText($stmt, ':assigned_to_email', $assignedTo);
        leadBindText($stmt, ':assigned_by_email', $assignedTo !== '' ? $actor : '');
        $stmt->bindValue(':sort_order', $sortOrder, SQLITE3_INTEGER);
        if ($metaJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
        else leadBindText($stmt, ':metadata_json', $metaJson);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':updated_by_email', $actor);

        $ok = $stmt->execute();
        if (!$ok) die(json_encode(['success' => false, 'error' => 'Could not save list']));
        $syncLeadAssign = $db->prepare('UPDATE lead_memberships SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE list_id = :list_id');
        leadBindText($syncLeadAssign, ':assigned_to_email', $assignedTo);
        $syncLeadAssign->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($syncLeadAssign, ':updated_by_email', $actor);
        leadBindText($syncLeadAssign, ':list_id', $id);
        $syncLeadAssign->execute();
        echo json_encode(['success' => true, 'id' => $id]);
        return true;
    }

    if ($action === 'lead_list_delete') {
        if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Only managers can delete lists']));
        $id = leadText('id');
        if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing id']));
        $stmt = $db->prepare('DELETE FROM lead_lists WHERE id = :id');
        leadBindText($stmt, ':id', $id);
        $ok = $stmt->execute();
        echo json_encode(['success' => !!$ok]);
        return true;
    }

    if ($action === 'lead_list_leads') {
        $listId = leadText('list_id');
        if ($listId === '') die(json_encode(['success' => false, 'error' => 'Missing list_id']));
        $listRow = leadListRowById($db, $listId);
        if (!$listRow) die(json_encode(['success' => false, 'error' => 'Lead list not found']));
        leadRequireListView($listRow);

        $limit = max(1, min(1000, leadInt('limit', 200)));
        $offset = max(0, leadInt('offset', 0));
        $status = leadNormalizeStatus(leadText('status'), '');
        $region = leadNormalizeRegion(leadText('region'));
        $q = trim(leadText('q'));

        $where = ['list_id = :list_id'];
        $binds = [':list_id' => $listId];
        if ($status !== '') {
            $where[] = 'status = :status';
            $binds[':status'] = $status;
        }
        if ($region !== '') {
            $where[] = '(region = :region OR region_code = :region_code)';
            $binds[':region'] = $region;
            $binds[':region_code'] = strtoupper($region);
        }
        if ($q !== '') {
            $where[] = '(lead_name LIKE :q OR company LIKE :q OR email LIKE :q OR phone LIKE :q OR address LIKE :q OR website LIKE :q)';
            $binds[':q'] = '%' . $q . '%';
        }

        $sql = "
            SELECT *
            FROM leads
            WHERE " . implode(' AND ', $where) . "
            ORDER BY company COLLATE NOCASE ASC, updated_at DESC, created_at DESC
            LIMIT :limit OFFSET :offset
        ";
        $stmt = $db->prepare($sql);
        foreach ($binds as $key => $val) leadBindText($stmt, $key, $val);
        $stmt->bindValue(':limit', $limit, SQLITE3_INTEGER);
        $stmt->bindValue(':offset', $offset, SQLITE3_INTEGER);
        $res = $stmt->execute();
        $rows = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
            $rows[] = $row;
        }
        echo json_encode(['success' => true, 'leads' => $rows]);
        return true;
    }

    if ($action === 'lead_get') {
        $id = leadText('id');
        if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing id']));
        $row = leadRowById($db, $id);
        if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($row);
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
        $row['contacts'] = leadContactRows($db, $id);
        $row['contact_notes'] = leadContactNoteMap($db, $id);
        $row['dial_event_contacts'] = leadDialEventContactMap($db, $id);
        $row['notes_items'] = leadNoteRows($db, $id);
        $row['followups'] = leadFollowupRows($db, $id);
        $row['dial_events'] = leadDialEventRows($db, $id, 100);
        $row['organization_snapshot'] = leadOrganizationSnapshotForLead($row['organization_id'] ?? '', $actor);
        leadEchoJson(['success' => true, 'lead' => $row]);
        return true;
    }

    if ($action === 'lead_mark_dialed') {
        $leadId = leadText('lead_id');
        if ($leadId === '') die(json_encode(['success' => false, 'error' => 'Missing lead_id']));
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);
        $source = leadText('source', 'manual');
        $context = leadJson('context_json');
        $result = leadRecordDialEvent($db, $leadId, $actor, $source, $context, $now);
        if (empty($result['success'])) die(json_encode($result));
        echo json_encode($result);
        return true;
    }

    if ($action === 'lead_add_note') {
        $leadId = leadText('lead_id');
        $noteText = trim((string)($_POST['note_text'] ?? ''));
        if ($leadId === '' || $noteText === '') die(json_encode(['success' => false, 'error' => 'Lead and note text are required']));
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);
        $stmt = $db->prepare("
            INSERT INTO lead_notes (
                id, lead_id, dial_event_id, owner_email, note_text, created_at, updated_at, created_by_email, updated_by_email
            ) VALUES (
                :id, :lead_id, :dial_event_id, :owner_email, :note_text, :created_at, :updated_at, :created_by_email, :updated_by_email
            )
        ");
        leadBindText($stmt, ':id', leadId('note'));
        leadBindText($stmt, ':lead_id', $leadId);
        leadBindText($stmt, ':dial_event_id', '');
        leadBindText($stmt, ':owner_email', $actor);
        leadBindText($stmt, ':note_text', $noteText);
        $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':created_by_email', $actor);
        leadBindText($stmt, ':updated_by_email', $actor);
        $ok = $stmt->execute();
        if (!$ok) die(json_encode(['success' => false, 'error' => 'Could not save note']));
        echo json_encode(['success' => true, 'notes' => leadNoteRows($db, $leadId)]);
        return true;
    }

    if ($action === 'lead_save_contact') {
        $leadId = leadText('lead_id');
        $contactId = leadText('contact_id');
        $dialEventId = leadText('dial_event_id');
        $fullName = leadText('full_name');
        $title = leadText('title');
        $email = strtolower(leadText('email'));
        $phone = leadText('phone');
        $notes = leadText('notes');
        if ($leadId === '') die(json_encode(['success' => false, 'error' => 'Missing lead_id']));
        if ($fullName === '' && $email === '' && $phone === '') {
            die(json_encode(['success' => false, 'error' => 'Add at least a name, email, or phone for the contact']));
        }
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);

        if ($contactId === '') {
            $contactId = leadId('contact');
            $stmt = $db->prepare("
                INSERT INTO lead_contacts (
                    id, lead_id, owner_email, full_name, title, email, phone, notes,
                    created_at, updated_at, created_by_email, updated_by_email
                ) VALUES (
                    :id, :lead_id, :owner_email, :full_name, :title, :email, :phone, :notes,
                    :created_at, :updated_at, :created_by_email, :updated_by_email
                )
            ");
            leadBindText($stmt, ':id', $contactId);
            $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
            leadBindText($stmt, ':created_by_email', $actor);
        } else {
            $existingStmt = $db->prepare('SELECT * FROM lead_contacts WHERE id = :id LIMIT 1');
            leadBindText($existingStmt, ':id', $contactId);
            $existingRes = $existingStmt->execute();
            $existing = $existingRes ? $existingRes->fetchArray(SQLITE3_ASSOC) : false;
            if (!$existing) die(json_encode(['success' => false, 'error' => 'Contact not found']));
            if (($existing['lead_id'] ?? '') !== $leadId) die(json_encode(['success' => false, 'error' => 'Contact does not belong to this lead']));
            $stmt = $db->prepare("
                UPDATE lead_contacts
                SET full_name = :full_name,
                    title = :title,
                    email = :email,
                    phone = :phone,
                    notes = :notes,
                    updated_at = :updated_at,
                    updated_by_email = :updated_by_email
                WHERE id = :id
            ");
            leadBindText($stmt, ':id', $contactId);
        }
        leadBindText($stmt, ':lead_id', $leadId);
        leadBindText($stmt, ':owner_email', $actor);
        leadBindText($stmt, ':full_name', $fullName);
        leadBindText($stmt, ':title', $title);
        leadBindText($stmt, ':email', $email);
        leadBindText($stmt, ':phone', $phone);
        leadBindText($stmt, ':notes', $notes);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':updated_by_email', $actor);
        $ok = $stmt->execute();
        if (!$ok) die(json_encode(['success' => false, 'error' => 'Could not save contact']));
        if ($dialEventId !== '') {
            leadSetDialEventSelection($db, $leadId, $dialEventId, $contactId, false, $actor, $now);
        }
        echo json_encode(['success' => true, 'contacts' => leadContactRows($db, $leadId)]);
        return true;
    }

    if ($action === 'lead_save_contact_note') {
        $leadId = leadText('lead_id');
        $contactId = leadText('contact_id');
        $noteText = trim((string)($_POST['note_text'] ?? ''));
        if ($leadId === '' || $contactId === '' || $noteText === '') {
            die(json_encode(['success' => false, 'error' => 'Lead, contact, and note text are required']));
        }
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);
        $check = $db->prepare('SELECT id FROM lead_contacts WHERE id = :id AND lead_id = :lead_id LIMIT 1');
        leadBindText($check, ':id', $contactId);
        leadBindText($check, ':lead_id', $leadId);
        $checkRes = $check->execute();
        if (!($checkRes && $checkRes->fetchArray(SQLITE3_ASSOC))) {
            die(json_encode(['success' => false, 'error' => 'Contact not found']));
        }
        $stmt = $db->prepare("
            INSERT INTO lead_contact_notes (
                id, lead_id, contact_id, owner_email, note_text, created_at, updated_at, created_by_email, updated_by_email
            ) VALUES (
                :id, :lead_id, :contact_id, :owner_email, :note_text, :created_at, :updated_at, :created_by_email, :updated_by_email
            )
        ");
        leadBindText($stmt, ':id', leadId('contactnote'));
        leadBindText($stmt, ':lead_id', $leadId);
        leadBindText($stmt, ':contact_id', $contactId);
        leadBindText($stmt, ':owner_email', $actor);
        leadBindText($stmt, ':note_text', $noteText);
        $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':created_by_email', $actor);
        leadBindText($stmt, ':updated_by_email', $actor);
        if (!$stmt->execute()) die(json_encode(['success' => false, 'error' => 'Could not save contact note']));
        echo json_encode(['success' => true, 'contact_notes' => leadContactNoteMap($db, $leadId)]);
        return true;
    }

    if ($action === 'lead_select_contact') {
        $leadId = leadText('lead_id');
        $dialEventId = leadText('dial_event_id');
        $contactId = leadText('contact_id');
        $unknown = filter_var($_POST['unknown'] ?? '0', FILTER_VALIDATE_BOOLEAN);
        if ($leadId === '' || $dialEventId === '') die(json_encode(['success' => false, 'error' => 'Missing lead_id or dial_event_id']));
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);
        if (!$unknown && $contactId !== '') {
            $check = $db->prepare('SELECT id FROM lead_contacts WHERE id = :id AND lead_id = :lead_id LIMIT 1');
            leadBindText($check, ':id', $contactId);
            leadBindText($check, ':lead_id', $leadId);
            $res = $check->execute();
            if (!($res && $res->fetchArray(SQLITE3_ASSOC))) {
                die(json_encode(['success' => false, 'error' => 'Contact not found']));
            }
        }
        leadSetDialEventSelection($db, $leadId, $dialEventId, $contactId, $unknown, $actor, $now);
        echo json_encode(['success' => true, 'contacts' => leadContactRows($db, $leadId), 'dial_event_contacts' => leadDialEventContactMap($db, $leadId)]);
        return true;
    }

    if ($action === 'lead_save_followup') {
        $leadId = leadText('lead_id');
        $followupId = leadText('followup_id');
        if ($leadId === '') die(json_encode(['success' => false, 'error' => 'Missing lead_id']));
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);
        $title = leadText('title');
        $body = leadText('body');
        $status = leadNormalizeStatus(leadText('status', 'open'), 'open');
        $dialEventId = leadText('dial_event_id');
        if (!in_array($status, ['open', 'done', 'cancelled'], true)) $status = 'open';
        $dueAt = 0;
        $dueAtRaw = trim((string)($_POST['due_at'] ?? ''));
        if ($dueAtRaw !== '') {
            $ts = strtotime($dueAtRaw);
            if (!$ts && preg_match('/^\d{4}-\d{2}-\d{2}$/', $dueAtRaw)) {
                $ts = strtotime($dueAtRaw . ' 00:00:00');
            }
            if ($ts) $dueAt = $ts;
        }
        if ($status !== 'done' && $dueAt <= 0) {
            die(json_encode(['success' => false, 'error' => 'Choose a follow-up date']));
        }

        if ($followupId === '') {
            $stmt = $db->prepare("
                INSERT INTO lead_followups (
                    id, lead_id, list_id, dial_event_id, owner_email, title, body, due_at, status, priority, completed_at,
                    created_at, updated_at, created_by_email, updated_by_email
                ) VALUES (
                    :id, :lead_id, :list_id, :dial_event_id, :owner_email, :title, :body, :due_at, :status, :priority, :completed_at,
                    :created_at, :updated_at, :created_by_email, :updated_by_email
                )
            ");
            leadBindText($stmt, ':id', leadId('followup'));
            leadBindText($stmt, ':lead_id', $leadId);
            leadBindText($stmt, ':list_id', $leadRow['list_id'] ?? '');
            leadBindText($stmt, ':dial_event_id', $dialEventId);
            leadBindText($stmt, ':owner_email', $actor);
            $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
            leadBindText($stmt, ':created_by_email', $actor);
        } else {
            $existingStmt = $db->prepare('SELECT * FROM lead_followups WHERE id = :id LIMIT 1');
            leadBindText($existingStmt, ':id', $followupId);
            $existingRes = $existingStmt->execute();
            $existing = $existingRes ? $existingRes->fetchArray(SQLITE3_ASSOC) : false;
            if (!$existing) die(json_encode(['success' => false, 'error' => 'Follow-up not found']));
            if (!leadCanManageLists() && strtolower(trim((string)($existing['owner_email'] ?? ''))) !== $actor) {
                die(json_encode(['success' => false, 'error' => 'Only the follow-up owner can edit it']));
            }
            $stmt = $db->prepare("
                UPDATE lead_followups
                SET dial_event_id = :dial_event_id,
                    title = :title,
                    body = :body,
                    due_at = :due_at,
                    status = :status,
                    priority = :priority,
                    completed_at = :completed_at,
                    updated_at = :updated_at,
                    updated_by_email = :updated_by_email
                WHERE id = :id
            ");
            leadBindText($stmt, ':id', $followupId);
            if ($dialEventId === '') $dialEventId = trim((string)($existing['dial_event_id'] ?? ''));
        }

        leadBindText($stmt, ':dial_event_id', $dialEventId);
        leadBindText($stmt, ':title', $title);
        leadBindText($stmt, ':body', $body);
        $stmt->bindValue(':due_at', $dueAt, SQLITE3_INTEGER);
        leadBindText($stmt, ':status', $status);
        leadBindText($stmt, ':priority', 'normal');
        if ($status === 'done') $stmt->bindValue(':completed_at', $now, SQLITE3_INTEGER);
        else $stmt->bindValue(':completed_at', null, SQLITE3_NULL);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':updated_by_email', $actor);
        $ok = $stmt->execute();
        if (!$ok) die(json_encode(['success' => false, 'error' => 'Could not save follow-up']));
        echo json_encode(['success' => true, 'followups' => leadFollowupRows($db, $leadId)]);
        return true;
    }

    if ($action === 'lead_update_company_email') {
        $leadId = leadText('lead_id');
        $email = strtolower(leadText('email'));
        if ($leadId === '') die(json_encode(['success' => false, 'error' => 'Missing lead_id']));
        $leadRow = leadRowById($db, $leadId);
        if (!$leadRow) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        leadRequireLeadView($leadRow);
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            die(json_encode(['success' => false, 'error' => 'Enter a valid email address']));
        }
        if (!leadUpdateCompanyEmail($db, $leadId, $email, $actor, $now)) {
            die(json_encode(['success' => false, 'error' => 'Could not update company email']));
        }
        $row = leadRowById($db, $leadId);
        $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
        echo json_encode(['success' => true, 'lead' => $row]);
        return true;
    }

    if ($action === 'lead_import_orum_csv') {
        if (empty($_FILES['csv_file']) || !is_uploaded_file($_FILES['csv_file']['tmp_name'])) {
            die(json_encode(['success' => false, 'error' => 'Upload a CSV file first']));
        }
        $result = leadImportOrumCsv($db, $_FILES['csv_file']['tmp_name'], $actor);
        if (empty($result['success'])) die(json_encode($result));
        echo json_encode($result);
        return true;
    }

    if ($action === 'lead_save') {
        $id = leadText('id');
        $listId = leadText('list_id');
        if ($listId === '') die(json_encode(['success' => false, 'error' => 'Missing list_id']));
        $listRow = leadListRowById($db, $listId);
        if (!$listRow) die(json_encode(['success' => false, 'error' => 'Lead list not found']));
        leadRequireListView($listRow);
        if ($id === '' && strtolower(trim((string)($listRow['type'] ?? 'manual'))) !== 'manual') {
            die(json_encode(['success' => false, 'error' => 'Manual lead entry is only available for manual lists']));
        }

        $region = leadNormalizeRegion(leadText('region', $listRow['region'] ?? ''));
        $regionCode = strtoupper(leadText('region_code', $listRow['region_code'] ?? ''));
        $status = leadNormalizeStatus(leadText('status', 'new'), 'new');
        $leadName = leadText('lead_name');
        $company = leadText('company');
        $email = strtolower(leadText('email'));
        $phone = leadText('phone');
        $address = leadText('address');
        $city = leadText('city');
        $state = leadText('state');
        $postalCode = leadText('postal_code');
        $website = leadText('website');
        $notes = leadText('notes');
        $source = leadText('source');
        $externalKey = leadText('external_key');
        $assignedTo = strtolower(leadText('assigned_to_email', $listRow['assigned_to_email'] ?? ''));
        $metadata = leadJson('metadata_json');
        $saved = leadSaveMembershipRecord($db, $id, $listId, [
            'organization_id' => trim((string)($_POST['organization_id'] ?? '')),
            'external_key' => $externalKey,
            'region' => $region,
            'region_code' => $regionCode,
            'status' => $status,
            'lead_name' => $leadName,
            'company' => $company,
            'email' => $email,
            'phone' => $phone,
            'address' => $address,
            'city' => $city,
            'state' => $state,
            'postal_code' => $postalCode,
            'website' => $website,
            'notes' => $notes,
            'source' => $source,
            'assigned_to_email' => $assignedTo,
            'metadata_json' => is_array($metadata) ? $metadata : [],
        ], $actor, $now);
        if (empty($saved['success'])) die(json_encode(['success' => false, 'error' => $saved['error'] ?? 'Could not save lead']));
        $id = (string)$saved['id'];
        $count = leadSyncListLeadCount($db, $listId);
        echo json_encode(['success' => true, 'id' => $id, 'lead_count' => $count]);
        return true;
    }

    if ($action === 'lead_delete') {
        $id = leadText('id');
        if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing id']));
        $stmt = $db->prepare('SELECT list_id, lead_entity_id FROM lead_memberships WHERE id = :id LIMIT 1');
        leadBindText($stmt, ':id', $id);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        $listRow = leadListRowById($db, $row['list_id'] ?? '');
        leadRequireListView($listRow);

        $del = $db->prepare('DELETE FROM lead_memberships WHERE id = :id');
        leadBindText($del, ':id', $id);
        $ok = $del->execute();
        if ($ok) leadDeleteOrphanEntity($db, (string)($row['lead_entity_id'] ?? ''));
        $count = leadSyncListLeadCount($db, $row['list_id']);
        echo json_encode(['success' => !!$ok, 'lead_count' => $count]);
        return true;
    }

    if ($action === 'lead_export_history') {
        $listId = leadText('list_id');
        if ($listId === '') die(json_encode(['success' => false, 'error' => 'Missing list_id']));
        $listRow = leadListRowById($db, $listId);
        if (!$listRow) die(json_encode(['success' => false, 'error' => 'List not found']));
        leadRequireListView($listRow);

        $stmt = $db->prepare('SELECT * FROM lead_exports WHERE list_id = :list_id ORDER BY exported_at DESC');
        leadBindText($stmt, ':list_id', $listId);
        $res = $stmt->execute();
        $rows = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $row['metadata'] = leadDecodeJsonRowField($row, 'metadata_json');
            $rows[] = $row;
        }
        echo json_encode(['success' => true, 'exports' => $rows]);
        return true;
    }

    if ($action === 'lead_export_csv') {
        $listId = leadText('list_id');
        if ($listId === '') die(json_encode(['success' => false, 'error' => 'Missing list_id']));
        $export = leadBuildCsvExport($db, $listId, $actor, $now);
        if (empty($export['success'])) {
            die(json_encode($export));
        }

        $download = filter_var($_POST['download'] ?? '0', FILTER_VALIDATE_BOOLEAN);
        if ($download) {
            if (!headers_sent()) {
                header('Content-Type: text/csv; charset=UTF-8');
                header('Content-Disposition: attachment; filename="' . addslashes($export['filename']) . '"');
                header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
            }
            echo $export['csv'];
            return true;
        }

        echo json_encode($export);
        return true;
    }

    if ($action === 'lead_export_leads_csv') {
        $mode = strtolower(leadText('mode', 'selected'));
        $target = leadViewerTarget($actor);
        $leadIds = array_values(array_filter(array_map('trim', explode(',', (string)($_POST['lead_ids_csv'] ?? '')))));
        $export = leadBuildLeadSelectionCsv($db, $actor, $leadIds, $target, $mode === 'due' ? 'due' : 'selected');
        if (empty($export['success'])) die(json_encode($export));

        $download = filter_var($_POST['download'] ?? '0', FILTER_VALIDATE_BOOLEAN);
        if ($download) {
            if (!headers_sent()) {
                header('Content-Type: text/csv; charset=UTF-8');
                header('Content-Disposition: attachment; filename="' . addslashes($export['filename']) . '"');
                header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
            }
            echo $export['csv'];
            return true;
        }

        echo json_encode($export);
        return true;
    }

    if ($action === 'lead_import_legacy') {
        if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Only managers can import legacy territory lists']));
        $listName = leadText('legacy_list_name');
        if ($listName === '') die(json_encode(['success' => false, 'error' => 'Missing legacy_list_name']));
        $chunkSize = max(0, min(5000, leadInt('chunk_size', 250)));
        $assignedRaw = trim((string)($_POST['assigned_emails_csv'] ?? ''));
        $assignedEmails = array_values(array_filter(array_map(function($v) {
            return strtolower(trim($v));
        }, explode(',', $assignedRaw))));
        echo json_encode(leadImportLegacyList($db, $listName, $chunkSize, $actor, $assignedEmails));
        return true;
    }

    if ($action === 'lead_create_territory_lists') {
        if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Only managers can create territory lists']));
        $territoryName = leadText('territory_name');
        if ($territoryName === '') die(json_encode(['success' => false, 'error' => 'Territory name is required']));
        $chunkSize = max(0, min(5000, leadInt('chunk_size', 250)));
        $placeIds = leadJson('place_ids_json');
        if (!is_array($placeIds)) $placeIds = [];
        $filterMeta = leadJson('filter_json');
        if (!is_array($filterMeta)) $filterMeta = [];
        $builderConfig = leadJson('builder_config_json');
        if (!is_array($builderConfig)) $builderConfig = [];
        echo json_encode(leadCreateTerritoryLists($db, $territoryName, $placeIds, $chunkSize, $actor, $filterMeta, $builderConfig));
        return true;
    }

    if ($action === 'lead_generate_daily_lists') {
        $chunkSize = max(0, min(5000, leadInt('chunk_size', 100)));
        $assignedEmails = [];
        if (leadCanManageLists()) {
            $assignedRaw = trim((string)($_POST['assigned_emails_csv'] ?? ''));
            $assignedEmails = array_values(array_filter(array_map(function($v) {
                return strtolower(trim($v));
            }, explode(',', $assignedRaw))));
        }
        echo json_encode(leadGenerateDailyLists($db, $chunkSize, $actor, $assignedEmails, !leadCanManageLists()));
        return true;
    }

    if ($action === 'lead_generate_followup_lists') {
        $chunkSize = max(0, min(5000, leadInt('chunk_size', 100)));
        echo json_encode(leadGenerateFollowupLists($db, $chunkSize, $actor));
        return true;
    }

    if ($action === 'lead_assign_list') {
        if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Only managers can assign lists']));
        $listId = leadText('list_id');
        $assignedTo = strtolower(leadText('assigned_to_email'));
        if ($listId === '') die(json_encode(['success' => false, 'error' => 'Missing list_id']));
        $listRow = leadListRowById($db, $listId);
        if (!$listRow) die(json_encode(['success' => false, 'error' => 'List not found']));

        $stmt = $db->prepare("
            UPDATE lead_lists
            SET assigned_to_email = :assigned_to_email,
                assigned_by_email = :assigned_by_email,
                updated_at = :updated_at,
                updated_by_email = :updated_by_email
            WHERE id = :id
        ");
        leadBindText($stmt, ':assigned_to_email', $assignedTo);
        leadBindText($stmt, ':assigned_by_email', $assignedTo !== '' ? $actor : '');
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':updated_by_email', $actor);
        leadBindText($stmt, ':id', $listId);
        $ok = $stmt->execute();
        if (!$ok) die(json_encode(['success' => false, 'error' => 'Could not assign list']));
        $syncLeadAssign = $db->prepare('UPDATE lead_memberships SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE list_id = :list_id');
        leadBindText($syncLeadAssign, ':assigned_to_email', $assignedTo);
        $syncLeadAssign->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($syncLeadAssign, ':updated_by_email', $actor);
        leadBindText($syncLeadAssign, ':list_id', $listId);
        $syncLeadAssign->execute();
        echo json_encode(['success' => true]);
        return true;
    }

    if ($action === 'lead_distribute_unassigned') {
        if (!leadCanManageLists()) die(json_encode(['success' => false, 'error' => 'Only managers can distribute lists']));
        $assignedRaw = trim((string)($_POST['assigned_emails_csv'] ?? ''));
        $assignedEmails = array_values(array_filter(array_map(function($v) {
            return strtolower(trim($v));
        }, explode(',', $assignedRaw))));
        if (!$assignedEmails) die(json_encode(['success' => false, 'error' => 'Select at least one salesperson']));

        $stmt = $db->prepare("
            SELECT id
            FROM lead_lists
            WHERE assigned_to_email = ''
            ORDER BY
                CASE type WHEN 'daily' THEN 0 WHEN 'territory' THEN 1 ELSE 2 END,
                region COLLATE NOCASE ASC,
                sort_order ASC,
                name COLLATE NOCASE ASC
        ");
        $res = $stmt->execute();
        $listIds = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) $listIds[] = $row['id'];

        $count = 0;
        foreach ($listIds as $idx => $listId) {
            $assignedTo = $assignedEmails[$idx % count($assignedEmails)];
            $up = $db->prepare("
                UPDATE lead_lists
                SET assigned_to_email = :assigned_to_email,
                    assigned_by_email = :assigned_by_email,
                    updated_at = :updated_at,
                    updated_by_email = :updated_by_email
                WHERE id = :id
            ");
            leadBindText($up, ':assigned_to_email', $assignedTo);
            leadBindText($up, ':assigned_by_email', $actor);
            $up->bindValue(':updated_at', $now, SQLITE3_INTEGER);
            leadBindText($up, ':updated_by_email', $actor);
            leadBindText($up, ':id', $listId);
            if ($up->execute()) {
                $syncLeadAssign = $db->prepare('UPDATE lead_memberships SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE list_id = :list_id');
                leadBindText($syncLeadAssign, ':assigned_to_email', $assignedTo);
                $syncLeadAssign->bindValue(':updated_at', $now, SQLITE3_INTEGER);
                leadBindText($syncLeadAssign, ':updated_by_email', $actor);
                leadBindText($syncLeadAssign, ':list_id', $listId);
                $syncLeadAssign->execute();
                $count++;
            }
        }

        echo json_encode(['success' => true, 'assigned_count' => $count]);
        return true;
    }

    return false;
}
