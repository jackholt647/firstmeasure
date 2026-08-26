<?php
require_once __DIR__ . '/_storage.php';
require_once dirname(__DIR__, 2) . '/includes/provider_keys.php';
/**
 * index.php - Portal (modular shell + plugin system)
 *
 * Built-ins:
 * - projects.js (projects + queue admin + apple key + next-in-queue)
 * - tutorials.js (tutorials + student progress + curriculum editor)
 * - users.js (user management)
 *
 * Plugins:
 * - discount_codes.js (registers itself; injects nav + view + modal)
 *
 * IMPORTANT:
 * - This file still hosts the portal-only POST endpoints (apple key, user admin, student progress),
 *   exactly like your prior portal.php did.
 * - Node /v1 APIs host core app APIs (projects list, queue, tutorials, coupons, etc).
 */

session_start();
require_once __DIR__ . '/firstmeasure_node.php';
require_once __DIR__ . '/_permission_options.php';
require_once __DIR__ . '/_tutorials.php';

$GOOGLE_BROWSER_API_KEY = fm_google_provider_key('browser_internal');

// --- CONFIGURATION ---
$tutorialDir = storageDir('tutorials');

// Apple key store
$APPLE_KEY_PATH = storagePath('config/apple_key.json', true);
$APPLE_MAPS_DEFAULT_TILE_VERSION = 10401;

// --- PERMISSION DEFINITIONS ---
function getPermissionPresets($role) {
    return permissionOptionsPresetPermissions($role);
}

function isEmployeeUserData($u) {
    if (!is_array($u)) return false;

    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'employee') return true;
    if ($acct === 'customer') return false;

    // Back-compat inference (older files without account_type)
    $role = strtolower(trim((string)($u['role'] ?? '')));
    if ($role === 'admin') return true;

    if (!empty($u['is_admin'])) return true;

    $perms = permissionOptionsNormalizePermissions($u['permissions'] ?? [], $role);
    return permissionOptionsHasGrantedPermission($perms);
}

function portalTutorialCourseOptions() {
    return [
        'default' => [
            'id' => 'default',
            'label' => 'New Hire Training',
            'description' => 'Base onboarding curriculum for new hires.',
        ],
        'software-update-refresh' => [
            'id' => 'software-update-refresh',
            'label' => 'Software Update Refresh',
            'description' => 'Retraining curriculum for team members active before May 1, 2026.',
        ],
    ];
}

function portalNormalizeTutorialCourseId($courseId) {
    $raw = strtolower(trim((string)$courseId));
    if ($raw === '' || $raw === 'default') return 'default';
    $slug = preg_replace('/[^a-z0-9_\-]/', '', str_replace(' ', '-', $raw));
    $options = portalTutorialCourseOptions();
    return isset($options[$slug]) ? $slug : 'default';
}

function portalDefaultTutorialCourseForUser($userData) {
    if (is_array($userData) && !empty($userData['assigned_tutorial_course_id'])) {
        return portalNormalizeTutorialCourseId($userData['assigned_tutorial_course_id']);
    }

    $createdAt = is_array($userData) ? trim((string)($userData['created_at'] ?? '')) : '';
    $createdTs = $createdAt !== '' ? strtotime($createdAt) : false;
    $refreshCutoffTs = strtotime('2026-05-01 00:00:00');

    if ($createdTs !== false && $createdTs < $refreshCutoffTs) {
        return 'software-update-refresh';
    }

    return 'default';
}

// --- AUTH CHECK ---
if (!isset($_SESSION['user_email'])) {
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = $_SESSION['user_email'];
$currentUserName  = $_SESSION['user_name'];
if (in_array(strtolower(trim((string)$currentUserEmail)), ['', 'unknown@example.com', 'unknown@unknown.local'], true)) {
    $_SESSION = [];
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_destroy();
    }
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}
if (session_status() === PHP_SESSION_ACTIVE && function_exists('session_write_close')) {
    session_write_close();
}

function portalNormalizeOrganizationId($id) {
    if (function_exists('orgNormalizeId')) return orgNormalizeId($id);
    $id = strtolower(trim((string)$id));
    return preg_replace('/[^a-f0-9]/', '', $id);
}

function portalEnsureUserCreditsFields(&$user) {
    if (!is_array($user)) $user = [];
    if (!isset($user['credits_balance'])) $user['credits_balance'] = 0;
    if (!is_numeric($user['credits_balance'])) $user['credits_balance'] = 0;
    $user['credits_balance'] = portalCreditAmount($user['credits_balance']);
    if (!isset($user['credits_ledger']) || !is_array($user['credits_ledger'])) $user['credits_ledger'] = [];
}

function portalCreditAmount($value) {
    if (function_exists('portalMoneyAmount')) return portalMoneyAmount($value);
    if (!is_numeric((string)$value)) return 0.0;
    return round((float)$value, 2);
}

function portalReadUserDataByEmail($email) {
    return portalReadNodeInternalUserByEmail($email);
}

function portalInternalApiBaseUrl() {
    $base = rtrim((string)fm_api_base_url(), '/');
    $internal = preg_replace('#/firstmeasure/?$#', '/internal', $base);
    if (is_string($internal) && $internal !== '' && $internal !== $base) return $internal;
    return rtrim($base, '/') . '/../internal';
}

function portalNodeInternalRequest($method, $path, $body = null, $query = []) {
    $method = strtoupper(trim((string)$method));
    $url = rtrim(portalInternalApiBaseUrl(), '/') . '/' . ltrim((string)$path, '/');
    if (is_array($query) && $query) {
        $qs = http_build_query($query);
        if ($qs !== '') $url .= (strpos($url, '?') === false ? '?' : '&') . $qs;
    }

    $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $headers = ['Accept: application/json'];
    if ($actorEmail !== '') $headers[] = 'X-Internal-User-Email: ' . $actorEmail;
    if (!empty($_SESSION['user_name'])) $headers[] = 'X-Internal-User-Name: ' . (string)$_SESSION['user_name'];

    $payload = null;
    if ($body !== null) {
        $payload = json_encode($body);
        $headers[] = 'Content-Type: application/json';
    }

    if (!function_exists('curl_init')) {
        return ['ok' => false, 'status' => 500, 'json' => null, 'body' => '', 'error' => 'curl_missing'];
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
    ]);
    if ($payload !== null && $method !== 'GET') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    }
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    $json = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    return [
        'ok' => ($error === '' && $status >= 200 && $status < 300 && is_array($json)),
        'status' => $status ?: 500,
        'json' => is_array($json) ? $json : null,
        'body' => is_string($raw) ? $raw : '',
        'error' => $error,
    ];
}

function portalReadNodeInternalUserByEmail($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return null;
    $res = portalNodeInternalRequest('GET', 'users/' . rawurlencode($email));
    if (!$res['ok']) return null;
    $data = $res['json'];
    if (!is_array($data)) return null;
    $user = is_array($data['user'] ?? null) ? $data['user'] : null;
    if (!is_array($user)) return null;
    $user['email'] = strtolower(trim((string)($user['email'] ?? $email)));
    if ($user['email'] === '') return null;
    portalEnsureUserCreditsFields($user);
    if (!array_key_exists('organization_id', $user)) $user['organization_id'] = null;
    return $user;
}

function portalWriteUserDataByEmail($email, $data) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    if (!is_array($data)) $data = [];
    $data['email'] = strtolower(trim((string)($data['email'] ?? $email)));
    portalEnsureUserCreditsFields($data);
    if (!array_key_exists('organization_id', $data)) $data['organization_id'] = null;
    $targetId = trim((string)($data['id'] ?? '')) !== '' ? (string)$data['id'] : $email;
    $res = portalNodeInternalRequest('PUT', 'users/' . rawurlencode($targetId), $data);
    return !empty($res['ok']);
}

function portalDeleteNodeInternalUser($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    $res = portalNodeInternalRequest('DELETE', 'users/' . rawurlencode($email));
    return !empty($res['ok']);
}

function portalListNodeInternalUsers($visibleTeam = false, $query = []) {
    $path = $visibleTeam ? 'users/team' : 'users';
    $res = portalNodeInternalRequest('GET', $path, null, is_array($query) ? $query : []);
    if (!$res['ok'] || !is_array($res['json'])) return [];
    return array_values(array_filter((array)($res['json']['users'] ?? []), 'is_array'));
}

function portalCanManageFeatureRollouts($userData, $perms) {
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    return $role === 'admin'
        || !empty($userData['is_admin'])
        || !empty($perms['manage_users'])
        || !empty($perms['manage_sales_users']);
}

function portalPlatformStorageRoot() {
    $candidates = [
        realpath(__DIR__ . '/../../v1/storage/platform'),
        realpath(__DIR__ . '/../../portal/../v1/storage/platform'),
        realpath(storagePath('platform')),
    ];
    foreach ($candidates as $path) {
        if (is_string($path) && $path !== '' && is_dir($path)) return rtrim($path, '/\\');
    }
    return rtrim(__DIR__ . '/../../v1/storage/platform', '/\\');
}

function portalFeatureFlagRegistry() {
    return [
        'platform.lead_import' => [
            'group' => 'platform',
            'flag' => 'lead_import',
            'label' => 'Lead Import',
            'description' => 'Enables lead intake settings and lead import surfaces.',
            'default' => false,
            'requires' => [],
        ],
        'platform.website_embed_import' => [
            'group' => 'platform',
            'flag' => 'website_embed_import',
            'label' => 'Website Forms',
            'description' => 'Enables the Forms settings tab and website lead intake APIs.',
            'default' => false,
            'requires' => ['platform.lead_import'],
        ],
        'platform.scheduling' => [
            'group' => 'platform',
            'flag' => 'scheduling',
            'label' => 'Scheduling',
            'description' => 'Enables the Scheduling tab, scheduling settings, and appointment-slot features.',
            'default' => false,
            'requires' => [],
        ],
        'platform.project_photos' => [
            'group' => 'platform',
            'flag' => 'project_photos',
            'label' => 'Project Photos',
            'description' => 'Enables project photo galleries and uploads in New Project and project viewer workflows.',
            'default' => false,
            'requires' => [],
        ],
        'platform.photos_feed' => [
            'group' => 'platform',
            'flag' => 'photos_feed',
            'label' => 'Photo Feed',
            'description' => 'Enables the organization-wide photo feed, photo comments, and photo markup review workflows.',
            'default' => false,
            'requires' => ['platform.project_photos'],
        ],
        'platform.proposals' => [
            'group' => 'platform',
            'flag' => 'proposals',
            'label' => 'Proposals',
            'description' => 'Enables proposal creation, proposal tabs, and proposal editing workflows.',
            'default' => false,
            'requires' => [],
        ],
        'platform.top_bar' => [
            'group' => 'platform',
            'flag' => 'top_bar',
            'label' => 'Platform Top Bar',
            'description' => 'Enables the global search box and notifications bell in the platform header.',
            'default' => false,
            'requires' => [],
        ],
        'platform.configuration' => [
            'group' => 'platform',
            'flag' => 'configuration',
            'label' => 'Configuration',
            'description' => 'Shows the Configuration settings tab.',
            'default' => false,
            'requires' => [],
        ],
        'platform.pricebook' => [
            'group' => 'platform',
            'flag' => 'pricebook',
            'label' => 'Pricebook',
            'description' => 'Shows the Pricebook settings tab and editor.',
            'default' => false,
            'requires' => [],
        ],
        'platform.user_modals' => [
            'group' => 'platform',
            'flag' => 'user_modals',
            'label' => 'User Modals',
            'description' => 'Enables clickable user profile modals with uploaded-photo views.',
            'default' => false,
            'requires' => [],
        ],
        'platform.user_activity' => [
            'group' => 'platform',
            'flag' => 'user_activity',
            'label' => 'User Activity',
            'description' => 'Shows activity streams in user profile modals.',
            'default' => false,
            'requires' => ['platform.user_modals'],
        ],
        'platform.storage_limits' => [
            'group' => 'platform',
            'flag' => 'storage_limits',
            'label' => 'Storage Limits',
            'description' => 'Shows storage usage and enforces media upload limits.',
            'default' => false,
            'requires' => [],
        ],
        'platform.customer_portal' => [
            'group' => 'platform',
            'flag' => 'customer_portal',
            'label' => 'Customer Portal',
            'description' => 'Enables secure per-project customer portal links and portal sharing controls.',
            'default' => false,
            'requires' => [],
        ],
        'platform.customer_portal_media' => [
            'group' => 'platform',
            'flag' => 'customer_portal_media',
            'label' => 'Customer Portal Media',
            'description' => 'Allows project photos and videos to be shared with customer portal visitors.',
            'default' => false,
            'requires' => ['platform.customer_portal', 'platform.project_photos'],
        ],
        'platform.purchasable_storage' => [
            'group' => 'platform',
            'flag' => 'purchasable_storage',
            'label' => 'Purchasable Storage',
            'description' => 'Shows storage checkout entry points.',
            'default' => false,
            'requires' => ['platform.storage_limits'],
        ],
        'email.inbound_lead_import' => [
            'group' => 'email',
            'flag' => 'inbound_lead_import',
            'label' => 'Email Inbox Leads',
            'description' => 'Enables inbound email lead capture.',
            'default' => false,
            'requires' => ['platform.lead_import'],
        ],
        'canvassing.app' => [
            'group' => 'canvassing',
            'flag' => 'app',
            'label' => 'Canvassing',
            'description' => 'Enables canvassing settings, canvassing APIs, and the Canvassing tab.',
            'default' => false,
            'requires' => [],
        ],
        'lead_forms.contact_form' => [
            'group' => 'lead_forms',
            'flag' => 'contact_form',
            'label' => 'Contact Form',
            'description' => 'Enables basic website contact forms.',
            'default' => false,
            'requires' => ['platform.website_embed_import'],
        ],
        'lead_forms.appointment_form' => [
            'group' => 'lead_forms',
            'flag' => 'appointment_form',
            'label' => 'Appointment Form',
            'description' => 'Enables website appointment forms that depend on scheduling.',
            'default' => false,
            'requires' => ['platform.website_embed_import', 'platform.scheduling'],
        ],
        'lead_forms.instant_estimate' => [
            'group' => 'lead_forms',
            'flag' => 'instant_estimate',
            'label' => 'Instant Estimate',
            'description' => 'Enables website instant estimate forms.',
            'default' => false,
            'requires' => ['platform.website_embed_import'],
        ],
        'firstmeasure.bonus_upfront_match' => [
            'group' => 'firstmeasure',
            'flag' => 'bonus_upfront_match',
            'label' => 'Bonus Upfront Match',
            'description' => 'Enables the upfront credit match offer.',
            'default' => false,
            'requires' => [],
        ],
        'firstmeasure.gutter_reports' => [
            'group' => 'firstmeasure',
            'flag' => 'gutter_reports',
        'label' => 'Gutter Reports',
        'description' => 'Enables roof and gutter measurement report options.',
        'default' => true,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.weather_reports' => [
            'group' => 'firstmeasure',
            'flag' => 'weather_reports',
            'label' => 'Historical Weather Reports',
            'description' => 'Enables historical severe-weather report ordering and project report tabs.',
            'default' => false,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.measurement_report_summary' => [
            'group' => 'firstmeasure',
            'flag' => 'measurement_report_summary',
        'label' => 'Measurement Report Summary',
        'description' => 'Enables the gated roof report summary sub-tab in project reports.',
        'default' => true,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.report_orders' => [
            'group' => 'firstmeasure',
            'flag' => 'report_orders',
            'label' => 'Report Orders',
            'description' => 'Enables ordering FirstMeasure roof measurement reports.',
            'default' => true,
            'requires' => [],
        ],
        'firstmeasure.report_expedite_options' => [
            'group' => 'firstmeasure',
            'flag' => 'report_expedite_options',
        'label' => 'Report Expedite Options',
        'description' => 'Enables customer-facing turnaround choices for report orders.',
        'default' => true,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.report_cancellations' => [
            'group' => 'firstmeasure',
            'flag' => 'report_cancellations',
            'label' => 'Report Cancellations',
            'description' => 'Enables customer cancellation of report orders during the grace period.',
            'default' => true,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.report_followup' => [
            'group' => 'firstmeasure',
            'flag' => 'report_followup',
            'label' => 'Report Follow-up',
            'description' => 'Enables customer issue reports, correction requests, additional structure requests, and the Changes Pending tab.',
            'default' => false,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.instant_reports' => [
            'group' => 'firstmeasure',
            'flag' => 'instant_reports',
            'label' => 'Instant Reports',
            'description' => 'Enables FirstMeasure instant report options.',
            'default' => false,
            'requires' => ['firstmeasure.report_orders'],
        ],
        'firstmeasure.referral_program_banner' => [
            'group' => 'firstmeasure',
            'flag' => 'referral_program_banner',
            'label' => 'Referral Program Banner',
            'description' => 'Enables the customer referral banner.',
            'default' => false,
            'requires' => [],
        ],
    ];
}

function portalFeatureFlagDefaults() {
    $defaults = [];
    foreach (portalFeatureFlagRegistry() as $definition) {
        $group = $definition['group'];
        if (!isset($defaults[$group])) $defaults[$group] = [];
        $defaults[$group][$definition['flag']] = !empty($definition['default']);
    }
    return $defaults;
}

function portalFeatureFlagDefaultConfigPath() {
    return portalPlatformStorageRoot() . '/config/app_flag_defaults.json';
}

function portalFeatureFlagReadDefaultRecord() {
    $path = portalFeatureFlagDefaultConfigPath();
    $stored = is_file($path) ? portalFeatureFlagReadJson($path) : [];
    $data = is_array($stored['data'] ?? null) ? $stored['data'] : [];
    $flags = portalFeatureFlagNormalizeFlags($data['app_flags'] ?? $stored['app_flags'] ?? []);
    return [
        'id' => 'app_flag_defaults',
        'flags' => $flags,
        'saved' => is_file($path),
        'updated_at' => trim((string)($stored['updated_at'] ?? '')),
        'updated_by' => trim((string)($stored['updated_by'] ?? '')),
    ];
}

function portalFeatureFlagSaveDefaultRecord($flags, $actorEmail = '') {
    $record = [
        'schema_version' => 1,
        'id' => 'app_flag_defaults',
        'data' => [
            'app_flags' => portalFeatureFlagNormalizeFlags($flags),
        ],
        'updated_at' => gmdate('c'),
        'updated_by' => $actorEmail,
    ];
    $apiResult = portalFeatureFlagSaveDefaultRecordViaInternalApi($flags);
    if (!empty($apiResult['success'])) return true;
    return portalFeatureFlagWriteJson(portalFeatureFlagDefaultConfigPath(), $record);
}

function portalFeatureFlagSaveDefaultRecordDetailed($flags, $actorEmail = '') {
    $record = [
        'schema_version' => 1,
        'id' => 'app_flag_defaults',
        'data' => [
            'app_flags' => portalFeatureFlagNormalizeFlags($flags),
        ],
        'updated_at' => gmdate('c'),
        'updated_by' => $actorEmail,
    ];
    $apiResult = portalFeatureFlagSaveDefaultRecordViaInternalApi($flags);
    if (!empty($apiResult['success'])) return $apiResult;
    $fileResult = portalFeatureFlagWriteJsonDetailed(portalFeatureFlagDefaultConfigPath(), $record);
    if (!empty($fileResult['success'])) return $fileResult;
    return [
        'success' => false,
        'error' => ($apiResult['error'] ?? 'Internal API write failed') . '; direct file write: ' . ($fileResult['error'] ?? 'write failed'),
    ];
}

function portalFeatureFlagSaveDefaultRecordViaInternalApi($flags) {
    if (!function_exists('portalNodeInternalRequest')) {
        return ['success' => false, 'error' => 'Internal API client unavailable'];
    }
    $body = [
        'app_flags' => portalFeatureFlagNormalizeFlags($flags),
    ];
    $last = null;
    for ($attempt = 1; $attempt <= 4; $attempt++) {
        $res = portalNodeInternalRequest('PUT', 'admin/app-flag-defaults', $body);
        if (!empty($res['ok'])) return ['success' => true, 'source' => 'internal_api', 'attempts' => $attempt];
        $last = $res;
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        $message = (string)($json['message'] ?? $json['error'] ?? ($res['error'] ?? '') ?: ($res['body'] ?? '') ?: 'Internal API write failed');
        $status = (int)($res['status'] ?? 0);
        $retryableAdminMismatch = $status === 403 && (
            stripos($message, 'Only internal admins can manage app feature flags') !== false
            || stripos($message, 'admin_required') !== false
        );
        if (!$retryableAdminMismatch && !in_array($status, [0, 429, 500, 502, 503, 504], true)) break;
        if ($attempt < 4) usleep(120000 * $attempt);
    }
    $res = is_array($last) ? $last : [];
    $json = is_array($res['json'] ?? null) ? $res['json'] : [];
    $message = (string)($json['message'] ?? $json['error'] ?? ($res['error'] ?? '') ?: ($res['body'] ?? '') ?: 'Internal API write failed');
    return [
        'success' => false,
        'error' => 'Internal API: ' . trim(substr($message, 0, 240)),
        'status' => (int)($res['status'] ?? 0),
    ];
}

function portalFeatureVariantRegistry() {
    return [
        'firstmeasure.referral_offer' => [
            [
                'family' => 'firstmeasure.referral_offer',
                'key' => 'gift_card_50',
                'label' => '$50 Gift Card',
                'description' => 'Referrer receives a $50 gift card for each qualified signup.',
                'requires' => ['firstmeasure.referral_program_banner'],
            ],
            [
                'family' => 'firstmeasure.referral_offer',
                'key' => 'credits_50',
                'label' => '$50 Free Credits',
                'description' => 'Referrer receives $50 in FirstMate credits for each qualified signup.',
                'requires' => ['firstmeasure.referral_program_banner'],
            ],
        ],
    ];
}

function portalFeatureFlagDefinitions() {
    $out = [];
    foreach (portalFeatureFlagRegistry() as $key => $definition) {
        $definition['key'] = $key;
        $out[] = $definition;
    }
    return $out;
}

function portalFeatureVariantDefinitions() {
    $out = [];
    foreach (portalFeatureVariantRegistry() as $variants) {
        foreach ($variants as $variant) $out[] = $variant;
    }
    return $out;
}

function portalFeatureFlagNormalizeKey($key) {
    $key = strtolower(trim((string)$key));
    return isset(portalFeatureFlagRegistry()[$key]) ? $key : '';
}

function portalFeatureVariantNormalizeFamily($family) {
    $family = strtolower(trim((string)$family));
    return isset(portalFeatureVariantRegistry()[$family]) ? $family : '';
}

function portalFeatureVariantNormalizeKey($family, $key) {
    $family = portalFeatureVariantNormalizeFamily($family);
    $key = strtolower(trim((string)$key));
    if ($family === '' || $key === '') return '';
    foreach (portalFeatureVariantRegistry()[$family] as $variant) {
        if (($variant['key'] ?? '') === $key) return $key;
    }
    return '';
}

function portalFeatureFlagOrgRoot() {
    return portalPlatformStorageRoot() . '/organizations';
}

function portalFeatureFlagReadJson($path) {
    if (!is_file($path)) return [];
    $data = json_decode((string)@file_get_contents($path), true);
    return is_array($data) ? $data : [];
}

function portalFeatureFlagWriteJson($path, $data) {
    $result = portalFeatureFlagWriteJsonDetailed($path, $data);
    return !empty($result['success']);
}

function portalFeatureFlagWriteJsonDetailed($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        return ['success' => false, 'error' => 'Could not create directory'];
    }
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (!is_string($json)) {
        return ['success' => false, 'error' => 'Could not encode JSON'];
    }
    if (function_exists('error_clear_last')) error_clear_last();
    $written = @file_put_contents($path, $json, LOCK_EX);
    if ($written === false) {
        $last = function_exists('error_get_last') ? error_get_last() : null;
        $message = is_array($last) && !empty($last['message']) ? (string)$last['message'] : 'Could not write JSON file';
        return ['success' => false, 'error' => $message];
    }
    return ['success' => true, 'bytes' => $written];
}

function portalFeatureFlagOrgPaths($orgId) {
    $safe = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$orgId);
    if ($safe === '') return null;
    $root = portalFeatureFlagOrgRoot() . '/' . $safe;
    return [
        'id' => $safe,
        'root' => $root,
        'manifest' => $root . '/manifest.json',
        'global' => $root . '/global.json',
    ];
}

function portalFeatureFlagReadOrgRecord($orgId) {
    $paths = portalFeatureFlagOrgPaths($orgId);
    if (!$paths || !is_file($paths['manifest'])) return null;
    $manifest = portalFeatureFlagReadJson($paths['manifest']);
    if (!is_array($manifest)) $manifest = [];
    $global = portalFeatureFlagReadJson($paths['global']);
    if (!is_array($global)) $global = [];
    $data = is_array($global['data'] ?? null) ? $global['data'] : [];
    $contact = is_array($manifest['contact'] ?? null) ? $manifest['contact'] : [];
    $name = trim((string)($manifest['name'] ?? $manifest['company_name'] ?? $manifest['organization_name'] ?? $contact['company'] ?? ''));
    if ($name === '') $name = $paths['id'];
    return [
        'id' => $paths['id'],
        'name' => $name,
        'email' => strtolower(trim((string)($contact['email'] ?? $manifest['email'] ?? $manifest['created_by_email'] ?? ''))),
        'phone' => trim((string)($contact['phone'] ?? $manifest['phone'] ?? '')),
        'status' => strtolower(trim((string)($manifest['status'] ?? $data['status'] ?? 'active'))),
        'created_at' => trim((string)($manifest['created_at'] ?? $global['created_at'] ?? '')),
        'updated_at' => trim((string)($global['updated_at'] ?? $manifest['updated_at'] ?? '')),
        'manifest' => $manifest,
        'global' => $global,
        'flags' => portalFeatureFlagNormalizeFlags($data['app_flags'] ?? $data['feature_flags'] ?? []),
        'variants' => portalFeatureVariantNormalizeValues($data['app_variants'] ?? $data['feature_variants'] ?? []),
    ];
}

function portalFeatureFlagNormalizeFlags($input) {
    $input = is_array($input) ? $input : [];
    $defaults = portalFeatureFlagDefaults();
    $normalized = [];
    foreach ($defaults as $group => $flags) {
        $normalized[$group] = [];
        $groupInput = is_array($input[$group] ?? null) ? $input[$group] : [];
        foreach ($flags as $flag => $default) {
            $normalized[$group][$flag] = array_key_exists($flag, $groupInput) ? ($groupInput[$flag] !== false) : $default;
        }
    }
    return $normalized;
}

function portalFeatureVariantNormalizeValues($input) {
    $input = is_array($input) ? $input : [];
    $normalized = [];
    foreach (array_keys(portalFeatureVariantRegistry()) as $family) {
        $key = portalFeatureVariantNormalizeKey($family, $input[$family] ?? '');
        $normalized[$family] = $key !== '' ? $key : null;
    }
    return $normalized;
}

function portalFeatureFlagResolveOne($key, $raw, &$resolved, &$reasons, $stack = []) {
    if (array_key_exists($key, $resolved)) return $resolved[$key];
    $registry = portalFeatureFlagRegistry();
    if (empty($registry[$key])) {
        $resolved[$key] = false;
        $reasons[$key] = 'unknown_flag';
        return false;
    }
    $definition = $registry[$key];
    $enabled = (($raw[$definition['group']][$definition['flag']] ?? false) !== false);
    if (!$enabled) {
        $resolved[$key] = false;
        $reasons[$key] = 'flag_disabled';
        return false;
    }
    if (in_array($key, $stack, true)) {
        $resolved[$key] = false;
        $reasons[$key] = 'dependency_cycle';
        return false;
    }
    foreach ((array)$definition['requires'] as $requirement) {
        if (!portalFeatureFlagResolveOne($requirement, $raw, $resolved, $reasons, array_merge($stack, [$key]))) {
            $resolved[$key] = false;
            $reasons[$key] = 'requires ' . $requirement;
            return false;
        }
    }
    $resolved[$key] = true;
    $reasons[$key] = null;
    return true;
}

function portalFeatureFlagResolve($raw) {
    $resolvedByKey = [];
    $reasons = [];
    foreach (array_keys(portalFeatureFlagRegistry()) as $key) {
        portalFeatureFlagResolveOne($key, $raw, $resolvedByKey, $reasons);
    }
    return ['resolved_by_key' => $resolvedByKey, 'disabled_reasons' => $reasons];
}

function portalFeatureVariantResolve($rawVariants, $resolvedFlagsByKey) {
    $resolved = [];
    $reasons = [];
    foreach (portalFeatureVariantRegistry() as $family => $variants) {
        $key = portalFeatureVariantNormalizeKey($family, $rawVariants[$family] ?? '');
        $selected = null;
        foreach ($variants as $variant) {
            if (($variant['key'] ?? '') === $key) {
                $selected = $variant;
                break;
            }
        }
        if (!$selected) {
            $resolved[$family] = null;
            $reasons[$family] = $key !== '' ? 'unknown_variant' : 'no_variant';
            continue;
        }
        $missing = '';
        foreach ((array)($selected['requires'] ?? []) as $requirement) {
            if (empty($resolvedFlagsByKey[$requirement])) {
                $missing = $requirement;
                break;
            }
        }
        if ($missing !== '') {
            $resolved[$family] = null;
            $reasons[$family] = 'requires ' . $missing;
            continue;
        }
        $resolved[$family] = $key;
        $reasons[$family] = null;
    }
    return ['resolved' => $resolved, 'disabled_reasons' => $reasons];
}

function portalFeatureFlagOrgSummary($org) {
    $resolved = portalFeatureFlagResolve($org['flags']);
    $variants = portalFeatureVariantResolve($org['variants'], $resolved['resolved_by_key']);
    $enabled = [];
    foreach ($resolved['resolved_by_key'] as $key => $value) {
        if ($value !== false) $enabled[] = $key;
    }
    return [
        'id' => $org['id'],
        'name' => $org['name'],
        'email' => $org['email'],
        'phone' => $org['phone'],
        'status' => $org['status'],
        'created_at' => $org['created_at'],
        'updated_at' => $org['updated_at'],
        'enabled_count' => count($enabled),
        'enabled_flags' => $enabled,
        'raw' => $org['flags'],
        'raw_variants' => $org['variants'],
        'effective_by_key' => $resolved['resolved_by_key'],
        'effective_variants' => $variants['resolved'],
        'disabled_reasons' => $resolved['disabled_reasons'],
        'variant_disabled_reasons' => $variants['disabled_reasons'],
    ];
}

function portalFeatureFlagAllOrgIds() {
    $root = portalFeatureFlagOrgRoot();
    if (!is_dir($root)) return [];
    $ids = [];
    foreach (scandir($root) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $manifest = $root . '/' . $entry . '/manifest.json';
        if (is_dir($root . '/' . $entry) && is_file($manifest)) $ids[] = $entry;
    }
    natcasesort($ids);
    return array_values($ids);
}

function portalFeatureFlagOrgMatches($org, $query, $status = '', $flagKey = '', $flagState = '', $variantFamily = '', $variantState = '') {
    $status = strtolower(trim((string)$status));
    if ($status !== '' && $status !== 'all' && strtolower((string)$org['status']) !== $status) return false;
    $flagKey = portalFeatureFlagNormalizeKey($flagKey);
    $flagState = strtolower(trim((string)$flagState));
    if ($flagKey !== '' && in_array($flagState, ['on', 'off'], true)) {
        $resolved = portalFeatureFlagResolve($org['flags']);
        $isOn = !empty($resolved['resolved_by_key'][$flagKey]);
        if ($flagState === 'on' && !$isOn) return false;
        if ($flagState === 'off' && $isOn) return false;
    }
    $variantFamily = portalFeatureVariantNormalizeFamily($variantFamily);
    $variantState = strtolower(trim((string)$variantState));
    if ($variantFamily !== '') {
        $resolved = portalFeatureFlagResolve($org['flags']);
        $variants = portalFeatureVariantResolve($org['variants'], $resolved['resolved_by_key']);
        $effectiveVariant = strtolower(trim((string)($variants['resolved'][$variantFamily] ?? '')));
        if ($variantState === 'none' && $effectiveVariant !== '') return false;
        if ($variantState !== '' && $variantState !== 'all' && $variantState !== 'none') {
            $wantedVariant = portalFeatureVariantNormalizeKey($variantFamily, $variantState);
            if ($wantedVariant !== '' && $effectiveVariant !== $wantedVariant) return false;
        }
    }
    $query = strtolower(trim((string)$query));
    if ($query === '') return true;
    $haystack = strtolower(implode(' ', [
        $org['id'] ?? '',
        $org['name'] ?? '',
        $org['email'] ?? '',
        $org['phone'] ?? '',
        $org['status'] ?? '',
    ]));
    return strpos($haystack, $query) !== false;
}

function portalFeatureFlagFilteredOrgs($query = '', $status = '', $limit = 0, $offset = 0, $flagKey = '', $flagState = '', $variantFamily = '', $variantState = '') {
    $items = [];
    $total = 0;
    foreach (portalFeatureFlagAllOrgIds() as $orgId) {
        $org = portalFeatureFlagReadOrgRecord($orgId);
        if (!$org || !portalFeatureFlagOrgMatches($org, $query, $status, $flagKey, $flagState, $variantFamily, $variantState)) continue;
        $total++;
        if ($offset > 0) {
            $offset--;
            continue;
        }
        if ($limit > 0 && count($items) >= $limit) continue;
        $items[] = $org;
    }
    return ['total' => $total, 'items' => $items];
}

function portalFeatureFlagFilteredOrgIds($query = '', $status = '', $flagKey = '', $flagState = '', $variantFamily = '', $variantState = '') {
    $ids = [];
    foreach (portalFeatureFlagAllOrgIds() as $orgId) {
        $org = portalFeatureFlagReadOrgRecord($orgId);
        if (!$org || !portalFeatureFlagOrgMatches($org, $query, $status, $flagKey, $flagState, $variantFamily, $variantState)) continue;
        $ids[] = (string)$orgId;
    }
    return $ids;
}

function portalFeatureFlagStableBucket($orgId, $salt = '') {
    $hash = hash('sha256', (string)$salt . ':' . (string)$orgId);
    $slice = substr($hash, 0, 8);
    return hexdec($slice) % 10000;
}

function portalFeatureFlagStableHash($orgId, $salt = '') {
    return hash('sha256', (string)$salt . ':' . (string)$orgId);
}

function portalFeatureFlagStableCohortIds($orgs, $percent, $salt = '') {
    $orgs = is_array($orgs) ? $orgs : [];
    $count = count($orgs);
    $target = (int)round($count * max(0, min(100, (float)$percent)) / 100);
    if ($target <= 0 || $count <= 0) return [];
    if ($target >= $count) {
        $all = [];
        foreach ($orgs as $org) {
            $orgId = (string)($org['id'] ?? '');
            if ($orgId !== '') $all[$orgId] = true;
        }
        return $all;
    }

    $ranked = [];
    foreach ($orgs as $org) {
        $orgId = (string)($org['id'] ?? '');
        if ($orgId === '') continue;
        $ranked[] = [
            'id' => $orgId,
            'hash' => portalFeatureFlagStableHash($orgId, $salt),
        ];
    }
    usort($ranked, function($a, $b) {
        $cmp = strcmp($a['hash'], $b['hash']);
        return $cmp !== 0 ? $cmp : strcmp($a['id'], $b['id']);
    });

    $selected = [];
    foreach (array_slice($ranked, 0, $target) as $entry) {
        $selected[$entry['id']] = true;
    }
    return $selected;
}

