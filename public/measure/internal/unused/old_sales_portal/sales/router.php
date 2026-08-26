<?php
/**
 * sales/router.php
 *
 * Purpose
 * -------
 * This file is a deliberately bounded API surface for small sales-side apps.
 * A front-end app in the folder above this one can call:
 *
 *   fetch("sales/router.php?resource=users")
 *   fetch("sales/router.php?resource=organizations&q=acme")
 *   fetch("sales/router.php?resource=leads&status=new&limit=100")
 *
 * The caller must already be logged in through the normal FirstMate PHP login.
 * The router uses the existing PHP session cookie; no separate API token is
 * needed for same-origin front-end apps.
 *
 * Security model
 * --------------
 * - Requires a logged-in non-customer employee account.
 * - Uses the existing session created by server.php/backend_login.php.
 * - Rejects unsafe cross-origin browser writes when Origin/Referer is present.
 * - Redacts obvious secret/password/token fields from user/org reads.
 * - Allows file writes only inside this folder's ./storage directory.
 * - Does not expose arbitrary SQL, arbitrary PHP includes, or filesystem paths.
 *
 * Intended contract
 * -----------------
 * This router is meant to be stable and readable by future Codex sessions.
 * Custom sales apps should call it, not edit it.
 *
 * Endpoint overview
 * -----------------
 * All responses are JSON except the FirstMeasure passthrough and storage raw
 * download mode.
 *
 * Meta:
 *   GET  ?resource=meta
 *
 * Read-only users:
 *   GET  ?resource=users&q=&limit=100&offset=0
 *   GET  ?resource=users&email=person@example.com
 *   GET  ?resource=users&id=user_id
 *
 * Read-only organizations:
 *   GET  ?resource=organizations&q=&limit=100&offset=0&include_ledger=0
 *   GET  ?resource=organizations&id=org_id&include_ledger=1
 *
 * Organization credit writes:
 *   GET  ?resource=organization_credits&org_id=...
 *   POST ?resource=organization_credits
 *        JSON: {"org_id":"...","delta":25,"reason":"manual_adjustment","meta":{}}
 *        JSON: {"org_id":"...","set_balance":100,"reason":"manual_set"}
 *
 * FirstMeasure passthrough:
 *   ANY  ?resource=firstmeasure&path=projects/query
 *   ANY  ?fm_path=projects/query
 *   Example:
 *     fetch("sales/router.php?resource=firstmeasure&path=projects/query", {
 *       method: "POST",
 *       headers: {"Content-Type":"application/json"},
 *       body: JSON.stringify({limit: 25, include_all: true})
 *     })
 *
 * Lead data:
 *   GET  ?resource=lead_tables
 *   GET  ?resource=leads&q=&status=&assigned_to_email=&limit=100
 *   GET  ?resource=leads&id=lead_...&hydrate=1
 *   POST ?resource=lead_save
 *        JSON: {"list_id":"...","company":"...","email":"...","status":"new"}
 *   GET/POST/PATCH/DELETE ?resource=lead_rows&table=lead_lists
 *   GET/POST/PATCH/DELETE ?resource=lead_lists
 *   GET/POST/PATCH/DELETE ?resource=lead_entities
 *   GET/POST/PATCH/DELETE ?resource=lead_memberships
 *   GET/POST/PATCH/DELETE ?resource=lead_notes
 *   GET/POST/PATCH/DELETE ?resource=lead_contacts
 *   GET/POST/PATCH/DELETE ?resource=lead_followups
 *   GET/POST/PATCH/DELETE ?resource=lead_dial_events
 *   GET/POST/PATCH/DELETE ?resource=lead_contact_notes
 *   GET/POST/PATCH/DELETE ?resource=lead_activity_items
 *   GET/POST/PATCH/DELETE ?resource=lead_dashboard_tasks
 *   GET/POST/PATCH/DELETE ?resource=lead_import_runs
 *
 * Sales app storage:
 *   GET    ?resource=storage&path=
 *   GET    ?resource=storage&path=foo.json
 *   GET    ?resource=storage&path=foo.json&raw=1
 *   PUT    ?resource=storage&path=foo.json
 *          JSON: {"data":{"anything":true}}
 *          JSON: {"content":"plain text"}
 *   DELETE ?resource=storage&path=foo.json
 *
 * Query helpers
 * -------------
 * List endpoints accept:
 *   q          text search
 *   limit      default 100, max 1000
 *   offset     default 0
 *   order_by   a real column/key on that resource
 *   order_dir  asc or desc
 *
 * Lead table endpoints also accept exact filters for indexed fields such as:
 *   id, list_id, lead_id, lead_entity_id, organization_id, status,
 *   assigned_to_email, owner_email, region, region_code, external_key,
 *   source_kind, source_key, import_type, preview_token.
 */

require_once dirname(__DIR__) . '/_storage.php';

if (session_status() !== PHP_SESSION_ACTIVE) {
    session_start();
}

$userDir = storageDir('users');
$orgDir = storageDir('organizations');

require_once dirname(__DIR__) . '/_project_api.php';
require_once dirname(__DIR__) . '/_permission_options.php';
require_once dirname(__DIR__) . '/_organizations.php';
require_once dirname(__DIR__) . '/_users.php';
require_once dirname(__DIR__) . '/_lead.php';

