<?php
require_once __DIR__ . '/_storage.php';
require_once __DIR__ . '/_config.php';
require_once __DIR__ . '/_project_api.php';
if (!isset($GLOBALS['userDir']) || !is_string($GLOBALS['userDir']) || $GLOBALS['userDir'] === '') {
    $GLOBALS['userDir'] = storageDir('users');
}
require_once __DIR__ . '/_organizations.php';
require_once __DIR__ . '/_users.php';
require_once __DIR__ . '/_crm_settings.php';
require_once __DIR__ . '/_call_scripts.php';

if (defined('FIRSTMATE_DATA_AGENT_LOADED')) {
    return;
}
define('FIRSTMATE_DATA_AGENT_LOADED', true);

function dataAgentStorageDir() {
    $dir = storageDir('meta') . 'data_agent/';
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return $dir;
}

function dataAgentConversationsDir() {
    $dir = dataAgentStorageDir() . 'conversations/';
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return $dir;
}

function dataAgentRunsDir() {
    $dir = dataAgentStorageDir() . 'runs/';
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return $dir;
}

function dataAgentSettingsPath() {
    return dataAgentStorageDir() . 'settings.json';
}

function dataAgentJsonResponse($payload, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function dataAgentJsonResponseThenRun($payload, $runId, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    if (function_exists('session_write_close')) @session_write_close();
    if (function_exists('fastcgi_finish_request')) {
        @fastcgi_finish_request();
        @set_time_limit(240);
        dataAgentRunBackgroundJob($runId);
        exit;
    }
    @ob_flush();
    @flush();
    exit;
}

function dataAgentNowIso() {
    return (new DateTimeImmutable('now', new DateTimeZone(dataAgentTimezone())))->format(DateTimeInterface::ATOM);
}

function dataAgentTimezone() {
    $tz = trim((string)getenv('DATA_AGENT_TIMEZONE'));
    if ($tz !== '') {
        try {
            new DateTimeZone($tz);
            return $tz;
        } catch (Throwable $e) {}
    }
    return 'America/Los_Angeles';
}

function dataAgentTechnicianTimezone() {
    return 'Asia/Manila';
}

function dataAgentCanUse($userData = null, $perms = null) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($email === '') return false;
    if (!is_array($userData)) $userData = dataAgentReadUserByEmailRaw($email);
    if (!is_array($userData)) return false;
    if (($userData['account_type'] ?? '') === 'customer') return false;
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    if (!is_array($perms)) $perms = $userData['permissions'] ?? [];
    return $role === 'admin' || !empty($userData['is_admin']) || !empty($perms['is_admin_legacy']);
}

function dataAgentReadUserByEmailRaw($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return null;
    $file = storageDir('users') . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', $email) . '.json';
    $data = dataAgentReadJsonFile($file, null);
    if (!is_array($data)) return null;
    $data['email'] = strtolower(trim((string)($data['email'] ?? $email)));
    return $data;
}

function dataAgentRequireAllowed() {
    if (!dataAgentCanUse()) {
        dataAgentJsonResponse(['success' => false, 'error' => 'Not authorized for the data agent.'], 403);
    }
}

function dataAgentSafeSessionId($id) {
    $id = strtolower(trim((string)$id));
    return preg_match('/^[a-f0-9]{24,64}$/', $id) ? $id : '';
}

function dataAgentNewId($bytes = 16) {
    try {
        return bin2hex(random_bytes($bytes));
    } catch (Throwable $e) {
        return md5(uniqid('', true) . mt_rand());
    }
}

function dataAgentConversationPath($id) {
    $id = dataAgentSafeSessionId($id);
    if ($id === '') return null;
    return dataAgentConversationsDir() . $id . '.json';
}

function dataAgentRunPath($id) {
    $id = dataAgentSafeSessionId($id);
    if ($id === '') return null;
    return dataAgentRunsDir() . $id . '.json';
}

function dataAgentReadJsonFile($path, $fallback = null) {
    if (!is_file($path)) return $fallback;
    $raw = @file_get_contents($path);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : $fallback;
}

function dataAgentWriteJsonFile($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    $tmp = $path . '.tmp_' . dataAgentNewId(4);
    $ok = @file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    if ($ok === false) return false;
    return @rename($tmp, $path);
}

function dataAgentLoadConversation($id) {
    $path = dataAgentConversationPath($id);
    if (!$path) return null;
    return dataAgentReadJsonFile($path, null);
}

function dataAgentSaveConversation($session) {
    if (!is_array($session) || empty($session['id'])) return false;
    $path = dataAgentConversationPath($session['id']);
    if (!$path) return false;
    $session['updated_at'] = dataAgentNowIso();
    return dataAgentWriteJsonFile($path, $session);
}

function dataAgentCreateConversation($title = '', $persist = true) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $session = [
        'id' => dataAgentNewId(16),
        'title' => trim((string)$title) !== '' ? trim((string)$title) : 'New data chat',
        'created_at' => dataAgentNowIso(),
        'updated_at' => dataAgentNowIso(),
        'created_by_email' => $email,
        'created_by_name' => (string)($_SESSION['user_name'] ?? ''),
        'messages' => [],
    ];
    if ($persist) dataAgentSaveConversation($session);
    return $session;
}

function dataAgentCurrentUserIsAdmin() {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $u = dataAgentReadUserByEmailRaw($email);
    if (!is_array($u)) return false;
    return strtolower(trim((string)($u['role'] ?? ''))) === 'admin' || !empty($u['is_admin']);
}

function dataAgentConversationBelongsToCurrentUser($session) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    return $email !== '' && strtolower(trim((string)($session['created_by_email'] ?? ''))) === $email;
}

function dataAgentCanAccessConversation($session) {
    return is_array($session) && (dataAgentConversationBelongsToCurrentUser($session) || dataAgentCurrentUserIsAdmin());
}

function dataAgentDeleteConversation($id) {
    $path = dataAgentConversationPath($id);
    if (!$path || !is_file($path)) return false;
    return @unlink($path);
}

function dataAgentLoadRun($id) {
    $path = dataAgentRunPath($id);
    if (!$path) return null;
    return dataAgentReadJsonFile($path, null);
}

function dataAgentSaveRun($run) {
    if (!is_array($run) || empty($run['id'])) return false;
    $path = dataAgentRunPath($run['id']);
    if (!$path) return false;
    $run['updated_at'] = dataAgentNowIso();
    return dataAgentWriteJsonFile($path, $run);
}

function dataAgentRunBelongsToCurrentUser($run) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    return $email !== '' && strtolower(trim((string)($run['created_by_email'] ?? ''))) === $email;
}

function dataAgentCanAccessRun($run) {
    return is_array($run) && (dataAgentRunBelongsToCurrentUser($run) || dataAgentCurrentUserIsAdmin());
}

function dataAgentRunIsStale($run) {
    if (!is_array($run)) return false;
    if (!in_array((string)($run['status'] ?? ''), ['queued','running'], true)) return false;
    $stamp = (string)($run['updated_at'] ?? $run['created_at'] ?? '');
    if ($stamp === '') return false;
    try {
        $updated = new DateTimeImmutable($stamp);
        return $updated < (new DateTimeImmutable('now'))->modify('-45 minutes');
    } catch (Throwable $e) {
        return false;
    }
}

function dataAgentMarkRunStaleIfNeeded($run) {
    if (!dataAgentRunIsStale($run)) return $run;
    $run['status'] = 'error';
    $run['error'] = 'This run stopped updating and was marked stale.';
    $run['completed_at'] = dataAgentNowIso();
    dataAgentSaveRun($run);
    dataAgentAppendRunEvent((string)$run['id'], 'error', ['message' => $run['error']]);
    return dataAgentLoadRun((string)$run['id']) ?: $run;
}

function dataAgentKickRunIfNeeded($run) {
    if (!is_array($run)) return $run;
    $status = (string)($run['status'] ?? '');
    if (!in_array($status, ['queued','running'], true)) return $run;
    $stamp = (string)($run['updated_at'] ?? $run['created_at'] ?? '');
    try {
        $updated = $stamp !== '' ? new DateTimeImmutable($stamp) : new DateTimeImmutable('@0');
        $threshold = $status === 'queued' ? '-20 seconds' : '-3 minutes';
        if ($updated > (new DateTimeImmutable('now'))->modify($threshold)) return $run;
    } catch (Throwable $e) {
    }
    dataAgentAppendRunEvent((string)$run['id'], 'status', ['message' => 'Re-kicking the Data Agent worker.']);
    if (function_exists('fastcgi_finish_request')) return dataAgentLoadRun((string)$run['id']) ?: $run;
    if (!dataAgentSpawnRunWorker((string)$run['id'])) {
        $run = dataAgentLoadRun((string)$run['id']) ?: $run;
        $run['status'] = 'error';
        $run['error'] = 'Could not start the Data Agent worker. Make sure PHP CLI is available and exec/popen is not disabled.';
        dataAgentSaveRun($run);
        dataAgentAppendRunEvent((string)$run['id'], 'error', ['message' => $run['error']]);
    }
    return dataAgentLoadRun((string)$run['id']) ?: $run;
}

function dataAgentAppendRunEvent($runId, $event, $payload = []) {
    $run = dataAgentLoadRun($runId);
    if (!is_array($run)) return false;
    $events = is_array($run['events'] ?? null) ? $run['events'] : [];
    $seq = (int)($run['last_event_seq'] ?? count($events)) + 1;
    $events[] = [
        'seq' => $seq,
        'event' => (string)$event,
        'data' => is_array($payload) ? $payload : ['value' => $payload],
        'created_at' => dataAgentNowIso(),
    ];
    if (count($events) > 500) $events = array_slice($events, -500);
    $run['events'] = $events;
    $run['last_event_seq'] = $seq;
    return dataAgentSaveRun($run);
}

function dataAgentLatestActiveRunForSession($sessionId) {
    $sessionId = dataAgentSafeSessionId($sessionId);
    if ($sessionId === '') return null;
    $latest = null;
    foreach (glob(dataAgentRunsDir() . '*.json') ?: [] as $path) {
        $run = dataAgentReadJsonFile($path, null);
        if (!is_array($run)) continue;
        $run = dataAgentMarkRunStaleIfNeeded($run);
        if (($run['session_id'] ?? '') !== $sessionId) continue;
        if (!in_array((string)($run['status'] ?? ''), ['queued','running'], true)) continue;
        if (!dataAgentCanAccessRun($run)) continue;
        if (!$latest || strcmp((string)($run['updated_at'] ?? ''), (string)($latest['updated_at'] ?? '')) > 0) $latest = $run;
    }
    return $latest ? [
        'id' => (string)$latest['id'],
        'session_id' => (string)$latest['session_id'],
        'status' => (string)$latest['status'],
        'last_event_seq' => (int)($latest['last_event_seq'] ?? 0),
        'updated_at' => (string)($latest['updated_at'] ?? ''),
    ] : null;
}

function dataAgentDefaultSettings() {
    return [
        'system_prompt' => '',
        'custom_context' => '',
        'updated_at' => '',
        'updated_by_email' => '',
        'updated_by_name' => '',
    ];
}

function dataAgentLoadSettings() {
    $settings = dataAgentReadJsonFile(dataAgentSettingsPath(), []);
    if (!is_array($settings)) $settings = [];
    $settings = array_merge(dataAgentDefaultSettings(), $settings);
    if (trim((string)$settings['system_prompt']) === '') {
        $base = dataAgentCoreSystemInstructions();
        $custom = trim((string)($settings['custom_context'] ?? ''));
        $settings['system_prompt'] = $custom !== '' ? $base . "\n\nAdditional FirstMeasure context:\n" . $custom : $base;
    }
    return $settings;
}

function dataAgentSaveSettings($settings) {
    $current = dataAgentLoadSettings();
    $prompt = trim((string)($settings['system_prompt'] ?? ''));
    if ($prompt === '') $prompt = dataAgentCoreSystemInstructions();
    if (mb_strlen($prompt) > 30000) $prompt = mb_substr($prompt, 0, 30000);
    $next = array_merge($current, [
        'system_prompt' => $prompt,
        'custom_context' => '',
        'updated_at' => dataAgentNowIso(),
        'updated_by_email' => strtolower(trim((string)($_SESSION['user_email'] ?? ''))),
        'updated_by_name' => (string)($_SESSION['user_name'] ?? ''),
    ]);
    dataAgentWriteJsonFile(dataAgentSettingsPath(), $next);
    return $next;
}

