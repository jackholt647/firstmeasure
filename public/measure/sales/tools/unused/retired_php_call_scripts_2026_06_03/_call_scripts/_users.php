<?php
require_once dirname(__DIR__) . '/_storage.php';
/**
 * _users.php
 *
 * User-related functions and action handlers.
 * This file should be included AFTER all config, globals, and org functions are defined.
 *
 * Contains:
 * - User helper functions (read/write, permissions, auth checks)
 * - User action handlers (register, login, OTP, user management)
 * - Shift scheduling, live shift status, and session stats
 *
 * Shift schedule data is stored directly on each user's JSON file under
 * the "shift_schedule" key:
 *   "shift_schedule" => {
 *       "recurring"  => { "monday" => [ {start,end,role}, … ], … },
 *       "overrides"  => { "2026-02-20" => [ {start,end,role} ] | [] (day off) },
 *       "updated_at" => "2026-02-16T10:00:00+00:00",
 *       "updated_by" => "admin@example.com"
 *   }
 *
 * Shift permissions (stored in user JSON under permissions):
 *   shift_view: "all" | "team" | "self" | "none"
 *   shift_edit: "all" | "team" | "self" | "none"
 */

// ------------------------------------------------
// -------------- SHIFT CONSTANTS -----------------
// ------------------------------------------------
$SHIFT_VALID_ROLES = ['technician', 'qa', 'manager'];
$SHIFT_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ------------------------------------------------
// ---------------- USER HELPER FUNCTIONS ---------
// ------------------------------------------------

function captureAttribution() {
    $fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', '_fbc', '_fbp'];
    $att = [];
    foreach ($fields as $f) {
        $val = trim((string)($_POST[$f] ?? ''));
        $att[$f] = ($val !== '') ? $val : null;
    }
    $att['signup_ts'] = time();
    $att['client_ip'] = $_SERVER['REMOTE_ADDR'] ?? null;
    $att['client_ua'] = $_SERVER['HTTP_USER_AGENT'] ?? null;

    // Check if we got anything at all
    $hasAny = false;
    foreach ($fields as $f) {
        if ($att[$f] !== null) { $hasAny = true; break; }
    }
    if (!$hasAny) {
        $att['utm_source'] = 'direct';
    }

    return $att;
}

function getUserFilename($email) {
    return preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email))) . '.json';
}

function isAdmin() {
    return (isset($_SESSION['user_is_admin']) && $_SESSION['user_is_admin'] === true);
}

function readUserDataByEmail($email) {
    global $userDir;
    $email = strtolower(trim((string)$email));
    $file = $userDir . getUserFilename($email);
    if (!file_exists($file)) return null;
    $d = json_decode(@file_get_contents($file), true);
    if (!is_array($d)) return null;
    $d['email'] = strtolower(trim((string)($d['email'] ?? $email)));
    $changed = false;
    if (ensureUserId($d)) $changed = true;
    if (ensureUserCreditsFields($d)) $changed = true;
    if (ensureUserOrgFields($d)) $changed = true;
    if (ensureUserShiftFields($d)) $changed = true;
    if ($changed) @atomicWriteJson($file, $d);
    return $d;
}

function writeUserDataByEmail($email, $data) {
    global $userDir;
    $email = strtolower(trim((string)$email));
    $file = $userDir . getUserFilename($email);
    if (!is_array($data)) $data = [];
    $data['email'] = strtolower(trim((string)($data['email'] ?? $email)));
    ensureUserId($data);
    ensureUserCreditsFields($data);
    ensureUserOrgFields($data);
    ensureUserShiftFields($data);
    return atomicWriteJson($file, $data);
}

function ensureUserCreditsFields(&$u) {
    $changed = false;
    if (!is_array($u)) { $u = []; $changed = true; }
    if (!isset($u['credits_balance'])) { $u['credits_balance'] = 0; $changed = true; }
    if (!is_int($u['credits_balance'])) { $u['credits_balance'] = (int)$u['credits_balance']; $changed = true; }
    if (!isset($u['credits_ledger']) || !is_array($u['credits_ledger'])) { $u['credits_ledger'] = []; $changed = true; }
    return $changed;
}

function isAuthorized($folderId) {
    if (!isset($_SESSION['user_email'])) return false;
    if (isset($_SESSION['user_is_admin']) && $_SESSION['user_is_admin'] === true) return true;
    return true;
    
    //TODO: Fix this
    global $userDir;
    $userFile = $userDir . getUserFilename($_SESSION['user_email']);
    if (!file_exists($userFile)) return false;
    $userData = json_decode(file_get_contents($userFile), true);
    $myProjects = $userData['projects'] ?? [];
    return in_array($folderId, $myProjects);
}

function getUserTeamId($email) {
    $u = readUserDataByEmail($email);
    return ($u && !empty($u['team_id'])) ? $u['team_id'] : 'default';
}

function ensureUserId(&$u) {
    if (!is_array($u)) $u = [];
    $id = strtolower(trim((string)($u['id'] ?? '')));
    if ($id !== '') { $u['id'] = $id; return false; }
    $u['id'] = genHexId(10);
    return true; // changed
}

// ============================================================
// ORG-SCOPED PERMISSIONS (customer/org) + GLOBAL PERMS (employee)
// ============================================================
function ensureUserOrgFields(&$u) {
    $changed = false;
    if (!is_array($u)) { $u = []; $changed = true; }
    if (!isset($u['organization_id'])) { $u['organization_id'] = null; $changed = true; }
    if (!isset($u['org_permissions_by_org']) || !is_array($u['org_permissions_by_org'])) {
        $u['org_permissions_by_org'] = [];
        $changed = true;
    }
    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    // Legacy migrate: org_permissions -> org_permissions_by_org[orgId]
    if ($orgId !== '') {
        $hasBlock = (isset($u['org_permissions_by_org'][$orgId]) && is_array($u['org_permissions_by_org'][$orgId]));
        if (!$hasBlock && isset($u['org_permissions']) && is_array($u['org_permissions'])) {
            $lvl = strtolower(trim((string)($u['org_permissions']['level'] ?? 'viewer'))) ?: 'viewer';
            $items = $u['org_permissions']['items'] ?? [];
            if (!is_array($items)) $items = [];
            $u['org_permissions_by_org'][$orgId] = [
                'org_id' => $orgId,
                'level'  => $lvl,
                'items'  => $items,
            ];
            $changed = true;
        }
    }
    // Normalize all blocks + keys
    foreach ($u['org_permissions_by_org'] as $k => $v) {
        $oid = orgNormalizeId($k);
        if ($oid === '' || !is_array($v)) { unset($u['org_permissions_by_org'][$k]); $changed = true; continue; }
        $lvl = strtolower(trim((string)($v['level'] ?? 'viewer'))) ?: 'viewer';
        $items = $v['items'] ?? [];
        if (!is_array($items)) $items = [];
        $norm = [
            'org_id' => $oid,
            'level'  => $lvl,
            'items'  => $items,
        ];
        if ($oid !== $k) { unset($u['org_permissions_by_org'][$k]); $changed = true; }
        if (!isset($u['org_permissions_by_org'][$oid]) || $u['org_permissions_by_org'][$oid] !== $norm) {
            $u['org_permissions_by_org'][$oid] = $norm;
            $changed = true;
        }
    }
    // Maintain legacy mirrors for current org only (UI convenience)
    if ($orgId !== '' && isset($u['org_permissions_by_org'][$orgId])) {
        $want = [
            'level' => $u['org_permissions_by_org'][$orgId]['level'],
            'items' => $u['org_permissions_by_org'][$orgId]['items'],
        ];
        if (!isset($u['org_permissions']) || !is_array($u['org_permissions']) || $u['org_permissions'] !== $want) {
            $u['org_permissions'] = $want;
            $changed = true;
        }
        if (($u['org_permission_level'] ?? null) !== $want['level']) { $u['org_permission_level'] = $want['level']; $changed = true; }
        if (($u['org_permission_items'] ?? null) !== $want['items']) { $u['org_permission_items'] = $want['items']; $changed = true; }
    } else {
        if (!isset($u['org_permissions']) || !is_array($u['org_permissions'])) {
            $u['org_permissions'] = ['level' => 'viewer', 'items' => []];
            $changed = true;
        }
    }
    return $changed;
}

function orgPermissionPresets() {
    // ORG-ONLY permission keys (customers/org admins)
    return [
        'super_admin' => ['*' => true],
        'admin' => [
            'order_reports'              => true,
            'view_reports'               => true,
            'manage_billing'             => true,
            'manage_company_settings'    => true,
            'manage_report_settings'     => true,
            'manage_company_users'       => true,
            // IMPORTANT: admin cannot change user perms
            'manage_company_user_permissions' => false,
        ],
        'manager' => [
            'order_reports'              => true,
            'view_reports'               => true,
            'manage_billing'             => false,
            'manage_company_settings'    => false,
            'manage_report_settings'     => false,
            'manage_company_users'       => false,
            'manage_company_user_permissions' => false,
        ],
        'viewer' => [
            'order_reports'              => false,
            'view_reports'               => true,
            'manage_billing'             => false,
            'manage_company_settings'    => false,
            'manage_report_settings'     => false,
            'manage_company_users'       => false,
            'manage_company_user_permissions' => false,
        ],
        // 'custom' handled explicitly
    ];
}

function normalizePermItems($arr) {
    if (!is_array($arr)) return [];
    $out = [];
    foreach ($arr as $k => $v) $out[(string)$k] = !empty($v);
    return $out;
}

// Effective ORG perms only (wildcard only applies inside org)
function userEffectiveOrgPerms($u, $orgId) {
    if (!is_array($u)) return [];
    ensureUserOrgFields($u);
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return [];
    $block = $u['org_permissions_by_org'][$orgId] ?? null;
    // If user is in org but no explicit block exists, default to viewer
    $lvl = 'viewer';
    $items = [];
    if (is_array($block)) {
        $lvl = strtolower(trim((string)($block['level'] ?? 'viewer'))) ?: 'viewer';
        $items = $block['items'] ?? [];
        if (!is_array($items)) $items = [];
    }
    if ($lvl === 'custom') return normalizePermItems($items);
    if ($lvl === 'super_admin') return ['*' => true];
    $presets = orgPermissionPresets();
    if (isset($presets[$lvl])) return $presets[$lvl];
    return $presets['viewer'];
}