const SALES_ROUTER_VERSION = '2026-05-11';

sr_handle_options();
sr_require_sales_router_auth();
sr_require_same_origin_for_writes();

$resource = sr_resource();
if ($resource === 'firstmeasure' || isset($_GET['fm_path'])) {
    sr_firstmeasure_passthrough();
}

header('Content-Type: application/json; charset=utf-8');

try {
    switch ($resource) {
        case '':
        case 'meta':
        case 'help':
            sr_json(sr_meta());
            break;
        case 'users':
            sr_users_endpoint();
            break;
        case 'organizations':
        case 'orgs':
            sr_organizations_endpoint();
            break;
        case 'organization_credits':
        case 'org_credits':
        case 'credits':
            sr_organization_credits_endpoint();
            break;
        case 'lead_tables':
            sr_json(['success' => true, 'tables' => sr_lead_table_docs()]);
            break;
        case 'lead_save':
            sr_lead_save_endpoint();
            break;
        case 'storage':
        case 'files':
            sr_storage_endpoint();
            break;
        default:
            if (sr_is_lead_table_resource($resource)) {
                sr_lead_rows_endpoint(sr_table_for_resource($resource));
            }
            sr_error('Unknown resource: ' . $resource, 404, ['available' => array_keys(sr_meta()['resources'])]);
    }
} catch (Throwable $e) {
    sr_error('Router error', 500, ['detail' => $e->getMessage()]);
}

function sr_handle_options() {
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'OPTIONS') return;
    header('Allow: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Accept');
    http_response_code(204);
    exit;
}

function sr_require_sales_router_auth() {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($email === '') sr_error('Not logged in', 401);

    $user = function_exists('readUserDataByEmail') ? readUserDataByEmail($email) : null;
    if (!is_array($user)) sr_error('Logged-in user record not found', 401);

    $accountType = strtolower(trim((string)($user['account_type'] ?? '')));
    if ($accountType === 'customer') sr_error('Customer accounts cannot use the sales router', 403);

    $isEmployee = function_exists('isEmployeeUserByEmail') ? isEmployeeUserByEmail($email) : false;
    $isAdmin = !empty($_SESSION['user_is_admin']) || !empty($user['is_admin']) || strtolower((string)($user['role'] ?? '')) === 'admin';
    if (!$isEmployee && !$isAdmin) sr_error('Only employee accounts can use the sales router', 403);
}

function sr_require_same_origin_for_writes() {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) return;

    $host = strtolower(trim((string)($_SERVER['HTTP_HOST'] ?? '')));
    if ($host === '') return;

    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    $referer = trim((string)($_SERVER['HTTP_REFERER'] ?? ''));
    $source = $origin !== '' ? $origin : $referer;
    if ($source === '') return;

    $sourceHost = strtolower(trim((string)(parse_url($source, PHP_URL_HOST) ?? '')));
    $hostOnly = strtolower(trim(explode(':', $host)[0]));
    if ($sourceHost !== '' && $sourceHost !== $hostOnly) {
        sr_error('Cross-origin writes are not allowed', 403);
    }
}

function sr_resource() {
    $raw = (string)($_GET['resource'] ?? $_GET['endpoint'] ?? $_GET['r'] ?? '');
    $raw = strtolower(trim($raw));
    return preg_replace('/[^a-z0-9_\-]/', '', $raw);
}

function sr_method() {
    return strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
}

function sr_request_body() {
    static $body = null;
    if ($body !== null) return $body;
    $body = (string)file_get_contents('php://input');
    return $body;
}

function sr_payload() {
    static $payload = null;
    if ($payload !== null) return $payload;

    $payload = [];
    $raw = sr_request_body();
    $contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
    if ($raw !== '' && strpos($contentType, 'application/json') !== false) {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) $payload = $decoded;
    }
    if ($_POST) {
        foreach ($_POST as $k => $v) $payload[$k] = $v;
    }
    return $payload;
}

function sr_input($key, $default = null) {
    $payload = sr_payload();
    if (array_key_exists($key, $payload)) return $payload[$key];
    if (array_key_exists($key, $_GET)) return $_GET[$key];
    return $default;
}

function sr_bool($value, $default = false) {
    if ($value === null) return $default;
    if (is_bool($value)) return $value;
    $value = strtolower(trim((string)$value));
    if ($value === '') return $default;
    return in_array($value, ['1', 'true', 'yes', 'on'], true);
}

function sr_limit($default = 100, $max = 1000) {
    return max(1, min($max, (int)sr_input('limit', $default)));
}

function sr_offset() {
    return max(0, (int)sr_input('offset', 0));
}

