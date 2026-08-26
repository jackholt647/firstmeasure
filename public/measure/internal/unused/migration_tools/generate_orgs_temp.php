<?php
require_once __DIR__ . '/_storage.php';
/**
 * migrate_legacy_orgs.php
 *
 * Drop this file next to server.php and run it from CLI:
 *   php migrate_legacy_orgs.php
 *
 * What it does:
 * - Scans /users/*.json
 * - For any NON-employee user missing organization_id:
 *     - Finds/creates an org by company name (name-based grouping)
 *     - Adds user to that org
 *     - Sets user org_permissions.level = super_admin
 *     - Adds the user's current credits_balance onto the org (without removing from user)
 * - Idempotent: won't re-add credits for a user already migrated into that org.
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

$userDir = storageDir('users');
$orgDir  = storageDir('organizations');

if (!is_dir($userDir)) die("Missing users/ directory: $userDir\n");
if (!is_dir($orgDir)) @mkdir($orgDir, 0777, true);

function atomicWriteJson($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
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

function orgNormalizeId($id) {
    $id = strtolower(trim((string)$id));
    $id = preg_replace('/[^a-f0-9]/', '', $id);
    return $id;
}

function normalizeCompanyKey($name) {
    $name = strtolower(trim((string)$name));
    $name = preg_replace('/\s+/', ' ', $name);
    $name = preg_replace('/[^a-z0-9 \.\-&]/', '', $name);
    $name = trim($name);
    return $name;
}

function readJsonFile($path) {
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
}

function ensureOrgDefaults(&$o, $orgId) {
    if (!is_array($o)) $o = [];
    $o['id'] = $orgId;

    if (!isset($o['name'])) $o['name'] = '';
    if (!isset($o['created_at'])) $o['created_at'] = gmdate('c');
    if (!isset($o['created_by_user_id'])) $o['created_by_user_id'] = null;
    if (!isset($o['created_by_email'])) $o['created_by_email'] = null;
    if (!isset($o['created_by_name'])) $o['created_by_name'] = null;

    if (!isset($o['users']) || !is_array($o['users'])) $o['users'] = [];
    if (!isset($o['users_meta']) || !is_array($o['users_meta'])) $o['users_meta'] = [];

    if (!isset($o['credits_balance'])) $o['credits_balance'] = 0;
    if (!is_int($o['credits_balance'])) $o['credits_balance'] = (int)$o['credits_balance'];
    if (!isset($o['credits_ledger']) || !is_array($o['credits_ledger'])) $o['credits_ledger'] = [];

    if (!isset($o['branding']) || !is_array($o['branding'])) $o['branding'] = [];
    if (!array_key_exists('logo', $o['branding'])) $o['branding']['logo'] = null;
    if (!isset($o['branding']['colors']) || !is_array($o['branding']['colors'])) $o['branding']['colors'] = [];
    $o['branding']['colors']['primary']   = $o['branding']['colors']['primary']   ?? '#DB0000';
    $o['branding']['colors']['secondary'] = $o['branding']['colors']['secondary'] ?? '#111111';
    $o['branding']['colors']['accent']    = $o['branding']['colors']['accent']    ?? '#1A73E8';
}

function orgManifestPath($orgDir, $orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    return rtrim($orgDir, '/\\') . '/' . $orgId . '/manifest.json';
}

function scanExistingOrgsByName($orgDir) {
    $map = []; // companyKey => orgId
    if (!is_dir($orgDir)) return $map;

    foreach (scandir($orgDir) as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $orgId = orgNormalizeId($entry);
        if ($orgId === '') continue;

        $mp = orgManifestPath($orgDir, $orgId);
        if (!$mp || !file_exists($mp)) continue;

        $o = readJsonFile($mp);
        if (!$o) continue;

        $name = (string)($o['name'] ?? '');
        $key = normalizeCompanyKey($name);
        if ($key !== '' && empty($map[$key])) {
            $map[$key] = $orgId;
        }
    }
    return $map;
}

function createOrgForCompany($orgDir, $companyName, $creatorEmail = null, $creatorName = null, $creatorUserId = null) {
    $base = rtrim($orgDir, '/\\') . '/';

    $orgId = '';
    for ($i=0; $i<50; $i++) {
        $candidate = genHexId(12);
        if (!file_exists($base . $candidate . '/manifest.json')) { $orgId = $candidate; break; }
    }
    if ($orgId === '') return null;

    $o = [
        'id' => $orgId,
        'name' => (string)$companyName,
        'created_at' => gmdate('c'),
        'created_by_user_id' => $creatorUserId ?: null,
        'created_by_email' => $creatorEmail ?: null,
        'created_by_name' => $creatorName ?: null,
        'users' => [],
        'users_meta' => [],
        'credits_balance' => 0,
        'credits_ledger' => [],
        'branding' => [
            'logo' => null,
            'colors' => [
                'primary' => '#DB0000',
                'secondary' => '#111111',
                'accent' => '#1A73E8',
            ]
        ],
    ];
    ensureOrgDefaults($o, $orgId);

    $dir = $base . $orgId . '/';
    if (!is_dir($dir)) @mkdir($dir, 0777, true);

    $mp = $dir . 'manifest.json';
    if (!atomicWriteJson($mp, $o)) return null;

    return $orgId;
}

function userIsEmployee($u) {
    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'employee') return true;
    return false;
}

function userOrgId($u) {
    $orgId = trim((string)($u['organization_id'] ?? ''));
    $orgId = orgNormalizeId($orgId);
    return $orgId !== '' ? $orgId : null;
}

function ensureUserOrgFields(&$u) {
    if (!is_array($u)) $u = [];
    if (!array_key_exists('organization_id', $u)) $u['organization_id'] = null;

    if (!isset($u['org_permissions']) || !is_array($u['org_permissions'])) {
        $u['org_permissions'] = ['level'=>null,'items'=>[]];
    } else {
        if (!array_key_exists('level', $u['org_permissions'])) $u['org_permissions']['level'] = null;
        if (!array_key_exists('items', $u['org_permissions'])) $u['org_permissions']['items'] = [];
        if (!is_array($u['org_permissions']['items'])) $u['org_permissions']['items'] = [];
    }
}

function companyNameFromUser($u) {
    $company = trim((string)($u['company'] ?? ''));
    if ($company !== '') return $company;

    $name = trim((string)($u['name'] ?? ''));
    if ($name !== '') return $name . ' Company';

    $email = trim((string)($u['email'] ?? ''));
    if ($email !== '') return $email . ' Company';

    return 'My Company';
}

function stableUserIdForOrg($u) {
    $id = strtolower(trim((string)($u['id'] ?? '')));
    if ($id !== '') return $id;

    $email = strtolower(trim((string)($u['email'] ?? '')));
    if ($email !== '') return 'legacy_' . substr(md5($email), 0, 24);

    return 'legacy_' . genHexId(10);
}

function orgLoad($orgDir, $orgId) {
    $mp = orgManifestPath($orgDir, $orgId);
    if (!$mp || !file_exists($mp)) return [null, null];
    $o = readJsonFile($mp);
    if (!$o) $o = [];
    ensureOrgDefaults($o, $orgId);
    return [$o, $mp];
}

function orgHasMigratedUserCredit($o, $userEmail) {
    $userEmail = strtolower(trim((string)$userEmail));
    if ($userEmail === '') return false;

    $ledger = $o['credits_ledger'] ?? [];
    if (!is_array($ledger)) return false;

    foreach ($ledger as $row) {
        if (!is_array($row)) continue;
        if (($row['reason'] ?? '') !== 'legacy_migration') continue;
        $meta = $row['meta'] ?? null;
        if (!is_array($meta)) continue;
        $mEmail = strtolower(trim((string)($meta['migrated_from_user_email'] ?? '')));
        if ($mEmail !== '' && $mEmail === $userEmail) return true;
    }
    return false;
}

function orgAddUserAndMaybeCredits($orgDir, $orgId, $userId, $email, $name, $userCreditsBalance) {
    [$o, $mp] = orgLoad($orgDir, $orgId);
    if (!$o || !$mp) return [false, "org_load_failed"];

    // add membership
    if (!in_array($userId, $o['users'], true)) $o['users'][] = $userId;
    $o['users'] = array_values(array_unique($o['users']));

    $o['users_meta'][$userId] = array_merge(
        (is_array($o['users_meta'][$userId] ?? null) ? $o['users_meta'][$userId] : []),
        [
            'id' => $userId,
            'email' => $email ?: null,
            'name' => $name ?: null,
            'added_at' => ($o['users_meta'][$userId]['added_at'] ?? gmdate('c')),
        ]
    );

    // add credits (idempotent per user)
    $emailLc = strtolower(trim((string)$email));
    $credits = (int)$userCreditsBalance;
    if ($credits > 0 && !orgHasMigratedUserCredit($o, $emailLc)) {
        $o['credits_balance'] = (int)$o['credits_balance'] + $credits;
        $o['credits_ledger'][] = [
            'ts' => date('c'),
            'delta' => $credits,
            'reason' => 'legacy_migration',
            'by_email' => null,
            'applied_for_user_email' => $emailLc ?: null,
            'meta' => [
                'migrated_from_user_email' => $emailLc ?: null,
                'migrated_user_id' => $userId,
            ],
            'unit' => 'usd_dollars',
        ];
    }

    if (!atomicWriteJson($mp, $o)) return [false, "org_write_failed"];
    return [true, null];
}

// ---------------------------
// RUN
// ---------------------------

$orgNameToId = scanExistingOrgsByName($orgDir);

$stats = [
    'users_scanned' => 0,
    'users_skipped_employee' => 0,
    'users_already_had_org' => 0,
    'users_migrated' => 0,
    'orgs_created' => 0,
    'credits_migrated_total' => 0,
];

foreach (scandir($userDir) as $f) {
    if ($f === '.' || $f === '..') continue;
    if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;

    $path = $userDir . $f;
    $u = readJsonFile($path);
    if (!$u) continue;

    $stats['users_scanned']++;

    // skip employees
    if (userIsEmployee($u)) {
        $stats['users_skipped_employee']++;
        continue;
    }

    // already has org
    if (userOrgId($u)) {
        $stats['users_already_had_org']++;
        continue;
    }

    // determine org by company name
    $company = companyNameFromUser($u);
    $companyKey = normalizeCompanyKey($company);
    if ($companyKey === '') $companyKey = 'my company';

    $email = strtolower(trim((string)($u['email'] ?? '')));
    $name  = (string)($u['name'] ?? '');

    $orgId = $orgNameToId[$companyKey] ?? null;

    if (!$orgId) {
        $orgId = createOrgForCompany(
            $orgDir,
            $company,
            $email ?: null,
            $name ?: null,
            ($u['id'] ?? null)
        );
        if (!$orgId) {
            echo "FAILED: could not create org for company={$company}\n";
            continue;
        }
        $orgNameToId[$companyKey] = $orgId;
        $stats['orgs_created']++;
    }

    $userId = stableUserIdForOrg($u);
    $userCredits = (int)($u['credits_balance'] ?? 0);

    // add user + credits to org (credits are idempotent per user)
    [$ok, $err] = orgAddUserAndMaybeCredits($orgDir, $orgId, $userId, $email, $name, $userCredits);
    if (!$ok) {
        echo "FAILED: org update org_id={$orgId} email={$email} err={$err}\n";
        continue;
    }

    // update user: ONLY org fields + super admin (as requested)
    ensureUserOrgFields($u);
    $u['organization_id'] = $orgId;
    $u['org_permissions']['level'] = 'super_admin';
    $u['org_permissions']['items'] = [];

    if (!atomicWriteJson($path, $u)) {
        echo "FAILED: user write email={$email} file={$f}\n";
        continue;
    }

    $stats['users_migrated']++;
    // note: we count "migrated credits total" based on userCredits, even though idempotency may skip if rerun
    if ($userCredits > 0) $stats['credits_migrated_total'] += $userCredits;

    echo "OK: {$email} -> org {$orgId} ({$company}) +{$userCredits}\n";
}

echo "\nDONE\n";
echo "users_scanned={$stats['users_scanned']}\n";
echo "users_skipped_employee={$stats['users_skipped_employee']}\n";
echo "users_already_had_org={$stats['users_already_had_org']}\n";
echo "users_migrated={$stats['users_migrated']}\n";
echo "orgs_created={$stats['orgs_created']}\n";
echo "credits_migrated_total={$stats['credits_migrated_total']}\n";
