<?php
require_once dirname(__DIR__) . '/_storage.php';

define('COMMISSION_REVENUE_MILESTONE_DOLLARS', 100);
define('COMMISSION_PAYOUT_CENTS', 1000);

function commissionDbPath() {
    return storageExistingPath('databases/commissions.sqlite', __DIR__ . '/commissions.sqlite', true);
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
            updated_at INTEGER NOT NULL DEFAULT 0,
            updated_by_email TEXT NOT NULL DEFAULT ''
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS commission_milestones (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            org_name TEXT NOT NULL DEFAULT '',
            sales_email TEXT NOT NULL DEFAULT '',
            milestone_count INTEGER NOT NULL DEFAULT 10,
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
    foreach ([
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
    if (function_exists('isAdmin') && isAdmin()) return true;
    if (function_exists('userHasPerm') && (userHasPerm($email, 'manage_users') || userHasPerm($email, 'manage_sales_users'))) return true;
    $role = strtolower(trim((string)(commissionActorData()['role'] ?? '')));
    return in_array($role, ['admin', 'system_admin', 'sales_manager'], true);
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

function commissionUserSettings(SQLite3 $db, $email) {
    $stmt = $db->prepare('SELECT * FROM commission_user_settings WHERE user_email = :user_email LIMIT 1');
    $stmt->bindValue(':user_email', strtolower(trim((string)$email)), SQLITE3_TEXT);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return [
        'user_email' => strtolower(trim((string)$email)),
        'monthly_quota' => (int)($row['monthly_quota'] ?? 0),
        'base_pay_cents' => (int)($row['base_pay_cents'] ?? 0),
        'updated_at' => (int)($row['updated_at'] ?? 0),
        'updated_by_email' => (string)($row['updated_by_email'] ?? ''),
    ];
}

function commissionSaveUserSettings(SQLite3 $db, $email, $monthlyQuota, $basePayCents, $actor) {
    $now = time();
    $stmt = $db->prepare("
        INSERT INTO commission_user_settings (user_email, monthly_quota, base_pay_cents, updated_at, updated_by_email)
        VALUES (:user_email, :monthly_quota, :base_pay_cents, :updated_at, :updated_by_email)
        ON CONFLICT(user_email) DO UPDATE SET
            monthly_quota = excluded.monthly_quota,
            base_pay_cents = excluded.base_pay_cents,
            updated_at = excluded.updated_at,
            updated_by_email = excluded.updated_by_email
    ");
    $stmt->bindValue(':user_email', strtolower(trim((string)$email)), SQLITE3_TEXT);
    $stmt->bindValue(':monthly_quota', max(0, (int)$monthlyQuota), SQLITE3_INTEGER);
    $stmt->bindValue(':base_pay_cents', max(0, (int)$basePayCents), SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    $stmt->bindValue(':updated_by_email', strtolower(trim((string)$actor)), SQLITE3_TEXT);
    $stmt->execute();
}

function commissionSyncMilestones(SQLite3 $db) {
    if (!function_exists('projectIndexDb') || !function_exists('orgDirPath')) return;

    $orgAssignments = [];
    $orgNames = [];
    foreach (scandir(orgDirPath()) as $f) {
        if ($f === '.' || $f === '..') continue;
        $o = orgRead($f);
        if (!is_array($o)) continue;
        $orgId = orgNormalizeId($o['id'] ?? $f);
        if ($orgId === '') continue;
        $orgAssignments[$orgId] = strtolower(trim((string)($o['assigned_sales_email'] ?? '')));
        $orgNames[$orgId] = (string)($o['name'] ?? $orgId);
    }

    $emailToOrg = [];
    foreach (glob(storageDir('users') . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) !== 'customer') continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        $orgId = orgNormalizeId($u['organization_id'] ?? '');
        if ($email !== '' && $orgId !== '') $emailToOrg[$email] = $orgId;
    }

    $orgOrders = [];
    $manifestCache = [];
    try {
        $pdb = projectIndexDb();
        $res = $pdb->query("
            SELECT
                id,
                COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) AS email,
                COALESCE(ca, qa, pa, da, 0) AS event_ts,
                st AS status
            FROM manifests
            WHERE COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) <> ''
              AND COALESCE(ca, qa, pa, da, 0) > 0
            ORDER BY COALESCE(ca, qa, pa, da, 0) ASC
        ");
        while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
            $email = strtolower(trim((string)($row['email'] ?? '')));
            $orgId = $emailToOrg[$email] ?? '';
            if ($orgId === '') continue;
            $status = strtolower(trim((string)($row['status'] ?? '')));
            if (in_array($status, ['cancelled', 'deleted'], true)) continue;
            $folderId = trim((string)($row['id'] ?? ''));
            if ($folderId === '') continue;
            if (!array_key_exists($folderId, $manifestCache)) {
                $manifestCache[$folderId] = null;
                if (function_exists('locateProjectDir')) {
                    $dir = locateProjectDir($folderId);
                    $manifestPath = $dir ? ($dir . 'manifest.json') : '';
                    if ($manifestPath !== '' && file_exists($manifestPath)) {
                        $manifest = json_decode((string)@file_get_contents($manifestPath), true);
                        if (is_array($manifest)) $manifestCache[$folderId] = $manifest;
                    }
                }
            }
            $manifest = $manifestCache[$folderId];
            if (!is_array($manifest)) continue;
            $amount = commissionManifestRevenueDollars($manifest);
            if ($amount <= 0) continue;
            if (!isset($orgOrders[$orgId])) $orgOrders[$orgId] = [];
            $orgOrders[$orgId][] = [
                'ts' => (int)($row['event_ts'] ?? 0),
                'amount' => $amount,
            ];
        }
    } catch (Throwable $e) {
        return;
    }

    $now = time();
    $db->exec('DELETE FROM commission_milestones');
    foreach ($orgOrders as $orgId => $orders) {
        usort($orders, function($a, $b) {
            return ((int)($a['ts'] ?? 0)) <=> ((int)($b['ts'] ?? 0));
        });
        $runningRevenue = 0;
        $milestoneAt = 0;
        foreach ($orders as $order) {
            $runningRevenue += max(0, (int)($order['amount'] ?? 0));
            if ($runningRevenue >= COMMISSION_REVENUE_MILESTONE_DOLLARS) {
                $milestoneAt = (int)($order['ts'] ?? 0);
                break;
            }
        }
        if ($milestoneAt <= 0) continue;

        $stmt = $db->prepare("
            INSERT INTO commission_milestones (
                id, org_id, org_name, sales_email, milestone_count, milestone_at, source_report_count, created_at, updated_at
            ) VALUES (
                :id, :org_id, :org_name, :sales_email, :milestone_count, :milestone_at, :source_report_count, :created_at, :updated_at
            )
        ");
        $stmt->bindValue(':id', commissionId('milestone'), SQLITE3_TEXT);
        $stmt->bindValue(':org_id', $orgId, SQLITE3_TEXT);
        $stmt->bindValue(':org_name', (string)($orgNames[$orgId] ?? $orgId), SQLITE3_TEXT);
        $stmt->bindValue(':sales_email', (string)($orgAssignments[$orgId] ?? ''), SQLITE3_TEXT);
        $stmt->bindValue(':milestone_count', COMMISSION_REVENUE_MILESTONE_DOLLARS, SQLITE3_INTEGER);
        $stmt->bindValue(':milestone_at', $milestoneAt, SQLITE3_INTEGER);
        $stmt->bindValue(':source_report_count', count($orders), SQLITE3_INTEGER);
        $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        $stmt->execute();
    }
}

function commissionAmountForMilestones($count) {
    return max(0, (int)$count) * COMMISSION_PAYOUT_CENTS;
}

function commissionManifestRevenueDollars($manifest) {
    if (!is_array($manifest)) return 0;
    $charged = $manifest['amount_charged'] ?? null;
    if ($charged !== null && is_numeric($charged)) {
        return max(0, (int)round((float)$charged));
    }
    if (function_exists('projectTypePrice')) {
        $projectType = strtolower(trim((string)($manifest['project_type'] ?? 'residential')));
        return max(0, (int)projectTypePrice($projectType));
    }
    return 0;
}

function commissionNextCommissionDueTs($year, $month) {
    $currentTs = mktime(0, 0, 0, $month, 1, $year);
    $nextMonthTs = strtotime('+1 month', $currentTs);
    $dueDates = commissionDueDatesForMonth((int)date('Y', $nextMonthTs), (int)date('n', $nextMonthTs));
    return (int)($dueDates[0] ?? 0);
}

function commissionMilestoneCountForMonth(SQLite3 $db, $email, $year, $month) {
    [$start, $end] = commissionMonthRange($year, $month);
    $stmt = $db->prepare("
        SELECT COUNT(1) AS c
        FROM commission_milestones
        WHERE sales_email = :sales_email
          AND milestone_at BETWEEN :start_ts AND :end_ts
    ");
    $stmt->bindValue(':sales_email', strtolower(trim((string)$email)), SQLITE3_TEXT);
    $stmt->bindValue(':start_ts', $start, SQLITE3_INTEGER);
    $stmt->bindValue(':end_ts', $end, SQLITE3_INTEGER);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return (int)($row['c'] ?? 0);
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
            $commissionCount = commissionMilestoneCountForMonth($db, $email, $prevYear, $prevMonth);
            $commissionCents = commissionAmountForMilestones($commissionCount);

            foreach ([
                [
                    'period_key' => sprintf('%04d-%02d-a', $year, $month),
                    'due_date' => $due1,
                    'base_pay_cents' => $base,
                    'commission_cents' => $commissionCents,
                    'commission_count' => $commissionCount,
                    'metadata' => ['commission_month' => sprintf('%04d-%02d', $prevYear, $prevMonth), 'kind' => 'semi_monthly_first'],
                ],
                [
                    'period_key' => sprintf('%04d-%02d-b', $year, $month),
                    'due_date' => $due2,
                    'base_pay_cents' => $base,
                    'commission_cents' => 0,
                    'commission_count' => 0,
                    'metadata' => ['commission_month' => null, 'kind' => 'semi_monthly_second'],
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
                $stmt->bindValue(':metadata_json', json_encode($row['metadata']), SQLITE3_TEXT);
                $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
                $stmt->execute();
            }
        }
    }
}

function commissionPayrollRows(SQLite3 $db, $userEmail = '', $limit = 200) {
    $where = [];
    $stmt = null;
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

function commissionDashboardPayload() {
    $actor = commissionActorEmail();
    if ($actor === '') return ['success' => false, 'error' => 'Unauthorized'];
    $db = commissionDb();
    commissionSyncMilestones($db);
    $salesUsers = commissionSalesUsers();
    commissionEnsurePayrollRows($db, array_column($salesUsers, 'email'));

    $now = time();
    $year = (int)date('Y', $now);
    $month = (int)date('n', $now);
    $settings = commissionUserSettings($db, $actor);
    $currentHits = commissionMilestoneCountForMonth($db, $actor, $year, $month);
    $currentCommissionCents = commissionAmountForMilestones($currentHits);
    $quota = (int)$settings['monthly_quota'];
    $payroll = commissionPayrollRows($db, $actor, 24);
    $milestones = commissionMilestoneRows($db, $actor, 24);

    $payload = [
        'success' => true,
        'can_manage' => commissionCanManage(),
        'actor_email' => $actor,
        'current_month' => sprintf('%04d-%02d', $year, $month),
        'settings' => $settings,
        'summary' => [
            'quota' => $quota,
            'current_hits' => $currentHits,
            'quota_remaining' => max(0, $quota - $currentHits),
            'current_commission_cents' => $currentCommissionCents,
            'monthly_base_pay_cents' => (int)$settings['base_pay_cents'] * 2,
            'next_commission_due_ts' => commissionNextCommissionDueTs($year, $month),
            'next_commission_amount_cents' => $currentCommissionCents,
        ],
        'payroll' => $payroll,
        'milestones' => $milestones,
    ];

    if (commissionCanManage()) {
        $team = [];
        foreach ($salesUsers as $user) {
            $email = strtolower(trim((string)($user['email'] ?? '')));
            $userSettings = commissionUserSettings($db, $email);
            $hits = commissionMilestoneCountForMonth($db, $email, $year, $month);
            $team[] = [
                'email' => $email,
                'name' => (string)($user['name'] ?? $email),
                'role' => (string)($user['role'] ?? ''),
                'department' => (string)($user['department'] ?? ''),
                'settings' => $userSettings,
                'current_hits' => $hits,
                'current_commission_cents' => commissionAmountForMilestones($hits),
            ];
        }
        $payload['sales_users'] = $team;
        $payload['manager_payroll'] = commissionPayrollRows($db, '', 400);
        $payload['manager_milestones'] = commissionMilestoneRows($db, '', 400);
    }
    return $payload;
}

function handleCommissionActions($action) {
    $actions = [
        'commission_dashboard',
        'commission_save_user_settings',
        'commission_mark_payroll_completed',
    ];
    if (!in_array($action, $actions, true)) return false;
    header('Content-Type: application/json');
    if ($action === 'commission_dashboard') {
        echo json_encode(commissionDashboardPayload());
        return true;
    }

    $actor = commissionActorEmail();
    if ($actor === '' || !commissionCanManage()) {
        die(json_encode(['success' => false, 'error' => 'Unauthorized']));
    }
    $db = commissionDb();
    commissionSyncMilestones($db);
    commissionEnsurePayrollRows($db, array_column(commissionSalesUsers(), 'email'));

    if ($action === 'commission_save_user_settings') {
        $email = strtolower(trim((string)($_POST['user_email'] ?? '')));
        $quota = (int)($_POST['monthly_quota'] ?? 0);
        $basePay = (float)($_POST['base_pay'] ?? 0);
        if ($email === '') die(json_encode(['success' => false, 'error' => 'Missing user']));
        commissionSaveUserSettings($db, $email, $quota, (int)round($basePay * 100), $actor);
        commissionEnsurePayrollRows($db, [$email]);
        echo json_encode(commissionDashboardPayload());
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
        echo json_encode(commissionDashboardPayload());
        return true;
    }

    return false;
}