function sr_json($data, $status = 200) {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function sr_error($message, $status = 400, $extra = []) {
    $out = array_merge(['success' => false, 'error' => $message], is_array($extra) ? $extra : []);
    sr_json($out, $status);
}

function sr_meta() {
    return [
        'success' => true,
        'router' => 'sales/router.php',
        'version' => SALES_ROUTER_VERSION,
        'authenticated_as' => [
            'email' => strtolower(trim((string)($_SESSION['user_email'] ?? ''))),
            'name' => (string)($_SESSION['user_name'] ?? ''),
        ],
        'resources' => [
            'meta' => 'Endpoint map and examples.',
            'users' => 'Read-only sanitized user records.',
            'organizations' => 'Read-only sanitized organization records.',
            'organization_credits' => 'Read and adjust organization credit balances.',
            'firstmeasure' => 'Authenticated passthrough to public/v1/firstmeasure.',
            'lead_tables' => 'Lead table names and writable columns.',
            'leads' => 'Primary lead membership records; prefer lead_save for writes.',
            'lead_save' => 'Safe create/update wrapper for lead membership plus entity data.',
            'lead_rows' => 'Generic whitelisted lead-table CRUD; pass table=...',
            'storage' => 'Read/write files inside sales/storage only.',
        ],
    ];
}

function sr_redact($value) {
    if (!is_array($value)) return $value;
    $out = [];
    foreach ($value as $k => $v) {
        $key = strtolower((string)$k);
        if (preg_match('/(password|pass_hash|secret|token|api[_-]?key|oauth|otp|session|cookie|authorization|stripe|payment_method|customer_id|client_secret|pm_server)/', $key)) {
            continue;
        }
        $out[$k] = is_array($v) ? sr_redact($v) : $v;
    }
    return $out;
}

function sr_text_haystack($row, $keys = []) {
    if (!is_array($row)) return '';
    if (!$keys) $keys = array_keys($row);
    $parts = [];
    foreach ($keys as $key) {
        $value = $row[$key] ?? '';
        if (is_scalar($value) || $value === null) $parts[] = (string)$value;
    }
    return strtolower(implode(' ', $parts));
}

function sr_sort_paginate($rows, $defaultOrderBy = '', $defaultDir = 'asc') {
    $orderBy = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)sr_input('order_by', $defaultOrderBy));
    $orderDir = strtolower(trim((string)sr_input('order_dir', $defaultDir))) === 'desc' ? 'desc' : 'asc';
    if ($orderBy !== '') {
        usort($rows, function ($a, $b) use ($orderBy, $orderDir) {
            $av = $a[$orderBy] ?? null;
            $bv = $b[$orderBy] ?? null;
            if (is_numeric($av) && is_numeric($bv)) $cmp = ((float)$av <=> (float)$bv);
            else $cmp = strnatcasecmp((string)$av, (string)$bv);
            return $orderDir === 'desc' ? -$cmp : $cmp;
        });
    }
    $total = count($rows);
    $offset = sr_offset();
    $limit = sr_limit();
    return [
        'rows' => array_slice($rows, $offset, $limit),
        'pagination' => [
            'total' => $total,
            'limit' => $limit,
            'offset' => $offset,
            'returned' => min($limit, max(0, $total - $offset)),
        ],
    ];
}

function sr_users_endpoint() {
    if (sr_method() !== 'GET') sr_error('Users are read-only through this router', 405);

    $email = strtolower(trim((string)sr_input('email', '')));
    $id = strtolower(trim((string)sr_input('id', '')));
    if ($email !== '') {
        $user = readUserDataByEmail($email);
        if (!is_array($user)) sr_error('User not found', 404);
        sr_json(['success' => true, 'user' => sr_redact($user)]);
    }

    $rows = [];
    $dir = $GLOBALS['userDir'] ?? storageDir('users');
    foreach (scandir($dir) ?: [] as $file) {
        if (pathinfo($file, PATHINFO_EXTENSION) !== 'json') continue;
        $path = rtrim($dir, '/\\') . '/' . $file;
        $user = json_decode((string)@file_get_contents($path), true);
        if (!is_array($user)) continue;
        if ($id !== '' && strtolower(trim((string)($user['id'] ?? ''))) !== $id) continue;
        if (!sr_bool(sr_input('include_deleted', false)) && !empty($user['deleted'])) continue;
        $user = sr_redact($user);
        $user['email'] = strtolower(trim((string)($user['email'] ?? basename($file, '.json'))));
        $q = strtolower(trim((string)sr_input('q', '')));
        if ($q !== '' && strpos(sr_text_haystack($user, ['email', 'name', 'role', 'department', 'account_type', 'organization_id']), $q) === false) continue;
        $rows[] = $user;
    }

    $page = sr_sort_paginate($rows, 'email', 'asc');
    sr_json(['success' => true, 'users' => $page['rows'], 'pagination' => $page['pagination']]);
}

