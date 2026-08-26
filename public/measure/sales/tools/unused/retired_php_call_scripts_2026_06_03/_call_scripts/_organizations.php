<?php
require_once dirname(__DIR__) . '/_storage.php';
/**
 * _organizations.php
 *
 * Organization-related functions and action handlers.
 * This file should be included AFTER all config, globals are defined,
 * and BEFORE _users.php (since users depend on org functions).
 *
 * Contains:
 * - Utility functions (atomicWriteJson, genHexId, etc.)
 * - Organization helper functions (read/write, ensure fields, etc.)
 * - Credits functions (resolve, get, add, spend)
 * - Internal mutation helpers
 * - Organization action handlers
 */

// ------------------------------------------------
// ---------------- UTILITY FUNCTIONS -------------
// ------------------------------------------------

function atomicWriteJson($path, $data) {
    $dir = dirname($path);
    if (!file_exists($dir)) @mkdir($dir, 0777, true);
    $tmp = $path . '.tmp_' . uniqid('', true);
    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) return false;
    if (@file_put_contents($tmp, $json) === false) return false;
    return @rename($tmp, $path);
}

function genHexId($bytes = 12) {
    try { return bin2hex(random_bytes($bytes)); }
    catch (Exception $e) { return bin2hex(openssl_random_pseudo_bytes($bytes)); }
}

// ------------------------------------------------
// ---------------- ORG HELPER FUNCTIONS ----------
// ------------------------------------------------

function orgNormalizeId($id) {
    $id = strtolower(trim((string)$id));
    $id = preg_replace('/[^a-f0-9]/', '', $id);
    return $id;
}

function orgDirPath() {
    $p = $GLOBALS['orgDir'] ?? (storageDir('organizations'));
    if (!file_exists($p)) @mkdir($p, 0777, true);
    return rtrim($p, '/\\') . '/';
}

function orgPath($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    return orgDirPath() . $orgId . '/';
}

function orgManifestPath($orgId) {
    $dir = orgPath($orgId);
    if (!$dir) return null;
    return $dir . 'manifest.json';
}

function orgEnsureCreditsFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['credits_balance'])) $o['credits_balance'] = 0;
    if (!is_int($o['credits_balance'])) $o['credits_balance'] = (int)$o['credits_balance'];
    if (!isset($o['credits_ledger']) || !is_array($o['credits_ledger'])) $o['credits_ledger'] = [];
}

function orgEnsureBrandingFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['branding']) || !is_array($o['branding'])) $o['branding'] = [];
    if (!isset($o['branding']['logo']) ) $o['branding']['logo'] = null;
    if (!isset($o['branding']['colors']) || !is_array($o['branding']['colors'])) $o['branding']['colors'] = [];
    $defaults = [
        'primary'   => '#DB0000',
        'secondary' => '#111111',
        'accent'    => '#1A73E8',
    ];
    foreach ($defaults as $k=>$v) {
        if (empty($o['branding']['colors'][$k])) $o['branding']['colors'][$k] = $v;
        $o['branding']['colors'][$k] = orgNormalizeHexColor($o['branding']['colors'][$k], $v);
    }
}

function orgNormalizeHexColor($hex, $fallback = '#000000') {
    $hex = strtoupper(trim((string)$hex));
    if ($hex === '') return $fallback;
    if ($hex[0] !== '#') $hex = '#' . $hex;
    if (!preg_match('/^#[0-9A-F]{6}$/', $hex)) return $fallback;
    return $hex;
}

// ---------------- ORG REPORT SETTINGS HELPERS ----------------

function orgEnsureReportSettingsFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['report_settings']) || !is_array($o['report_settings'])) {
        $o['report_settings'] = [];
    }
    // Support both legacy flat object and new {general, customer}
    $rs = $o['report_settings'];
    // If someone accidentally stored the old "customer flags" flat at report_settings
    // (no general/customer keys), normalize it.
    $hasBuckets = (is_array($rs) && (isset($rs['general']) || isset($rs['customer'])));
    if (!$hasBuckets) {
        $o['report_settings'] = [
            'general' => $rs,
            'customer' => $rs,
        ];
        $rs = $o['report_settings'];
    }
    if (!isset($o['report_settings']['general']) || !is_array($o['report_settings']['general'])) {
        $o['report_settings']['general'] = [];
    }
    if (!isset($o['report_settings']['customer']) || !is_array($o['report_settings']['customer'])) {
        $o['report_settings']['customer'] = [];
    }
    // ---- General defaults ----
    // Your UI calls it nfva_ratio (user said NMVA; we accept both).
    if (!array_key_exists('nfva_ratio', $o['report_settings']['general'])) {
        // if someone stored nmva_ratio, map it over
        if (array_key_exists('nmva_ratio', $o['report_settings']['general'])) {
            $o['report_settings']['general']['nfva_ratio'] = $o['report_settings']['general']['nmva_ratio'];
        } else {
            $o['report_settings']['general']['nfva_ratio'] = 300;
        }
    }
    $o['report_settings']['general']['nfva_ratio'] = max(1, min(1000, (int)$o['report_settings']['general']['nfva_ratio']));
    // ---- Customer defaults ----
    $defaults = [
        'cover_show_customer' => true,
        'cover_show_squares' => true,
        'cover_show_waste' => true,
        'cover_show_breakdown' => true,
        'cover_show_pitch' => true,
        'cover_show_facets' => true,
        'page_top_view' => true,
        'page_elevations' => true,
        'page_3d' => true,
        'page_pitch' => true,
        'page_area' => true,
        'page_layers' => true,
        'page_summary' => true,
        'page_materials' => true,
        'page_ventilation' => true
    ];
    foreach ($defaults as $k => $v) {
        if (!array_key_exists($k, $o['report_settings']['customer'])) {
            $o['report_settings']['customer'][$k] = $v;
        } else {
            $o['report_settings']['customer'][$k] = !!$o['report_settings']['customer'][$k];
        }
    }
}

function orgEnsureUsersFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['users']) || !is_array($o['users'])) $o['users'] = [];
    if (!isset($o['users_meta']) || !is_array($o['users_meta'])) $o['users_meta'] = []; // optional convenience map
}

function orgEnsureDefaults(&$o) {
    if (!is_array($o)) $o = [];
    if (empty($o['id'])) $o['id'] = null;
    if (!isset($o['name'])) $o['name'] = '';
    if (!isset($o['created_at'])) $o['created_at'] = gmdate('c');
    if (!isset($o['created_by_user_id'])) $o['created_by_user_id'] = null;
    if (!isset($o['created_by_email'])) $o['created_by_email'] = null;
    // ── Test organization flag ──
    if (!array_key_exists('is_test', $o)) $o['is_test'] = false;
    $o['is_test'] = !!$o['is_test'];
    if (!array_key_exists('assigned_sales_email', $o)) $o['assigned_sales_email'] = '';
    if (!array_key_exists('assigned_sales_name', $o)) $o['assigned_sales_name'] = '';
    if (!array_key_exists('assigned_sales_by_email', $o)) $o['assigned_sales_by_email'] = '';
    if (!array_key_exists('assigned_sales_at', $o)) $o['assigned_sales_at'] = null;
    if (!array_key_exists('paired_lead_ids', $o) || !is_array($o['paired_lead_ids'])) $o['paired_lead_ids'] = [];
    if (!array_key_exists('paired_primary_lead_id', $o)) $o['paired_primary_lead_id'] = '';
    if (!array_key_exists('paired_at', $o)) $o['paired_at'] = null;
    orgEnsureUsersFields($o);
    orgEnsureCreditsFields($o);
    orgEnsureBrandingFields($o);
    orgEnsureBillingFields($o);
    orgEnsureReportSettingsFields($o);
    // NEW: contact block
    if (!isset($o['contact']) || !is_array($o['contact'])) $o['contact'] = [];
    if (!array_key_exists('email', $o['contact'])) $o['contact']['email'] = '';
    if (!array_key_exists('phone', $o['contact'])) $o['contact']['phone'] = '';
    if (!array_key_exists('address', $o['contact'])) $o['contact']['address'] = '';
    if (!is_string($o['contact']['email'])) $o['contact']['email'] = '';
    if (!is_string($o['contact']['phone'])) $o['contact']['phone'] = '';
    if (!is_string($o['contact']['address'])) $o['contact']['address'] = '';
}