function dataAgentListConversations() {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $isAdmin = dataAgentCurrentUserIsAdmin();
    $rows = [];
    foreach (glob(dataAgentConversationsDir() . '*.json') ?: [] as $path) {
        $s = dataAgentReadJsonFile($path, null);
        if (!is_array($s)) continue;
        $messages = is_array($s['messages'] ?? null) ? $s['messages'] : [];
        if (count($messages) === 0) {
            @unlink($path);
            continue;
        }
        if (!$isAdmin && strtolower(trim((string)($s['created_by_email'] ?? ''))) !== $email) continue;
        $last = end($messages);
        $rows[] = [
            'id' => (string)($s['id'] ?? basename($path, '.json')),
            'title' => (string)($s['title'] ?? 'Data chat'),
            'updated_at' => (string)($s['updated_at'] ?? ''),
            'created_at' => (string)($s['created_at'] ?? ''),
            'created_by_email' => (string)($s['created_by_email'] ?? ''),
            'created_by_name' => (string)($s['created_by_name'] ?? ''),
            'message_count' => count($messages),
            'last_preview' => is_array($last) ? mb_substr(trim((string)($last['content'] ?? '')), 0, 160) : '',
        ];
    }
    usort($rows, function ($a, $b) {
        return strcmp((string)$b['updated_at'], (string)$a['updated_at']);
    });
    return $rows;
}

function dataAgentDbMap() {
    return [
        'projects' => dirname(__DIR__, 2) . '/v1/storage/firstmeasure/projects_index.sqlite',
        'leads' => __DIR__ . '/storage/databases/leads.sqlite',
        'commissions' => __DIR__ . '/storage/databases/commissions.sqlite',
        'referrals' => __DIR__ . '/storage/databases/referrals.sqlite',
        'legacy_projects' => __DIR__ . '/storage/databases/pj_idx.sqlite',
    ];
}

function dataAgentOpenDb($name) {
    $map = dataAgentDbMap();
    $name = strtolower(trim((string)$name));
    if (!isset($map[$name]) || !is_file($map[$name])) {
        throw new RuntimeException('Unknown or missing database: ' . $name);
    }
    if (!class_exists('SQLite3')) {
        throw new RuntimeException('SQLite3 is not available in PHP.');
    }
    $db = new SQLite3($map[$name], SQLITE3_OPEN_READONLY);
    @$db->exec('PRAGMA query_only = ON');
    @$db->busyTimeout(2500);
    return $db;
}

function dataAgentSqlValue($v) {
    if ($v === null) return null;
    if (is_bool($v)) return $v ? 1 : 0;
    if (is_int($v) || is_float($v) || is_string($v)) return $v;
    return json_encode($v, JSON_UNESCAPED_SLASHES);
}

function dataAgentRows(SQLite3Result $res, $limit = 500) {
    $rows = [];
    $limit = max(1, min(1000, (int)$limit));
    while (($row = $res->fetchArray(SQLITE3_ASSOC)) !== false) {
        $clean = [];
        foreach ($row as $k => $v) $clean[$k] = $v;
        $rows[] = $clean;
        if (count($rows) >= $limit) break;
    }
    return $rows;
}