function portalFeatureFlagStableCohortIdMap($orgIds, $percent, $salt = '') {
    $orgIds = array_values(array_filter(array_map('strval', is_array($orgIds) ? $orgIds : [])));
    $count = count($orgIds);
    $target = (int)round($count * max(0, min(100, (float)$percent)) / 100);
    if ($target <= 0 || $count <= 0) return [];
    if ($target >= $count) return array_fill_keys($orgIds, true);

    $ranked = [];
    foreach ($orgIds as $orgId) {
        $ranked[] = [
            'id' => $orgId,
            'hash' => portalFeatureFlagStableHash($orgId, $salt),
        ];
    }
    usort($ranked, function($a, $b) {
        $cmp = strcmp($a['hash'], $b['hash']);
        return $cmp !== 0 ? $cmp : strcmp($a['id'], $b['id']);
    });

    $selected = [];
    foreach (array_slice($ranked, 0, $target) as $entry) {
        $selected[$entry['id']] = true;
    }
    return $selected;
}

function portalFeatureFlagRolloutPayload() {
    $mode = strtolower(trim((string)($_POST['mode'] ?? 'percentage')));
    $desired = strtolower(trim((string)($_POST['desired'] ?? 'on'))) === 'off' ? false : true;
    $query = trim((string)($_POST['query'] ?? ''));
    $status = trim((string)($_POST['status'] ?? ''));
    $flagKey = trim((string)($_POST['filter_flag_key'] ?? ''));
    $flagState = trim((string)($_POST['filter_flag_state'] ?? ''));
    $variantFamily = trim((string)($_POST['filter_variant_family'] ?? ''));
    $variantState = trim((string)($_POST['filter_variant_state'] ?? ''));
    $percent = max(0, min(100, (float)($_POST['percent'] ?? 100)));
    $dryRun = filter_var($_POST['dry_run'] ?? '0', FILTER_VALIDATE_BOOLEAN);
    $keys = json_decode((string)($_POST['flag_keys'] ?? '[]'), true);
    if (!is_array($keys)) $keys = [];
    $keys = array_values(array_unique(array_values(array_filter(array_map('portalFeatureFlagNormalizeKey', $keys)))));
    sort($keys, SORT_STRING);
    if (!$keys) return ['success' => false, 'error' => 'Choose at least one feature flag'];
    if (!in_array($mode, ['all', 'percentage'], true)) {
        return ['success' => false, 'error' => 'Unsupported rollout mode'];
    }

    $postedActions = json_decode((string)($_POST['flag_actions'] ?? '{}'), true);
    if (!is_array($postedActions)) $postedActions = [];
    $flagActions = [];
    foreach ($keys as $key) {
        $rawAction = strtolower(trim((string)($postedActions[$key] ?? ($desired ? 'on' : 'off'))));
        $flagActions[$key] = $rawAction === 'off' ? false : true;
    }

    return [
        'success' => true,
        'mode' => $mode,
        'query' => $query,
        'status' => $status,
        'filter_flag_key' => $flagKey,
        'filter_flag_state' => $flagState,
        'filter_variant_family' => $variantFamily,
        'filter_variant_state' => $variantState,
        'percent' => $percent,
        'dry_run' => $dryRun,
        'keys' => $keys,
        'flag_actions' => $flagActions,
    ];
}

function portalFeatureVariantAssignments($orgIds, $family, $variantKeys) {
    $orgIds = array_values(array_filter(array_map('strval', is_array($orgIds) ? $orgIds : [])));
    $variantKeys = array_values(array_filter(array_map('strval', is_array($variantKeys) ? $variantKeys : [])));
    if (!$orgIds || !$variantKeys) return [];

    $ranked = [];
    foreach ($orgIds as $orgId) {
        $ranked[] = [
            'id' => $orgId,
            'hash' => portalFeatureFlagStableHash($orgId, 'variant-choice:' . $family),
        ];
    }
    usort($ranked, function($a, $b) {
        $cmp = strcmp($a['hash'], $b['hash']);
        return $cmp !== 0 ? $cmp : strcmp($a['id'], $b['id']);
    });

    $assignments = [];
    foreach ($ranked as $index => $entry) {
        $assignments[$entry['id']] = $variantKeys[$index % count($variantKeys)];
    }
    return $assignments;
}

function portalFeatureFlagSetKey(&$flags, $key, $enabled) {
    $registry = portalFeatureFlagRegistry();
    if (empty($registry[$key])) return false;
    $definition = $registry[$key];
    if (!isset($flags[$definition['group']]) || !is_array($flags[$definition['group']])) $flags[$definition['group']] = [];
    $flags[$definition['group']][$definition['flag']] = $enabled ? true : false;
    return true;
}

function portalFeatureFlagSaveOrgFlags($orgId, $flags, $actorEmail = '') {
    $result = portalFeatureFlagSaveOrgFlagsDetailed($orgId, $flags, $actorEmail);
    return !empty($result['success']);
}

function portalFeatureFlagSaveOrgStateViaInternalApi($orgId, $flags = null, $variants = null) {
    $body = [];
    if ($flags !== null) $body['app_flags'] = portalFeatureFlagNormalizeFlags($flags);
    if ($variants !== null) $body['app_variants'] = portalFeatureVariantNormalizeValues($variants);
    if (!$body) return ['success' => false, 'error' => 'No app flag state supplied'];
    if (!function_exists('portalNodeInternalRequest')) {
        return ['success' => false, 'error' => 'Internal API client unavailable'];
    }
    $last = null;
    for ($attempt = 1; $attempt <= 4; $attempt++) {
        $res = portalNodeInternalRequest('POST', 'admin/organizations/' . rawurlencode((string)$orgId) . '/app-flags', $body);
        if (!empty($res['ok'])) return ['success' => true, 'source' => 'internal_api', 'attempts' => $attempt];
        $last = $res;
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        $message = (string)($json['message'] ?? $json['error'] ?? ($res['error'] ?? '') ?: ($res['body'] ?? '') ?: 'Internal API write failed');
        $status = (int)($res['status'] ?? 0);
        $retryableAdminMismatch = $status === 403 && (
            stripos($message, 'Only internal admins can manage app feature flags') !== false
            || stripos($message, 'admin_required') !== false
        );
        if (!$retryableAdminMismatch && !in_array($status, [0, 429, 500, 502, 503, 504], true)) break;
        if ($attempt < 4) usleep(120000 * $attempt);
    }
    $res = is_array($last) ? $last : [];
    $json = is_array($res['json'] ?? null) ? $res['json'] : [];
    $message = (string)($json['message'] ?? $json['error'] ?? ($res['error'] ?? '') ?: ($res['body'] ?? '') ?: 'Internal API write failed');
    return [
        'success' => false,
        'error' => 'Internal API: ' . trim(substr($message, 0, 240)),
        'status' => (int)($res['status'] ?? 0),
    ];
}

function portalFeatureFlagSaveOrgFlagsDetailed($orgId, $flags, $actorEmail = '') {
    $apiResult = portalFeatureFlagSaveOrgStateViaInternalApi($orgId, $flags, null);
    if (!empty($apiResult['success'])) return $apiResult;

    $paths = portalFeatureFlagOrgPaths($orgId);
    if (!$paths) return ['success' => false, 'error' => 'Invalid organization id'];
    $global = portalFeatureFlagReadJson($paths['global']);
    if (!is_array($global)) $global = [];
    if (!isset($global['id'])) $global['id'] = 'global';
    if (!isset($global['data']) || !is_array($global['data'])) $global['data'] = [];
    $global['data']['app_flags'] = portalFeatureFlagNormalizeFlags($flags);
    $global['updated_at'] = gmdate('c');
    $global['updated_by'] = $actorEmail;
    $fileResult = portalFeatureFlagWriteJsonDetailed($paths['global'], $global);
    if (!empty($fileResult['success'])) return $fileResult;
    return [
        'success' => false,
        'error' => ($apiResult['error'] ?? 'Internal API write failed') . '; direct file write: ' . ($fileResult['error'] ?? 'write failed'),
    ];
}

function portalFeatureFlagSaveOrgState($orgId, $flags, $variants, $actorEmail = '') {
    $result = portalFeatureFlagSaveOrgStateDetailed($orgId, $flags, $variants, $actorEmail);
    return !empty($result['success']);
}

function portalFeatureFlagSaveOrgStateDetailed($orgId, $flags, $variants, $actorEmail = '') {
    $apiResult = portalFeatureFlagSaveOrgStateViaInternalApi($orgId, $flags, $variants);
    if (!empty($apiResult['success'])) return $apiResult;

    $paths = portalFeatureFlagOrgPaths($orgId);
    if (!$paths) return ['success' => false, 'error' => 'Invalid organization id'];
    $global = portalFeatureFlagReadJson($paths['global']);
    if (!is_array($global)) $global = [];
    if (!isset($global['id'])) $global['id'] = 'global';
    if (!isset($global['data']) || !is_array($global['data'])) $global['data'] = [];
    $global['data']['app_flags'] = portalFeatureFlagNormalizeFlags($flags);
    $global['data']['app_variants'] = portalFeatureVariantNormalizeValues($variants);
    $global['updated_at'] = gmdate('c');
    $global['updated_by'] = $actorEmail;
    $fileResult = portalFeatureFlagWriteJsonDetailed($paths['global'], $global);
    if (!empty($fileResult['success'])) return $fileResult;
    return [
        'success' => false,
        'error' => ($apiResult['error'] ?? 'Internal API write failed') . '; direct file write: ' . ($fileResult['error'] ?? 'write failed'),
    ];
}

function portalRefundCreditsByOrganizationId($orgId, $amount, $reason, $meta = [], $appliedForEmail = '') {
    $orgId = portalNormalizeOrganizationId($orgId);
    $amount = portalCreditAmount($amount);
    if ($orgId === '' || $amount <= 0) return ['ok' => false, 'error' => 'bad_args'];

    $appliedForEmail = strtolower(trim((string)$appliedForEmail));
    $payload = [
        'amount' => $amount,
        'direction' => 'add',
        'reason' => (string)$reason,
        'applied_for_user_email' => $appliedForEmail !== '' ? $appliedForEmail : null,
        'meta' => array_merge((array)$meta, ['refund' => $amount]),
        'unit' => 'usd_dollars',
    ];

    $res = portalNodeInternalRequest('POST', 'organizations/' . rawurlencode($orgId) . '/credits/adjust', $payload);
    if (empty($res['ok'])) {
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        return [
            'ok' => false,
            'error' => (string)($json['error'] ?? $res['error'] ?? 'node_credit_refund_failed'),
            'status' => $res['status'] ?? 500,
            'node_response' => $json,
        ];
    }

    $json = is_array($res['json'] ?? null) ? $res['json'] : [];

    return [
        'ok' => true,
        'scope' => 'org',
        'org_id' => $orgId,
        'new_balance' => portalCreditAmount($json['balance'] ?? 0),
        'refunded' => $amount,
        'applied_for_user_email' => $appliedForEmail !== '' ? $appliedForEmail : null,
        'node_response' => $json,
    ];
}

function portalRefundCreditsByEmail($email, $amount, $reason, $meta = []) {
    if (function_exists('creditsRefundByEmail')) {
        return creditsRefundByEmail($email, $amount, $reason, $meta);
    }

    $email = strtolower(trim((string)$email));
    $amount = portalCreditAmount($amount);
    if ($email === '' || $amount <= 0) return ['ok' => false, 'error' => 'bad_args'];

    $user = portalReadUserDataByEmail($email);
    if (!is_array($user)) return ['ok' => false, 'error' => 'User not found'];

    $orgId = portalNormalizeOrganizationId($user['organization_id'] ?? '');
    if ($orgId !== '') {
        return portalRefundCreditsByOrganizationId($orgId, $amount, $reason, $meta, $email);
    }

    portalEnsureUserCreditsFields($user);
    $user['credits_balance'] = portalCreditAmount($user['credits_balance'] + $amount);
    $user['credits_ledger'][] = [
        'ts' => date('c'),
        'delta' => $amount,
        'reason' => (string)$reason,
        'by_email' => $_SESSION['user_email'] ?? null,
        'meta' => array_merge((array)$meta, ['refund' => $amount]),
        'unit' => 'usd_dollars',
    ];

    if (!portalWriteUserDataByEmail($email, $user)) return ['ok' => false, 'error' => 'user_write_failed'];

    return [
        'ok' => true,
        'scope' => 'user',
        'new_balance' => portalCreditAmount($user['credits_balance']),
        'refunded' => $amount,
    ];
}

function tutorialCourseIdFromRequest() {
    $raw = strtolower(trim((string)($_POST['course_id'] ?? $_GET['course_id'] ?? 'default')));
    if ($raw === '' || $raw === 'default') return 'default';
    $slug = preg_replace('/[^a-z0-9_\-]/', '', str_replace(' ', '-', $raw));
    return $slug !== '' ? $slug : 'default';
}

function tutorialCourseBaseDir($courseId) {
    global $tutorialDir;
    if ($courseId === 'default') return $tutorialDir;
    return $tutorialDir . 'courses/' . $courseId . '/';
}

function tutorialEnsureCourseDirs($courseId) {
    $base = tutorialCourseBaseDir($courseId);
    if (!file_exists($base)) mkdir($base, 0777, true);
    if (!file_exists($base . 'master/')) mkdir($base . 'master/', 0777, true);
    return $base;
}

function portalDataAgentCanUse($userData, $perms) {
    if (!is_array($userData)) return false;
    if (($userData['account_type'] ?? '') === 'customer') return false;
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    return $role === 'admin' || !empty($userData['is_admin']) || !empty($perms['is_admin_legacy']);
}

$myUserData = portalReadUserDataByEmail($currentUserEmail);
if (!is_array($myUserData)) { header("Location: backend_logout.php"); exit; }

// --- EMPLOYEE-ONLY GATE ---
if (!isEmployeeUserData($myUserData)) {
    // boot immediately
    header("Location: /portal");
    exit;
}


// Normalize permissions if missing
$myPerms = permissionOptionsNormalizePermissions($myUserData['permissions'] ?? [], $myUserData['role'] ?? 'user');
$canDataAgent = portalDataAgentCanUse($myUserData, $myPerms);
$isFullAdmin = in_array(strtolower(trim((string)($myUserData['role'] ?? ''))), ['admin', 'system_admin'], true)
    || !empty($myUserData['is_admin'])
    || !empty($myPerms['is_admin_legacy'])
    || !empty($myPerms['platform_admin']);

$myTeam  = $myUserData['team_id'] ?? 'default';

// Training completion (admin-set only)
$myTrainingComplete = !empty($myUserData['training_complete']);
$tutorialCourseOptions = portalTutorialCourseOptions();
$myTutorialCourseId = portalDefaultTutorialCourseForUser($myUserData);
$portalGlobalReportSettingsPath = storagePath('config/report_settings.json');
$portalGlobalReportSettings = is_file($portalGlobalReportSettingsPath)
    ? json_decode((string)@file_get_contents($portalGlobalReportSettingsPath), true)
    : [];
if (!is_array($portalGlobalReportSettings)) $portalGlobalReportSettings = [];

// Derive queue-admin ability:
$isQueueAdmin = !!($myPerms['manage_queue'] ?? false) || !!($myPerms['is_admin_legacy'] ?? false) || (($myUserData['role'] ?? '') === 'admin');

// Apple key admin ability:
$isAppleKeyAdmin = !!($myPerms['manage_apple_key'] ?? false) || !!($myPerms['is_admin_legacy'] ?? false) || (($myUserData['role'] ?? '') === 'admin');
$canDebugFirstMeasure = !!($myPerms['debug_firstmeasure_api'] ?? false) || (($myUserData['role'] ?? '') === 'admin');

// --- DEFAULT LANDING VIEW ---
$isQaRole = !!($myPerms['manage_qa'] ?? false) || !!($myPerms['manage_qa_queue'] ?? false);
$isManagerRole = !!($myPerms['manage_queue'] ?? false);
$userRoleKey = strtolower(trim((string)($myUserData['role'] ?? 'user')));
$isDraftingTechnician = ($userRoleKey === 'technician')
    && !$isQaRole
    && !$isManagerRole
    && !$isQueueAdmin
    && (($myUserData['role'] ?? '') !== 'admin')
    && empty($myUserData['is_admin']);
$showShiftDashboard = $isManagerRole || portalCanManagerReview($myUserData, $myPerms);
$showProductionDashboard = $isDraftingTechnician || $showShiftDashboard;

$defaultView = 'projects';
if ($isDraftingTechnician) {
    $defaultView = 'dashboard';
} elseif ($isQaRole && !$isManagerRole) {
    $defaultView = 'qa';
} elseif ($showShiftDashboard) {
    $defaultView = 'dashboard';
}

function portalUserRole($u) {
    return strtolower(trim((string)($u['role'] ?? '')));
}

function portalCanDoQa($u, $perms = null) {
    if (!is_array($u)) $u = [];
    if (!is_array($perms)) $perms = $u['permissions'] ?? [];
    $role = portalUserRole($u);
    return $role === 'admin' || !empty($perms['manage_qa']) || !empty($perms['is_admin_legacy']);
}

function portalCanManageQaQueue($u, $perms = null) {
    if (!is_array($u)) $u = [];
    if (!is_array($perms)) $perms = $u['permissions'] ?? [];
    $role = portalUserRole($u);
    return $role === 'admin' || $role === 'manager' || !empty($perms['manage_qa_queue']) || !empty($perms['is_admin_legacy']);
}

function portalCanManagerReview($u, $perms = null) {
    if (!is_array($u)) $u = [];
    if (!is_array($perms)) $perms = $u['permissions'] ?? [];
    $role = portalUserRole($u);
    return $role === 'admin' || $role === 'manager';
}

function portalQaBlindIdentityFields(array $item, $viewerEmail = '') {
    $viewerEmail = strtolower(trim((string)$viewerEmail));
    $identityKeys = [
        'assigned_to_email', 'assigned_to_name',
        'drafter_email', 'drafter_name',
        'technician_email', 'technician_name',
        'qa_paid_to_email', 'qa_paid_to_name',
        'qa_return_to_email', 'qa_return_to_name',
        'return_to_qa_email', 'return_to_qa_name',
        'original_technician_email', 'original_technician_name',
        'latest_technician_email', 'latest_technician_name',
        'display_technician_email', 'display_technician_name',
        'correction_to_email', 'correction_to_name',
        'reserved_to_email', 'reserved_to_name',
        'last_reopened_claimed_by_email', 'last_reopened_claimed_by_name',
    ];
    foreach ($identityKeys as $key) {
        if (array_key_exists($key, $item)) $item[$key] = null;
    }

    $claimEmail = strtolower(trim((string)($item['qa_claimed_by_email'] ?? '')));
    if ($claimEmail !== '' && $claimEmail !== $viewerEmail) {
        $item['qa_claimed_by_email'] = '__other__';
        $item['qa_claimed_by_name'] = 'Another QA reviewer';
    } elseif ($claimEmail === '') {
        if (array_key_exists('qa_claimed_by_email', $item)) $item['qa_claimed_by_email'] = null;
        if (array_key_exists('qa_claimed_by_name', $item)) $item['qa_claimed_by_name'] = null;
    }

    foreach (['technician_history', 'previous_technician_history'] as $key) {
        if (array_key_exists($key, $item)) $item[$key] = [];
    }

    foreach (['work_history', 'qa_history'] as $historyKey) {
        if (empty($item[$historyKey]) || !is_array($item[$historyKey])) continue;
        foreach ($item[$historyKey] as &$event) {
            if (!is_array($event)) continue;
            foreach ([
                'worker_email', 'worker_name',
                'assigned_to_email', 'assigned_to_name',
                'technician_email', 'technician_name',
                'qa_email', 'qa_name',
                'inspector', 'inspector_name',
                'user_email', 'user_name',
            ] as $key) {
                if (array_key_exists($key, $event)) $event[$key] = null;
            }
        }
        unset($event);
    }

    if (isset($item['workflow']) && is_array($item['workflow'])) {
        foreach (['assigned_to', 'reserved_to', 'correction_to', 'qa_claim'] as $key) {
            if (isset($item['workflow'][$key]) && is_array($item['workflow'][$key])) {
                foreach (['email', 'name', 'claimed_by_email', 'claimed_by_name'] as $field) {
                    if (array_key_exists($field, $item['workflow'][$key])) $item['workflow'][$key][$field] = null;
                }
            }
        }
        if (!empty($item['workflow']['history']) && is_array($item['workflow']['history'])) {
            foreach ($item['workflow']['history'] as &$event) {
                if (!is_array($event)) continue;
                foreach ([
                    'worker_email', 'worker_name',
                    'assigned_to_email', 'assigned_to_name',
                    'technician_email', 'technician_name',
                    'qa_email', 'qa_name',
                    'inspector', 'inspector_name',
                    'user_email', 'user_name',
                ] as $key) {
                    if (array_key_exists($key, $event)) $event[$key] = null;
                }
            }
            unset($event);
        }
    }

    return $item;
}

function portalQaBlindIdentityList($items, $viewerEmail = '') {
    $out = [];
    foreach (array_values(array_filter((array)$items, 'is_array')) as $item) {
        $out[] = portalQaBlindIdentityFields($item, $viewerEmail);
    }
    return $out;
}

function portalQaQueueStatePath() {
    return storagePath('meta/qa_queue_state.json', true);
}

function portalQaHeartbeatCleanupPath() {
    return storagePath('meta/qa_heartbeat_cleanup.json', true);
}

function portalQaHeartbeatTimeoutSeconds() {
    return 20 * 60;
}

function portalQaHeartbeatCleanupEnabled() {
    return false;
}

function portalQaHeartbeatCleanupIntervalSeconds() {
    return 60;
}

function portalQaTouchHeartbeat($email, $currentFolder = '', $active = true) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    $u = portalReadUserDataByEmail($email);
    if (!is_array($u)) return false;
    $nowIso = gmdate('c');
    $u['last_qa_heartbeat_at'] = $nowIso;
    $u['last_qa_activity_at'] = $active ? $nowIso : ($u['last_qa_activity_at'] ?? null);
    $u['qa_heartbeat_active'] = $active ? true : false;
    $u['qa_heartbeat_current_folder'] = trim((string)$currentFolder);
    return portalWriteUserDataByEmail($email, $u);
}

function portalQaHeartbeatTsForEmail($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return 0;
    $u = portalReadUserDataByEmail($email);
    if (!is_array($u)) return 0;
    if (array_key_exists('qa_heartbeat_active', $u) && empty($u['qa_heartbeat_active'])) return 0;
    foreach (['last_qa_heartbeat_at', 'last_qa_activity_at'] as $key) {
        $raw = trim((string)($u[$key] ?? ''));
        if ($raw === '') continue;
        $ts = strtotime($raw);
        if ($ts !== false) return (int)$ts;
    }
    return 0;
}

function portalQaClaimExpired($item, $nowTs = null) {
    if (!is_array($item)) return false;
    $claimedBy = portalQaClaimedByEmail($item);
    if ($claimedBy === '') return false;
    if ($nowTs === null) $nowTs = time();
    $timeout = portalQaHeartbeatTimeoutSeconds();
    $heartbeatTs = portalQaHeartbeatTsForEmail($claimedBy);
    if ($heartbeatTs > 0) return ($nowTs - $heartbeatTs) > $timeout;

    $claimedAtRaw = trim((string)($item['qa_claimed_at'] ?? ''));
    if ($claimedAtRaw === '' && isset($item['workflow']) && is_array($item['workflow'])) {
        $claim = is_array($item['workflow']['qa_claim'] ?? null) ? $item['workflow']['qa_claim'] : [];
        $claimedAtRaw = trim((string)($claim['claimed_at'] ?? ''));
    }
    $claimedAt = $claimedAtRaw !== '' ? strtotime($claimedAtRaw) : false;
    return $claimedAt !== false && ($nowTs - (int)$claimedAt) > $timeout;
}

function portalQaReturnToQaMeta($item) {
    if (!is_array($item)) return ['email' => '', 'name' => '', 'at' => ''];

    $email = '';
    $name = '';
    $at = '';
    foreach ([
        ['qa_return_to_email', 'qa_return_to_name', 'qa_return_to_set_at'],
        ['return_to_qa_email', 'return_to_qa_name', 'return_to_qa_at'],
    ] as $keys) {
        $candidateEmail = strtolower(trim((string)($item[$keys[0]] ?? '')));
        if ($candidateEmail === '') continue;
        $email = $candidateEmail;
        $name = trim((string)($item[$keys[1]] ?? ''));
        $at = trim((string)($item[$keys[2]] ?? ''));
        break;
    }
    if ($email !== '') return ['email' => $email, 'name' => $name, 'at' => $at];

    $history = [];
    if (!empty($item['work_history']) && is_array($item['work_history'])) {
        $history = array_values($item['work_history']);
    } elseif (!empty($item['workflow']['history']) && is_array($item['workflow']['history'])) {
        $history = array_values($item['workflow']['history']);
    }

    $lastReturn = null;
    $lastCorrectionSubmitIndex = -1;
    foreach ($history as $idx => $event) {
        if (!is_array($event)) continue;
        $eventName = strtolower(trim((string)($event['event'] ?? '')));
        if (in_array($eventName, ['correction_submitted', 'submitted_for_qa'], true)) {
            $lastCorrectionSubmitIndex = $idx;
        }
        if (!in_array($eventName, ['qa_rejected', 'qa_sent_back_to_tech'], true)) continue;
        $candidateEmail = strtolower(trim((string)($event['qa_email'] ?? ($event['inspector'] ?? ($event['user_email'] ?? ($event['by_email'] ?? ''))))));
        $candidateName = trim((string)($event['qa_name'] ?? ($event['inspector_name'] ?? ($event['user_name'] ?? ($event['by_name'] ?? '')))));
        if ($candidateEmail === '' && $candidateName === '') continue;
        $lastReturn = [
            'index' => $idx,
            'email' => $candidateEmail,
            'name' => $candidateName,
            'at' => trim((string)($event['ts'] ?? ($event['date'] ?? ($event['created_at'] ?? '')))),
        ];
    }

    if (!$lastReturn) return ['email' => '', 'name' => '', 'at' => ''];
    $status = strtolower(trim((string)($item['status'] ?? '')));
    if ($status === 'awaiting_review' && $lastCorrectionSubmitIndex <= (int)$lastReturn['index']) {
        return ['email' => '', 'name' => '', 'at' => ''];
    }
    return [
        'email' => (string)$lastReturn['email'],
        'name' => (string)$lastReturn['name'],
        'at' => (string)$lastReturn['at'],
    ];
}

function portalQaReturnTargetIsActive($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    $heartbeatTs = portalQaHeartbeatTsForEmail($email);
    return $heartbeatTs > 0 && (time() - $heartbeatTs) <= portalQaHeartbeatTimeoutSeconds();
}

function portalQaCanViewerAccessReturnRoutedItem($item, $viewerEmail, $canManage = false) {
    if ($canManage) return true;
    if (!is_array($item)) return true;
    $status = strtolower(trim((string)($item['status'] ?? '')));
    if ($status !== 'awaiting_review') return true;

    $route = portalQaReturnToQaMeta($item);
    $targetEmail = strtolower(trim((string)($route['email'] ?? '')));
    if ($targetEmail === '') return true;

    $viewerEmail = strtolower(trim((string)$viewerEmail));
    if ($viewerEmail !== '' && $targetEmail === $viewerEmail) return true;
    return !portalQaReturnTargetIsActive($targetEmail);
}

function portalQaReturnsToViewer($item, $viewerEmail) {
    $viewerEmail = strtolower(trim((string)$viewerEmail));
    if ($viewerEmail === '' || !is_array($item)) return false;
    $status = strtolower(trim((string)($item['status'] ?? '')));
    if ($status !== 'awaiting_review') return false;
    $route = portalQaReturnToQaMeta($item);
    return strtolower(trim((string)($route['email'] ?? ''))) === $viewerEmail;
}

function portalQaPreferReturnRoutedForViewer(array $items, $viewerEmail) {
    $viewerEmail = strtolower(trim((string)$viewerEmail));
    if ($viewerEmail === '') return $items;
    $mine = [];
    $rest = [];
    foreach ($items as $item) {
        if (portalQaReturnsToViewer($item, $viewerEmail)) $mine[] = $item;
        else $rest[] = $item;
    }
    return array_merge($mine, $rest);
}

function portalQaReleaseExpiredClaims($teamKey = 'all', $force = false) {
    if (!portalQaHeartbeatCleanupEnabled()) {
        return [
            'success' => true,
            'skipped' => true,
            'disabled' => true,
            'released' => 0,
        ];
    }
    $teamKey = portalQaTeamKey($teamKey);
    $statePath = portalQaHeartbeatCleanupPath();
    $state = [];
    if (is_file($statePath)) {
        $state = json_decode(@file_get_contents($statePath) ?: '{}', true);
        if (!is_array($state)) $state = [];
    }
    $nowTs = time();
    $runsByTeam = is_array($state['last_run_by_team'] ?? null) ? $state['last_run_by_team'] : [];
    $teamRun = is_array($runsByTeam[$teamKey] ?? null) ? $runsByTeam[$teamKey] : [];
    $lastRun = (int)($teamRun['ts'] ?? 0);
    if (!$force && $lastRun > 0 && ($nowTs - $lastRun) < portalQaHeartbeatCleanupIntervalSeconds()) {
        return [
            'success' => true,
            'skipped' => true,
            'released' => 0,
            'last_run_at' => $teamRun['at'] ?? null,
        ];
    }

    $released = 0;
    $checked = 0;
    $projects = function_exists('fm_project_query')
        ? fm_project_query([
            'statuses' => ['awaiting_review', 'pending_rejection'],
            'include_all' => true,
        ])
        : fm_fetch_all_projects(true);

    foreach (array_values(array_filter((array)$projects, 'is_array')) as $item) {
        $projectId = portalQaProjectId($item);
        if ($projectId === '') continue;
        $claimedBy = portalQaClaimedByEmail($item);
        if ($claimedBy === '') continue;
        if ($teamKey !== 'all') {
            $projectTeam = portalQaTeamKey($item['team_id'] ?? ($item['team'] ?? 'default'));
            if ($projectTeam !== 'all' && $projectTeam !== $teamKey) continue;
        }
        $checked++;
        if (!portalQaClaimExpired($item, $nowTs)) continue;
        $res = portalQaReleaseClaimLocal($projectId, [
            'email' => 'system@firstmate.app',
            'name' => 'QA Heartbeat Monitor',
        ], 'heartbeat_expired', true);
        if (!empty($res['success'])) $released++;
    }

    $runsByTeam[$teamKey] = [
        'ts' => $nowTs,
        'at' => gmdate('c', $nowTs),
        'checked' => $checked,
        'released' => $released,
    ];
    $state['last_run_by_team'] = $runsByTeam;
    $state['last_run_ts'] = $nowTs;
    $state['last_run_at'] = gmdate('c', $nowTs);
    $state['last_team'] = $teamKey;
    $state['last_checked'] = $checked;
    $state['last_released'] = $released;
    if (function_exists('atomicWriteJson')) @atomicWriteJson($statePath, $state);
    else @file_put_contents($statePath, json_encode($state, JSON_PRETTY_PRINT));

    return [
        'success' => true,
        'skipped' => false,
        'checked' => $checked,
        'released' => $released,
        'last_run_at' => $state['last_run_at'],
    ];
}

function portalQaNormalizeTopList($value) {
    $ids = [];
    foreach (is_array($value) ? $value : [] as $raw) {
        $id = trim((string)$raw);
        if ($id === '' || in_array($id, $ids, true)) continue;
        $ids[] = $id;
    }
    return $ids;
}

function portalQaReadQueueState() {
    $path = portalQaQueueStatePath();
    $data = [
        'manual_top_by_team' => [],
        'updated_at' => null,
        'updated_by' => null,
        'updated_by_name' => null,
    ];
    if (!file_exists($path)) return $data;
    $raw = @file_get_contents($path);
    $json = json_decode($raw ?: '{}', true);
    if (!is_array($json)) return $data;
    $map = [];
    foreach ((array)($json['manual_top_by_team'] ?? []) as $teamKey => $list) {
        $map[(string)$teamKey] = portalQaNormalizeTopList($list);
    }
    $data['manual_top_by_team'] = $map;
    $data['updated_at'] = is_string($json['updated_at'] ?? null) ? $json['updated_at'] : null;
    $data['updated_by'] = is_string($json['updated_by'] ?? null) ? strtolower(trim($json['updated_by'])) : null;
    $data['updated_by_name'] = is_string($json['updated_by_name'] ?? null) ? trim($json['updated_by_name']) : null;
    return $data;
}

function portalQaWriteQueueState($state) {
    if (!is_array($state)) $state = [];
    $normalized = [
        'manual_top_by_team' => [],
        'updated_at' => $state['updated_at'] ?? null,
        'updated_by' => $state['updated_by'] ?? null,
        'updated_by_name' => $state['updated_by_name'] ?? null,
    ];
    foreach ((array)($state['manual_top_by_team'] ?? []) as $teamKey => $list) {
        $normalized['manual_top_by_team'][(string)$teamKey] = portalQaNormalizeTopList($list);
    }
    return atomicWriteJson(portalQaQueueStatePath(), $normalized);
}

function portalQaTeamKey($teamId) {
    $team = trim((string)$teamId);
    if ($team === '' || strtolower($team) === 'default') return 'all';
    return $team;
}

function portalQaTimestampValue($item, array $keys) {
    foreach ($keys as $key) {
        $raw = trim((string)($item[$key] ?? ''));
        if ($raw === '') continue;
        $ts = strtotime($raw);
        if ($ts !== false) return (int)$ts;
    }
    return 0;
}

function portalQaPriorityGroup($item) {
    if (!empty($item['qa_priority'])) return 0;
    $isFiller = !empty($item['is_filler']);
    if ($isFiller) return 3;
    $hasPriorityFlag = !empty($item['is_vip']) || !empty($item['is_expedited']);
    if ($hasPriorityFlag) return 1;
    return 2;
}

function portalQaPriorityBucketLabel($group) {
    switch ((int)$group) {
        case 0: return 'prioritized';
        case 1: return 'vip_or_expedited';
        case 2: return 'standard';
        default: return 'filler';
    }
}