function orgActorCanManageCustomers() {
    $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($actor === '') return false;
    if (function_exists('isAdmin') && isAdmin()) return true;
    if (function_exists('userHasPerm') && (userHasPerm($actor, 'manage_users') || userHasPerm($actor, 'manage_sales_users'))) {
        return true;
    }
    $u = function_exists('readUserDataByEmail') ? readUserDataByEmail($actor) : null;
    $role = strtolower(trim((string)($u['role'] ?? '')));
    return in_array($role, ['admin', 'system_admin', 'sales_manager'], true);
}

function orgActorCanViewAllCustomers() {
    return orgActorCanManageCustomers();
}

function orgSalesUsersList() {
    if (function_exists('leadSalesUsers')) return leadSalesUsers();
    $rows = [];
    $userDir = storageDir('users');
    foreach (glob($userDir . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) === 'customer') continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        if ($email === '') continue;
        $perms = is_array($u['permissions'] ?? null) ? $u['permissions'] : [];
        $role = strtolower(trim((string)($u['role'] ?? '')));
        $dept = strtolower(trim((string)($u['department'] ?? '')));
        if ($dept !== 'sales' && empty($perms['manage_sales_users']) && !in_array($role, ['sales_manager', 'admin', 'system_admin'], true)) continue;
        $rows[] = [
            'email' => $email,
            'name' => (string)($u['name'] ?? $email),
            'role' => (string)($u['role'] ?? 'user'),
            'department' => (string)($u['department'] ?? ''),
        ];
    }
    usort($rows, function($a, $b) {
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    return $rows;
}

function orgCustomerDataSnapshot($actorEmail) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $canViewAll = orgActorCanViewAllCustomers();
    $orgMap = [];
    $orgDirPath = orgDirPath();
    if (is_dir($orgDirPath)) {
        foreach (scandir($orgDirPath) as $f) {
            if ($f === '.' || $f === '..') continue;
            $manifestPath = $orgDirPath . $f . '/manifest.json';
            if (!file_exists($manifestPath)) continue;
            $o = json_decode((string)@file_get_contents($manifestPath), true);
            if (!is_array($o)) continue;
            orgEnsureDefaults($o);
            $oid = orgNormalizeId($o['id'] ?? $f);
            if ($oid === '') continue;
            $assigned = strtolower(trim((string)($o['assigned_sales_email'] ?? '')));
            if (!$canViewAll && $assigned !== $actorEmail) continue;
            $orgMap[$oid] = [
                'id' => $oid,
                'name' => (string)($o['name'] ?? $oid),
                'is_test' => !empty($o['is_test']),
                'created_at' => $o['created_at'] ?? null,
                'credits_balance' => (int)($o['credits_balance'] ?? 0),
                'credits_ledger' => is_array($o['credits_ledger'] ?? null) ? $o['credits_ledger'] : [],
                'assigned_sales_email' => $assigned,
                'assigned_sales_name' => (string)($o['assigned_sales_name'] ?? ''),
                'assigned_sales_by_email' => (string)($o['assigned_sales_by_email'] ?? ''),
                'assigned_sales_at' => $o['assigned_sales_at'] ?? null,
                'paired_lead_ids' => array_values(array_filter(array_map('strval', $o['paired_lead_ids'] ?? []))),
                'paired_primary_lead_id' => (string)($o['paired_primary_lead_id'] ?? ''),
                'paired_at' => $o['paired_at'] ?? null,
                'contact' => is_array($o['contact'] ?? null) ? $o['contact'] : ['email' => '', 'phone' => '', 'address' => ''],
                'users' => [],
                'orders' => [],
                'lifetimeOrders' => 0,
                'rolling7' => 0,
                'avgOrdersDay' => 0,
            ];
        }
    }

    $customerUsers = [];
    foreach (glob(storageDir('users') . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) !== 'customer') continue;
        $orgId = orgNormalizeId($u['organization_id'] ?? '');
        if ($orgId === '' || !isset($orgMap[$orgId])) continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        $customerUsers[$email] = [
            'email' => $email,
            'org_id' => $orgId,
            'name' => (string)($u['name'] ?? ''),
            'phone' => (string)($u['phone'] ?? ''),
            'created_at' => $u['created_at'] ?? null,
            'org_permission_level' => (string)(($u['org_permissions']['level'] ?? 'viewer')),
        ];
        $orgMap[$orgId]['users'][] = [
            'id' => (string)($u['id'] ?? ''),
            'email' => $email,
            'name' => (string)($u['name'] ?? ''),
            'phone' => (string)($u['phone'] ?? ''),
            'created_at' => $u['created_at'] ?? null,
            'orderCount' => 0,
            'org_permission_level' => (string)(($u['org_permissions']['level'] ?? 'viewer')),
        ];
        if (!$orgMap[$orgId]['created_at'] && !empty($u['created_at'])) $orgMap[$orgId]['created_at'] = $u['created_at'];
    }

    $orderBuckets = [];
    if (function_exists('projectIndexDb')) {
        try {
            $pdb = projectIndexDb();
            $res = $pdb->query("
                SELECT
                    COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) AS email,
                    COUNT(1) AS order_count,
                    SUM(CASE WHEN COALESCE(ca, 0) >= strftime('%s','now','-7 day') THEN 1 ELSE 0 END) AS rolling7,
                    MIN(COALESCE(ca, qa, da, pa, 0)) AS first_touch
                FROM manifests
                WHERE COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) <> ''
                GROUP BY COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie)))
            ");
            while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                $email = strtolower(trim((string)($row['email'] ?? '')));
                if ($email === '' || !isset($customerUsers[$email])) continue;
                $orgId = $customerUsers[$email]['org_id'];
                if (!isset($orderBuckets[$orgId])) $orderBuckets[$orgId] = ['lifetime' => 0, 'rolling7' => 0];
                $orderBuckets[$orgId]['lifetime'] += (int)($row['order_count'] ?? 0);
                $orderBuckets[$orgId]['rolling7'] += (int)($row['rolling7'] ?? 0);
                foreach ($orgMap[$orgId]['users'] as &$userRow) {
                    if (strtolower(trim((string)$userRow['email'])) === $email) {
                        $userRow['orderCount'] = (int)($row['order_count'] ?? 0);
                        break;
                    }
                }
                unset($userRow);
            }
            $res2 = $pdb->query("
                SELECT
                    ad AS address,
                    st AS status,
                    ow AS owner_email,
                    ie AS issuer_email,
                    ca AS created_at
                FROM manifests
                WHERE COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) <> ''
                ORDER BY COALESCE(ca, 0) DESC
            ");
            while ($res2 && ($row = $res2->fetchArray(SQLITE3_ASSOC))) {
                $ownerEmail = strtolower(trim((string)($row['owner_email'] ?? '')));
                $issuerEmail = strtolower(trim((string)($row['issuer_email'] ?? '')));
                $email = $ownerEmail !== '' ? $ownerEmail : $issuerEmail;
                if ($email === '' || !isset($customerUsers[$email])) continue;
                $orgId = $customerUsers[$email]['org_id'];
                $orgMap[$orgId]['orders'][] = [
                    'address' => (string)($row['address'] ?? ''),
                    'status' => (string)($row['status'] ?? ''),
                    'owner_email' => $ownerEmail,
                    'issuer' => ['email' => $issuerEmail],
                    'created_at' => !empty($row['created_at']) ? date('c', (int)$row['created_at']) : null,
                ];
            }
        } catch (Throwable $e) {
        }
    }

    foreach ($orgMap as $orgId => &$org) {
        $bucket = $orderBuckets[$orgId] ?? ['lifetime' => 0, 'rolling7' => 0];
        $org['lifetimeOrders'] = (int)$bucket['lifetime'];
        $org['rolling7'] = (int)$bucket['rolling7'];
        $org['avgOrdersDay'] = round($org['rolling7'] / 7, 2);
        usort($org['users'], function($a, $b) {
            return strcmp((string)($a['name'] ?: $a['email']), (string)($b['name'] ?: $b['email']));
        });
    }
    unset($org);

    return array_values($orgMap);
}