function sr_organizations_endpoint() {
    if (sr_method() !== 'GET') sr_error('Organizations are read-only through this router; use organization_credits for credit writes', 405);

    $id = function_exists('orgNormalizeId') ? orgNormalizeId(sr_input('id', '')) : trim((string)sr_input('id', ''));
    $includeLedger = sr_bool(sr_input('include_ledger', $id !== ''), $id !== '');
    if ($id !== '') {
        $org = orgRead($id);
        if (!is_array($org)) sr_error('Organization not found', 404);
        if (!$includeLedger) unset($org['credits_ledger'], $org['billing']['events']);
        sr_json(['success' => true, 'organization' => sr_redact($org)]);
    }

    $rows = [];
    $dir = function_exists('orgDirPath') ? orgDirPath() : storageDir('organizations');
    $q = strtolower(trim((string)sr_input('q', '')));
    foreach (scandir($dir) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $orgId = function_exists('orgNormalizeId') ? orgNormalizeId($entry) : $entry;
        if ($orgId === '') continue;
        $manifest = rtrim($dir, '/\\') . '/' . $entry . '/manifest.json';
        if (!file_exists($manifest)) continue;
        $org = orgRead($orgId);
        if (!is_array($org)) continue;
        if (!$includeLedger) unset($org['credits_ledger'], $org['billing']['events']);
        $org = sr_redact($org);
        if ($q !== '' && strpos(sr_text_haystack($org, ['id', 'name', 'created_by_email', 'assigned_sales_email', 'assigned_sales_name']), $q) === false) continue;
        $rows[] = $org;
    }

    $page = sr_sort_paginate($rows, 'name', 'asc');
    sr_json(['success' => true, 'organizations' => $page['rows'], 'pagination' => $page['pagination']]);
}

function sr_organization_credits_endpoint() {
    $method = sr_method();
    $orgId = orgNormalizeId(sr_input('org_id', sr_input('id', '')));
    if ($orgId === '') sr_error('Missing org_id');

    $org = orgRead($orgId);
    if (!is_array($org)) sr_error('Organization not found', 404);
    orgEnsureCreditsFields($org);

    if ($method === 'GET') {
        $ledger = is_array($org['credits_ledger'] ?? null) ? array_reverse($org['credits_ledger']) : [];
        $page = sr_sort_paginate($ledger, '', 'desc');
        sr_json([
            'success' => true,
            'org_id' => $orgId,
            'credits_balance' => portalMoneyAmount($org['credits_balance'] ?? 0),
            'ledger' => $page['rows'],
            'pagination' => $page['pagination'],
        ]);
    }

    if (!in_array($method, ['POST', 'PUT', 'PATCH'], true)) sr_error('Use GET, POST, PUT, or PATCH for organization_credits', 405);

    $current = portalMoneyAmount($org['credits_balance'] ?? 0);
    $hasSet = sr_input('set_balance', null) !== null;
    $target = $hasSet ? portalMoneyAmount(sr_input('set_balance')) : null;
    $delta = $hasSet ? portalMoneyAmount($target - $current) : portalMoneyAmount(sr_input('delta', sr_input('amount', 0)));
    if ($delta == 0.0 && !$hasSet) sr_error('Provide a non-zero delta, amount, or set_balance');

    $reason = trim((string)sr_input('reason', $hasSet ? 'sales_router_set_balance' : 'sales_router_adjustment'));
    if ($reason === '') $reason = 'sales_router_adjustment';
    $meta = sr_input('meta', []);
    if (!is_array($meta)) $meta = ['note' => (string)$meta];
    $meta['sales_router'] = true;
    $meta['actor_email'] = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($hasSet) {
        $meta['previous_balance'] = $current;
        $meta['set_balance'] = $target;
    }

    $org['credits_balance'] = portalMoneyAmount($current + $delta);
    $entry = [
        'ts' => date('c'),
        'delta' => portalMoneyAmount($delta),
        'reason' => $reason,
        'by_email' => $_SESSION['user_email'] ?? null,
        'applied_for_user_email' => trim((string)sr_input('applied_for_email', '')) ?: null,
        'meta' => $meta,
        'unit' => 'usd_dollars',
        'balance_after' => portalMoneyAmount($org['credits_balance']),
    ];
    $org['credits_ledger'][] = $entry;
    if (!orgWrite($orgId, $org)) sr_error('Could not write organization credits', 500);

    sr_json([
        'success' => true,
        'org_id' => $orgId,
        'previous_balance' => $current,
        'delta' => portalMoneyAmount($delta),
        'new_balance' => portalMoneyAmount($org['credits_balance']),
        'ledger_entry' => $entry,
    ]);
}

function sr_firstmeasure_passthrough() {
    $path = (string)($_GET['fm_path'] ?? $_GET['path'] ?? '');
    $path = trim($path);
    $path = preg_replace('#^/?v1/firstmeasure/?#', '', $path);
    $path = ltrim($path, '/');
    if ($path === '') $path = '';
    if (strpos($path, '..') !== false) sr_error('Invalid FirstMeasure path', 400);

    $query = $_GET;
    foreach (['resource', 'endpoint', 'r', 'path', 'fm_path'] as $key) unset($query[$key]);

    $url = rtrim(fm_api_base_url(), '/') . ($path !== '' ? '/' . $path : '');
    $qs = http_build_query($query);
    if ($qs !== '') $url .= (strpos($url, '?') === false ? '?' : '&') . $qs;

    $method = sr_method();
    $body = sr_request_body();
    $headers = [];
    $contentType = trim((string)($_SERVER['CONTENT_TYPE'] ?? ''));
    if ($contentType !== '') $headers[] = 'Content-Type: ' . $contentType;
    $accept = trim((string)($_SERVER['HTTP_ACCEPT'] ?? ''));
    $headers[] = 'Accept: ' . ($accept !== '' ? $accept : '*/*');

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        $responseHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => function ($curl, $header) use (&$responseHeaders) {
                $len = strlen($header);
                $parts = explode(':', $header, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return $len;
            },
        ]);
        if (!in_array($method, ['GET', 'HEAD'], true) && $body !== '') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $resp = curl_exec($ch);
        $err = curl_error($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($err !== '') sr_error('FirstMeasure request failed', 502, ['detail' => $err]);
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => !in_array($method, ['GET', 'HEAD'], true) ? $body : '',
                'timeout' => 120,
                'ignore_errors' => true,
            ],
            'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
        ]);
        $resp = @file_get_contents($url, false, $context);
        $status = 0;
        $responseHeaders = [];
        foreach (($http_response_header ?? []) as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) $status = (int)$m[1];
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
        if ($resp === false) sr_error('FirstMeasure request failed', 502);
    }

    http_response_code($status > 0 ? $status : 502);
    foreach (['content-type', 'content-disposition', 'cache-control'] as $name) {
        if (!empty($responseHeaders[$name])) header($name . ': ' . $responseHeaders[$name]);
    }
    if (empty($responseHeaders['content-type'])) header('Content-Type: application/json; charset=utf-8');
    echo $resp === false ? '' : $resp;
    exit;
}