// Effective GLOBAL perms only (employee tooling)
function userEffectiveGlobalPerms($u) {
    if (!is_array($u)) return [];
    // Site admin / legacy admin flag => global all
    if (!empty($u['is_admin']) || (($u['role'] ?? '') === 'admin')) return ['*' => true];
    // Global employee perms live here (your original intent)
    $legacy = $u['permissions'] ?? [];
    return normalizePermItems($legacy);
}

function userHasOrgPerm($email, $orgId, $permKey) {
    $email = strtolower(trim((string)$email));
    $permKey = (string)$permKey;
    $orgId = orgNormalizeId($orgId);
    if ($email === '' || $permKey === '' || $orgId === '') return false;
    // Site admin override (still global admin)
    if (isset($_SESSION['user_is_admin']) && $_SESSION['user_is_admin'] === true) return true;
    $u = readUserDataByEmail($email);
    if (!$u) return false;
    // Must belong to that org
    $uOrg = orgNormalizeId($u['organization_id'] ?? '');
    if ($uOrg !== $orgId) return false;
    $eff = userEffectiveOrgPerms($u, $orgId);
    if (!is_array($eff)) $eff = [];
    if (!empty($eff['*'])) return true;
    return !empty($eff[$permKey]);
}

function userHasGlobalPerm($email, $permKey) {
    $email = strtolower(trim((string)$email));
    $permKey = (string)$permKey;
    if ($email === '' || $permKey === '') return false;
    // Site admin override
    if (isset($_SESSION['user_is_admin']) && $_SESSION['user_is_admin'] === true) return true;
    $u = readUserDataByEmail($email);
    if (!$u) return false;
    $eff = userEffectiveGlobalPerms($u);
    if (!is_array($eff)) $eff = [];
    if (!empty($eff['*'])) return true;
    return !empty($eff[$permKey]);
}

// Backward-compatible wrapper (kept only if lots of code calls it)
// IMPORTANT: This now checks GLOBAL perms by default.
// Use userHasOrgPerm() for org-scoped checks.
function userHasPerm($email, $permKey) {
    return userHasGlobalPerm($email, $permKey);
}

function isEmployeeUserByEmail($email) {
    $u = readUserDataByEmail($email);
    if (!$u) return false;
    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'employee') return true;
    if ($acct === 'customer') return false;
    // If account_type isn't set, fall back to GLOBAL perms only
    if (userHasGlobalPerm($email, 'manage_queue')) return true;
    if (userHasGlobalPerm($email, 'manage_qa')) return true;
    if (userHasGlobalPerm($email, 'is_admin_legacy')) return true;
    return false;
}

function isQueueAdminUser() {
    if (!isset($_SESSION['user_email'])) return false;
    $email = $_SESSION['user_email'];
    if (isAdmin()) return true;
    return userHasGlobalPerm($email, 'manage_queue') || userHasGlobalPerm($email, 'is_admin_legacy');
}

function canQAUser() {
    if (!isset($_SESSION['user_email'])) return false;
    if (isAdmin()) return true;
    $email = $_SESSION['user_email'];
    return userHasGlobalPerm($email, 'manage_qa') || userHasGlobalPerm($email, 'is_admin_legacy');
}

// Coupons: employee/admin-only now (global)
function canManageCoupons() {
    if (!isset($_SESSION['user_email'])) return false;
    if (isAdmin()) return true;
    return userHasGlobalPerm($_SESSION['user_email'], 'manage_users');
}

// Org-scoped require
function requireOrgPermOrFail($permKey) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($email === '') die(json_encode(['success'=>false,'error'=>'Not logged in']));
    $orgId = actorOrgIdFromSession();
    if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
    if (!userHasOrgPerm($email, $orgId, $permKey)) {
        die(json_encode(['success'=>false,'error'=>'Unauthorized']));
    }
}

// Global-scoped require (employee)
function requireGlobalPermOrFail($permKey) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($email === '') die(json_encode(['success'=>false,'error'=>'Not logged in']));
    if (!userHasGlobalPerm($email, $permKey)) die(json_encode(['success'=>false,'error'=>'Unauthorized']));
}

function userPublicView($u) {
    if (!is_array($u)) $u = [];
    ensureUserId($u);
    ensureUserOrgFields($u);
    ensureUserShiftFields($u);
    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    $orgBlock = ($orgId !== '' && isset($u['org_permissions_by_org'][$orgId]) && is_array($u['org_permissions_by_org'][$orgId]))
        ? $u['org_permissions_by_org'][$orgId]
        : ['level'=>'viewer','items'=>[]];
    return [
        'id' => (string)($u['id'] ?? ''),
        'email' => (string)($u['email'] ?? ''),
        'name' => (string)($u['name'] ?? ''),
        'disabled' => !empty($u['disabled']),
        'deleted'  => !empty($u['deleted']),
        'is_verified' => !empty($u['is_verified']),
        'account_type' => (string)($u['account_type'] ?? ''),
        'team_id' => (string)($u['team_id'] ?? 'default'),
        'training_complete' => !empty($u['training_complete']),
        'shift_rate' => (int)($u['shift_rate'] ?? 940),
        // Org-scoped permissions for THIS org only (what your org UI edits)
        'org_permissions' => [
            'org_id' => $orgId,
            'level'  => (string)($orgBlock['level'] ?? 'viewer'),
            'items'  => is_array($orgBlock['items'] ?? null) ? $orgBlock['items'] : [],
        ],
        'effective_permissions' => userEffectiveOrgPerms($u, $orgId),
        'created_at' => $u['created_at'] ?? null,
        'last_login_at' => $u['last_login_at'] ?? null,
    ];
}

// ============================================================
function actorOrgIdByEmail($email) {
    $u = readUserDataByEmail($email);
    if (!$u) return null;
    $orgId = trim((string)($u['organization_id'] ?? ''));
    return $orgId !== '' ? orgNormalizeId($orgId) : null;
}

function sameOrg($emailA, $emailB) {
    $a = actorOrgIdByEmail($emailA);
    $b = actorOrgIdByEmail($emailB);
    return ($a && $b && $a === $b);
}

function actorCanManageTargetUser($actorEmail, $targetEmail) {
    if (isAdmin()) return true; // site admin
    $actorEmail = strtolower(trim((string)$actorEmail));
    $targetEmail = strtolower(trim((string)$targetEmail));
    if ($actorEmail === '' || $targetEmail === '') return false;
    if (!userHasPerm($actorEmail, 'manage_users')) return false;
    return sameOrg($actorEmail, $targetEmail);
}

function userFindFileById($userId) {
    $userId = strtolower(trim((string)$userId));
    if ($userId === '') return null;
    $userDir = $GLOBALS['userDir'] ?? (storageDir('users'));
    if (!is_dir($userDir)) return null;
    foreach (scandir($userDir) as $f) {
        if ($f === '.' || $f === '..') continue;
        if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
        $p = $userDir . $f;
        $u = json_decode(@file_get_contents($p), true);
        if (!is_array($u)) continue;
        $id = strtolower(trim((string)($u['id'] ?? '')));
        if ($id !== '' && $id === $userId) return $p;
    }
    return null;
}

function actorOrgIdFromSession() {
    if (!isset($_SESSION['user_email'])) return null;
    $email = strtolower(trim((string)$_SESSION['user_email']));
    $u = readUserDataByEmail($email);
    if (!$u) return null;
    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    return $orgId !== '' ? $orgId : null;
}

function requireLoginOrFail() {
    if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
}

// ------------------------------------------------
// ---------------- OTP / AUTH HELPERS -----------
// ------------------------------------------------
function sendOtpEmail($to, $code) {
    $to = strtolower(trim((string)$to));
    if ($to === '') return false;
    $subject = "1m8 Verification Code: $code";
    $text = "Your verification code is: $code\n\nThis code expires in 5 minutes.\n\nIf you did not request this, you can ignore this email.";
    $html = "<p>Your verification code is:</p>
             <p style=\"font-size:28px; font-weight:700; letter-spacing:2px;\">$code</p>
             <p>This code expires in <b>5 minutes</b>.</p>
             <p>If you did not request this, you can ignore this email.</p>";
    $ret = postmarkSendEmail($to, $subject, $text, $html);
    return !empty($ret['ok']);
}

function setupOtpSession($email, $name, $company, $isResetMode = false) {
    $otp = rand(100000, 999999);
    $_SESSION['otp_pending'] = true;
    $_SESSION['otp_code'] = $otp;
    $_SESSION['otp_attempts'] = 0;
    $_SESSION['otp_expires'] = time() + 300;
    $_SESSION['otp_email'] = $email;
    $_SESSION['otp_name'] = $name;
    $_SESSION['otp_company'] = $company;
    $_SESSION['is_password_reset'] = $isResetMode;
    sendOtpEmail($email, $otp);
    return $otp;
}

function sendWelcomeActivationEmail($toEmail, $toName, $orgName = '') {
    $toEmail = strtolower(trim((string)$toEmail));
    if ($toEmail === '') return ['ok'=>false, 'error'=>'missing_email'];
    $base = $GLOBALS['BASE_URL'] ?? '';
    $activateUrl = rtrim($base, '/') . '/activate.php?email=' . rawurlencode($toEmail);
    $subject = "You've been invited to FirstMate";
    $text =
"Hi " . (($toName && trim($toName) !== '') ? $toName : $toEmail) . ",
You've been invited" . (($orgName && trim($orgName) !== '') ? (" to " . $orgName) : "") . ".
Activate your account and set your password:
$activateUrl
";
    $html =
        '<p>Hi ' . htmlspecialchars(($toName && trim($toName) !== '') ? $toName : $toEmail) . ',</p>' .
        "<p>You've been invited" . (($orgName && trim($orgName) !== '') ? (' to <b>' . htmlspecialchars($orgName) . '</b>') : '') . '.</p>' .
        '<p><a href="' . htmlspecialchars($activateUrl) . '" style="display:inline-block; padding:10px 14px; background:#db0000; color:#fff; text-decoration:none; border-radius:10px; font-weight:800;">Activate account</a></p>' .
        '<p style="color:#666; font-size:12px;">Or open: ' . htmlspecialchars($activateUrl) . '</p>';
    $ret = postmarkSendEmail($toEmail, $subject, $text, $html);
    $ret['activate_url'] = $activateUrl;
    return $ret;
}

// ------------------------------------------------
// --------- SHIFT SCHEDULE FUNCTIONS -------------
// ------------------------------------------------