function dataAgentDatabaseSchema($database = '') {
    $map = dataAgentDbMap();
    $out = [];
    foreach ($map as $name => $path) {
        if ($database !== '' && $database !== $name) continue;
        if (!is_file($path)) {
            $out[$name] = ['path' => $path, 'exists' => false, 'tables' => []];
            continue;
        }
        $db = dataAgentOpenDb($name);
        $tables = [];
        $rs = $db->query("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
        while ($r = $rs->fetchArray(SQLITE3_ASSOC)) {
            $safe = str_replace("'", "''", (string)$r['name']);
            $cols = [];
            $cr = $db->query("PRAGMA table_info('" . $safe . "')");
            while ($c = $cr->fetchArray(SQLITE3_ASSOC)) {
                $cols[] = [
                    'name' => (string)$c['name'],
                    'type' => (string)$c['type'],
                    'notnull' => (int)$c['notnull'],
                    'pk' => (int)$c['pk'],
                ];
            }
            $count = null;
            try {
                $count = (int)$db->querySingle('SELECT COUNT(*) FROM "' . str_replace('"', '""', (string)$r['name']) . '"');
            } catch (Throwable $e) {}
            $tables[] = ['name' => (string)$r['name'], 'type' => (string)$r['type'], 'row_count' => $count, 'columns' => $cols];
        }
        $out[$name] = ['path' => $path, 'exists' => true, 'tables' => $tables];
    }
    return $out;
}

function dataAgentRunReadonlySql($args) {
    $database = strtolower(trim((string)($args['database'] ?? 'projects')));
    $sql = trim((string)($args['sql'] ?? ''));
    $limit = max(1, min(500, (int)($args['limit'] ?? 200)));
    if ($sql === '') throw new RuntimeException('SQL is required.');
    if (substr_count($sql, ';') > 0) throw new RuntimeException('Only one read-only statement is allowed; omit semicolons.');
    if (!preg_match('/^\s*(select|with)\b/i', $sql)) {
        throw new RuntimeException('Only SELECT or WITH queries are allowed. Use inspect_database_schema for PRAGMA/table details.');
    }
    $blocked = '/\b(insert|update|delete|replace|drop|alter|create|attach|detach|vacuum|reindex|pragma|truncate)\b/i';
    if (preg_match($blocked, $sql)) throw new RuntimeException('This query contains a disallowed write or database-control keyword.');
    if (!preg_match('/\blimit\s+\d+/i', $sql)) $sql .= ' LIMIT ' . $limit;

    $db = dataAgentOpenDb($database);
    $stmt = $db->prepare($sql);
    if (!$stmt) throw new RuntimeException('Could not prepare SQL: ' . $db->lastErrorMsg());
    $params = $args['params'] ?? [];
    if (is_array($params)) {
        foreach ($params as $key => $value) {
            $bindKey = is_int($key) ? $key + 1 : (strpos((string)$key, ':') === 0 ? (string)$key : ':' . (string)$key);
            $v = dataAgentSqlValue($value);
            $type = is_int($v) ? SQLITE3_INTEGER : (is_float($v) ? SQLITE3_FLOAT : ($v === null ? SQLITE3_NULL : SQLITE3_TEXT));
            $stmt->bindValue($bindKey, $v, $type);
        }
    }
    $started = microtime(true);
    $res = $stmt->execute();
    if (!$res) throw new RuntimeException('SQL execution failed: ' . $db->lastErrorMsg());
    $rows = dataAgentRows($res, $limit);
    return [
        'database' => $database,
        'sql' => $sql,
        'row_count' => count($rows),
        'limit' => $limit,
        'duration_ms' => (int)round((microtime(true) - $started) * 1000),
        'polled_at' => dataAgentNowIso(),
        'rows' => $rows,
    ];
}

function dataAgentProjectFilterSql($filters, &$params) {
    $where = ['1=1'];
    $filters = is_array($filters) ? $filters : [];
    foreach (['status', 'project_type', 'team_id', 'organization_id', 'owner_email', 'assigned_to_email', 'qa_claimed_by_email'] as $field) {
        if (!isset($filters[$field]) || $filters[$field] === '') continue;
        $value = $filters[$field];
        if (is_array($value)) {
            $keys = [];
            foreach (array_values($value) as $i => $v) {
                $k = ':' . $field . $i;
                $params[$k] = $v;
                $keys[] = $k;
            }
            if ($keys) $where[] = $field . ' IN (' . implode(',', $keys) . ')';
        } else {
            $k = ':' . $field;
            $params[$k] = $value;
            $where[] = $field . ' = ' . $k;
        }
    }
    if (!empty($filters['technician'])) {
        $params[':technician'] = '%' . strtolower(trim((string)$filters['technician'])) . '%';
        $where[] = '(lower(assigned_to_name) LIKE :technician OR lower(assigned_to_email) LIKE :technician OR lower(qa_claimed_by_name) LIKE :technician OR lower(qa_claimed_by_email) LIKE :technician)';
    }
    if (!empty($filters['search'])) {
        $params[':search'] = '%' . strtolower(trim((string)$filters['search'])) . '%';
        $where[] = 'lower(search_text) LIKE :search';
    }
    $dateField = (string)($filters['date_field'] ?? 'completed_at_ms');
    $allowedDate = ['created_at_ms','queued_at_ms','started_at_ms','uploaded_at_ms','completed_at_ms','rejected_at_ms','cancelled_at_ms','updated_at_ms'];
    if (!in_array($dateField, $allowedDate, true)) $dateField = 'completed_at_ms';
    foreach (['start' => '>=', 'end' => '<='] as $key => $op) {
        if (empty($filters[$key])) continue;
        $ts = strtotime((string)$filters[$key]);
        if ($ts !== false) {
            $pk = ':' . $key . '_ms';
            $params[$pk] = $ts * 1000;
            $where[] = $dateField . ' ' . $op . ' ' . $pk;
        }
    }
    if (array_key_exists('is_filler', $filters)) {
        $params[':is_filler'] = !empty($filters['is_filler']) ? 1 : 0;
        $where[] = 'is_filler = :is_filler';
    }
    if (array_key_exists('is_vip', $filters)) {
        $params[':is_vip'] = !empty($filters['is_vip']) ? 1 : 0;
        $where[] = 'is_vip = :is_vip';
    }
    if (array_key_exists('is_expedited', $filters)) {
        $params[':is_expedited'] = !empty($filters['is_expedited']) ? 1 : 0;
        $where[] = 'is_expedited = :is_expedited';
    }
    return implode(' AND ', $where);
}

function dataAgentSearchProjects($args) {
    $params = [];
    $where = dataAgentProjectFilterSql($args['filters'] ?? $args, $params);
    $limit = max(1, min(200, (int)($args['limit'] ?? 50)));
    $sql = "SELECT id,status,project_type,address,owner_name,owner_email,issuer_name,issuer_email,organization_id,team_id,assigned_to_name,assigned_to_email,qa_claimed_by_name,qa_claimed_by_email,complexity,amount_charged,is_filler,is_vip,is_expedited,created_at,queued_at,started_at,uploaded_at,completed_at,updated_at,has_report_pdf,has_summary_pdf FROM projects WHERE $where ORDER BY sort_ts DESC, updated_at_ms DESC LIMIT :limit";
    $params[':limit'] = $limit;
    return dataAgentRunReadonlySql(['database' => 'projects', 'sql' => $sql, 'params' => $params, 'limit' => $limit]);
}

function dataAgentProjectStats($args) {
    $filters = $args['filters'] ?? [];
    $params = [];
    $where = dataAgentProjectFilterSql($filters, $params);
    $groupMap = [
        'status' => 'status',
        'project_type' => 'project_type',
        'technician' => "COALESCE(NULLIF(assigned_to_name,''), NULLIF(assigned_to_email,''), 'Unassigned')",
        'qa_technician' => "COALESCE(NULLIF(qa_claimed_by_name,''), NULLIF(qa_claimed_by_email,''), 'Unclaimed')",
        'owner_email' => 'owner_email',
        'team_id' => 'team_id',
        'organization_id' => 'organization_id',
        'day_completed' => "substr(completed_at,1,10)",
        'day_created' => "substr(created_at,1,10)",
        'complexity' => "COALESCE(NULLIF(complexity,''), 'unknown')",
    ];
    $groups = $args['group_by'] ?? ['project_type'];
    if (!is_array($groups)) $groups = [$groups];
    $selects = [];
    $groupSql = [];
    foreach (array_slice($groups, 0, 3) as $i => $g) {
        $g = (string)$g;
        if (!isset($groupMap[$g])) continue;
        $alias = 'group_' . ($i + 1);
        $selects[] = $groupMap[$g] . ' AS ' . $alias;
        $groupSql[] = $alias;
    }
    if (!$selects) {
        $selects[] = "'all' AS group_1";
        $groupSql[] = 'group_1';
    }
    $sql = 'SELECT ' . implode(', ', $selects)
        . ', COUNT(*) AS report_count'
        . ", SUM(CASE WHEN project_type = 'commercial' THEN 1 ELSE 0 END) AS commercial_count"
        . ", SUM(CASE WHEN project_type = 'multifamily' THEN 1 ELSE 0 END) AS multifamily_count"
        . ", SUM(CASE WHEN project_type = 'residential' THEN 1 ELSE 0 END) AS residential_count"
        . ', ROUND(AVG(amount_charged), 2) AS avg_amount_charged'
        . ', ROUND(SUM(amount_charged), 2) AS total_amount_charged'
        . ' FROM projects WHERE ' . $where
        . ' GROUP BY ' . implode(', ', $groupSql)
        . ' ORDER BY report_count DESC LIMIT 200';
    $result = dataAgentRunReadonlySql(['database' => 'projects', 'sql' => $sql, 'params' => $params, 'limit' => 200]);
    $total = 0;
    foreach ($result['rows'] as $row) $total += (int)($row['report_count'] ?? 0);
    foreach ($result['rows'] as &$row) {
        $row['share_pct'] = $total > 0 ? round(((int)$row['report_count'] / $total) * 100, 2) : 0;
        $row['commercial_share_pct'] = (int)$row['report_count'] > 0 ? round(((int)$row['commercial_count'] / (int)$row['report_count']) * 100, 2) : 0;
    }
    unset($row);
    $result['total_count'] = $total;
    return $result;
}

function dataAgentProjectDetail($args) {
    $id = trim((string)($args['project_id'] ?? $args['id'] ?? ''));
    if ($id === '') throw new RuntimeException('project_id is required.');
    $row = dataAgentRunReadonlySql([
        'database' => 'projects',
        'sql' => 'SELECT * FROM projects WHERE id = :id LIMIT 1',
        'params' => [':id' => $id],
        'limit' => 1,
    ]);
    $project = $row['rows'][0] ?? null;
    if (!$project) return ['project' => null, 'polled_at' => dataAgentNowIso()];
    $manifest = json_decode((string)($project['manifest_json'] ?? '{}'), true);
    unset($project['manifest_json']);
    return [
        'project' => $project,
        'manifest' => !empty($args['include_manifest']) && is_array($manifest) ? $manifest : null,
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentSafeUser($u) {
    $u = is_array($u) ? $u : [];
    unset($u['password_hash'], $u['otp'], $u['reset_token'], $u['tokens']);
    return [
        'id' => $u['id'] ?? '',
        'email' => strtolower(trim((string)($u['email'] ?? ''))),
        'name' => (string)($u['name'] ?? ''),
        'role' => (string)($u['role'] ?? ''),
        'department' => (string)($u['department'] ?? ''),
        'team_id' => (string)($u['team_id'] ?? ''),
        'account_type' => (string)($u['account_type'] ?? ''),
        'organization_id' => (string)($u['organization_id'] ?? ''),
        'training_complete' => !empty($u['training_complete']),
        'queue_mode' => (string)($u['queue_mode'] ?? ''),
        'shift_rate' => $u['shift_rate'] ?? null,
        'last_activity_at' => $u['last_activity_at'] ?? null,
        'permissions' => $u['permissions'] ?? [],
    ];
}

function dataAgentSearchUsers($args) {
    $q = strtolower(trim((string)($args['query'] ?? '')));
    $role = strtolower(trim((string)($args['role'] ?? '')));
    $department = strtolower(trim((string)($args['department'] ?? '')));
    $team = strtolower(trim((string)($args['team_id'] ?? '')));
    $limit = max(1, min(200, (int)($args['limit'] ?? 50)));
    $rows = [];
    foreach (glob(storageDir('users') . '*.json') ?: [] as $path) {
        $u = dataAgentReadJsonFile($path, null);
        if (!is_array($u)) continue;
        $safe = dataAgentSafeUser($u);
        $hay = strtolower(implode(' ', [$safe['email'], $safe['name'], $safe['role'], $safe['department'], $safe['team_id']]));
        if ($q !== '' && strpos($hay, $q) === false) continue;
        if ($role !== '' && strtolower($safe['role']) !== $role) continue;
        if ($department !== '' && strtolower($safe['department']) !== $department) continue;
        if ($team !== '' && strtolower($safe['team_id']) !== $team) continue;
        $rows[] = $safe;
        if (count($rows) >= $limit) break;
    }
    return ['row_count' => count($rows), 'rows' => $rows, 'polled_at' => dataAgentNowIso()];
}

function dataAgentGetUserProfile($args) {
    $email = strtolower(trim((string)($args['email'] ?? '')));
    if ($email === '') throw new RuntimeException('email is required.');
    $u = dataAgentReadUserByEmailRaw($email);
    return ['user' => $u ? dataAgentSafeUser($u) : null, 'polled_at' => dataAgentNowIso()];
}

function dataAgentShiftBlockWithZones($block, $date, $sourceTz = null) {
    $block = is_array($block) ? $block : [];
    $sourceTz = $sourceTz ?: dataAgentTechnicianTimezone();
    $start = trim((string)($block['start'] ?? ''));
    $end = trim((string)($block['end'] ?? ''));
    if (!preg_match('/^\d{2}:\d{2}$/', $start) || !preg_match('/^\d{2}:\d{2}$/', $end)) return null;
    $tz = new DateTimeZone($sourceTz);
    $userTz = new DateTimeZone(dataAgentTimezone());
    $startDt = new DateTimeImmutable($date . ' ' . $start, $tz);
    $endDt = new DateTimeImmutable($date . ' ' . $end, $tz);
    if ($end <= $start) $endDt = $endDt->modify('+1 day');
    return [
        'role' => strtolower(trim((string)($block['role'] ?? 'technician'))),
        'philippines' => [
            'timezone' => $sourceTz,
            'start' => $startDt->format(DateTimeInterface::ATOM),
            'end' => $endDt->format(DateTimeInterface::ATOM),
            'label' => $startDt->format('M j, Y g:i A') . ' - ' . $endDt->format('g:i A') . ' PHT',
        ],
        'pacific' => [
            'timezone' => dataAgentTimezone(),
            'start' => $startDt->setTimezone($userTz)->format(DateTimeInterface::ATOM),
            'end' => $endDt->setTimezone($userTz)->format(DateTimeInterface::ATOM),
            'label' => $startDt->setTimezone($userTz)->format('M j, Y g:i A') . ' - ' . $endDt->setTimezone($userTz)->format('g:i A T'),
        ],
    ];
}

function dataAgentResolvedShiftBlocks($schedule, $date) {
    $schedule = is_array($schedule) ? $schedule : [];
    $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$date) ? (string)$date : (new DateTimeImmutable('now', new DateTimeZone(dataAgentTechnicianTimezone())))->format('Y-m-d');
    $dayName = strtolower((new DateTimeImmutable($date, new DateTimeZone(dataAgentTechnicianTimezone())))->format('l'));
    $rawBlocks = [];
    $source = 'recurring';
    $overrides = is_array($schedule['overrides'] ?? null) ? $schedule['overrides'] : [];
    if (array_key_exists($date, $overrides)) {
        $source = 'override';
        $rawBlocks = is_array($overrides[$date]) ? $overrides[$date] : [];
    } else {
        $recurring = is_array($schedule['recurring'] ?? null) ? $schedule['recurring'] : [];
        $rawBlocks = is_array($recurring[$dayName] ?? null) ? $recurring[$dayName] : [];
    }
    $blocks = [];
    foreach ($rawBlocks as $block) {
        $normalized = dataAgentShiftBlockWithZones($block, $date);
        if ($normalized) $blocks[] = $normalized;
    }
    return ['date' => $date, 'day' => $dayName, 'source' => $source, 'blocks' => $blocks];
}

function dataAgentShiftSnapshot($args) {
    $query = strtolower(trim((string)($args['query'] ?? '')));
    $role = strtolower(trim((string)($args['role'] ?? '')));
    $department = strtolower(trim((string)($args['department'] ?? '')));
    $team = strtolower(trim((string)($args['team_id'] ?? '')));
    $date = trim((string)($args['date'] ?? ''));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        $date = (new DateTimeImmutable('now', new DateTimeZone(dataAgentTechnicianTimezone())))->format('Y-m-d');
    }
    $limit = max(1, min(250, (int)($args['limit'] ?? 100)));
    $nowPht = new DateTimeImmutable('now', new DateTimeZone(dataAgentTechnicianTimezone()));
    $nowPacific = $nowPht->setTimezone(new DateTimeZone(dataAgentTimezone()));
    $rows = [];
    foreach (glob(storageDir('users') . '*.json') ?: [] as $path) {
        $u = dataAgentReadJsonFile($path, null);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) === 'customer') continue;
        if (!empty($u['disabled']) || !empty($u['deleted'])) continue;
        $safe = dataAgentSafeUser($u);
        $hay = strtolower(implode(' ', [$safe['email'], $safe['name'], $safe['role'], $safe['department'], $safe['team_id']]));
        if ($query !== '' && strpos($hay, $query) === false) continue;
        if ($role !== '' && strtolower($safe['role']) !== $role) continue;
        if ($department !== '' && strtolower($safe['department']) !== $department) continue;
        if ($team !== '' && strtolower($safe['team_id']) !== $team) continue;
        $schedule = is_array($u['shift_schedule'] ?? null) ? $u['shift_schedule'] : ['recurring' => [], 'overrides' => []];
        $resolved = dataAgentResolvedShiftBlocks($schedule, $date);
        $active = [];
        foreach ($resolved['blocks'] as $block) {
            $start = new DateTimeImmutable($block['philippines']['start']);
            $end = new DateTimeImmutable($block['philippines']['end']);
            if ($nowPht >= $start && $nowPht < $end) $active[] = $block;
        }
        if (!empty($args['on_shift_only']) && !$active) continue;
        $rows[] = [
            'user' => $safe,
            'date' => $date,
            'schedule_updated_at' => $schedule['updated_at'] ?? null,
            'schedule_updated_by' => $schedule['updated_by'] ?? null,
            'resolved_source' => $resolved['source'],
            'resolved_day' => $resolved['day'],
            'blocks' => $resolved['blocks'],
            'on_shift_now' => count($active) > 0,
            'active_blocks' => $active,
        ];
        if (count($rows) >= $limit) break;
    }
    return [
        'row_count' => count($rows),
        'date_interpreted_as_philippines_date' => $date,
        'technician_timezone' => dataAgentTechnicianTimezone(),
        'company_user_timezone' => dataAgentTimezone(),
        'now_philippines' => $nowPht->format(DateTimeInterface::ATOM),
        'now_pacific' => $nowPacific->format(DateTimeInterface::ATOM),
        'rows' => $rows,
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentOrgSummary($org, $id = '') {
    $org = is_array($org) ? $org : [];
    $ledger = is_array($org['credits_ledger'] ?? null) ? $org['credits_ledger'] : [];
    $spent = 0;
    $added = 0;
    $orderSubmitted = 0;
    $firstOrderAt = null;
    $lastOrderAt = null;
    foreach ($ledger as $entry) {
        $delta = (int)($entry['delta'] ?? 0);
        if ($delta < 0) $spent += abs($delta);
        if ($delta > 0) $added += $delta;
        if ((string)($entry['reason'] ?? '') === 'order_submitted') {
            $orderSubmitted++;
            $ts = (string)($entry['ts'] ?? '');
            if ($ts !== '') {
                if ($firstOrderAt === null || strcmp($ts, $firstOrderAt) < 0) $firstOrderAt = $ts;
                if ($lastOrderAt === null || strcmp($ts, $lastOrderAt) > 0) $lastOrderAt = $ts;
            }
        }
    }
    return [
        'id' => (string)($org['id'] ?? $id),
        'name' => (string)($org['name'] ?? ''),
        'created_at' => $org['created_at'] ?? null,
        'created_by_email' => $org['created_by_email'] ?? null,
        'created_by_name' => $org['created_by_name'] ?? null,
        'credits_balance' => $org['credits_balance'] ?? null,
        'credits_added_total' => $added,
        'credits_spent_total' => $spent,
        'ledger_count' => count($ledger),
        'ledger_order_submitted_count' => $orderSubmitted,
        'first_order_at' => $firstOrderAt,
        'last_order_at' => $lastOrderAt,
        'assigned_sales_email' => $org['assigned_sales_email'] ?? '',
        'assigned_sales_name' => $org['assigned_sales_name'] ?? '',
        'paired_lead_ids' => $org['paired_lead_ids'] ?? [],
        'contact' => $org['contact'] ?? [],
        'report_settings' => $org['report_settings'] ?? [],
        'is_test' => !empty($org['is_test']),
    ];
}

function dataAgentLocalDateRangeUtcMs($date, $timezone = '') {
    $timezone = trim((string)$timezone) ?: dataAgentTimezone();
    try { $tz = new DateTimeZone($timezone); } catch (Throwable $e) { $tz = new DateTimeZone(dataAgentTimezone()); }
    $date = trim((string)$date);
    if ($date === '') $date = (new DateTimeImmutable('now', $tz))->format('Y-m-d');
    $start = new DateTimeImmutable($date . ' 00:00:00', $tz);
    $end = $start->modify('+1 day');
    return [$start->getTimestamp() * 1000, $end->getTimestamp() * 1000, $tz->getName(), $start->format('Y-m-d')];
}

function dataAgentOrgMatchesFilters($summary, $filters) {
    $filters = is_array($filters) ? $filters : [];
    $q = strtolower(trim((string)($filters['query'] ?? '')));
    if ($q !== '') {
        $hay = strtolower(implode(' ', [$summary['id'], $summary['name'], $summary['created_by_email'], $summary['created_by_name'], $summary['assigned_sales_email'], $summary['assigned_sales_name']]));
        if (strpos($hay, $q) === false) return false;
    }
    if (empty($filters['include_test']) && !empty($summary['is_test'])) return false;
    $createdMs = null;
    if (!empty($summary['created_at'])) {
        $ts = strtotime((string)$summary['created_at']);
        if ($ts !== false) $createdMs = $ts * 1000;
    }
    if (!empty($filters['created_on'])) {
        [$startMs, $endMs] = dataAgentLocalDateRangeUtcMs($filters['created_on'], (string)($filters['timezone'] ?? dataAgentTimezone()));
        if ($createdMs === null || $createdMs < $startMs || $createdMs >= $endMs) return false;
    }
    foreach (['created_start' => '>=', 'created_end' => '<'] as $key => $op) {
        if (empty($filters[$key])) continue;
        $ts = strtotime((string)$filters[$key]);
        if ($ts === false || $createdMs === null) continue;
        $ms = $ts * 1000;
        if ($op === '>=' && $createdMs < $ms) return false;
        if ($op === '<' && $createdMs >= $ms) return false;
    }
    return true;
}

function dataAgentProjectCountsByOrganization($orgIds) {
    $orgIds = array_values(array_filter(array_unique(array_map('strval', is_array($orgIds) ? $orgIds : []))));
    $out = [];
    foreach ($orgIds as $id) $out[$id] = ['project_count' => 0, 'completed_project_count' => 0, 'cancelled_project_count' => 0, 'rejected_project_count' => 0, 'latest_project_at' => null];
    if (!$orgIds) return $out;
    $db = dataAgentOpenDb('projects');
    foreach (array_chunk($orgIds, 80) as $chunk) {
        $params = [];
        $keys = [];
        foreach ($chunk as $i => $id) {
            $key = ':org' . $i;
            $params[$key] = $id;
            $keys[] = $key;
        }
        $sql = "SELECT organization_id,
                COUNT(*) AS project_count,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_project_count,
                SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_project_count,
                SUM(CASE WHEN status LIKE 'rejected%' THEN 1 ELSE 0 END) AS rejected_project_count,
                MAX(COALESCE(NULLIF(completed_at,''), NULLIF(updated_at,''), NULLIF(created_at,''))) AS latest_project_at
            FROM projects
            WHERE organization_id IN (" . implode(',', $keys) . ")
            GROUP BY organization_id";
        $stmt = $db->prepare($sql);
        if (!$stmt) continue;
        foreach ($params as $key => $value) $stmt->bindValue($key, $value, SQLITE3_TEXT);
        $res = $stmt->execute();
        if (!$res) continue;
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $id = (string)($row['organization_id'] ?? '');
            if ($id === '') continue;
            $out[$id] = [
                'project_count' => (int)($row['project_count'] ?? 0),
                'completed_project_count' => (int)($row['completed_project_count'] ?? 0),
                'cancelled_project_count' => (int)($row['cancelled_project_count'] ?? 0),
                'rejected_project_count' => (int)($row['rejected_project_count'] ?? 0),
                'latest_project_at' => $row['latest_project_at'] ?? null,
            ];
        }
    }
    return $out;
}