function sr_lead_table_map() {
    return [
        'leads' => 'lead_memberships',
        'lead' => 'lead_memberships',
        'lead_rows' => 'lead_memberships',
        'lead_memberships' => 'lead_memberships',
        'lead_lists' => 'lead_lists',
        'lead_entities' => 'lead_entities',
        'lead_exports' => 'lead_exports',
        'lead_notes' => 'lead_notes',
        'lead_followups' => 'lead_followups',
        'lead_dial_events' => 'lead_dial_events',
        'lead_contacts' => 'lead_contacts',
        'lead_contact_notes' => 'lead_contact_notes',
        'lead_dial_event_contacts' => 'lead_dial_event_contacts',
        'lead_activity_items' => 'lead_activity_items',
        'lead_dashboard_tasks' => 'lead_dashboard_tasks',
        'lead_import_runs' => 'lead_import_runs',
    ];
}

function sr_is_lead_table_resource($resource) {
    if ($resource === 'lead_rows') return true;
    return isset(sr_lead_table_map()[$resource]);
}

function sr_table_for_resource($resource) {
    $requested = $resource === 'lead_rows' ? (string)sr_input('table', 'lead_memberships') : $resource;
    $requested = strtolower(trim($requested));
    $map = sr_lead_table_map();
    if (!isset($map[$requested])) sr_error('Lead table is not allowed: ' . $requested, 400, ['allowed_tables' => array_values(array_unique($map))]);
    return $map[$requested];
}

function sr_lead_columns(SQLite3 $db, $table) {
    $columns = [];
    $res = $db->query('PRAGMA table_info(' . $table . ')');
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $columns[(string)$row['name']] = $row;
    }
    return $columns;
}

function sr_lead_table_docs() {
    $db = leadDb();
    $docs = [];
    foreach (array_values(array_unique(sr_lead_table_map())) as $table) {
        $columns = sr_lead_columns($db, $table);
        if (!$columns) continue;
        $docs[$table] = [
            'columns' => array_keys($columns),
            'primary_key' => isset($columns['id']) ? 'id' : null,
            'json_columns' => array_values(array_filter(array_keys($columns), function ($c) {
                return substr($c, -5) === '_json' || $c === 'metadata_json' || $c === 'context_json';
            })),
        ];
    }
    return $docs;
}

function sr_lead_rows_endpoint($table) {
    leadRequireAccess();
    $db = leadDb();
    $method = sr_method();

    if ($method === 'GET') {
        sr_lead_rows_get($db, $table);
    } elseif ($method === 'POST') {
        sr_lead_row_save($db, $table, false);
    } elseif (in_array($method, ['PUT', 'PATCH'], true)) {
        sr_lead_row_save($db, $table, true);
    } elseif ($method === 'DELETE') {
        sr_lead_row_delete($db, $table);
    } else {
        sr_error('Unsupported method for lead table', 405);
    }
}