function portalQaPointValue($item) {
    $raw = $item['point_value'] ?? ($item['project_points'] ?? null);
    if (is_numeric($raw) && (float)$raw > 0) return (float)$raw;
    $complexity = strtolower(trim((string)($item['complexity'] ?? '')));
    $complexity = preg_replace('/[^a-z0-9]+/', '_', $complexity);
    $complexity = trim((string)$complexity, '_');
    $map = [
        '1' => 2, '2' => 3, '3' => 4, '4' => 6, '5' => 10,
        'very_simple' => 2, 'very_simple_project' => 2,
        'simple' => 3, 'simple_project' => 3,
        'standard' => 4, 'standard_project' => 4,
        'complex' => 6, 'complex_project' => 6,
        'very_complex' => 10, 'very_complex_project' => 10,
    ];
    return (float)($map[$complexity] ?? 0);
}

function portalQaDrafterEmail($item) {
    $item = is_array($item) ? $item : [];
    if (function_exists('fm_project_pay_technician_from_manifest')) {
        $payTech = fm_project_pay_technician_from_manifest($item);
        $email = strtolower(trim((string)($payTech['email'] ?? '')));
        if ($email !== '') return $email;
    }
    $qaEmails = [];
    foreach (['qa_claimed_by_email', 'qa_approved_by_email', 'qa_approved_by', 'qa_reviewed_by_email', 'qa_reviewed_by'] as $key) {
        $qaEmail = strtolower(trim((string)($item[$key] ?? '')));
        if ($qaEmail !== '') $qaEmails[$qaEmail] = true;
    }
    foreach (['qa_paid_to_email', 'assigned_to_email', 'drafter_email', 'technician_email'] as $key) {
        $email = strtolower(trim((string)($item[$key] ?? '')));
        if ($email !== '' && isset($qaEmails[$email])) continue;
        if ($email !== '') return $email;
    }
    return '';
}

function portalQaBackfillSolarImageryQuality($manifestPath, $quality, $insights) {
    $quality = strtoupper(trim((string)$quality));
    if ($quality === '' || !is_file($manifestPath)) return;
    $manifest = json_decode(@file_get_contents($manifestPath) ?: '{}', true);
    if (!is_array($manifest)) return;
    $changed = false;
    if (trim((string)($manifest['solar_imagery_quality'] ?? '')) === '') {
        $manifest['solar_imagery_quality'] = $quality;
        $changed = true;
    }
    if (trim((string)($manifest['height_map_quality'] ?? '')) === '') {
        $manifest['height_map_quality'] = $quality;
        $changed = true;
    }
    if (!empty($insights['imageryDate']) && empty($manifest['solar_imagery_date'])) {
        $manifest['solar_imagery_date'] = $insights['imageryDate'];
        $changed = true;
    }
    if (!empty($insights['imageryProcessedDate']) && empty($manifest['solar_imagery_processed_date'])) {
        $manifest['solar_imagery_processed_date'] = $insights['imageryProcessedDate'];
        $changed = true;
    }
    if (!$changed) return;
    if (function_exists('atomicWriteJson')) @atomicWriteJson($manifestPath, $manifest);
    else @file_put_contents($manifestPath, json_encode($manifest, JSON_PRETTY_PRINT));
}

function portalQaStoredSolarImageryQuality($item) {
    foreach (['solar_imagery_quality', 'height_map_quality', 'heightmap_quality', 'dsm_quality', 'height_quality', 'height_map_quality_score', 'heightmap_quality_score'] as $key) {
        if (array_key_exists($key, $item) && trim((string)$item[$key]) !== '') {
            return ['raw' => $item[$key], 'source' => $key];
        }
    }
    $id = preg_replace('/[^a-z0-9_-]/', '', strtolower(trim((string)($item['id'] ?? ''))));
    if ($id === '') return ['raw' => null, 'source' => 'default'];
    $candidates = [
        __DIR__ . '/../../v1/storage/firstmeasure/projects/' . $id . '/insights.json',
        storagePath('firstmeasure/projects/' . $id . '/insights.json'),
    ];
    foreach ($candidates as $path) {
        if (!is_file($path)) continue;
        $json = json_decode(@file_get_contents($path) ?: '{}', true);
        if (!is_array($json)) continue;
        $quality = trim((string)($json['imageryQuality'] ?? ''));
        if ($quality !== '') {
            portalQaBackfillSolarImageryQuality(dirname($path) . '/manifest.json', $quality, $json);
            return ['raw' => strtoupper($quality), 'source' => 'insights.imageryQuality'];
        }
    }
    return ['raw' => null, 'source' => 'default'];
}

function portalQaHeightQualityMeta($item) {
    $stored = portalQaStoredSolarImageryQuality($item);
    $raw = $stored['raw'] ?? null;
    $sourceKey = $stored['source'] ?? 'default';
    if ($raw === null) {
        return ['points' => 5.0, 'source' => 'default', 'raw' => null];
    }
    $points = 5.0;
    if (is_numeric($raw)) {
        $value = (float)$raw;
        if ($value >= 0 && $value <= 1) $points = max(0, min(10, (1 - $value) * 10));
        elseif ($value >= 1 && $value <= 5) $points = max(0, min(10, (($value - 1) / 4) * 10));
        elseif ($value >= 0 && $value <= 10) $points = max(0, min(10, $value));
        elseif ($value >= 0 && $value <= 100) $points = max(0, min(10, 10 - ($value / 10)));
        return ['points' => round($points, 2), 'source' => $sourceKey, 'raw' => $raw];
    }
    $label = strtolower(trim((string)$raw));
    if (in_array($label, ['excellent', 'best', 'high', 'highest', 'good'], true)) $points = 0.0;
    elseif ($label === 'medium') $points = 5.0;
    elseif ($label === 'base') $points = 10.0;
    elseif (in_array($label, ['poor', 'low', 'lowest', 'bad'], true)) $points = 10.0;
    return ['points' => round($points, 2), 'source' => $sourceKey, 'raw' => $raw];
}

function portalQaHeightQualityPoints($item) {
    $meta = portalQaHeightQualityMeta($item);
    return (float)($meta['points'] ?? 5.0);
}

function portalQaRankMeta($item, $drafterRanks = null) {
    static $cachedRanks = null;
    if (!is_array($drafterRanks)) {
        if ($cachedRanks === null) $cachedRanks = portalQaDrafterRankMap();
        $drafterRanks = $cachedRanks;
    }
    $drafterEmail = portalQaDrafterEmail($item);
    $rank = strtolower(trim((string)($drafterRanks[$drafterEmail] ?? 'junior')));
    if (!in_array($rank, ['junior', 'standard', 'senior'], true)) $rank = 'junior';
    $rankPoints = $rank === 'senior' ? 0 : ($rank === 'standard' ? 5 : 10);
    $projectPoints = portalQaPointValue($item);
    $heightMeta = portalQaHeightQualityMeta($item);
    $heightPoints = (float)($heightMeta['points'] ?? 5.0);
    $enteredTs = portalQaTimestampValue($item, ['uploaded_at', 'qa_submitted_at', 'queued_at', 'created_at', 'date']);
    $batchStart = $enteredTs > 0 ? (int)(floor($enteredTs / 1800) * 1800) : 0;
    $score = round($projectPoints + $rankPoints + $heightPoints, 2);
    return [
        'top_group' => portalQaPriorityGroup($item),
        'batch_start_ms' => $batchStart * 1000,
        'entered_at_ms' => $enteredTs * 1000,
        'error_score' => $score,
        'project_points' => $projectPoints,
        'drafter_rank' => $rank,
        'drafter_rank_points' => $rankPoints,
        'height_quality_points' => round($heightPoints, 2),
        'height_quality_source' => $heightMeta['source'] ?? 'default',
        'height_quality_raw' => $heightMeta['raw'] ?? null,
    ];
}

function portalQaClaimedByEmail($item) {
    return strtolower(trim((string)($item['qa_claimed_by_email'] ?? '')));
}

function portalQaReviewerEmail($item) {
    foreach (['qa_reviewed_by_email', 'qa_reviewed_by', 'qa_approved_by_email', 'qa_approved_by'] as $key) {
        $email = strtolower(trim((string)($item[$key] ?? '')));
        if ($email !== '') return $email;
    }
    return '';
}

function portalQaReviewerName($item) {
    foreach (['qa_approved_by_name', 'qa_reviewed_by_name', 'qa_reviewer_name'] as $key) {
        $name = trim((string)($item[$key] ?? ''));
        if ($name !== '') return $name;
    }
    return portalQaReviewerEmail($item);
}

function portalQaIsTodayTs($raw) {
    $ts = strtotime((string)$raw);
    if ($ts === false) return false;
    return (new DateTimeImmutable('@' . $ts))->setTimezone(fm_leaderboard_pacific_timezone())->format('Y-m-d') === fm_leaderboard_pacific_today();
}

function portalQaApprovalRatesForDate($completedItems, $date = '') {
    $bounds = fm_leaderboard_pacific_day_bounds($date);
    $start = (int)$bounds['start_ts'];
    $end = !empty($bounds['is_today']) ? time() : (int)$bounds['end_ts'];
    $elapsedHours = max(1 / 60, ($end - $start) / 3600);
    $byQa = [];
    foreach (array_values(array_filter((array)$completedItems, 'is_array')) as $item) {
        $at = $item['qa_approved_at'] ?? ($item['qa_reviewed_at'] ?? ($item['completed_at'] ?? ($item['date'] ?? '')));
        $ts = strtotime((string)$at);
        if ($ts === false || $ts < $start || $ts > $end) continue;
        $email = portalQaReviewerEmail($item);
        if ($email === '') continue;
        if (!isset($byQa[$email])) {
            $byQa[$email] = [
                'email' => $email,
                'name' => portalQaReviewerName($item),
                'approved_count' => 0,
                'points' => 0,
                'projects_per_hour' => 0,
                'points_per_hour' => 0,
            ];
        }
        $byQa[$email]['approved_count']++;
        $points = portalQaPointValue($item);
        if ($points <= 0) $points = 1.0;
        $byQa[$email]['points'] += $points;
    }
    foreach ($byQa as &$row) {
        $row['projects_per_hour'] = round($row['approved_count'] / $elapsedHours, 2);
        $row['points'] = round((float)$row['points'], 2);
        $row['points_per_hour'] = round($row['points'] / $elapsedHours, 2);
    }
    unset($row);
    usort($byQa, function($a, $b) {
        if ($a['projects_per_hour'] !== $b['projects_per_hour']) return $b['projects_per_hour'] <=> $a['projects_per_hour'];
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    return array_values($byQa);
}

function portalQaApprovalRatesToday($completedItems) {
    return portalQaApprovalRatesForDate($completedItems, fm_leaderboard_pacific_today());
}

function portalQaCompletedItemsForDate($teamKey, $date = '') {
    $bounds = fm_leaderboard_pacific_day_bounds($date);
    $payload = [
        'statuses' => ['completed'],
        'activity_start' => $bounds['start_iso'],
        'activity_end' => !empty($bounds['is_today']) ? gmdate('c') : $bounds['end_iso'],
        'activity_fields' => ['completed'],
        'include_all' => true,
    ];
    $teamKey = portalQaTeamKey($teamKey);
    if ($teamKey !== 'all') $payload['team'] = $teamKey;
    if (!function_exists('fm_api_json')) return null;
    $res = fm_api_json('POST', 'projects/query', $payload);
    if (!$res['ok'] || !is_array($res['json'])) return null;
    $items = [];
    foreach (array_values(array_filter((array)($res['json']['projects'] ?? []), 'is_array')) as $manifest) {
        $items[] = function_exists('fm_legacy_manifest') ? fm_legacy_manifest($manifest) : $manifest;
    }
    return $items;
}

function portalQaRankApprovalRows($rows) {
    $list = array_values(array_filter((array)$rows, 'is_array'));
    usort($list, function($a, $b) {
        if ((float)($a['points'] ?? 0) !== (float)($b['points'] ?? 0)) return (float)($b['points'] ?? 0) <=> (float)($a['points'] ?? 0);
        if ((int)($a['approved_count'] ?? 0) !== (int)($b['approved_count'] ?? 0)) return (int)($b['approved_count'] ?? 0) <=> (int)($a['approved_count'] ?? 0);
        return strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? ''));
    });
    foreach ($list as $idx => &$row) {
        $row['rank'] = $idx + 1;
        $row['approved_count'] = (int)($row['approved_count'] ?? 0);
        $row['points'] = round((float)($row['points'] ?? 0), 2);
        $row['projects_per_hour'] = round((float)($row['projects_per_hour'] ?? 0), 2);
        $row['points_per_hour'] = round((float)($row['points_per_hour'] ?? 0), 2);
    }
    unset($row);
    return $list;
}

function portalQaLeaderboardForDate($teamKey = 'all', $date = '', $completedItems = null) {
    $teamKey = portalQaTeamKey($teamKey);
    $bounds = fm_leaderboard_pacific_day_bounds($date);
    $date = $bounds['date'];
    $ttl = fm_leaderboard_cache_ttl_for_date($date);
    return fm_leaderboard_cached('qa_day_v4_' . strtolower($teamKey) . '_' . $date, $ttl, function() use ($teamKey, $date, $completedItems, $bounds) {
        $items = $completedItems;
        if (!is_array($items)) {
            if (!empty($bounds['is_today'])) {
                $data = portalQaFetchOverviewCompat($teamKey);
                if (!is_array($data) || !empty($data['error']) || (array_key_exists('success', $data) && empty($data['success']))) {
                    return [
                        'success' => false,
                        'error' => 'Unable to load completed projects for QA leaderboard',
                        'leaderboard' => [],
                        'team' => $teamKey,
                        'date' => $date,
                        'timezone' => $bounds['timezone'],
                    ];
                }
                $items = array_values(array_filter((array)($data['completed_today'] ?? ($data['completed_any'] ?? [])), 'is_array'));
            } else {
                $items = portalQaCompletedItemsForDate($teamKey, $date);
                if (!is_array($items)) {
                    return [
                        'success' => false,
                        'error' => 'Unable to load completed projects for QA leaderboard',
                        'leaderboard' => [],
                        'team' => $teamKey,
                        'date' => $date,
                        'timezone' => $bounds['timezone'],
                    ];
                }
            }
        }
        $rows = portalQaRankApprovalRows(portalQaApprovalRatesForDate($items, $date));
        return [
            'success' => true,
            'leaderboard' => $rows,
            'team' => $teamKey,
            'date' => $date,
            'timezone' => $bounds['timezone'],
            'frozen' => empty($bounds['is_today']),
        ];
    });
}

function portalQaLeaderboardToday($teamKey = 'all', $completedItems = null) {
    return portalQaLeaderboardForDate($teamKey, fm_leaderboard_pacific_today(), $completedItems);
}

function portalQaIsClaimAvailableForUser($item, $email) {
    $email = strtolower(trim((string)$email));
    $claimedBy = portalQaClaimedByEmail($item);
    if ($claimedBy === '' || $claimedBy === $email) return true;
    $availabilityReason = strtolower(trim((string)($item['qa_availability_reason'] ?? '')));
    if ($availabilityReason === 'claimer_offline') return true;
    if (empty($item['hidden_from_queue']) && !empty($item['qa_available'])) return true;
    return false;
}

function portalQaApplyPriorityMeta(array $items) {
    $drafterRanks = portalQaDrafterRankMap();
    usort($items, function($a, $b) use ($drafterRanks) {
        $idA = (string)($a['id'] ?? '');
        $idB = (string)($b['id'] ?? '');
        $groupA = portalQaPriorityGroup($a);
        $groupB = portalQaPriorityGroup($b);
        if ($groupA !== $groupB) return $groupA <=> $groupB;

        $metaA = portalQaRankMeta($a, $drafterRanks);
        $metaB = portalQaRankMeta($b, $drafterRanks);
        if ($metaA['batch_start_ms'] !== $metaB['batch_start_ms']) return $metaA['batch_start_ms'] <=> $metaB['batch_start_ms'];
        if ($metaA['error_score'] !== $metaB['error_score']) return $metaA['error_score'] <=> $metaB['error_score'];
        if ($metaA['entered_at_ms'] !== $metaB['entered_at_ms']) return $metaA['entered_at_ms'] <=> $metaB['entered_at_ms'];

        return strcmp($idA, $idB);
    });

    foreach ($items as $idx => &$item) {
        $group = portalQaPriorityGroup($item);
        $rankMeta = portalQaRankMeta($item, $drafterRanks);
        $item['qa_priority'] = !empty($item['qa_priority']);
        $item['qa_priority_rank'] = $idx + 1;
        $item['qa_priority_group'] = $group;
        $item['qa_priority_bucket'] = portalQaPriorityBucketLabel($group);
        $item['qa_rank'] = $rankMeta;
        $item['qa_error_score'] = $rankMeta['error_score'];
        $item['qa_priority_rank_score'] = $rankMeta['error_score'];
        $item['project_points'] = $rankMeta['project_points'];
        $item['drafter_rank'] = $rankMeta['drafter_rank'];
        $item['drafter_rank_points'] = $rankMeta['drafter_rank_points'];
        $item['height_quality_points'] = $rankMeta['height_quality_points'];
        $item['height_quality_source'] = $rankMeta['height_quality_source'];
        $item['height_quality_raw'] = $rankMeta['height_quality_raw'];
    }
    unset($item);

    return $items;
}

function portalQaReleasePreference($u) {
    if (!is_array($u)) $u = [];
    $pref = is_array($u['qa_release_preference'] ?? null) ? $u['qa_release_preference'] : [];
    $projectId = trim((string)($pref['project_id'] ?? ($u['qa_last_released_project_id'] ?? '')));
    return [
        'project_id' => $projectId,
        'address' => trim((string)($pref['address'] ?? '')),
        'released_at' => trim((string)($pref['released_at'] ?? '')),
    ];
}

function portalQaSetReleasePreference($email, $projectId, $address = '') {
    $email = strtolower(trim((string)$email));
    $projectId = trim((string)$projectId);
    if ($email === '' || $projectId === '') return false;
    $u = portalReadUserDataByEmail($email);
    if (!is_array($u)) return false;
    $u['qa_last_released_project_id'] = $projectId;
    $u['qa_release_preference'] = [
        'project_id' => $projectId,
        'address' => trim((string)$address),
        'released_at' => gmdate('c'),
    ];
    return portalWriteUserDataByEmail($email, $u);
}

function portalQaFetchOverviewCompat($teamKey) {
    $teamKey = portalQaTeamKey($teamKey);
    $payload = [
        'include' => 'qa,pending_rejection,completed_today',
        'view' => 'card',
    ];
    if ($teamKey !== 'all') $payload['team'] = $teamKey;
    $res = fm_api_json('POST', 'queue/admin/overview/compat', $payload);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['success' => false, 'error' => 'Failed to load QA queue'];
    }
    return $res['json'];
}

function portalQaDrafterRankMap() {
    static $cachedMap = null;
    if (is_array($cachedMap)) return $cachedMap;

    $map = [];
    foreach (portalListNodeInternalUsers(false) as $u) {
        if (!is_array($u)) continue;
        if (!isEmployeeUserData($u)) continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        if ($email === '') continue;
        $rank = strtolower(trim((string)($u['drafter_rank'] ?? 'junior')));
        if (!in_array($rank, ['junior', 'standard', 'senior'], true)) $rank = 'junior';
        $map[$email] = $rank;
    }
    $cachedMap = $map;
    return $cachedMap;
}

function portalQaRankedQueueFromApi($teamKey, $live = false, $limit = 500) {
    $teamKey = portalQaTeamKey($teamKey);
    $payload = [
        'team' => $teamKey === 'all' ? null : $teamKey,
        'limit' => $limit,
        'live' => $live ? true : false,
        'release_stale' => false,
        'drafter_ranks' => portalQaDrafterRankMap(),
        'actor' => fm_current_actor(),
    ];
    $res = fm_api_json('POST', 'qa/queue/peek', $payload);
    if (!$res['ok'] || !is_array($res['json']) || empty($res['json']['success'])) return null;
    return array_values(array_filter((array)($res['json']['projects'] ?? []), 'is_array'));
}

function portalQaMergeRankedQueueMeta($pending, $ranked) {
    $pending = array_values(array_filter((array)$pending, 'is_array'));
    $ranked = array_values(array_filter((array)$ranked, 'is_array'));
    if (empty($ranked)) return portalQaApplyPriorityMeta($pending);
    $drafterRanks = portalQaDrafterRankMap();

    $byId = [];
    foreach ($pending as $item) {
        $id = trim((string)($item['id'] ?? ''));
        if ($id !== '') $byId[$id] = $item;
    }

    $out = [];
    $seen = [];
    foreach ($ranked as $idx => $rankedItem) {
        $id = trim((string)($rankedItem['id'] ?? ''));
        if ($id === '' || !isset($byId[$id])) continue;
        $merged = array_merge($byId[$id], $rankedItem);
        $merged['qa_priority_rank'] = $idx + 1;
        $merged['qa_priority'] = !empty($merged['qa_priority']);
        $out[] = $merged;
        $seen[$id] = true;
    }

    foreach ($pending as $item) {
        $id = trim((string)($item['id'] ?? ''));
        if ($id !== '' && isset($seen[$id])) continue;
        $out[] = $item;
    }

    foreach ($out as $idx => &$item) {
        if (empty($item['qa_priority_rank'])) $item['qa_priority_rank'] = $idx + 1;
        if (!isset($item['qa_rank']) || !is_array($item['qa_rank']) || !isset($item['qa_error_score'])) {
            $rankMeta = portalQaRankMeta($item, $drafterRanks);
            $item['qa_rank'] = $rankMeta;
            $item['qa_error_score'] = $rankMeta['error_score'];
            $item['qa_priority_rank_score'] = $rankMeta['error_score'];
            $item['project_points'] = $rankMeta['project_points'];
            $item['drafter_rank'] = $rankMeta['drafter_rank'];
            $item['drafter_rank_points'] = $rankMeta['drafter_rank_points'];
            $item['height_quality_points'] = $rankMeta['height_quality_points'];
            $item['height_quality_source'] = $rankMeta['height_quality_source'];
            $item['height_quality_raw'] = $rankMeta['height_quality_raw'];
        }
    }
    unset($item);
    return $out;
}

function portalQaBuildSnapshot($userData, $perms, $teamKey) {
    $teamKey = portalQaTeamKey($teamKey);
    $data = portalQaFetchOverviewCompat($teamKey);
    if (!is_array($data) || !empty($data['error']) || (array_key_exists('success', $data) && !$data['success'])) {
        return [
            'success' => false,
            'error' => (string)($data['error'] ?? 'Failed to load QA queue'),
        ];
    }

    $qaItems = array_values(array_filter((array)($data['qa'] ?? []), 'is_array'));
    $rejectedItems = array_values(array_filter((array)($data['rejected'] ?? []), 'is_array'));
    $completedAny = array_values(array_filter((array)($data['completed_today'] ?? ($data['completed_any'] ?? [])), 'is_array'));

    $pending = array_merge(
        array_values(array_filter($qaItems, function($item) {
            return strtolower(trim((string)($item['status'] ?? ''))) === 'awaiting_review';
        })),
        array_values(array_filter($rejectedItems, function($item) {
            return strtolower(trim((string)($item['status'] ?? ''))) === 'pending_rejection';
        }))
    );

    $pendingIds = [];
    foreach ($pending as $item) {
        $id = trim((string)($item['id'] ?? ''));
        if ($id !== '') $pendingIds[$id] = true;
    }
    foreach ($completedAny as $item) {
        $status = strtolower(trim((string)($item['status'] ?? '')));
        $id = trim((string)($item['id'] ?? ''));
        if ($id === '' || isset($pendingIds[$id])) continue;
        if (in_array($status, ['awaiting_review', 'pending_rejection'], true)) {
            $pending[] = $item;
            $pendingIds[$id] = true;
        }
    }

    $rankedQueue = portalQaRankedQueueFromApi($teamKey, portalCanManageQaQueue($userData, $perms) || portalCanManagerReview($userData, $perms));
    $pending = portalQaMergeRankedQueueMeta($pending, $rankedQueue);

    $email = strtolower(trim((string)($userData['email'] ?? ($_SESSION['user_email'] ?? ''))));
    $canManageQaView = portalCanManageQaQueue($userData, $perms) || portalCanManagerReview($userData, $perms);
    if (!$canManageQaView) {
        $pending = array_values(array_filter($pending, function($item) use ($email) {
            return portalQaCanViewerAccessReturnRoutedItem($item, $email, false);
        }));
        $pending = portalQaPreferReturnRoutedForViewer($pending, $email);
    }

    $claimedByMe = [];
    foreach ($pending as $item) {
        if (portalQaClaimedByEmail($item) === $email) $claimedByMe[] = $item;
    }

    $preferred = portalQaReleasePreference($userData);
    $preferredItem = null;
    if ($preferred['project_id'] !== '') {
        foreach ($pending as $item) {
            if ((string)($item['id'] ?? '') !== $preferred['project_id']) continue;
            if (portalQaIsClaimAvailableForUser($item, $email)) {
                $preferredItem = $item;
            }
            break;
        }
    }

    $nextCandidate = null;
    if (!empty($claimedByMe)) {
        $nextCandidate = $claimedByMe[0];
    } elseif ($preferredItem) {
        $nextCandidate = $preferredItem;
    } else {
        foreach ($pending as $item) {
            if (portalQaIsClaimAvailableForUser($item, $email)) {
                $nextCandidate = $item;
                break;
            }
        }
    }

    $mineToday = array_values(array_filter($completedAny, function($item) use ($email) {
        return $email !== '' && portalQaReviewerEmail($item) === $email && portalQaIsTodayTs($item['completed_at'] ?? ($item['date'] ?? ''));
    }));

    $canSeeTechnicianIdentity = portalCanManagerReview($userData, $perms);
    if (!$canSeeTechnicianIdentity) {
        $pending = portalQaBlindIdentityList($pending, $email);
        $completedAny = portalQaBlindIdentityList($completedAny, $email);
    }

    $qaLeaderboardToday = portalQaLeaderboardToday($teamKey, $completedAny);

    $stats = [
        'claimed_count' => count($claimedByMe),
        'reviewed_today_count' => count($mineToday),
        'qa_rates_today' => $canSeeTechnicianIdentity ? array_values(array_filter((array)($qaLeaderboardToday['leaderboard'] ?? []), 'is_array')) : [],
        'qa_leaderboard_today' => $qaLeaderboardToday,
        'preferred_project_id' => $preferred['project_id'],
        'preferred_project_address' => $preferred['address'],
        'preferred_project_available' => $preferredItem ? true : false,
        'next_candidate_id' => $nextCandidate['id'] ?? null,
        'next_candidate_address' => $nextCandidate['address'] ?? null,
    ];

    return [
        'success' => true,
        'can_manage_queue' => portalCanManageQaQueue($userData, $perms),
        'can_do_qa' => portalCanDoQa($userData, $perms),
        'can_manager_review' => portalCanManagerReview($userData, $perms),
        'pending' => $pending,
        'history' => $completedAny,
        'manager' => portalCanManagerReview($userData, $perms)
            ? array_values(array_filter($qaItems, function($item) {
                return strtolower(trim((string)($item['status'] ?? ''))) === 'awaiting_manager_review';
            }))
            : [],
        'manager_history' => portalCanManagerReview($userData, $perms)
            ? array_values(array_filter($completedAny, function($item) {
                return !empty($item['is_vip']) && (!empty($item['manager_approved_by']) || !empty($item['manager_approved_by_name']));
            }))
            : [],
        'stats' => $stats,
        'manual_top_ids' => array_values(array_map(function($item) {
            return (string)($item['id'] ?? '');
        }, array_values(array_filter($pending, function($item) {
            return !empty($item['qa_priority']);
        })))),
        'team' => $teamKey,
    ];
}

function portalQaProjectId($item) {
    if (!is_array($item)) return '';
    foreach (['id', 'folder', 'project_id'] as $key) {
        $value = trim((string)($item[$key] ?? ''));
        if ($value !== '') return $value;
    }
    return '';
}

function portalQaActorFromUser($userData) {
    $actor = fm_current_actor();
    $email = strtolower(trim((string)($actor['email'] ?? ($userData['email'] ?? ($_SESSION['user_email'] ?? '')))));
    $name = trim((string)($actor['name'] ?? ($userData['name'] ?? ($_SESSION['user_name'] ?? $email))));
    if ($name === '') $name = $email;
    $actor['email'] = $email;
    $actor['name'] = $name;
    return $actor;
}

function portalQaRankedReturnItem($item) {
    $ranked = portalQaApplyPriorityMeta([is_array($item) ? $item : []]);
    return $ranked[0] ?? $item;
}

function portalQaClaimProjectLocal($item, $actor, $source = 'portal_fallback') {
    $projectId = portalQaProjectId($item);
    if ($projectId === '') {
        return ['success' => false, 'error' => 'Project is required'];
    }
    $actorEmail = strtolower(trim((string)($actor['email'] ?? '')));
    $actorName = trim((string)($actor['name'] ?? $actorEmail));
    if ($actorEmail === '') {
        return ['success' => false, 'error' => 'A QA actor email is required'];
    }

    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) $manifest = is_array($item) ? $item : [];

    $status = strtolower(trim((string)($manifest['status'] ?? ($item['status'] ?? ''))));
    if (!in_array($status, ['awaiting_review', 'pending_rejection'], true)) {
        return ['success' => false, 'error' => 'Project is no longer in the QA queue', 'status' => $status];
    }

    $claimedBy = portalQaClaimedByEmail($manifest);
    if ($claimedBy === '') $claimedBy = portalQaClaimedByEmail($item);
    if ($claimedBy !== '' && $claimedBy !== $actorEmail && !portalQaIsClaimAvailableForUser($manifest + $item, $actorEmail)) {
        return [
            'success' => false,
            'error' => 'item_claimed_by_other_user',
            'claimed_by' => $claimedBy,
            'claimed_by_name' => $manifest['qa_claimed_by_name'] ?? ($item['qa_claimed_by_name'] ?? $claimedBy),
        ];
    }

    $nowIso = gmdate('c');
    $workflow = is_array($manifest['workflow'] ?? null) ? $manifest['workflow'] : [];
    $existingQaClaim = is_array($workflow['qa_claim'] ?? null) ? $workflow['qa_claim'] : [];
    $existingClaimedAt = trim((string)($manifest['qa_claimed_at'] ?? ($existingQaClaim['claimed_at'] ?? '')));
    $sameClaim = $claimedBy === $actorEmail && $existingClaimedAt !== '';
    $claimedAt = $sameClaim ? $existingClaimedAt : $nowIso;
    $workHistory = portalProjectWorkHistory($manifest);
    if (!$sameClaim) {
        $workHistory[] = [
            'ts' => $nowIso,
            'event' => 'qa_claimed',
            'qa_email' => $actorEmail,
            'qa_name' => $actorName ?: $actorEmail,
            'source' => $source,
        ];
    }

    $workflow['qa_claim'] = [
        'email' => $actorEmail,
        'name' => $actorName ?: $actorEmail,
        'claimed_at' => $claimedAt,
    ];
    if (!empty($actor['id'])) $workflow['qa_claim']['id'] = (string)$actor['id'];
    $workflow['history'] = $workHistory;

    $timestamps = is_array($manifest['timestamps'] ?? null) ? $manifest['timestamps'] : [];
    $timestamps['qa_claimed_at'] = $claimedAt;
    $timestamps['updated_at'] = $nowIso;

    $updated = fm_project_patch($projectId, [
        'qa_claimed_by_email' => $actorEmail,
        'qa_claimed_by_name' => $actorName ?: $actorEmail,
        'qa_claimed_at' => $claimedAt,
        'qa_available' => false,
        'qa_availability_reason' => 'claimed',
        'hidden_from_queue' => true,
        'work_history' => $workHistory,
        'workflow' => $workflow,
        'timestamps' => $timestamps,
    ]);
    if (!is_array($updated)) {
        return ['success' => false, 'error' => 'Failed to claim QA project'];
    }
    $updated = array_merge(is_array($item) ? $item : [], $updated);
    $updated['id'] = portalQaProjectId($updated) ?: $projectId;
    return ['success' => true, 'project' => portalQaRankedReturnItem($updated)];
}

function portalQaReleaseClaimLocal($projectId, $actor, $reason = 'manual', $allowOther = false) {
    $projectId = trim((string)$projectId);
    if ($projectId === '') return ['success' => false, 'error' => 'Project is required'];
    $actorEmail = strtolower(trim((string)($actor['email'] ?? '')));
    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) return ['success' => false, 'error' => 'Project not found'];

    $claimedBy = portalQaClaimedByEmail($manifest);
    if ($claimedBy !== '' && $actorEmail !== '' && $claimedBy !== $actorEmail && !$allowOther) {
        return ['success' => false, 'error' => 'claim_owned_by_other_user', 'claimed_by' => $claimedBy];
    }

    $workHistory = portalProjectWorkHistory($manifest);
    if ($claimedBy !== '') {
        $workHistory[] = [
            'ts' => gmdate('c'),
            'event' => 'qa_claim_released',
            'previous_claimer' => $claimedBy,
            'released_by' => $actorEmail ?: null,
            'reason' => trim((string)$reason) ?: 'manual',
            'source' => 'portal_fallback',
        ];
    }
    $workflow = is_array($manifest['workflow'] ?? null) ? $manifest['workflow'] : [];
    $workflow['qa_claim'] = null;
    $workflow['history'] = $workHistory;
    $timestamps = is_array($manifest['timestamps'] ?? null) ? $manifest['timestamps'] : [];
    $timestamps['qa_claimed_at'] = null;
    $timestamps['updated_at'] = gmdate('c');

    $updated = fm_project_patch($projectId, [
        'qa_claimed_by_email' => null,
        'qa_claimed_by_name' => null,
        'qa_claimed_at' => null,
        'qa_available' => true,
        'qa_availability_reason' => null,
        'hidden_from_queue' => false,
        'work_history' => $workHistory,
        'workflow' => $workflow,
        'timestamps' => $timestamps,
    ]);
    return ['success' => is_array($updated), 'project' => $updated, 'error' => is_array($updated) ? null : 'Failed to release QA claim'];
}