/**
 * Ensures the user record has a well-formed shift_schedule block.
 * Called lazily on read/write, same pattern as ensureUserCreditsFields().
 */
function ensureUserShiftFields(&$u) {
    $changed = false;
    if (!is_array($u)) { $u = []; $changed = true; }

    if (!isset($u['shift_schedule']) || !is_array($u['shift_schedule'])) {
        $u['shift_schedule'] = [
            'recurring'  => [],
            'overrides'  => [],
            'updated_at' => null,
            'updated_by' => null,
        ];
        $changed = true;
    }

    $ss = &$u['shift_schedule'];

    if (!isset($ss['recurring']) || !is_array($ss['recurring'])) {
        $ss['recurring'] = [];
        $changed = true;
    }
    if (!isset($ss['overrides']) || !is_array($ss['overrides'])) {
        $ss['overrides'] = [];
        $changed = true;
    }
    if (!array_key_exists('updated_at', $ss)) {
        $ss['updated_at'] = null;
        $changed = true;
    }
    if (!array_key_exists('updated_by', $ss)) {
        $ss['updated_by'] = null;
        $changed = true;
    }

    // Per-user shift rate (PHP currency per completed shift day)
    if (!isset($u['shift_rate']) || !is_numeric($u['shift_rate'])) {
        $u['shift_rate'] = 940; // default
        $changed = true;
    } else {
        $u['shift_rate'] = (int)$u['shift_rate'];
    }

    return $changed;
}

// ---- Shift permission helpers ----

function shiftViewLevel($email = null) {
    if (!$email) $email = $_SESSION['user_email'] ?? '';
    $email = strtolower(trim((string)$email));
    if ($email === '') return 'none';
    if (isAdmin()) return 'all';
    $u = readUserDataByEmail($email);
    if (!$u) return 'self';
    $perms = $u['permissions'] ?? [];
    $level = strtolower(trim((string)($perms['shift_view'] ?? '')));
    if (in_array($level, ['all', 'team', 'self', 'none'], true)) return $level;
    // Fallback: admins get all, queue admins get all, others get self
    if (!empty($perms['is_admin_legacy']) || ($u['role'] ?? '') === 'admin') return 'all';
    if (!empty($perms['manage_queue'])) return 'all';
    return 'self';
}

function shiftEditLevel($email = null) {
    if (!$email) $email = $_SESSION['user_email'] ?? '';
    $email = strtolower(trim((string)$email));
    if ($email === '') return 'none';
    if (isAdmin()) return 'all';
    $u = readUserDataByEmail($email);
    if (!$u) return 'none';
    $perms = $u['permissions'] ?? [];
    $level = strtolower(trim((string)($perms['shift_edit'] ?? '')));
    if (in_array($level, ['all', 'team', 'self', 'none'], true)) return $level;
    if (!empty($perms['is_admin_legacy']) || ($u['role'] ?? '') === 'admin') return 'all';
    return 'none';
}

function shiftCanView($actorEmail, $targetEmail) {
    $actor  = strtolower(trim((string)$actorEmail));
    $target = strtolower(trim((string)$targetEmail));
    $level  = shiftViewLevel($actor);
    if ($level === 'all') return true;
    if ($level === 'none') return false;
    if ($level === 'self') return ($actor === $target);
    if ($level === 'team') {
        return (getUserTeamId($actor) === getUserTeamId($target));
    }
    return false;
}

function shiftCanEdit($actorEmail, $targetEmail) {
    $actor  = strtolower(trim((string)$actorEmail));
    $target = strtolower(trim((string)$targetEmail));
    $level  = shiftEditLevel($actor);
    if ($level === 'all') return true;
    if ($level === 'none') return false;
    if ($level === 'self') return ($actor === $target);
    if ($level === 'team') {
        return (getUserTeamId($actor) === getUserTeamId($target));
    }
    return false;
}

// ---- Shift schedule helpers ----

function shiftValidateBlock($block) {
    global $SHIFT_VALID_ROLES;
    if (!is_array($block)) return null;
    $start = trim((string)($block['start'] ?? ''));
    $end   = trim((string)($block['end'] ?? ''));
    $role  = strtolower(trim((string)($block['role'] ?? 'technician')));
    if (!preg_match('/^\d{2}:\d{2}$/', $start)) return null;
    if (!preg_match('/^\d{2}:\d{2}$/', $end)) return null;
    if (!in_array($role, $SHIFT_VALID_ROLES, true)) $role = 'other';
    return ['start' => $start, 'end' => $end, 'role' => $role];
}

function shiftGetUserSchedule($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return ['recurring' => [], 'overrides' => []];
    $u = readUserDataByEmail($email);
    if (!$u) return ['recurring' => [], 'overrides' => []];
    ensureUserShiftFields($u);
    return $u['shift_schedule'];
}

function shiftSetUserSchedule($email, $scheduleData) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    $u = readUserDataByEmail($email);
    if (!$u) return false;
    ensureUserShiftFields($u);
    $u['shift_schedule'] = $scheduleData;
    return writeUserDataByEmail($email, $u);
}

/**
 * Resolve blocks inline from a pre-loaded shift_schedule array.
 * Avoids re-reading the user file.
 */
function shiftResolveBlocksInline($sched, $dateStr, $dayName) {
    $blocks = [];
    $overrides = $sched['overrides'] ?? [];
    if (is_array($overrides) && array_key_exists($dateStr, $overrides)) {
        $raw = $overrides[$dateStr];
        if (is_array($raw)) {
            foreach ($raw as $b) {
                $v = shiftValidateBlock($b);
                if ($v) $blocks[] = $v;
            }
        }
        return $blocks;
    }
    $recurring = $sched['recurring'] ?? [];
    $dayBlocks = $recurring[$dayName] ?? [];
    if (is_array($dayBlocks)) {
        foreach ($dayBlocks as $b) {
            $v = shiftValidateBlock($b);
            if ($v) $blocks[] = $v;
        }
    }
    return $blocks;
}

function shiftResolveForDate($email, $dateStr) {
    $email = strtolower(trim((string)$email));
    $sched = shiftGetUserSchedule($email);
    $ts = strtotime($dateStr);
    $dayName = $ts ? strtolower(date('l', $ts)) : '';
    return shiftResolveBlocksInline($sched, $dateStr, $dayName);
}

function shiftIsUserOnNow($email) {
    $today = date('Y-m-d');
    $nowTime = date('H:i');
    $blocks = shiftResolveForDate($email, $today);
    $active = [];
    foreach ($blocks as $b) {
        if ($b['start'] <= $nowTime && $b['end'] > $nowTime) {
            $active[] = $b;
        }
    }
    return [
        'on_shift'   => count($active) > 0,
        'blocks'     => $active,
        'all_blocks' => $blocks,
    ];
}

/**
 * Get all employees currently on shift.
 * Reads user files once and resolves shift_schedule inline.
 */
function shiftGetCurrentOnShift($teamFilter = 'all') {
    global $userDir;
    if (!is_dir($userDir)) return [];

    $today = date('Y-m-d');
    $nowTime = date('H:i');
    $dayName = strtolower(date('l'));

    $results = [];
    foreach (scandir($userDir) as $f) {
        if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
        $u = json_decode(@file_get_contents($userDir . $f), true);
        if (!is_array($u)) continue;

        $acct = strtolower(trim((string)($u['account_type'] ?? '')));
        if ($acct === 'customer') continue;

        $email = strtolower(trim((string)($u['email'] ?? '')));
        if ($email === '') continue;

        if (!empty($u['disabled']) || !empty($u['deleted'])) continue;

        // Only include trained users
        if (empty($u['training_complete'])) continue;

        $uTeam = (string)($u['team_id'] ?? 'default');
        if ($teamFilter !== 'all' && $uTeam !== $teamFilter) continue;

        ensureUserShiftFields($u);
        $blocks = shiftResolveBlocksInline($u['shift_schedule'], $today, $dayName);

        $active = [];
        foreach ($blocks as $b) {
            if ($b['start'] <= $nowTime && $b['end'] > $nowTime) {
                $active[] = $b;
            }
        }
        if (count($active) === 0) continue;

        $results[] = [
            'email'      => $email,
            'name'       => (string)($u['name'] ?? $email),
            'team_id'    => $uTeam,
            'role'       => (string)($u['role'] ?? 'user'),
            'on_break'   => !empty($u['on_break']),
            'break_started_at' => $u['break_started_at'] ?? null,
            'last_activity_at' => $u['last_activity_at'] ?? null,
            'shift_blocks' => $active,
            'all_blocks'   => $blocks,
        ];
    }
    return $results;
}

// ---- Shift session stats ----