function sr_lead_rows_get(SQLite3 $db, $table) {
    $columns = sr_lead_columns($db, $table);
    if (!$columns) sr_error('Unknown lead table', 404);

    $id = trim((string)sr_input('id', ''));
    if ($id !== '') {
        if ($table === 'lead_memberships' && sr_bool(sr_input('hydrate', false))) {
            $row = leadHydratedRow($db, $id, leadActorEmail());
            if (!$row) sr_error('Lead not found', 404);
            sr_json(['success' => true, 'table' => $table, 'row' => $row]);
        }
        $row = sr_sql_one($db, 'SELECT * FROM ' . $table . ' WHERE id = :id LIMIT 1', [':id' => $id]);
        if (!$row) sr_error('Row not found', 404);
        sr_decode_json_columns($row);
        sr_json(['success' => true, 'table' => $table, 'row' => $row]);
    }

    $where = [];
    $binds = [];
    $filterKeys = [
        'list_id', 'lead_id', 'lead_entity_id', 'organization_id', 'status',
        'assigned_to_email', 'owner_email', 'region', 'region_code',
        'external_key', 'source', 'source_kind', 'source_key',
        'import_type', 'preview_token', 'contact_id', 'dial_event_id',
    ];
    foreach ($filterKeys as $key) {
        $value = trim((string)sr_input($key, ''));
        if ($value === '' || !isset($columns[$key])) continue;
        $where[] = $key . ' = :' . $key;
        $binds[':' . $key] = $value;
    }

    $q = trim((string)sr_input('q', ''));
    if ($q !== '') {
        $qCols = array_values(array_filter(['name', 'company', 'lead_name', 'email', 'phone', 'address', 'city', 'state', 'postal_code', 'website', 'notes', 'description', 'filename'], function ($c) use ($columns) {
            return isset($columns[$c]);
        }));
        if ($qCols) {
            $parts = [];
            foreach ($qCols as $idx => $col) {
                $key = ':q' . $idx;
                $parts[] = $col . ' LIKE ' . $key;
                $binds[$key] = '%' . $q . '%';
            }
            $where[] = '(' . implode(' OR ', $parts) . ')';
        }
    }

    $orderBy = preg_replace('/[^a-zA-Z0-9_]/', '', (string)sr_input('order_by', isset($columns['updated_at']) ? 'updated_at' : 'id'));
    if (!isset($columns[$orderBy])) $orderBy = isset($columns['id']) ? 'id' : array_key_first($columns);
    $orderDir = strtolower(trim((string)sr_input('order_dir', 'desc'))) === 'asc' ? 'ASC' : 'DESC';
    $limit = sr_limit(100, 1000);
    $offset = sr_offset();

    $sql = 'SELECT * FROM ' . $table;
    if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
    $countSql = 'SELECT COUNT(1) AS c FROM ' . $table . ($where ? ' WHERE ' . implode(' AND ', $where) : '');
    $sql .= ' ORDER BY ' . $orderBy . ' ' . $orderDir . ' LIMIT :limit OFFSET :offset';

    $total = (int)(sr_sql_one($db, $countSql, $binds)['c'] ?? 0);
    $stmt = $db->prepare($sql);
    foreach ($binds as $key => $value) leadBindText($stmt, $key, $value);
    $stmt->bindValue(':limit', $limit, SQLITE3_INTEGER);
    $stmt->bindValue(':offset', $offset, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        sr_decode_json_columns($row);
        $rows[] = $row;
    }

    sr_json([
        'success' => true,
        'table' => $table,
        'rows' => $rows,
        'pagination' => ['total' => $total, 'limit' => $limit, 'offset' => $offset, 'returned' => count($rows)],
    ]);
}

function sr_lead_row_save(SQLite3 $db, $table, $requireExisting) {
    $columns = sr_lead_columns($db, $table);
    if (!$columns || !isset($columns['id'])) sr_error('Table is not writable through this generic endpoint', 400);

    $payload = sr_payload();
    $record = is_array($payload['record'] ?? null) ? $payload['record'] : $payload;
    if (!is_array($record)) sr_error('Provide a JSON object or {record:{...}}');

    $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $now = time();
    $id = trim((string)($record['id'] ?? sr_input('id', '')));
    if ($id === '') {
        $prefix = $table === 'lead_lists' ? 'list' : ($table === 'lead_entities' ? 'entity' : 'row');
        $id = function_exists('leadId') ? leadId($prefix) : ($prefix . '_' . bin2hex(random_bytes(8)));
    }
    $record['id'] = $id;
    if (isset($columns['updated_at']) && !isset($record['updated_at'])) $record['updated_at'] = $now;
    if (isset($columns['updated_by_email']) && !isset($record['updated_by_email'])) $record['updated_by_email'] = $actor;
    if (isset($columns['created_at']) && !isset($record['created_at'])) $record['created_at'] = $now;
    if (isset($columns['created_by_email']) && !isset($record['created_by_email'])) $record['created_by_email'] = $actor;

    $exists = sr_sql_one($db, 'SELECT id FROM ' . $table . ' WHERE id = :id LIMIT 1', [':id' => $id]);
    if ($requireExisting && !$exists) sr_error('Row not found for update', 404);

    $fields = [];
    foreach ($record as $key => $value) {
        if (!isset($columns[$key])) continue;
        if (substr($key, -5) === '_json' && is_array($value)) $value = json_encode($value, JSON_UNESCAPED_SLASHES);
        $fields[$key] = $value;
    }
    if (!$fields) sr_error('No writable fields supplied');

    if ($exists) {
        $sets = [];
        foreach ($fields as $key => $value) {
            if ($key === 'id') continue;
            $sets[] = $key . ' = :' . $key;
        }
        if (!$sets) sr_error('No update fields supplied');
        $stmt = $db->prepare('UPDATE ' . $table . ' SET ' . implode(', ', $sets) . ' WHERE id = :id');
    } else {
        $names = array_keys($fields);
        $stmt = $db->prepare('INSERT INTO ' . $table . ' (' . implode(', ', $names) . ') VALUES (:' . implode(', :', $names) . ')');
    }
    foreach ($fields as $key => $value) {
        if ($value === null) $stmt->bindValue(':' . $key, null, SQLITE3_NULL);
        elseif (is_int($value) || preg_match('/_at$|_count$|sort_order/', $key)) $stmt->bindValue(':' . $key, (int)$value, SQLITE3_INTEGER);
        elseif (is_float($value)) $stmt->bindValue(':' . $key, (float)$value, SQLITE3_FLOAT);
        else leadBindText($stmt, ':' . $key, is_array($value) ? json_encode($value) : $value);
    }
    if ($exists && !array_key_exists('id', $fields)) leadBindText($stmt, ':id', $id);
    $ok = (bool)$stmt->execute();
    if (!$ok) sr_error('Could not save row', 500, ['sqlite_error' => $db->lastErrorMsg()]);

    if ($table === 'lead_memberships' && isset($fields['list_id'])) {
        leadSyncListLeadCount($db, (string)$fields['list_id']);
    }

    $row = sr_sql_one($db, 'SELECT * FROM ' . $table . ' WHERE id = :id LIMIT 1', [':id' => $id]);
    sr_decode_json_columns($row);
    sr_json(['success' => true, 'table' => $table, 'id' => $id, 'row' => $row, 'mode' => $exists ? 'updated' : 'created']);
}