function portalQaGrabNextFallback($userData, $perms, $teamKey, $count = 2) {
    $actor = portalQaActorFromUser($userData);
    $email = strtolower(trim((string)($actor['email'] ?? '')));
    if ($email === '') return ['success' => false, 'error' => 'A QA actor email is required'];

    $snapshot = portalQaBuildSnapshot($userData, $perms, $teamKey);
    if (empty($snapshot['success'])) {
        return ['success' => false, 'error' => (string)($snapshot['error'] ?? 'Failed to load QA queue')];
    }

    $pending = array_values(array_filter((array)($snapshot['pending'] ?? []), 'is_array'));
    $claimed = [];
    $available = [];
    foreach ($pending as $item) {
        $id = portalQaProjectId($item);
        if ($id === '') continue;
        $claimedBy = portalQaClaimedByEmail($item);
        if ($claimedBy === $email) {
            $claimed[] = portalQaRankedReturnItem($item);
            continue;
        }
        if (portalQaIsClaimAvailableForUser($item, $email)) {
            $available[] = $item;
        }
    }

    $target = max(1, min(4, (int)$count));
    $reserved = [];
    $seen = [];
    foreach ($claimed as $item) {
        $id = portalQaProjectId($item);
        if ($id === '' || isset($seen[$id])) continue;
        $reserved[] = $item;
        $seen[$id] = true;
        if (count($reserved) >= $target) break;
    }

    foreach ($available as $item) {
        if (count($reserved) >= $target) break;
        $id = portalQaProjectId($item);
        if ($id === '' || isset($seen[$id])) continue;
        $claimedResult = portalQaClaimProjectLocal($item, $actor, 'portal_queue_fallback');
        if (!empty($claimedResult['success']) && is_array($claimedResult['project'] ?? null)) {
            $reserved[] = $claimedResult['project'];
            $seen[$id] = true;
        }
    }

    if (empty($reserved)) {
        return ['success' => false, 'error' => 'No QA project is available right now.'];
    }
    if (!portalCanManagerReview($userData, $perms)) {
        $reserved = portalQaBlindIdentityList($reserved, $email);
    }
    return [
        'success' => true,
        'folder' => portalQaProjectId($reserved[0]),
        'project' => $reserved[0],
        'reserved_projects' => array_values($reserved),
        'reused_existing' => !empty($claimed),
        'queue_source' => 'portal_fallback',
    ];
}

function portalQaReleaseAllClaimsFallback($userData, $perms, $teamKey, $reason = 'manual') {
    $actor = portalQaActorFromUser($userData);
    $email = strtolower(trim((string)($actor['email'] ?? '')));
    if ($email === '') return ['success' => false, 'released' => 0, 'error' => 'A QA actor email is required'];
    $snapshot = portalQaBuildSnapshot($userData, $perms, $teamKey);
    if (empty($snapshot['success'])) return ['success' => false, 'released' => 0, 'error' => (string)($snapshot['error'] ?? 'Failed to load QA queue')];
    $released = 0;
    foreach (array_values(array_filter((array)($snapshot['pending'] ?? []), 'is_array')) as $item) {
        if (portalQaClaimedByEmail($item) !== $email) continue;
        $id = portalQaProjectId($item);
        if ($id === '') continue;
        $res = portalQaReleaseClaimLocal($id, $actor, $reason, false);
        if (!empty($res['success'])) $released++;
    }
    return ['success' => true, 'released' => $released];
}

// --- APPLE KEY STORE HELPERS (JSON) ---
function appleKeyFilePath() {
    global $APPLE_KEY_PATH;
    return $APPLE_KEY_PATH;
}

function appleKeyCandidatePaths() {
    $publicRoot = dirname(__DIR__, 2);
    $paths = [
        appleKeyFilePath(),
        $publicRoot . '/storage/measure/internal/config/apple_key.json',
        $publicRoot . '/v1/storage/firstmeasure/apple_key.json',
        $publicRoot . '/v1/storage/internal/state/config/apple_key.json',
    ];

    $out = [];
    foreach ($paths as $path) {
        $path = (string)$path;
        if ($path === '' || isset($out[$path])) continue;
        $out[$path] = $path;
    }
    return array_values($out);
}

function appleKeyWritableMirrorPaths() {
    $publicRoot = dirname(__DIR__, 2);
    $paths = [
        appleKeyFilePath(),
        $publicRoot . '/v1/storage/firstmeasure/apple_key.json',
    ];

    $out = [];
    foreach ($paths as $path) {
        $path = (string)$path;
        if ($path === '' || isset($out[$path])) continue;
        $out[$path] = $path;
    }
    return array_values($out);
}

function appleKeyNormalizeStore($data) {
    global $APPLE_MAPS_DEFAULT_TILE_VERSION;
    if (!is_array($data)) $data = [];
    $source = (isset($data['data']) && is_array($data['data'])) ? $data['data'] : $data;
    $key = isset($source['key']) && is_string($source['key']) ? trim($source['key']) : '';
    $updated = isset($source['updated_at_utc']) && is_string($source['updated_at_utc'])
        ? trim($source['updated_at_utc'])
        : null;
    $tileVersion = filter_var($source['tile_version'] ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1, 'max_range' => 999999999]
    ]);

    return [
        'key' => $key,
        'updated_at_utc' => ($updated !== '') ? $updated : null,
        'tile_version' => ($tileVersion !== false) ? $tileVersion : $APPLE_MAPS_DEFAULT_TILE_VERSION
    ];
}

function appleKeyReadStoreAt($path) {
    global $APPLE_MAPS_DEFAULT_TILE_VERSION;
    if (!is_string($path) || $path === '' || !file_exists($path)) {
        return [ 'key' => '', 'updated_at_utc' => null, 'tile_version' => $APPLE_MAPS_DEFAULT_TILE_VERSION ];
    }
    $raw = @file_get_contents($path);
    $data = json_decode($raw ?: '{}', true);
    return appleKeyNormalizeStore($data);
}

function appleKeyEnsureStore() {
    global $APPLE_MAPS_DEFAULT_TILE_VERSION;
    $path = appleKeyFilePath();
    if (!file_exists($path)) {
        $init = [ 'key' => '', 'updated_at_utc' => null, 'tile_version' => $APPLE_MAPS_DEFAULT_TILE_VERSION ];
        @file_put_contents($path, json_encode($init, JSON_PRETTY_PRINT));
        return $init;
    }
    $raw = @file_get_contents($path);
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) $data = [];
    if (!array_key_exists('key', $data)) $data['key'] = '';
    if (!array_key_exists('updated_at_utc', $data)) $data['updated_at_utc'] = null;
    if (!array_key_exists('tile_version', $data)) $data['tile_version'] = $APPLE_MAPS_DEFAULT_TILE_VERSION;
    if (!is_string($data['key'])) $data['key'] = '';
    if (!is_null($data['updated_at_utc']) && !is_string($data['updated_at_utc'])) $data['updated_at_utc'] = null;
    return appleKeyNormalizeStore($data);
}

function appleKeyGetInfo() {
    $s = null;
    foreach (appleKeyCandidatePaths() as $path) {
        $candidate = appleKeyReadStoreAt($path);
        if (trim((string)($candidate['key'] ?? '')) !== '') {
            $s = $candidate;
            break;
        }
    }
    if ($s === null) {
        $s = appleKeyEnsureStore();
    }
    $k = trim((string)($s['key'] ?? ''));
    $ts = $s['updated_at_utc'] ?? null;
    $ts = is_string($ts) ? trim($ts) : null;

    return [
        'key' => ($k !== '') ? $k : null,
        'updated_at_utc' => ($ts !== '') ? $ts : null,
        'tile_version' => $s['tile_version']
    ];
}

function appleKeySet($newKey) {
    $newKey = trim((string)$newKey);
    if ($newKey === '') return false;

    $path = appleKeyFilePath();
    $nowUtc = gmdate('c');
    $existing = appleKeyGetInfo();

    $data = [
        'key' => $newKey,
        'updated_at_utc' => $nowUtc,
        'tile_version' => $existing['tile_version']
    ];

    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) return false;

    $ok = (@file_put_contents($path, $json) !== false);
    if (!$ok) return false;

    foreach (appleKeyWritableMirrorPaths() as $candidatePath) {
        if ($candidatePath === $path || !file_exists($candidatePath)) continue;
        $existing = appleKeyReadStoreAt($candidatePath);
        if (trim((string)($existing['key'] ?? '')) === '') continue;
        @file_put_contents($candidatePath, $json);
    }

    return true;
}

function appleTileVersionSet($newVersion) {
    $version = filter_var($newVersion, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1, 'max_range' => 999999999]
    ]);
    if ($version === false) return false;

    $existing = appleKeyGetInfo();
    $data = [
        'key' => trim((string)($existing['key'] ?? '')),
        'updated_at_utc' => $existing['updated_at_utc'] ?? null,
        'tile_version' => $version
    ];
    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false || @file_put_contents(appleKeyFilePath(), $json) === false) return false;

    foreach (appleKeyWritableMirrorPaths() as $candidatePath) {
        if ($candidatePath === appleKeyFilePath() || !file_exists($candidatePath)) continue;
        @file_put_contents($candidatePath, $json);
    }
    return true;
}

function portalStatusNormalizeStatus($status) {
    $value = strtolower(trim((string)$status));
    if ($value === '') return '';
    return preg_replace('/\s+/', '_', $value);
}

function portalProjectWorkHistory($manifest) {
    $manifest = is_array($manifest) ? $manifest : [];
    if (!empty($manifest['work_history']) && is_array($manifest['work_history'])) {
        return array_values($manifest['work_history']);
    }
    if (!empty($manifest['workflow']['history']) && is_array($manifest['workflow']['history'])) {
        return array_values($manifest['workflow']['history']);
    }
    return [];
}

function portalNormalizeStructureReorderProjectType($value) {
    $type = strtolower(trim((string)$value));
    $type = str_replace(['_', ' '], '-', $type);
    if ($type === 'multi-family' || $type === 'multifamily') return 'multifamily';
    if ($type === 'commercial') return 'commercial';
    return '';
}

function portalProjectTypeLabelForCustomer($value) {
    $type = portalNormalizeStructureReorderProjectType($value);
    if ($type === 'multifamily') return 'multi-family';
    if ($type === 'commercial') return 'commercial';
    return 'residential';
}

function portalBuildStructureReorderPayload($projectId, $manifest, $correctProjectType) {
    $projectId = trim((string)$projectId);
    $manifest = is_array($manifest) ? $manifest : [];
    $correctProjectType = portalNormalizeStructureReorderProjectType($correctProjectType);
    if (!in_array($correctProjectType, ['commercial', 'multifamily'], true)) return null;

    $prefill = [
        'source_project_id' => $projectId,
        'project_type' => $correctProjectType,
    ];
    foreach ([
        'address',
        'lat',
        'lng',
        'pins',
        'radius_meters',
        'report_mode',
        'include_gutter_measurements',
        'report_expedite_option',
        'cc_emails',
        'branding_defaults',
        'metadata',
    ] as $key) {
        if (array_key_exists($key, $manifest) && $manifest[$key] !== null && $manifest[$key] !== '') {
            $prefill[$key] = $manifest[$key];
        }
    }

    $query = [
        'reorder_project_id' => $projectId,
        'source_project_id' => $projectId,
        'project_type' => $correctProjectType,
        'prefill' => 'previous_order',
        'prefill_data' => json_encode($prefill),
    ];
    foreach (['address', 'lat', 'lng', 'report_mode', 'include_gutter_measurements', 'report_expedite_option'] as $key) {
        if (isset($prefill[$key]) && $prefill[$key] !== '') $query[$key] = $prefill[$key];
    }
    $url = 'https://app.1m8.ai/portal?' . http_build_query($query);
    return [
        'source_project_id' => $projectId,
        'project_type' => $correctProjectType,
        'project_type_label' => portalProjectTypeLabelForCustomer($correctProjectType),
        'url' => $url,
        'prefill' => $prefill,
    ];
}

function portalRejectedProjectRefund($projectId, $manifest, $actorEmail = '', $actorName = '', $source = 'portal_review_rejection') {
    $manifest = is_array($manifest) ? $manifest : [];
    $projectId = trim((string)$projectId);
    $actorEmail = strtolower(trim((string)$actorEmail));
    $actorName = trim((string)$actorName);

    $existingRefundAmount = max(0, portalCreditAmount($manifest['refund_amount'] ?? 0));
    if (!empty($manifest['refund_issued'])) {
        return [
            'ok' => true,
            'already_refunded' => true,
            'refunded' => $existingRefundAmount,
            'refund_amount' => $existingRefundAmount,
            'refund_scope' => strtolower(trim((string)($manifest['refund_scope'] ?? ''))),
            'refund_to_email' => strtolower(trim((string)($manifest['refund_to_email'] ?? ''))),
            'refund_to_organization_id' => portalNormalizeOrganizationId($manifest['refund_to_organization_id'] ?? ''),
            'refund_at' => $manifest['refund_at'] ?? null,
            'refund_by' => $manifest['refund_by'] ?? null,
            'refund_by_name' => $manifest['refund_by_name'] ?? null,
        ];
    }

    if (!empty($manifest['is_filler'])) {
        return [
            'ok' => true,
            'skipped' => true,
            'refund_amount' => 0,
        ];
    }

    $rawAmountCharged = $manifest['amount_charged'] ?? null;
    $refundAmount = max(0, portalCreditAmount($rawAmountCharged));
    if ($refundAmount <= 0) {
        $projectType = strtolower(trim((string)($manifest['project_type'] ?? 'residential')));
        if (!in_array($projectType, ['residential', 'commercial', 'multifamily'], true)) $projectType = 'residential';
        $fallbackAmount = max(0, portalCreditAmount(projectTypePrice($projectType)));
        $hasUsableChargedAmount = ($rawAmountCharged !== null && is_numeric($rawAmountCharged) && (float)$rawAmountCharged > 0);
        if ($fallbackAmount > 0 && !$hasUsableChargedAmount) {
            $refundAmount = $fallbackAmount;
        }
    }

    if ($refundAmount <= 0) {
        return [
            'ok' => true,
            'skipped' => true,
            'refund_amount' => 0,
        ];
    }

    $ownerRef = is_array($manifest['owner_ref'] ?? null) ? $manifest['owner_ref'] : [];
    $issuer = is_array($manifest['issuer'] ?? null) ? $manifest['issuer'] : [];
    $ownerEmail = strtolower(trim((string)($manifest['owner_email'] ?? '')));
    if ($ownerEmail === '') $ownerEmail = strtolower(trim((string)($ownerRef['email'] ?? '')));
    if ($ownerEmail === '') $ownerEmail = strtolower(trim((string)($issuer['email'] ?? '')));

    $organizationId = portalNormalizeOrganizationId($manifest['organization_id'] ?? '');
    $projectType = strtolower(trim((string)($manifest['project_type'] ?? 'residential')));
    if (!in_array($projectType, ['residential', 'commercial', 'multifamily'], true)) $projectType = 'residential';

    $refundMeta = [
        'project_id' => $projectId !== '' ? $projectId : (string)($manifest['id'] ?? ''),
        'address' => (string)($manifest['address'] ?? ''),
        'project_type' => $projectType,
        'pin_count' => max(1, count(is_array($manifest['pins'] ?? null) ? $manifest['pins'] : [])),
        'source' => (string)$source,
        'rejected_by_email' => $actorEmail !== '' ? $actorEmail : null,
        'rejected_by_name' => $actorName !== '' ? $actorName : null,
        'organization_id' => $organizationId !== '' ? $organizationId : null,
    ];

    $refundResult = null;
    $refundScope = null;
    $refundTargetEmail = $ownerEmail !== '' ? $ownerEmail : null;
    if ($organizationId !== '') {
        $refundScope = 'org';
        $refundResult = portalRefundCreditsByOrganizationId($organizationId, $refundAmount, 'rejection_refund', $refundMeta, $ownerEmail);
        $refundTargetEmail = $refundResult['applied_for_user_email'] ?? ($ownerEmail !== '' ? $ownerEmail : null);
    } else {
        if ($ownerEmail === '') {
            return ['ok' => false, 'error' => 'This project does not have an associated organization or customer email available for refund'];
        }
        $refundScope = 'user';
        $refundResult = portalRefundCreditsByEmail($ownerEmail, $refundAmount, 'rejection_refund', $refundMeta);
    }

    if (empty($refundResult['ok'])) {
        return ['ok' => false, 'error' => $refundResult['error'] ?? 'Refund failed'];
    }

    return [
        'ok' => true,
        'refunded' => portalCreditAmount($refundResult['refunded'] ?? $refundAmount),
        'refund_amount' => $refundAmount,
        'refund_scope' => $refundScope,
        'refund_to_email' => $refundTargetEmail,
        'refund_to_organization_id' => $organizationId !== '' ? $organizationId : null,
        'refund_at' => gmdate('Y-m-d H:i:s'),
        'refund_by' => $actorEmail !== '' ? $actorEmail : null,
        'refund_by_name' => $actorName !== '' ? $actorName : null,
        'new_balance' => portalCreditAmount($refundResult['new_balance'] ?? 0),
    ];
}

function portalCanReopenCompletedProject($u, $perms = null) {
    if (!is_array($u)) $u = [];
    if (!is_array($perms)) $perms = $u['permissions'] ?? [];
    return portalUserRole($u) === 'admin'
        || !empty($u['is_admin'])
        || !empty($perms['is_admin_legacy']);
}