function orgFreeEmailDomains() {
    return [
        'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com',
        'rocketmail.com','icloud.com','me.com','mac.com','aol.com','protonmail.com','pm.me','att.net','comcast.net',
        'verizon.net','sbcglobal.net','bellsouth.net','cox.net','mail.com'
    ];
}

function orgEmailDomain($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || strpos($email, '@') === false) return '';
    $parts = explode('@', $email);
    $domain = trim((string)end($parts));
    if ($domain === '' || in_array($domain, orgFreeEmailDomains(), true)) return '';
    return $domain;
}

function orgNormPhone($phone) {
    $digits = preg_replace('/\D+/', '', (string)$phone);
    if (strlen($digits) === 11 && $digits[0] === '1') $digits = substr($digits, 1);
    return strlen($digits) >= 10 ? $digits : '';
}

// ---------------- ORG BILLING HELPERS ----------------

function orgEnsureBillingFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['billing']) || !is_array($o['billing'])) $o['billing'] = [];
    if (!isset($o['billing']['auto_topup']) || !is_array($o['billing']['auto_topup'])) {
        $o['billing']['auto_topup'] = [];
    }
    $at =& $o['billing']['auto_topup'];
    if (!array_key_exists('enabled', $at)) $at['enabled'] = false;
    $at['enabled'] = !!$at['enabled'];
    if (!array_key_exists('threshold_dollars', $at)) $at['threshold_dollars'] = 70;
    if (!array_key_exists('topup_dollars', $at)) $at['topup_dollars'] = 70;
    $at['threshold_dollars'] = max(35, (int)$at['threshold_dollars']);
    $at['topup_dollars']     = max(35, (int)$at['topup_dollars']);
    if (!array_key_exists('cooldown_minutes', $at)) $at['cooldown_minutes'] = 10;
    $at['cooldown_minutes'] = max(1, (int)$at['cooldown_minutes']);
    if (!array_key_exists('last_attempt_utc', $at)) $at['last_attempt_utc'] = null;
    if (!array_key_exists('last_success_utc', $at)) $at['last_success_utc'] = null;
    if (!array_key_exists('status', $at)) $at['status'] = 'idle'; // idle|ok|cooldown|failed|needs_payment_method
    if (!array_key_exists('last_error', $at)) $at['last_error'] = null;
    if (!isset($o['billing']['stripe']) || !is_array($o['billing']['stripe'])) {
        $o['billing']['stripe'] = [];
    }
    $s =& $o['billing']['stripe'];
    foreach (['customer_id','payment_method_id','brand','last4','exp_month','exp_year'] as $k) {
        if (!array_key_exists($k, $s)) $s[$k] = null;
    }
    if (!array_key_exists('has_payment_method', $s)) $s['has_payment_method'] = false;
    $s['has_payment_method'] = !!$s['has_payment_method'];
    if (!isset($o['billing']['events']) || !is_array($o['billing']['events'])) $o['billing']['events'] = [];
}

function orgBillingLogEvent(&$o, $type, $data = [], $cap = 100) {
    orgEnsureBillingFields($o);
    $ev = [
        'ts_utc' => gmdate('c'),
        'type' => (string)$type,
        'data' => is_array($data) ? $data : ['value'=>(string)$data],
    ];
    $o['billing']['events'][] = $ev;
    $cap = max(10, (int)$cap);
    if (count($o['billing']['events']) > $cap) {
        $o['billing']['events'] = array_slice($o['billing']['events'], -$cap);
    }
}

function orgRead($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    $mp = orgManifestPath($orgId);
    if (!$mp || !file_exists($mp)) return null;
    $o = json_decode(@file_get_contents($mp), true);
    if (!is_array($o)) $o = [];
    orgEnsureDefaults($o);
    $o['id'] = $orgId;
    return $o;
}

function orgWrite($orgId, $o) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return false;
    $dir = orgPath($orgId);
    if (!$dir) return false;
    if (!file_exists($dir)) @mkdir($dir, 0777, true);
    orgEnsureDefaults($o);
    $o['id'] = $orgId;
    $mp = $dir . 'manifest.json';
    return atomicWriteJson($mp, $o);
}

function orgCreate($name, $creatorUserId, $creatorEmail, $creatorName, $preferredId = null) {
    $base = orgDirPath();
    $orgId = $preferredId ? orgNormalizeId($preferredId) : '';
    if ($orgId === '') {
        for ($i=0; $i<20; $i++) {
            $candidate = genHexId(12);
            if (!file_exists($base . $candidate . '/manifest.json')) { $orgId = $candidate; break; }
        }
    }
    if ($orgId === '') return null;
    $o = [
        'id' => $orgId,
        'name' => (string)$name,
        'created_at' => gmdate('c'),
        'created_by_user_id' => $creatorUserId ?: null,
        'created_by_email' => $creatorEmail ?: null,
        'created_by_name' => $creatorName ?: null,
        'users' => [],
        'users_meta' => [],
        'credits_balance' => 0,
        'credits_ledger' => [],
        'is_test' => false,
        'branding' => [
            'logo' => null,
            'colors' => [
                'primary' => '#DB0000',
                'secondary' => '#111111',
                'accent' => '#1A73E8',
            ]
        ],
    ];
    orgEnsureDefaults($o);
    if (!orgWrite($orgId, $o)) return null;
    return $orgId;
}