function sr_lead_row_delete(SQLite3 $db, $table) {
    $columns = sr_lead_columns($db, $table);
    if (!$columns || !isset($columns['id'])) sr_error('Table is not deletable through this endpoint', 400);
    $id = trim((string)sr_input('id', ''));
    if ($id === '') sr_error('Missing id');

    $row = sr_sql_one($db, 'SELECT * FROM ' . $table . ' WHERE id = :id LIMIT 1', [':id' => $id]);
    if (!$row) sr_error('Row not found', 404);

    $stmt = $db->prepare('DELETE FROM ' . $table . ' WHERE id = :id');
    leadBindText($stmt, ':id', $id);
    $ok = (bool)$stmt->execute();
    if (!$ok) sr_error('Could not delete row', 500, ['sqlite_error' => $db->lastErrorMsg()]);

    if ($table === 'lead_memberships') {
        if (!empty($row['list_id'])) leadSyncListLeadCount($db, (string)$row['list_id']);
        if (!empty($row['lead_entity_id']) && function_exists('leadDeleteOrphanEntity')) {
            leadDeleteOrphanEntity($db, (string)$row['lead_entity_id']);
        }
    }

    sr_json(['success' => true, 'table' => $table, 'id' => $id, 'deleted' => true]);
}

function sr_lead_save_endpoint() {
    if (!in_array(sr_method(), ['POST', 'PUT', 'PATCH'], true)) sr_error('Use POST, PUT, or PATCH for lead_save', 405);
    leadRequireAccess();
    $db = leadDb();
    $payload = sr_payload();
    $record = is_array($payload['record'] ?? null) ? $payload['record'] : $payload;
    if (!is_array($record)) sr_error('Provide a lead JSON object');
    $listId = trim((string)($record['list_id'] ?? sr_input('list_id', '')));
    if ($listId === '') sr_error('Missing list_id');
    if (!leadListRowById($db, $listId)) sr_error('Lead list not found', 404);

    $metadata = $record['metadata_json'] ?? ($record['metadata'] ?? []);
    if (!is_array($metadata)) $metadata = [];
    $leadData = [
        'organization_id' => (string)($record['organization_id'] ?? ''),
        'external_key' => (string)($record['external_key'] ?? ''),
        'region' => (string)($record['region'] ?? ''),
        'region_code' => (string)($record['region_code'] ?? ''),
        'status' => (string)($record['status'] ?? 'new'),
        'lead_name' => (string)($record['lead_name'] ?? ''),
        'company' => (string)($record['company'] ?? ''),
        'email' => strtolower(trim((string)($record['email'] ?? ''))),
        'phone' => (string)($record['phone'] ?? ''),
        'address' => (string)($record['address'] ?? ''),
        'city' => (string)($record['city'] ?? ''),
        'state' => (string)($record['state'] ?? ''),
        'postal_code' => (string)($record['postal_code'] ?? ''),
        'website' => (string)($record['website'] ?? ''),
        'notes' => (string)($record['notes'] ?? ''),
        'source' => (string)($record['source'] ?? ''),
        'assigned_to_email' => strtolower(trim((string)($record['assigned_to_email'] ?? ''))),
        'metadata_json' => $metadata,
    ];
    $id = trim((string)($record['id'] ?? sr_input('id', '')));
    $saved = leadSaveMembershipRecord($db, $id, $listId, $leadData, leadActorEmail(), time());
    if (empty($saved['success'])) sr_error((string)($saved['error'] ?? 'Could not save lead'), 400, ['details' => $saved]);

    $leadId = (string)($saved['id'] ?? $id);
    $row = sr_bool(sr_input('hydrate', true), true)
        ? leadHydratedRow($db, $leadId, leadActorEmail())
        : leadRowById($db, $leadId);
    sr_json(['success' => true, 'id' => $leadId, 'lead_entity_id' => $saved['lead_entity_id'] ?? '', 'lead' => $row]);
}

function sr_sql_one(SQLite3 $db, $sql, $binds = []) {
    $stmt = $db->prepare($sql);
    foreach ($binds as $key => $value) leadBindText($stmt, $key, $value);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return $row ?: null;
}