function shiftSessionStats($email, $shiftStartTs, $shiftEndTs = null) {
    $email = strtolower(trim((string)$email));
    if (!$shiftEndTs) $shiftEndTs = time();

    $stats = [
        'email'             => $email,
        'shift_start'       => date('c', $shiftStartTs),
        'shift_end'         => date('c', $shiftEndTs),
        'completed'         => 0,
        'submitted_for_qa'  => 0,
        'qa_reviewed'       => 0,
        'corrections_done'  => 0,
        'categories'        => [],
        'projects'          => [],
        'first_project_at'  => null,
        'last_project_at'   => null,
        'current_project'   => null,
        'current_project_started_at' => null,
    ];

    if (!function_exists('pj_db')) return $stats;
    $db = pj_db();

    // --- Completed projects ---
    $stmtC = $db->prepare("
        SELECT id, da, st, cx
        FROM p
        WHERE asn = :email
          AND da >= :start
          AND da <= :end
          AND st = 'completed'
        ORDER BY da ASC
    ");
    $stmtC->bindValue(':email', $email, SQLITE3_TEXT);
    $stmtC->bindValue(':start', $shiftStartTs, SQLITE3_INTEGER);
    $stmtC->bindValue(':end', $shiftEndTs, SQLITE3_INTEGER);
    $res = $stmtC->execute();
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $stats['completed']++;
        $cat = 'technician';
        $ts = (int)($row['da'] ?? 0);
        $stats['projects'][] = [
            'id'   => (string)$row['id'],
            'type' => $cat,
            'at'   => $ts ? date('c', $ts) : null,
            'event'=> 'completed',
        ];
        $stats['categories'][$cat] = ($stats['categories'][$cat] ?? 0) + 1;
        if (!$stats['first_project_at'] || $ts < strtotime($stats['first_project_at'])) {
            $stats['first_project_at'] = date('c', $ts);
        }
        if (!$stats['last_project_at'] || $ts > strtotime($stats['last_project_at'])) {
            $stats['last_project_at'] = date('c', $ts);
        }
    }
    $res->finalize();

    // --- Submitted for QA ---
    $stmtS = $db->prepare("
        SELECT id, ua, st
        FROM p
        WHERE asn = :email
          AND ua >= :start
          AND ua <= :end
          AND st IN ('awaiting_review','completed','correction_needed')
        ORDER BY ua ASC
    ");
    $stmtS->bindValue(':email', $email, SQLITE3_TEXT);
    $stmtS->bindValue(':start', $shiftStartTs, SQLITE3_INTEGER);
    $stmtS->bindValue(':end', $shiftEndTs, SQLITE3_INTEGER);
    $resS = $stmtS->execute();
    while ($row = $resS->fetchArray(SQLITE3_ASSOC)) {
        $stats['submitted_for_qa']++;
    }
    $resS->finalize();

    // --- QA reviews done BY this user ---
    $stmtQ = $db->prepare("
        SELECT id, da
        FROM p
        WHERE st = 'completed'
          AND da >= :start
          AND da <= :end
        ORDER BY da ASC
        LIMIT 500
    ");
    $stmtQ->bindValue(':start', $shiftStartTs, SQLITE3_INTEGER);
    $stmtQ->bindValue(':end', $shiftEndTs, SQLITE3_INTEGER);
    $resQ = $stmtQ->execute();

    $baseDir = $GLOBALS['baseDir'] ?? '';
    while ($row = $resQ->fetchArray(SQLITE3_ASSOC)) {
        $folder = (string)($row['id'] ?? '');
        if ($folder === '') continue;
        $td = (function_exists('locateProjectDir') ? locateProjectDir($folder) : null)
              ?: rtrim($baseDir, '/\\') . '/' . $folder . '/';
        $mp = $td . 'manifest.json';
        if (!file_exists($mp)) continue;
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) continue;
        $qaBy = strtolower(trim((string)($m['qa_approved_by'] ?? '')));
        if ($qaBy === $email) {
            $stats['qa_reviewed']++;
            $cat = 'qa';
            $stats['categories'][$cat] = ($stats['categories'][$cat] ?? 0) + 1;
            $ts = (int)($row['da'] ?? 0);
            $stats['projects'][] = [
                'id'   => $folder,
                'type' => $cat,
                'at'   => $ts ? date('c', $ts) : null,
                'event'=> 'qa_approved',
            ];
            if (!$stats['first_project_at'] || ($ts && $ts < strtotime($stats['first_project_at']))) {
                $stats['first_project_at'] = date('c', $ts);
            }
            if (!$stats['last_project_at'] || ($ts && $ts > strtotime($stats['last_project_at']))) {
                $stats['last_project_at'] = date('c', $ts);
            }
        }
    }
    $resQ->finalize();

    // --- Currently working on ---
    $stmtCur = $db->prepare("
        SELECT id, sa
        FROM p
        WHERE asn = :email
          AND st IN ('processing','in_progress')
        ORDER BY sa DESC
        LIMIT 1
    ");
    $stmtCur->bindValue(':email', $email, SQLITE3_TEXT);
    $resCur = $stmtCur->execute();
    $curRow = $resCur->fetchArray(SQLITE3_ASSOC);
    $resCur->finalize();
    if ($curRow) {
        $stats['current_project'] = (string)$curRow['id'];
        $sa = (int)($curRow['sa'] ?? 0);
        $stats['current_project_started_at'] = $sa ? date('c', $sa) : null;
    }

    $stats['categories'] = array_filter($stats['categories'], function($v) { return $v > 0; });

    return $stats;
}

// ------------------------------------------------
// ---------------- USER ACTION HANDLERS ---------
// ------------------------------------------------

function handleUserActions($action) {
    global $userDir, $baseDir, $BASE_URL, $STRIPE_SECRET_KEY, $STRIPE_PRICE_ID;
    
    // ------------------------------------------------
    // ---------------- AUTH ACTIONS -----------------
    // ------------------------------------------------
    if ($action === 'register') {
        $email = strtolower(trim($_POST['email'] ?? ''));
        $password = $_POST['password'] ?? '';
        $name = $_POST['name'] ?? '';
        $phone = $_POST['phone'] ?? '';
        $company = $_POST['company'] ?? '';
        if (!$email || !$password) die(json_encode(['error' => 'Missing fields']));
        $userFile = $userDir . getUserFilename($email);
        if (file_exists($userFile)) die(json_encode(['error' => 'User exists']));
        $userId = genHexId(10);
        $orgId = orgCreateForNewSignup($email, $userId, $name, $company);
        if (!$orgId) die(json_encode(['error' => 'Org create failed']));

        $attribution = captureAttribution();

        $userData = [
            'id' => $userId,
            'email' => $email,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'name' => $name,
            'phone' => $phone,
            'company' => $company,
            'organization_id' => $orgId,
            'org_permissions' => [
                'level' => 'super_admin',
                'items' => [],
            ],
            'attribution' => $attribution,
            'is_verified' => false,
            'is_admin' => false,
            'failed_attempts' => 0,
            'seen_tutorial' => false,
            'created_at' => date('Y-m-d H:i:s'),
            'projects' => [],
            'team_id' => 'default',
            'permissions' => [
                'view_all_projects' => false,
                'view_team_projects' => false,
                'manage_users' => false,
                'create_users' => false,
                'assign_teams' => false,
                'manage_tutorials' => false,
                'is_admin_legacy' => false,
                'manage_queue' => false,
                'shift_view' => 'self',
                'shift_edit' => 'none',
            ],
            'role' => 'user',
            'account_type' => 'customer',
            'credits_balance' => 0,
            'credits_ledger' => [],
        ];
        if (atomicWriteJson($userFile, $userData)) {
            $org = orgRead($orgId);
            if (is_array($org)) {
                $org['attribution'] = $attribution;
                orgWrite($orgId, $org);
            }

            opsNotifyNewSignup($email, $name, $company, $phone);
            capiCompleteRegistration($email, $userId, ['fn' => $name, 'phone' => $phone]);
            setupOtpSession($email, $name, $company);
            echo json_encode(['success' => false, 'require_otp' => true, 'email' => $email]);
        } else {
            echo json_encode(['error' => 'Write error']);
        }
        return true;
    }

    if ($action === 'login') {
        $email = strtolower(trim($_POST['email'] ?? ''));
        $password = $_POST['password'] ?? '';
        $userFile = $userDir . getUserFilename($email);
        if (!file_exists($userFile)) die(json_encode(['error' => 'User not found']));
        $userData = json_decode(file_get_contents($userFile), true);
        if (!is_array($userData)) $userData = [];
        // ✅ Avoid undefined array key warnings on legacy user files
        if (!array_key_exists('name', $userData)) $userData['name'] = '';
        if (!array_key_exists('company', $userData)) $userData['company'] = '';
        if (!array_key_exists('phone', $userData)) $userData['phone'] = '';
        $userData['name'] = (string)$userData['name'];
        $userData['company'] = (string)$userData['company'];
        $userData['phone'] = (string)$userData['phone'];
        
        if (!empty($userData['deleted'])) {
            die(json_encode(['error' => 'Account deleted. Contact your administrator.']));
        }
        if (!empty($userData['disabled'])) {
            die(json_encode(['error' => 'Account suspended. Contact your administrator.']));
        }
        ensureUserCreditsFields($userData);
        ensureUserOrgFields($userData);
        ensureUserId($userData);
        $fails = $userData['failed_attempts'] ?? 0;
        if (password_verify($password, $userData['password_hash'])) {
            if ($fails >= 5) {
                setupOtpSession($email, $userData['name'], $userData['company']);
                echo json_encode(['error'=>'Locked','require_otp'=>true,'email'=>$email,'message'=>'Account locked. Enter code.']);
                return true;
            }
            if (!empty($userData['is_verified']) && $userData['is_verified'] === true) {
                if ($fails > 0) $userData['failed_attempts'] = 0;
                $_SESSION['user_email'] = $email;
                $_SESSION['user_name'] = $userData['name'];
                $_SESSION['user_company'] = $userData['company'];
                $_SESSION['user_is_admin'] = $userData['is_admin'] ?? false;
                // org session fields
                $_SESSION['user_org_id'] = $userData['organization_id'] ?? null;
                $_SESSION['user_org_perm_level'] = $userData['org_permissions']['level'] ?? null;
                $isFirstTime = empty($userData['seen_tutorial']);
                if ($isFirstTime || $fails > 0) {
                    if ($isFirstTime) $userData['seen_tutorial'] = true;
                    atomicWriteJson($userFile, $userData);
                }
                echo json_encode([
                    'success' => true,
                    'first_login' => $isFirstTime,
                    'is_admin' => ($userData['is_admin'] ?? false)
                ]);
            } else {
                setupOtpSession($email, $userData['name'], $userData['company']);
                echo json_encode(['success'=>false, 'require_otp'=>true, 'email'=>$email]);
            }
        } else {
            $fails++;
            $userData['failed_attempts'] = $fails;
            atomicWriteJson($userFile, $userData);
            echo json_encode(['error' => "Invalid credentials. " . (5 - $fails) . " attempts left."]);
        }
        return true;
    }

    if ($action === 'forgot_password') {
        $email = strtolower(trim($_POST['email'] ?? ''));
        $userFile = $userDir . getUserFilename($email);
        if (file_exists($userFile)) {
            $userData = json_decode(file_get_contents($userFile), true);
            if (!is_array($userData)) $userData = [];
            $name = (string)($userData['name'] ?? '');
            $company = (string)($userData['company'] ?? '');
            setupOtpSession($email, $name, $company, true);
        }
        echo json_encode(['success' => true, 'require_otp' => true, 'email' => $email]);
        return true;
    }

    if ($action === 'verify_otp') {
        $code = $_POST['otp'] ?? '';
        if (!isset($_SESSION['otp_pending'])) die(json_encode(['error' => 'Session expired']));
        if (trim($code) == $_SESSION['otp_code']) {
            $email = $_SESSION['otp_email'];
            $userFile = $userDir . getUserFilename($email);
            $isAdminFlag = false;
            if (file_exists($userFile)) {
                $uData = json_decode(file_get_contents($userFile), true);
                if (!is_array($uData)) $uData = [];
                ensureUserId($uData);
                ensureUserCreditsFields($uData);
                ensureUserOrgFields($uData);
                $uData['is_verified'] = true;
                $uData['failed_attempts'] = 0;
                $isAdminFlag = $uData['is_admin'] ?? false;
                atomicWriteJson($userFile, $uData);
            }
            if (!empty($_SESSION['is_password_reset'])) {
                $_SESSION['allow_password_change'] = true;
                echo json_encode(['success' => false, 'require_new_password' => true]);
            } else {
                $_SESSION['user_email'] = $_SESSION['otp_email'];
                $_SESSION['user_name'] = $_SESSION['otp_name'];
                $_SESSION['user_company'] = $_SESSION['otp_company'];
                $_SESSION['user_is_admin'] = $isAdminFlag;
                // org session fields
                $uData = json_decode(file_get_contents($userFile), true);
                if (!is_array($uData)) $uData = [];
                ensureUserOrgFields($uData);
                $_SESSION['user_org_id'] = $uData['organization_id'] ?? null;
                $_SESSION['user_org_perm_level'] = $uData['org_permissions']['level'] ?? null;
                unset($_SESSION['otp_pending'], $_SESSION['otp_code']);
                $isFirstTime = empty($uData['seen_tutorial']);
                if ($isFirstTime) {
                    $uData['seen_tutorial'] = true;
                    atomicWriteJson($userFile, $uData);

                    // Send branded welcome email on first login
                    sendFirstLoginWelcomeEmail($email, $uData['name'] ?? '');
                }
                echo json_encode(['success' => true, 'first_login' => $isFirstTime]);
            }
        } else {
            echo json_encode(['error' => 'Invalid code']);
        }
        return true;
    }

    if ($action === 'set_new_password') {
        if (!isset($_SESSION['allow_password_change'])) die(json_encode(['error' => 'Unauthorized']));
        $newPass = $_POST['new_password'] ?? '';
        if (strlen($newPass) < 6) die(json_encode(['error' => 'Password too short']));
        $email = $_SESSION['otp_email'];
        $userFile = $userDir . getUserFilename($email);
        if (file_exists($userFile)) {
            $uData = json_decode(file_get_contents($userFile), true);
            $uData['password_hash'] = password_hash($newPass, PASSWORD_DEFAULT);
            file_put_contents($userFile, json_encode($uData, JSON_PRETTY_PRINT));
            $_SESSION['user_email'] = $email;
            unset($_SESSION['allow_password_change'], $_SESSION['otp_pending']);
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Error']);
        }
        return true;
    }

    // ------------------------------------------------
    // ---------------- CREDITS ACTIONS -------------
    // ------------------------------------------------
    if ($action === 'get_credits') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        $email = strtolower(trim($_SESSION['user_email']));
        $bal = creditsGetBalanceByEmail($email);
        if (empty($bal['ok'])) die(json_encode(['success'=>false,'error'=>$bal['error'] ?? 'credits_failed']));
        // --- Calculate permissions for frontend ---
        $u = readUserDataByEmail($email);
        $orgId = actorOrgIdByEmail($email);
        
        // If user is in an org, send org-scoped permissions. If not, send global/employee permissions.
        $perms = $orgId ? userEffectiveOrgPerms($u, $orgId) : userEffectiveGlobalPerms($u);
        // Site admin override for client-side ease
        if (isAdmin()) $perms = ['*' => true];
        // -----------------------------------------------
        echo json_encode([
            'success'=>true,
            'credits_balance'=>(int)$bal['balance'],
            'credits_scope'=>(string)($bal['scope'] ?? 'user'),
            'organization_id'=>($_SESSION['user_org_id'] ?? null),
            'account_type'=>(string)($u['account_type'] ?? ''),
            'is_employee'=> false, 
            'stripe_test_mode'=> STRIPE_TEST_MODE,
            'permissions' => $perms
        ]);
        return true;
    }

    // Admin/employee management: set account type
    if ($action === 'set_account_type') {
        $actor = $_SESSION['user_email'] ?? '';
        if (!isAdmin() && !userHasPerm($actor, 'manage_users')) {
            die(json_encode(['success'=>false,'error'=>'Unauthorized']));
        }
        $email = strtolower(trim($_POST['email'] ?? ''));
        $type  = strtolower(trim($_POST['account_type'] ?? ''));
        if (!$email) die(json_encode(['success'=>false,'error'=>'Missing email']));
        if (!in_array($type, ['customer','employee'], true)) die(json_encode(['success'=>false,'error'=>'Invalid account_type']));
        if (!isAdmin() && !actorCanManageTargetUser($actor, $email)) {
            die(json_encode(['success'=>false,'error'=>'Unauthorized']));
        }
        $u = readUserDataByEmail($email);
        if (!$u) die(json_encode(['success'=>false,'error'=>'User not found']));
        $u['account_type'] = $type;
        writeUserDataByEmail($email, $u);
        echo json_encode(['success'=>true]);
        return true;
    }

    // ------------------------------------------------
    // ---------------- ORG USER MANAGEMENT ----------
    // ------------------------------------------------
    // ---------------- ORG USERS: LIST ----------------
    if ($action === 'org_users_list_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_users');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $users = [];
        $includeDeleted = isset($_POST['include_deleted'])
            ? filter_var($_POST['include_deleted'], FILTER_VALIDATE_BOOLEAN)
            : false;
        foreach (scandir($userDir) as $f) {
            if ($f === '.' || $f === '..') continue;
            if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
            $u = json_decode(@file_get_contents($userDir . $f), true);
            if (!is_array($u)) continue;
            ensureUserId($u);
            ensureUserOrgFields($u);
            $uOrg = orgNormalizeId($u['organization_id'] ?? '');
            if ($uOrg !== $orgId) continue;
            // ✅ Hide deleted users by default
            if (!$includeDeleted && !empty($u['deleted'])) continue;
            unset($u['password_hash']);
            $users[] = userPublicView($u);
        }
        usort($users, function($a,$b){
            return strcmp(($a['name'] ?: $a['email']), ($b['name'] ?: $b['email']));
        });
        echo json_encode(['success'=>true,'org_id'=>$orgId,'users'=>$users]);
        return true;
    }

    // ---------------- ORG USERS: ADD (create user) ----------------
    if ($action === 'org_users_add_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_users');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $email = sanitizeEmail($_POST['email'] ?? '');
        $name  = sanitizeName($_POST['name'] ?? '');
        $level = strtolower(trim((string)($_POST['perm_level'] ?? 'viewer')));
        if ($email === '') die(json_encode(['success'=>false,'error'=>'Invalid email']));
        if ($name === '') $name = $email;
        $allowedLevels = array_keys(orgPermissionPresets());
        $allowedLevels[] = 'custom';
        if (!in_array($level, $allowedLevels, true)) $level = 'viewer';
        $userFile = $userDir . getUserFilename($email);
        if (file_exists($userFile)) die(json_encode(['success'=>false,'error'=>'User already exists']));
        $tempPass = bin2hex(random_bytes(12)); // not shown to user; activation flow sets real password
        $userId = genHexId(10);
        $u = [
            'id' => $userId,
            'email' => $email,
            'password_hash' => password_hash($tempPass, PASSWORD_DEFAULT),
            'name' => $name,
            'company' => '',
            'phone' => '',
            'organization_id' => $orgId,
            'org_permissions' => [
                'level' => $level,
                'items' => [],
            ],
            'is_verified' => false,
            'disabled' => false,
            'deleted' => false,
            'failed_attempts' => 0,
            'seen_tutorial' => false,
            'created_at' => date('Y-m-d H:i:s'),
            'projects' => [],
            'team_id' => 'default',
            'role' => 'user',
            'account_type' => 'customer',
            'credits_balance' => 0,
            'credits_ledger' => [],
        ];
        if (!atomicWriteJson($userFile, $u)) die(json_encode(['success'=>false,'error'=>'Write failed']));
        // record membership in org manifest (best effort)
        orgAddUserId($orgId, $userId, $email, $name);
        // ✅ Send welcome email with activation link
        $org = orgRead($orgId);
        $orgName = $org ? (string)($org['name'] ?? '') : '';
        $mail = sendWelcomeActivationEmail($email, $name, $orgName);
        echo json_encode([
            'success'=>true,
            'user'=>userPublicView($u),
            'emailed'=>!empty($mail['ok']),
            'activate_url'=>$mail['activate_url'] ?? (rtrim(($GLOBALS['BASE_URL'] ?? ''), '/') . '/activate.php?email=' . rawurlencode($email)),
        ]);
        return true;
    }

    // ---------------- ORG USERS: UPDATE PERMS ----------------
    if ($action === 'org_users_set_perms_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_user_permissions');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $userId = strtolower(trim((string)($_POST['user_id'] ?? '')));
        if ($userId === '') die(json_encode(['success'=>false,'error'=>'Missing user_id']));
        $level = strtolower(trim((string)($_POST['perm_level'] ?? 'viewer')));
        $itemsJson = (string)($_POST['perm_items_json'] ?? '{}');
        $items = json_decode($itemsJson, true);
        if (!is_array($items)) $items = [];
        $allowedLevels = array_keys(orgPermissionPresets());
        $allowedLevels[] = 'custom';
        if (!in_array($level, $allowedLevels, true)) $level = 'viewer';
        $uf = userFindFileById($userId);
        if (!$uf) die(json_encode(['success'=>false,'error'=>'User not found']));
        $u = json_decode(@file_get_contents($uf), true);
        if (!is_array($u)) die(json_encode(['success'=>false,'error'=>'Bad user json']));
        ensureUserOrgFields($u);
        $uOrg = orgNormalizeId($u['organization_id'] ?? '');
        if ($uOrg !== $orgId) die(json_encode(['success'=>false,'error'=>'Wrong org']));
        if (!isset($u['org_permissions_by_org']) || !is_array($u['org_permissions_by_org'])) $u['org_permissions_by_org'] = [];
        $u['org_permissions_by_org'][$orgId] = [
            'org_id' => $orgId,
            'level'  => $level,
            'items'  => $items,
        ];
        // keep mirrors aligned for UI
        $u['org_permissions'] = ['level'=>$level,'items'=>$items];
        $u['org_permission_level'] = $level;
        $u['org_permission_items'] = $items;
        if (!atomicWriteJson($uf, $u)) die(json_encode(['success'=>false,'error'=>'Write failed']));
        echo json_encode(['success'=>true,'user'=>userPublicView($u)]);
        return true;
    }

    // ---------------- ORG USERS: SUSPEND / UNSUSPEND ----------------
    if ($action === 'org_users_set_disabled_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_users');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $userId = strtolower(trim((string)($_POST['user_id'] ?? '')));
        $disabled = isset($_POST['disabled']) ? filter_var($_POST['disabled'], FILTER_VALIDATE_BOOLEAN) : true;
        if ($userId === '') die(json_encode(['success'=>false,'error'=>'Missing user_id']));
        $uf = userFindFileById($userId);
        if (!$uf) die(json_encode(['success'=>false,'error'=>'User not found']));
        $u = json_decode(@file_get_contents($uf), true);
        if (!is_array($u)) die(json_encode(['success'=>false,'error'=>'Bad user json']));
        ensureUserOrgFields($u);
        $uOrg = orgNormalizeId($u['organization_id'] ?? '');
        if ($uOrg !== $orgId) die(json_encode(['success'=>false,'error'=>'Wrong org']));
        // prevent self-lockout footgun: do not allow disabling yourself
        $me = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if ($me !== '' && strtolower(trim((string)($u['email'] ?? ''))) === $me && $disabled) {
            die(json_encode(['success'=>false,'error'=>'Cannot suspend your own account']));
        }
        $u['disabled'] = $disabled ? true : false;
        if (!atomicWriteJson($uf, $u)) die(json_encode(['success'=>false,'error'=>'Write failed']));
        echo json_encode(['success'=>true,'user'=>userPublicView($u)]);
        return true;
    }

    // ---------------- ORG USERS: DELETE (soft delete) ----------------
    if ($action === 'org_users_delete_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_users');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $userId = strtolower(trim((string)($_POST['user_id'] ?? '')));
        if ($userId === '') die(json_encode(['success'=>false,'error'=>'Missing user_id']));
        $uf = userFindFileById($userId);
        if (!$uf) die(json_encode(['success'=>false,'error'=>'User not found']));
        $u = json_decode(@file_get_contents($uf), true);
        if (!is_array($u)) die(json_encode(['success'=>false,'error'=>'Bad user json']));
        ensureUserOrgFields($u);
        $uOrg = orgNormalizeId($u['organization_id'] ?? '');
        if ($uOrg !== $orgId) die(json_encode(['success'=>false,'error'=>'Wrong org']));
        // prevent deleting yourself
        $me = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if ($me !== '' && strtolower(trim((string)($u['email'] ?? ''))) === $me) {
            die(json_encode(['success'=>false,'error'=>'Cannot delete your own account']));
        }
        // Soft delete: disable + mark deleted; keep file for audit
        $u['disabled'] = true;
        $u['deleted'] = true;
        $u['deleted_at'] = date('Y-m-d H:i:s');
        $u['deleted_by'] = $me ?: null;
        if (!atomicWriteJson($uf, $u)) die(json_encode(['success'=>false,'error'=>'Write failed']));
        echo json_encode(['success'=>true]);
        return true;
    }

    // ------------------------------------------------
    // ---------- QUEUE MODE ACTIONS -----------------
    // ------------------------------------------------
    if ($action === 'get_user_queue_mode') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        $email = strtolower(trim((string)$_SESSION['user_email']));
        $u = readUserDataByEmail($email);
        if (!$u) die(json_encode(['success'=>false,'error'=>'User not found']));
        $mode = strtolower(trim((string)($u['queue_mode'] ?? 'disabled')));
        $validModes = ['disabled', 'wait_for_feedback', 'hot_swap'];
        if (!in_array($mode, $validModes, true)) $mode = 'disabled';
        $labels = [
            'disabled'          => 'Hot Swapping Disabled',
            'wait_for_feedback' => 'Wait for Feedback',
            'hot_swap'          => 'Hot Swapping Enabled',
        ];
        // For wait_for_feedback, check whether user is currently blocked
        $blocked       = false;
        $blockedReason = null;
        $pendingProjects = [];
        if ($mode === 'wait_for_feedback') {
            foreach (scandir($baseDir) as $folder) {
                if ($folder === '.' || $folder === '..') continue;
                $mp = $baseDir . $folder . '/manifest.json';
                if (!file_exists($mp)) continue;
                $m = json_decode(@file_get_contents($mp), true);
                if (!is_array($m)) continue;
                $assigned = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
                if ($assigned !== $email) continue;
                $status = $m['status'] ?? '';
                if (in_array($status, ['awaiting_review', 'correction_needed'], true)) {
                    $blocked = true;
                    $blockedReason = 'You have projects pending QA review. Complete those before pulling new work.';
                    $pendingProjects[] = [
                        'folder'  => $folder,
                        'address' => $m['address'] ?? '',
                        'status'  => $status,
                    ];
                }
            }
        }
        echo json_encode([
            'success'          => true,
            'queue_mode'       => $mode,
            'queue_mode_label' => $labels[$mode] ?? $mode,
            'blocked'          => $blocked,
            'blocked_reason'   => $blockedReason,
            'pending_projects' => $pendingProjects,
        ]);
        return true;
    }

    if ($action === 'set_user_queue_mode') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        
        $actorEmail = strtolower(trim((string)$_SESSION['user_email']));
        $targetEmail = strtolower(trim((string)($_POST['email'] ?? $_POST['user_email'] ?? '')));
        $newMode = strtolower(trim((string)($_POST['queue_mode'] ?? '')));
        
        // If no target specified, default to self
        if ($targetEmail === '') {
            $targetEmail = $actorEmail;
        }
        
        // Validate mode
        $validModes = ['disabled', 'wait_for_feedback', 'hot_swap'];
        if (!in_array($newMode, $validModes, true)) {
            die(json_encode(['success'=>false, 'error'=>'Invalid queue_mode. Must be: disabled, wait_for_feedback, or hot_swap']));
        }
        
        // Authorization: user can set their own, or admin/queue admin can set for others
        $isSelf = ($targetEmail === $actorEmail);
        $canSetOthers = isAdmin() || isQueueAdminUser();
        
        if (!$isSelf && !$canSetOthers) {
            die(json_encode(['success'=>false, 'error'=>'Unauthorized. You can only change your own queue mode.']));
        }
        
        // Load target user
        $userFile = $userDir . getUserFilename($targetEmail);
        if (!file_exists($userFile)) {
            die(json_encode(['success'=>false, 'error'=>'User not found']));
        }
        
        $u = json_decode(@file_get_contents($userFile), true);
        if (!is_array($u)) $u = [];
        
        // Update queue_mode
        $oldMode = strtolower(trim((string)($u['queue_mode'] ?? 'disabled')));
        $u['queue_mode'] = $newMode;
        $u['queue_mode_updated_at'] = date('Y-m-d H:i:s');
        $u['queue_mode_updated_by'] = $actorEmail;
        
        if (!atomicWriteJson($userFile, $u)) {
            die(json_encode(['success'=>false, 'error'=>'Failed to save user data']));
        }
        
        $labels = [
            'disabled'          => 'Hot Swapping Disabled',
            'wait_for_feedback' => 'Wait for Feedback',
            'hot_swap'          => 'Hot Swapping Enabled',
        ];
        
        echo json_encode([
            'success'          => true,
            'email'            => $targetEmail,
            'queue_mode'       => $newMode,
            'queue_mode_label' => $labels[$newMode] ?? $newMode,
            'previous_mode'    => $oldMode,
            'updated_by'       => $actorEmail,
        ]);
        return true;
    }

    if ($action === 'queue_live_trained_users') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        if (!isQueueAdminUser() && !isAdmin()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));
        $out = [];
        foreach (scandir($userDir) as $f) {
            if ($f === '.' || $f === '..') continue;
            if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
            $u = json_decode(@file_get_contents($userDir . $f), true);
            if (!is_array($u)) continue;
            // "live" heuristic:
            // - verified (if present)
            // - not disabled (if you ever add it)
            // - training_complete must be true
            // - must be employee (customers don't do training)
            $training = !empty($u['training_complete']);
            if (!$training) continue;
            if (array_key_exists('disabled', $u) && !empty($u['disabled'])) continue;
            if (array_key_exists('is_verified', $u) && empty($u['is_verified'])) continue;
            // Skip customers - only employees do training
            $acctType = strtolower(trim((string)($u['account_type'] ?? '')));
            if ($acctType === 'customer') continue;
            $email = strtolower(trim((string)($u['email'] ?? '')));
            if ($email === '') continue;
            $out[] = [
                'id'    => (string)($u['id'] ?? ''),
                'email' => $email,
                'name'  => (string)($u['name'] ?? ''),
                'team_id' => (string)($u['team_id'] ?? 'default'),
                'account_type' => (string)($u['account_type'] ?? ''),
            ];
        }
        usort($out, function($a,$b){
            return strcmp(($a['name'] ?: $a['email']), ($b['name'] ?: $b['email']));
        });
        echo json_encode(['success'=>true, 'users'=>$out]);
        return true;
    }

    // ------------------------------------------------
    // ------------- CUSTOMER MANAGEMENT -------------
    // ------------------------------------------------
    // Fetch all users with order counts (admin only)
    if ($action === 'fetch_all_users_with_orders') {
        $actor = $_SESSION['user_email'] ?? '';
        if (!isAdmin() && !userHasPerm($actor, 'manage_users')) {
            die(json_encode(['error' => 'Unauthorized']));
        }
        $users = [];
        $actorOrg = isAdmin() ? null : actorOrgIdByEmail($actor);
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $u = json_decode(file_get_contents($userDir . $f), true);
                if (!is_array($u)) continue;
                ensureUserId($u);
                ensureUserCreditsFields($u);
                ensureUserOrgFields($u);
                if (!isAdmin()) {
                    $uOrg = orgNormalizeId($u['organization_id'] ?? '');
                    if (!$actorOrg || $uOrg !== $actorOrg) continue;
                }
                unset($u['password_hash']);
                $users[] = $u;
            }
        }
        echo json_encode(['success' => true, 'users' => $users]);
        return true;
    }

    // Fetch projects for a specific user (admin only)
    if ($action === 'fetch_user_projects') {
        if (!isAdmin() && !userHasPerm($_SESSION['user_email'] ?? '', 'manage_users')) {
            die(json_encode(['error' => 'Unauthorized']));
        }
        
        $targetEmail = strtolower(trim($_POST['email'] ?? ''));
        if (!$targetEmail) die(json_encode(['error' => 'Missing email']));
        
        $projects = [];
        
        // Scan all projects and filter by owner
        foreach (scandir($baseDir) as $folder) {
            if ($folder === '.' || $folder === '..') continue;
            $mp = $baseDir . $folder . '/manifest.json';
            if (!file_exists($mp)) continue;
            
            $m = json_decode(file_get_contents($mp), true);
            if (!is_array($m)) continue;
            
            // Check if this project belongs to the target user
            $ownerEmail = strtolower(trim((string)($m['owner_email'] ?? '')));
            $issuerEmail = strtolower(trim((string)($m['issuer']['email'] ?? '')));
            
            if ($ownerEmail === $targetEmail || $issuerEmail === $targetEmail) {
                $projects[] = [
                    'id' => $folder,
                    'address' => $m['address'] ?? '',
                    'status' => $m['status'] ?? 'queued',
                    'created_at' => $m['created_at'] ?? '',
                    'completed_at' => $m['completed_at'] ?? null,
                    'owner_email' => $m['owner_email'] ?? '',
                    'issuer' => $m['issuer'] ?? [],
                    'resident' => $m['resident'] ?? []
                ];
            }
        }
        
        // Sort by created date descending
        usort($projects, function($a, $b) {
            return strtotime($b['created_at'] ?? '1970-01-01') - strtotime($a['created_at'] ?? '1970-01-01');
        });
        
        echo json_encode(['success' => true, 'projects' => $projects]);
        return true;
    }

    // Admin issue credit to a customer
    if ($action === 'admin_issue_credit') {
        $actor = $_SESSION['user_email'] ?? '';
        if (!isAdmin() && !userHasPerm($actor, 'manage_users')) {
            die(json_encode(['error' => 'Unauthorized']));
        }
        $targetEmail = strtolower(trim($_POST['email'] ?? ''));
        $amount = (int)($_POST['amount'] ?? 0);
        $reason = trim($_POST['reason'] ?? 'admin_manual_credit');
        if (!$targetEmail) die(json_encode(['error' => 'Missing email']));
        if ($amount <= 0) die(json_encode(['error' => 'Amount must be positive']));
        if (!isAdmin() && !actorCanManageTargetUser($actor, $targetEmail)) {
            die(json_encode(['error' => 'Unauthorized']));
        }
        $u = readUserDataByEmail($targetEmail);
        if (!$u) die(json_encode(['error' => 'User not found']));
        $acctType = strtolower(trim((string)($u['account_type'] ?? '')));
        if ($acctType !== 'customer') die(json_encode(['error' => 'Can only issue credits to customer accounts']));
        $add = creditsAddByEmail($targetEmail, $amount, $reason, [
            'issued_by' => $actor ?: 'system',
            'target_email' => $targetEmail,
        ]);
        if (empty($add['ok'])) die(json_encode(['error' => 'Failed to apply credits', 'details'=>$add]));
        echo json_encode([
            'success' => true,
            'credits_scope' => $add['scope'] ?? 'user',
            'organization_id' => $add['org_id'] ?? null,
            'new_balance' => (int)($add['new_balance'] ?? 0),
            'amount_added' => $amount
        ]);
        return true;
    }

    // Try shift actions before giving up
    if (handleShiftActions($action)) return true;

    // Action not handled by this file
    return false;
}

