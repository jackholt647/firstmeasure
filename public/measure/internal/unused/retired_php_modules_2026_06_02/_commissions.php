<?php
require_once __DIR__ . '/_storage.php';

define('COMMISSION_REVENUE_MILESTONE_DOLLARS', 70);
define('COMMISSION_DEFAULT_PAYOUT_CENTS', 1000);
define('COMMISSION_REFERRAL_SIGNUP_CENTS', 1000);
define('COMMISSION_BONUS_MIN_PAYMENT_DOLLARS', 500);
define('COMMISSION_BONUS_WINDOW_SECONDS', 259200); // 3 days
define('COMMISSION_REBUILD_COOLDOWN_SECONDS', 45);

function commissionDbPath() {
    return storageExistingPath('databases/commissions.sqlite', __DIR__ . '/commissions.sqlite', true);
}

function commissionDbEnsureColumn(SQLite3 $db, $table, $column, $definition) {
    $res = $db->query("PRAGMA table_info(" . $table . ")");
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        if (strcasecmp((string)($row['name'] ?? ''), (string)$column) === 0) return;
    }
    $db->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
}

function commissionDb() {
    static $db = null;
    if ($db instanceof SQLite3) return $db;
    if (!class_exists('SQLite3')) {
        throw new Exception('SQLite3 extension not available');
    }
    $db = new SQLite3(commissionDbPath());
    $db->busyTimeout(5000);
    $db->exec('PRAGMA journal_mode=WAL;');
    $db->exec('PRAGMA synchronous=NORMAL;');
    $db->exec('PRAGMA foreign_keys=ON;');
    $db->exec("
        CREATE TABLE IF NOT EXISTS commission_user_settings (
            user_email TEXT PRIMARY KEY,
            monthly_quota INTEGER NOT NULL DEFAULT 0,
            base_pay_cents INTEGER NOT NULL DEFAULT 0,
            milestone_payout_cents INTEGER NOT NULL DEFAULT 1000,
            updated_at INTEGER NOT NULL DEFAULT 0,
            updated_by_email TEXT NOT NULL DEFAULT ''
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS commission_events (
            id TEXT PRIMARY KEY,
            event_key TEXT NOT NULL,
            event_type TEXT NOT NULL,
            user_email TEXT NOT NULL DEFAULT '',
            secondary_user_email TEXT NOT NULL DEFAULT '',
            org_id TEXT NOT NULL DEFAULT '',
            org_name TEXT NOT NULL DEFAULT '',
            lead_id TEXT NOT NULL DEFAULT '',
            referrer_user_email TEXT NOT NULL DEFAULT '',
            referrer_org_id TEXT NOT NULL DEFAULT '',
            source_amount_cents INTEGER NOT NULL DEFAULT 0,
            payout_cents INTEGER NOT NULL DEFAULT 0,
            occurred_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'earned',
            metadata_json TEXT,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS commission_milestones (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            org_name TEXT NOT NULL DEFAULT '',
            sales_email TEXT NOT NULL DEFAULT '',
            milestone_count INTEGER NOT NULL DEFAULT 70,
            milestone_at INTEGER NOT NULL DEFAULT 0,
            source_report_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS commission_payrolls (
            id TEXT PRIMARY KEY,
            user_email TEXT NOT NULL,
            period_key TEXT NOT NULL,
            due_date INTEGER NOT NULL DEFAULT 0,
            base_pay_cents INTEGER NOT NULL DEFAULT 0,
            commission_cents INTEGER NOT NULL DEFAULT 0,
            commission_count INTEGER NOT NULL DEFAULT 0,
            total_cents INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            completed_at INTEGER,
            completed_by_email TEXT NOT NULL DEFAULT '',
            metadata_json TEXT,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS commission_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
        )
    ");
    commissionDbEnsureColumn($db, 'commission_user_settings', 'milestone_payout_cents', 'INTEGER NOT NULL DEFAULT 1000');
    foreach ([
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_events_key ON commission_events(event_key)',
        'CREATE INDEX IF NOT EXISTS idx_commission_events_user_month ON commission_events(user_email, occurred_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_commission_events_type_month ON commission_events(event_type, occurred_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_commission_events_org ON commission_events(org_id, occurred_at DESC)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_milestones_org ON commission_milestones(org_id)',
        'CREATE INDEX IF NOT EXISTS idx_commission_milestones_sales_month ON commission_milestones(sales_email, milestone_at)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_payrolls_user_period ON commission_payrolls(user_email, period_key)',
        'CREATE INDEX IF NOT EXISTS idx_commission_payrolls_due_date ON commission_payrolls(due_date, status)',
        'CREATE INDEX IF NOT EXISTS idx_commission_payrolls_user_due_date ON commission_payrolls(user_email, due_date DESC)'
    ] as $sql) {
        $db->exec($sql);
    }
    return $db;
}

function commissionActorEmail() {
    return strtolower(trim((string)($_SESSION['user_email'] ?? '')));
}

function commissionActorData() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $email = commissionActorEmail();
    $cached = ($email !== '' && function_exists('readUserDataByEmail')) ? readUserDataByEmail($email) : null;
    return $cached;
}

function commissionCanManage() {
    $email = commissionActorEmail();
    if ($email === '') return false;
    if (function_exists('userHasSalesPermission')) {
        return userHasSalesPermission($email, 'sales_view_all_commission_summaries', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
    }
    if (function_exists('isAdmin') && isAdmin()) return true;
    if (function_exists('userHasPerm') && (userHasPerm($email, 'manage_users') || userHasPerm($email, 'manage_sales_users'))) return true;
    $role = strtolower(trim((string)(commissionActorData()['role'] ?? '')));
    return in_array($role, ['admin', 'system_admin', 'sales_manager'], true);
}

function commissionCanViewOwnSummary() {
    $email = commissionActorEmail();
    if ($email === '') return false;
    if (function_exists('userHasSalesPermission')) {
        return userHasSalesPermission($email, 'sales_view_own_commission_summary', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
    }
    return commissionCanManage();
}

function commissionCanExportReports() {
    $email = commissionActorEmail();
    if ($email === '') return false;
    if (function_exists('userHasSalesPermission')) {
        return userHasSalesPermission($email, 'sales_export_commission_reports', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
    }
    return commissionCanManage();
}

function commissionSalesUsers() {
    if (function_exists('orgSalesUsersList')) return orgSalesUsersList();
    return [];
}

function commissionId($prefix = 'commission') {
    return $prefix . '_' . bin2hex(random_bytes(8));
}

function commissionMonthRange($year, $month) {
    $start = mktime(0, 0, 0, $month, 1, $year);
    $end = strtotime('+1 month', $start) - 1;
    return [$start, $end];
}

function commissionLastDayOfMonth($year, $month) {
    return (int)date('t', mktime(0, 0, 0, $month, 1, $year));
}

function commissionDueDatesForMonth($year, $month) {
    return [
        mktime(12, 0, 0, $month, 15, $year),
        mktime(12, 0, 0, $month, commissionLastDayOfMonth($year, $month), $year),
    ];
}

function commissionParseTs($value, $default = 0) {
    if ($value === null || $value === '') return (int)$default;
    if (is_int($value) || is_float($value) || ctype_digit((string)$value)) return (int)$value;
    $ts = strtotime((string)$value);
    return $ts ? (int)$ts : (int)$default;
}

function commissionMetaValue(SQLite3 $db, $key, $default = '') {
    $stmt = $db->prepare('SELECT meta_value FROM commission_meta WHERE meta_key = :meta_key LIMIT 1');
    $stmt->bindValue(':meta_key', (string)$key, SQLITE3_TEXT);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return $row !== false ? (string)($row['meta_value'] ?? $default) : $default;
}

function commissionMetaSet(SQLite3 $db, $key, $value) {
    $stmt = $db->prepare("
        INSERT INTO commission_meta (meta_key, meta_value, updated_at)
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

function commissionUserSettings(SQLite3 $db, $email) {
    $email = strtolower(trim((string)$email));
    $stmt = $db->prepare('SELECT * FROM commission_user_settings WHERE user_email = :user_email LIMIT 1');
    $stmt->bindValue(':user_email', $email, SQLITE3_TEXT);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return [
        'user_email' => $email,
        'monthly_quota' => (int)($row['monthly_quota'] ?? 0),
        'base_pay_cents' => (int)($row['base_pay_cents'] ?? 0),
        'milestone_payout_cents' => (int)($row['milestone_payout_cents'] ?? COMMISSION_DEFAULT_PAYOUT_CENTS),
        'updated_at' => (int)($row['updated_at'] ?? 0),
        'updated_by_email' => (string)($row['updated_by_email'] ?? ''),
    ];
}

function commissionSaveUserSettings(SQLite3 $db, $email, $monthlyQuota, $basePayCents, $milestonePayoutCents, $actor) {
    $now = time();
    $stmt = $db->prepare("
        INSERT INTO commission_user_settings (user_email, monthly_quota, base_pay_cents, milestone_payout_cents, updated_at, updated_by_email)
        VALUES (:user_email, :monthly_quota, :base_pay_cents, :milestone_payout_cents, :updated_at, :updated_by_email)
        ON CONFLICT(user_email) DO UPDATE SET
            monthly_quota = excluded.monthly_quota,
            base_pay_cents = excluded.base_pay_cents,
            milestone_payout_cents = excluded.milestone_payout_cents,
            updated_at = excluded.updated_at,
            updated_by_email = excluded.updated_by_email
    ");
    $stmt->bindValue(':user_email', strtolower(trim((string)$email)), SQLITE3_TEXT);
    $stmt->bindValue(':monthly_quota', max(0, (int)$monthlyQuota), SQLITE3_INTEGER);
    $stmt->bindValue(':base_pay_cents', max(0, (int)$basePayCents), SQLITE3_INTEGER);
    $stmt->bindValue(':milestone_payout_cents', max(0, (int)$milestonePayoutCents), SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_by_email', strtolower(trim((string)$actor)), SQLITE3_TEXT);
    $stmt->execute();
}

function commissionSafeJson($value) {
    $json = json_encode($value);
    return $json === false ? '{}' : $json;
}

function commissionUserNameByEmail($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return '';
    if (function_exists('leadUserDisplayNameByEmail')) {
        $label = (string)leadUserDisplayNameByEmail($email);
        if ($label !== '') return $label;
    }
    if (function_exists('readUserDataByEmail')) {
        $user = readUserDataByEmail($email);
        if (is_array($user)) {
            $name = trim((string)($user['name'] ?? ''));
            if ($name !== '') return $name;
        }
    }
    return $email;
}

function commissionIsCustomerUser($user) {
    return strtolower(trim((string)($user['account_type'] ?? ''))) === 'customer';
}

function commissionReadCustomerUsersByEmail() {
    $rows = [];
    foreach (glob(storageDir('users') . '*.json') as $path) {
        $user = json_decode((string)@file_get_contents($path), true);
        if (!is_array($user) || !commissionIsCustomerUser($user)) continue;
        $email = strtolower(trim((string)($user['email'] ?? '')));
        if ($email === '') continue;
        $rows[$email] = $user;
    }
    return $rows;
}

function commissionPrimaryLeadRow(SQLite3 $leadDb, $org) {
    $leadId = strtolower(trim((string)($org['paired_primary_lead_id'] ?? '')));
    if ($leadId !== '' && function_exists('leadRowById')) {
        $row = leadRowById($leadDb, $leadId);
        if (is_array($row)) return $row;
    }
    foreach ((array)($org['paired_lead_ids'] ?? []) as $candidate) {
        $candidate = strtolower(trim((string)$candidate));
        if ($candidate === '' || !function_exists('leadRowById')) continue;
        $row = leadRowById($leadDb, $candidate);
        if (is_array($row)) return $row;
    }
    return null;
}

function commissionLeadOwnerEmail($leadRow) {
    if (!is_array($leadRow)) return '';
    $email = strtolower(trim((string)($leadRow['list_assigned_to_email'] ?? $leadRow['assigned_to_email'] ?? '')));
    return $email;
}

function commissionResolveSignupOwnerEmail(SQLite3 $leadDb, $org) {
    $persisted = strtolower(trim((string)($org['commission_signup_owner_email'] ?? '')));
    if ($persisted !== '') return $persisted;
    $lead = commissionPrimaryLeadRow($leadDb, $org);
    $leadOwner = commissionLeadOwnerEmail($lead);
    if ($leadOwner !== '') return $leadOwner;
    return strtolower(trim((string)($org['assigned_sales_email'] ?? '')));
}

function commissionResolveCurrentOwnerEmail(SQLite3 $leadDb, $org) {
    $lead = commissionPrimaryLeadRow($leadDb, $org);
    $leadOwner = commissionLeadOwnerEmail($lead);
    if ($leadOwner !== '') return $leadOwner;
    return strtolower(trim((string)($org['assigned_sales_email'] ?? '')));
}

function commissionResolveLeadId(SQLite3 $leadDb, $org) {
    $lead = commissionPrimaryLeadRow($leadDb, $org);
    if (is_array($lead)) return (string)($lead['id'] ?? '');
    return '';
}

function commissionResolveSignupAt(SQLite3 $leadDb, $org, array $payments) {
    $persisted = commissionParseTs($org['commission_signup_at'] ?? 0, 0);
    if ($persisted > 0) return $persisted;
    $attrTs = commissionParseTs($org['attribution']['signup_ts'] ?? 0, 0);
    if ($attrTs > 0) return $attrTs;
    $lead = commissionPrimaryLeadRow($leadDb, $org);
    if (is_array($lead)) {
        $ts = commissionParseTs($lead['created_at'] ?? 0, 0);
        if ($ts > 0) return $ts;
    }
    if ($payments) {
        $first = $payments[0];
        $ts = (int)($first['occurred_at'] ?? 0);
        if ($ts > 0) return $ts;
    }
    return commissionParseTs($org['created_at'] ?? 0, 0);
}

function commissionPersistAttributionIfNeeded($orgId, array $org, $signupOwnerEmail, $signupAt, $leadId) {
    $changed = false;
    if ($signupOwnerEmail !== '' && strtolower(trim((string)($org['commission_signup_owner_email'] ?? ''))) !== $signupOwnerEmail) {
        $org['commission_signup_owner_email'] = $signupOwnerEmail;
        $org['commission_signup_owner_name'] = commissionUserNameByEmail($signupOwnerEmail);
        $changed = true;
    }
    if ($signupAt > 0 && commissionParseTs($org['commission_signup_at'] ?? 0, 0) !== $signupAt) {
        $org['commission_signup_at'] = gmdate('c', $signupAt);
        $changed = true;
    }
    if ($leadId !== '' && (string)($org['commission_signup_lead_id'] ?? '') !== $leadId) {
        $org['commission_signup_lead_id'] = $leadId;
        $changed = true;
    }
    if ($changed && function_exists('orgWrite')) orgWrite($orgId, $org);
}

function commissionSessionPaymentRows() {
    $rows = [];
    foreach (glob(storageDir('stripe_events_live') . 'session_*.json') as $path) {
        $payload = json_decode((string)@file_get_contents($path), true);
        if (!is_array($payload) || empty($payload['fulfilled'])) continue;
        if (!empty($payload['test_mode'])) continue;
        $orgId = function_exists('orgNormalizeId') ? orgNormalizeId((string)($payload['org_id'] ?? '')) : trim((string)($payload['org_id'] ?? ''));
        $paid = max(0, (int)($payload['paid_dollars'] ?? 0));
        if ($orgId === '' || $paid <= 0) continue;
        $sessionId = preg_replace('/\.json$/', '', basename($path));
        $rows[] = [
            'source_key' => 'session:' . $sessionId,
            'org_id' => $orgId,
            'occurred_at' => commissionParseTs($payload['ts'] ?? 0, 0),
            'paid_cents' => $paid * 100,
            'paid_dollars' => $paid,
            'bonus_dollars' => max(0, (int)($payload['bonus_dollars'] ?? 0)),
            'is_bonus_like' => max(0, (int)($payload['bonus_dollars'] ?? 0)) > 0 || !empty($payload['is_signup_match']),
            'session_id' => $sessionId,
            'source' => (string)($payload['source'] ?? 'stripe_session'),
            'user_email' => strtolower(trim((string)($payload['user_email'] ?? ''))),
            'metadata' => $payload,
        ];
    }
    usort($rows, function ($a, $b) {
        return ((int)$a['occurred_at'] <=> (int)$b['occurred_at']) ?: strcmp((string)$a['source_key'], (string)$b['source_key']);
    });
    return $rows;
}

function commissionOrgAutotopupPaymentRows($orgId, $org) {
    $rows = [];
    foreach ((array)($org['billing']['events'] ?? []) as $event) {
        if (!is_array($event)) continue;
        $type = strtolower(trim((string)($event['type'] ?? '')));
        if ($type !== 'autotopup_success') continue;
        $data = is_array($event['data'] ?? null) ? $event['data'] : [];
        $dollars = max(0, (int)($data['topup_dollars'] ?? $data['amount_dollars'] ?? $data['paid_dollars'] ?? 0));
        if ($dollars <= 0) continue;
        $sourceKey = (string)($data['payment_intent_id'] ?? $data['invoice_id'] ?? $event['ts_utc'] ?? '');
        if ($sourceKey === '') $sourceKey = commissionId('autotopup');
        $rows[] = [
            'source_key' => 'autotopup:' . $sourceKey,
            'org_id' => $orgId,
            'occurred_at' => commissionParseTs($event['ts_utc'] ?? 0, 0),
            'paid_cents' => $dollars * 100,
            'paid_dollars' => $dollars,
            'bonus_dollars' => 0,
            'is_bonus_like' => false,
            'session_id' => '',
            'source' => 'stripe_auto_topup',
            'user_email' => '',
            'metadata' => $event,
        ];
    }
    return $rows;
}

function commissionBuildOrgCatalog(SQLite3 $leadDb) {
    $catalog = [];
    $sessionPayments = commissionSessionPaymentRows();
    $paymentsByOrg = [];
    foreach ($sessionPayments as $row) {
        $paymentsByOrg[$row['org_id']][] = $row;
    }

    if (!function_exists('orgDirPath') || !function_exists('orgRead')) return [];
    foreach (scandir(orgDirPath()) as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $org = orgRead($entry);
        if (!is_array($org)) continue;
        $orgId = function_exists('orgNormalizeId') ? orgNormalizeId((string)($org['id'] ?? $entry)) : trim((string)($org['id'] ?? $entry));
        if ($orgId === '') continue;
        $payments = $paymentsByOrg[$orgId] ?? [];
        foreach (commissionOrgAutotopupPaymentRows($orgId, $org) as $row) $payments[] = $row;
        usort($payments, function ($a, $b) {
            return ((int)$a['occurred_at'] <=> (int)$b['occurred_at']) ?: strcmp((string)$a['source_key'], (string)$b['source_key']);
        });
        $leadId = commissionResolveLeadId($leadDb, $org);
        $signupOwnerEmail = commissionResolveSignupOwnerEmail($leadDb, $org);
        $signupAt = commissionResolveSignupAt($leadDb, $org, $payments);
        commissionPersistAttributionIfNeeded($orgId, $org, $signupOwnerEmail, $signupAt, $leadId);
        $catalog[$orgId] = [
            'org_id' => $orgId,
            'org' => $org,
            'org_name' => (string)($org['name'] ?? $orgId),
            'lead_id' => $leadId,
            'signup_owner_email' => $signupOwnerEmail,
            'current_owner_email' => commissionResolveCurrentOwnerEmail($leadDb, $org),
            'signup_at' => $signupAt,
            'payments' => $payments,
        ];
    }
    return $catalog;
}

function commissionPaymentMilestoneEvent(array $catalogItem, SQLite3 $db) {
    $orgId = (string)$catalogItem['org_id'];
    $payments = (array)$catalogItem['payments'];
    $ownerEmail = strtolower(trim((string)($catalogItem['signup_owner_email'] ?? '')));
    if ($orgId === '' || !$payments || $ownerEmail === '') return null;
    $runningCents = 0;
    $milestoneAt = 0;
    $sourceKey = '';
    foreach ($payments as $row) {
        $runningCents += max(0, (int)($row['paid_cents'] ?? 0));
        if ($runningCents >= (COMMISSION_REVENUE_MILESTONE_DOLLARS * 100)) {
            $milestoneAt = (int)($row['occurred_at'] ?? 0);
            $sourceKey = (string)($row['source_key'] ?? '');
            break;
        }
    }
    if ($milestoneAt <= 0) return null;
    $settings = commissionUserSettings($db, $ownerEmail);
    return [
        'event_key' => 'milestone:' . $orgId,
        'event_type' => 'milestone',
        'user_email' => $ownerEmail,
        'secondary_user_email' => '',
        'org_id' => $orgId,
        'org_name' => (string)($catalogItem['org_name'] ?? $orgId),
        'lead_id' => (string)($catalogItem['lead_id'] ?? ''),
        'referrer_user_email' => '',
        'referrer_org_id' => '',
        'source_amount_cents' => $runningCents,
        'payout_cents' => (int)$settings['milestone_payout_cents'],
        'occurred_at' => $milestoneAt,
        'status' => 'earned',
        'metadata' => [
            'threshold_dollars' => COMMISSION_REVENUE_MILESTONE_DOLLARS,
            'source_payment_key' => $sourceKey,
            'payment_count' => count($payments),
            'signup_owner_email' => $ownerEmail,
            'signup_at' => (int)($catalogItem['signup_at'] ?? 0),
        ],
    ];
}

function commissionPersistBonusOwnerMap($orgId, array $org, array $map) {
    if (($org['commission_bonus_owner_map'] ?? null) === $map) return;
    $org['commission_bonus_owner_map'] = $map;
    if (function_exists('orgWrite')) orgWrite($orgId, $org);
}

function commissionPotentialBonusSources(array $catalogItem) {
    $org = (array)$catalogItem['org'];
    $sources = [];
    foreach ((array)($org['payments']['bonus_claims'] ?? []) as $claim) {
        if (!is_array($claim)) continue;
        $paid = max(0, (int)($claim['paid_dollars'] ?? 0));
        if ($paid <= 0) continue;
        $sourceKey = (string)($claim['session_id'] ?? $claim['payment_intent_id'] ?? $claim['id'] ?? '');
        if ($sourceKey === '') $sourceKey = commissionId('bonus');
        $sources['custom:' . $sourceKey] = [
            'source_key' => 'custom:' . $sourceKey,
            'occurred_at' => commissionParseTs($claim['claimed_at'] ?? $claim['ts'] ?? 0, 0),
            'paid_cents' => $paid * 100,
            'source' => 'bonus_offer_custom',
            'metadata' => $claim,
        ];
    }
    $dealMeta = is_array($org['claimed_deals']['signup_match_50_meta'] ?? null) ? $org['claimed_deals']['signup_match_50_meta'] : [];
    $dealPaid = max(0, (int)($dealMeta['paid_dollars'] ?? 0));
    $dealTs = commissionParseTs($org['claimed_deals']['signup_match_50_claimed_at'] ?? 0, 0);
    if ($dealPaid > 0 && $dealTs > 0) {
        $sourceKey = (string)($dealMeta['session_id'] ?? 'signup_match_50');
        $sources['signup_match:' . $sourceKey] = [
            'source_key' => 'signup_match:' . $sourceKey,
            'occurred_at' => $dealTs,
            'paid_cents' => $dealPaid * 100,
            'source' => 'signup_match_50',
            'metadata' => $dealMeta,
        ];
    }
    foreach ((array)$catalogItem['payments'] as $payment) {
        $paidDollars = max(0, (int)($payment['paid_dollars'] ?? 0));
        if ($paidDollars <= 0) continue;
        if (empty($payment['is_bonus_like'])) continue;
        $sources['payment:' . (string)$payment['source_key']] = [
            'source_key' => 'payment:' . (string)$payment['source_key'],
            'occurred_at' => (int)($payment['occurred_at'] ?? 0),
            'paid_cents' => max(0, (int)($payment['paid_cents'] ?? 0)),
            'source' => (string)($payment['source'] ?? 'stripe_session'),
            'metadata' => $payment['metadata'] ?? $payment,
        ];
    }
    ksort($sources);
    return array_values($sources);
}

function commissionBonusEvents(array $catalogItem) {
    $orgId = (string)$catalogItem['org_id'];
    $org = (array)$catalogItem['org'];
    $ownerMap = is_array($org['commission_bonus_owner_map'] ?? null) ? $org['commission_bonus_owner_map'] : [];
    $currentOwner = strtolower(trim((string)($catalogItem['current_owner_email'] ?? '')));
    $events = [];
    foreach (commissionPotentialBonusSources($catalogItem) as $source) {
        $sourceKey = (string)($source['source_key'] ?? '');
        $occurredAt = (int)($source['occurred_at'] ?? 0);
        $paidCents = max(0, (int)($source['paid_cents'] ?? 0));
        if ($sourceKey === '' || $occurredAt <= 0 || $paidCents < (COMMISSION_BONUS_MIN_PAYMENT_DOLLARS * 100)) continue;
        $ownerEmail = strtolower(trim((string)($ownerMap[$sourceKey] ?? '')));
        if ($ownerEmail === '') {
            $ownerEmail = $currentOwner;
            $ownerMap[$sourceKey] = $ownerEmail;
        }
        if ($ownerEmail === '') continue;
        $events[] = [
            'event_key' => 'bonus_offer:' . $orgId . ':' . $sourceKey,
            'event_type' => 'bonus_offer',
            'user_email' => $ownerEmail,
            'secondary_user_email' => '',
            'org_id' => $orgId,
            'org_name' => (string)($catalogItem['org_name'] ?? $orgId),
            'lead_id' => (string)($catalogItem['lead_id'] ?? ''),
            'referrer_user_email' => '',
            'referrer_org_id' => '',
            'source_amount_cents' => $paidCents,
            'payout_cents' => (int)round($paidCents * 0.05),
            'occurred_at' => $occurredAt,
            'status' => 'earned',
            'metadata' => [
                'source_key' => $sourceKey,
                'source' => (string)($source['source'] ?? ''),
                'owner_email' => $ownerEmail,
                'rule' => '5_percent_bonus_payment',
                'raw' => $source['metadata'] ?? [],
            ],
        ];
    }
    commissionPersistBonusOwnerMap($orgId, $org, $ownerMap);
    return $events;
}

function commissionResolveReferralData(array $catalogItem) {
    $org = (array)$catalogItem['org'];
    $leadOwner = strtolower(trim((string)($catalogItem['current_owner_email'] ?? '')));
    $referrerOrgId = function_exists('orgNormalizeId')
        ? orgNormalizeId((string)($org['referral']['referrer_org_id'] ?? $org['referred_by_org_id'] ?? $org['referrer_org_id'] ?? ''))
        : trim((string)($org['referral']['referrer_org_id'] ?? $org['referred_by_org_id'] ?? $org['referrer_org_id'] ?? ''));
    $referrerUserEmail = strtolower(trim((string)($org['referral']['referrer_user_email'] ?? $org['referred_by_user_email'] ?? $org['referrer_user_email'] ?? '')));
    $referralSdrEmail = strtolower(trim((string)($org['referral']['referral_sdr_email'] ?? $org['referrer_sdr_email'] ?? '')));
    if ($referralSdrEmail === '' && $referrerOrgId !== '' && function_exists('orgRead')) {
        $referrerOrg = orgRead($referrerOrgId);
        if (is_array($referrerOrg)) {
            $referralSdrEmail = strtolower(trim((string)($referrerOrg['assigned_sales_email'] ?? $referrerOrg['commission_signup_owner_email'] ?? '')));
        }
    }
    $collision = $referralSdrEmail !== '' && $leadOwner !== '' && $leadOwner !== $referralSdrEmail;
    return [
        'referrer_org_id' => $referrerOrgId,
        'referrer_user_email' => $referrerUserEmail,
        'referral_sdr_email' => $referralSdrEmail,
        'lead_owner_email' => $leadOwner,
        'collision' => $collision,
    ];
}

function commissionReferralEvents(array $catalogItem) {
    $orgId = (string)$catalogItem['org_id'];
    $signupAt = (int)($catalogItem['signup_at'] ?? 0);
    $referral = commissionResolveReferralData($catalogItem);
    if ($orgId === '' || $signupAt <= 0 || $referral['referral_sdr_email'] === '') return [];
    $events = [];
    $events[] = [
        'event_key' => 'referral_signup:' . $orgId . ':' . $referral['referral_sdr_email'],
        'event_type' => 'referral_signup',
        'user_email' => $referral['referral_sdr_email'],
        'secondary_user_email' => $referral['collision'] ? $referral['lead_owner_email'] : '',
        'org_id' => $orgId,
        'org_name' => (string)($catalogItem['org_name'] ?? $orgId),
        'lead_id' => (string)($catalogItem['lead_id'] ?? ''),
        'referrer_user_email' => $referral['referrer_user_email'],
        'referrer_org_id' => $referral['referrer_org_id'],
        'source_amount_cents' => 0,
        'payout_cents' => COMMISSION_REFERRAL_SIGNUP_CENTS,
        'occurred_at' => $signupAt,
        'status' => 'earned',
        'metadata' => [
            'collision' => $referral['collision'],
            'kind' => 'referral_signup',
            'lead_owner_email' => $referral['lead_owner_email'],
        ],
    ];
    if ($referral['collision'] && $referral['lead_owner_email'] !== '') {
        $events[] = [
            'event_key' => 'referral_signup:' . $orgId . ':' . $referral['lead_owner_email'],
            'event_type' => 'referral_signup',
            'user_email' => $referral['lead_owner_email'],
            'secondary_user_email' => $referral['referral_sdr_email'],
            'org_id' => $orgId,
            'org_name' => (string)($catalogItem['org_name'] ?? $orgId),
            'lead_id' => (string)($catalogItem['lead_id'] ?? ''),
            'referrer_user_email' => $referral['referrer_user_email'],
            'referrer_org_id' => $referral['referrer_org_id'],
            'source_amount_cents' => 0,
            'payout_cents' => COMMISSION_REFERRAL_SIGNUP_CENTS,
            'occurred_at' => $signupAt,
            'status' => 'earned',
            'metadata' => [
                'collision' => true,
                'kind' => 'referral_signup_collision_lead_owner',
                'referral_sdr_email' => $referral['referral_sdr_email'],
            ],
        ];
    }
    if (!$referral['collision']) foreach (commissionBonusEvents($catalogItem) as $bonusEvent) {
        $bonusOwner = $referral['collision'] ? $referral['lead_owner_email'] : $referral['referral_sdr_email'];
        if ($bonusOwner === '') continue;
        $events[] = [
            'event_key' => 'referral_bonus:' . $orgId . ':' . ($bonusEvent['metadata']['source_key'] ?? commissionId('bonus')) . ':' . $bonusOwner,
            'event_type' => 'referral_bonus',
            'user_email' => $bonusOwner,
            'secondary_user_email' => $referral['collision'] ? $referral['referral_sdr_email'] : '',
            'org_id' => $orgId,
            'org_name' => (string)($catalogItem['org_name'] ?? $orgId),
            'lead_id' => (string)($catalogItem['lead_id'] ?? ''),
            'referrer_user_email' => $referral['referrer_user_email'],
            'referrer_org_id' => $referral['referrer_org_id'],
            'source_amount_cents' => (int)$bonusEvent['source_amount_cents'],
            'payout_cents' => (int)$bonusEvent['payout_cents'],
            'occurred_at' => (int)$bonusEvent['occurred_at'],
            'status' => 'earned',
            'metadata' => [
                'collision' => $referral['collision'],
                'kind' => 'referral_bonus',
                'source_key' => (string)($bonusEvent['metadata']['source_key'] ?? ''),
            ],
        ];
    }
    return $events;
}

function commissionEventInsert(SQLite3 $db, array $event, $now) {
    $stmt = $db->prepare("
        INSERT INTO commission_events (
            id, event_key, event_type, user_email, secondary_user_email, org_id, org_name, lead_id,
            referrer_user_email, referrer_org_id, source_amount_cents, payout_cents, occurred_at, status,
            metadata_json, created_at, updated_at
        ) VALUES (
            :id, :event_key, :event_type, :user_email, :secondary_user_email, :org_id, :org_name, :lead_id,
            :referrer_user_email, :referrer_org_id, :source_amount_cents, :payout_cents, :occurred_at, :status,
            :metadata_json, :created_at, :updated_at
        )
    ");
    $stmt->bindValue(':id', commissionId('event'), SQLITE3_TEXT);
    foreach ([
        'event_key','event_type','user_email','secondary_user_email','org_id','org_name','lead_id',
        'referrer_user_email','referrer_org_id','status'
    ] as $key) {
        $stmt->bindValue(':' . $key, (string)($event[$key] ?? ''), SQLITE3_TEXT);
    }
    foreach (['source_amount_cents','payout_cents','occurred_at'] as $key) {
        $stmt->bindValue(':' . $key, (int)($event[$key] ?? 0), SQLITE3_INTEGER);
    }
    $stmt->bindValue(':metadata_json', commissionSafeJson($event['metadata'] ?? []), SQLITE3_TEXT);
    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    $stmt->execute();
}

function commissionRebuildDerivedData(SQLite3 $db, $force = false) {
    $last = (int)commissionMetaValue($db, 'last_rebuild_at', '0');
    if (!$force && $last > 0 && (time() - $last) < COMMISSION_REBUILD_COOLDOWN_SECONDS) return;
    $leadDb = function_exists('leadDb') ? leadDb() : null;
    if (!$leadDb instanceof SQLite3) return;
    $catalog = commissionBuildOrgCatalog($leadDb);
    $now = time();

    $db->exec('BEGIN IMMEDIATE');
    try {
        $db->exec('DELETE FROM commission_events');
        $db->exec('DELETE FROM commission_milestones');
        foreach ($catalog as $orgId => $item) {
            $events = [];
            $milestoneEvent = commissionPaymentMilestoneEvent($item, $db);
            if ($milestoneEvent) $events[] = $milestoneEvent;
            $referral = commissionResolveReferralData($item);
            $referralEvents = commissionReferralEvents($item);
            if (empty($referral['referral_sdr_email']) || !empty($referral['collision'])) {
                foreach (commissionBonusEvents($item) as $event) $events[] = $event;
            }
            foreach ($referralEvents as $event) $events[] = $event;
            foreach ($events as $event) {
                commissionEventInsert($db, $event, $now);
                if ((string)$event['event_type'] === 'milestone') {
                    $stmt = $db->prepare("
                        INSERT INTO commission_milestones (
                            id, org_id, org_name, sales_email, milestone_count, milestone_at, source_report_count, created_at, updated_at
                        ) VALUES (
                            :id, :org_id, :org_name, :sales_email, :milestone_count, :milestone_at, :source_report_count, :created_at, :updated_at
                        )
                    ");
                    $stmt->bindValue(':id', commissionId('milestone'), SQLITE3_TEXT);
                    $stmt->bindValue(':org_id', $orgId, SQLITE3_TEXT);
                    $stmt->bindValue(':org_name', (string)($item['org_name'] ?? $orgId), SQLITE3_TEXT);
                    $stmt->bindValue(':sales_email', (string)($event['user_email'] ?? ''), SQLITE3_TEXT);
                    $stmt->bindValue(':milestone_count', COMMISSION_REVENUE_MILESTONE_DOLLARS, SQLITE3_INTEGER);
                    $stmt->bindValue(':milestone_at', (int)($event['occurred_at'] ?? 0), SQLITE3_INTEGER);
                    $stmt->bindValue(':source_report_count', count((array)($item['payments'] ?? [])), SQLITE3_INTEGER);
                    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
                    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
                    $stmt->execute();
                }
            }
        }
        commissionMetaSet($db, 'last_rebuild_at', (string)$now);
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }
}

function commissionAmountForMilestones($count, $payoutCents) {
    return max(0, (int)$count) * max(0, (int)$payoutCents);
}

function commissionEventRows(SQLite3 $db, $userEmail = '', $limit = 500) {
    if ($userEmail !== '') {
        $stmt = $db->prepare('SELECT * FROM commission_events WHERE user_email = :user_email ORDER BY occurred_at DESC, event_key ASC LIMIT :limit');
        $stmt->bindValue(':user_email', strtolower(trim((string)$userEmail)), SQLITE3_TEXT);
    } else {
        $stmt = $db->prepare('SELECT * FROM commission_events ORDER BY occurred_at DESC, event_key ASC LIMIT :limit');
    }
    $stmt->bindValue(':limit', max(1, (int)$limit), SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = json_decode((string)($row['metadata_json'] ?? ''), true);
        if (!is_array($row['metadata'])) $row['metadata'] = [];
        $rows[] = $row;
    }
    return $rows;
}

function commissionMilestoneCountForMonth(SQLite3 $db, $email, $year, $month) {
    [$start, $end] = commissionMonthRange($year, $month);
    $stmt = $db->prepare("
        SELECT COUNT(1) AS c
        FROM commission_events
        WHERE user_email = :user_email
          AND event_type = 'milestone'
          AND occurred_at BETWEEN :start_ts AND :end_ts
    ");
    $stmt->bindValue(':user_email', strtolower(trim((string)$email)), SQLITE3_TEXT);
    $stmt->bindValue(':start_ts', $start, SQLITE3_INTEGER);
    $stmt->bindValue(':end_ts', $end, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return (int)($row['c'] ?? 0);
}

function commissionMonthlyBreakdown(SQLite3 $db, $email, $year, $month) {
    [$start, $end] = commissionMonthRange($year, $month);
    $stmt = $db->prepare("
        SELECT event_type, COUNT(1) AS item_count, COALESCE(SUM(payout_cents), 0) AS payout_cents
        FROM commission_events
        WHERE user_email = :user_email
          AND occurred_at BETWEEN :start_ts AND :end_ts
        GROUP BY event_type
    ");
    $stmt->bindValue(':user_email', strtolower(trim((string)$email)), SQLITE3_TEXT);
    $stmt->bindValue(':start_ts', $start, SQLITE3_INTEGER);
    $stmt->bindValue(':end_ts', $end, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [
        'milestone' => ['count' => 0, 'payout_cents' => 0],
        'bonus_offer' => ['count' => 0, 'payout_cents' => 0],
        'referral_signup' => ['count' => 0, 'payout_cents' => 0],
        'referral_bonus' => ['count' => 0, 'payout_cents' => 0],
    ];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $type = (string)($row['event_type'] ?? '');
        if (!isset($rows[$type])) $rows[$type] = ['count' => 0, 'payout_cents' => 0];
        $rows[$type] = [
            'count' => (int)($row['item_count'] ?? 0),
            'payout_cents' => (int)($row['payout_cents'] ?? 0),
        ];
    }
    $rows['total_payout_cents'] = 0;
    foreach ($rows as $type => $values) {
        if ($type === 'total_payout_cents') continue;
        $rows['total_payout_cents'] += (int)($values['payout_cents'] ?? 0);
    }
    return $rows;
}

function commissionNextCommissionDueTs($year, $month) {
    $currentTs = mktime(12, 0, 0, $month, 1, $year);
    $nextMonthTs = strtotime('+1 month', $currentTs);
    $dueDates = commissionDueDatesForMonth((int)date('Y', $nextMonthTs), (int)date('n', $nextMonthTs));
    return (int)($dueDates[0] ?? 0);
}

function commissionEnsurePayrollRows(SQLite3 $db, $emails) {
    $emails = array_values(array_unique(array_filter(array_map(function($email) {
        return strtolower(trim((string)$email));
    }, $emails))));
    if (!$emails) return;

    $now = time();
    $startMonthTs = strtotime(date('Y-m-01', strtotime('-24 months', $now)));
    for ($i = 0; $i < 49; $i++) {
        $monthTs = strtotime('+' . $i . ' month', $startMonthTs);
        $year = (int)date('Y', $monthTs);
        $month = (int)date('n', $monthTs);
        [$due1, $due2] = commissionDueDatesForMonth($year, $month);
        $prevTs = strtotime('-1 month', $monthTs);
        $prevYear = (int)date('Y', $prevTs);
        $prevMonth = (int)date('n', $prevTs);

        foreach ($emails as $email) {
            $settings = commissionUserSettings($db, $email);
            $base = (int)$settings['base_pay_cents'];
            $breakdown = commissionMonthlyBreakdown($db, $email, $prevYear, $prevMonth);
            $commissionCount = 0;
            foreach (['milestone', 'bonus_offer', 'referral_signup', 'referral_bonus'] as $type) {
                $commissionCount += (int)($breakdown[$type]['count'] ?? 0);
            }
            $commissionCents = (int)($breakdown['total_payout_cents'] ?? 0);

            foreach ([
                [
                    'period_key' => sprintf('%04d-%02d-a', $year, $month),
                    'due_date' => $due1,
                    'base_pay_cents' => $base,
                    'commission_cents' => $commissionCents,
                    'commission_count' => $commissionCount,
                    'metadata' => ['commission_month' => sprintf('%04d-%02d', $prevYear, $prevMonth), 'kind' => 'semi_monthly_first', 'breakdown' => $breakdown],
                ],
                [
                    'period_key' => sprintf('%04d-%02d-b', $year, $month),
                    'due_date' => $due2,
                    'base_pay_cents' => $base,
                    'commission_cents' => 0,
                    'commission_count' => 0,
                    'metadata' => ['commission_month' => null, 'kind' => 'semi_monthly_second', 'breakdown' => []],
                ]
            ] as $row) {
                $existingStmt = $db->prepare('SELECT * FROM commission_payrolls WHERE user_email = :user_email AND period_key = :period_key LIMIT 1');
                $existingStmt->bindValue(':user_email', $email, SQLITE3_TEXT);
                $existingStmt->bindValue(':period_key', $row['period_key'], SQLITE3_TEXT);
                $existingRes = $existingStmt->execute();
                $existing = $existingRes ? $existingRes->fetchArray(SQLITE3_ASSOC) : false;
                $total = (int)$row['base_pay_cents'] + (int)$row['commission_cents'];
                if ($existing && strtolower(trim((string)($existing['status'] ?? ''))) === 'completed') continue;

                if ($existing) {
                    $stmt = $db->prepare("
                        UPDATE commission_payrolls
                        SET due_date = :due_date,
                            base_pay_cents = :base_pay_cents,
                            commission_cents = :commission_cents,
                            commission_count = :commission_count,
                            total_cents = :total_cents,
                            metadata_json = :metadata_json,
                            updated_at = :updated_at
                        WHERE id = :id
                    ");
                    $stmt->bindValue(':id', $existing['id'], SQLITE3_TEXT);
                } else {
                    $stmt = $db->prepare("
                        INSERT INTO commission_payrolls (
                            id, user_email, period_key, due_date, base_pay_cents, commission_cents, commission_count,
                            total_cents, status, completed_at, completed_by_email, metadata_json, created_at, updated_at
                        ) VALUES (
                            :id, :user_email, :period_key, :due_date, :base_pay_cents, :commission_cents, :commission_count,
                            :total_cents, 'pending', NULL, '', :metadata_json, :created_at, :updated_at
                        )
                    ");
                    $stmt->bindValue(':id', commissionId('payroll'), SQLITE3_TEXT);
                    $stmt->bindValue(':user_email', $email, SQLITE3_TEXT);
                    $stmt->bindValue(':period_key', $row['period_key'], SQLITE3_TEXT);
                    $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
                }
                $stmt->bindValue(':due_date', (int)$row['due_date'], SQLITE3_INTEGER);
                $stmt->bindValue(':base_pay_cents', (int)$row['base_pay_cents'], SQLITE3_INTEGER);
                $stmt->bindValue(':commission_cents', (int)$row['commission_cents'], SQLITE3_INTEGER);
                $stmt->bindValue(':commission_count', (int)$row['commission_count'], SQLITE3_INTEGER);
                $stmt->bindValue(':total_cents', $total, SQLITE3_INTEGER);
                $stmt->bindValue(':metadata_json', commissionSafeJson($row['metadata']), SQLITE3_TEXT);
                $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
                $stmt->execute();
            }
        }
    }
}

function commissionPayrollRows(SQLite3 $db, $userEmail = '', $limit = 200) {
    if ($userEmail !== '') {
        $stmt = $db->prepare('SELECT * FROM commission_payrolls WHERE user_email = :user_email ORDER BY due_date DESC LIMIT :limit');
        $stmt->bindValue(':user_email', strtolower(trim((string)$userEmail)), SQLITE3_TEXT);
    } else {
        $stmt = $db->prepare('SELECT * FROM commission_payrolls ORDER BY due_date DESC, user_email COLLATE NOCASE ASC LIMIT :limit');
    }
    $stmt->bindValue(':limit', max(1, (int)$limit), SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $row['metadata'] = json_decode((string)($row['metadata_json'] ?? ''), true);
        if (!is_array($row['metadata'])) $row['metadata'] = [];
        $rows[] = $row;
    }
    return $rows;
}

function commissionMilestoneRows(SQLite3 $db, $userEmail = '', $limit = 200) {
    if ($userEmail !== '') {
        $stmt = $db->prepare('SELECT * FROM commission_milestones WHERE sales_email = :sales_email ORDER BY milestone_at DESC LIMIT :limit');
        $stmt->bindValue(':sales_email', strtolower(trim((string)$userEmail)), SQLITE3_TEXT);
    } else {
        $stmt = $db->prepare('SELECT * FROM commission_milestones ORDER BY milestone_at DESC LIMIT :limit');
    }
    $stmt->bindValue(':limit', max(1, (int)$limit), SQLITE3_INTEGER);
    $res = $stmt->execute();
    $rows = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) $rows[] = $row;
    return $rows;
}

function commissionTeamRows(SQLite3 $db, $salesUsers, $year, $month) {
    $rows = [];
    foreach ($salesUsers as $user) {
        $email = strtolower(trim((string)($user['email'] ?? '')));
        if ($email === '') continue;
        $settings = commissionUserSettings($db, $email);
        $breakdown = commissionMonthlyBreakdown($db, $email, $year, $month);
        $rows[] = [
            'email' => $email,
            'name' => (string)($user['name'] ?? $email),
            'role' => (string)($user['role'] ?? ''),
            'department' => (string)($user['department'] ?? ''),
            'settings' => $settings,
            'current_hits' => (int)($breakdown['milestone']['count'] ?? 0),
            'current_commission_cents' => (int)($breakdown['total_payout_cents'] ?? 0),
            'breakdown' => $breakdown,
        ];
    }
    usort($rows, function ($a, $b) {
        return ((int)$b['current_commission_cents'] <=> (int)$a['current_commission_cents'])
            ?: strcmp((string)$a['name'], (string)$b['name']);
    });
    return $rows;
}

function commissionCsvReport(array $team, array $payroll, $monthLabel) {
    $fh = fopen('php://temp', 'r+');
    fputcsv($fh, ['Month', 'SDR', 'Email', 'Milestones', 'Milestone $', 'Bonus $', 'Referral Signup $', 'Referral Bonus $', 'Total $', 'Quota', 'Base / Check']);
    foreach ($team as $row) {
        $breakdown = is_array($row['breakdown'] ?? null) ? $row['breakdown'] : [];
        fputcsv($fh, [
            $monthLabel,
            (string)($row['name'] ?? ''),
            (string)($row['email'] ?? ''),
            (int)($breakdown['milestone']['count'] ?? 0),
            round(((int)($breakdown['milestone']['payout_cents'] ?? 0)) / 100, 2),
            round(((int)($breakdown['bonus_offer']['payout_cents'] ?? 0)) / 100, 2),
            round(((int)($breakdown['referral_signup']['payout_cents'] ?? 0)) / 100, 2),
            round(((int)($breakdown['referral_bonus']['payout_cents'] ?? 0)) / 100, 2),
            round(((int)($breakdown['total_payout_cents'] ?? 0)) / 100, 2),
            (int)($row['settings']['monthly_quota'] ?? 0),
            round(((int)($row['settings']['base_pay_cents'] ?? 0)) / 100, 2),
        ]);
    }
    fputcsv($fh, []);
    fputcsv($fh, ['Payroll Due', 'SDR', 'Email', 'Base $', 'Commission $', 'Total $', 'Status', 'Completed At', 'Completed By']);
    foreach ($payroll as $row) {
        fputcsv($fh, [
            $row['due_date'] ? gmdate('Y-m-d', (int)$row['due_date']) : '',
            commissionUserNameByEmail((string)($row['user_email'] ?? '')),
            (string)($row['user_email'] ?? ''),
            round(((int)($row['base_pay_cents'] ?? 0)) / 100, 2),
            round(((int)($row['commission_cents'] ?? 0)) / 100, 2),
            round(((int)($row['total_cents'] ?? 0)) / 100, 2),
            (string)($row['status'] ?? ''),
            !empty($row['completed_at']) ? gmdate('Y-m-d', (int)$row['completed_at']) : '',
            (string)($row['completed_by_email'] ?? ''),
        ]);
    }
    rewind($fh);
    return stream_get_contents($fh);
}

function commissionDashboardPayload($forceRebuild = false) {
    $actor = commissionActorEmail();
    if ($actor === '') return ['success' => false, 'error' => 'Unauthorized'];
    if (!commissionCanViewOwnSummary() && !commissionCanManage()) {
        return ['success' => false, 'error' => 'You do not have permission to view commissions.'];
    }
    $db = commissionDb();
    commissionRebuildDerivedData($db, $forceRebuild);
    $salesUsers = commissionSalesUsers();
    commissionEnsurePayrollRows($db, array_column($salesUsers, 'email'));

    $now = time();
    $year = (int)date('Y', $now);
    $month = (int)date('n', $now);
    $settings = commissionUserSettings($db, $actor);
    $breakdown = commissionMonthlyBreakdown($db, $actor, $year, $month);
    $quota = (int)$settings['monthly_quota'];
    $payroll = commissionPayrollRows($db, $actor, 24);
    $events = commissionEventRows($db, $actor, 250);
    $milestones = commissionMilestoneRows($db, $actor, 100);

    $payload = [
        'success' => true,
        'can_manage' => commissionCanManage(),
        'actor_email' => $actor,
        'current_month' => sprintf('%04d-%02d', $year, $month),
        'settings' => $settings,
        'summary' => [
            'quota' => $quota,
            'current_hits' => (int)($breakdown['milestone']['count'] ?? 0),
            'quota_remaining' => max(0, $quota - (int)($breakdown['milestone']['count'] ?? 0)),
            'current_commission_cents' => (int)($breakdown['total_payout_cents'] ?? 0),
            'monthly_base_pay_cents' => (int)$settings['base_pay_cents'] * 2,
            'next_commission_due_ts' => commissionNextCommissionDueTs($year, $month),
            'next_commission_amount_cents' => (int)($breakdown['total_payout_cents'] ?? 0),
            'milestone_payout_cents' => (int)$settings['milestone_payout_cents'],
            'breakdown' => $breakdown,
        ],
        'payroll' => $payroll,
        'events' => $events,
        'milestones' => $milestones,
    ];

    if (commissionCanManage()) {
        $team = commissionTeamRows($db, $salesUsers, $year, $month);
        $managerPayroll = commissionPayrollRows($db, '', 400);
        $managerEvents = commissionEventRows($db, '', 1000);
        $payload['sales_users'] = $team;
        $payload['manager_payroll'] = $managerPayroll;
        $payload['manager_events'] = $managerEvents;
        $payload['manager_milestones'] = commissionMilestoneRows($db, '', 400);
        $payload['export'] = [
            'filename' => 'commissions_' . sprintf('%04d_%02d', $year, $month) . '.csv',
            'csv' => commissionCsvReport($team, $managerPayroll, sprintf('%04d-%02d', $year, $month)),
        ];
    }
    return $payload;
}

function handleCommissionActions($action) {
    $actions = [
        'commission_dashboard',
        'commission_save_user_settings',
        'commission_mark_payroll_completed',
        'commission_export_report',
    ];
    if (!in_array($action, $actions, true)) return false;
    header('Content-Type: application/json');
    if ($action === 'commission_dashboard') {
        $force = !empty($_POST['force']) || !empty($_GET['force']);
        echo json_encode(commissionDashboardPayload($force));
        return true;
    }

    $actor = commissionActorEmail();
    if ($actor === '' || !commissionCanManage()) {
        die(json_encode(['success' => false, 'error' => 'Unauthorized']));
    }
    $db = commissionDb();
    commissionRebuildDerivedData($db, true);
    commissionEnsurePayrollRows($db, array_column(commissionSalesUsers(), 'email'));

    if ($action === 'commission_save_user_settings') {
        $email = strtolower(trim((string)($_POST['user_email'] ?? '')));
        $quota = (int)($_POST['monthly_quota'] ?? 0);
        $basePay = (float)($_POST['base_pay'] ?? 0);
        $milestonePayout = (float)($_POST['milestone_payout'] ?? 0);
        if ($email === '') die(json_encode(['success' => false, 'error' => 'Missing user']));
        commissionSaveUserSettings($db, $email, $quota, (int)round($basePay * 100), (int)round($milestonePayout * 100), $actor);
        commissionRebuildDerivedData($db, true);
        commissionEnsurePayrollRows($db, [$email]);
        echo json_encode(commissionDashboardPayload(true));
        return true;
    }

    if ($action === 'commission_mark_payroll_completed') {
        $id = trim((string)($_POST['payroll_id'] ?? ''));
        if ($id === '') die(json_encode(['success' => false, 'error' => 'Missing payroll']));
        $stmt = $db->prepare("
            UPDATE commission_payrolls
            SET status = 'completed',
                completed_at = :completed_at,
                completed_by_email = :completed_by_email,
                updated_at = :updated_at
            WHERE id = :id
        ");
        $now = time();
        $stmt->bindValue(':completed_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':completed_by_email', $actor, SQLITE3_TEXT);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':id', $id, SQLITE3_TEXT);
        $stmt->execute();
        echo json_encode(commissionDashboardPayload(true));
        return true;
    }

    if ($action === 'commission_export_report') {
        if (!commissionCanExportReports()) {
            die(json_encode(['success' => false, 'error' => 'You do not have permission to export commission reports.']));
        }
        $payload = commissionDashboardPayload(true);
        $export = is_array($payload['export'] ?? null) ? $payload['export'] : [];
        echo json_encode([
            'success' => true,
            'filename' => (string)($export['filename'] ?? 'commissions.csv'),
            'csv' => (string)($export['csv'] ?? ''),
        ]);
        return true;
    }

    return false;
}