function sr_decode_json_columns(&$row) {
    if (!is_array($row)) return;
    foreach (array_keys($row) as $key) {
        if (substr($key, -5) !== '_json' || !is_string($row[$key]) || trim($row[$key]) === '') continue;
        $decoded = json_decode($row[$key], true);
        if (json_last_error() === JSON_ERROR_NONE) {
            $plain = substr($key, 0, -5);
            $row[$plain === 'metadata' ? 'metadata' : $plain] = $decoded;
        }
    }
}

function sr_storage_root() {
    $root = __DIR__ . '/storage';
    if (!is_dir($root)) @mkdir($root, 0775, true);
    $real = realpath($root);
    return $real ? rtrim($real, '/\\') : rtrim($root, '/\\');
}

function sr_storage_path($relative, $ensureParent = false) {
    $relative = str_replace('\\', '/', (string)$relative);
    $relative = preg_replace('#/+#', '/', $relative);
    $relative = ltrim($relative, '/');
    $parts = [];
    foreach (explode('/', $relative) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') sr_error('Storage paths cannot contain ..', 400);
        $parts[] = preg_replace('/[^a-zA-Z0-9_\-. @]/', '_', $part);
    }
    $clean = implode('/', $parts);
    $root = sr_storage_root();
    $path = $root . ($clean !== '' ? '/' . $clean : '');
    $parent = dirname($path);
    if ($ensureParent && !is_dir($parent)) @mkdir($parent, 0775, true);
    $realParent = realpath(is_dir($path) ? $path : $parent);
    if ($realParent && strpos(rtrim($realParent, '/\\'), $root) !== 0) sr_error('Storage path escapes sales/storage', 400);
    return [$path, $clean];
}

function sr_storage_endpoint() {
    $method = sr_method();
    [$path, $relative] = sr_storage_path(sr_input('path', ''), in_array($method, ['POST', 'PUT', 'PATCH'], true));

    if ($method === 'GET') {
        if (is_dir($path)) {
            $items = [];
            foreach (scandir($path) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..') continue;
                $child = rtrim($path, '/\\') . '/' . $entry;
                $items[] = [
                    'name' => $entry,
                    'path' => ltrim(($relative !== '' ? $relative . '/' : '') . $entry, '/'),
                    'type' => is_dir($child) ? 'directory' : 'file',
                    'size' => is_file($child) ? filesize($child) : null,
                    'modified_at' => date('c', filemtime($child)),
                ];
            }
            sr_json(['success' => true, 'path' => $relative, 'type' => 'directory', 'items' => $items]);
        }
        if (!is_file($path)) sr_error('Storage file not found', 404);
        $raw = (string)file_get_contents($path);
        if (sr_bool(sr_input('raw', false))) {
            header_remove('Content-Type');
            header('Content-Type: ' . (function_exists('mime_content_type') ? (mime_content_type($path) ?: 'application/octet-stream') : 'application/octet-stream'));
            header('Content-Length: ' . strlen($raw));
            echo $raw;
            exit;
        }
        $isUtf8 = function_exists('mb_check_encoding')
            ? mb_check_encoding($raw, 'UTF-8')
            : (preg_match('//u', $raw) === 1);
        sr_json([
            'success' => true,
            'path' => $relative,
            'type' => 'file',
            'size' => filesize($path),
            'modified_at' => date('c', filemtime($path)),
            'encoding' => $isUtf8 ? 'utf8' : 'base64',
            'content' => $isUtf8 ? $raw : base64_encode($raw),
            'json' => $isUtf8 ? json_decode($raw, true) : null,
        ]);
    }

    if (in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
        if ($relative === '') sr_error('Missing storage path');
        $payload = sr_payload();
        if (array_key_exists('data', $payload)) {
            $content = json_encode($payload['data'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        } elseif (array_key_exists('content', $payload)) {
            $content = (string)$payload['content'];
            if (sr_bool($payload['base64'] ?? false)) $content = base64_decode($content, true);
        } else {
            $content = sr_request_body();
        }
        if ($content === false) sr_error('Invalid base64 content');
        $bytes = sr_bool(sr_input('append', false)) ? file_put_contents($path, $content, FILE_APPEND) : file_put_contents($path, $content);
        if ($bytes === false) sr_error('Could not write storage file', 500);
        sr_json(['success' => true, 'path' => $relative, 'bytes_written' => $bytes]);
    }

    if ($method === 'DELETE') {
        if ($relative === '') sr_error('Refusing to delete the storage root');
        if (!file_exists($path)) sr_json(['success' => true, 'path' => $relative, 'deleted' => false]);
        if (is_dir($path)) {
            if (!sr_bool(sr_input('recursive', false))) sr_error('Directory delete requires recursive=1');
            sr_delete_tree($path);
        } else {
            @unlink($path);
        }
        sr_json(['success' => true, 'path' => $relative, 'deleted' => true]);
    }

    sr_error('Unsupported method for storage', 405);
}

function sr_delete_tree($path) {
    foreach (scandir($path) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $child = rtrim($path, '/\\') . '/' . $entry;
        if (is_dir($child)) sr_delete_tree($child);
        else @unlink($child);
    }
    @rmdir($path);
}