// ------------------------------------------------
// ---------- SHIFT ACTION HANDLERS ---------------
// ------------------------------------------------

function handleShiftActions($action) {
    global $userDir;
    
    // ---- GET MY RAW SCHEDULE (for earnings plugin) ----
    if ($action === 'shift_get_my_schedule') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $email = strtolower(trim((string)$_SESSION['user_email']));
        $sched = shiftGetUserSchedule($email);
        echo json_encode([
            'success'  => true,
            'schedule' => $sched,
        ]);
        return true;
    }

    // ---- GET SCHEDULES ----
    if ($action === 'shift_get_schedules') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $viewLevel = shiftViewLevel($actor);
        if ($viewLevel === 'none') {
            die(json_encode(['success' => false, 'error' => 'No permission to view schedules']));
        }

        $weekOf = trim((string)($_POST['week_of'] ?? ''));
        if (!$weekOf) $weekOf = date('Y-m-d', strtotime('monday this week'));

        $teamFilter = trim((string)($_POST['team'] ?? 'all'));

        $result = [];

        if (!is_dir($userDir)) {
            echo json_encode(['success' => true, 'schedules' => [], 'week_of' => $weekOf]);
            return true;
        }

        foreach (scandir($userDir) as $f) {
            if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
            $u = json_decode(@file_get_contents($userDir . $f), true);
            if (!is_array($u)) continue;

            $acct = strtolower(trim((string)($u['account_type'] ?? '')));
            if ($acct === 'customer') continue;

            $email = strtolower(trim((string)($u['email'] ?? '')));
            if ($email === '') continue;

            if (!empty($u['disabled']) || !empty($u['deleted'])) continue;

            // Only show users who have completed training (queue-eligible)
            if (empty($u['training_complete'])) continue;

            $uTeam = (string)($u['team_id'] ?? 'default');
            if ($teamFilter !== 'all' && $uTeam !== $teamFilter) continue;

            if (!shiftCanView($actor, $email)) continue;

            ensureUserShiftFields($u);
            $sched = $u['shift_schedule'];

            // Resolve the week inline
            $weekResolved = [];
            $mondayTs = strtotime($weekOf);
            for ($d = 0; $d < 7; $d++) {
                $dateStr = date('Y-m-d', $mondayTs + ($d * 86400));
                $dayName = strtolower(date('l', $mondayTs + ($d * 86400)));
                $overrides = $sched['overrides'] ?? [];
                $isOverride = (is_array($overrides) && array_key_exists($dateStr, $overrides));
                $blocks = shiftResolveBlocksInline($sched, $dateStr, $dayName);

                $weekResolved[$dayName] = [
                    'date'       => $dateStr,
                    'blocks'     => $blocks,
                    'is_override'=> $isOverride,
                ];
            }

            // Check if user has any blocks this week
            $hasBlocks = false;
            foreach ($weekResolved as $dayInfo) {
                if (!empty($dayInfo['blocks'])) { $hasBlocks = true; break; }
            }

            $result[] = [
                'email'     => $email,
                'name'      => (string)($u['name'] ?? $email),
                'team_id'   => $uTeam,
                'role'      => (string)($u['role'] ?? 'user'),
                'recurring' => $sched['recurring'] ?? [],
                'overrides' => $sched['overrides'] ?? [],
                'week'      => $weekResolved,
                'has_blocks' => $hasBlocks,
            ];
        }

        usort($result, function($a, $b) {
            $rolePriority = ['admin' => 0, 'lead' => 1, 'user' => 2];
            $ra = $rolePriority[$a['role'] ?? 'user'] ?? 2;
            $rb = $rolePriority[$b['role'] ?? 'user'] ?? 2;
            if ($ra !== $rb) return $ra - $rb;
            return strcmp($a['name'], $b['name']);
        });

        echo json_encode([
            'success'    => true,
            'schedules'  => $result,
            'week_of'    => $weekOf,
            'view_level' => $viewLevel,
            'edit_level' => shiftEditLevel($actor),
        ]);
        return true;
    }

    // ---- SAVE SCHEDULE (full recurring + overrides) ----
    if ($action === 'shift_save_schedule') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $targetEmail = strtolower(trim((string)($_POST['target_email'] ?? '')));
        if ($targetEmail === '') {
            die(json_encode(['success' => false, 'error' => 'Missing target_email']));
        }
        if (!shiftCanEdit($actor, $targetEmail)) {
            die(json_encode(['success' => false, 'error' => 'No permission to edit this schedule']));
        }

        $recurring = json_decode($_POST['recurring'] ?? '{}', true);
        $overrides = json_decode($_POST['overrides'] ?? '{}', true);
        if (!is_array($recurring)) $recurring = [];
        if (!is_array($overrides)) $overrides = [];

        global $SHIFT_DAYS;
        $cleanRecurring = [];
        foreach ($SHIFT_DAYS as $day) {
            $dayBlocks = $recurring[$day] ?? [];
            if (!is_array($dayBlocks)) continue;
            $valid = [];
            foreach ($dayBlocks as $b) {
                $v = shiftValidateBlock($b);
                if ($v) $valid[] = $v;
            }
            if (!empty($valid)) $cleanRecurring[$day] = $valid;
        }

        $cleanOverrides = [];
        foreach ($overrides as $dateStr => $blocks) {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateStr)) continue;
            if (!is_array($blocks)) { $cleanOverrides[$dateStr] = []; continue; }
            $valid = [];
            foreach ($blocks as $b) {
                $v = shiftValidateBlock($b);
                if ($v) $valid[] = $v;
            }
            $cleanOverrides[$dateStr] = $valid;
        }

        $scheduleData = [
            'recurring'  => $cleanRecurring,
            'overrides'  => $cleanOverrides,
            'updated_at' => date('c'),
            'updated_by' => $actor,
        ];

        $ok = shiftSetUserSchedule($targetEmail, $scheduleData);
        echo json_encode(['success' => !!$ok, 'target_email' => $targetEmail]);
        return true;
    }

    // ---- SAVE SINGLE DAY OVERRIDE ----
    if ($action === 'shift_save_day_override') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $targetEmail = strtolower(trim((string)($_POST['target_email'] ?? '')));
        $dateStr = trim((string)($_POST['date'] ?? ''));
        $blocks = json_decode($_POST['blocks'] ?? '[]', true);

        if ($targetEmail === '') die(json_encode(['success' => false, 'error' => 'Missing target_email']));
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateStr)) die(json_encode(['success' => false, 'error' => 'Invalid date']));
        if (!shiftCanEdit($actor, $targetEmail)) die(json_encode(['success' => false, 'error' => 'No permission']));

        $validBlocks = [];
        if (is_array($blocks)) {
            foreach ($blocks as $b) {
                $v = shiftValidateBlock($b);
                if ($v) $validBlocks[] = $v;
            }
        }

        $u = readUserDataByEmail($targetEmail);
        if (!$u) die(json_encode(['success' => false, 'error' => 'User not found']));
        ensureUserShiftFields($u);
        $u['shift_schedule']['overrides'][$dateStr] = $validBlocks;
        $u['shift_schedule']['updated_at'] = date('c');
        $u['shift_schedule']['updated_by'] = $actor;
        writeUserDataByEmail($targetEmail, $u);

        echo json_encode(['success' => true]);
        return true;
    }

    // ---- REMOVE DAY OVERRIDE (revert to recurring) ----
    if ($action === 'shift_remove_day_override') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $targetEmail = strtolower(trim((string)($_POST['target_email'] ?? '')));
        $dateStr = trim((string)($_POST['date'] ?? ''));

        if (!shiftCanEdit($actor, $targetEmail)) die(json_encode(['success' => false, 'error' => 'No permission']));
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateStr)) die(json_encode(['success' => false, 'error' => 'Invalid date']));

        $u = readUserDataByEmail($targetEmail);
        if (!$u) die(json_encode(['success' => false, 'error' => 'User not found']));
        ensureUserShiftFields($u);
        if (isset($u['shift_schedule']['overrides'][$dateStr])) {
            unset($u['shift_schedule']['overrides'][$dateStr]);
            writeUserDataByEmail($targetEmail, $u);
        }

        echo json_encode(['success' => true]);
        return true;
    }

    // ---- CURRENT SHIFT STATUS ----
    if ($action === 'shift_current_status') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $viewLevel = shiftViewLevel($actor);
        if ($viewLevel === 'none') die(json_encode(['success' => false, 'error' => 'No permission']));

        $teamFilter = trim((string)($_POST['team'] ?? 'all'));
        $onShift = shiftGetCurrentOnShift($teamFilter);

        $filtered = [];
        foreach ($onShift as $person) {
            if (shiftCanView($actor, $person['email'])) {
                $filtered[] = $person;
            }
        }

        $byRole = ['manager' => [], 'qa' => [], 'technician' => [], 'lead' => [], 'other' => []];
        foreach ($filtered as $p) {
            $shiftRole = 'technician';
            foreach ($p['shift_blocks'] as $b) {
                $shiftRole = $b['role'] ?? 'technician';
                break;
            }
            if (!isset($byRole[$shiftRole])) $byRole[$shiftRole] = [];
            $p['shift_role'] = $shiftRole;
            $byRole[$shiftRole][] = $p;
        }

        echo json_encode([
            'success'  => true,
            'on_shift' => $filtered,
            'by_role'  => $byRole,
            'now'      => date('c'),
            'today'    => date('Y-m-d'),
        ]);
        return true;
    }

    // ---- SESSION STATS ----
    if ($action === 'shift_session_stats') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $viewLevel = shiftViewLevel($actor);
        if ($viewLevel === 'none') die(json_encode(['success' => false, 'error' => 'No permission']));

        $teamFilter = trim((string)($_POST['team'] ?? 'all'));
        $onShift = shiftGetCurrentOnShift($teamFilter);

        $results = [];
        foreach ($onShift as $person) {
            if (!shiftCanView($actor, $person['email'])) continue;

            $earliest = '23:59';
            foreach ($person['all_blocks'] as $b) {
                if ($b['start'] < $earliest) $earliest = $b['start'];
            }
            $today = date('Y-m-d');
            $shiftStartTs = strtotime($today . ' ' . $earliest);
            if (!$shiftStartTs) $shiftStartTs = strtotime($today . ' 00:00');

            $stats = shiftSessionStats($person['email'], $shiftStartTs);

            $stats['name']       = $person['name'];
            $stats['team_id']    = $person['team_id'];
            $stats['on_break']   = $person['on_break'];
            $stats['break_started_at'] = $person['break_started_at'];
            $stats['last_activity_at'] = $person['last_activity_at'];

            $shiftRole = 'technician';
            foreach ($person['shift_blocks'] as $b) {
                $shiftRole = $b['role'] ?? 'technician';
                break;
            }
            $stats['shift_role'] = $shiftRole;
            $stats['shift_blocks'] = $person['shift_blocks'];
            $stats['all_blocks'] = $person['all_blocks'];

            $totalProjects = array_sum($stats['categories'] ?: [0]);
            $elapsedHours = (time() - $shiftStartTs) / 3600;
            $stats['total_done'] = $totalProjects;
            $stats['elapsed_hours'] = round($elapsedHours, 2);
            $stats['rate_per_hour'] = ($elapsedHours > 0.1) ? round($totalProjects / $elapsedHours, 2) : 0;

            $results[] = $stats;
        }

        echo json_encode([
            'success' => true,
            'stats'   => $results,
            'now'     => date('c'),
        ]);
        return true;
    }

    // ---- GET MY PERMISSIONS ----
    if ($action === 'shift_my_permissions') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        echo json_encode([
            'success'    => true,
            'view_level' => shiftViewLevel($actor),
            'edit_level' => shiftEditLevel($actor),
        ]);
        return true;
    }
    
    // ---- SET PER-USER SHIFT RATE ----
    if ($action === 'shift_set_rate') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $targetEmail = strtolower(trim((string)($_POST['target_email'] ?? '')));
        $newRate = (int)($_POST['shift_rate'] ?? 0);

        if ($targetEmail === '') die(json_encode(['success' => false, 'error' => 'Missing target_email']));
        if ($newRate < 0 || $newRate > 100000) die(json_encode(['success' => false, 'error' => 'Invalid shift_rate']));

        // Only admins / queue admins can change shift rates
        if (!isAdmin() && !isQueueAdminUser()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $u = readUserDataByEmail($targetEmail);
        if (!$u) die(json_encode(['success' => false, 'error' => 'User not found']));

        $oldRate = (int)($u['shift_rate'] ?? 940);
        $u['shift_rate'] = $newRate;
        writeUserDataByEmail($targetEmail, $u);

        echo json_encode([
            'success'      => true,
            'target_email' => $targetEmail,
            'shift_rate'   => $newRate,
            'previous_rate'=> $oldRate,
        ]);
        return true;
    }
    
    // ------------------------------------------------
    // -------- ADMIN IMPERSONATION (LOGIN-AS) --------
    // ------------------------------------------------

    if ($action === 'admin_impersonate_user') {
        // Only site admins can impersonate
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }

        // Check admin status from the REAL session (not impersonated)
        $realAdmin = $_SESSION['impersonating_from_email'] ?? $_SESSION['user_email'];
        $realAdminData = readUserDataByEmail($realAdmin);
        if (!$realAdminData || empty($realAdminData['is_admin'])) {
            die(json_encode(['success' => false, 'error' => 'Only site admins can impersonate users']));
        }

        $targetEmail = strtolower(trim((string)($_POST['email'] ?? '')));
        if ($targetEmail === '') {
            die(json_encode(['success' => false, 'error' => 'Missing target email']));
        }

        // Can't impersonate yourself
        if ($targetEmail === $realAdmin) {
            die(json_encode(['success' => false, 'error' => 'Cannot impersonate yourself']));
        }

        $targetUser = readUserDataByEmail($targetEmail);
        if (!$targetUser) {
            die(json_encode(['success' => false, 'error' => 'User not found']));
        }

        // Store the real admin identity (only if not already impersonating)
        if (!isset($_SESSION['impersonating_from_email'])) {
            $_SESSION['impersonating_from_email'] = $_SESSION['user_email'];
            $_SESSION['impersonating_from_name']  = $_SESSION['user_name'] ?? '';
            $_SESSION['impersonating_from_admin'] = true;
        }

        // Swap session to target user
        $_SESSION['user_email']   = $targetEmail;
        $_SESSION['user_name']    = (string)($targetUser['name'] ?? '');
        $_SESSION['user_company'] = (string)($targetUser['company'] ?? '');
        $_SESSION['user_is_admin'] = false; // run as customer perms
        $_SESSION['user_org_id']  = $targetUser['organization_id'] ?? null;
        $_SESSION['user_org_perm_level'] = $targetUser['org_permissions']['level'] ?? null;

        // Flag that we're impersonating
        $_SESSION['is_impersonating'] = true;

        // Log the impersonation event
        $logEntry = [
            'event'        => 'admin_impersonate',
            'admin_email'  => $realAdmin,
            'target_email' => $targetEmail,
            'timestamp'    => date('c'),
            'ip'           => $_SERVER['REMOTE_ADDR'] ?? 'unknown',
        ];
        @file_put_contents(
            ($GLOBALS['userDir'] ?? storageDir('users')) . '../logs/impersonation.log',
            json_encode($logEntry) . "\n",
            FILE_APPEND | LOCK_EX
        );

        echo json_encode([
            'success'      => true,
            'impersonating' => $targetEmail,
            'target_name'  => (string)($targetUser['name'] ?? $targetEmail),
            'admin_email'  => $realAdmin,
        ]);
        return true;
    }

    if ($action === 'admin_stop_impersonation') {
        if (empty($_SESSION['is_impersonating']) || empty($_SESSION['impersonating_from_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not currently impersonating']));
        }

        $adminEmail = $_SESSION['impersonating_from_email'];
        $adminData  = readUserDataByEmail($adminEmail);
        if (!$adminData) {
            // Shouldn't happen, but safe fallback
            session_destroy();
            die(json_encode(['success' => false, 'error' => 'Admin account not found. Session ended.']));
        }

        // Restore admin session
        $_SESSION['user_email']   = $adminEmail;
        $_SESSION['user_name']    = (string)($adminData['name'] ?? '');
        $_SESSION['user_company'] = (string)($adminData['company'] ?? '');
        $_SESSION['user_is_admin'] = !empty($adminData['is_admin']);
        $_SESSION['user_org_id']  = $adminData['organization_id'] ?? null;
        $_SESSION['user_org_perm_level'] = $adminData['org_permissions']['level'] ?? null;

        // Clear impersonation flags
        unset(
            $_SESSION['is_impersonating'],
            $_SESSION['impersonating_from_email'],
            $_SESSION['impersonating_from_name'],
            $_SESSION['impersonating_from_admin']
        );

        echo json_encode([
            'success'  => true,
            'restored' => $adminEmail,
        ]);
        return true;
    }

    if ($action === 'admin_impersonation_status') {
        echo json_encode([
            'success'         => true,
            'is_impersonating' => !empty($_SESSION['is_impersonating']),
            'acting_as'       => $_SESSION['user_email'] ?? null,
            'real_admin'      => $_SESSION['impersonating_from_email'] ?? null,
        ]);
        return true;
    }

    return false;
}