<?php
require_once dirname(__DIR__) . '/_storage.php';

function leadDbPath() {
    return storageExistingPath('databases/leads.sqlite', __DIR__ . '/leads.sqlite', true);
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
        CREATE TABLE IF NOT EXISTS leads (
            id TEXT PRIMARY KEY,
            list_id TEXT NOT NULL,
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
            FOREIGN KEY(list_id) REFERENCES lead_lists(id) ON DELETE CASCADE
        )
    ");

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
            FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
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
            FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
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
            FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
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
            FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
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
            FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
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
            FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
            FOREIGN KEY(contact_id) REFERENCES lead_contacts(id) ON DELETE CASCADE
        )
    ");

    leadEnsureColumn($db, 'lead_lists', 'type', "TEXT NOT NULL DEFAULT 'manual'");
    leadEnsureColumn($db, 'lead_lists', 'source_kind', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'source_key', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'assigned_to_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'assigned_by_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'exported_at', 'INTEGER');
    leadEnsureColumn($db, 'lead_lists', 'exported_by_email', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_lists', 'exported_count', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'lead_lists', 'lead_count', 'INTEGER NOT NULL DEFAULT 0');
    leadEnsureColumn($db, 'leads', 'external_key', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'leads', 'organization_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'leads', 'website', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_notes', 'dial_event_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_followups', 'dial_event_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dial_events', 'event_token', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dial_events', 'selected_contact_id', "TEXT NOT NULL DEFAULT ''");
    leadEnsureColumn($db, 'lead_dial_events', 'selected_contact_unknown', 'INTEGER NOT NULL DEFAULT 0');

    foreach ([
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_region_sort ON lead_lists(region, sort_order, name)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_type_region ON lead_lists(type, region, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_assigned ON lead_lists(assigned_to_email, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_status ON lead_lists(status, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_source ON lead_lists(source_kind, source_key)',
        'CREATE INDEX IF NOT EXISTS idx_lead_lists_updated_at ON lead_lists(updated_at)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_lists_unique_source ON lead_lists(source_kind, source_key) WHERE source_kind <> \'\' AND source_key <> \'\'',
        'CREATE INDEX IF NOT EXISTS idx_leads_list_id ON leads(list_id)',
        'CREATE INDEX IF NOT EXISTS idx_leads_external_key ON leads(external_key)',
        'CREATE INDEX IF NOT EXISTS idx_leads_organization_id ON leads(organization_id)',
        'CREATE INDEX IF NOT EXISTS idx_leads_region ON leads(region)',
        'CREATE INDEX IF NOT EXISTS idx_leads_region_code ON leads(region_code)',
        'CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)',
        'CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to_email)',
        'CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON leads(updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_leads_list_region ON leads(list_id, region)',
        'CREATE INDEX IF NOT EXISTS idx_leads_list_updated ON leads(list_id, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company COLLATE NOCASE)',
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
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_dial_events_unique_token ON lead_dial_events(lead_id, owner_email, source, event_token) WHERE event_token <> \'\''
    ] as $sql) {
        $db->exec($sql);
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
    if (!empty($perms['manage_users']) || !empty($perms['manage_sales_users']) || !empty($perms['create_users'])) {
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

function leadDecodeJsonRowField($row, $key) {
    $raw = $row[$key] ?? null;
    if (!is_string($raw) || trim($raw) === '') return null;
    $data = json_decode($raw, true);
    return json_last_error() === JSON_ERROR_NONE ? $data : null;
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
    return $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
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
    return $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
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
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
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
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
    return $rows;
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
    $stmt = $db->prepare("
        UPDATE leads
        SET email = :email,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    leadBindText($stmt, ':email', strtolower(trim((string)$email)));
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $leadId);
    return (bool)$stmt->execute();
}

function leadOrganizationSnapshotForLead($organizationId, $actor) {
    $organizationId = strtolower(trim((string)$organizationId));
    if ($organizationId === '') return null;

    if (function_exists('orgCustomerDataSnapshot')) {
        $orgs = orgCustomerDataSnapshot($actor);
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
        while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
            if (leadNormalizePhoneForMatch($row['phone'] ?? '') === $phone) return $row;
        }
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
    if ($existingRes && $existingRes->fetchArray(SQLITE3_ASSOC)) return;

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
        $eventToken = leadOrumRowValue($row, ['call_id', 'id', 'activity_id', 'conversation_id']);
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
    fclose($handle);

    return [
        'success' => true,
        'rows' => $rowCount,
        'matched' => $matched,
        'created_calls' => $created,
        'unmatched' => array_slice($unmatched, 0, 50)
    ];
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
    $requested = strtolower(leadText('target_email'));
    if ($requested === '' || $requested === 'me' || $requested === 'mine') return ['mode' => 'mine', 'email' => $actor];
    if (!leadCanManageLists()) return ['mode' => 'mine', 'email' => $actor];
    if ($requested === '__all__' || $requested === 'all') return ['mode' => 'all', 'email' => ''];
    return ['mode' => 'user', 'email' => $requested];
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
        'organization_id' => trim((string)($payload['organization_id'] ?? '')),
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

function leadInsertLead(SQLite3 $db, $listId, $leadData, $actor, $now) {
    $stmt = $db->prepare("
        INSERT INTO leads (
            id, list_id, organization_id, external_key, region, region_code, status, lead_name, company, email, phone, address,
            city, state, postal_code, website, notes, source, assigned_to_email, metadata_json,
            created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, :list_id, :organization_id, :external_key, :region, :region_code, :status, :lead_name, :company, :email, :phone, :address,
            :city, :state, :postal_code, :website, :notes, :source, :assigned_to_email, :metadata_json,
            :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    leadBindText($stmt, ':id', leadId('lead'));
    leadBindText($stmt, ':list_id', $listId);
    leadBindText($stmt, ':organization_id', $leadData['organization_id'] ?? '');
    leadBindText($stmt, ':external_key', $leadData['external_key'] ?? '');
    leadBindText($stmt, ':region', $leadData['region'] ?? '');
    leadBindText($stmt, ':region_code', $leadData['region_code'] ?? '');
    leadBindText($stmt, ':status', $leadData['status'] ?? 'new');
    leadBindText($stmt, ':lead_name', $leadData['lead_name'] ?? '');
    leadBindText($stmt, ':company', $leadData['company'] ?? '');
    leadBindText($stmt, ':email', $leadData['email'] ?? '');
    leadBindText($stmt, ':phone', $leadData['phone'] ?? '');
    leadBindText($stmt, ':address', $leadData['address'] ?? '');
    leadBindText($stmt, ':city', $leadData['city'] ?? '');
    leadBindText($stmt, ':state', $leadData['state'] ?? '');
    leadBindText($stmt, ':postal_code', $leadData['postal_code'] ?? '');
    leadBindText($stmt, ':website', $leadData['website'] ?? '');
    leadBindText($stmt, ':notes', $leadData['notes'] ?? '');
    leadBindText($stmt, ':source', $leadData['source'] ?? '');
    leadBindText($stmt, ':assigned_to_email', $leadData['assigned_to_email'] ?? '');
    $metaJson = json_encode($leadData['metadata_json'] ?? null);
    if ($metaJson === 'null') $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metaJson);
    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':created_by_email', $actor);
    leadBindText($stmt, ':updated_by_email', $actor);
    return (bool)$stmt->execute();
}

function leadLinkOrganization(SQLite3 $db, $leadId, $orgId, $actor, $salesEmail = '') {
    $leadId = trim((string)$leadId);
    $orgId = function_exists('orgNormalizeId') ? orgNormalizeId($orgId) : trim((string)$orgId);
    if ($leadId === '' || $orgId === '') return false;
    $lead = leadRowById($db, $leadId);
    if (!$lead) return false;
    $metadata = leadDecodeJsonRowField($lead, 'metadata_json');
    if (!is_array($metadata)) $metadata = [];
    $metadata['organization_id'] = $orgId;
    if (function_exists('orgRead')) {
        $org = orgRead($orgId);
        if (is_array($org)) $metadata['organization_name'] = (string)($org['name'] ?? '');
    }
    $stmt = $db->prepare("
        UPDATE leads
        SET organization_id = :organization_id,
            assigned_to_email = CASE WHEN :sales_email <> '' THEN :sales_email ELSE assigned_to_email END,
            metadata_json = :metadata_json,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    leadBindText($stmt, ':organization_id', $orgId);
    leadBindText($stmt, ':sales_email', strtolower(trim((string)$salesEmail)));
    leadBindText($stmt, ':metadata_json', json_encode($metadata));
    $stmt->bindValue(':updated_at', time(), SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', $leadId);
    return (bool)$stmt->execute();
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
    $stmt = $db->prepare('DELETE FROM leads WHERE list_id = :list_id');
    leadBindText($stmt, ':list_id', $listId);
    $stmt->execute();
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
    $usersDir = storageDir('users');
    $candidates = [];
    if (!is_dir($usersDir) || !function_exists('readUserDataByEmail')) return [];

    $projectCountsByOwner = [];
    $lastCompletedByOwner = [];
    if (function_exists('projectIndexDb')) {
        try {
            $pdb = projectIndexDb();
            $res = $pdb->query("
                SELECT ow AS owner_email, COUNT(1) AS total_orders, MAX(COALESCE(da, pa, qa, ca, 0)) AS last_touch
                FROM manifests
                WHERE ow <> '' AND st = 'completed'
                GROUP BY ow
            ");
            while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                $owner = strtolower(trim((string)($row['owner_email'] ?? '')));
                if ($owner === '') continue;
                $projectCountsByOwner[$owner] = (int)($row['total_orders'] ?? 0);
                $lastCompletedByOwner[$owner] = (int)($row['last_touch'] ?? 0);
            }
        } catch (Throwable $e) {
        }
    }

    $now = time();
    foreach (glob($usersDir . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) !== 'customer') continue;
        if (!empty($u['deleted']) || !empty($u['disabled'])) continue;

        $email = strtolower(trim((string)($u['email'] ?? '')));
        if ($email === '') continue;
        $createdAt = strtotime((string)($u['created_at'] ?? ''));
        if (!$createdAt) continue;

        $ageDays = floor(($now - $createdAt) / 86400);
        $orders = (int)($projectCountsByOwner[$email] ?? 0);
        $lastOrderTs = (int)($lastCompletedByOwner[$email] ?? 0);
        $reason = '';
        if ($orders === 0 && $ageDays >= 2) {
            $reason = 'No order after 2+ days';
        } elseif ($orders > 0 && $orders <= 3 && $lastOrderTs > 0 && (($now - $lastOrderTs) / 86400) >= 3) {
            $reason = 'Initial order only, inactive for 3+ days';
        } else {
            continue;
        }

        $company = trim((string)($u['company'] ?? ''));
        $phone = trim((string)($u['phone'] ?? ''));
        $regionCode = '';
        $orgId = trim((string)($u['organization_id'] ?? ''));
        $org = null;
        if ($orgId !== '' && function_exists('orgRead')) {
            $org = orgRead($orgId);
            if (is_array($org)) {
                $addr = (string)($org['billing_address'] ?? $org['address'] ?? '');
                $regionCode = leadStateFromAddress($addr);
                if ($company === '') $company = (string)($org['name'] ?? '');
            }
        }

        $region = $regionCode !== '' ? $regionCode : 'UNASSIGNED';
        $salesOwner = leadResolveCustomerSalesOwner($u, is_array($org) ? $org : null);
        $candidates[] = [
            'external_key' => 'customer:' . $email,
            'company' => $company !== '' ? $company : $email,
            'lead_name' => (string)($u['name'] ?? ''),
            'email' => $email,
            'phone' => $phone,
            'region' => $region,
            'region_code' => $regionCode,
            'status' => 'open',
            'source' => 'daily_customer_call_list',
            'notes' => $reason,
            'assigned_to_email' => $salesOwner,
            'metadata' => [
                'customer_created_at' => $u['created_at'] ?? null,
                'organization_id' => $orgId !== '' ? $orgId : null,
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
        'lead_dashboard',
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
        $syncLeadAssign = $db->prepare('UPDATE leads SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE list_id = :list_id');
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
        echo json_encode(['success' => true, 'lead' => $row]);
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
            $ts = strtotime($dueAtRaw . ' 00:00:00');
            if ($ts) $dueAt = $ts;
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
        $metaJson = $metadata !== null ? json_encode($metadata) : null;

        if ($id === '') {
            $id = leadId('lead');
            $stmt = $db->prepare("
                INSERT INTO leads (
                    id, list_id, external_key, region, region_code, status, lead_name, company, email, phone, address,
                    city, state, postal_code, website, notes, source, assigned_to_email, metadata_json,
                    created_at, updated_at, created_by_email, updated_by_email
                ) VALUES (
                    :id, :list_id, :external_key, :region, :region_code, :status, :lead_name, :company, :email, :phone, :address,
                    :city, :state, :postal_code, :website, :notes, :source, :assigned_to_email, :metadata_json,
                    :created_at, :updated_at, :created_by_email, :updated_by_email
                )
            ");
            leadBindText($stmt, ':id', $id);
            $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
            leadBindText($stmt, ':created_by_email', $actor);
        } else {
            $stmt = $db->prepare("
                UPDATE leads
                SET
                    list_id = :list_id,
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
            leadBindText($stmt, ':id', $id);
        }

        leadBindText($stmt, ':list_id', $listId);
        leadBindText($stmt, ':external_key', $externalKey);
        leadBindText($stmt, ':region', $region);
        leadBindText($stmt, ':region_code', $regionCode);
        leadBindText($stmt, ':status', $status);
        leadBindText($stmt, ':lead_name', $leadName);
        leadBindText($stmt, ':company', $company);
        leadBindText($stmt, ':email', $email);
        leadBindText($stmt, ':phone', $phone);
        leadBindText($stmt, ':address', $address);
        leadBindText($stmt, ':city', $city);
        leadBindText($stmt, ':state', $state);
        leadBindText($stmt, ':postal_code', $postalCode);
        leadBindText($stmt, ':website', $website);
        leadBindText($stmt, ':notes', $notes);
        leadBindText($stmt, ':source', $source);
        leadBindText($stmt, ':assigned_to_email', $assignedTo);
        if ($metaJson === null) $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
        else leadBindText($stmt, ':metadata_json', $metaJson);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        leadBindText($stmt, ':updated_by_email', $actor);

        $ok = $stmt->execute();
        if (!$ok) die(json_encode(['success' => false, 'error' => 'Could not save lead']));
        $count = leadSyncListLeadCount($db, $listId);
        echo json_encode(['success' => true, 'id' => $id, 'lead_count' => $count]);
        return true;
    }

    if ($action === 'lead_delete') {
        $id = leadText('id');
        if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing id']));
        $stmt = $db->prepare('SELECT list_id FROM leads WHERE id = :id LIMIT 1');
        leadBindText($stmt, ':id', $id);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if (!$row) die(json_encode(['success' => false, 'error' => 'Lead not found']));
        $listRow = leadListRowById($db, $row['list_id'] ?? '');
        leadRequireListView($listRow);

        $del = $db->prepare('DELETE FROM leads WHERE id = :id');
        leadBindText($del, ':id', $id);
        $ok = $del->execute();
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
        $syncLeadAssign = $db->prepare('UPDATE leads SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE list_id = :list_id');
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
                $syncLeadAssign = $db->prepare('UPDATE leads SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE list_id = :list_id');
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