// --- API HANDLER (portal-only endpoints) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';
    header('Content-Type: application/json');

    if (in_array($action, ['feature_flags_bootstrap', 'feature_flags_search', 'feature_flags_org', 'feature_flags_save_org', 'feature_flags_rollout', 'feature_flags_rollout_plan', 'feature_flags_rollout_batch', 'feature_flags_variant_rollout', 'feature_flags_save_defaults'], true)) {
        if (!portalCanManageFeatureRollouts($myUserData, $myPerms)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
    }

    if ($action === 'feature_flags_bootstrap') {
        $definitions = portalFeatureFlagDefinitions();
        $summary = array_fill_keys(array_map(function($definition) {
            return $definition['key'];
        }, $definitions), ['enabled' => 0, 'raw_enabled' => 0]);
        $total = 0;
        foreach (portalFeatureFlagAllOrgIds() as $orgId) {
            $org = portalFeatureFlagReadOrgRecord($orgId);
            if (!$org) continue;
            $total++;
            $resolved = portalFeatureFlagResolve($org['flags']);
            foreach ($definitions as $definition) {
                $key = $definition['key'];
                $rawEnabled = (($org['flags'][$definition['group']][$definition['flag']] ?? false) !== false);
                if ($rawEnabled) $summary[$key]['raw_enabled']++;
                if (!empty($resolved['resolved_by_key'][$key])) $summary[$key]['enabled']++;
            }
        }
        echo json_encode([
            'success' => true,
            'definitions' => $definitions,
            'variant_definitions' => portalFeatureVariantDefinitions(),
            'defaults' => portalFeatureFlagDefaults(),
            'new_user_defaults' => portalFeatureFlagReadDefaultRecord(),
            'total_orgs' => $total,
            'summary' => $summary,
        ]);
        exit;
    }

    if ($action === 'feature_flags_save_defaults') {
        $flags = json_decode((string)($_POST['flags'] ?? '{}'), true);
        if (!is_array($flags)) die(json_encode(['success' => false, 'error' => 'Invalid defaults payload']));
        $saveResult = portalFeatureFlagSaveDefaultRecordDetailed($flags, $currentUserEmail);
        if (empty($saveResult['success'])) {
            $details = trim((string)($saveResult['error'] ?? ''));
            $message = 'Could not write new user defaults';
            if ($details !== '') $message .= ': ' . $details;
            die(json_encode(['success' => false, 'error' => $message]));
        }
        echo json_encode([
            'success' => true,
            'new_user_defaults' => portalFeatureFlagReadDefaultRecord(),
        ]);
        exit;
    }

    if ($action === 'feature_flags_search') {
        $query = trim((string)($_POST['query'] ?? ''));
        $status = trim((string)($_POST['status'] ?? ''));
        $requestedLimit = strtolower(trim((string)($_POST['limit'] ?? '25')));
        $limit = $requestedLimit === 'all' ? 500 : max(1, min(500, (int)$requestedLimit));
        $page = max(1, (int)($_POST['page'] ?? 1));
        $flagKey = trim((string)($_POST['flag_key'] ?? ''));
        $flagState = trim((string)($_POST['flag_state'] ?? ''));
        $variantFamily = trim((string)($_POST['variant_family'] ?? ''));
        $variantState = trim((string)($_POST['variant_state'] ?? ''));
        $filtered = portalFeatureFlagFilteredOrgs($query, $status, $limit, $limit > 0 ? (($page - 1) * $limit) : 0, $flagKey, $flagState, $variantFamily, $variantState);
        echo json_encode([
            'success' => true,
            'total' => $filtered['total'],
            'page' => $page,
            'limit' => $limit,
            'organizations' => array_map('portalFeatureFlagOrgSummary', $filtered['items']),
        ]);
        exit;
    }

    if ($action === 'feature_flags_rollout_plan') {
        $payload = portalFeatureFlagRolloutPayload();
        if (empty($payload['success'])) die(json_encode($payload));

        $matchedIds = portalFeatureFlagFilteredOrgIds(
            $payload['query'],
            $payload['status'],
            $payload['filter_flag_key'],
            $payload['filter_flag_state'],
            $payload['filter_variant_family'],
            $payload['filter_variant_state']
        );
        $selectedMap = $payload['mode'] === 'all'
            ? portalFeatureFlagStableCohortIdMap($matchedIds, 100, 'rollout:' . implode(',', $payload['keys']))
            : portalFeatureFlagStableCohortIdMap($matchedIds, $payload['percent'], 'rollout:' . implode(',', $payload['keys']));
        $selectedIds = [];
        foreach ($matchedIds as $orgId) {
            if (!empty($selectedMap[$orgId])) $selectedIds[] = $orgId;
        }

        $preview = [];
        foreach (array_slice($selectedIds, 0, 12) as $orgId) {
            $org = portalFeatureFlagReadOrgRecord($orgId);
            $preview[] = [
                'id' => $orgId,
                'name' => $org['name'] ?? $orgId,
                'selected' => true,
            ];
        }

        echo json_encode([
            'success' => true,
            'matched' => count($matchedIds),
            'selected' => count($selectedIds),
            'org_ids' => $selectedIds,
            'batch_size' => 100,
            'flag_actions' => $payload['flag_actions'],
            'preview' => $preview,
            'message' => 'Rollout plan ready.',
        ]);
        exit;
    }

    if ($action === 'feature_flags_rollout_batch') {
        $payload = portalFeatureFlagRolloutPayload();
        if (empty($payload['success'])) die(json_encode($payload));
        $orgIds = json_decode((string)($_POST['org_ids'] ?? '[]'), true);
        $orgIds = array_values(array_unique(array_filter(array_map('strval', is_array($orgIds) ? $orgIds : []))));
        if (!$orgIds) die(json_encode(['success' => false, 'error' => 'No organizations supplied for this batch']));
        if (count($orgIds) > 150) die(json_encode(['success' => false, 'error' => 'Batch is too large']));

        $selected = 0;
        $wouldChange = 0;
        $changed = 0;
        $errors = [];
        $preview = [];
        foreach ($orgIds as $orgId) {
            $org = portalFeatureFlagReadOrgRecord($orgId);
            $orgName = is_array($org) ? (string)($org['name'] ?? $orgId) : $orgId;
            $errorLabel = $orgName !== $orgId ? $orgName . ' (' . $orgId . ')' : $orgId;
            if (!$org) {
                $errors[] = $errorLabel . ': organization not found';
                continue;
            }
            $selected++;
            $flags = $org['flags'];
            $before = $flags;
            foreach ($payload['keys'] as $key) {
                portalFeatureFlagSetKey($flags, $key, $payload['flag_actions'][$key]);
            }
            if ($flags !== $before) {
                $wouldChange++;
                if ($payload['dry_run']) {
                    $changed++;
                } else {
                    $saved = portalFeatureFlagSaveOrgFlagsDetailed($orgId, $flags, $currentUserEmail);
                    if (!empty($saved['success'])) {
                        $changed++;
                    } else {
                        $errors[] = $errorLabel . ': ' . ($saved['error'] ?? 'write failed');
                    }
                }
            }
            if (count($preview) < 5) {
                $preview[] = [
                    'id' => $orgId,
                    'name' => $org['name'] ?? $orgId,
                    'selected' => true,
                ];
            }
        }

        echo json_encode([
            'success' => empty($errors),
            'dry_run' => $payload['dry_run'],
            'selected' => $selected,
            'would_change' => $wouldChange,
            'changed' => $changed,
            'errors' => $errors,
            'preview' => $preview,
            'message' => $payload['dry_run'] ? 'Batch preview complete.' : 'Batch applied.',
        ]);
        exit;
    }

    if ($action === 'feature_flags_org') {
        $orgId = trim((string)($_POST['org_id'] ?? ''));
        $org = portalFeatureFlagReadOrgRecord($orgId);
        if (!$org) die(json_encode(['success' => false, 'error' => 'Organization not found']));
        echo json_encode([
            'success' => true,
            'organization' => portalFeatureFlagOrgSummary($org),
        ]);
        exit;
    }

    if ($action === 'feature_flags_save_org') {
        $orgId = trim((string)($_POST['org_id'] ?? ''));
        $flags = json_decode((string)($_POST['flags'] ?? '{}'), true);
        $variants = json_decode((string)($_POST['variants'] ?? '{}'), true);
        if (!is_array($flags)) die(json_encode(['success' => false, 'error' => 'Invalid flags payload']));
        $org = portalFeatureFlagReadOrgRecord($orgId);
        if (!$org) die(json_encode(['success' => false, 'error' => 'Organization not found']));
        if (!is_array($variants)) $variants = $org['variants'] ?? [];
        if (!portalFeatureFlagSaveOrgState($orgId, $flags, $variants, $currentUserEmail)) {
            die(json_encode(['success' => false, 'error' => 'Could not write organization flags']));
        }
        $updated = portalFeatureFlagReadOrgRecord($orgId);
        echo json_encode([
            'success' => true,
            'organization' => portalFeatureFlagOrgSummary($updated),
        ]);
        exit;
    }

    if ($action === 'feature_flags_rollout') {
        $payload = portalFeatureFlagRolloutPayload();
        if (empty($payload['success'])) die(json_encode($payload));
        $matchedIds = portalFeatureFlagFilteredOrgIds(
            $payload['query'],
            $payload['status'],
            $payload['filter_flag_key'],
            $payload['filter_flag_state'],
            $payload['filter_variant_family'],
            $payload['filter_variant_state']
        );
        $changed = 0;
        $selected = 0;
        $errors = [];
        $preview = [];
        $selectedOrgIds = $payload['mode'] === 'all'
            ? portalFeatureFlagStableCohortIdMap($matchedIds, 100, 'rollout:' . implode(',', $payload['keys']))
            : portalFeatureFlagStableCohortIdMap($matchedIds, $payload['percent'], 'rollout:' . implode(',', $payload['keys']));

        foreach ($matchedIds as $orgId) {
            $orgSelected = !empty($selectedOrgIds[$orgId]);
            $org = null;
            if ($orgSelected || count($preview) < 12) {
                $org = portalFeatureFlagReadOrgRecord($orgId);
            }
            if (!$org && $orgSelected) {
                $errors[] = $orgId;
                continue;
            }
            if (!$orgSelected) {
                if (count($preview) < 12) {
                    $preview[] = [
                        'id' => $orgId,
                        'name' => $org['name'] ?? $orgId,
                        'selected' => false,
                    ];
                }
                continue;
            }
            $flags = $org['flags'];
            $before = $flags;

            foreach ($payload['keys'] as $key) {
                portalFeatureFlagSetKey($flags, $key, $payload['flag_actions'][$key]);
            }

            $selected++;
            if ($flags !== $before) {
                $wouldChange++;
                if ($payload['dry_run']) {
                    $changed++;
                } else {
                    $saved = portalFeatureFlagSaveOrgFlagsDetailed($orgId, $flags, $currentUserEmail);
                    if (!empty($saved['success'])) {
                        $changed++;
                    } else {
                        $errors[] = $orgId . ': ' . ($saved['error'] ?? 'write failed');
                    }
                }
            }
            if (count($preview) < 12) {
                $preview[] = [
                    'id' => $orgId,
                    'name' => $org['name'],
                    'selected' => $orgSelected,
                ];
            }
        }

        echo json_encode([
            'success' => empty($errors),
            'dry_run' => $payload['dry_run'],
            'matched' => count($matchedIds),
            'selected' => $selected,
            'would_change' => $wouldChange,
            'changed' => $changed,
            'flag_actions' => $payload['flag_actions'],
            'errors' => $errors,
            'preview' => $preview,
            'message' => $payload['dry_run'] ? 'Preview complete.' : 'Rollout applied.',
        ]);
        exit;
    }

    if ($action === 'feature_flags_variant_rollout') {
        $family = portalFeatureVariantNormalizeFamily($_POST['variant_family'] ?? '');
        if ($family === '') die(json_encode(['success' => false, 'error' => 'Choose a valid variant family']));
        $query = trim((string)($_POST['query'] ?? ''));
        $status = trim((string)($_POST['status'] ?? ''));
        $flagKey = trim((string)($_POST['filter_flag_key'] ?? ''));
        $flagState = trim((string)($_POST['filter_flag_state'] ?? ''));
        $filterVariantFamily = trim((string)($_POST['filter_variant_family'] ?? ''));
        $filterVariantState = trim((string)($_POST['filter_variant_state'] ?? ''));
        $percent = max(0, min(100, (float)($_POST['percent'] ?? 50)));
        $dryRun = filter_var($_POST['dry_run'] ?? '0', FILTER_VALIDATE_BOOLEAN);
        $variantKeys = json_decode((string)($_POST['variant_keys'] ?? '[]'), true);
        if (!is_array($variantKeys)) $variantKeys = [];
        $variantKeys = array_values(array_unique(array_values(array_filter(array_map(function($key) use ($family) {
            return portalFeatureVariantNormalizeKey($family, $key);
        }, $variantKeys)))));
        if (!$variantKeys) die(json_encode(['success' => false, 'error' => 'Choose at least one variant']));

        $requirementKeys = [];
        foreach (portalFeatureVariantRegistry()[$family] as $variant) {
            foreach ((array)($variant['requires'] ?? []) as $requirement) {
                $normalized = portalFeatureFlagNormalizeKey($requirement);
                if ($normalized !== '') $requirementKeys[$normalized] = $normalized;
            }
        }
        $requirementKeys = array_values($requirementKeys);

        $filtered = portalFeatureFlagFilteredOrgs($query, $status, 0, 0, $flagKey, $flagState, $filterVariantFamily, $filterVariantState);
        $matched = $filtered['items'];
        $changed = 0;
        $selected = 0;
        $variantCounts = array_fill_keys($variantKeys, 0);
        $errors = [];
        $preview = [];
        $selectedOrgIds = portalFeatureFlagStableCohortIds($matched, $percent, 'variant-family:' . $family);
        $variantAssignments = portalFeatureVariantAssignments(array_keys($selectedOrgIds), $family, $variantKeys);

        foreach ($matched as $org) {
            $orgId = $org['id'];
            $flags = $org['flags'];
            $variants = $org['variants'];
            $beforeFlags = $flags;
            $beforeVariants = $variants;
            $orgSelected = !empty($selectedOrgIds[$orgId]);
            $assignedVariant = null;

            if ($orgSelected) {
                foreach ($requirementKeys as $key) portalFeatureFlagSetKey($flags, $key, true);
                $assignedVariant = $variantAssignments[$orgId] ?? $variantKeys[0];
                $variants[$family] = $assignedVariant;
                $selected++;
                $variantCounts[$assignedVariant]++;
            } else {
                foreach ($requirementKeys as $key) portalFeatureFlagSetKey($flags, $key, false);
                $variants[$family] = null;
            }

            if ($flags !== $beforeFlags || $variants !== $beforeVariants) {
                $changed++;
                if (!$dryRun && !portalFeatureFlagSaveOrgState($orgId, $flags, $variants, $currentUserEmail)) {
                    $errors[] = $orgId;
                }
            }
            if (count($preview) < 12) {
                $preview[] = [
                    'id' => $orgId,
                    'name' => $org['name'],
                    'selected' => $orgSelected,
                    'variant' => $assignedVariant,
                ];
            }
        }

        echo json_encode([
            'success' => empty($errors),
            'dry_run' => $dryRun,
            'matched' => count($matched),
            'selected' => $selected,
            'holdout' => max(0, count($matched) - $selected),
            'changed' => $changed,
            'variant_counts' => $variantCounts,
            'errors' => $errors,
            'preview' => $preview,
            'message' => $dryRun ? 'Variant preview complete.' : 'Variant rollout applied.',
        ]);
        exit;
    }

    // APPLE KEY GET
    if ($action === 'get_apple_key_info') {
        if (!$isAppleKeyAdmin) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $info = appleKeyGetInfo();
        echo json_encode([
            'success' => true,
            'key' => $info['key'],
            'updated_at_utc' => $info['updated_at_utc'],
            'tile_version' => $info['tile_version']
        ]);
        exit;
    }

    // APPLE KEY SET
    if ($action === 'set_apple_key') {
        if (!$isAppleKeyAdmin) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $k = $_POST['key'] ?? '';
        if (!appleKeySet($k)) die(json_encode(['success' => false, 'error' => 'Invalid key or write failed']));
        $info = appleKeyGetInfo();
        echo json_encode(['success' => true, 'updated_at_utc' => $info['updated_at_utc']]);
        exit;
    }

    // APPLE MAPS TILE VERSION SET
    if ($action === 'set_apple_tile_version') {
        if (!$isAppleKeyAdmin) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        if (!appleTileVersionSet($_POST['tile_version'] ?? null)) {
            die(json_encode(['success' => false, 'error' => 'Tile version must be a positive whole number']));
        }
        $info = appleKeyGetInfo();
        echo json_encode(['success' => true, 'tile_version' => $info['tile_version']]);
        exit;
    }

    if ($action === 'reopen_completed_project') {
        if (!portalCanReopenCompletedProject($myUserData, $myPerms)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project folder is required']));

        $notes = trim((string)($_POST['notes'] ?? ''));
        if ($notes === '') {
            die(json_encode(['success' => false, 'error' => 'Please add notes explaining why this project is being reopened.']));
        }

        $manifest = fm_fetch_project_manifest($folder);
        if (!is_array($manifest)) die(json_encode(['success' => false, 'error' => 'Project not found']));

        $status = portalStatusNormalizeStatus($manifest['status'] ?? '');
        if ($status !== 'completed') {
            die(json_encode([
                'success' => false,
                'error' => 'Only completed projects can be reopened for edits',
                'current_status' => $status,
            ]));
        }

        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $actorName = trim((string)($_SESSION['user_name'] ?? ''));
        $nowSql = gmdate('Y-m-d H:i:s');
        $imagesRaw = trim((string)($_POST['images_json'] ?? ''));
        $images = [];
        if ($imagesRaw !== '') {
            $decodedImages = json_decode($imagesRaw, true);
            if (is_array($decodedImages)) {
                foreach ($decodedImages as $image) {
                    if (!is_array($image)) continue;
                    $name = trim((string)($image['name'] ?? ''));
                    $url = trim((string)($image['url'] ?? ''));
                    if ($name === '' && $url === '') continue;
                    $images[] = [
                        'name' => $name !== '' ? $name : null,
                        'url' => $url !== '' ? $url : null,
                        'original_name' => trim((string)($image['original_name'] ?? '')) ?: null,
                        'content_type' => trim((string)($image['content_type'] ?? '')) ?: null,
                        'uploaded_at' => trim((string)($image['uploaded_at'] ?? '')) ?: $nowSql,
                        'uploaded_by_email' => $actorEmail !== '' ? $actorEmail : null,
                        'uploaded_by_name' => $actorName !== '' ? $actorName : null,
                    ];
                }
            }
        }
        $completedAt = trim((string)($manifest['completed_at'] ?? ''));
        if ($completedAt === '' && isset($manifest['timestamps']) && is_array($manifest['timestamps'])) {
            $completedAt = trim((string)($manifest['timestamps']['completed_at'] ?? ''));
        }
        $previousAssignedAt = trim((string)($manifest['assigned_at'] ?? ($manifest['claimed_at'] ?? ($manifest['technician_claimed_at'] ?? ''))));
        $previousStartedAt = trim((string)($manifest['started_at'] ?? ''));
        $previousUploadedAt = trim((string)($manifest['uploaded_at'] ?? ''));
        $previousStartBasis = $previousStartedAt !== '' ? $previousStartedAt : $previousAssignedAt;
        $previousEndBasis = $previousUploadedAt !== '' ? $previousUploadedAt : $completedAt;
        $previousStartTs = $previousStartBasis !== '' ? strtotime($previousStartBasis) : false;
        $previousEndTs = $previousEndBasis !== '' ? strtotime($previousEndBasis) : false;
        $previousWorkSeconds = ($previousStartTs !== false && $previousEndTs !== false && $previousEndTs >= $previousStartTs)
            ? ($previousEndTs - $previousStartTs)
            : null;
        $previousTechnicianHistory = function_exists('fm_manifest_technician_history')
            ? fm_manifest_technician_history($manifest)
            : [];

        $resubmissions = [];
        if (isset($manifest['resubmissions']) && is_array($manifest['resubmissions'])) {
            $resubmissions = array_values(array_filter($manifest['resubmissions'], 'is_array'));
        }

        $resubmission = [
            'id' => 'resub_' . gmdate('Ymd_His') . '_' . substr(bin2hex(random_bytes(4)), 0, 8),
            'round' => count($resubmissions) + 1,
            'previous_status' => $status,
            'completed_at' => $completedAt !== '' ? $completedAt : null,
            'reopened_at' => $nowSql,
            'reopened_by_email' => $actorEmail !== '' ? $actorEmail : null,
            'reopened_by_name' => $actorName !== '' ? $actorName : null,
            'notes' => $notes,
            'previous_assigned_to_email' => $manifest['assigned_to_email'] ?? null,
            'previous_assigned_to_name' => $manifest['assigned_to_name'] ?? null,
            'previous_assigned_at' => $previousAssignedAt !== '' ? $previousAssignedAt : null,
            'previous_started_at' => $previousStartedAt !== '' ? $previousStartedAt : null,
            'previous_uploaded_at' => $previousUploadedAt !== '' ? $previousUploadedAt : null,
            'previous_work_seconds' => $previousWorkSeconds,
            'previous_technician_history' => $previousTechnicianHistory,
            'previous_qa_approved_by' => $manifest['qa_approved_by'] ?? ($manifest['qa_approved_by_email'] ?? null),
            'previous_qa_approved_by_name' => $manifest['qa_approved_by_name'] ?? null,
            'previous_qa_approved_at' => $manifest['qa_approved_at'] ?? ($manifest['qa_completed_at'] ?? null),
            'images' => $images,
        ];
        $resubmissions[] = $resubmission;

        $workHistory = portalProjectWorkHistory($manifest);
        $workHistory[] = [
            'event' => 'project_reopened_for_edits',
            'ts' => $nowSql,
            'by_email' => $actorEmail !== '' ? $actorEmail : null,
            'by_name' => $actorName !== '' ? $actorName : null,
            'project_id' => $folder,
            'previous_completed_at' => $completedAt !== '' ? $completedAt : null,
            'resubmission_round' => count($resubmissions),
            'note' => $notes,
            'resulting_status' => 'queued',
        ];

        $emailState = is_array($manifest['email_state'] ?? null) ? $manifest['email_state'] : [];
        $emailState['report_email'] = [
            'sent_ok' => false,
            'last_ok' => false,
            'attempts' => 0,
            'sent_at_utc' => null,
            'last_attempt_utc' => null,
            'last_http' => null,
            'message_id' => null,
            'reset_at_utc' => gmdate('c'),
            'reset_reason' => 'project_reopened_for_edits',
        ];

        $patch = [
            'status' => 'queued',
            'queued_at' => $nowSql,
            'updated_at' => $nowSql,
            'started_at' => '',
            'assigned_at' => '',
            'claimed_at' => '',
            'technician_claimed_at' => '',
            'uploaded_at' => '',
            'completed_at' => '',
            'qa_claimed_at' => '',
            'qa_claimed_by_email' => '',
            'qa_claimed_by_name' => '',
            'qa_approved_at' => '',
            'qa_completed_at' => '',
            'qa_approved_by' => '',
            'qa_approved_by_email' => '',
            'qa_approved_by_name' => '',
            'assigned_to_email' => '',
            'assigned_to_name' => '',
            'reserved_to_email' => '',
            'reserved_to_name' => '',
            'reserved_at' => '',
            'correction_to_email' => '',
            'correction_to_name' => '',
            'correction_requested_at' => '',
            'resubmitted_at' => $nowSql,
            'last_resubmission_notes' => $notes,
            'resubmission_count' => count($resubmissions),
            'resubmissions' => $resubmissions,
            'reopened_for_edits' => true,
            'report_sent_at' => '',
            'email_state' => $emailState,
            'timestamps' => [
                'queued_at' => $nowSql,
                'updated_at' => $nowSql,
                'started_at' => '',
                'assigned_at' => '',
                'uploaded_at' => '',
                'completed_at' => '',
                'qa_claimed_at' => '',
                'qa_approved_at' => '',
                'qa_completed_at' => '',
            ],
            'workflow' => [
                'assigned_to' => ['email' => '', 'name' => ''],
                'reserved_to' => ['email' => '', 'name' => ''],
                'correction_to' => ['email' => '', 'name' => ''],
                'qa_claim' => ['email' => '', 'name' => '', 'claimed_at' => ''],
                'assigned_at' => '',
                'reserved_at' => '',
                'started_at' => '',
                'uploaded_at' => '',
                'completed_at' => '',
                'history' => $workHistory,
            ],
            'work_history' => $workHistory,
        ];

        $updated = fm_project_patch($folder, $patch);
        if (!is_array($updated)) {
            die(json_encode(['success' => false, 'error' => 'Failed to reopen project for edits']));
        }

        echo json_encode([
            'success' => true,
            'folder' => $folder,
            'status' => portalStatusNormalizeStatus($updated['status'] ?? 'queued'),
            'resubmission' => $resubmission,
            'project' => $updated,
        ]);
        exit;
    }

    // USERS
    if ($action === 'fetch_users') {
        if (empty($myPerms['manage_users']) && empty($myPerms['manage_sales_users'])) die(json_encode(['error' => 'Unauthorized']));

        $users = [];
        foreach (portalListNodeInternalUsers(false) as $u) {
            unset($u['password_hash']);
            $u['permissions'] = permissionOptionsNormalizePermissions($u['permissions'] ?? [], $u['role'] ?? 'user');
            if (!isset($u['department']) || !is_string($u['department']) || trim($u['department']) === '') $u['department'] = 'production';
            $u['training_complete'] = !empty($u['training_complete']);
            if (!isEmployeeUserData($u)) continue;
            $users[] = $u;
        }
        echo json_encode(['success' => true, 'users' => $users]);
        exit;
    }

    if ($action === 'save_user') {
        $mode = $_POST['mode'] ?? '';

        if ($mode === 'create' && empty($myPerms['create_users']) && empty($myPerms['manage_sales_users'])) die(json_encode(['error' => 'Unauthorized to create']));
        if ($mode === 'edit'   && empty($myPerms['manage_users']) && empty($myPerms['manage_sales_users'])) die(json_encode(['error' => 'Unauthorized to edit']));

        $email = strtolower(trim($_POST['email'] ?? ''));
        $name  = $_POST['name'] ?? '';
        $role  = $_POST['role'] ?? 'user';
        $team  = $_POST['team'] ?? 'default';
        $department = strtolower(trim($_POST['department'] ?? 'production'));
        if (!in_array($department, ['production', 'sales'], true)) $department = 'production';
        $compPref = $_POST['complexity_preference'] ?? 'all';
        $drafterRank = strtolower(trim((string)($_POST['drafter_rank'] ?? 'junior')));
        if (!in_array($drafterRank, ['junior', 'standard', 'senior'], true)) $drafterRank = 'junior';
        $perms = json_decode($_POST['permissions'] ?? '{}', true);
        $qMode = $_POST['queue_mode'] ?? 'disabled'; // <--- ADD THIS LINE
        $pass  = $_POST['password'] ?? '';

        $trainingCompleteRaw = $_POST['training_complete'] ?? '0';
        $trainingComplete = filter_var($trainingCompleteRaw, FILTER_VALIDATE_BOOLEAN);

        if (!$email) die(json_encode(['error' => 'Email required']));

        // normalize perms
        $perms = permissionOptionsNormalizePermissions($perms, $role);

        $uData = [];

        if ($mode === 'create') {
            if (portalReadUserDataByEmail($email)) die(json_encode(['error' => 'User already exists']));
            if (!$pass) die(json_encode(['error' => 'Password required for new users']));

            $uData = [
                'email' => $email,
                'created_at' => date('Y-m-d H:i:s'),
                'is_verified' => true,
                'training_complete' => $trainingComplete ? true : false,
            ];
        } else {
            $uData = portalReadUserDataByEmail($email);
            if (!$uData) die(json_encode(['error' => 'User not found']));
            if (!is_array($uData)) $uData = [];

            // Safety: don't let portal "edit" accidentally target a customer user
            $existingAcct = strtolower(trim((string)($uData['account_type'] ?? '')));
            if ($existingAcct === 'customer') {
                die(json_encode(['error' => 'Refusing to edit: this account is a customer. Portal user management is employees only.']));
            }
        }

        // Core fields
        $uData['name'] = $name;
        $uData['role'] = $role;
        $uData['team_id'] = $team;
        $uData['department'] = $department;
        $uData['complexity_preference'] = $compPref;
        $uData['drafter_rank'] = $drafterRank;
        $uData['queue_mode'] = $qMode;
        $uData['shift_rate'] = max(0, min(100000, (int)($_POST['shift_rate'] ?? 940)));
        $uData['permissions'] = $perms;

        // Legacy admin flag (keep for backward compat)
        $uData['is_admin'] = !empty($perms['is_admin_legacy']) || (($role === 'admin') ? true : false);

        // ✅ Portal-created/edited users are employees
        $uData['account_type'] = 'employee';

        // Training completion (admin-set only)
        $uData['training_complete'] = $trainingComplete ? true : false;

        // Password
        if ($pass) {
            $uData['password'] = $pass;
        }

        if (portalWriteUserDataByEmail($email, $uData)) {
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Node user write error']);
        }
        exit;
    }

    if ($action === 'qa_queue_snapshot') {
        if (!portalCanDoQa($myUserData, $myPerms) && !portalCanManageQaQueue($myUserData, $myPerms) && !portalCanManagerReview($myUserData, $myPerms)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $teamKey = portalQaTeamKey($_POST['team'] ?? ($myUserData['team_id'] ?? 'default'));
        $cleanup = portalQaReleaseExpiredClaims($teamKey);
        echo json_encode(portalQaBuildSnapshot($myUserData, $myPerms, $teamKey));
        exit;
    }

    if ($action === 'qa_leaderboard') {
        if (!portalCanDoQa($myUserData, $myPerms) && !portalCanManageQaQueue($myUserData, $myPerms) && !portalCanManagerReview($myUserData, $myPerms)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $teamKey = portalQaTeamKey($_POST['team'] ?? ($myUserData['team_id'] ?? 'default'));
        $date = fm_leaderboard_normalize_date($_POST['date'] ?? '');
        echo json_encode(portalQaLeaderboardForDate($teamKey, $date));
        exit;
    }

    if ($action === 'qa_queue_move_to_top') {
        if (!portalCanManageQaQueue($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project is required']));
        $res = fm_api_json('POST', 'projects/' . rawurlencode($folder) . '/qa/priority', [
            'prioritized' => true,
            'actor' => fm_current_actor(),
        ]);
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        if (!$res['ok'] || (array_key_exists('success', $json) && empty($json['success']))) {
            die(json_encode([
                'success' => false,
                'error' => (string)($json['error'] ?? $json['message'] ?? 'Failed to prioritize QA project'),
            ]));
        }
        echo json_encode(['success' => true, 'folder' => $folder, 'qa_priority' => true]);
        exit;
    }

    if ($action === 'qa_queue_clear_priority') {
        if (!portalCanManageQaQueue($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project is required']));
        $res = fm_api_json('POST', 'projects/' . rawurlencode($folder) . '/qa/priority', [
            'prioritized' => false,
            'actor' => fm_current_actor(),
        ]);
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        if (!$res['ok'] || (array_key_exists('success', $json) && empty($json['success']))) {
            die(json_encode([
                'success' => false,
                'error' => (string)($json['error'] ?? $json['message'] ?? 'Failed to update QA priority'),
            ]));
        }
        echo json_encode(['success' => true, 'folder' => $folder, 'qa_priority' => false]);
        exit;
    }

    if ($action === 'qa_queue_grab_next') {
        if (!portalCanDoQa($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $teamKey = portalQaTeamKey($_POST['team'] ?? ($myUserData['team_id'] ?? 'default'));
        portalQaReleaseExpiredClaims($teamKey);
        if (!portalCanManageQaQueue($myUserData, $myPerms) && !portalCanManagerReview($myUserData, $myPerms)) {
            echo json_encode(portalQaGrabNextFallback($myUserData, $myPerms, $teamKey, 2));
            exit;
        }
        $pull = fm_api_json('POST', 'qa/queue/pull', [
            'team' => $teamKey === 'all' ? null : $teamKey,
            'count' => 2,
            'drafter_ranks' => portalQaDrafterRankMap(),
            'actor' => fm_current_actor(),
        ]);
        $pullJson = is_array($pull['json'] ?? null) ? $pull['json'] : [];
        if (empty($pull['ok']) || empty($pullJson['success'])) {
            $fallback = portalQaGrabNextFallback($myUserData, $myPerms, $teamKey, 2);
            if (!empty($fallback['success'])) {
                echo json_encode($fallback);
                exit;
            }
            die(json_encode([
                'success' => false,
                'error' => (string)($fallback['error'] ?? $pullJson['error'] ?? $pullJson['message'] ?? 'No QA project is available right now.'),
            ]));
        }
        $projects = array_values(array_filter((array)($pullJson['projects'] ?? []), 'is_array'));
        if (empty($projects)) {
            echo json_encode(['success' => false, 'error' => 'No QA project is available right now.']);
            exit;
        }
        if (!portalCanManagerReview($myUserData, $myPerms)) {
            $viewerEmail = strtolower(trim((string)($myUserData['email'] ?? ($_SESSION['user_email'] ?? ''))));
            $projects = portalQaBlindIdentityList($projects, $viewerEmail);
        }

        echo json_encode([
            'success' => true,
            'folder' => (string)($projects[0]['id'] ?? ''),
            'project' => $projects[0],
            'reserved_projects' => $projects,
            'reused_existing' => count($projects) === 1,
            'queue_source' => $pullJson['source'] ?? null,
        ]);
        exit;
    }

    if ($action === 'qa_bulk_approve') {
        if (!$isFullAdmin) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $projectIds = json_decode((string)($_POST['project_ids'] ?? '[]'), true);
        if (!is_array($projectIds)) $projectIds = [];
        $criteria = json_decode((string)($_POST['criteria'] ?? '{}'), true);
        if (!is_array($criteria)) $criteria = [];
        $res = fm_api_json('POST', 'qa/bulk-approve', [
            'project_ids' => array_values(array_filter(array_map('strval', $projectIds))),
            'criteria' => $criteria,
            'drafter_ranks' => portalQaDrafterRankMap(),
            'actor' => fm_current_actor(),
        ]);
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        if (!$res['ok'] || (array_key_exists('success', $json) && empty($json['success']))) {
            die(json_encode([
                'success' => false,
                'error' => (string)($json['error'] ?? $json['message'] ?? 'Bulk QA approval failed'),
            ]));
        }
        echo json_encode($json);
        exit;
    }

    if ($action === 'qa_mark_return_to_me') {
        if (!portalCanDoQa($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project is required']));

        $actor = portalQaActorFromUser($myUserData);
        $actorEmail = strtolower(trim((string)($actor['email'] ?? '')));
        $actorName = trim((string)($actor['name'] ?? ''));
        if ($actorEmail === '') die(json_encode(['success' => false, 'error' => 'QA actor email is required']));

        $nowIso = gmdate('c');
        $updated = fm_project_patch($folder, [
            'qa_return_to_email' => $actorEmail,
            'qa_return_to_name' => $actorName !== '' ? $actorName : $actorEmail,
            'qa_return_to_set_at' => $nowIso,
            'qa_return_to_reason' => 'technician_correction',
            'return_to_qa_email' => $actorEmail,
            'return_to_qa_name' => $actorName !== '' ? $actorName : $actorEmail,
            'return_to_qa_at' => $nowIso,
            'timestamps' => [
                'updated_at' => $nowIso,
            ],
        ]);

        echo json_encode([
            'success' => is_array($updated),
            'folder' => $folder,
            'return_to_qa_email' => $actorEmail,
            'error' => is_array($updated) ? null : 'Failed to record QA return routing',
        ]);
        exit;
    }

    if ($action === 'qa_session_heartbeat') {
        if (!portalCanDoQa($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $active = filter_var($_POST['active'] ?? '1', FILTER_VALIDATE_BOOLEAN);
        $currentFolder = trim((string)($_POST['current_folder'] ?? ''));
        portalQaTouchHeartbeat($myUserData['email'] ?? ($_SESSION['user_email'] ?? ''), $currentFolder, $active);
        $res = fm_api_json('POST', 'qa/session/heartbeat', [
            'active' => $active,
            'current_folder' => $currentFolder,
            'actor' => fm_current_actor(),
        ]);
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        echo json_encode([
            'success' => !empty($res['ok']) && (!array_key_exists('success', $json) || !empty($json['success'])),
            'active' => $active,
            'received_at' => $json['received_at'] ?? gmdate('c'),
            'error' => $json['error'] ?? null,
        ]);
        exit;
    }

    if ($action === 'qa_release_all_claims') {
        if (!portalCanDoQa($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $res = fm_api_json('POST', 'qa/session/release', [
            'reason' => trim((string)($_POST['reason'] ?? 'manual')),
            'actor' => fm_current_actor(),
        ]);
        $json = is_array($res['json'] ?? null) ? $res['json'] : [];
        if (empty($res['ok']) || (array_key_exists('success', $json) && empty($json['success']))) {
            $teamKey = portalQaTeamKey($_POST['team'] ?? ($myUserData['team_id'] ?? 'default'));
            $fallback = portalQaReleaseAllClaimsFallback($myUserData, $myPerms, $teamKey, trim((string)($_POST['reason'] ?? 'manual')));
            echo json_encode($fallback);
            exit;
        }
        echo json_encode([
            'success' => !empty($res['ok']) && (!array_key_exists('success', $json) || !empty($json['success'])),
            'released' => (int)($json['released'] ?? 0),
            'error' => $json['error'] ?? null,
        ]);
        exit;
    }

    if ($action === 'qa_release_claim') {
        $forceRelease = filter_var($_POST['force'] ?? false, FILTER_VALIDATE_BOOLEAN);
        if ($forceRelease) {
            if (!portalCanManagerReview($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Only managers can force release QA claims']));
        } elseif (!portalCanDoQa($myUserData, $myPerms)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $folder = trim((string)($_POST['folder'] ?? ''));
        $address = trim((string)($_POST['address'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project is required']));

        $release = fm_api_json('POST', 'projects/' . rawurlencode($folder) . '/qa/release-claim', [
            'actor' => fm_current_actor(),
            'reason' => $forceRelease ? 'manager_force_release' : 'manual',
            'force' => $forceRelease,
        ]);
        $releaseJson = is_array($release['json'] ?? null) ? $release['json'] : [];
        if (empty($release['ok']) || (array_key_exists('success', $releaseJson) && empty($releaseJson['success']))) {
            $fallback = portalQaReleaseClaimLocal(
                $folder,
                portalQaActorFromUser($myUserData),
                $forceRelease ? 'manager_force_release' : 'manual',
                $forceRelease
            );
            if (!empty($fallback['success'])) {
                portalQaSetReleasePreference(strtolower(trim((string)($_SESSION['user_email'] ?? ''))), $folder, $address);
                echo json_encode(['success' => true, 'source' => 'portal_fallback']);
                exit;
            }
            die(json_encode([
                'success' => false,
                'error' => (string)($fallback['error'] ?? $releaseJson['error'] ?? $releaseJson['message'] ?? 'Failed to release QA claim'),
            ]));
        }

        portalQaSetReleasePreference(strtolower(trim((string)($_SESSION['user_email'] ?? ''))), $folder, $address);
        echo json_encode(['success' => true]);
        exit;
    }

    if ($action === 'review_rejection') {
        if (!portalCanDoQa($myUserData, $myPerms)) die(json_encode(['success' => false, 'error' => 'Unauthorized']));

        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project folder is required']));

        $decision = strtolower(trim((string)($_POST['decision'] ?? '')));
        if (!in_array($decision, ['confirmed', 'overturned'], true)) {
            die(json_encode(['success' => false, 'error' => 'Decision must be confirmed or overturned']));
        }

        $manifest = fm_fetch_project_manifest($folder);
        if (!is_array($manifest)) die(json_encode(['success' => false, 'error' => 'Project not found']));

        $status = portalStatusNormalizeStatus($manifest['status'] ?? '');
        if ($status !== 'pending_rejection') {
            die(json_encode([
                'success' => false,
                'error' => 'Project is not pending rejection',
                'current_status' => $status,
            ]));
        }

        $reviewerEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $reviewerName = trim((string)($_SESSION['user_name'] ?? ''));
        $reviewNotes = trim((string)($_POST['review_notes'] ?? ''));
        $nowSql = gmdate('Y-m-d H:i:s');
        $workHistory = portalProjectWorkHistory($manifest);

        $rejectionRequest = is_array($manifest['rejection_request'] ?? null) ? $manifest['rejection_request'] : [];
        $rejectionRequest['reviewed'] = true;
        $rejectionRequest['review_decision'] = $decision;
        $rejectionRequest['reviewed_at'] = $nowSql;
        $rejectionRequest['reviewed_by'] = $reviewerEmail !== '' ? $reviewerEmail : null;
        $rejectionRequest['reviewed_by_name'] = $reviewerName !== '' ? $reviewerName : null;
        $rejectionRequest['review_notes'] = $reviewNotes !== '' ? $reviewNotes : null;

        if ($decision === 'overturned') {
            $restoredStatus = portalStatusNormalizeStatus($rejectionRequest['previous_status'] ?? '');
            if ($restoredStatus === '' || $restoredStatus === 'pending_rejection') $restoredStatus = 'processing';

            $workHistory[] = [
                'event' => 'rejection_reviewed',
                'ts' => $nowSql,
                'decision' => 'overturned',
                'reviewer_email' => $reviewerEmail !== '' ? $reviewerEmail : null,
                'reviewer_name' => $reviewerName !== '' ? $reviewerName : null,
                'review_notes' => $reviewNotes !== '' ? $reviewNotes : null,
                'resulting_status' => $restoredStatus,
            ];

            $updated = fm_project_patch($folder, [
                'status' => $restoredStatus,
                'rejection_request' => $rejectionRequest,
                'timestamps' => [
                    'updated_at' => $nowSql,
                ],
                'work_history' => $workHistory,
                'workflow' => [
                    'history' => $workHistory,
                ],
            ]);

            if (!is_array($updated)) {
                die(json_encode(['success' => false, 'error' => 'Failed to update project status']));
            }

            echo json_encode([
                'success' => true,
                'folder' => $folder,
                'decision' => 'overturned',
                'status' => $restoredStatus,
                'project' => $updated,
            ]);
            exit;
        }

        $reqReasons = array_values(array_filter((array)($rejectionRequest['reasons'] ?? []), function($value) {
            return trim((string)$value) !== '';
        }));
        $reqReasonIds = [];
        foreach ($reqReasons as $value) {
            $reasonId = function_exists('fm_rejection_reason_id_from_value') ? fm_rejection_reason_id_from_value($value) : '';
            if ($reasonId !== '' && !in_array($reasonId, $reqReasonIds, true)) $reqReasonIds[] = $reasonId;
        }
        if (empty($reqReasonIds)) {
            die(json_encode([
                'success' => false,
                'error' => 'A valid rejection reason is required',
                'allowed_rejection_reasons' => function_exists('fm_rejection_reason_ids') ? fm_rejection_reason_ids() : [],
            ]));
        }
        $structureReorder = null;
        if (in_array('incorrect_structure_type', $reqReasonIds, true)) {
            $correctProjectType = portalNormalizeStructureReorderProjectType(
                $rejectionRequest['correct_project_type']
                    ?? $rejectionRequest['reorder_project_type']
                    ?? $rejectionRequest['target_project_type']
                    ?? ''
            );
            if ($correctProjectType === '') {
                die(json_encode([
                    'success' => false,
                    'error' => 'Incorrect structure type rejections require the correct project type: commercial or multifamily.',
                ]));
            }
            $structureReorder = portalBuildStructureReorderPayload($folder, $manifest, $correctProjectType);
            if (!is_array($structureReorder)) {
                die(json_encode(['success' => false, 'error' => 'Unable to build reorder information for this rejection']));
            }
            $rejectionRequest['correct_project_type'] = $correctProjectType;
            $rejectionRequest['reorder_project_type'] = $correctProjectType;
        }
        $reqNotes = trim((string)($rejectionRequest['notes'] ?? ''));
        $combinedNotes = $reqNotes;
        if ($combinedNotes === '' && !empty($reqReasons)) {
            $combinedNotes = implode('; ', $reqReasons);
        }

        $refund = portalRejectedProjectRefund($folder, $manifest, $reviewerEmail, $reviewerName, 'portal_review_rejection');
        if (empty($refund['ok'])) {
            die(json_encode(['success' => false, 'error' => $refund['error'] ?? 'Refund failed']));
        }

        $refundApplied = !empty($refund['refunded']);
        $alreadyRefunded = !empty($refund['already_refunded']);
        if (!$alreadyRefunded && $refundApplied) {
            $workHistory[] = [
                'event' => 'credit_refunded',
                'ts' => $refund['refund_at'] ?? $nowSql,
                'by_email' => $reviewerEmail !== '' ? $reviewerEmail : null,
                'by_name' => $reviewerName !== '' ? $reviewerName : null,
                'refund_amount' => portalCreditAmount($refund['refunded'] ?? 0),
                'refund_reason' => 'rejection_refund',
                'project_id' => $folder,
                'refund_scope' => $refund['refund_scope'] ?? null,
                'refund_to_email' => $refund['refund_to_email'] ?? null,
                'refund_to_organization_id' => $refund['refund_to_organization_id'] ?? null,
                'note' => 'Refunded as part of project rejection',
            ];
        }

        $workHistory[] = [
            'event' => 'rejection_reviewed',
            'ts' => $nowSql,
            'decision' => 'confirmed',
            'reviewer_email' => $reviewerEmail !== '' ? $reviewerEmail : null,
            'reviewer_name' => $reviewerName !== '' ? $reviewerName : null,
            'review_notes' => $reviewNotes !== '' ? $reviewNotes : null,
            'resulting_status' => 'rejected_no_coverage',
        ];
        $workHistory[] = [
            'event' => 'rejected_no_coverage',
            'ts' => $nowSql,
            'by_email' => $reviewerEmail !== '' ? $reviewerEmail : null,
            'by_name' => $reviewerName !== '' ? $reviewerName : null,
            'note' => $combinedNotes !== '' ? $combinedNotes : null,
            'source' => 'rejection_review',
        ];

        $patch = [
            'status' => 'rejected_no_coverage',
            'rejected_at' => $nowSql,
            'rejected_by' => $reviewerEmail !== '' ? $reviewerEmail : null,
            'rejection_reason' => $reqReasonIds[0],
            'rejection_note' => $combinedNotes !== '' ? $combinedNotes : null,
            'rejection_notes' => $combinedNotes !== '' ? $combinedNotes : null,
            'rejection_review_notes' => $reviewNotes !== '' ? $reviewNotes : null,
            'rejection_reason_details' => $reqReasonIds,
            'rejection_request' => $rejectionRequest,
            'refund_issued' => $refundApplied || $alreadyRefunded,
            'refund_amount' => portalCreditAmount($refund['refund_amount'] ?? 0),
            'refund_at' => $refund['refund_at'] ?? null,
            'refund_by' => $refund['refund_by'] ?? null,
            'refund_by_name' => $refund['refund_by_name'] ?? null,
            'refund_scope' => $refund['refund_scope'] ?? null,
            'refund_to_email' => $refund['refund_to_email'] ?? null,
            'refund_to_organization_id' => $refund['refund_to_organization_id'] ?? null,
            'timestamps' => [
                'rejected_at' => $nowSql,
                'updated_at' => $nowSql,
            ],
            'work_history' => $workHistory,
            'workflow' => [
                'history' => $workHistory,
            ],
        ];
        if (is_array($structureReorder)) {
            $patch['correct_project_type'] = $structureReorder['project_type'];
            $patch['rejection_correct_project_type'] = $structureReorder['project_type'];
            $patch['reorder_project_type'] = $structureReorder['project_type'];
            $patch['reorder_url'] = $structureReorder['url'];
            $patch['rejection_reorder'] = $structureReorder;
            $patch['customer_rejection_title'] = 'Incorrect structure type';
            $patch['customer_rejection_message'] =
                'This was ordered as ' . portalProjectTypeLabelForCustomer($manifest['project_type'] ?? '') .
                ', but it appears to require a ' . portalProjectTypeLabelForCustomer($structureReorder['project_type']) .
                ' report. We have reimbursed the original report.';
        }

        $updated = fm_project_patch($folder, $patch);
        if (!is_array($updated)) {
            $refundWarning = ($refundApplied && !$alreadyRefunded)
                ? ' Credit refund may have already been applied; please check the customer transaction history before retrying.'
                : '';
            die(json_encode(['success' => false, 'error' => 'Failed to finalize rejection.' . $refundWarning]));
        }

        $emailRes = fm_api_json('POST', 'projects/' . rawurlencode($folder) . '/email/send-rejection', [
            'force' => false,
        ]);

        echo json_encode([
            'success' => true,
            'folder' => $folder,
            'decision' => 'confirmed',
            'status' => 'rejected_no_coverage',
            'project' => $updated,
            'refunded' => $refundApplied || $alreadyRefunded,
            'refund_amount' => portalCreditAmount($refund['refund_amount'] ?? 0),
            'email_result' => is_array($emailRes['json'] ?? null) ? $emailRes['json'] : null,
        ]);
        exit;
    }

    if ($action === 'reject_no_coverage') {
        if (!portalCanManagerReview($myUserData, $myPerms) && !portalCanManageQaQueue($myUserData, $myPerms)) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project folder is required']));

        $manifest = fm_fetch_project_manifest($folder);
        if (!is_array($manifest)) die(json_encode(['success' => false, 'error' => 'Project not found']));

        $status = portalStatusNormalizeStatus($manifest['status'] ?? '');
        if (in_array($status, ['completed', 'cancelled'], true)) {
            die(json_encode(['success' => false, 'error' => 'Completed and cancelled projects cannot be rejected']));
        }

        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $actorName = trim((string)($_SESSION['user_name'] ?? ''));
        $note = trim((string)($_POST['note'] ?? ''));
        $rejectionReason = function_exists('fm_rejection_reason_id_from_value')
            ? fm_rejection_reason_id_from_value($_POST['rejection_reason'] ?? '')
            : '';
        if ($rejectionReason === '') {
            die(json_encode([
                'success' => false,
                'error' => 'A valid rejection reason is required',
                'allowed_rejection_reasons' => function_exists('fm_rejection_reason_ids') ? fm_rejection_reason_ids() : [],
            ]));
        }
        $structureReorder = null;
        if ($rejectionReason === 'incorrect_structure_type') {
            $correctProjectType = portalNormalizeStructureReorderProjectType(
                $_POST['correct_project_type']
                    ?? $_POST['reorder_project_type']
                    ?? $_POST['target_project_type']
                    ?? ''
            );
            if ($correctProjectType === '') {
                die(json_encode([
                    'success' => false,
                    'error' => 'Incorrect structure type rejections require the correct project type: commercial or multifamily.',
                ]));
            }
            $structureReorder = portalBuildStructureReorderPayload($folder, $manifest, $correctProjectType);
            if (!is_array($structureReorder)) {
                die(json_encode(['success' => false, 'error' => 'Unable to build reorder information for this rejection']));
            }
        }

        $refund = portalRejectedProjectRefund($folder, $manifest, $actorEmail, $actorName, 'portal_no_coverage_rejection');
        if (empty($refund['ok'])) {
            die(json_encode(['success' => false, 'error' => $refund['error'] ?? 'Refund failed']));
        }
        $refundApplied = !empty($refund['refunded']);
        $alreadyRefunded = !empty($refund['already_refunded']);

        if (!in_array($status, ['rejected', 'rejected_no_coverage'], true)) {
            $rejectRes = fm_api_json('POST', 'projects/' . rawurlencode($folder) . '/coverage/reject', [
                'note' => $note,
                'rejection_reason' => $rejectionReason,
                'correct_project_type' => is_array($structureReorder) ? $structureReorder['project_type'] : null,
                'refund_issued' => $refundApplied || $alreadyRefunded,
                'refund_amount' => portalCreditAmount($refund['refund_amount'] ?? 0),
                'refund_reason' => 'rejection_refund',
                'refund_pending' => false,
                'actor' => fm_current_actor(),
            ]);
            $rejectJson = is_array($rejectRes['json'] ?? null) ? $rejectRes['json'] : [];
            if (empty($rejectRes['ok']) || (array_key_exists('success', $rejectJson) && empty($rejectJson['success']))) {
                die(json_encode([
                    'success' => false,
                    'error' => (string)($rejectJson['error'] ?? $rejectJson['message'] ?? 'Reject failed'),
                ]));
            }
        }

        $updatedManifest = fm_fetch_project_manifest($folder);
        if (!is_array($updatedManifest)) $updatedManifest = $manifest;

        $nowSql = gmdate('Y-m-d H:i:s');
        $workHistory = portalProjectWorkHistory($updatedManifest);
        if (!$alreadyRefunded && $refundApplied) {
            $workHistory[] = [
                'event' => 'credit_refunded',
                'ts' => $refund['refund_at'] ?? $nowSql,
                'by_email' => $actorEmail !== '' ? $actorEmail : null,
                'by_name' => $actorName !== '' ? $actorName : null,
                'refund_amount' => portalCreditAmount($refund['refunded'] ?? 0),
                'refund_reason' => 'rejection_refund',
                'project_id' => $folder,
                'refund_scope' => $refund['refund_scope'] ?? null,
                'refund_to_email' => $refund['refund_to_email'] ?? null,
                'refund_to_organization_id' => $refund['refund_to_organization_id'] ?? null,
                'note' => 'Refunded as part of project rejection',
            ];
        }

        $patch = [
            'rejection_reason' => $rejectionReason,
            'rejection_note' => $note !== '' ? $note : null,
            'rejection_notes' => $note !== '' ? $note : null,
            'rejection_reason_details' => [$rejectionReason],
            'refund_issued' => $refundApplied || $alreadyRefunded,
            'refund_amount' => portalCreditAmount($refund['refund_amount'] ?? 0),
            'refund_at' => $refund['refund_at'] ?? null,
            'refund_by' => $refund['refund_by'] ?? null,
            'refund_by_name' => $refund['refund_by_name'] ?? null,
            'refund_scope' => $refund['refund_scope'] ?? null,
            'refund_to_email' => $refund['refund_to_email'] ?? null,
            'refund_to_organization_id' => $refund['refund_to_organization_id'] ?? null,
            'work_history' => $workHistory,
            'workflow' => [
                'history' => $workHistory,
            ],
            'timestamps' => [
                'updated_at' => $nowSql,
            ],
        ];
        if (is_array($structureReorder)) {
            $patch['correct_project_type'] = $structureReorder['project_type'];
            $patch['rejection_correct_project_type'] = $structureReorder['project_type'];
            $patch['reorder_project_type'] = $structureReorder['project_type'];
            $patch['reorder_url'] = $structureReorder['url'];
            $patch['rejection_reorder'] = $structureReorder;
            $patch['customer_rejection_title'] = 'Incorrect structure type';
            $patch['customer_rejection_message'] =
                'This was ordered as ' . portalProjectTypeLabelForCustomer($manifest['project_type'] ?? '') .
                ', but it appears to require a ' . portalProjectTypeLabelForCustomer($structureReorder['project_type']) .
                ' report. We have reimbursed the original report.';
        }

        $patched = fm_project_patch($folder, $patch);
        if (!is_array($patched)) {
            $refundWarning = ($refundApplied && !$alreadyRefunded)
                ? ' Credit refund may have already been applied; please check the customer transaction history before retrying.'
                : '';
            die(json_encode(['success' => false, 'error' => 'Rejected, but failed to record refund metadata.' . $refundWarning]));
        }

        echo json_encode([
            'success' => true,
            'folder' => $folder,
            'status' => portalStatusNormalizeStatus($patched['status'] ?? ($updatedManifest['status'] ?? '')),
            'project' => $patched,
            'refunded' => $refundApplied || $alreadyRefunded,
            'refund_amount' => portalCreditAmount($refund['refund_amount'] ?? 0),
        ]);
        exit;
    }

    if ($action === 'cancel_project') {
        if (empty($myPerms['cancel_projects'])) die(json_encode(['success' => false, 'error' => 'Unauthorized']));

        $folder = trim((string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success' => false, 'error' => 'Project folder is required']));
        $refundMode = strtolower(trim((string)($_POST['refund_mode'] ?? '')));
        if (!in_array($refundMode, ['refund', 'no_refund'], true)) {
            die(json_encode(['success' => false, 'error' => 'Please choose whether to refund credits for this cancellation']));
        }

        $manifest = fm_fetch_project_manifest($folder);
        if (!is_array($manifest)) die(json_encode(['success' => false, 'error' => 'Project not found']));

        $status = portalStatusNormalizeStatus($manifest['status'] ?? '');
        if (in_array($status, ['completed', 'rejected', 'rejected_no_coverage', 'cancelled'], true)) {
            die(json_encode(['success' => false, 'error' => 'Only active projects can be cancelled']));
        }

        $ownerRef = is_array($manifest['owner_ref'] ?? null) ? $manifest['owner_ref'] : [];
        $issuer = is_array($manifest['issuer'] ?? null) ? $manifest['issuer'] : [];
        $ownerEmail = strtolower(trim((string)($manifest['owner_email'] ?? '')));
        if ($ownerEmail === '') $ownerEmail = strtolower(trim((string)($ownerRef['email'] ?? '')));
        if ($ownerEmail === '') $ownerEmail = strtolower(trim((string)($issuer['email'] ?? '')));
        $organizationId = portalNormalizeOrganizationId($manifest['organization_id'] ?? '');
        $refundAmount = max(0, portalCreditAmount($manifest['amount_charged'] ?? 0));
        $projectType = strtolower(trim((string)($manifest['project_type'] ?? 'residential')));
        if (!in_array($projectType, ['residential', 'commercial', 'multifamily'], true)) $projectType = 'residential';

        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $actorName = trim((string)($_SESSION['user_name'] ?? ''));
        $nowSql = gmdate('Y-m-d H:i:s');

        $workHistory = [];
        if (!empty($manifest['work_history']) && is_array($manifest['work_history'])) {
            $workHistory = array_values($manifest['work_history']);
        } else if (!empty($manifest['workflow']['history']) && is_array($manifest['workflow']['history'])) {
            $workHistory = array_values($manifest['workflow']['history']);
        }

        $refundResult = null;
        $refundTargetScope = null;
        $refundTargetEmail = $ownerEmail ?: null;
        if ($refundMode === 'refund') {
            if ($refundAmount <= 0) {
                die(json_encode(['success' => false, 'error' => 'This project does not have charged credits available to refund']));
            }

            $refundMeta = [
                'project_id' => $folder,
                'address' => (string)($manifest['address'] ?? ''),
                'project_type' => $projectType,
                'pin_count' => max(1, count(is_array($manifest['pins'] ?? null) ? $manifest['pins'] : [])),
                'source' => 'internal_portal_cancel_project',
                'cancelled_by_email' => $actorEmail,
                'cancelled_by_name' => $actorName,
                'organization_id' => $organizationId !== '' ? $organizationId : null,
            ];
            if ($organizationId !== '') {
                $refundTargetScope = 'org';
                $refundResult = portalRefundCreditsByOrganizationId($organizationId, $refundAmount, 'cancellation_refund', $refundMeta, $ownerEmail);
                $refundTargetEmail = $refundResult['applied_for_user_email'] ?? ($ownerEmail ?: null);
            } else {
                if ($ownerEmail === '') {
                    die(json_encode(['success' => false, 'error' => 'This project does not have an associated organization or customer email available for refund']));
                }
                $refundTargetScope = 'user';
                $refundResult = portalRefundCreditsByEmail($ownerEmail, $refundAmount, 'cancellation_refund', $refundMeta);
                $refundTargetEmail = $ownerEmail;
            }
            if (empty($refundResult['ok'])) {
                die(json_encode(['success' => false, 'error' => $refundResult['error'] ?? 'Refund failed']));
            }

            $workHistory[] = [
                'event' => 'credit_refunded',
                'ts' => $nowSql,
                'by_email' => $actorEmail ?: null,
                'by_name' => $actorName ?: null,
                'refund_amount' => $refundAmount,
                'refund_reason' => 'cancellation_refund',
                'project_id' => $folder,
                'refund_scope' => $refundTargetScope,
                'refund_to_email' => $refundTargetEmail,
                'refund_to_organization_id' => $organizationId !== '' ? $organizationId : null,
                'note' => 'Refunded as part of project cancellation',
            ];
        }

        $workHistory[] = [
            'event' => 'cancelled_project',
            'ts' => $nowSql,
            'by_email' => $actorEmail ?: null,
            'by_name' => $actorName ?: null,
            'refund_decision' => ($refundMode === 'refund') ? 'refunded' : 'not_refunded',
            'refund_amount' => ($refundMode === 'refund') ? $refundAmount : 0,
            'project_id' => $folder,
            'note' => ($refundMode === 'refund')
                ? ('Project cancelled and $' . $refundAmount . ' refunded to credits')
                : 'Project cancelled without refunding credits',
        ];

        $patch = [
            'status' => 'cancelled',
            'cancelled_at' => $nowSql,
            'cancelled_by_email' => $actorEmail ?: null,
            'cancelled_by_name' => $actorName ?: null,
            'cancellation_refund_decision' => ($refundMode === 'refund') ? 'refunded' : 'not_refunded',
            'cancellation_refunded' => ($refundMode === 'refund'),
            'cancellation_refund_amount' => ($refundMode === 'refund') ? $refundAmount : 0,
            'cancellation_refund_at' => ($refundMode === 'refund') ? $nowSql : null,
            'cancellation_refund_by_email' => ($refundMode === 'refund') ? ($actorEmail ?: null) : null,
            'cancellation_refund_by_name' => ($refundMode === 'refund') ? ($actorName ?: null) : null,
            'cancellation' => [
                'cancelled_at' => $nowSql,
                'cancelled_by_email' => $actorEmail ?: null,
                'cancelled_by_name' => $actorName ?: null,
                'refund_decision' => ($refundMode === 'refund') ? 'refunded' : 'not_refunded',
                'refund_amount' => ($refundMode === 'refund') ? $refundAmount : 0,
                'refund_at' => ($refundMode === 'refund') ? $nowSql : null,
                'refund_by_email' => ($refundMode === 'refund') ? ($actorEmail ?: null) : null,
                'refund_by_name' => ($refundMode === 'refund') ? ($actorName ?: null) : null,
                'refund_scope' => ($refundMode === 'refund') ? $refundTargetScope : null,
                'customer_email' => $refundTargetEmail ?: ($ownerEmail ?: null),
                'organization_id' => $organizationId !== '' ? $organizationId : null,
            ],
            'timestamps' => [
                'cancelled_at' => $nowSql,
                'updated_at' => $nowSql,
            ],
            'work_history' => $workHistory,
            'workflow' => [
                'history' => $workHistory,
            ],
        ];

        $updated = fm_project_patch($folder, $patch);
        if (!is_array($updated)) {
            $refundWarning = ($refundMode === 'refund')
                ? ' Credit refund may have already been applied; please check the customer transaction history before retrying.'
                : '';
            die(json_encode(['success' => false, 'error' => 'Failed to cancel project.' . $refundWarning]));
        }

        echo json_encode([
            'success' => true,
            'project' => $updated,
            'refund_applied' => ($refundMode === 'refund'),
            'refund_amount' => ($refundMode === 'refund') ? $refundAmount : 0,
        ]);
        exit;
    }


    if ($action === 'delete_user') {
        if (empty($myPerms['assign_teams']) && empty($myPerms['manage_sales_users'])) die(json_encode(['error' => 'Unauthorized']));
        $email = $_POST['email'] ?? '';
        if (portalDeleteNodeInternalUser($email)) {
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Not found']);
        }
        exit;
    }

    // STUDENT PROGRESS
    if ($action === 'fetch_student_list') {
        if (empty($myPerms['manage_tutorials'])) die(json_encode(['error' => 'Unauthorized']));
        $courseId = portalNormalizeTutorialCourseId(tutorialCourseIdFromRequest());

        $students = [];
        foreach (portalListNodeInternalUsers(false) as $u) {
            if (!$u) continue;

            // Only include employees in progress tracking
            if (!isEmployeeUserData($u)) continue;

            $email = (string)($u['email'] ?? '');
            $safeUser = fm_tutorial_safe_user($email);
            $trainingComplete = !empty($u['training_complete']);
            $seenTutorial = !empty($u['seen_tutorial']);

                $readProgressNoCreate = function($cid) use ($safeUser) {
                    $cid = (string)$cid;
                    $paths = [];
                    $paths[] = storagePath('tutorials/users/' . $safeUser . '/courses/' . ($cid ?: 'default') . '/progress.json');
                    if ($cid === '' || $cid === 'default') {
                        $paths[] = storagePath('tutorials/' . $safeUser . '/progress.json');
                    } else {
                        $paths[] = storagePath('tutorials/courses/' . $cid . '/' . $safeUser . '/progress.json');
                    }
                    foreach ($paths as $path) {
                        $progress = fm_tutorial_read_json_file($path, null);
                        if (is_array($progress)) {
                            $progress = array_merge(fm_tutorial_default_progress(), $progress);
                            $progress['completed_videos'] = is_array($progress['completed_videos'] ?? null) ? $progress['completed_videos'] : [];
                            $progress['completed_projects'] = is_array($progress['completed_projects'] ?? null) ? $progress['completed_projects'] : [];
                            $progress['test_attempts'] = is_array($progress['test_attempts'] ?? null) ? $progress['test_attempts'] : [];
                            $progress['current_chapter'] = max(1, (int)($progress['current_chapter'] ?? 1));
                            return $progress;
                        }
                    }
                    return fm_tutorial_default_progress();
                };

                $countProjectsNoCreate = function($cid) use ($safeUser) {
                    $cid = (string)$cid;
                    $dirs = [
                        storagePath('tutorials/users/' . $safeUser . '/courses/' . ($cid ?: 'default') . '/projects'),
                    ];
                    if ($cid === '' || $cid === 'default') {
                        $dirs[] = storagePath('tutorials/' . $safeUser . '/projects');
                    } else {
                        $dirs[] = storagePath('tutorials/courses/' . $cid . '/' . $safeUser . '/projects');
                    }
                    $count = 0;
                    $seen = [];
                    foreach ($dirs as $dir) {
                        $real = is_dir($dir) ? realpath($dir) : false;
                        if (!$real || isset($seen[$real])) continue;
                        $seen[$real] = true;
                        foreach (scandir($real) ?: [] as $id) {
                            if ($id === '.' || $id === '..' || !fm_tutorial_is_tutorial_project_id($id)) continue;
                            if (is_file($real . DIRECTORY_SEPARATOR . $id . DIRECTORY_SEPARATOR . 'manifest.json')) $count++;
                        }
                    }
                    return $count;
                };

                $candidateCourses = [
                    $courseId,
                    portalDefaultTutorialCourseForUser($u),
                    'default',
                    'software-update-refresh',
                ];
                $newCoursesRoot = storagePath('tutorials/users/' . $safeUser . '/courses');
                if (is_dir($newCoursesRoot)) {
                    foreach (scandir($newCoursesRoot) ?: [] as $entry) {
                        if ($entry !== '.' && $entry !== '..' && preg_match('/^[a-zA-Z0-9_\-]+$/', $entry) && is_dir($newCoursesRoot . DIRECTORY_SEPARATOR . $entry)) {
                            $candidateCourses[] = $entry;
                        }
                    }
                }
                $legacyCoursesRoot = storagePath('tutorials/courses');
                if (is_dir($legacyCoursesRoot)) {
                    foreach (scandir($legacyCoursesRoot) ?: [] as $entry) {
                        if ($entry !== '.' && $entry !== '..' && preg_match('/^[a-zA-Z0-9_\-]+$/', $entry) && is_dir($legacyCoursesRoot . DIRECTORY_SEPARATOR . $entry . DIRECTORY_SEPARATOR . $safeUser)) {
                            $candidateCourses[] = $entry;
                        }
                    }
                }
                $candidateCourses = array_values(array_unique(array_filter(array_map('strval', $candidateCourses))));

                $selectedProgress = $readProgressNoCreate($courseId);
                $selectedCompletedVideos = is_array($selectedProgress['completed_videos'] ?? null) ? count($selectedProgress['completed_videos']) : 0;
                $selectedCompletedProjects = is_array($selectedProgress['completed_projects'] ?? null) ? count($selectedProgress['completed_projects']) : 0;
                $selectedTestAttempts = is_array($selectedProgress['test_attempts'] ?? null) ? count($selectedProgress['test_attempts']) : 0;
                $selectedProjectCount = $countProjectsNoCreate($courseId);
                $currentChapter = max(1, (int)($selectedProgress['current_chapter'] ?? 1));

                $completedVideos = 0;
                $completedProjects = 0;
                $testAttempts = 0;
                $projectCount = 0;
                $maxChapter = $currentChapter;
                $activeCourses = [];
                foreach ($candidateCourses as $cid) {
                    $progress = $readProgressNoCreate($cid);
                    $courseVideos = is_array($progress['completed_videos'] ?? null) ? count($progress['completed_videos']) : 0;
                    $courseProjects = is_array($progress['completed_projects'] ?? null) ? count($progress['completed_projects']) : 0;
                    $courseAttempts = is_array($progress['test_attempts'] ?? null) ? count($progress['test_attempts']) : 0;
                    $courseProjectCount = $countProjectsNoCreate($cid);
                    $courseChapter = max(1, (int)($progress['current_chapter'] ?? 1));
                    $completedVideos += $courseVideos;
                    $completedProjects += $courseProjects;
                    $testAttempts += $courseAttempts;
                    $projectCount += $courseProjectCount;
                    $maxChapter = max($maxChapter, $courseChapter);
                    if ($courseChapter > 1 || $courseVideos > 0 || $courseProjects > 0 || $courseAttempts > 0 || $courseProjectCount > 0) {
                        $activeCourses[] = $cid;
                    }
                }

                $selectedHasActivity = $currentChapter > 1
                    || $selectedCompletedVideos > 0
                    || $selectedCompletedProjects > 0
                    || $selectedTestAttempts > 0
                    || $selectedProjectCount > 0;
                $hasActivity = $trainingComplete
                    || $selectedHasActivity
                    || $maxChapter > 1
                    || $completedVideos > 0
                    || $completedProjects > 0
                    || $testAttempts > 0
                    || $projectCount > 0;

                if ($selectedHasActivity) {
                    $activityLabel = 'Chapter ' . $currentChapter;
                } elseif ($trainingComplete) {
                    $activityLabel = 'Training complete';
                } elseif (!empty($activeCourses)) {
                    $activityLabel = 'Active in another curriculum';
                } else {
                    $activityLabel = 'Not started';
                }

                $students[] = [
                    'email' => $email,
                    'name' => $u['name'] ?? 'Unknown',
                    'current_chapter' => $currentChapter,
                    'has_activity' => $hasActivity,
                    'activity_label' => $activityLabel,
                    'training_complete' => $trainingComplete,
                    'seen_tutorial' => $seenTutorial,
                    'activity_counts' => [
                        'completed_videos' => $completedVideos,
                        'completed_projects' => $completedProjects,
                        'test_attempts' => $testAttempts,
                        'tutorial_projects' => $projectCount,
                        'selected_completed_videos' => $selectedCompletedVideos,
                        'selected_completed_projects' => $selectedCompletedProjects,
                        'selected_test_attempts' => $selectedTestAttempts,
                        'selected_tutorial_projects' => $selectedProjectCount
                    ],
                    'last_active' => 'Unknown'
                ];
            }
        echo json_encode(['success' => true, 'students' => $students]);
        exit;
    }

    if ($action === 'fetch_student_details') {
        if (empty($myPerms['manage_tutorials'])) die(json_encode(['error' => 'Unauthorized']));
        $courseId = portalNormalizeTutorialCourseId(tutorialCourseIdFromRequest());

        $email = $_POST['email'] ?? '';

        $progress = fm_tutorial_read_progress($courseId, (string)$email);

        $projects = [];
        foreach (fm_tutorial_list_user_projects((string)$email, $courseId) as $project) {
            $id = (string)($project['id'] ?? $project['folder'] ?? '');
            if ($id === '') continue;
            $safeUser = fm_tutorial_safe_user($email);
            $thumbBase = "tutorials/users/$safeUser/courses/$courseId/projects/$id";
            $projects[] = [
                'id' => $id,
                'address' => $project['address'] ?? '',
                'status' => $project['status'] ?? '',
                'score' => is_numeric($project['tutorial_score'] ?? null) ? (float)$project['tutorial_score'] : null,
                'score_status' => $project['tutorial_score_status'] ?? 'calculating',
                'scored_at' => $project['tutorial_scored_at'] ?? null,
                'grading_version' => $project['tutorial_grading_version'] ?? ($project['tutorial_score_details']['grading_version'] ?? null),
                'tutorial_kind' => $project['tutorial_kind'] ?? 'practice',
                'test_attempt_id' => $project['test_attempt_id'] ?? null,
                'test_title' => $project['test_title'] ?? null,
                'sequence_index' => $project['test_sequence_index'] ?? ($project['draft_reject_sequence_index'] ?? null),
                'sequence_total' => $project['test_sequence_total'] ?? ($project['draft_reject_sequence_total'] ?? null),
                'updated_at' => $project['app_metadata']['last_saved'] ?? ($project['updated_at'] ?? ($project['created_at'] ?? '')),
                'thumbnail' => $thumbBase . "/google.png",
                'master_id' => $project['source_project_id'] ?? ($project['original_master_id'] ?? null)
            ];
        }

        echo json_encode(['success' => true, 'progress' => $progress, 'projects' => $projects]);
        exit;
    }

    if ($action === 'fetch_tutorial_project_audit') {
        if (empty($myPerms['manage_tutorials'])) die(json_encode(['error' => 'Unauthorized']));
        $courseId = portalNormalizeTutorialCourseId(tutorialCourseIdFromRequest());
        $email = (string)($_POST['email'] ?? '');
        $tutorialId = (string)($_POST['tutorial_id'] ?? $_POST['project_id'] ?? '');
        echo json_encode(fm_tutorial_project_grading_audit($courseId, $email, $tutorialId));
        exit;
    }

    if ($action === 'fetch_tutorial_exam_grade_categories') {
        if (empty($myPerms['manage_tutorials'])) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $courseId = portalNormalizeTutorialCourseId(tutorialCourseIdFromRequest());
        $requested = json_decode((string)($_POST['projects'] ?? '[]'), true);
        if (!is_array($requested)) $requested = [];
        $results = [];
        $seen = [];
        foreach (array_slice($requested, 0, 10) as $item) {
            if (!is_array($item)) continue;
            $email = strtolower(trim((string)($item['email'] ?? '')));
            $tutorialId = fm_tutorial_sanitize_project_id($item['tutorial_id'] ?? '');
            if ($email === '' || !fm_tutorial_is_tutorial_project_id($tutorialId)) continue;
            $key = $email . '|' . $tutorialId;
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            try {
                $found = fm_tutorial_find_project($tutorialId, $email, $courseId);
                if (!$found) {
                    $results[$key] = ['success' => false, 'score' => null, 'categories' => []];
                    continue;
                }
                $storedDetails = is_array($found['manifest']['tutorial_score_details'] ?? null)
                    ? $found['manifest']['tutorial_score_details']
                    : [];
                $storedCategories = is_array($storedDetails['categories'] ?? null) ? $storedDetails['categories'] : [];
                if ($storedCategories) {
                    $results[$key] = [
                        'success' => true,
                        'score' => $found['manifest']['tutorial_score'] ?? ($storedDetails['score'] ?? null),
                        'categories' => $storedCategories
                    ];
                    continue;
                }
                $audit = fm_tutorial_project_grading_audit($courseId, $email, $tutorialId);
                $results[$key] = [
                    'success' => !empty($audit['success']),
                    'score' => $audit['current_score']['score'] ?? null,
                    'categories' => is_array($audit['categories'] ?? null) ? $audit['categories'] : []
                ];
            } catch (Throwable $error) {
                $results[$key] = ['success' => false, 'score' => null, 'categories' => []];
            }
        }
        echo json_encode(['success' => true, 'projects' => $results]);
        exit;
    }

    echo json_encode(['error' => 'Unknown action']);
    exit;
}

$ver = time(); // cache busting
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Mate - Dashboard</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">

    <!-- Google Maps Places Library -->
    <?php if ($GOOGLE_BROWSER_API_KEY !== ''): ?>
    <script async defer src="https://maps.googleapis.com/maps/api/js?key=<?=htmlspecialchars(rawurlencode($GOOGLE_BROWSER_API_KEY), ENT_QUOTES, 'UTF-8')?>&libraries=places&callback=initMapsCallback"></script>
    <?php endif; ?>

    <style>
        :root {
            --primary: #d93025;
            --primary-light: #fce8e6;
            --bg-page: #f0f2f5;
            --bg-panel: #ffffff;
            --text-main: #202124;
            --text-muted: #5f6368;
            --border: #dadce0;
            --sidebar-width: 190px;
        }

        body {
            background: var(--bg-page);
            color: var(--text-main);
            font-family: 'Segoe UI', Roboto, sans-serif;
            margin: 0; padding: 0;
            height: 100vh; display: flex; overflow: hidden;
        }

        /* SIDEBAR */
        .sidebar {
            width: var(--sidebar-width); background: var(--bg-panel);
            border-right: 1px solid var(--border);
            display: flex; flex-direction: column; z-index: 10;
            flex: 0 0 var(--sidebar-width);
            transition: transform 260ms cubic-bezier(.2,.9,.2,1), flex-basis 260ms cubic-bezier(.2,.9,.2,1);
            overflow: hidden;
        }
        .logo-area {
            height: 72px; display: flex; align-items: center; gap: 8px;
            padding: 0 18px; border-bottom: 1px solid var(--border);
            font-size: 17px; font-weight: 800; color: var(--primary);
        }

        /* Next in Queue button zone */
        .queue-cta-wrap {
            padding: 10px 14px;
            border-bottom: 1px solid var(--border);
            background: #fff;
        }
        .btn-queue {
            width: 100%;
            border: 1px solid var(--primary);
            background: var(--primary);
            color: #fff;
            padding: 10px 12px;
            border-radius: 8px;
            font-weight: 800;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: 0.2s;
            box-shadow: 0 2px 8px rgba(217,48,37,0.15);
        }
        .btn-queue:hover { background: #b0261e; }
        .btn-queue:disabled,
        .btn-queue.disabled {
            background: #f1f3f4;
            border-color: #dadce0;
            color: #9aa0a6;
            cursor: not-allowed;
            box-shadow: none;
        }
        .queue-sub {
            margin-top: 6px;
            font-size: 10px;
            color: #80868b;
            display: flex;
            justify-content: space-between;
            gap: 8px;
        }
        .queue-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #f8f9fa;
            border: 1px solid #eee;
            border-radius: 999px;
            padding: 2px 6px;
            font-weight: 700;
            color: #5f6368;
        }
        .queue-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #34a853;
        }
        .queue-dot.empty { background: #9aa0a6; }

        .nav-links { flex: 1; padding: 14px 12px; display: flex; flex-direction: column; gap: 3px; }
        .nav-btn {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 12px; border-radius: 7px;
            background: transparent; border: none;
            color: var(--text-muted); font-weight: 600; font-size: 13px;
            cursor: pointer; transition: 0.2s; text-align: left; text-decoration: none;
        }
        .nav-btn:hover { background: #f1f3f4; color: var(--text-main); }
        .nav-btn.active { background: var(--primary-light); color: var(--primary); }
        .nav-btn i { width: 18px; text-align: center; font-size: 12px; }

        .user-panel {
            padding: 14px 16px; border-top: 1px solid var(--border);
            font-size: 11px; color: var(--text-muted); line-height: 1.4;
        }
        .user-name { display: block; font-size: 13px; color: var(--text-main); margin-bottom: 2px; }
        .user-email { display: block; font-size: 10px; color: var(--text-muted); word-break: break-word; }
        .user-signout { display: inline-block; margin-top: 8px; color: var(--primary); text-decoration: none; font-weight: 600; font-size: 11px; }
        .user-pill {
            display: inline-block; padding: 2px 8px; border-radius: 12px;
            background: #eee; font-weight: 700; font-size: 10px;
            text-transform: uppercase; margin-top: 5px;
        }

        /* MAIN AREA */
        .main-content {
            flex: 1;
            padding: 0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            position: relative;
            min-width: 0;
            box-sizing: border-box;
            transition: padding 260ms cubic-bezier(.2,.9,.2,1);
        }
        body.qa-editor-fullscreen .sidebar {
            display: none;
            flex-basis: 0;
            width: 0;
            min-width: 0;
            border-right: 0;
            pointer-events: none;
            transform: translateX(calc(-1 * var(--sidebar-width) - 2px));
        }
        body.qa-editor-fullscreen .main-content {
            position: fixed;
            inset: 0;
            z-index: 20;
            flex: none;
            width: 100vw;
            max-width: none;
            height: 100vh;
            padding: 0;
            margin: 0;
            overflow: hidden;
            background: #fff;
        }
        body.qa-editor-fullscreen #portalPluginViews {
            flex: 1 1 auto;
            min-width: 0;
            min-height: 0;
            width: 100%;
            height: 100%;
            padding: 0;
            margin: 0;
            overflow: hidden;
            background: #fff;
        }
        body.qa-editor-fullscreen #portalStatusBarMount {
            display: none !important;
            position: static !important;
            width: 0 !important;
            height: 0 !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
        }
        .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; gap: 15px; }
        h1 { margin: 0; font-size: 24px; color: #202124; }

        /* FILTERS */
        .filter-group { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 4px; display: flex; }
        .filter-btn {
            padding: 8px 16px; border: none; background: transparent;
            font-weight: 600; font-size: 13px; color: var(--text-muted);
            border-radius: 6px; cursor: pointer; transition: 0.2s;
        }
        .filter-btn.active { background: var(--bg-page); color: var(--text-main); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }

        /* GRID TILES */
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
        .tile {
            background: white; border-radius: 12px; overflow: hidden;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05); border: 1px solid var(--border);
            cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
            display: flex; flex-direction: column; position: relative;
        }
        .tile:hover { transform: translateY(-3px); box-shadow: 0 10px 20px rgba(0,0,0,0.1); }

        .tile-thumb { height: 160px; background: #eee; position: relative; }
        .tile-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .tile-badge-stack {
            position: absolute; display: flex; flex-direction: column; gap: 6px;
            z-index: 5; pointer-events: none;
        }
        .tile-badge-stack.top-right { top: 10px; right: 10px; align-items: flex-end; }
        .tile-badge-stack.top-left { top: 10px; left: 10px; align-items: flex-start; }
        .tile-badge-stack.bottom-right { bottom: 10px; right: 10px; align-items: flex-end; }
        .tile-badge-stack.bottom-left { bottom: 10px; left: 10px; align-items: flex-start; }
        .badge {
            position: static; padding: 4px 10px;
            border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2); color: #fff;
            z-index: 5; margin: 0; max-width: 140px;
        }
        .badge-complexity {
            position: static; padding: 4px 10px;
            border-radius: 20px; font-size: 9px; font-weight: 700; text-transform: uppercase;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2); color: #fff; z-index: 5; margin: 0;
        }
        .bg-simple { background: #34a853; }
        .bg-complex { background: #d93025; }
        .bg-queued { background: #fbbc04; color: #333; }
        .bg-processing { background: #4285f4; }
        .bg-ready { background: #34a853; }
        .bg-review { background: #ea4335; }
        .bg-cancelled { background: #5f6368; }
        .bg-tutorial { background: #673ab7; }

        .tile-content { padding: 15px; flex: 1; display: flex; flex-direction: column; }
        .tile-addr { font-weight: 700; font-size: 14px; margin-bottom: 5px; line-height: 1.4; }
        .tile-meta { font-size: 12px; color: #777; margin-bottom: 10px; }

        .chap-desc {
            color: #666;
            margin-bottom: 8px;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        /* MODALS */
        .modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 2000; display: none;
            align-items: center; justify-content: center; backdrop-filter: blur(3px);
        }
        .modal-card {
            background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            display: flex; flex-direction: column; overflow: hidden; max-height: 90vh;
        }
        .md-user { width: min(1000px, calc(100vw - 40px)); }
        .md-project { width: 900px; height: 80vh; }
        .md-editor { width: 1200px; height: 90vh; }
        .md-student { width: 1000px; height: 85vh; }

        .modal-header { padding: 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { margin: 0; font-size: 18px; }
        .modal-body { padding: 25px; overflow-y: auto; flex: 1; }
        .modal-footer { padding: 20px; border-top: 1px solid #eee; background: #fafafa; display: flex; justify-content: flex-end; gap: 10px; }

        /* PROJECT DETAILS */
        .proj-layout { display: flex; height: 100%; }
        .proj-meta { width: 300px; border-right: 1px solid #eee; padding-right: 25px; display: flex; flex-direction: column; }
        .proj-gallery { flex: 1; padding-left: 25px; overflow-y: auto; }
        .meta-group { margin-bottom: 20px; }
        .meta-label { font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase; margin-bottom: 4px; }
        .meta-val { font-size: 14px; color: #333; }
        .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 15px; }
        .gal-item { border: 1px solid #eee; border-radius: 8px; overflow: hidden; aspect-ratio: 1; background: #f9f9f9; }
        .gal-item a { display: block; width: 100%; height: 100%; }
        .gal-item img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }

        /* FORMS */
        .presets { display: flex; gap: 10px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .btn-preset { flex: 1; padding: 10px; border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
        .btn-preset:hover { background: #f9f9f9; }
        .perm-sections { display: flex; flex-direction: column; gap: 16px; margin-bottom: 20px; }
        .perm-section { border: 1px solid #e5e7eb; border-radius: 12px; background: #fafbfc; padding: 14px; }
        .perm-section-header { margin-bottom: 12px; }
        .perm-section-title { font-size: 12px; font-weight: 900; color: #1f2937; text-transform: uppercase; letter-spacing: .04em; }
        .perm-section-description { font-size: 12px; color: #667085; margin-top: 4px; line-height: 1.45; }
        .perm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .perm-item { display: flex; gap: 10px; font-size: 13px; color: #333; }
        .perm-item-checkbox { align-items: flex-start; }
        .perm-item-checkbox input { margin-top: 2px; }
        .perm-item-select { flex-direction: column; align-items: stretch; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; }
        .perm-grid-selects { margin-top: 12px; }
        .perm-item-select select { width: 100%; padding: 10px; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; }
        .perm-control-label { font-size: 12px; font-weight: 800; color: #344054; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .03em; }
        .seg-control { display: inline-flex; width: 100%; border: 1px solid #d0d5dd; border-radius: 999px; overflow: hidden; background: #fff; }
        .seg-btn {
            flex: 1; border: 0; border-right: 1px solid #d0d5dd; background: #fff; color: #344054;
            padding: 9px 10px; font-size: 12px; font-weight: 850; cursor: pointer;
        }
        .seg-btn:last-child { border-right: 0; }
        .seg-btn:hover { background: #f8f9fa; }
        .seg-btn.active { background: var(--primary); color: #fff; }
        .seg-hidden { display: none !important; }
        .perm-copy { display: flex; flex-direction: column; gap: 2px; }
        .perm-label { font-weight: 700; color: #1f2937; }
        .perm-help { font-size: 11px; color: #667085; line-height: 1.35; }
        @media (max-width: 860px) { .perm-grid { grid-template-columns: 1fr; } }
        .form-row { margin-bottom: 15px; }
        .form-row label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #777; margin-bottom: 5px; }
        .form-row input, .form-group textarea, .form-row textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
        .form-row label.user-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 0; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 8px; cursor: pointer; }
        .user-switch-copy { min-width: 0; font-size: 13px; font-weight: 700; color: #333; text-transform: none; }
        .user-switch { position: relative; display: inline-flex; width: 46px; height: 26px; flex: 0 0 46px; }
        .form-row .user-switch-input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; opacity: 0; cursor: pointer; }
        .user-switch-slider { position: absolute; inset: 0; border-radius: 999px; background: #cdd3dc; transition: background .18s ease; pointer-events: none; }
        .user-switch-slider::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); transition: transform .18s ease; }
        .user-switch-input:checked + .user-switch-slider { background: var(--primary); }
        .user-switch-input:checked + .user-switch-slider::after { transform: translateX(20px); }
        .user-switch-input:focus-visible + .user-switch-slider { outline: 3px solid rgba(217,48,37,.24); outline-offset: 2px; }

        /* BUTTONS */
        .btn-primary { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .btn-secondary { background: #fff; border: 1px solid #ccc; color: #333; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .btn-danger { background: #fff; border: 1px solid #d93025; color: #d93025; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        .btn-big-edit { background: var(--primary); color: white; border: none; padding: 12px; border-radius: 6px; font-size: 16px; font-weight: 700; width: 100%; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: auto; text-decoration: none; }
        .btn-big-edit:hover { background: #b0261e; }

        /* TUTORIALS */
        .chapter-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; background:white; padding:20px; border-radius:8px; border:1px solid var(--border); box-shadow:0 2px 4px rgba(0,0,0,0.05); }
        .chapter-desc-card {
            background: white; border: 1px solid var(--border); border-radius: 8px;
            box-shadow:0 2px 4px rgba(0,0,0,0.05);
            padding: 14px 20px; margin-bottom: 20px;
            color: #555; line-height: 1.5;
            display: none; white-space: pre-wrap;
        }
        .res-list { display:flex; flex-direction:column; gap:10px; }
        .res-item { display:flex; align-items:center; gap:10px; padding:12px; background:white; border:1px solid #eee; border-radius:6px; text-decoration:none; color:#333; transition:0.2s; }
        .res-item:hover { background:#f8f9fa; border-color:#ccc; transform:translateX(5px); }
        .res-icon { width:30px; text-align:center; color:var(--primary); font-size:16px; }
        .check-icon { margin-left:auto; color:#34a853; }

        .col-3-layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 25px; }
        .col-3-layout > div { min-width: 0; display: flex; flex-direction: column; }
        .col-3-layout .tile, .col-3-layout .res-item { max-width: 100%; }

        .fab-next {
            position: fixed; bottom: 30px; right: 30px;
            background: var(--primary); color: white;
            padding: 15px 30px; border-radius: 50px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            font-weight: bold; font-size: 16px;
            border: none; cursor: pointer;
            transition: transform 0.2s, background 0.2s;
            display: flex; align-items: center; gap: 10px; z-index: 100;
        }
        .fab-next:hover { transform: scale(1.05); background: #b0261e; }

        /* EDITOR */
        .chapter-editor-item { border:1px solid #eee; padding:20px; margin-bottom:15px; background:#f9f9f9; border-radius:8px; }
        .resource-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: center; }
        .resource-row input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
        .resource-row .status { width: 120px; font-size: 11px; color: #666; text-align: center; }
        .pagination { display: flex; gap: 5px; align-items: center; flex:1; }
        .page-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: white; font-weight: bold; color: #555; }
        .page-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
        .page-btn:hover:not(.active) { background: #eee; }

        /* TABLES */
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        th { background: #f8f9fa; padding: 12px 15px; text-align: left; font-size: 12px; color: #555; text-transform: uppercase; border-bottom: 1px solid #eee; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; font-size: 13px; }
        tr:hover td { background:#f9f9f9; }

        /* QUEUE ADMIN VIEW */
        .queue-panel { background:#fff; border:1px solid var(--border); border-radius:12px; padding:18px; box-shadow:0 2px 5px rgba(0,0,0,0.05); }
        .queue-head { display:flex; justify-content:space-between; align-items:center; gap:15px; margin-bottom:14px; }
        .queue-title { font-weight:900; letter-spacing:0.2px; }
        .queue-team-filter { display:flex; gap:8px; align-items:center; }
        .queue-team-filter select {
            padding:8px 10px; border-radius:8px; border:1px solid var(--border);
            font-weight:700; font-size:12px; color:#444; background:#fff;
        }
        .queue-section { margin-top:18px; }
        .queue-section h3 { margin:0 0 8px 0; font-size:13px; color:#444; display:flex; align-items:center; gap:8px; }
        .hscroll {
            display:flex; gap:12px; overflow-x:auto; padding:8px 2px 10px 2px;
            scroll-snap-type:x proximity;
        }
        .hscroll::-webkit-scrollbar { height: 8px; }
        .hscroll::-webkit-scrollbar-thumb { background:#dadce0; border-radius:999px; }
        .qcard {
            min-width: 280px; max-width: 280px;
            border:1px solid #eee; border-radius:12px;
            background:#fff; padding:12px;
            box-shadow:0 2px 8px rgba(0,0,0,0.04);
            scroll-snap-align:start;
            cursor:pointer;
            transition: transform 0.15s, box-shadow 0.15s;
        }
        .qcard:hover { transform: translateY(-2px); box-shadow:0 10px 20px rgba(0,0,0,0.08); }
        .qcard.qcard--age-warning {
            background:#fff3e0;
            border-color:#e37400;
            box-shadow:0 8px 18px rgba(227, 116, 0, 0.16);
        }
        .qcard.qcard--age-critical {
            background:#fce8e6;
            border-color:#d93025;
            box-shadow:0 8px 18px rgba(217, 48, 37, 0.18);
        }
        .qcard.qcard--age-warning .qline2,
        .qcard.qcard--age-warning .qt-age,
        .qcard.qcard--age-warning .qstage-age { color:#9b6700 !important; }
        .qcard.qcard--age-critical .qline2,
        .qcard.qcard--age-critical .qt-age,
        .qcard.qcard--age-critical .qstage-age { color:#a50e0e !important; }
        .qline1 { font-weight:900; font-size:13px; line-height:1.3; margin-bottom:6px; }
        .qline2 { font-size:12px; color:#666; display:flex; justify-content:space-between; gap:10px; }
        .qmeta { font-size:11px; color:#888; margin-top:8px; display:flex; gap:10px; flex-wrap:wrap; }
        .qtag { background:#f8f9fa; border:1px solid #eee; padding:2px 8px; border-radius:999px; font-weight:800; color:#5f6368; }
        .qtag.red { border-color:#fce8e6; background:#fce8e6; color:#b0261e; }
        .qtag.blue { border-color:#e8f0fe; background:#e8f0fe; color:#1a73e8; }
        .qtag.green { border-color:#e6f4ea; background:#e6f4ea; color:#137333; }
        .qtag.gray { border-color:#dadce0; background:#f1f3f4; color:#3c4043; }
        .qempty { color:#9aa0a6; font-style:italic; padding:10px 2px; }

        /* APPLE KEY PANEL */
        .panel-card {
            background:#fff;
            border:1px solid var(--border);
            border-radius:12px;
            padding:18px;
            box-shadow:0 2px 5px rgba(0,0,0,0.05);
            max-width: 900px;
        }
        .apple-alert {
            display:none;
            align-items:flex-start;
            gap:10px;
            border:1px solid #fbbc04;
            background:#fff7e0;
            color:#7a4b00;
            padding:12px 14px;
            border-radius:10px;
            margin-bottom:14px;
            font-weight:700;
            font-size:13px;
        }
        .apple-alert.show { display:flex; }
        .apple-ok {
            display:none;
            align-items:center;
            gap:10px;
            border:1px solid #c8e6c9;
            background:#e8f5e9;
            color:#137333;
            padding:10px 12px;
            border-radius:10px;
            margin-bottom:14px;
            font-weight:800;
            font-size:13px;
        }
        .apple-ok.show { display:flex; }
        .apple-kv {
            display:grid;
            grid-template-columns: 220px 1fr;
            gap:10px 14px;
            font-size:13px;
            align-items:center;
        }
        .apple-kv .k { color:#666; font-weight:900; text-transform:uppercase; font-size:11px; }
        .apple-kv .v { color:#202124; font-weight:700; }
        .apple-key-value {
            display:flex;
            align-items:center;
            gap:10px;
            min-width:0;
        }
        .apple-key-value .mono {
            flex:1;
            min-width:0;
            overflow-wrap:anywhere;
        }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; }
        .apple-row { display:flex; gap:10px; align-items:center; margin-top:14px; }
        .apple-row input {
            flex:1; padding:12px 12px;
            border-radius:10px; border:1px solid #ccc;
            font-size:13px;
        }
        .btn-inline {
            display:inline-flex; align-items:center; gap:8px;
            padding:12px 14px; border-radius:10px;
            border:1px solid var(--border);
            background:#fff; font-weight:900; cursor:pointer;
        }
        .btn-inline:disabled {
            opacity:.55;
            cursor:not-allowed;
        }
        .btn-inline.primary {
            background: var(--primary);
            border-color: var(--primary);
            color:#fff;
        }
        .btn-inline.primary:disabled {
            background:#f1f3f4;
            border-color:#dadce0;
            color:#9aa0a6;
            cursor:not-allowed;
        }
        .small-note { color:#777; font-size:12px; margin-top:8px; }

        /* DEBUGGING VIEW */
        .debug-shell {
            display:flex;
            flex-direction:column;
            gap:18px;
        }
        .debug-hero {
            position:relative;
            overflow:hidden;
            background:
                radial-gradient(circle at top right, rgba(163, 230, 53, 0.18), transparent 32%),
                radial-gradient(circle at bottom left, rgba(15, 118, 110, 0.14), transparent 36%),
                linear-gradient(135deg, #0f172a 0%, #12324a 52%, #1f6f78 100%);
            color:#f8fafc;
            border-radius:18px;
            padding:26px 28px;
            box-shadow:0 16px 34px rgba(15, 23, 42, 0.18);
        }
        .debug-hero::after {
            content:"";
            position:absolute;
            inset:auto -60px -60px auto;
            width:220px;
            height:220px;
            border-radius:999px;
            background:rgba(255,255,255,0.06);
            filter:blur(4px);
        }
        .debug-hero-top {
            position:relative;
            z-index:1;
            display:flex;
            justify-content:space-between;
            gap:18px;
            align-items:flex-start;
            flex-wrap:wrap;
        }
        .debug-eyebrow {
            display:inline-flex;
            align-items:center;
            gap:8px;
            padding:6px 10px;
            border-radius:999px;
            background:rgba(255,255,255,0.12);
            font-size:11px;
            font-weight:900;
            letter-spacing:.08em;
            text-transform:uppercase;
            margin-bottom:12px;
        }
        .debug-hero h1 {
            margin:0 0 10px;
            font-size:30px;
            line-height:1.05;
            letter-spacing:-0.03em;
        }
        .debug-hero p {
            margin:0;
            max-width:760px;
            color:rgba(248, 250, 252, 0.86);
            font-size:14px;
            line-height:1.6;
        }
        .debug-hero-actions {
            position:relative;
            z-index:1;
            display:flex;
            gap:10px;
            align-items:center;
            flex-wrap:wrap;
            justify-content:flex-end;
        }
        .btn-debug-run {
            display:inline-flex;
            align-items:center;
            gap:10px;
            border:none;
            border-radius:12px;
            padding:13px 18px;
            background:#d7f36b;
            color:#163127;
            font-weight:900;
            cursor:pointer;
            box-shadow:0 10px 24px rgba(215, 243, 107, 0.18);
        }
        .btn-debug-run:disabled {
            opacity:0.6;
            cursor:not-allowed;
            box-shadow:none;
        }
        .debug-subtabs {
            display:flex;
            gap:10px;
            flex-wrap:wrap;
        }
        .debug-subtab {
            border:1px solid #d8e4e7;
            background:#fff;
            color:#274255;
            border-radius:999px;
            padding:11px 16px;
            font-weight:900;
            cursor:pointer;
            transition:all .16s ease;
        }
        .debug-subtab.active {
            background:#12324a;
            border-color:#12324a;
            color:#fff;
            box-shadow:0 10px 20px rgba(18, 50, 74, 0.16);
        }
        .debug-panel {
            background:#fff;
            border:1px solid #e7edf0;
            border-radius:18px;
            padding:20px;
            box-shadow:0 10px 24px rgba(15, 23, 42, 0.06);
        }
        .debug-options {
            display:flex;
            gap:12px;
            align-items:center;
            flex-wrap:wrap;
        }
        .debug-option {
            display:inline-flex;
            align-items:center;
            gap:10px;
            padding:11px 14px;
            background:#f7fafb;
            border:1px solid #d9e6ea;
            border-radius:12px;
            font-size:13px;
            font-weight:700;
            color:#284255;
        }
        .debug-option input {
            width:16px;
            height:16px;
        }
        .debug-status-banner {
            display:none;
            align-items:center;
            gap:12px;
            padding:13px 16px;
            border-radius:14px;
            border:1px solid #d9e6ea;
            background:#f7fafb;
            color:#284255;
            font-weight:700;
        }
        .debug-status-banner.show { display:flex; }
        .debug-status-banner.success {
            display:flex;
            background:#e8f7ee;
            border-color:#cde8d7;
            color:#166534;
        }
        .debug-status-banner.error {
            display:flex;
            background:#fff1f1;
            border-color:#f2cccc;
            color:#b42318;
        }
        .debug-status-banner.info {
            display:flex;
            background:#eef6ff;
            border-color:#cfe0f5;
            color:#1d4f91;
        }
        .debug-metrics {
            display:grid;
            grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
            gap:14px;
        }
        .debug-metric {
            border-radius:16px;
            padding:18px;
            background:linear-gradient(180deg, #ffffff 0%, #f8fbfc 100%);
            border:1px solid #dfe9ec;
        }
        .debug-metric .label {
            font-size:11px;
            font-weight:900;
            letter-spacing:.08em;
            text-transform:uppercase;
            color:#6b7f89;
            margin-bottom:8px;
        }
        .debug-metric .value {
            font-size:32px;
            line-height:1;
            font-weight:900;
            color:#102a43;
            margin-bottom:6px;
        }
        .debug-metric .meta {
            font-size:12px;
            color:#5b7080;
            font-weight:700;
        }
        .debug-grid {
            display:grid;
            grid-template-columns:minmax(0, 1.5fr) minmax(300px, 1fr);
            gap:18px;
        }
        .debug-card-title {
            display:flex;
            justify-content:space-between;
            align-items:center;
            gap:12px;
            margin-bottom:14px;
        }
        .debug-card-title h3 {
            margin:0;
            font-size:17px;
            color:#102a43;
        }
        .debug-card-title span {
            font-size:12px;
            color:#5b7080;
            font-weight:700;
        }
        .debug-table-wrap {
            overflow:auto;
            border:1px solid #e2ebee;
            border-radius:14px;
        }
        .debug-table {
            width:100%;
            border-collapse:collapse;
            min-width:860px;
            background:#fff;
        }
        .debug-table th,
        .debug-table td {
            padding:12px 14px;
            border-bottom:1px solid #edf2f4;
            text-align:left;
            vertical-align:top;
            font-size:13px;
        }
        .debug-table th {
            background:#f6fafb;
            color:#48606d;
            font-size:11px;
            font-weight:900;
            letter-spacing:.08em;
            text-transform:uppercase;
        }
        .debug-table tr:last-child td { border-bottom:none; }
        .debug-endpoint {
            display:flex;
            flex-direction:column;
            gap:4px;
        }
        .debug-endpoint code {
            font-size:12px;
            color:#102a43;
            font-weight:700;
        }
        .debug-endpoint small {
            color:#6b7f89;
            font-size:11px;
        }
        .debug-pill {
            display:inline-flex;
            align-items:center;
            gap:6px;
            border-radius:999px;
            padding:5px 10px;
            font-size:11px;
            font-weight:900;
            letter-spacing:.04em;
            text-transform:uppercase;
        }
        .debug-pill.pass { background:#e8f7ee; color:#166534; }
        .debug-pill.warn { background:#fff4db; color:#8a5200; }
        .debug-pill.fail { background:#fde8e8; color:#b42318; }
        .debug-pill.skip { background:#edf2f7; color:#475467; }
        .debug-issues,
        .debug-log {
            display:flex;
            flex-direction:column;
            gap:10px;
        }
        .debug-issue,
        .debug-log-item {
            border:1px solid #e2ebee;
            border-radius:14px;
            padding:14px;
            background:#fff;
        }
        .debug-issue.fail { border-color:#f1c2c0; background:#fff6f5; }
        .debug-issue.warn { border-color:#f2d9a6; background:#fffaf1; }
        .debug-issue-head,
        .debug-log-head {
            display:flex;
            justify-content:space-between;
            gap:12px;
            align-items:flex-start;
            margin-bottom:8px;
        }
        .debug-issue-head strong,
        .debug-log-head strong {
            color:#102a43;
            font-size:13px;
        }
        .debug-issue-body,
        .debug-log-body {
            color:#52697a;
            font-size:12px;
            line-height:1.6;
            white-space:pre-wrap;
            word-break:break-word;
        }
        .debug-empty {
            text-align:center;
            padding:26px 18px;
            border:1px dashed #d6e3e8;
            border-radius:14px;
            color:#6b7f89;
            background:#fbfdfe;
            font-size:13px;
            font-weight:700;
        }
        .debug-coming-soon {
            display:grid;
            grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
            gap:16px;
        }
        .debug-tools-grid {
            display:grid;
            grid-template-columns:minmax(0, 1.15fr) minmax(300px, 0.85fr);
            gap:18px;
        }
        .debug-tool-card {
            border-radius:18px;
            border:1px solid #dce8eb;
            background:
                radial-gradient(circle at top right, rgba(215, 243, 107, 0.24), transparent 34%),
                linear-gradient(180deg, #ffffff 0%, #f7fbfc 100%);
            padding:22px;
        }
        .debug-tool-head {
            display:flex;
            justify-content:space-between;
            gap:18px;
            align-items:flex-start;
            flex-wrap:wrap;
            margin-bottom:12px;
        }
        .debug-tool-head h3 {
            margin:0 0 8px;
            color:#102a43;
            font-size:22px;
        }
        .debug-tool-head p {
            margin:0;
            max-width:680px;
            color:#536b7a;
            font-size:13px;
            line-height:1.6;
        }
        .debug-tool-eyebrow {
            display:inline-flex;
            align-items:center;
            gap:8px;
            margin-bottom:10px;
            padding:6px 10px;
            border-radius:999px;
            background:#eaf3f5;
            color:#295066;
            font-size:11px;
            font-weight:900;
            letter-spacing:.08em;
            text-transform:uppercase;
        }
        .debug-tool-actions {
            display:flex;
            gap:10px;
            flex-wrap:wrap;
        }
        .btn-debug-secondary {
            display:inline-flex;
            align-items:center;
            gap:9px;
            border:1px solid #cfdfe5;
            border-radius:12px;
            padding:12px 16px;
            background:#fff;
            color:#17354a;
            font-weight:800;
            cursor:pointer;
        }
        .btn-debug-secondary:disabled,
        .btn-debug-run:disabled {
            opacity:0.6;
            cursor:not-allowed;
            box-shadow:none;
        }
        .debug-soon-card {
            border-radius:18px;
            padding:22px;
            border:1px solid #dce8eb;
            background:linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(245,250,251,0.98) 100%);
        }
        .debug-soon-card h3 {
            margin:0 0 10px;
            color:#102a43;
            font-size:18px;
        }
        .debug-soon-card p {
            margin:0;
            color:#5b7080;
            line-height:1.6;
            font-size:13px;
        }
        .debug-muted {
            color:#5b7080;
            font-size:12px;
            font-weight:700;
        }
        @media (max-width: 1100px) {
            .debug-grid {
                grid-template-columns:1fr;
            }
            .debug-tools-grid {
                grid-template-columns:1fr;
            }
        }
        @media (max-width: 700px) {
            .debug-hero {
                padding:22px 20px;
            }
            .debug-hero h1 {
                font-size:24px;
            }
            .debug-subtabs,
            .debug-options,
            .debug-hero-actions {
                width:100%;
            }
            .btn-debug-run {
                width:100%;
                justify-content:center;
            }
        }
    </style>
</head>
<body>

    <!-- SIDEBAR -->
    <div class="sidebar">
        <div class="logo-area">
            <img src="/images/logo_red.png" alt="First Mate" height="34"
                onerror="this.style.display='none'; document.getElementById('logoTxt').style.display='block';">
            <span id="logoTxt" style="display:none;">First Mate</span>
        </div>

        <!-- Next in Queue -->
        <div class="queue-cta-wrap">
            <button id="btnNextQueue" class="btn-queue" onclick="handleNextInQueueClick()" disabled>
                <i class="fas fa-forward"></i> Next in Queue
            </button>

            <div class="queue-sub">
                <span class="queue-pill">
                    <span id="queueDot" class="queue-dot empty"></span>
                    <span id="queueCountText">Queue: …</span>
                </span>
                <span id="queueHint">Checking…</span>
            </div>
        </div>

        <div class="nav-links">
            <?php if ($showProductionDashboard): ?>
            <button class="nav-btn <?= $defaultView === 'dashboard' ? 'active' : '' ?>" onclick="switchView('dashboard', this)" id="navDashboardBtn">
                <i class="fas fa-gauge-high"></i> Dashboard
            </button>
            <?php endif; ?>

            <?php if (!$isDraftingTechnician): ?>
            <button class="nav-btn <?= $defaultView === 'projects' ? 'active' : '' ?>" onclick="switchView('projects', this)" id="navProjectsBtn">
                <i class="fas fa-th-large"></i> Project Browser
            </button>
            <?php endif; ?>

            <?php if ($isQueueAdmin): ?>
            <button class="nav-btn" onclick="switchView('queue', this)" id="navQueueBtn">
                <i class="fas fa-stream"></i> Queue
            </button>
            <?php endif; ?>

            <?php if ($isAppleKeyAdmin): ?>
            <button class="nav-btn" onclick="switchView('apple-key', this)" id="navAppleKeyBtn">
                <i class="fas fa-apple-alt"></i> Apple Key
            </button>
            <?php endif; ?>

            <button class="nav-btn" onclick="switchView('tutorials', this)">
                <i class="fas fa-graduation-cap"></i> Tutorials
            </button>

            <?php if (!empty($myPerms['manage_users']) || !empty($myPerms['manage_sales_users']) || !empty($myPerms['create_users'])): ?>
            <button class="nav-btn" onclick="switchView('users', this)">
                <i class="fas fa-users-cog"></i> Users & Teams
            </button>
            <?php endif; ?>

            <?php if ($canDebugFirstMeasure): ?>
            <button class="nav-btn" onclick="switchView('debugging', this)" id="navDebuggingBtn">
                <i class="fas fa-stethoscope"></i> Debugging
            </button>
            <?php endif; ?>

            <!-- PLUGIN NAV ITEMS INSERT HERE (one-time, stable) -->
            <div id="portalPluginNav"></div>

            <div style="flex:1"></div>
            <a href="editor.php" class="nav-btn">
                <i class="fas fa-edit"></i> Editor
            </a>
        </div>

        <div class="user-panel">
            <strong class="user-name"><?= htmlspecialchars($currentUserName) ?></strong>
            <span class="user-email"><?= htmlspecialchars($currentUserEmail) ?></span>
            <a href="backend_logout.php" class="user-signout">Sign Out</a>
        </div>
    </div>

    <!-- MAIN CONTENT -->
    <div class="main-content">
        <div id="portalStatusBarMount"></div>

        <?php if ($showProductionDashboard): ?>
        <!-- PRODUCTION DASHBOARD VIEW -->
        <div id="view-dashboard" style="<?= $defaultView === 'dashboard' ? '' : 'display:none;' ?>">
            <div class="header-bar">
                <h1>Dashboard</h1>
                <div style="display:flex; align-items:center; gap:10px;">
                    <label for="dashboardTeamSelect" style="font-size:11px; font-weight:900; color:#667085; text-transform:uppercase; letter-spacing:.04em;">Team</label>
                    <select id="dashboardTeamSelect" style="min-width:180px; padding:9px 34px 9px 11px; border:1px solid #d4dae6; border-radius:8px; background:#fff; color:#202124; font-size:12px; font-weight:800;">
                        <option value="all">All Teams</option>
                    </select>
                    <button class="btn-secondary" id="technicianDashboardRefreshBtn">
                        <i class="fas fa-sync"></i> Refresh
                    </button>
                </div>
            </div>
            <?php if ($showShiftDashboard): ?>
            <div class="sh-section dashboard-shift-section">
                <div class="sh-section-header">
                    <div>
                        <div class="sh-section-title sh-dashboard-title"><i class="fas fa-broadcast-tower" style="color:#34a853;"></i> Active Production</div>
                    </div>
                </div>
                <div id="shiftStatusBody" class="sh-section-body">
                    <div class="sh-empty">Loading...</div>
                </div>
            </div>
            <?php endif; ?>
            <?php if ($isDraftingTechnician): ?>
            <div id="technicianDashboardActiveMount"></div>
            <?php endif; ?>
            <div id="technicianDashboardLeaderboardMount"></div>
        </div>
        <?php endif; ?>

        <!-- PROJECT VIEW -->
        <div id="view-projects" style="<?= $defaultView === 'projects' ? '' : 'display:none;' ?>">
            <div class="header-bar">
                <h1>Projects</h1>
                <div class="filter-group" id="filterContainer"></div>
            </div>
            <div class="grid" id="projectsGrid"></div>
        </div>

        <!-- QUEUE VIEW (ADMIN) -->
        <?php if ($isQueueAdmin): ?>
        <div id="view-queue" style="display:none;">
            <div class="header-bar">
                <h1>Queue Monitor</h1>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="queue-team-filter">
                        <span style="font-size:12px; color:#666; font-weight:800;">Team</span>
                        <select id="queueTeamSelect" onchange="refreshQueueAdmin(true)"></select>
                    </div>
                    <button class="btn-secondary" onclick="refreshQueueAdmin(true)"><i class="fas fa-sync"></i> Refresh</button>
                </div>
            </div>

            <div class="queue-panel">
                <div class="queue-head">
                    <div class="queue-title">Live overview</div>
                    <div style="font-size:12px; color:#666; font-weight:800;" id="queueAdminStatus">…</div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-layer-group" style="color:#fbbc04;"></i> Queued (not started)</h3>
                    <div class="hscroll" id="qRowQueued"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-person-digging" style="color:#1a73e8;"></i> In Progress</h3>
                    <div class="hscroll" id="qRowInProgress"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-clipboard-check" style="color:#b0261e;"></i> In QA</h3>
                    <div class="hscroll" id="qRowQA"></div>
                </div>

                <div class="queue-section">
                    <h3>
                        <span><i class="fas fa-calendar-day" style="color:#137333;"></i> Completed Today</span>
                        <select id="completedTodayPriorityFilter" class="q-priority-filter" title="Filter completed projects by priority">
                            <option value="all">All</option>
                            <option value="1">P1</option>
                            <option value="2">P2</option>
                            <option value="3">P3</option>
                        </select>
                    </h3>
                    <div class="grid" id="qCompletedGrid" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:16px;"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-ban" style="color:#b0261e;"></i> Rejected</h3>
                    <div class="hscroll" id="qRowRejected"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-circle-xmark" style="color:#5f6368;"></i> Cancelled</h3>
                    <div class="hscroll" id="qRowCancelled"></div>
                </div>
            </div>
        </div>
        <?php endif; ?>

        <!-- APPLE KEY VIEW -->
        <?php if ($isAppleKeyAdmin): ?>
        <div id="view-apple-key" style="display:none;">
            <div class="header-bar">
                <h1>Apple Maps Key</h1>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="refreshAppleKey(true)"><i class="fas fa-sync"></i> Refresh</button>
                </div>
            </div>

            <div class="panel-card">
                <div id="appleWarn" class="apple-alert">
                    <i class="fas fa-triangle-exclamation" style="margin-top:2px;"></i>
                    <div>
                        <div>Key looks stale (over 25 minutes old).</div>
                        <div style="font-weight:600; font-size:12px; opacity:0.9;">Apple keys expire at ~30 minutes. Set a fresh one now.</div>
                    </div>
                </div>

                <div id="appleOk" class="apple-ok">
                    <i class="fas fa-circle-check"></i>
                    <div>Key age is under 25 minutes.</div>
                </div>

                <div class="apple-kv">
                    <div class="k">Status</div>
                    <div class="v" id="appleStatusText">Loading…</div>

                    <div class="k">Updated (UTC)</div>
                    <div class="v mono" id="appleUpdatedUtc">—</div>

                    <div class="k">Age</div>
                    <div class="v" id="appleAge">—</div>

                    <div class="k">Key</div>
                    <div class="v apple-key-value">
                        <span class="mono" id="appleKeyMasked">—</span>
                        <button id="btnAppleCopy" class="btn-inline" onclick="copyAppleKey()" disabled>
                            <i class="fas fa-copy"></i> Copy
                        </button>
                    </div>

                    <div class="k">Maps tile version</div>
                    <div class="v mono" id="appleTileVersionCurrent">—</div>
                </div>

                <div class="apple-row">
                    <input id="appleKeyInput" class="mono" placeholder="Paste Apple Maps accessKey here (exact string)…" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <button id="btnAppleSave" class="btn-inline primary" onclick="saveAppleKey()">
                        <i class="fas fa-save"></i> Save Key
                    </button>
                </div>

                <div class="apple-row">
                    <input id="appleTileVersionInput" class="mono" type="number" min="1" max="999999999" step="1" inputmode="numeric" placeholder="Maps tile version">
                    <button id="btnAppleTileVersionSave" class="btn-inline primary" onclick="saveAppleTileVersion()">
                        <i class="fas fa-save"></i> Save Tile Version
                    </button>
                </div>

                <div class="small-note">
                    Tip: You can paste a new key anytime. The tile version is the number sent as <span class="mono">v</span> with Apple Maps tile requests.
                </div>
            </div>
        </div>
        <?php endif; ?>

        <!-- TUTORIALS VIEW -->
        <div id="view-tutorials" style="display:none;">
            <div class="header-bar">
                <h1 id="tutorialCourseTitle">Training Curriculum</h1>
                <div style="display:flex; gap:10px;">
                    <?php if(!empty($myPerms['manage_tutorials'])): ?>
                        <select id="tutorialCourseSelect" onchange="setTutorialCourse(this.value)" style="padding:10px 12px; border:1px solid #d0d5dd; border-radius:8px; font-weight:700; background:#fff;">
                            <?php foreach ($tutorialCourseOptions as $course): ?>
                                <option value="<?php echo htmlspecialchars($course['id'], ENT_QUOTES); ?>" <?php echo $course['id'] === $myTutorialCourseId ? 'selected' : ''; ?>>
                                    <?php echo htmlspecialchars($course['label'], ENT_QUOTES); ?>
                                </option>
                            <?php endforeach; ?>
                        </select>
                        <button class="btn-secondary" onclick="openStudentProgress()">
                            <i class="fas fa-chart-line"></i> Student Progress
                        </button>
                        <button class="btn-secondary" onclick="openCurriculumManager()">
                            <i class="fas fa-layer-group"></i> Advanced
                        </button>
                        <button class="btn-secondary" onclick="openEditor()">
                            <i class="fas fa-edit"></i> Edit Curriculum
                        </button>
                    <?php endif; ?>
                </div>
            </div>

            <div id="chapterGrid" class="grid"></div>

            <div id="chapterDetail" style="display:none;">
                <button onclick="showChapterGrid()" style="margin-bottom:15px; background:none; border:none; color:#666; cursor:pointer; font-weight:600;">
                    <i class="fas fa-arrow-left"></i> Back to Chapters
                </button>

                <div class="chapter-header">
                    <h2 id="chapTitle" style="margin:0;">Chapter 1</h2>
                    <span id="chapProgress" style="background:#e8f0fe; color:#1a73e8; padding:4px 10px; border-radius:12px; font-size:12px; font-weight:bold;">—</span>
                </div>

                <div id="chapDescCard" class="chapter-desc-card"></div>

                <div class="col-3-layout">
                    <div>
                        <h3><i class="fas fa-video" style="color:#555;"></i> Videos</h3>
                        <div id="resList" class="res-list"></div>
                    </div>

                    <div>
                        <h3><i class="fas fa-file-pdf" style="color:#555;"></i> Guides</h3>
                        <div id="guideList" class="res-list"></div>
                    </div>

                    <div>
                        <h3><i class="fas fa-project-diagram" style="color:#555;"></i> Hands-on Projects</h3>
                        <div id="projList" class="res-list" style="display:flex; flex-direction:column; gap:15px;"></div>
                    </div>
                </div>

                <button class="fab-next" onclick="completeChapter()" id="btnNextChapter">
                    Next Chapter <i class="fas fa-arrow-right"></i>
                </button>
            </div>
        </div>

        <!-- STUDENT PROGRESS VIEW -->
        <div id="view-student-progress" style="display:none;">
            <div class="header-bar">
                <div style="display:flex; align-items:center; gap:15px;">
                    <button class="btn-secondary" onclick="switchView('tutorials')" title="Back"><i class="fas fa-arrow-left"></i></button>
                    <h1>Student Progress</h1>
                </div>
                <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                    <label style="display:inline-flex; align-items:center; gap:8px; font-size:12px; font-weight:800; color:#344054; background:#fff; border:1px solid #e6e8ef; border-radius:8px; padding:9px 11px;">
                        <input type="checkbox" id="tutorialShowUnstartedStudents" onchange="fetchStudentList()" style="width:16px; height:16px; margin:0;">
                        Show not started
                    </label>
                    <button class="btn-secondary" onclick="fetchStudentList()"><i class="fas fa-sync"></i> Refresh</button>
                </div>
            </div>
            <div id="studentProgressSummary" style="margin:-8px 0 12px; font-size:12px; color:#667085; font-weight:700;"></div>
            <table>
                <thead>
                    <tr>
                        <th>Student Name</th>
                        <th>Email</th>
                        <th>Current Chapter</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody id="studentTable">
                    <tr><td colspan="4" style="text-align:center; padding:30px;">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <!-- USER VIEW -->
        <div id="view-users" style="display:none;">
            <style>
                @media (max-width: 1250px) {
                    #view-users .user-col-secondary { display:none; }
                    #view-users #usersSearchInput { width:clamp(190px, 22vw, 270px) !important; }
                }
                @media (max-width: 900px) {
                    #view-users .user-team-toolbar { flex-wrap:wrap; }
                    #view-users .user-team-toolbar-search { width:100%; margin-left:0 !important; }
                    #view-users #usersSearchInput { width:100% !important; }
                }
            </style>
            <div class="header-bar">
                <h1>User Management</h1>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="fetchUsers()"><i class="fas fa-sync"></i> Refresh</button>
                    <?php if (!empty($myPerms['create_users']) || !empty($myPerms['manage_sales_users'])): ?>
                    <button class="btn-primary" onclick="openUserModal('create')"><i class="fas fa-plus"></i> Add User</button>
                    <?php endif; ?>
                </div>
            </div>
            <div class="panel-card" style="max-width:none; margin-bottom:12px; padding:14px 16px 10px;">
                <div class="user-team-toolbar" style="display:flex; gap:14px; align-items:center;">
                    <div id="usersTeamFilter" class="filter-group" style="flex:1 1 auto; min-width:0; overflow-x:auto; display:flex; flex-wrap:nowrap;">
                        <button class="filter-btn active" type="button" data-user-team="__all_users__">All Users</button>
                        <button class="filter-btn" type="button" data-user-team="">No Team</button>
                    </div>
                    <div class="user-team-toolbar-search" style="display:flex; align-items:center; gap:8px; flex:0 0 auto; margin-left:auto;">
                        <div style="position:relative;">
                            <i class="fas fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#8a9099; font-size:12px;"></i>
                            <input id="usersSearchInput" type="text" placeholder="Search users..." style="width:clamp(220px, 25vw, 300px); padding:10px 12px 10px 34px; border:1px solid #ccc; border-radius:8px;">
                        </div>
                        <button id="usersAddTeamBtn" class="btn-secondary btn-sm" type="button" onclick="openTeamModal('create')"><i class="fas fa-plus"></i> Team</button>
                        <button id="usersEditTeamBtn" class="btn-secondary btn-sm" type="button" onclick="openTeamModal('edit')" style="display:none;" title="Rename team and manage its managers"><i class="fas fa-pen"></i></button>
                    </div>
                </div>
                <div id="usersTeamStats" style="height:34px; margin-top:9px; border-top:1px solid #eceff3; display:flex; align-items:center; gap:22px; color:#5f6368; font-size:12px; font-weight:700;">
                    <span><b id="usersTeamManagerCount">0</b> Managers</span>
                    <span><b id="usersTeamQaCount">0</b> QAs</span>
                    <span><b id="usersTeamTechnicianCount">0</b> Technicians</span>
                    <span id="usersResultSummary" style="margin-left:auto; font-weight:800; color:#666;">Loading...</span>
                </div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th data-user-sort="name" style="cursor:pointer;">Name</th>
                        <th data-user-sort="email" style="cursor:pointer;">Email</th>
                        <th data-user-sort="role" style="cursor:pointer;">Role</th>
                        <th data-user-sort="drafter_rank" style="cursor:pointer;">Level</th>
                        <th class="user-col-secondary" data-user-sort="department" style="cursor:pointer;">Dept</th>
                        <th data-user-sort="team_id" style="cursor:pointer; min-width:170px;">Team</th>
                        <th class="user-col-secondary" data-user-sort="training_complete" style="cursor:pointer;">Training</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody id="usersTable"></tbody>
            </table>
        </div>

        <?php if ($canDebugFirstMeasure): ?>
        <div id="view-debugging" style="display:none;">
            <div class="debug-shell">
                <section class="debug-hero">
                    <div class="debug-hero-top">
                        <div class="debug-hero-actions">
                            <button class="btn-debug-run" id="dbgRunBtn" type="button">
                                <i class="fas fa-play"></i> Run Full Diagnostics
                            </button>
                        </div>
                    </div>
                </section>

                <div class="debug-subtabs" id="dbgSubtabs">
                    <button class="debug-subtab active" type="button" data-debug-tab="projects">
                        <i class="fas fa-diagram-project"></i> Projects
                    </button>
                    <button class="debug-subtab" type="button" data-debug-tab="users">
                        <i class="fas fa-user-group"></i> Users
                    </button>
                    <button class="debug-subtab" type="button" data-debug-tab="organizations">
                        <i class="fas fa-building"></i> Organizations
                    </button>
                    <button class="debug-subtab" type="button" data-debug-tab="tools">
                        <i class="fas fa-wrench"></i> Tools
                    </button>
                </div>

                <section class="debug-panel" id="dbgPanelProjects">
                    <div class="debug-card-title">
                        <h3>Projects Diagnostics</h3>
                        <span id="dbgLastRunLabel">No diagnostics run yet</span>
                    </div>
                    <div class="debug-options" style="margin-bottom:16px;">
                        <label class="debug-option">
                            <input type="checkbox" id="dbgUseServerDebug" checked>
                            Include advanced server debug metadata
                        </label>
                        <label class="debug-option">
                            <input type="checkbox" id="dbgIncludeBinaryChecks" checked>
                            Include PDF, XML, and artifact fetch checks when available
                        </label>
                    </div>
                    <div class="debug-status-banner" id="dbgStatusBanner"></div>
                    <div class="debug-metrics" id="dbgMetrics" style="margin-top:16px;"></div>
                </section>

                <div id="dbgProjectsWorkspace">
                    <div class="debug-grid">
                        <section class="debug-panel">
                            <div class="debug-card-title">
                                <h3>Endpoint Sweep</h3>
                                <span id="dbgSweepMeta">Waiting for first run</span>
                            </div>
                            <div class="debug-table-wrap">
                                <table class="debug-table">
                                    <thead>
                                        <tr>
                                            <th>Endpoint</th>
                                            <th>Result</th>
                                            <th>HTTP</th>
                                            <th>Duration</th>
                                            <th>Highlights</th>
                                        </tr>
                                    </thead>
                                    <tbody id="dbgResultsTable">
                                        <tr>
                                            <td colspan="5">
                                                <div class="debug-empty">Run the diagnostics to test the live FirstMeasure read-only endpoints.</div>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </section>

                        <div style="display:flex; flex-direction:column; gap:18px;">
                            <section class="debug-panel">
                                <div class="debug-card-title">
                                    <h3>Issues & Warnings</h3>
                                    <span id="dbgIssuesMeta">Nothing to review yet</span>
                                </div>
                                <div class="debug-issues" id="dbgIssuesList">
                                    <div class="debug-empty">Failures, skips, and soft warnings will appear here.</div>
                                </div>
                            </section>

                            <section class="debug-panel">
                                <div class="debug-card-title">
                                    <h3>Request Log</h3>
                                    <span id="dbgLogMeta">No request traces yet</span>
                                </div>
                                <div class="debug-log" id="dbgLogList">
                                    <div class="debug-empty">Each diagnostic request will leave a concise trace here.</div>
                                </div>
                            </section>
                        </div>
                    </div>
                </div>

                <section class="debug-panel" id="dbgPanelUsers" style="display:none;">
                    <div class="debug-card-title">
                        <h3>Users Diagnostics</h3>
                        <span>Coming soon</span>
                    </div>
                    <div class="debug-coming-soon">
                        <div class="debug-soon-card">
                            <h3>API Coverage Next</h3>
                            <p>The current FirstMeasure API does not expose a dedicated read-only users surface yet, so this tab is staged for the later user-focused diagnostics pass.</p>
                        </div>
                        <div class="debug-soon-card">
                            <h3>Planned Scope</h3>
                            <p>This will eventually validate identity payloads, actor-scoped queue context, and any future user endpoints with the same request-by-request reporting used in Projects.</p>
                        </div>
                    </div>
                </section>

                <section class="debug-panel" id="dbgPanelOrganizations" style="display:none;">
                    <div class="debug-card-title">
                        <h3>Organizations Diagnostics</h3>
                        <span>Coming soon</span>
                    </div>
                    <div class="debug-coming-soon">
                        <div class="debug-soon-card">
                            <h3>Waiting On Endpoints</h3>
                            <p>Organization data is still managed outside the standalone FirstMeasure API, so there are no true read-only org endpoints to sweep yet.</p>
                        </div>
                        <div class="debug-soon-card">
                            <h3>Future Checks</h3>
                            <p>When those routes exist, this tab can test branding defaults, organization references, report settings handoff, and API-side permission boundaries.</p>
                        </div>
                    </div>
                </section>

                <section class="debug-panel" id="dbgPanelTools" style="display:none;">
                    <div class="debug-card-title">
                        <h3>Manual Tools</h3>
                        <span id="dbgToolsMeta">Index status has not been loaded yet</span>
                    </div>
                    <div class="debug-tools-grid">
                        <div class="debug-tool-card">
                            <div class="debug-tool-head">
                                <div>
                                    <div class="debug-tool-eyebrow"><i class="fas fa-database"></i> SQLite Index</div>
                                    <h3>Rebuild the FirstMeasure project index</h3>
                                    <p>
                                        Runs the same FirstMeasure SQLite index rebuild used by the development console.
                                        This rescans manifests on disk and refreshes the indexed data that powers project search,
                                        queue overview compatibility, and the project browser.
                                    </p>
                                </div>
                                <div class="debug-tool-actions">
                                    <button class="btn-debug-secondary" id="dbgRefreshIndexStatusBtn" type="button">
                                        <i class="fas fa-rotate"></i> Refresh Status
                                    </button>
                                    <button class="btn-debug-run" id="dbgRebuildIndexBtn" type="button">
                                        <i class="fas fa-arrows-rotate"></i> Rebuild Index
                                    </button>
                                </div>
                            </div>
                            <div class="debug-status-banner" id="dbgToolsBanner"></div>
                            <div class="debug-metrics" id="dbgToolsMetrics" style="margin-top:16px;"></div>
                        </div>

                        <section class="debug-panel">
                            <div class="debug-card-title">
                                <h3>Tool Activity</h3>
                                <span id="dbgToolLogMeta">No tool activity yet</span>
                            </div>
                            <div class="debug-log" id="dbgToolLogList">
                                <div class="debug-empty">Refresh the index status or run a rebuild to leave an operator trace here.</div>
                            </div>
                        </section>
                    </div>
                </section>
            </div>
        </div>
        <?php endif; ?>

        <!-- PLUGIN VIEWS INSERT HERE (one-time, stable) -->
        <div id="portalPluginViews"></div>

    </div>

    <!-- STUDENT DETAIL MODAL -->
    <div class="modal-overlay" id="studentModal">
        <div class="modal-card md-student">
            <div class="modal-header">
                <h2 id="stModalTitle">Student Details</h2>
                <button onclick="closeModal('studentModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div style="display:grid; grid-template-columns: 1fr 2fr; gap:20px; height:100%;">
                    <div style="background:#f9f9f9; padding:20px; border-radius:8px;">
                        <h3 style="margin-top:0;">Progress</h3>
                        <div class="meta-group">
                            <div class="meta-label">Current Chapter</div>
                            <div class="meta-val" id="stCurrentChap" style="font-size:18px; font-weight:bold; color:var(--primary);"></div>
                        </div>
                        <hr>
                        <h4>Video Watch History</h4>
                        <div id="stVideoList" class="res-list" style="max-height:400px; overflow-y:auto;"></div>
                    </div>

                    <div style="display:flex; flex-direction:column;">
                        <h3 style="margin-top:0;">Started Projects</h3>
                        <p style="font-size:12px; color:#777; margin-bottom:15px;">These are the specific instances created by this student. Click to review or edit their work.</p>
                        <div id="stProjectGrid" class="grid" style="grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));"></div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="closeModal('studentModal')">Close</button>
            </div>
        </div>
    </div>

    <!-- EDITOR MODAL -->
    <div class="modal-overlay" id="editorModal">
        <div class="modal-card md-editor">
            <div class="modal-header">
                <h2 id="editorCourseTitle">Curriculum Editor</h2>
                <button onclick="closeModal('editorModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div id="editorContent"></div>
            </div>
            <div class="modal-footer">
                <div id="paginationCtr" class="pagination"></div>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="addEditorChapter()">+ New Chapter</button>
                    <button class="btn-primary" onclick="saveCurriculum()">Save Curriculum</button>
                </div>
            </div>
        </div>
    </div>

    <!-- PROJECT DETAILS MODAL -->
    <div class="modal-overlay" id="projModal">
        <div class="modal-card md-project">
            <div class="modal-header">
                <h2>Project Details</h2>
                <button onclick="closeModal('projModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body" style="padding:0;">
                <div class="proj-layout">
                    <div class="proj-meta" style="padding:25px; background:#f9f9f9;">
                        <div class="meta-group">
                            <div class="meta-label">Address</div>
                            <div class="meta-val" id="pmAddress"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Status</div>
                            <div class="meta-val" id="pmStatus"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Owner</div>
                            <div class="meta-val" id="pmOwner"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Date Created</div>
                            <div class="meta-val" id="pmDate"></div>
                        </div>

                        <div style="margin-top:auto; display:flex; gap:10px; flex-direction:column;">
                            <a href="#" target="_blank" id="pmPdfBtn" class="btn-secondary" style="text-align:center; text-decoration:none; gap: 10px;">
                                <i class="fas fa-file-pdf"></i> Download PDF
                            </a>
                            <button class="btn-big-edit" id="pmEditBtn">
                                <i class="fas fa-edit"></i> Editor
                            </button>
                        </div>
                    </div>
                    <div class="proj-gallery" style="padding:25px;">
                        <h3 style="margin-top:0; font-size:14px; color:#555;">Project Assets</h3>
                        <div class="gallery-grid" id="pmGallery"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- TEAM MODAL -->
    <div class="modal-overlay" id="teamModal">
        <div class="modal-card" style="width:min(520px, calc(100vw - 32px));">
            <div class="modal-header">
                <h2 id="teamModalTitle">Add Team</h2>
                <button onclick="closeModal('teamModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <form id="teamForm">
                    <input type="hidden" id="teamMode" value="create">
                    <div class="form-row">
                        <label for="teamName">Team Name</label>
                        <input type="text" id="teamName" maxlength="100" placeholder="Usually the manager's name" required>
                    </div>
                    <div class="form-row">
                        <label for="teamManagers">Managers <span style="font-weight:normal; text-transform:none; color:#777;">(optional; select one or more)</span></label>
                        <select id="teamManagers" multiple size="6" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:6px;"></select>
                    </div>
                    <div style="font-size:11px; line-height:1.5; color:#777;">Managers selected here will be moved into this team. Other managers, QAs, and technicians can be added from the Team dropdown in the user list.</div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="closeModal('teamModal')">Cancel</button>
                <button class="btn-primary" id="teamSaveBtn" onclick="saveTeam()">Save Team</button>
            </div>
        </div>
    </div>

    <!-- USER MODAL -->
    <div class="modal-overlay" id="userModal">
        <div class="modal-card md-user">
            <div class="modal-header">
                <h2 id="uModalTitle">Edit User</h2>
                <button onclick="closeModal('userModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <form id="userForm">
                    <input type="hidden" id="uMode">
                    <div class="form-row"><label>Email</label><input type="email" id="uEmail" required></div>
                    <div class="form-row"><label>Full Name</label><input type="text" id="uName"></div>
                    <div class="form-row"><label>Password <span style="font-weight:normal; font-size:10px;">(Leave blank to keep existing)</span></label><input type="text" id="uPass"></div>
                    <div class="form-row"><label>Team</label><select id="uTeam" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px;"><option value="">No Team</option></select></div>
                    <div class="form-row">
                        <label>User Department</label>
                        <select id="uDepartment" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="production">Production</option>
                            <option value="sales">Sales</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label>Queue Priority</label>
                        <select id="uComplexityPref" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="all">No Preference (FIFO)</option>
                            <option value="simple">Prioritize Simple</option>
                            <option value="complex">Prioritize Complex</option>
                        </select>
                    </div>
                    <div class="form-row" id="uDrafterRankRow">
                        <label>Drafter Rank</label>
                        <select id="uDrafterRank" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="junior">Junior</option>
                            <option value="standard">Standard</option>
                            <option value="senior">Senior</option>
                        </select>
                    </div>
                    <div class="form-row" id="uPriorityEligibilityRow">
                        <label>Priority Eligibility</label>
                        <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px;">
                            <label class="user-switch-row">
                                <span class="user-switch-copy">Eligible for P1</span>
                                <span class="user-switch">
                                    <input class="user-switch-input" type="checkbox" role="switch" id="uP1Eligible">
                                    <span class="user-switch-slider" aria-hidden="true"></span>
                                </span>
                            </label>
                            <label class="user-switch-row">
                                <span class="user-switch-copy">Eligible for P2</span>
                                <span class="user-switch">
                                    <input class="user-switch-input" type="checkbox" role="switch" id="uP2Eligible">
                                    <span class="user-switch-slider" aria-hidden="true"></span>
                                </span>
                            </label>
                        </div>
                        <div id="uPriorityEligibilityHint" style="font-size:11px; color:#777; margin-top:6px; line-height:1.4;"></div>
                    </div>
                    <div class="form-row">
                        <label>QA Review Level</label>
                        <label class="user-switch-row">
                            <span class="user-switch-copy">Trainee QA — send every approved project to manager review</span>
                            <span class="user-switch">
                                <input class="user-switch-input" type="checkbox" role="switch" id="uQaTrainee">
                                <span class="user-switch-slider" aria-hidden="true"></span>
                            </span>
                        </label>
                    </div>
                    
                    <div class="form-row">
                        <label>Queue Mode (Hot Swapping)</label>
                        <select id="uQueueMode" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="disabled">Disabled (Standard)</option>
                            <option value="wait_for_feedback">Wait for Feedback</option>
                            <option value="hot_swap">Hot Swapping Enabled</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label for="uShiftRate">Shift Rate (PHP/day)</label>
                        <input type="number" id="uShiftRate" min="0" max="100000" step="1" value="940" class="form-control" placeholder="940">
                    </div>
                    
                    <div class="form-row">
                        <label>Training Complete</label>
                        <label style="display:flex; align-items:left; gap:10px; font-size:13px; text-transform:none; font-weight:700; color:#333; margin:0;">
                            <input type="checkbox" id="uTrainingComplete" style="width: 20px;">
                            Training complete. Approved for live system use.
                        </label>
                        <div style="font-size:11px; color:#777; margin-top:6px;">
                            Set manually by admin only. Not set automatically when chapters are finished.
                        </div>
                    </div>

                    <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#777; margin-bottom:5px;">Permissions Preset</label>
                    <div class="presets">
                        <button type="button" class="btn-preset" onclick="applyPreset('admin')">Admin</button>
                        <button type="button" class="btn-preset" onclick="applyPreset('lead')">Team Lead</button>
                        <button type="button" class="btn-preset" onclick="applyPreset('user')">User</button>
                    </div>

                    <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#777; margin-bottom:5px;">Detailed Permissions</label>
                    <?php echo permissionOptionsRenderHtml(); ?>
                    <input type="hidden" id="uRoleLabel">
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn-danger" id="btnDeleteUser" style="margin-right:auto; display:none;" onclick="deleteUser()">Delete</button>
                <button class="btn-secondary" id="btnImpersonateUser" style="display:none;" onclick="impersonateInternalUser()">Impersonate</button>
                <button class="btn-secondary" onclick="closeModal('userModal')">Cancel</button>
                <button class="btn-primary" id="uSaveUserBtn" type="button" onclick="saveUser()">Save User</button>
            </div>
        </div>
    </div>

<script>
    const FIRSTMEASURE_API_BASE_RAW = <?php echo json_encode(rtrim((string)fm_api_base_url(), '/')); ?>;
    const FIRSTMEASURE_API_BASE = (() => {
        const raw = String(FIRSTMEASURE_API_BASE_RAW || '').replace(/\/+$/, '');
        if (!raw) return `${location.origin}/v1/firstmeasure`;
        const pageHost = String(location.hostname || '').toLowerCase();
        const pageIsLocal = pageHost === '127.0.0.1' || pageHost === 'localhost';
        try {
            const parsed = new URL(raw, location.origin);
            const apiIsLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
            if (apiIsLocal && !pageIsLocal) {
                return `${location.origin}/v1/firstmeasure`;
            }
        } catch (e) {
            return `${location.origin}/v1/firstmeasure`;
        }
        return raw;
    })();
    window.FIRSTMEASURE_API_BASE = FIRSTMEASURE_API_BASE;
    const V1_API_BASE = String(FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
    const INTERNAL_API_BASE = `${V1_API_BASE}/internal`;
    const INTERNAL_LEGACY_ACTION_URL = `${INTERNAL_API_BASE}/legacy-action`;
    window.__APP = Object.assign({}, window.__APP || {}, {
        platformApiBase: `${V1_API_BASE}/platform`,
        userEmail: <?php echo json_encode($currentUserEmail); ?>,
        userName: <?php echo json_encode($currentUserName); ?>,
        userOrgId: <?php echo json_encode($myUserData['organization_id'] ?? ($_SESSION['user_org_id'] ?? '')); ?>,
        userTeamId: <?php echo json_encode($myTeam); ?>,
        userBranchId: <?php echo json_encode($_SESSION['platform_branch_id'] ?? ($_SESSION['branch_id'] ?? 'default')); ?>
    });

    window.PORTAL_CFG = {
        endpoints: {
            portal: INTERNAL_LEGACY_ACTION_URL,
            server: INTERNAL_LEGACY_ACTION_URL,
            firstmeasure: FIRSTMEASURE_API_BASE,
            internal: INTERNAL_API_BASE,
            platform: `${V1_API_BASE}/platform`,
            crm: `${V1_API_BASE}/internal/crm`,
            crm_referrals: `${V1_API_BASE}/internal/crm/referrals`,
            data_agent: INTERNAL_LEGACY_ACTION_URL
        },
        tutorials: {
            course_id: <?php echo json_encode($myTutorialCourseId); ?>,
            default_course_id: <?php echo json_encode($myTutorialCourseId); ?>,
            course_options: <?php echo json_encode(array_values($tutorialCourseOptions)); ?>,
            projects_enabled: true,
            label: 'Training Curriculum'
        },
        permission_model: <?php echo json_encode(permissionOptionsFrontendModel('all')); ?>,
        report_settings: <?php echo json_encode($portalGlobalReportSettings); ?>,
        perms: <?php echo json_encode($myPerms); ?>,
        user: {
            email: <?php echo json_encode($currentUserEmail); ?>,
            name:  <?php echo json_encode($currentUserName); ?>,
            organization_id: <?php echo json_encode($myUserData['organization_id'] ?? ($_SESSION['user_org_id'] ?? '')); ?>,
            branch_id: <?php echo json_encode($_SESSION['platform_branch_id'] ?? ($_SESSION['branch_id'] ?? 'default')); ?>,
            role:  <?php echo json_encode($myUserData['role'] ?? 'user'); ?>,
            team_id: <?php echo json_encode($myTeam); ?>,
            drafter_rank: <?php echo json_encode($myUserData['drafter_rank'] ?? 'junior'); ?>,
            queue_mode: <?php echo json_encode($myUserData['queue_mode'] ?? 'disabled'); ?>,
            training_complete: <?php echo $myTrainingComplete ? 'true' : 'false'; ?>,
            is_admin: <?php echo (($myUserData['role'] ?? '') === 'admin' || !empty($myUserData['is_admin'])) ? 'true' : 'false'; ?>
        },
        impersonation: {
            active: <?php echo !empty($_SESSION['is_impersonating']) ? 'true' : 'false'; ?>,
            admin_email: <?php echo json_encode($_SESSION['impersonating_from_email'] ?? ''); ?>,
            admin_name: <?php echo json_encode($_SESSION['impersonating_from_name'] ?? ''); ?>,
            started_at: <?php echo json_encode($_SESSION['impersonating_started_at'] ?? ''); ?>
        },
        flags: {
            is_queue_admin: <?php echo $isQueueAdmin ? 'true' : 'false'; ?>,
            is_apple_key_admin: <?php echo $isAppleKeyAdmin ? 'true' : 'false'; ?>,
            can_debug_firstmeasure: <?php echo $canDebugFirstMeasure ? 'true' : 'false'; ?>,
            can_data_agent: <?php echo $canDataAgent ? 'true' : 'false'; ?>,
            can_view_stats: <?php echo $isFullAdmin ? 'true' : 'false'; ?>,
            can_bulk_approve_qa: <?php echo $isFullAdmin ? 'true' : 'false'; ?>,
            is_qa_role: <?php echo $isQaRole ? 'true' : 'false'; ?>,
            is_manager_role: <?php echo ($isManagerRole || portalCanManagerReview($myUserData, $myPerms)) ? 'true' : 'false'; ?>,
            can_view_shift_dashboard: <?php echo $showShiftDashboard ? 'true' : 'false'; ?>,
            can_view_technician_dashboard: <?php echo $showProductionDashboard ? 'true' : 'false'; ?>,
            is_drafting_technician: <?php echo $isDraftingTechnician ? 'true' : 'false'; ?>,
            qa_fix_only_mode: <?php echo (!empty($myUserData['qa_fix_only_mode']) || !empty($myPerms['qa_fix_only_mode']) || !empty($_GET['qa_fix_only'])) ? 'true' : 'false'; ?>
        },
        default_view: <?php echo json_encode($defaultView); ?>,
        rejection_reasons: <?php echo json_encode(function_exists('fm_rejection_reasons') ? fm_rejection_reasons() : []); ?>,
        browser_google_api_key: <?php echo json_encode($GOOGLE_BROWSER_API_KEY); ?>
    };

    // Minimal shared utilities + plugin registry
    window.Portal = {
        cfg: window.PORTAL_CFG,

        qs(sel, root){ return (root||document).querySelector(sel); },
        qsa(sel, root){ return Array.from((root||document).querySelectorAll(sel)); },

        escapeHtml(s){
            return String(s ?? '')
                .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
        },

        isNodeUrl(url){
            const text = String(url || '');
            return !!V1_API_BASE && (text.startsWith(V1_API_BASE) || text.includes('/v1/'));
        },

        internalLegacyEndpoint(){
            const configured = this.cfg && this.cfg.endpoints && this.cfg.endpoints.server;
            if (configured) return configured;
            const firstMeasure = String(this.cfg?.endpoints?.firstmeasure || '').replace(/\/firstmeasure\/?$/, '');
            if (firstMeasure) return `${firstMeasure}/internal/legacy-action`;
            return INTERNAL_LEGACY_ACTION_URL || `${location.origin}/v1/internal/legacy-action`;
        },

        internalActor(){
            const user = (this.cfg && this.cfg.user) || {};
            const flags = (this.cfg && this.cfg.flags) || {};
            const actor = {};
            if (user.id) actor.id = user.id;
            if (user.email) actor.email = user.email;
            if (user.name) actor.name = user.name;
            if (user.role) actor.role = user.role;
            if (user.department) actor.department = user.department;
            if (user.team_id) actor.team_id = user.team_id;
            if (user.organization_id) actor.organization_id = user.organization_id;
            if (user.drafter_rank) actor.drafter_rank = user.drafter_rank;
            const roles = [];
            if (user.role) roles.push(String(user.role).toLowerCase());
            if (user.is_admin) roles.push('admin');
            if (flags.is_queue_admin) roles.push('queue_admin');
            if (flags.is_manager_role) roles.push('manager');
            if (flags.is_qa_role) roles.push('qa');
            if (roles.length) actor.roles = Array.from(new Set(roles.filter(Boolean)));
            return actor;
        },

        async apiPost(url, payload){
            const outgoing = Object.assign({}, payload || {});
            const isNode = this.isNodeUrl(url);
            if (isNode && String(url || '').includes('/v1/internal/legacy-action') && !outgoing.actor) {
                outgoing.actor = this.internalActor();
            }
            const init = isNode
                ? {
                    method: 'POST',
                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify(outgoing)
                }
                : (() => {
                    const fd = new FormData();
                    Object.entries(outgoing).forEach(([k, v]) => fd.append(k, v));
                    return { method: 'POST', body: fd };
                })();
            if (window.INTERNAL_LEGACY_ACTION_DEBUG && isNode && String(url || '').includes('/v1/internal/legacy-action')) {
                try {
                    console.log('[InternalLegacyAction]', {
                        action: outgoing.action || '',
                        actor_email: outgoing.actor && outgoing.actor.email ? outgoing.actor.email : '',
                        has_actor: !!outgoing.actor
                    });
                } catch (_) {}
            }
            const res = await fetch(url, init);
            const text = await res.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : {};
            } catch (err) {
                const snippet = String(text || '').trim().slice(0, 240);
                throw new Error(`Server returned invalid JSON (${res.status}). ${snippet || 'Empty response.'}`);
            }
            if (!res.ok && (!data || typeof data !== 'object')) {
                throw new Error(`Request failed (${res.status}).`);
            }
            return data;
        },

        fmUrl(path){
            const base = String((this.cfg.endpoints && this.cfg.endpoints.firstmeasure) || '').replace(/\/+$/, '');
            const suffix = String(path || '').replace(/^\/+/, '');
            return `${base}/${suffix}`;
        },

        async fmJson(path, options = {}){
            const init = Object.assign({
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }, options || {});

            if (init.headers && !(init.headers instanceof Headers)) {
                init.headers = Object.assign({ 'Accept': 'application/json' }, init.headers);
            }

            const res = await fetch(this.fmUrl(path), init);
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch (err) {
                const snippet = String(text || '').trim().slice(0, 240);
                throw new Error(`FirstMeasure returned invalid JSON (${res.status}). ${snippet || 'Empty response.'}`);
            }
            if (!res.ok || (data && typeof data === 'object' && data.ok === false)) {
                const error = new Error((data && (data.message || data.error)) || `FirstMeasure request failed (${res.status}).`);
                error.status = res.status;
                error.data = data;
                error.endpoint = this.fmUrl(path);
                throw error;
            }
            return data;
        },

        async fmPost(path, payload){
            return await this.fmJson(path, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload || {})
            });
        },

        openModal(id){ const el = document.getElementById(id); if (el) el.style.display='flex'; },
        closeModal(id){ const el = document.getElementById(id); if (el) el.style.display='none'; },

        plugins: [],
        _hasUserNavigated: false,
        _applyingStartupView: false,
        _currentView: '',

        registerPlugin(plugin){
            // plugin: { id, title, iconClass }
            this.plugins.push(plugin);

            const navHost = document.getElementById('portalPluginNav');
            if (!navHost) return;

            const btn = document.createElement('button');
            btn.className = 'nav-btn';
            btn.id = `nav-${plugin.id}`;
            btn.innerHTML = `<i class="${plugin.iconClass || 'fas fa-puzzle-piece'}"></i> ${plugin.title || plugin.id}`;
            btn.onclick = () => this.switchView(plugin.id, btn);
            navHost.appendChild(btn);
        },

        async switchView(id, btn){
            if (!this._applyingStartupView) this._hasUserNavigated = true;
            this._currentView = id;

            // nav active
            this.qsa('.nav-btn').forEach(b => b.classList.remove('active'));
            if (btn) btn.classList.add('active');

            // hide ALL views (built-in + plugins)
            document.querySelectorAll('[id^="view-"]').forEach(el => el.style.display = 'none');

            // stop built-in timers
            if (window.Projects && Projects.stopTimers) Projects.stopTimers();
            if (window.Tutorials && Tutorials.stopTimers) Tutorials.stopTimers();

            // show selected
            const target = document.getElementById('view-' + id);
            if (target) target.style.display = 'block';

            // built-in hooks (plugins can self-hook or monkeypatch switchView)
            if (id === 'users' && window.Users) await Users.onShowUsers();
            if (id === 'dashboard' && window.Projects) await Projects.onShowDashboard();
            if (id === 'projects' && window.Projects) await Projects.onShowProjects();
            if (id === 'tutorials' && window.Tutorials) await Tutorials.onShowTutorials();
            if (id === 'student-progress' && window.Tutorials) await Tutorials.onShowStudentProgress();
            if (id === 'queue' && window.Projects) await Projects.onShowQueue();
            if (id === 'apple-key' && window.Projects) await Projects.onShowAppleKey();
            if (id === 'debugging' && window.Debugging) await Debugging.onShowDebugging();
        },

        init(){
            if (window.Projects && Projects.init) Projects.init();
            if (window.Tutorials && Tutorials.init) Tutorials.init();
            if (window.Users && Users.init) Users.init();
            if (window.Debugging && Debugging.init) Debugging.init();

            const params = new URLSearchParams(window.location.search || '');
            const requestedView = String(params.get('view') || '').trim();
            if (requestedView) {
                setTimeout(() => {
                    if (Portal._hasUserNavigated && Portal._currentView !== requestedView) return;
                    const viewEl = document.getElementById('view-' + requestedView);
                    if (!viewEl) return;
                    const btn = document.getElementById('nav-' + requestedView) ||
                                document.querySelector(`[onclick*="switchView('${requestedView}'"]`);
                    Portal._applyingStartupView = true;
                    Promise.resolve(Portal.switchView(requestedView, btn)).finally(() => {
                        Portal._applyingStartupView = false;
                    });
                }, 0);
                return;
            }

            // Navigate to role-appropriate default view
            const dv = Portal.cfg.default_view || 'projects';
            if (dv !== 'projects') {
                // Defer so plugin scripts' DOMContentLoaded handlers
                // finish registering their views first
                setTimeout(() => {
                    if (Portal._hasUserNavigated && Portal._currentView !== dv) return;
                    const viewEl = document.getElementById('view-' + dv);
                    if (viewEl) {
                        const btn = document.getElementById('nav-' + dv) ||
                                    document.querySelector(`[onclick*="switchView('${dv}'"]`);
                        Portal._applyingStartupView = true;
                        Promise.resolve(Portal.switchView(dv, btn)).finally(() => {
                            Portal._applyingStartupView = false;
                        });
                    }
                    // If the view doesn't exist, projects stays visible as the fallback
                }, 0);
            }
        }
    };

    function initMapsCallback(){ console.log("Maps Loaded for Autocomplete"); }

    function switchView(id, btn){ return Portal.switchView(id, btn); }
    function closeModal(id){ return Portal.closeModal(id); }
    window.openTutorialProjectAudit = function(email, tutorialId){
        if (window.Tutorials && typeof Tutorials.openProjectGradingAudit === 'function') {
            return Tutorials.openProjectGradingAudit(email, tutorialId);
        }
        alert('Tutorial grading audit is still loading. Please try again.');
    };

    document.addEventListener('DOMContentLoaded', () => Portal.init());
</script>

<script src="../../libraries/platform-api/platform-api.js?v=<?=$ver?>"></script>
<script src="portal_scripts/structure_pin_modal.js?v=<?=$ver?>"></script>
<script src="portal_scripts/projects.js?v=<?=$ver?>"></script>
<script src="portal_scripts/tutorials.js?v=<?=$ver?>"></script>
<script src="portal_scripts/users.js?v=<?=$ver?>"></script>
<script src="portal_scripts/debugging.js?v=<?=$ver?>"></script>
<script src="portal_scripts/customers.js?v=<?=$ver?>"></script>
<script src="https://cdn.jsdelivr.net/npm/geotiff"></script>

<!-- Plugin(s) -->
<script src="portal_scripts/filler.js?v=<?=$ver?>"></script>
<script src="portal_scripts/discount_codes.js?v=<?=$ver?>"></script>
<script src="portal_scripts/earnings.js?v=<?=$ver?>"></script> <!-- -->
<script src="portal_scripts/payroll.js?v=<?=$ver?>"></script>
<script src="portal_scripts/qa.js?v=<?=$ver?>"></script>
<script src="portal_scripts/stats.js?v=<?=$ver?>"></script>
<script src="portal_scripts/admin_tools.js?v=<?=$ver?>"></script>
<script src="portal_scripts/api_keys.js?v=<?=$ver?>"></script>
<script src="portal_scripts/feature_flags.js?v=<?=$ver?>"></script>
<script src="portal_scripts/bonus_offers.js?v=<?=$ver?>"></script>
<script src="portal_scripts/acquisition_campaigns.js?v=<?=$ver?>"></script>
<script src="portal_scripts/shifts.js?v=<?=$ver?>"></script>
<script src="portal_scripts/manager_review.js?v=<?=$ver?>"></script>
<script src="portal_scripts/portal_status_bar.js?v=<?=$ver?>"></script>
<?php if ($canDataAgent): ?>
<script src="portal_scripts/data_agent.js?v=<?=$ver?>"></script>
<?php endif; ?>



</body>
</html>