function orgAddUserId($orgId, $userId, $email = null, $name = null) {
    $orgId = orgNormalizeId($orgId);
    $userId = strtolower(trim((string)$userId));
    if ($orgId === '' || $userId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureUsersFields($o);
    if (!in_array($userId, $o['users'], true)) $o['users'][] = $userId;
    $o['users_meta'][$userId] = [
        'id' => $userId,
        'email' => $email ? strtolower(trim((string)$email)) : ($o['users_meta'][$userId]['email'] ?? null),
        'name' => $name ? (string)$name : ($o['users_meta'][$userId]['name'] ?? null),
        'added_at' => $o['users_meta'][$userId]['added_at'] ?? gmdate('c'),
    ];
    $o['users'] = array_values(array_unique($o['users']));
    return orgWrite($orgId, $o);
}

// ------------------------------------------------
// ------------ ORG DEALS HELPERS -----------------
// ------------------------------------------------

/**
 * Ensure the org array has a claimed_deals sub-object.
 * Safe to call on any org regardless of age — orgs created before the deals
 * system existed simply won't have the key yet, and this adds it cleanly.
 */
function orgEnsureDealsFields(&$o) {
    if (!isset($o['claimed_deals']) || !is_array($o['claimed_deals'])) {
        $o['claimed_deals'] = [];
    }
}

/**
 * Check whether an org has already claimed a named deal.
 *
 * @param string $orgId
 * @param string $dealKey  e.g. 'signup_match_50'
 * @return bool
 */
function orgHasClaimedDeal($orgId, $dealKey) {
    $orgId = orgNormalizeId((string)$orgId);
    if ($orgId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureDealsFields($o);
    return !empty($o['claimed_deals'][$dealKey]);
}

/**
 * Stamp a deal as claimed on the org. Idempotent — safe to call twice.
 * Writes to disk immediately.
 *
 * @param string $orgId
 * @param string $dealKey  e.g. 'signup_match_50'
 * @param array  $meta     Optional context stored alongside the claim timestamp
 * @return bool  True on success
 */
function orgMarkDealClaimed($orgId, $dealKey, $meta = []) {
    $orgId = orgNormalizeId((string)$orgId);
    if ($orgId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureDealsFields($o);
    // Already claimed — don't overwrite the original timestamp
    if (!empty($o['claimed_deals'][$dealKey])) return true;
    $o['claimed_deals'][$dealKey]                   = true;
    $o['claimed_deals'][$dealKey . '_claimed_at']   = gmdate('c');
    if (!empty($meta)) {
        $o['claimed_deals'][$dealKey . '_meta'] = $meta;
    }
    return (bool)orgWrite($orgId, $o);
}

/**
 * Return true if the org has any Stripe purchase recorded in its credits ledger.
 *
 * This covers both manual checkouts (stripe_checkout_paid) and auto top-ups
 * (stripe_auto_topup). We use it to gate the first-purchase bonus — if they
 * have bought before, the deal is not available regardless of claimed_deals.
 *
 * @param string $orgId
 * @return bool
 */
function orgHasPreviousStripePurchase($orgId) {
    $orgId = orgNormalizeId((string)$orgId);
    if ($orgId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureCreditsFields($o);
    $ledger = $o['credits_ledger'] ?? [];
    if (!is_array($ledger)) return false;
    foreach ($ledger as $entry) {
        if (!is_array($entry)) continue;
        $reason = strtolower((string)($entry['reason'] ?? ''));
        // Any ledger entry whose reason starts with 'stripe_' counts as a prior purchase.
        // This catches: stripe_checkout_paid, stripe_auto_topup, stripe_manual_fulfill, etc.
        if (strpos($reason, 'stripe_') === 0) return true;
    }
    return false;
}

// ------------------------------------------------
// ---------------- CREDITS FUNCTIONS -------------
// ------------------------------------------------

// credits owner resolver (org if available, else user)
function creditsResolveOwnerByEmail($email) {
    $u = readUserDataByEmail($email);
    if (!$u) return ['ok'=>false,'error'=>'User not found'];
    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    if ($orgId !== '') {
        $o = orgRead($orgId);
        if ($o) return ['ok'=>true,'scope'=>'org','org_id'=>$orgId,'org'=>$o,'user'=>$u];
    }
    return ['ok'=>true,'scope'=>'user','user'=>$u];
}

function creditsGetBalanceByEmail($email) {
    $r = creditsResolveOwnerByEmail($email);
    if (empty($r['ok'])) return ['ok'=>false,'error'=>$r['error'] ?? 'resolve_failed'];
    if (($r['scope'] ?? '') === 'org') {
        orgEnsureCreditsFields($r['org']);
        return ['ok'=>true,'scope'=>'org','org_id'=>$r['org_id'],'balance'=>(int)$r['org']['credits_balance']];
    }
    ensureUserCreditsFields($r['user']);
    return ['ok'=>true,'scope'=>'user','balance'=>(int)$r['user']['credits_balance']];
}

function creditsAddByEmail($email, $amount, $reason, $meta = []) {
    $email = strtolower(trim((string)$email));
    $amount = (int)$amount;
    if ($email === '' || $amount === 0) return ['ok'=>false,'error'=>'bad_args'];
    $r = creditsResolveOwnerByEmail($email);
    if (empty($r['ok'])) return ['ok'=>false,'error'=>$r['error'] ?? 'resolve_failed'];
    $now = date('c');
    if (($r['scope'] ?? '') === 'org') {
        $o = $r['org'];
        orgEnsureCreditsFields($o);
        $o['credits_balance'] = (int)$o['credits_balance'] + $amount;
        $o['credits_ledger'][] = [
            'ts' => $now,
            'delta' => $amount,
            'reason' => (string)$reason,
            'by_email' => $_SESSION['user_email'] ?? null,
            'applied_for_user_email' => $email,
            'meta' => is_array($meta) ? $meta : [],
            'unit' => 'usd_dollars',
        ];
        if (!orgWrite($r['org_id'], $o)) return ['ok'=>false,'error'=>'org_write_failed'];
        return ['ok'=>true,'scope'=>'org','org_id'=>$r['org_id'],'new_balance'=>(int)$o['credits_balance']];
    }
    $u = $r['user'];
    ensureUserCreditsFields($u);
    $u['credits_balance'] = (int)$u['credits_balance'] + $amount;
    $u['credits_ledger'][] = [
        'ts' => $now,
        'delta' => $amount,
        'reason' => (string)$reason,
        'by_email' => $_SESSION['user_email'] ?? null,
        'meta' => is_array($meta) ? $meta : [],
        'unit' => 'usd_dollars',
    ];
    if (!writeUserDataByEmail($email, $u)) return ['ok'=>false,'error'=>'user_write_failed'];
    return ['ok'=>true,'scope'=>'user','new_balance'=>(int)$u['credits_balance']];
}

function creditsSpendByEmail($email, $amount, $reason, $meta = []) {
    $email = strtolower(trim((string)$email));
    $amount = (int)$amount;
    if ($email === '' || $amount < 1) return ['ok'=>false,'error'=>'bad_args'];
    $bal = creditsGetBalanceByEmail($email);
    if (empty($bal['ok'])) return $bal;
    if ((int)$bal['balance'] < $amount) {
        return ['ok'=>false,'error'=>'insufficient','balance'=>(int)$bal['balance']];
    }
    return creditsAddByEmail($email, -$amount, $reason, array_merge((array)$meta, [
        'spend' => $amount,
    ]));
}

function creditsRefundByEmail($email, $amount, $reason, $meta = []) {
    $email = strtolower(trim((string)$email));
    $amount = (int)$amount;
    if ($email === '' || $amount < 1) return ['ok'=>false,'error'=>'bad_args'];

    $result = creditsAddByEmail($email, $amount, $reason, array_merge((array)$meta, [
        'refund' => $amount,
    ]));

    if (!empty($result['ok'])) {
        $result['refunded'] = $amount;
    }

    return $result;
}

function orgCreateForNewSignup($email, $userId, $name, $company) {
    $company = trim((string)$company);
    if ($company === '') $company = trim((string)$name) !== '' ? (trim((string)$name) . ' Company') : 'My Company';
    $orgId = orgCreate($company, $userId, $email, $name);
    if (!$orgId) return null;
    // seed membership
    orgAddUserId($orgId, $userId, $email, $name);
    return $orgId;
}

// ------------------------------------------------
// ---------------- INTERNAL MUTATION HELPERS -----
// ------------------------------------------------

function internalMutationToken() {
    static $tok = null;
    if (is_string($tok) && $tok !== '') return $tok;
    $p = $GLOBALS['INTERNAL_MUTATION_TOKEN_PATH'] ?? null;
    if (!$p || !file_exists($p)) return null;
    $raw = trim((string)@file_get_contents($p));
    if ($raw === '') return null;
    $tok = $raw;
    return $tok;
}

function internalMutationAuthOrFail() {
    $need = internalMutationToken();
    if (!$need) {
        http_response_code(500);
        die(json_encode(['success'=>false,'error'=>'Internal mutation token missing on server']));
    }
    $got = '';
    if (isset($_POST['token'])) $got = (string)$_POST['token'];
    if ($got === '') {
        $hdr = $_SERVER['HTTP_X_INTERNAL_MUTATION_TOKEN'] ?? '';
        if ($hdr) $got = (string)$hdr;
    }
    if ($got === '') {
        http_response_code(403);
        die(json_encode(['success'=>false,'error'=>'Missing internal mutation token']));
    }
    // timing-safe compare
    if (function_exists('hash_equals')) {
        if (!hash_equals($need, $got)) {
            http_response_code(403);
            die(json_encode(['success'=>false,'error'=>'Bad internal mutation token']));
        }
    } else {
        if ($need !== $got) {
            http_response_code(403);
            die(json_encode(['success'=>false,'error'=>'Bad internal mutation token']));
        }
    }
}

function normalizeDotPath($path) {
    $path = trim((string)$path);
    if ($path === '') return null;
    $parts = explode('.', $path);
    $out = [];
    foreach ($parts as $seg) {
        $seg = trim($seg);
        if ($seg === '') return null;
        // only allow safe keys
        if (!preg_match('/^[A-Za-z0-9_\-]+$/', $seg)) return null;
        $out[] = $seg;
    }
    return $out;
}

function coerceJsonValue($raw) {
    // Accept already-decoded arrays/objects
    if (is_array($raw)) return $raw;
    $s = trim((string)$raw);
    if ($s === '') return '';
    // Try JSON first (objects/arrays/numbers/bools/null/strings)
    $j = json_decode($s, true);
    if (json_last_error() === JSON_ERROR_NONE) return $j;
    // Common primitives if not valid JSON
    $low = strtolower($s);
    if ($low === 'null') return null;
    if ($low === 'true') return true;
    if ($low === 'false') return false;
    // Numeric
    if (preg_match('/^-?\d+$/', $s)) return (int)$s;
    if (preg_match('/^-?\d+\.\d+$/', $s)) return (float)$s;
    // Fallback: string
    return $s;
}

function arraySetByPath(&$arr, $pathParts, $value) {
    if (!is_array($arr)) $arr = [];
    $ref =& $arr;
    $n = count($pathParts);
    for ($i = 0; $i < $n; $i++) {
        $k = $pathParts[$i];
        if ($i === $n - 1) {
            $ref[$k] = $value;
            return true;
        }
        if (!isset($ref[$k]) || !is_array($ref[$k])) $ref[$k] = [];
        $ref =& $ref[$k];
    }
    return false;
}

function orgLogoRelUrl($orgId, $filename) {
    $orgId = orgNormalizeId($orgId);
    $filename = ltrim((string)$filename, '/\\');
    return 'organizations/' . $orgId . '/' . $filename;
}

// ------------------------------------------------
// ---------------- ORG ACTION HANDLERS -----------
// ------------------------------------------------

function handleOrganizationActions($action) {
    global $userDir;
    
    // ---------------- ORG GET (my org) ----------------
    if ($action === 'org_get_my') {
        requireLoginOrFail();
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureDefaults($o);               // ✅ ensures contact/billing/report_settings exist
        orgEnsureBrandingFields($o);
        orgEnsureBillingFields($o);
        orgEnsureReportSettingsFields($o);
        $branding = $o['branding'] ?? [];
        $colors = (is_array($branding) && isset($branding['colors']) && is_array($branding['colors'])) ? $branding['colors'] : [];
        $contact = (isset($o['contact']) && is_array($o['contact'])) ? $o['contact'] : [];
        // Keep your existing "safe" billing response
        $billingSafe = [
            'auto_topup' => [
                'enabled' => !empty($o['billing']['auto_topup']['enabled']),
                'threshold_dollars' => (int)$o['billing']['auto_topup']['threshold_dollars'],
                'topup_dollars' => (int)$o['billing']['auto_topup']['topup_dollars'],
                'cooldown_minutes' => (int)$o['billing']['auto_topup']['cooldown_minutes'],
                'status' => (string)($o['billing']['auto_topup']['status'] ?? 'idle'),
                'last_attempt_utc' => $o['billing']['auto_topup']['last_attempt_utc'] ?? null,
                'last_success_utc' => $o['billing']['auto_topup']['last_success_utc'] ?? null,
                'last_error' => $o['billing']['auto_topup']['last_error'] ?? null,
            ],
            'stripe' => [
                'has_payment_method' => !empty($o['billing']['stripe']['has_payment_method']),
                'brand' => $o['billing']['stripe']['brand'] ?? null,
                'last4' => $o['billing']['stripe']['last4'] ?? null,
                'exp_month' => $o['billing']['stripe']['exp_month'] ?? null,
                'exp_year' => $o['billing']['stripe']['exp_year'] ?? null,
            ],
        ];
        echo json_encode([
            'success'=>true,
            'org'=>[
                'id'=>$orgId,
                'name'=>(string)($o['name'] ?? ''),
                'is_test'=>!empty($o['is_test']),
                'branding'=>[
                    'logo'=>($branding['logo'] ?? null),
                    'colors'=>[
                        'accent'=>$colors['primary'] ?? '#d93025',
                        'secondary'=>$colors['secondary'] ?? '#111111',
                    ]
                ],
                'contact'=>[
                    'email'=>(string)($contact['email'] ?? ''),
                    'phone'=>(string)($contact['phone'] ?? ''),
                    'address'=>(string)($contact['address'] ?? ''),
                ],
                'report_settings'=>$o['report_settings'] ?? [
                    'general'=>['nfva_ratio'=>300],
                    'customer'=>[]
                ],
                'billing'=>$billingSafe
            ]
        ]);
        return true;
    }
    
    if ($action === 'org_billing_history_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_billing');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBillingFields($o);
        orgEnsureCreditsFields($o);
        $limit = (int)($_POST['limit'] ?? 60);
        if ($limit < 5) $limit = 5;
        if ($limit > 200) $limit = 200;
        $events = $o['billing']['events'] ?? [];
        if (!is_array($events)) $events = [];
        // newest last in storage sometimes; normalize to newest-first
        usort($events, function($a,$b){
            return strcmp((string)($b['ts_utc'] ?? ''), (string)($a['ts_utc'] ?? ''));
        });
        $events = array_slice($events, 0, $limit);
        $ledger = $o['credits_ledger'] ?? [];
        if (!is_array($ledger)) $ledger = [];
        usort($ledger, function($a,$b){
            return strcmp((string)($b['ts'] ?? ''), (string)($a['ts'] ?? ''));
        });
        $ledger = array_slice($ledger, 0, $limit);
        // keep only billing-ish ledger rows (and newest-first)
        $ledger = array_values(array_filter($ledger, function($row){
            if (!is_array($row)) return false;
            $reason = strtolower((string)($row['reason'] ?? ''));
            if (strpos($reason, 'stripe') !== false) return true;
            if (strpos($reason, 'topup') !== false) return true;
            if (strpos($reason, 'checkout') !== false) return true;
            return false;
        }));
        usort($ledger, function($a,$b){
            return strcmp((string)($b['ts'] ?? ''), (string)($a['ts'] ?? ''));
        });
        $ledger = array_slice($ledger, 0, $limit);
        echo json_encode([
            'success'=>true,
            'org_id'=>$orgId,
            'events'=>$events,
            'ledger'=>$ledger
        ]);
        return true;
    }
    
    if ($action === 'org_update_my_billing') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_billing');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBillingFields($o);
        orgEnsureCreditsFields($o);
        $raw = (string)($_POST['billing_json'] ?? '');
        $j = json_decode($raw, true);
        if (!is_array($j)) $j = [];
        $at = $j['auto_topup'] ?? [];
        if (!is_array($at)) $at = [];
        $enabled  = !empty($at['enabled']);
        $threshold = max(35, (int)($at['threshold_dollars'] ?? $o['billing']['auto_topup']['threshold_dollars']));
        $topup     = max(35, (int)($at['topup_dollars'] ?? $o['billing']['auto_topup']['topup_dollars']));
        $hasPM = !empty($o['billing']['stripe']['has_payment_method']);
        // ✅ Always save settings, even without a payment method.
        $o['billing']['auto_topup']['enabled'] = $enabled;
        $o['billing']['auto_topup']['threshold_dollars'] = $threshold;
        $o['billing']['auto_topup']['topup_dollars'] = $topup;
        // Status semantics
        if (!$enabled) {
            $o['billing']['auto_topup']['status'] = 'idle';
            $o['billing']['auto_topup']['last_error'] = null;
        } else if (!$hasPM) {
            $o['billing']['auto_topup']['status'] = 'needs_payment_method';
            $o['billing']['auto_topup']['last_error'] = 'Payment method required';
        } else {
            $cur = (string)($o['billing']['auto_topup']['status'] ?? '');
            if ($cur === '' || $cur === 'needs_payment_method') $o['billing']['auto_topup']['status'] = 'idle';
            $o['billing']['auto_topup']['last_error'] = null;
        }
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = strtolower(trim((string)$_SESSION['user_email']));
        orgBillingLogEvent($o, 'settings_update', [
            'enabled'=>$enabled,
            'threshold_dollars'=>$threshold,
            'topup_dollars'=>$topup,
            'has_payment_method'=>$hasPM,
        ]);
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        // Prime if needed
        $primed = false;
        if ($enabled && $hasPM) {
            $balance = (int)($o['credits_balance'] ?? 0);
            $byEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
            if ($byEmail !== '' && $balance < $threshold) {
                $prime = orgAutoTopupTry($orgId, $byEmail, $balance, [
                    'reason' => 'settings_save_prime',
                    'source' => 'org_update_my_billing'
                ]);
                $primed = !empty($prime['ok']) && empty($prime['skipped']);
            }
        }
        echo json_encode([
            'success'=>true,
            'saved'=>true,
            'requires_payment_method'=>($enabled && !$hasPM),
            'primed'=>$primed
        ]);
        return true;
    }
    
    // ---------------- ORG UPDATE (my org) ----------------
    if ($action === 'org_update_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_settings');
        $email = strtolower(trim((string)$_SESSION['user_email']));
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        $name = trim((string)($_POST['name'] ?? ''));
        $accent = trim((string)($_POST['accent'] ?? ''));
        $secondary = trim((string)($_POST['secondary'] ?? ''));
        if ($name !== '') $o['name'] = sanitizeName($name);
        orgEnsureBrandingFields($o);
        if ($accent !== '')   $o['branding']['colors']['primary']   = orgNormalizeHexColor($accent,   $o['branding']['colors']['primary']   ?? '#d93025');
        if ($secondary !== '')$o['branding']['colors']['secondary'] = orgNormalizeHexColor($secondary,$o['branding']['colors']['secondary'] ?? '#111111');
        // contact fields
        $cEmail = sanitizeEmail($_POST['company_email'] ?? '');
        $cPhone = trim((string)($_POST['company_phone'] ?? ''));
        $cAddr  = trim((string)($_POST['company_address'] ?? ''));
        // light normalization
        $cPhone = preg_replace('/[^\d\+\-\(\)\.\s]/', '', $cPhone);
        $cPhone = preg_replace('/\s+/', ' ', $cPhone);
        $cPhone = substr($cPhone, 0, 60);
        $cAddr = preg_replace('/\s+/', ' ', $cAddr);
        $cAddr = substr($cAddr, 0, 240);
        if (!isset($o['contact']) || !is_array($o['contact'])) $o['contact'] = [];
        $o['contact']['email'] = $cEmail;
        $o['contact']['phone'] = $cPhone;
        $o['contact']['address'] = $cAddr;
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = $email;
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true]);
        return true;
    }
    
    // ---------------- ORG UPDATE REPORT SETTINGS (my org) ----------------
    if ($action === 'org_update_my_report_settings') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_report_settings');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureDefaults($o);
        orgEnsureReportSettingsFields($o);
        $raw = (string)($_POST['report_settings_json'] ?? '');
        $j = json_decode($raw, true);
        if (!is_array($j)) $j = [];
        $gen = $j['general'] ?? [];
        $cus = $j['customer'] ?? [];
        if (!is_array($gen)) $gen = [];
        if (!is_array($cus)) $cus = [];
        // Accept nmva_ratio alias
        if (!array_key_exists('nfva_ratio', $gen) && array_key_exists('nmva_ratio', $gen)) {
            $gen['nfva_ratio'] = $gen['nmva_ratio'];
        }
        $nfva = (int)($gen['nfva_ratio'] ?? ($o['report_settings']['general']['nfva_ratio'] ?? 300));
        $nfva = max(1, min(1000, $nfva));
        // Normalize booleans for known customer keys
        $known = [
            'cover_show_customer','cover_show_squares','cover_show_waste','cover_show_breakdown','cover_show_pitch','cover_show_facets',
            'page_top_view','page_elevations','page_3d','page_pitch','page_area','page_layers','page_summary','page_materials','page_ventilation'
        ];
        $nextCustomer = $o['report_settings']['customer'] ?? [];
        if (!is_array($nextCustomer)) $nextCustomer = [];
        foreach ($known as $k) {
            if (array_key_exists($k, $cus)) $nextCustomer[$k] = !!$cus[$k];
            else if (!array_key_exists($k, $nextCustomer)) $nextCustomer[$k] = true;
        }
        $o['report_settings'] = [
            'general' => [
                'nfva_ratio' => $nfva
            ],
            'customer' => $nextCustomer
        ];
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true]);
        return true;
    }
    
    if ($action === 'onboarding_complete') {
        requireLoginOrFail();
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));

        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));

        $o['onboarding_completed'] = true;
        $o['onboarding_completed_at'] = gmdate('c');
        $o['onboarding_meta'] = [
            'did_purchase' => ($_POST['did_purchase'] ?? '0') === '1',
            'did_add_card' => ($_POST['did_add_card'] ?? '0') === '1',
            'completed_by' => $_SESSION['user_email'] ?? null,
        ];

        orgWrite($orgId, $o);

        echo json_encode(['success'=>true]);
        return true;
    }
    
    // ---------------- PROMO: First-Load 50% Match Eligibility ----------------
    if ($action === 'check_promo_eligibility') {
        // Must be logged in
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'not_logged_in']));
        }

        $email = strtolower(trim((string)$_SESSION['user_email']));
        $orgId = actorOrgIdFromSession();

        // No org → not eligible
        if (!$orgId) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'no_org']));
        }

        $o = orgRead($orgId);
        if (!$o) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'org_not_found']));
        }

        orgEnsureDefaults($o);
        orgEnsureCreditsFields($o);

        // ── 1. Must be the org creator (first / primary user) ──
        $creatorEmail = strtolower(trim((string)($o['created_by_email'] ?? '')));
        if ($creatorEmail === '' || $creatorEmail !== $email) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'not_creator']));
        }

        // ── 2. Org must have been created today (UTC) ──
        $createdAt = $o['created_at'] ?? '';
        $signupDate = '';
        if ($createdAt !== '') {
            // Handle both ISO 8601 and "Y-m-d H:i:s" formats
            $ts = strtotime($createdAt);
            if ($ts !== false) {
                $signupDate = gmdate('Y-m-d', $ts);
            }
        }

        $todayUtc = gmdate('Y-m-d');
        if ($signupDate !== $todayUtc) {
            die(json_encode([
                'success'     => true,
                'eligible'    => false,
                'reason'      => 'not_signup_day',
                'signup_date' => $signupDate,
                'today'       => $todayUtc,
            ]));
        }

        // ── 3. Org must have never completed a Stripe card-load ──
        //    Check both credits_ledger and billing.events for any
        //    stripe checkout / payment completion.
        $hasStripeLoad = false;

        // Check credits ledger
        $ledger = $o['credits_ledger'] ?? [];
        if (is_array($ledger)) {
            foreach ($ledger as $entry) {
                if (!is_array($entry)) continue;
                $reason = strtolower((string)($entry['reason'] ?? ''));
                $delta  = (int)($entry['delta'] ?? 0);
                // Only count positive stripe loads (not refunds or spends)
                if ($delta > 0 && (
                    strpos($reason, 'stripe') !== false ||
                    strpos($reason, 'checkout') !== false ||
                    strpos($reason, 'card_load') !== false ||
                    strpos($reason, 'payment') !== false
                )) {
                    $hasStripeLoad = true;
                    break;
                }
            }
        }

        // Also check billing events as a fallback
        if (!$hasStripeLoad) {
            $events = $o['billing']['events'] ?? [];
            if (is_array($events)) {
                foreach ($events as $ev) {
                    if (!is_array($ev)) continue;
                    $type = strtolower((string)($ev['type'] ?? ''));
                    if (
                        strpos($type, 'stripe_paid') !== false ||
                        strpos($type, 'checkout_complete') !== false ||
                        strpos($type, 'topup_success') !== false ||
                        strpos($type, 'payment_success') !== false
                    ) {
                        $hasStripeLoad = true;
                        break;
                    }
                }
            }
        }

        if ($hasStripeLoad) {
            die(json_encode([
                'success'  => true,
                'eligible' => false,
                'reason'   => 'already_loaded',
            ]));
        }

        // ── All checks passed — eligible ──
        echo json_encode([
            'success'     => true,
            'eligible'    => true,
            'signup_date' => $signupDate,
            'org_id'      => $orgId,
            'match_pct'   => 50,
        ]);
        return true;
    }

    
    // ---------------- ORG UPLOAD LOGO (my org) ----------------
    if ($action === 'org_upload_logo_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_settings');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        if (empty($_FILES['logo']) || !is_array($_FILES['logo'])) {
            die(json_encode(['success'=>false,'error'=>'Missing file: logo']));
        }
        $f = $_FILES['logo'];
        if (!empty($f['error'])) die(json_encode(['success'=>false,'error'=>'Upload error','code'=>$f['error']]));
        if (empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) die(json_encode(['success'=>false,'error'=>'Bad upload tmp']));
        $name = (string)($f['name'] ?? 'logo');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === '') $ext = 'png';
        if (!in_array($ext, ['png','jpg','jpeg','webp','svg'], true)) die(json_encode(['success'=>false,'error'=>'Unsupported file type']));
        if ($ext === 'jpeg') $ext = 'jpg';
        $dir = orgPath($orgId);
        if (!$dir) die(json_encode(['success'=>false,'error'=>'Org path failed']));
        if (!file_exists($dir)) @mkdir($dir, 0777, true);
        $destName = 'logo.' . $ext;
        $destPath = $dir . $destName;
        if (!@move_uploaded_file($f['tmp_name'], $destPath)) die(json_encode(['success'=>false,'error'=>'Move failed']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBrandingFields($o);
        $o['branding']['logo'] = 'organizations/' . $orgId . '/' . $destName;
        $o['branding']['logo_updated_at_utc'] = gmdate('c');
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true,'logo'=>$o['branding']['logo']]);
        return true;
    }

    // ---------------- SET TEST ORG FLAG ----------------
    if ($action === 'org_set_test_flag') {
        requireLoginOrFail();
        $orgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($orgId === '') die(json_encode(['success'=>false,'error'=>'Missing org_id']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        $isTest = !empty($_POST['is_test']);
        $o['is_test'] = $isTest;
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true,'org_id'=>$orgId,'is_test'=>$isTest]);
        return true;
    }
    
    if ($action === 'internal_set_field') {
        internalMutationAuthOrFail();
        $type = strtolower(trim((string)($_POST['target_type'] ?? '')));
        $tid  = trim((string)($_POST['target_id'] ?? ''));
        $path = trim((string)($_POST['path'] ?? ''));
        if (!in_array($type, ['user','org'], true)) die(json_encode(['success'=>false,'error'=>'Invalid target_type']));
        if ($tid === '') die(json_encode(['success'=>false,'error'=>'Missing target_id']));
        if ($path === '') die(json_encode(['success'=>false,'error'=>'Missing path']));
        $parts = normalizeDotPath($path);
        if (!$parts) die(json_encode(['success'=>false,'error'=>'Invalid path']));
        $rawVal = isset($_POST['value_json']) ? $_POST['value_json'] : ($_POST['value'] ?? '');
        $val = coerceJsonValue($rawVal);
        if ($type === 'org') {
            $orgId = orgNormalizeId($tid);
            if ($orgId === '') die(json_encode(['success'=>false,'error'=>'Bad org_id']));
            $o = orgRead($orgId);
            if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
            arraySetByPath($o, $parts, $val);
            if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
            echo json_encode([
                'success'=>true,
                'target_type'=>'org',
                'target_id'=>$orgId,
                'path'=>$path,
                'value'=>$val
            ]);
            return true;
        }
        // user (by user_id, not email)
        $userId = strtolower(trim((string)$tid));
        $uf = userFindFileById($userId);
        if (!$uf) die(json_encode(['success'=>false,'error'=>'User not found by id']));
        $u = json_decode(@file_get_contents($uf), true);
        if (!is_array($u)) $u = [];
        if (function_exists('ensureUserId')) ensureUserId($u);
        if (function_exists('ensureUserCreditsFields')) ensureUserCreditsFields($u);
        if (function_exists('ensureUserOrgFields')) ensureUserOrgFields($u);
        arraySetByPath($u, $parts, $val);
        if (!atomicWriteJson($uf, $u)) die(json_encode(['success'=>false,'error'=>'User write failed']));
        echo json_encode([
            'success'=>true,
            'target_type'=>'user',
            'target_id'=>$userId,
            'path'=>$path,
            'value'=>$val
        ]);
        return true;
    }
    
    if ($action === 'org_upload_logo') {
        internalMutationAuthOrFail();
        $orgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($orgId === '') die(json_encode(['success'=>false,'error'=>'Missing/bad org_id']));
        if (empty($_FILES['logo']) || !is_array($_FILES['logo'])) {
            die(json_encode(['success'=>false,'error'=>'Missing file: logo']));
        }
        $f = $_FILES['logo'];
        if (!empty($f['error'])) die(json_encode(['success'=>false,'error'=>'Upload error','code'=>$f['error']]));
        if (empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) die(json_encode(['success'=>false,'error'=>'Bad upload tmp']));
        // allow common image formats
        $name = (string)($f['name'] ?? 'logo');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === '') $ext = 'png';
        if (!in_array($ext, ['png','jpg','jpeg','webp','svg'], true)) {
            die(json_encode(['success'=>false,'error'=>'Unsupported file type']));
        }
        if ($ext === 'jpeg') $ext = 'jpg';
        $dir = orgPath($orgId);
        if (!$dir) die(json_encode(['success'=>false,'error'=>'Org path failed']));
        if (!file_exists($dir)) @mkdir($dir, 0777, true);
        $destName = 'logo.' . $ext;
        $destPath = $dir . $destName;
        // overwrite ok
        if (!@move_uploaded_file($f['tmp_name'], $destPath)) {
            die(json_encode(['success'=>false,'error'=>'Move failed']));
        }
        // update org manifest
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        if (!isset($o['branding']) || !is_array($o['branding'])) $o['branding'] = [];
        $o['branding']['logo'] = orgLogoRelUrl($orgId, $destName);
        $o['branding']['logo_updated_at_utc'] = gmdate('c');
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode([
            'success'=>true,
            'org_id'=>$orgId,
            'logo'=>$o['branding']['logo'],
        ]);
        return true;
    }

    if ($action === 'customer_org_dashboard_data') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        echo json_encode([
            'success' => true,
            'can_manage' => orgActorCanManageCustomers(),
            'can_view_all' => orgActorCanViewAllCustomers(),
            'sales_users' => orgSalesUsersList(),
            'organizations' => orgCustomerDataSnapshot($actor),
        ]);
        exit;
    }

    if ($action === 'org_assign_sales_owner') {
        requireLoginOrFail();
        if (!orgActorCanManageCustomers()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $orgIds = $_POST['org_ids'] ?? [];
        if (is_string($orgIds)) {
            $decoded = json_decode($orgIds, true);
            if (json_last_error() === JSON_ERROR_NONE) $orgIds = $decoded;
        }
        if (!is_array($orgIds) || !$orgIds) die(json_encode(['success' => false, 'error' => 'No organizations selected']));
        $assignedTo = strtolower(trim((string)($_POST['assigned_to_email'] ?? '')));
        $salesUsers = orgSalesUsersList();
        $salesMap = [];
        foreach ($salesUsers as $row) $salesMap[strtolower(trim((string)$row['email']))] = $row;
        if ($assignedTo !== '' && !isset($salesMap[$assignedTo])) {
            die(json_encode(['success' => false, 'error' => 'Unknown salesperson']));
        }
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $updated = 0;
        foreach ($orgIds as $orgIdRaw) {
            $orgId = orgNormalizeId($orgIdRaw);
            if ($orgId === '') continue;
            $o = orgRead($orgId);
            if (!$o) continue;
            $o['assigned_sales_email'] = $assignedTo;
            $o['assigned_sales_name'] = $assignedTo !== '' ? (string)($salesMap[$assignedTo]['name'] ?? $assignedTo) : '';
            $o['assigned_sales_by_email'] = $actor;
            $o['assigned_sales_at'] = gmdate('c');
            if (orgWrite($orgId, $o)) $updated++;
        }
        echo json_encode(['success' => true, 'updated' => $updated]);
        exit;
    }

    if ($action === 'customer_pair_candidates') {
        requireLoginOrFail();
        if (!orgActorCanManageCustomers()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $db = function_exists('leadDb') ? leadDb() : null;
        if (!$db) die(json_encode(['success' => false, 'error' => 'Lead database unavailable']));

        $orgs = orgCustomerDataSnapshot(strtolower(trim((string)($_SESSION['user_email'] ?? ''))));
        $domainIndex = [];
        $phoneIndex = [];
        $leadSql = "
            SELECT l.id, l.company, l.email, l.phone, l.organization_id, l.updated_at, ll.assigned_to_email, ll.name AS list_name
            FROM leads l
            JOIN lead_lists ll ON ll.id = l.list_id
            WHERE COALESCE(l.organization_id, '') = ''
        ";
        $leadRes = $db->query($leadSql);
        while ($leadRes && ($lead = $leadRes->fetchArray(SQLITE3_ASSOC))) {
            $domain = orgEmailDomain($lead['email'] ?? '');
            $phone = orgNormPhone($lead['phone'] ?? '');
            if ($domain !== '') {
                if (!isset($domainIndex[$domain])) $domainIndex[$domain] = [];
                $domainIndex[$domain][] = $lead;
            }
            if ($phone !== '') {
                if (!isset($phoneIndex[$phone])) $phoneIndex[$phone] = [];
                $phoneIndex[$phone][] = $lead;
            }
        }

        $pairs = [];
        foreach ($orgs as $org) {
            if (!empty($org['is_test'])) continue;
            $domains = [];
            $phones = [];
            foreach (($org['users'] ?? []) as $user) {
                $domain = orgEmailDomain($user['email'] ?? '');
                if ($domain !== '') $domains[$domain] = true;
                $phone = orgNormPhone($user['phone'] ?? '');
                if ($phone !== '') $phones[$phone] = true;
            }
            $contactEmailDomain = orgEmailDomain($org['contact']['email'] ?? '');
            if ($contactEmailDomain !== '') $domains[$contactEmailDomain] = true;
            $contactPhone = orgNormPhone($org['contact']['phone'] ?? '');
            if ($contactPhone !== '') $phones[$contactPhone] = true;

            $candidates = [];
            foreach (array_keys($domains) as $domain) {
                foreach (($domainIndex[$domain] ?? []) as $lead) {
                    $id = (string)$lead['id'];
                    if (!isset($candidates[$id])) $candidates[$id] = ['lead' => $lead, 'reasons' => [], 'score' => 0];
                    $candidates[$id]['reasons'][] = 'Shared email domain: ' . $domain;
                    $candidates[$id]['score'] += 3;
                }
            }
            foreach (array_keys($phones) as $phone) {
                foreach (($phoneIndex[$phone] ?? []) as $lead) {
                    $id = (string)$lead['id'];
                    if (!isset($candidates[$id])) $candidates[$id] = ['lead' => $lead, 'reasons' => [], 'score' => 0];
                    $candidates[$id]['reasons'][] = 'Shared phone number';
                    $candidates[$id]['score'] += 4;
                }
            }

            foreach ($candidates as $leadId => $candidate) {
                $lead = $candidate['lead'];
                $pairs[] = [
                    'pair_id' => $org['id'] . ':' . $leadId,
                    'organization_id' => $org['id'],
                    'organization_name' => $org['name'],
                    'organization_is_test' => !empty($org['is_test']),
                    'lead_id' => $leadId,
                    'lead_company' => (string)($lead['company'] ?? ''),
                    'lead_email' => (string)($lead['email'] ?? ''),
                    'lead_phone' => (string)($lead['phone'] ?? ''),
                    'lead_list_name' => (string)($lead['list_name'] ?? ''),
                    'assigned_sales_email' => strtolower(trim((string)($lead['assigned_to_email'] ?? ''))),
                    'reasons' => array_values(array_unique($candidate['reasons'])),
                    'score' => (int)$candidate['score'],
                    'updated_at' => (int)($lead['updated_at'] ?? 0),
                ];
            }
        }

        usort($pairs, function($a, $b) {
            if ((int)$a['score'] !== (int)$b['score']) return (int)$b['score'] - (int)$a['score'];
            return strcmp((string)$a['organization_name'], (string)$b['organization_name']);
        });

        echo json_encode(['success' => true, 'pairs' => $pairs]);
        exit;
    }

    if ($action === 'customer_apply_pairs') {
        requireLoginOrFail();
        if (!orgActorCanManageCustomers()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $pairs = $_POST['pairs'] ?? [];
        if (is_string($pairs)) {
            $decoded = json_decode($pairs, true);
            if (json_last_error() === JSON_ERROR_NONE) $pairs = $decoded;
        }
        if (!is_array($pairs) || !$pairs) die(json_encode(['success' => false, 'error' => 'No pairs provided']));
        $db = function_exists('leadDb') ? leadDb() : null;
        if (!$db) die(json_encode(['success' => false, 'error' => 'Lead database unavailable']));
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $applied = 0;
        foreach ($pairs as $pair) {
            $orgId = orgNormalizeId($pair['organization_id'] ?? '');
            $leadId = trim((string)($pair['lead_id'] ?? ''));
            if ($orgId === '' || $leadId === '') continue;
            $o = orgRead($orgId);
            if (!$o) continue;
            if (!empty($o['is_test'])) continue;
            $salesEmail = strtolower(trim((string)($pair['assigned_sales_email'] ?? '')));
            if (!leadLinkOrganization($db, $leadId, $orgId, $actor, $salesEmail)) continue;
            $paired = array_values(array_unique(array_filter(array_map('strval', $o['paired_lead_ids'] ?? []))));
            if (!in_array($leadId, $paired, true)) $paired[] = $leadId;
            $o['paired_lead_ids'] = $paired;
            if (empty($o['paired_primary_lead_id'])) $o['paired_primary_lead_id'] = $leadId;
            $o['paired_at'] = gmdate('c');
            if ($salesEmail !== '') {
                $o['assigned_sales_email'] = $salesEmail;
                $o['assigned_sales_by_email'] = $actor;
                $o['assigned_sales_at'] = gmdate('c');
                foreach (orgSalesUsersList() as $row) {
                    if (strtolower(trim((string)$row['email'])) === $salesEmail) {
                        $o['assigned_sales_name'] = (string)($row['name'] ?? $salesEmail);
                        break;
                    }
                }
            }
            if (orgWrite($orgId, $o)) $applied++;
        }
        echo json_encode(['success' => true, 'applied' => $applied]);
        exit;
    }

    if ($action === 'fetch_organizations_list') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $orgs = [];
        $orgDirPath = orgDirPath();
        if (is_dir($orgDirPath)) {
            foreach (scandir($orgDirPath) as $f) {
                if ($f === '.' || $f === '..') continue;
                $manifestPath = $orgDirPath . $f . '/manifest.json';
                if (file_exists($manifestPath)) {
                    $o = json_decode(file_get_contents($manifestPath), true);
                    if (is_array($o)) {
                        orgEnsureCreditsFields($o);
                        $entry = [
                            'id' => $o['id'] ?? $f,
                            'name' => $o['name'] ?? $f,
                            'is_test' => !empty($o['is_test']),
                            'created_at' => $o['created_at'] ?? null,
                        ];
                        // Include credits data when requested (used by customers admin view)
                        if (!empty($_POST['include_credits'])) {
                            $entry['credits_balance'] = (int)($o['credits_balance'] ?? 0);
                            $entry['credits_ledger'] = $o['credits_ledger'] ?? [];
                        }
                        $orgs[] = $entry;
                    }
                }
            }
        }
        echo json_encode(['success' => true, 'organizations' => $orgs]);
        exit;
    }
    
    // Action not handled by this file
    return false;
}