function dataAgentSearchOrganizations($args) {
    $filters = is_array($args['filters'] ?? null) ? $args['filters'] : $args;
    $limit = max(1, min(200, (int)($args['limit'] ?? 50)));
    $includeCounts = !empty($args['include_project_counts']) || !empty($filters['include_project_counts']);
    $rows = [];
    foreach (glob(storageDir('organizations') . '*/manifest.json') ?: [] as $path) {
        $org = dataAgentReadJsonFile($path, null);
        if (!is_array($org)) continue;
        $id = basename(dirname($path));
        $summary = dataAgentOrgSummary($org, $id);
        if (!dataAgentOrgMatchesFilters($summary, $filters)) continue;
        $rows[] = $summary;
        if (count($rows) >= $limit) break;
    }
    if ($includeCounts && $rows) {
        $counts = dataAgentProjectCountsByOrganization(array_column($rows, 'id'));
        foreach ($rows as &$row) $row = array_merge($row, $counts[$row['id']] ?? []);
        unset($row);
    }
    return ['row_count' => count($rows), 'rows' => $rows, 'polled_at' => dataAgentNowIso()];
}

function dataAgentOrganizationSignupStats($args) {
    $filters = is_array($args['filters'] ?? null) ? $args['filters'] : $args;
    if (empty($filters['created_on']) && empty($filters['created_start']) && empty($filters['created_end'])) {
        $filters['created_on'] = (string)($args['created_on'] ?? (new DateTimeImmutable('now', new DateTimeZone(dataAgentTimezone())))->format('Y-m-d'));
        $filters['timezone'] = (string)($filters['timezone'] ?? dataAgentTimezone());
    }
    $limit = max(1, min(500, (int)($args['limit'] ?? 200)));
    $rows = [];
    foreach (glob(storageDir('organizations') . '*/manifest.json') ?: [] as $path) {
        $org = dataAgentReadJsonFile($path, null);
        if (!is_array($org)) continue;
        $id = basename(dirname($path));
        $summary = dataAgentOrgSummary($org, $id);
        if (!dataAgentOrgMatchesFilters($summary, $filters)) continue;
        $rows[] = $summary;
    }
    usort($rows, function ($a, $b) {
        return strcmp((string)($b['created_at'] ?? ''), (string)($a['created_at'] ?? ''));
    });
    $counts = dataAgentProjectCountsByOrganization(array_column($rows, 'id'));
    $totalProjects = 0;
    $totalCompleted = 0;
    $totalLedgerOrders = 0;
    foreach ($rows as &$row) {
        $row = array_merge($row, $counts[$row['id']] ?? []);
        $totalProjects += (int)($row['project_count'] ?? 0);
        $totalCompleted += (int)($row['completed_project_count'] ?? 0);
        $totalLedgerOrders += (int)($row['ledger_order_submitted_count'] ?? 0);
    }
    unset($row);
    return [
        'filters' => $filters,
        'organization_count' => count($rows),
        'project_count_total' => $totalProjects,
        'completed_project_count_total' => $totalCompleted,
        'ledger_order_submitted_count_total' => $totalLedgerOrders,
        'rows_returned' => min(count($rows), $limit),
        'rows' => array_slice($rows, 0, $limit),
        'note' => 'project_count_total counts projects/reports in the projects SQLite index by organization_id. ledger_order_submitted_count_total counts order_submitted entries in organization credit ledgers.',
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentGetOrganization($args) {
    $id = trim((string)($args['organization_id'] ?? $args['id'] ?? ''));
    if ($id === '') throw new RuntimeException('organization_id is required.');
    $org = function_exists('orgRead') ? orgRead($id) : null;
    return ['organization' => $org ? dataAgentOrgSummary($org, $id) : null, 'polled_at' => dataAgentNowIso()];
}

function dataAgentSearchLeads($args) {
    $filters = is_array($args['filters'] ?? null) ? $args['filters'] : $args;
    $params = [];
    $where = ['1=1'];
    foreach (['status','assigned_to_email','organization_id','state','region','region_code','list_id'] as $f) {
        if (empty($filters[$f])) continue;
        $params[':' . $f] = $filters[$f];
        $where[] = $f . ' = :' . $f;
    }
    if (!empty($filters['query'])) {
        $params[':q'] = '%' . strtolower(trim((string)$filters['query'])) . '%';
        $where[] = '(lower(lead_name) LIKE :q OR lower(company) LIKE :q OR lower(email) LIKE :q OR lower(phone) LIKE :q OR lower(address) LIKE :q OR lower(city) LIKE :q)';
    }
    $limit = max(1, min(200, (int)($args['limit'] ?? 50)));
    $sql = 'SELECT id,list_id,organization_id,status,lead_name,company,email,phone,address,city,state,postal_code,website,source,assigned_to_email,created_at,updated_at FROM leads WHERE ' . implode(' AND ', $where) . ' ORDER BY updated_at DESC LIMIT :limit';
    $params[':limit'] = $limit;
    return dataAgentRunReadonlySql(['database' => 'leads', 'sql' => $sql, 'params' => $params, 'limit' => $limit]);
}

function dataAgentLeadStats($args) {
    $groupMap = [
        'status' => 'status',
        'assigned_to_email' => "COALESCE(NULLIF(assigned_to_email,''), 'Unassigned')",
        'state' => 'state',
        'region' => 'region',
        'source' => 'source',
        'organization_id' => 'organization_id',
    ];
    $group = (string)($args['group_by'] ?? 'status');
    if (!isset($groupMap[$group])) $group = 'status';
    $filters = is_array($args['filters'] ?? null) ? $args['filters'] : [];
    $params = [];
    $where = ['1=1'];
    foreach (['status','assigned_to_email','organization_id','state','region'] as $f) {
        if (empty($filters[$f])) continue;
        $params[':' . $f] = $filters[$f];
        $where[] = $f . ' = :' . $f;
    }
    $sql = 'SELECT ' . $groupMap[$group] . ' AS group_1, COUNT(*) AS lead_count FROM leads WHERE ' . implode(' AND ', $where) . ' GROUP BY group_1 ORDER BY lead_count DESC LIMIT 200';
    return dataAgentRunReadonlySql(['database' => 'leads', 'sql' => $sql, 'params' => $params, 'limit' => 200]);
}

function dataAgentFirstMeasureApi($args) {
    $method = strtoupper(trim((string)($args['method'] ?? 'GET')));
    $path = '/' . ltrim((string)($args['path'] ?? ''), '/');
    if ($path === '/') throw new RuntimeException('path is required.');
    $allowedPost = [
        '#^/projects/query$#',
        '#^/projects/list$#',
        '#^/projects/find-by-address$#',
        '#^/queue/status(?:/compat)?$#',
        '#^/queue/admin/overview(?:/compat)?$#',
    ];
    if ($method !== 'GET' && $method !== 'POST') throw new RuntimeException('Only GET and read-only POST routes are allowed.');
    if ($method === 'POST') {
        $ok = false;
        foreach ($allowedPost as $rx) if (preg_match($rx, $path)) $ok = true;
        if (!$ok) throw new RuntimeException('This POST route is not on the read-only allowlist.');
    }
    $query = is_array($args['query'] ?? null) ? $args['query'] : null;
    $body = is_array($args['body'] ?? null) ? $args['body'] : null;
    $res = fm_api_request($method, $path, ['query' => $query, 'json' => $body, 'timeout' => 30]);
    $json = $res['json'];
    $bodyText = (string)($res['body'] ?? '');
    return [
        'ok' => !empty($res['ok']),
        'status' => (int)($res['status'] ?? 0),
        'url' => $res['url'] ?? null,
        'polled_at' => dataAgentNowIso(),
        'json' => is_array($json) ? $json : null,
        'body_preview' => is_array($json) ? null : substr($bodyText, 0, 4000),
    ];
}

function dataAgentCreateTableArtifact($args) {
    $columns = is_array($args['columns'] ?? null) ? array_slice($args['columns'], 0, 20) : [];
    $rows = is_array($args['rows'] ?? null) ? array_slice($args['rows'], 0, 200) : [];
    return [
        'artifact' => [
            'id' => 'artifact_' . dataAgentNewId(6),
            'type' => 'table',
            'title' => (string)($args['title'] ?? 'Table'),
            'columns' => $columns,
            'rows' => $rows,
        ],
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentCreateChartArtifact($args) {
    $type = strtolower(trim((string)($args['chart_type'] ?? 'bar')));
    if (!in_array($type, ['bar','line','pie','doughnut'], true)) $type = 'bar';
    $labels = is_array($args['labels'] ?? null) ? array_values(array_map('strval', $args['labels'])) : [];
    $rawDatasets = [];
    if (is_array($args['datasets'] ?? null)) $rawDatasets = array_values($args['datasets']);
    elseif (is_array($args['series'] ?? null)) $rawDatasets = array_values($args['series']);
    elseif (is_array($args['data'] ?? null)) $rawDatasets = [['label' => (string)($args['label'] ?? 'Series 1'), 'data' => $args['data']]];
    elseif (is_array($args['values'] ?? null)) $rawDatasets = [['label' => (string)($args['label'] ?? 'Series 1'), 'data' => $args['values']]];

    $datasets = [];
    foreach ($rawDatasets as $idx => $dataset) {
        if (!is_array($dataset)) continue;
        $values = $dataset['data'] ?? $dataset['values'] ?? $dataset['points'] ?? [];
        if (!is_array($values)) continue;
        $data = [];
        foreach (array_values($values) as $value) {
            if (is_array($value) && array_key_exists('y', $value)) $value = $value['y'];
            $data[] = is_numeric($value) ? (float)$value : 0;
        }
        if (!$data) continue;
        $datasets[] = array_merge($dataset, [
            'label' => (string)($dataset['label'] ?? $dataset['name'] ?? ('Series ' . ($idx + 1))),
            'data' => $data,
        ]);
    }
    if (!$labels || !$datasets) {
        throw new RuntimeException('create_chart requires non-empty labels and at least one dataset with numeric data. Re-call create_chart with datasets: [{label, data:[...]}].');
    }
    return [
        'artifact' => [
            'id' => 'artifact_' . dataAgentNewId(6),
            'type' => 'chart',
            'chart_type' => $type,
            'title' => (string)($args['title'] ?? 'Chart'),
            'labels' => $labels,
            'datasets' => $datasets,
        ],
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentRedactValue($value, $key = '') {
    if (is_array($value)) {
        $out = [];
        foreach ($value as $k => $v) $out[$k] = dataAgentRedactValue($v, (string)$k);
        return $out;
    }
    if (preg_match('/(password|secret|token|api[_-]?key|access[_-]?key|refresh|authorization|oauth|stripe|postmark|gemini|google_api)/i', $key)) {
        return is_scalar($value) && (string)$value !== '' ? '[redacted]' : $value;
    }
    return $value;
}

function dataAgentAllowedJsonRoots() {
    return [
        'storage/data' => realpath(storageDir('data')) ?: storageDir('data'),
        'storage/territory' => realpath(storagePath('territory')) ?: storagePath('territory'),
        'storage/tutorials' => realpath(storageDir('tutorials')) ?: storageDir('tutorials'),
        'storage/coupons' => realpath(storageDir('coupons')) ?: storageDir('coupons'),
        'storage/meta/mock_comms' => realpath(storagePath('meta/mock_comms')) ?: storagePath('meta/mock_comms'),
    ];
}

function dataAgentSafeRelativePath($path) {
    $path = str_replace('\\', '/', trim((string)$path));
    $path = preg_replace('#/+#', '/', $path);
    $path = ltrim($path, '/');
    if ($path === '' || strpos($path, '..') !== false) return '';
    if (!preg_match('#^storage/(data|territory|tutorials|coupons|meta/mock_comms)/#', $path)) return '';
    return $path;
}

function dataAgentPortalDataCatalog($args = []) {
    $limit = max(1, min(500, (int)($args['limit'] ?? 200)));
    $rows = [];
    $base = realpath(__DIR__);
    foreach (dataAgentAllowedJsonRoots() as $label => $root) {
        if (!is_dir($root)) continue;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if (!$file->isFile()) continue;
            if (strpos($file->getFilename(), '.') === 0) continue;
            $ext = strtolower(pathinfo($file->getFilename(), PATHINFO_EXTENSION));
            if ($ext !== 'json') continue;
            $real = $file->getRealPath();
            $rel = $base && $real ? str_replace('\\', '/', substr($real, strlen($base) + 1)) : $label . '/' . $file->getFilename();
            $rows[] = [
                'path' => $rel,
                'area' => $label,
                'bytes' => $file->getSize(),
                'modified_at' => date('c', $file->getMTime()),
            ];
            if (count($rows) >= $limit) break 2;
        }
    }
    return [
        'row_count' => count($rows),
        'rows' => $rows,
        'coverage_note' => 'This catalog intentionally excludes storage/secrets, storage/config, OAuth state, live Stripe event payloads, raw Gmail mailbox stores, and arbitrary PHP source.',
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentReadPortalJsonDocument($args) {
    $rel = dataAgentSafeRelativePath($args['path'] ?? '');
    if ($rel === '') throw new RuntimeException('Path is not in an allowed read-only JSON area.');
    $path = realpath(__DIR__ . '/' . $rel);
    $base = realpath(__DIR__);
    if (!$path || !$base || strpos($path, $base) !== 0 || !is_file($path)) throw new RuntimeException('JSON document not found.');
    if (filesize($path) > 2 * 1024 * 1024) throw new RuntimeException('JSON document is too large for direct agent reading.');
    $data = dataAgentReadJsonFile($path, null);
    if (!is_array($data)) throw new RuntimeException('Document is not valid JSON object/array.');
    return [
        'path' => $rel,
        'modified_at' => date('c', filemtime($path)),
        'data' => dataAgentRedactValue($data),
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentCrmSettingsSnapshot() {
    $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    return [
        'crm_settings' => function_exists('crmSettingsPublicSnapshotForActor') ? crmSettingsPublicSnapshotForActor($actor) : null,
        'mock_comms' => function_exists('mockCommsSettingsSnapshot') ? dataAgentRedactValue(mockCommsSettingsSnapshot()) : null,
        'call_scripts' => function_exists('callScriptLoadAll') ? callScriptLoadAll() : null,
        'polled_at' => dataAgentNowIso(),
    ];
}

function dataAgentListDataSources() {
    $orgCount = count(glob(storageDir('organizations') . '*/manifest.json') ?: []);
    $userCount = count(glob(storageDir('users') . '*.json') ?: []);
    $schema = dataAgentDatabaseSchema('');
    return [
        'app' => 'FirstMeasure for FirstMate roof reports',
        'server_time' => dataAgentNowIso(),
        'timezone' => dataAgentTimezone(),
        'firstmeasure_api_base' => fm_api_base_url(),
        'sqlite_databases' => $schema,
        'json_stores' => [
            'users' => ['path' => storageDir('users'), 'count' => $userCount],
            'organizations' => ['path' => storageDir('organizations'), 'count' => $orgCount],
            'data' => ['path' => storageDir('data')],
            'shift_schedules' => ['path' => storageDir('users'), 'note' => 'Stored per user under shift_schedule; interpreted as Philippine Standard Time for technicians, QA technicians, and managers.'],
            'v1_firstmeasure_projects' => ['path' => dirname(__DIR__, 2) . '/v1/storage/firstmeasure/projects'],
        ],
        'admin_readable_json_catalog' => array_keys(dataAgentAllowedJsonRoots()),
        'not_directly_exposed' => [
            'storage/secrets',
            'storage/config and OAuth token state',
            'live Stripe event payloads',
            'raw Gmail mailbox state',
            'arbitrary PHP source code',
        ],
        'terminology' => dataAgentTerminology(),
    ];
}

function dataAgentTerminology() {
    return [
        'product' => 'FirstMeasure',
        'company_context' => 'FirstMeasure is a FirstMate product used to produce roof reports.',
        'report_types' => ['residential', 'commercial', 'multifamily'],
        'people' => [
            'main_managers' => ['Melden', 'Rashid'],
            'technicians' => 'Production users who draw/process roof reports; commonly appear in assigned_to_* and workflow work_history. They generally work in the Philippines on Philippine Standard Time.',
            'qa_technicians' => 'QA users who review reports; commonly appear in qa_claimed_by_* and workflow qa_history. They generally work in the Philippines on Philippine Standard Time.',
            'managers' => 'Managers supervise queue, QA, reviews, users, payroll, and production operations. Melden and Rashid are main managers; manager shifts are also treated as Philippines-based unless data says otherwise.',
        ],
        'timezones' => [
            'company_and_agent_users' => dataAgentTimezone(),
            'technicians_qa_managers' => dataAgentTechnicianTimezone(),
            'pht_to_pacific_note' => 'Philippine Standard Time is UTC+08 and does not observe DST. Pacific time may be PST or PDT depending on date.',
        ],
        'important_statuses' => ['queued','processing','awaiting_review','completed','rejected','rejected_no_coverage','cancelled','requeue','correction_needed'],
        'time_awareness' => 'Data changes over time. Each tool result includes polled_at; compare it with the chat time before making freshness claims.',
    ];
}

function dataAgentToolDefinitions() {
    $object = ['type' => 'object', 'additionalProperties' => false];
    return [
        [
            'type' => 'function',
            'name' => 'list_data_sources',
            'description' => 'List available read-only data sources, schemas, storage paths, counts, API base URL, and FirstMeasure terminology.',
            'parameters' => $object + ['properties' => new stdClass(), 'required' => []],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'inspect_database_schema',
            'description' => 'Inspect SQLite tables/columns/counts for one database or all databases. Databases: projects, leads, commissions, referrals, legacy_projects.',
            'parameters' => $object + ['properties' => ['database' => ['type' => 'string', 'description' => 'Optional database name or empty string for all.']], 'required' => ['database']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'run_readonly_sql',
            'description' => 'Run a read-only SELECT/WITH SQL query against an allowed SQLite database. Use bound params. Max 500 rows.',
            'parameters' => $object + ['properties' => [
                'database' => ['type' => 'string', 'enum' => ['projects','leads','commissions','referrals','legacy_projects']],
                'sql' => ['type' => 'string'],
                'params' => ['type' => 'object', 'additionalProperties' => true],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 500],
            ], 'required' => ['database','sql','params','limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'search_projects',
            'description' => 'Search FirstMeasure project/report index by status, project type, technician, owner, organization, team, text, and dates.',
            'parameters' => ['type' => 'object', 'additionalProperties' => false, 'properties' => [
                'filters' => ['type' => 'object', 'additionalProperties' => true],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 200],
            ], 'required' => ['filters','limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'project_stats',
            'description' => 'Aggregate projects/reports. Useful for percentages such as commercial share by technician, service type mix, status counts, revenue, or day trends.',
            'parameters' => ['type' => 'object', 'additionalProperties' => false, 'properties' => [
                'filters' => ['type' => 'object', 'additionalProperties' => true],
                'group_by' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Allowed: status, project_type, technician, qa_technician, owner_email, team_id, organization_id, day_completed, day_created, complexity.'],
            ], 'required' => ['filters','group_by']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'get_project_detail',
            'description' => 'Get one project/report row and optionally the underlying manifest JSON.',
            'parameters' => $object + ['properties' => [
                'project_id' => ['type' => 'string'],
                'include_manifest' => ['type' => 'boolean'],
            ], 'required' => ['project_id','include_manifest']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'search_users',
            'description' => 'Search internal users/technicians/managers from user JSON files. Password hashes and tokens are never returned.',
            'parameters' => $object + ['properties' => [
                'query' => ['type' => 'string'],
                'role' => ['type' => 'string'],
                'department' => ['type' => 'string'],
                'team_id' => ['type' => 'string'],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 200],
            ], 'required' => ['query','role','department','team_id','limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'get_user_profile',
            'description' => 'Get one sanitized internal user profile by email.',
            'parameters' => $object + ['properties' => ['email' => ['type' => 'string']], 'required' => ['email']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'get_shift_snapshot',
            'description' => 'Read employee shift schedules from user JSON files, interpreting technician, QA technician, and manager shift times as Philippine Standard Time and converting them to Pacific time.',
            'parameters' => $object + ['properties' => [
                'query' => ['type' => 'string'],
                'role' => ['type' => 'string'],
                'department' => ['type' => 'string'],
                'team_id' => ['type' => 'string'],
                'date' => ['type' => 'string', 'description' => 'YYYY-MM-DD Philippines date. Empty means today in Asia/Manila.'],
                'on_shift_only' => ['type' => 'boolean'],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 250],
            ], 'required' => ['query','role','department','team_id','date','on_shift_only','limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'search_organizations',
            'description' => 'Search customer organizations and return safe operational summaries. Supports date filters such as created_on, created_start, created_end, timezone, include_project_counts, and include_test.',
            'parameters' => $object + ['properties' => [
                'query' => ['type' => 'string'],
                'filters' => ['type' => 'object', 'additionalProperties' => true],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 200],
                'include_project_counts' => ['type' => 'boolean'],
            ], 'required' => ['query','filters','limit','include_project_counts']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'organization_signup_stats',
            'description' => 'Find organizations by signup/created date and aggregate how many reports/orders/projects those organizations have done so far. Use for questions like "how many orgs signed up today" or "for today signups, how many orders have they done?" Dates are interpreted in the supplied timezone, default Pacific.',
            'parameters' => $object + ['properties' => [
                'filters' => ['type' => 'object', 'additionalProperties' => true, 'description' => 'created_on YYYY-MM-DD, created_start, created_end, timezone, query, include_test.'],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 500],
            ], 'required' => ['filters','limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'get_organization_summary',
            'description' => 'Get a summary for one customer organization.',
            'parameters' => $object + ['properties' => ['organization_id' => ['type' => 'string']], 'required' => ['organization_id']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'search_leads',
            'description' => 'Search CRM leads using the leads view.',
            'parameters' => ['type' => 'object', 'additionalProperties' => false, 'properties' => [
                'filters' => ['type' => 'object', 'additionalProperties' => true],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 200],
            ], 'required' => ['filters','limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'lead_stats',
            'description' => 'Aggregate CRM leads by status, assignee, state, region, source, or organization.',
            'parameters' => ['type' => 'object', 'additionalProperties' => false, 'properties' => [
                'filters' => ['type' => 'object', 'additionalProperties' => true],
                'group_by' => ['type' => 'string'],
            ], 'required' => ['filters','group_by']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'list_portal_data_catalog',
            'description' => 'List admin-readable JSON files used by CRM/Sales tabs from safe storage areas. Excludes secrets, config tokens, OAuth state, raw mailboxes, live Stripe events, and PHP source.',
            'parameters' => $object + ['properties' => [
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 500],
            ], 'required' => ['limit']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'read_portal_json_document',
            'description' => 'Read one JSON document from list_portal_data_catalog. Sensitive-looking keys are redacted.',
            'parameters' => $object + ['properties' => [
                'path' => ['type' => 'string', 'description' => 'Relative path such as storage/data/call_scripts.json.'],
            ], 'required' => ['path']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'get_crm_settings_snapshot',
            'description' => 'Read CRM settings, mock communications settings/recent rows, and call scripts through their normalized read-only helpers.',
            'parameters' => $object + ['properties' => new stdClass(), 'required' => []],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'firstmeasure_api_request',
            'description' => 'Call the FirstMeasure v1 API on read-only GET routes or whitelisted read-only POST query/status routes.',
            'parameters' => $object + ['properties' => [
                'method' => ['type' => 'string', 'enum' => ['GET','POST']],
                'path' => ['type' => 'string'],
                'query' => ['type' => 'object', 'additionalProperties' => true],
                'body' => ['type' => 'object', 'additionalProperties' => true],
            ], 'required' => ['method','path','query','body']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'create_table',
            'description' => 'Create a rendered table artifact for the UI from rows already obtained via other tools.',
            'parameters' => ['type' => 'object', 'additionalProperties' => false, 'properties' => [
                'title' => ['type' => 'string'],
                'columns' => ['type' => 'array', 'items' => ['type' => 'string']],
                'rows' => ['type' => 'array', 'items' => ['type' => 'object', 'additionalProperties' => true]],
            ], 'required' => ['title','columns','rows']],
            'strict' => false,
        ],
        [
            'type' => 'function',
            'name' => 'create_chart',
            'description' => 'Create a rendered Chart.js artifact for the UI. Always use this instead of Mermaid, xychart-beta, ASCII charts, or raw chart code when the user asks for a graph/visual/chart.',
            'parameters' => ['type' => 'object', 'additionalProperties' => false, 'properties' => [
                'title' => ['type' => 'string'],
                'chart_type' => ['type' => 'string', 'enum' => ['bar','line','pie','doughnut']],
                'labels' => ['type' => 'array', 'items' => ['type' => 'string']],
                'datasets' => ['type' => 'array', 'items' => ['type' => 'object', 'additionalProperties' => true]],
            ], 'required' => ['title','chart_type','labels','datasets']],
            'strict' => false,
        ],
    ];
}

function dataAgentCoreSystemInstructions() {
    $sources = dataAgentDbMap();
    return "You are the FirstMeasure Data Agent inside the FirstMate internal CRM.\n"
        . "Current server time: " . dataAgentNowIso() . ". Timezone: " . dataAgentTimezone() . ". Always pay attention to when data was polled, because operational data can change.\n\n"
        . "Product context: FirstMeasure is a FirstMate product for roof reports. Reports/projects can be residential, commercial, or multifamily. Main managers: Melden and Rashid.\n"
        . "Timezone context: the company and the people asking questions in this agent are normally in Pacific time (" . dataAgentTimezone() . "). Technicians, QA technicians, and managers generally work in the Philippines on Philippine Standard Time (" . dataAgentTechnicianTimezone() . ", UTC+08, no DST). When discussing shifts, staffing, same-day work, or relative times, state which timezone you are using and convert PHT <-> Pacific when helpful. Pacific may be PST or PDT depending on the date.\n"
        . "Terminology: technicians are production users who draw/process reports, QA technicians review reports, managers supervise queue/review/users/payroll. Technician names/emails may be in assigned_to_*, workflow.work_history, qa_claimed_by_*, and qa_history.\n\n"
        . "Data locations: projects SQLite index is " . $sources['projects'] . "; CRM leads are in " . $sources['leads'] . "; users and per-user shift schedules are JSON files in " . storageDir('users') . "; organizations are manifests in " . storageDir('organizations') . "; FirstMeasure API base is " . fm_api_base_url() . ".\n"
        . "For signup questions about customers/organizations, use organization_signup_stats. It can filter organizations by created_at/signup date and aggregate project/report counts plus ledger order_submitted counts for the resulting organization list.\n"
        . "You have only read-only tools. Never request writes, mutations, destructive SQL, or secret material. Do not reveal password hashes, tokens, API keys, files from storage/secrets, OAuth state, raw mailbox tokens, live Stripe payloads, or arbitrary PHP source. Use the safe catalog/read tools for non-secret JSON used by portal tabs.\n\n"
        . "Use tools proactively. Prefer high-level stats/search tools when they fit; use read-only SQL when a custom aggregation is needed. For statistical answers, show numerator, denominator, filters, and poll time. If a result may be stale, say when it was fetched. Generate tables/charts when they make the answer clearer.";
}

function dataAgentSystemInstructions() {
    $settings = dataAgentLoadSettings();
    $prompt = trim((string)($settings['system_prompt'] ?? ''));
    if ($prompt === '') $prompt = dataAgentCoreSystemInstructions();
    return $prompt . "\n\nNon-editable runtime safety: all available tools are read-only. Never request writes, mutations, destructive SQL, or secret material. Do not reveal password hashes, tokens, API keys, files from storage/secrets, OAuth state, raw mailbox tokens, live Stripe payloads, or arbitrary PHP source.\n\nNon-editable rendering rule: when the user asks for a chart, graph, visualization, trend line, bar chart, pie chart, or similar visual, call create_chart with labels and datasets. Do not output Mermaid, xychart-beta, ASCII charts, or raw chart code as the primary visual.";
}

function dataAgentFunctionCallSummaries() {
    $rows = [];
    foreach (dataAgentToolDefinitions() as $tool) {
        $rows[] = [
            'name' => (string)($tool['name'] ?? ''),
            'description' => (string)($tool['description'] ?? ''),
            'parameters' => $tool['parameters'] ?? null,
        ];
    }
    return $rows;
}

function dataAgentOpenAiApiKey() {
    $candidates = [
        getenv('OPENAI_API_KEY'),
        function_exists('serverConfigGet') ? serverConfigGet('data_agent_openai_api_key', '') : '',
        function_exists('serverConfigGet') ? serverConfigGet('openai_api_key', '') : '',
        function_exists('serverConfigGet') ? serverConfigGet('OPENAI_API_KEY', '') : '',
    ];
    foreach ($candidates as $key) {
        $key = is_string($key) ? trim($key) : '';
        if ($key !== '') return $key;
    }
    return '';
}

function dataAgentModelCandidates() {
    $configured = trim((string)(function_exists('serverConfigGet') ? serverConfigGet('data_agent_openai_model', '') : ''));
    $env = trim((string)getenv('DATA_AGENT_OPENAI_MODEL'));
    $list = [];
    foreach ([$configured, $env, 'gpt-5.5', 'gpt-5.4', 'gpt-5.1', 'gpt-5', 'gpt-4.1'] as $m) {
        if ($m !== '' && !in_array($m, $list, true)) $list[] = $m;
    }
    return $list;
}

function dataAgentOpenAiRequest($payload, $apiKey, $timeout = 90) {
    $url = 'https://api.openai.com/v1/responses';
    $headers = [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $apiKey,
    ];
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_TIMEOUT => $timeout,
        ]);
        $resp = curl_exec($ch);
        $err = curl_error($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => implode("\r\n", $headers), 'content' => $body, 'timeout' => $timeout, 'ignore_errors' => true]]);
        $resp = @file_get_contents($url, false, $ctx);
        $err = $resp === false ? 'request_failed' : '';
        $status = 0;
        foreach (($http_response_header ?? []) as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) $status = (int)$m[1];
        }
    }
    $json = json_decode((string)$resp, true);
    return ['ok' => $err === '' && $status >= 200 && $status < 300 && is_array($json), 'status' => $status, 'error' => $err, 'json' => is_array($json) ? $json : null, 'raw' => (string)$resp];
}

function dataAgentResponseText($response) {
    if (!is_array($response)) return '';
    if (isset($response['output_text']) && is_string($response['output_text'])) return $response['output_text'];
    $parts = [];
    foreach (($response['output'] ?? []) as $item) {
        if (($item['type'] ?? '') !== 'message') continue;
        foreach (($item['content'] ?? []) as $content) {
            if (isset($content['text'])) $parts[] = (string)$content['text'];
        }
    }
    return trim(implode("\n", $parts));
}

function dataAgentFunctionCalls($response) {
    $calls = [];
    foreach (($response['output'] ?? []) as $item) {
        if (($item['type'] ?? '') === 'function_call') $calls[] = $item;
    }
    return $calls;
}

function dataAgentCallTool($name, $args) {
    $args = is_array($args) ? $args : [];
    switch ($name) {
        case 'list_data_sources': return dataAgentListDataSources();
        case 'inspect_database_schema': return dataAgentDatabaseSchema((string)($args['database'] ?? ''));
        case 'run_readonly_sql': return dataAgentRunReadonlySql($args);
        case 'search_projects': return dataAgentSearchProjects($args);
        case 'project_stats': return dataAgentProjectStats($args);
        case 'get_project_detail': return dataAgentProjectDetail($args);
        case 'search_users': return dataAgentSearchUsers($args);
        case 'get_user_profile': return dataAgentGetUserProfile($args);
        case 'get_shift_snapshot': return dataAgentShiftSnapshot($args);
        case 'search_organizations': return dataAgentSearchOrganizations($args);
        case 'organization_signup_stats': return dataAgentOrganizationSignupStats($args);
        case 'get_organization_summary': return dataAgentGetOrganization($args);
        case 'search_leads': return dataAgentSearchLeads($args);
        case 'lead_stats': return dataAgentLeadStats($args);
        case 'list_portal_data_catalog': return dataAgentPortalDataCatalog($args);
        case 'read_portal_json_document': return dataAgentReadPortalJsonDocument($args);
        case 'get_crm_settings_snapshot': return dataAgentCrmSettingsSnapshot();
        case 'firstmeasure_api_request': return dataAgentFirstMeasureApi($args);
        case 'create_table': return dataAgentCreateTableArtifact($args);
        case 'create_chart': return dataAgentCreateChartArtifact($args);
    }
    throw new RuntimeException('Unknown tool: ' . $name);
}

function dataAgentTraceSummary($result) {
    if (isset($result['artifact'])) return ['artifact' => $result['artifact']];
    if (isset($result['row_count'])) return ['row_count' => $result['row_count'], 'polled_at' => $result['polled_at'] ?? null];
    if (isset($result['total_count'])) return ['total_count' => $result['total_count'], 'row_count' => $result['row_count'] ?? null, 'polled_at' => $result['polled_at'] ?? null];
    if (isset($result['status']) && isset($result['url'])) return ['status' => $result['status'], 'ok' => $result['ok'] ?? null, 'polled_at' => $result['polled_at'] ?? null];
    return ['keys' => array_slice(array_keys((array)$result), 0, 12), 'polled_at' => $result['polled_at'] ?? null];
}

function dataAgentNdjson($event, $payload = []) {
    $runId = (string)($GLOBALS['DATA_AGENT_ACTIVE_RUN_ID'] ?? '');
    if ($runId !== '') {
        dataAgentAppendRunEvent($runId, $event, is_array($payload) ? $payload : ['value' => $payload]);
        return;
    }
    echo json_encode(['event' => $event, 'data' => $payload], JSON_UNESCAPED_SLASHES) . "\n";
    @ob_flush();
    @flush();
}

function dataAgentBuildInputMessages($messages, $newUserText) {
    $input = [];
    foreach (array_slice(is_array($messages) ? $messages : [], -20) as $m) {
        $role = ($m['role'] ?? '') === 'assistant' ? 'assistant' : (($m['role'] ?? '') === 'user' ? 'user' : '');
        $content = trim((string)($m['content'] ?? ''));
        if ($role && $content !== '') $input[] = ['role' => $role, 'content' => $content];
    }
    $input[] = ['role' => 'user', 'content' => $newUserText];
    return $input;
}

function dataAgentRunChatStream($session, $message) {
    $apiKey = dataAgentOpenAiApiKey();
    if ($apiKey === '') {
        dataAgentNdjson('error', ['message' => 'Missing OPENAI_API_KEY or server_config data_agent_openai_api_key.']);
        return [null, [], []];
    }

    $tools = dataAgentToolDefinitions();
    $input = dataAgentBuildInputMessages($session['messages'] ?? [], $message);
    $artifacts = [];
    $trace = [];
    $selectedModel = null;
    $previousResponseId = null;
    $apiKeyError = null;

    dataAgentNdjson('status', ['message' => 'Contacting OpenAI with read-only tools.']);

    foreach (dataAgentModelCandidates() as $model) {
        $payload = [
            'model' => $model,
            'instructions' => dataAgentSystemInstructions(),
            'input' => $input,
            'tools' => $tools,
            'tool_choice' => 'auto',
            'parallel_tool_calls' => true,
        ];
        if (strpos($model, 'gpt-5') === 0) {
            $payload['reasoning'] = ['effort' => 'medium'];
        }
        $res = dataAgentOpenAiRequest($payload, $apiKey);
        if ($res['ok']) {
            $selectedModel = $model;
            $response = $res['json'];
            break;
        }
        $messageText = (string)($res['json']['error']['message'] ?? $res['error'] ?? $res['raw'] ?? 'OpenAI request failed.');
        $apiKeyError = $messageText;
        if (stripos($messageText, 'model') === false && stripos($messageText, 'does not exist') === false && stripos($messageText, 'not found') === false) {
            dataAgentNdjson('error', ['message' => $messageText, 'status' => $res['status']]);
            return [null, [], []];
        }
        dataAgentNdjson('status', ['message' => 'Model ' . $model . ' unavailable; trying fallback.']);
    }

    if (empty($response) || !$selectedModel) {
        dataAgentNdjson('error', ['message' => $apiKeyError ?: 'No configured model was available.']);
        return [null, [], []];
    }

    dataAgentNdjson('meta', ['model' => $selectedModel, 'server_time' => dataAgentNowIso()]);

    for ($step = 0; $step < 12; $step++) {
        $previousResponseId = (string)($response['id'] ?? $previousResponseId);
        $calls = dataAgentFunctionCalls($response);
        if (!$calls) break;
        $outputs = [];
        foreach ($calls as $call) {
            $name = (string)($call['name'] ?? '');
            $callId = (string)($call['call_id'] ?? '');
            $args = json_decode((string)($call['arguments'] ?? '{}'), true);
            if (!is_array($args)) $args = [];
            $started = microtime(true);
            dataAgentNdjson('tool_call', ['name' => $name, 'arguments' => $args, 'call_id' => $callId, 'started_at' => dataAgentNowIso()]);
            $traceItem = ['name' => $name, 'arguments' => $args, 'call_id' => $callId, 'started_at' => dataAgentNowIso()];
            try {
                $toolResult = dataAgentCallTool($name, $args);
                if (isset($toolResult['artifact']) && is_array($toolResult['artifact'])) $artifacts[] = $toolResult['artifact'];
                $summary = dataAgentTraceSummary($toolResult);
                $traceItem['ok'] = true;
                $traceItem['summary'] = $summary;
                $traceItem['duration_ms'] = (int)round((microtime(true) - $started) * 1000);
                $outputs[] = ['type' => 'function_call_output', 'call_id' => $callId, 'output' => json_encode($toolResult, JSON_UNESCAPED_SLASHES)];
                dataAgentNdjson('tool_result', ['name' => $name, 'call_id' => $callId, 'ok' => true, 'summary' => $summary, 'duration_ms' => $traceItem['duration_ms']]);
            } catch (Throwable $e) {
                $err = ['ok' => false, 'error' => $e->getMessage(), 'polled_at' => dataAgentNowIso()];
                $traceItem['ok'] = false;
                $traceItem['error'] = $e->getMessage();
                $outputs[] = ['type' => 'function_call_output', 'call_id' => $callId, 'output' => json_encode($err, JSON_UNESCAPED_SLASHES)];
                dataAgentNdjson('tool_result', ['name' => $name, 'call_id' => $callId, 'ok' => false, 'error' => $e->getMessage()]);
            }
            $trace[] = $traceItem;
        }
        dataAgentNdjson('status', ['message' => 'Sending tool results back to the model.']);
        $payload = [
            'model' => $selectedModel,
            'previous_response_id' => $previousResponseId,
            'input' => $outputs,
            'tools' => $tools,
            'tool_choice' => 'auto',
            'parallel_tool_calls' => true,
        ];
        if (strpos($selectedModel, 'gpt-5') === 0) $payload['reasoning'] = ['effort' => 'medium'];
        $res = dataAgentOpenAiRequest($payload, $apiKey, 120);
        if (!$res['ok']) {
            $msg = (string)($res['json']['error']['message'] ?? $res['error'] ?? 'OpenAI follow-up request failed.');
            dataAgentNdjson('error', ['message' => $msg, 'status' => $res['status']]);
            return [null, $trace, $artifacts];
        }
        $response = $res['json'];
    }

    $answer = dataAgentResponseText($response);
    if ($answer === '') $answer = 'I could not produce a final answer from the tool results.';
    dataAgentNdjson('assistant_message', ['content' => $answer, 'artifacts' => $artifacts, 'model' => $selectedModel, 'created_at' => dataAgentNowIso()]);
    return [$answer, $trace, $artifacts, $selectedModel];
}

function dataAgentTitleModelCandidates() {
    $configured = trim((string)(function_exists('serverConfigGet') ? serverConfigGet('data_agent_title_model', '') : ''));
    $env = trim((string)getenv('DATA_AGENT_TITLE_MODEL'));
    $list = [];
    foreach ([$configured, $env, 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.4'] as $m) {
        if ($m !== '' && !in_array($m, $list, true)) $list[] = $m;
    }
    return $list;
}

function dataAgentGenerateConversationTitle($message) {
    $apiKey = dataAgentOpenAiApiKey();
    $fallback = trim(mb_substr(preg_replace('/\s+/', ' ', (string)$message), 0, 54));
    if ($apiKey === '') return $fallback !== '' ? $fallback : 'Data chat';
    $input = "Create a concise 3-7 word title for this FirstMeasure data-agent conversation. Return only the title, no punctuation wrapper.\n\nUser request: " . (string)$message;
    foreach (dataAgentTitleModelCandidates() as $model) {
        $payload = [
            'model' => $model,
            'instructions' => 'You write short CRM conversation titles. Return only a plain title.',
            'input' => [['role' => 'user', 'content' => $input]],
            'max_output_tokens' => 32,
        ];
        $res = dataAgentOpenAiRequest($payload, $apiKey, 12);
        if (!$res['ok']) continue;
        $title = trim(dataAgentResponseText($res['json']));
        $title = trim($title, " \t\n\r\0\x0B\"'`.,:;-");
        if ($title !== '') return mb_substr($title, 0, 70);
    }
    return $fallback !== '' ? $fallback : 'Data chat';
}

function dataAgentMaybeGenerateTitle($sessionId, $message) {
    $session = dataAgentLoadConversation($sessionId);
    if (!is_array($session)) return;
    $messages = is_array($session['messages'] ?? null) ? $session['messages'] : [];
    $title = trim((string)($session['title'] ?? ''));
    if (count($messages) !== 1) return;
    if ($title !== '' && $title !== 'New data chat' && $title !== 'Generating title...') return;
    $session['title'] = dataAgentGenerateConversationTitle($message);
    dataAgentSaveConversation($session);
}

function dataAgentSpawnRunWorker($runId) {
    $script = __DIR__ . '/_data_agent_worker.php';
    if (!is_file($script)) return false;
    $phpCandidates = [];
    foreach ([defined('PHP_BINARY') ? PHP_BINARY : '', PHP_BINDIR ? PHP_BINDIR . DIRECTORY_SEPARATOR . 'php' : '', '/usr/bin/php', '/usr/local/bin/php', 'php'] as $candidate) {
        $candidate = trim((string)$candidate);
        if ($candidate !== '' && !in_array($candidate, $phpCandidates, true)) $phpCandidates[] = $candidate;
    }
    $php = $phpCandidates[0] ?? 'php';
    foreach ($phpCandidates as $candidate) {
        if ($candidate === 'php' || is_file($candidate)) {
            $php = $candidate;
            break;
        }
    }
    if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
        if (!function_exists('popen') || !function_exists('pclose')) return false;
        $cmd = 'start /B "" ' . escapeshellarg($php) . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($runId);
        @pclose(@popen($cmd, 'r'));
        return true;
    }
    if (!function_exists('exec')) return false;
    $cmd = 'nohup ' . escapeshellarg($php) . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($runId) . ' > /dev/null 2>&1 &';
    @exec($cmd);
    return true;
}

function dataAgentCreateServerRun($session, $message, $messagesBeforeNewUser, $userMessage) {
    $run = [
        'id' => dataAgentNewId(16),
        'session_id' => (string)$session['id'],
        'status' => 'queued',
        'created_at' => dataAgentNowIso(),
        'updated_at' => dataAgentNowIso(),
        'created_by_email' => strtolower(trim((string)($_SESSION['user_email'] ?? ''))),
        'created_by_name' => (string)($_SESSION['user_name'] ?? ''),
        'message' => (string)$message,
        'context_messages' => array_values(is_array($messagesBeforeNewUser) ? $messagesBeforeNewUser : []),
        'user_message' => $userMessage,
        'events' => [],
        'last_event_seq' => 0,
    ];
    dataAgentSaveRun($run);
    dataAgentAppendRunEvent($run['id'], 'user_message', $userMessage + ['session_id' => $session['id']]);
    if (!dataAgentSpawnRunWorker($run['id'])) {
        $run = dataAgentLoadRun($run['id']) ?: $run;
        $run['status'] = 'error';
        $run['error'] = 'Could not start the Data Agent worker. Make sure PHP CLI is available and exec/popen is not disabled.';
        dataAgentSaveRun($run);
        dataAgentAppendRunEvent($run['id'], 'error', ['message' => $run['error']]);
    }
    return dataAgentLoadRun($run['id']) ?: $run;
}

function dataAgentBuildUserMessageAndSession($id, $message, $editIndex) {
    if ($message === '') dataAgentJsonResponse(['success' => false, 'error' => 'Message is required.'], 400);
    $session = $id ? dataAgentLoadConversation($id) : null;
    if ($id && (!$session || !dataAgentCanAccessConversation($session))) {
        dataAgentJsonResponse(['success' => false, 'error' => 'Conversation not found.'], 404);
    }
    if ($editIndex !== null && !$session) {
        dataAgentJsonResponse(['success' => false, 'error' => 'Cannot edit a conversation that has not been saved yet.'], 400);
    }
    if (!$session) $session = dataAgentCreateConversation('Generating title...', false);
    $messagesBeforeNewUser = is_array($session['messages'] ?? null) ? $session['messages'] : [];
    $userMessage = ['role' => 'user', 'content' => $message, 'created_at' => dataAgentNowIso()];
    if ($editIndex !== null) {
        $messages = is_array($session['messages'] ?? null) ? $session['messages'] : [];
        $latestUserIndex = -1;
        foreach ($messages as $idx => $savedMessage) {
            if (($savedMessage['role'] ?? '') === 'user') $latestUserIndex = (int)$idx;
        }
        if (!isset($messages[$editIndex]) || ($messages[$editIndex]['role'] ?? '') !== 'user') {
            dataAgentJsonResponse(['success' => false, 'error' => 'Only a saved user message can be edited.'], 400);
        }
        if ($editIndex !== $latestUserIndex) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Only the most recent user message can be edited.'], 400);
        }
        $userMessage['edited_at'] = dataAgentNowIso();
        $userMessage['replaces_message_index'] = $editIndex;
        $messagesBeforeNewUser = array_slice($messages, 0, $editIndex);
        $session['messages'] = $messagesBeforeNewUser;
    }
    $session['messages'][] = $userMessage;
    if (($session['title'] ?? 'New data chat') === 'New data chat') $session['title'] = 'Generating title...';
    dataAgentSaveConversation($session);
    return [$session, $messagesBeforeNewUser, $userMessage];
}

function dataAgentRunBackgroundJob($runId) {
    $run = dataAgentLoadRun($runId);
    if (!is_array($run)) return false;
    if (!in_array((string)($run['status'] ?? ''), ['queued','running'], true)) return true;
    $run['status'] = 'running';
    $run['started_at'] = $run['started_at'] ?? dataAgentNowIso();
    dataAgentSaveRun($run);
    $GLOBALS['DATA_AGENT_ACTIVE_RUN_ID'] = $runId;
    try {
        $modelSession = ['id' => (string)$run['session_id'], 'messages' => is_array($run['context_messages'] ?? null) ? $run['context_messages'] : []];
        [$answer, $trace, $artifacts, $model] = dataAgentRunChatStream($modelSession, (string)$run['message']);
        dataAgentMaybeGenerateTitle((string)$run['session_id'], (string)$run['message']);
        $run = dataAgentLoadRun($runId) ?: $run;
        if ($answer !== null) {
            $assistantMessage = [
                'role' => 'assistant',
                'content' => $answer,
                'created_at' => dataAgentNowIso(),
                'trace' => $trace,
                'artifacts' => $artifacts,
                'model' => $model,
            ];
            $session = dataAgentLoadConversation((string)$run['session_id']);
            if (is_array($session)) {
                $session['messages'][] = $assistantMessage;
                dataAgentSaveConversation($session);
            }
            $run['status'] = 'completed';
            $run['completed_at'] = dataAgentNowIso();
            $run['assistant_message'] = $assistantMessage;
            dataAgentSaveRun($run);
            dataAgentNdjson('done', ['session_id' => (string)$run['session_id'], 'run_id' => $runId, 'updated_at' => dataAgentNowIso()]);
        } else {
            $run['status'] = 'error';
            $run['completed_at'] = dataAgentNowIso();
            dataAgentSaveRun($run);
        }
    } catch (Throwable $e) {
        dataAgentNdjson('error', ['message' => $e->getMessage()]);
        $run = dataAgentLoadRun($runId) ?: $run;
        $run['status'] = 'error';
        $run['completed_at'] = dataAgentNowIso();
        $run['error'] = $e->getMessage();
        dataAgentSaveRun($run);
    } finally {
        unset($GLOBALS['DATA_AGENT_ACTIVE_RUN_ID']);
    }
    return true;
}

function handleDataAgentActions($action) {
    if (strpos((string)$action, 'data_agent_') !== 0) return false;
    dataAgentRequireAllowed();

    if ($action === 'data_agent_bootstrap') {
        $sessions = dataAgentListConversations();
        dataAgentJsonResponse([
            'success' => true,
            'sessions' => $sessions,
            'sources_summary' => [
                'server_time' => dataAgentNowIso(),
                'timezone' => dataAgentTimezone(),
                'firstmeasure_api_base' => fm_api_base_url(),
                'model_candidates' => dataAgentModelCandidates(),
            ],
        ]);
    }

    if ($action === 'data_agent_new_session') {
        dataAgentJsonResponse(['success' => true, 'session' => dataAgentCreateConversation((string)($_POST['title'] ?? ''), false)]);
    }

    if ($action === 'data_agent_get_settings') {
        $settings = dataAgentLoadSettings();
        dataAgentJsonResponse([
            'success' => true,
            'settings' => $settings,
            'function_calls' => dataAgentFunctionCallSummaries(),
        ]);
    }

    if ($action === 'data_agent_save_settings') {
        $settings = dataAgentSaveSettings([
            'system_prompt' => (string)($_POST['system_prompt'] ?? ''),
        ]);
        dataAgentJsonResponse(['success' => true, 'settings' => $settings]);
    }

    if ($action === 'data_agent_get_session') {
        $id = dataAgentSafeSessionId($_POST['session_id'] ?? '');
        $session = $id ? dataAgentLoadConversation($id) : null;
        if (!$session) dataAgentJsonResponse(['success' => false, 'error' => 'Conversation not found.'], 404);
        if (!dataAgentCanAccessConversation($session)) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Conversation not found.'], 404);
        }
        dataAgentJsonResponse(['success' => true, 'session' => $session, 'active_run' => dataAgentLatestActiveRunForSession($id)]);
    }

    if ($action === 'data_agent_list_sessions') {
        dataAgentJsonResponse(['success' => true, 'sessions' => dataAgentListConversations()]);
    }

    if ($action === 'data_agent_delete_session') {
        $id = dataAgentSafeSessionId($_POST['session_id'] ?? '');
        $session = $id ? dataAgentLoadConversation($id) : null;
        if (!$session || !dataAgentCanAccessConversation($session)) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Conversation not found.'], 404);
        }
        dataAgentDeleteConversation($id);
        dataAgentJsonResponse(['success' => true, 'deleted_session_id' => $id]);
    }

    if ($action === 'data_agent_rename_session') {
        $id = dataAgentSafeSessionId($_POST['session_id'] ?? '');
        $title = trim((string)($_POST['title'] ?? ''));
        if ($title === '') dataAgentJsonResponse(['success' => false, 'error' => 'Title is required.'], 400);
        if (mb_strlen($title) > 90) $title = mb_substr($title, 0, 90);
        $session = $id ? dataAgentLoadConversation($id) : null;
        if (!$session || !dataAgentCanAccessConversation($session)) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Conversation not found.'], 404);
        }
        $session['title'] = $title;
        dataAgentSaveConversation($session);
        dataAgentJsonResponse(['success' => true, 'session' => $session]);
    }

    if ($action === 'data_agent_start_run') {
        $id = dataAgentSafeSessionId($_POST['session_id'] ?? '');
        $message = trim((string)($_POST['message'] ?? ''));
        $editIndex = null;
        if (isset($_POST['edit_message_index']) && $_POST['edit_message_index'] !== '') {
            $editIndex = filter_var($_POST['edit_message_index'], FILTER_VALIDATE_INT);
            if ($editIndex === false || $editIndex < 0) dataAgentJsonResponse(['success' => false, 'error' => 'Invalid message edit index.'], 400);
        }
        [$session, $messagesBeforeNewUser, $userMessage] = dataAgentBuildUserMessageAndSession($id, $message, $editIndex);
        $run = dataAgentCreateServerRun($session, $message, $messagesBeforeNewUser, $userMessage);
        $payload = [
            'success' => true,
            'session_id' => (string)$session['id'],
            'session' => $session,
            'run' => [
                'id' => (string)$run['id'],
                'status' => (string)($run['status'] ?? 'queued'),
                'last_event_seq' => (int)($run['last_event_seq'] ?? 0),
            ],
            'user_message' => $userMessage,
        ];
        if (function_exists('fastcgi_finish_request') && in_array((string)($run['status'] ?? ''), ['queued','running'], true)) {
            dataAgentJsonResponseThenRun($payload, (string)$run['id']);
        }
        dataAgentJsonResponse($payload);
    }

    if ($action === 'data_agent_get_run') {
        $runId = dataAgentSafeSessionId($_POST['run_id'] ?? '');
        $after = filter_var($_POST['after_seq'] ?? 0, FILTER_VALIDATE_INT);
        if ($after === false || $after < 0) $after = 0;
        $run = $runId ? dataAgentLoadRun($runId) : null;
        if ($run) $run = dataAgentMarkRunStaleIfNeeded($run);
        if ($run) $run = dataAgentKickRunIfNeeded($run);
        if (!$run || !dataAgentCanAccessRun($run)) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Run not found.'], 404);
        }
        $events = array_values(array_filter(is_array($run['events'] ?? null) ? $run['events'] : [], function ($event) use ($after) {
            return (int)($event['seq'] ?? 0) > $after;
        }));
        $sessionForRun = dataAgentLoadConversation((string)($run['session_id'] ?? ''));
        dataAgentJsonResponse([
            'success' => true,
            'run' => [
                'id' => (string)$run['id'],
                'session_id' => (string)$run['session_id'],
                'status' => (string)($run['status'] ?? 'queued'),
                'last_event_seq' => (int)($run['last_event_seq'] ?? 0),
                'updated_at' => (string)($run['updated_at'] ?? ''),
            ],
            'session_title' => is_array($sessionForRun) ? (string)($sessionForRun['title'] ?? '') : '',
            'events' => $events,
        ]);
    }

    if ($action === 'data_agent_chat_stream') {
        $id = dataAgentSafeSessionId($_POST['session_id'] ?? '');
        $message = trim((string)($_POST['message'] ?? ''));
        $editIndex = null;
        if (isset($_POST['edit_message_index']) && $_POST['edit_message_index'] !== '') {
            $editIndex = filter_var($_POST['edit_message_index'], FILTER_VALIDATE_INT);
            if ($editIndex === false || $editIndex < 0) {
                dataAgentJsonResponse(['success' => false, 'error' => 'Invalid message edit index.'], 400);
            }
        }
        if ($message === '') dataAgentJsonResponse(['success' => false, 'error' => 'Message is required.'], 400);
        $session = $id ? dataAgentLoadConversation($id) : null;
        if ($id && (!$session || !dataAgentCanAccessConversation($session))) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Conversation not found.'], 404);
        }
        if ($editIndex !== null && !$session) {
            dataAgentJsonResponse(['success' => false, 'error' => 'Cannot edit a conversation that has not been saved yet.'], 400);
        }
        if (!$session) $session = dataAgentCreateConversation(mb_substr($message, 0, 54), false);
        $messagesBeforeNewUser = is_array($session['messages'] ?? null) ? $session['messages'] : [];
        $userMessage = ['role' => 'user', 'content' => $message, 'created_at' => dataAgentNowIso()];
        if ($editIndex !== null) {
            $messages = is_array($session['messages'] ?? null) ? $session['messages'] : [];
            $latestUserIndex = -1;
            foreach ($messages as $idx => $savedMessage) {
                if (($savedMessage['role'] ?? '') === 'user') $latestUserIndex = (int)$idx;
            }
            if (!isset($messages[$editIndex]) || ($messages[$editIndex]['role'] ?? '') !== 'user') {
                dataAgentJsonResponse(['success' => false, 'error' => 'Only a saved user message can be edited.'], 400);
            }
            if ($editIndex !== $latestUserIndex) {
                dataAgentJsonResponse(['success' => false, 'error' => 'Only the most recent user message can be edited.'], 400);
            }
            $userMessage['edited_at'] = dataAgentNowIso();
            $userMessage['replaces_message_index'] = $editIndex;
            $messagesBeforeNewUser = array_slice($messages, 0, $editIndex);
            $session['messages'] = $messagesBeforeNewUser;
        }
        $session['messages'][] = $userMessage;
        if (($session['title'] ?? 'New data chat') === 'New data chat') {
            $session['title'] = mb_substr($message, 0, 54);
        }
        dataAgentSaveConversation($session);

        if (function_exists('session_write_close')) @session_write_close();
        @set_time_limit(180);
        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Cache-Control: no-cache, no-transform');
        header('X-Accel-Buffering: no');
        dataAgentNdjson('user_message', $userMessage + ['session_id' => $session['id']]);
        $modelSession = $session;
        $modelSession['messages'] = $messagesBeforeNewUser;
        [$answer, $trace, $artifacts, $model] = dataAgentRunChatStream($modelSession, $message);
        if ($answer !== null) {
            $assistantMessage = [
                'role' => 'assistant',
                'content' => $answer,
                'created_at' => dataAgentNowIso(),
                'trace' => $trace,
                'artifacts' => $artifacts,
                'model' => $model,
            ];
            $session = dataAgentLoadConversation($session['id']) ?: $session;
            $session['messages'][] = $assistantMessage;
            dataAgentSaveConversation($session);
            dataAgentNdjson('done', ['session_id' => $session['id'], 'updated_at' => $session['updated_at'] ?? dataAgentNowIso()]);
        }
        exit;
    }

    dataAgentJsonResponse(['success' => false, 'error' => 'Unknown data agent action.'], 404);
}
