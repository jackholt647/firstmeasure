<?php
/**
 * /app/server.php
 * Proxy that forwards requests to: /measure/internal/server.php
 *
 * Place this file next to /app/index.php so existing frontend calls like:
 *   fetch('server.php', { method:'POST', body: formData })
 * keep working after moving the frontend to /app.
 */

declare(strict_types=1);

require_once __DIR__ . '/session_bootstrap.php';
portalStartSession();
$SESSION_SNAPSHOT = $_SESSION;
session_write_close();

// --- CONFIG ---
$BACKEND_PATH            = '/measure/internal/server.php'; // web path on same domain
$FIRST_MEASURE_BASE_PATH = '/v1/firstmeasure';
$TIMEOUT_SEC             = 120;
$FEATURE_FLAGS           = [];

$featureFlagsPath = __DIR__ . '/feature_flags.php';
if (is_file($featureFlagsPath)) {
    $loadedFeatureFlags = require $featureFlagsPath;
    if (is_array($loadedFeatureFlags)) {
        $FEATURE_FLAGS = $loadedFeatureFlags;
    }
}

// --- BASIC HARDENING ---
header('X-Proxy: app-server-php');
header('X-Content-Type-Options: nosniff');

function jsonResponse(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function requestMethod(): string
{
    return $_SERVER['REQUEST_METHOD'] ?? 'GET';
}

function sameHostUrl(string $path): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host . $path;
}

function firstMeasureBaseUrl(): string
{
    global $FIRST_MEASURE_BASE_PATH;

    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost') {
        return 'http://127.0.0.1:3111' . $FIRST_MEASURE_BASE_PATH;
    }

    return sameHostUrl($FIRST_MEASURE_BASE_PATH);
}

function currentCookieHeader(): string
{
    return (string)($_SERVER['HTTP_COOKIE'] ?? '');
}

function sessionValue(string $key, $default = '')
{
    global $SESSION_SNAPSHOT;
    return $SESSION_SNAPSHOT[$key] ?? $default;
}

function featureFlagEnabled(string $key, bool $default = true): bool
{
    global $FEATURE_FLAGS;
    return (($FEATURE_FLAGS[$key] ?? $default) !== false);
}

function sendHttpRequest(string $url, string $method = 'GET', ?string $body = null, array $headers = []): array
{
    global $TIMEOUT_SEC;

    if (!function_exists('curl_init')) {
        $context = stream_context_create([
            'http' => [
                'method' => strtoupper($method),
                'timeout' => $TIMEOUT_SEC,
                'ignore_errors' => true,
                'header' => implode("\r\n", $headers),
                'content' => ($body !== null && strtoupper($method) !== 'GET') ? $body : '',
            ],
            'ssl' => [
                'verify_peer' => false,
                'verify_peer_name' => false,
            ],
        ]);
        $resp = @file_get_contents($url, false, $context);
        $status = 0;
        $rawHeaders = '';
        foreach (($http_response_header ?? []) as $line) {
            $rawHeaders .= $line . "\r\n";
            if (preg_match('#^HTTP/\S+\s+(\d+)#', (string)$line, $m)) {
                $status = (int)$m[1];
            }
        }
        return [
            'ok' => $resp !== false,
            'status' => $status,
            'headers_raw' => $rawHeaders,
            'body' => $resp === false ? '' : (string)$resp,
            'error' => $resp === false ? 'stream_request_failed' : null,
        ];
    }

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
    curl_setopt($ch, CURLOPT_TIMEOUT, $TIMEOUT_SEC);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($method));

    if (strtoupper($method) === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
    }
    if ($headers) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    }
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    $resp = curl_exec($ch);
    if ($resp === false) {
        $err = curl_error($ch);
        curl_close($ch);
        return [
            'ok' => false,
            'status' => 0,
            'headers_raw' => '',
            'body' => '',
            'error' => $err,
        ];
    }

    $httpCode   = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    return [
        'ok' => true,
        'status' => $httpCode,
        'headers_raw' => substr($resp, 0, $headerSize),
        'body' => substr($resp, $headerSize),
        'error' => null,
    ];
}

function decodeJsonBody(string $body, string $fallbackMessage): array
{
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) {
        throw new RuntimeException($fallbackMessage);
    }
    return $decoded;
}

function legacyActionJson(string $action, array $fields = []): array
{
    global $BACKEND_PATH;

    if (function_exists('platformCanHandleAction') && function_exists('platformActionJson') && platformCanHandleAction($action)) {
        return [
            'status' => 200,
            'data' => platformActionJson($action, $fields),
        ];
    }

    $headers = [
        'Accept: application/json',
        'Content-Type: application/x-www-form-urlencoded',
    ];
    $cookieHeader = currentCookieHeader();
    if ($cookieHeader !== '') {
        $headers[] = 'Cookie: ' . $cookieHeader;
    }

    $response = sendHttpRequest(
        sameHostUrl($BACKEND_PATH),
        'POST',
        http_build_query(array_merge(['action' => $action], $fields)),
        $headers
    );

    if (!$response['ok']) {
        throw new RuntimeException('Proxy failed: ' . ($response['error'] ?: 'Unknown error'));
    }

    return [
        'status' => $response['status'],
        'data' => decodeJsonBody($response['body'], 'Legacy backend returned invalid JSON.'),
    ];
}

function firstMeasurePostJson(string $path, array $payload): array
{
    $headers = [
        'Accept: application/json',
        'Content-Type: application/json',
    ];
    $cookieHeader = currentCookieHeader();
    if ($cookieHeader !== '') {
        $headers[] = 'Cookie: ' . $cookieHeader;
    }

    $response = sendHttpRequest(
        firstMeasureBaseUrl() . '/' . ltrim($path, '/'),
        'POST',
        json_encode($payload),
        $headers
    );

    if (!$response['ok']) {
        throw new RuntimeException('Proxy failed: ' . ($response['error'] ?: 'Unknown error'));
    }

    $data = decodeJsonBody(
        $response['body'],
        sprintf('FirstMeasure returned invalid JSON (%d).', (int)$response['status'])
    );

    if (
        $response['status'] < 200
        || $response['status'] >= 300
        || (array_key_exists('ok', $data) && $data['ok'] === false)
    ) {
        $message = (string)($data['message'] ?? $data['error'] ?? '');
        throw new RuntimeException($message !== '' ? $message : sprintf('FirstMeasure request failed (%d).', (int)$response['status']));
    }

    return $data;
}

function parseJsonMaybe($value, $fallback)
{
    if (is_array($value)) {
        return $value;
    }
    if (is_object($value)) {
        return (array)$value;
    }

    $raw = trim((string)($value ?? ''));
    if ($raw === '') {
        return $fallback;
    }

    $decoded = json_decode($raw, true);
    return json_last_error() === JSON_ERROR_NONE ? ($decoded ?? $fallback) : $fallback;
}

function asNumberOrNull($value): ?float
{
    $raw = trim((string)($value ?? ''));
    if ($raw === '' || !is_numeric($raw)) {
        return null;
    }
    return (float)$raw;
}

function normalizeProjectType($value): string
{
    $type = strtolower(trim((string)($value ?? 'residential')));
    return $type !== '' ? $type : 'residential';
}

function normalizeReportMode($value): string
{
    $mode = strtolower(trim((string)($value ?? 'full')));
    return in_array($mode, ['full', 'instant', 'both'], true) ? $mode : 'full';
}

function shouldIncludeGutterMeasurements(string $projectType, $value): bool
{
    if ($projectType !== 'residential') {
        return false;
    }

    $normalized = strtolower(trim((string)($value ?? '')));
    return $value === true || $value === 1 || $value === '1' || $normalized === 'true';
}

function currentActorFromSession(): array
{
    $actor = [];

    $email = trim((string)sessionValue('user_email', ''));
    $name  = trim((string)sessionValue('user_name', ''));
    $orgId = trim((string)sessionValue('user_org_id', sessionValue('org_id', '')));
    $teamId = trim((string)sessionValue('user_team_id', sessionValue('team_id', '')));

    if ($email !== '') {
        $actor['email'] = $email;
    }
    if ($name !== '') {
        $actor['name'] = $name;
    }
    if ($orgId !== '') {
        $actor['organization_id'] = $orgId;
    }
    if ($teamId !== '') {
        $actor['team_id'] = $teamId;
    }

    return $actor;
}

function existingOrgProjectCount(array $actor): int
{
    $basePayload = [
        'page' => 1,
        'limit' => 1,
        'include_all' => true,
        'actor' => $actor,
    ];

    $orgCount = 0;
    if (!empty($actor['organization_id'])) {
        $orgData = firstMeasurePostJson('projects/list', $basePayload + ['filter' => 'org']);
        $orgCount = (int)($orgData['pagination']['total_count'] ?? count($orgData['projects'] ?? []));
    }

    $mineCount = 0;
    if (!empty($actor['email'])) {
        $mineData = firstMeasurePostJson('projects/list', $basePayload + ['filter' => 'mine']);
        $mineCount = (int)($mineData['pagination']['total_count'] ?? count($mineData['projects'] ?? []));
    }

    return max($orgCount, $mineCount);
}

function existingOrgCompletedProjectCount(array $actor): int
{
    $basePayload = [
        'page' => 1,
        'limit' => 1,
        'include_all' => true,
        'status_filter' => 'ready',
        'actor' => $actor,
    ];

    $orgCount = 0;
    if (!empty($actor['organization_id'])) {
        $orgData = firstMeasurePostJson('projects/list', $basePayload + ['filter' => 'org']);
        $orgCount = (int)($orgData['pagination']['total_count'] ?? count($orgData['projects'] ?? []));
    }

    $mineCount = 0;
    if (!empty($actor['email'])) {
        $mineData = firstMeasurePostJson('projects/list', $basePayload + ['filter' => 'mine']);
        $mineCount = (int)($mineData['pagination']['total_count'] ?? count($mineData['projects'] ?? []));
    }

    return max($orgCount, $mineCount);
}

function bonusUpfrontMatchPortalTiers(): array
{
    return [
        [
            'id' => 'tier_1',
            'label' => 'Tier 1',
            'customer_pays' => 500,
            'bonus_dollars' => 125,
            'total_account_value' => 625,
            'type' => 'fixed',
        ],
        [
            'id' => 'tier_2',
            'label' => 'Tier 2',
            'customer_pays' => 1000,
            'bonus_dollars' => 500,
            'total_account_value' => 1500,
            'type' => 'fixed',
        ],
        [
            'id' => 'tier_3',
            'label' => 'Tier 3',
            'customer_pays' => 3000,
            'bonus_dollars' => 1500,
            'total_account_value' => 4500,
            'type' => 'fixed',
        ],
    ];
}

function handleBonusUpfrontMatchStatus(): void
{
    $tiers = bonusUpfrontMatchPortalTiers();
    $offerEnabled = featureFlagEnabled('offer_bonus_upfront_match', true);
    if (!$offerEnabled) {
        jsonResponse(200, [
            'success' => true,
            'offer_enabled' => false,
            'show_banner' => false,
            'reason' => 'feature_disabled',
            'tiers' => $tiers,
        ]);
    }

    $actor = currentActorFromSession();
    if (empty($actor['email'])) {
        jsonResponse(401, ['success' => false, 'error' => 'Authentication required.']);
    }

    try {
        $orgResp = legacyActionJson('org_get_my');
    } catch (Throwable $e) {
        jsonResponse(400, ['success' => false, 'error' => $e->getMessage() ?: 'Could not load organization state.']);
    }

    $org = is_array($orgResp['data']['org'] ?? null) ? $orgResp['data']['org'] : [];
    $orgId = trim((string)($org['id'] ?? ''));

    if ($orgId === '') {
        jsonResponse(200, [
            'success' => true,
            'offer_enabled' => $offerEnabled,
            'show_banner' => false,
            'reason' => 'no_org',
            'tiers' => $tiers,
        ]);
    }

    $projectCount = 0;
    try {
        $projectCount = existingOrgProjectCount($actor);
    } catch (Throwable $e) {
        error_log('portal bonus status count failed: ' . $e->getMessage());
    }

    $completedProjectCount = 0;
    try {
        $completedProjectCount = existingOrgCompletedProjectCount($actor);
    } catch (Throwable $e) {
        error_log('portal bonus status completed count failed: ' . $e->getMessage());
    }

    $offers = is_array($org['offers']['items'] ?? null) ? $org['offers']['items'] : [];
    $offer = is_array($offers['bonus_upfront_match_v1'] ?? null) ? $offers['bonus_upfront_match_v1'] : [];
    $status = trim((string)($offer['status'] ?? 'eligible'));
    $autoOpenModal = false;

    $shouldActivate = $offerEnabled
        && $completedProjectCount >= 1
        && empty($offer['claimed'])
        && empty($offer['shown'])
        && !in_array($status, ['active', 'expired', 'claimed'], true);

    if ($shouldActivate) {
        try {
            $mark = legacyActionJson('org_offer_mark_shown', [
                'offer_id' => 'bonus_upfront_match_v1',
                'meta_json' => json_encode([
                    'source' => 'portal_bonus_banner',
                    'activated_after_project_count' => $projectCount,
                    'activated_after_completed_project_count' => $completedProjectCount,
                ]),
            ]);
            if (!empty($mark['data']['success']) && is_array($mark['data']['offer'] ?? null)) {
                $offer = $mark['data']['offer'];
                $status = trim((string)($offer['status'] ?? $status));
                $autoOpenModal = true;
            }
        } catch (Throwable $e) {
            error_log('portal bonus status activation failed: ' . $e->getMessage());
        }
    }

    $endsAt = trim((string)($offer['ends_at'] ?? ''));
    $secondsRemaining = 0;
    if ($endsAt !== '') {
        $endTs = strtotime($endsAt);
        if ($endTs !== false) {
            $secondsRemaining = max(0, $endTs - time());
        }
    }

    $showBanner = $offerEnabled
        && ($status === 'active')
        && $secondsRemaining > 0;

    jsonResponse(200, [
        'success' => true,
        'org_id' => $orgId,
        'offer_enabled' => $offerEnabled,
        'project_count' => $projectCount,
        'completed_project_count' => $completedProjectCount,
        'completed_project_threshold' => 1,
        'show_banner' => $showBanner,
        'historical_signup_match_claimed' => false,
        'prior_stripe_purchase_exists' => false,
        'auto_open_modal' => $autoOpenModal,
        'seconds_remaining' => $secondsRemaining,
        'offer' => $offer,
        'tiers' => $tiers,
    ]);
}

function refundReservedCredits(string $chargeToken, string $projectType, string $address): void
{
    if ($chargeToken === '') {
        return;
    }

    try {
        legacyActionJson('portal_refund_order_credits', [
            'charge_token' => $chargeToken,
            'project_type' => $projectType,
            'address' => $address,
        ]);
    } catch (Throwable $e) {
        error_log('portal queue refund failed: ' . $e->getMessage());
    }
}

function handleSecureQueue(): void
{
    $address = trim((string)($_POST['address'] ?? ''));
    $projectType = normalizeProjectType($_POST['project_type'] ?? 'residential');
    $reportMode = normalizeReportMode($_POST['report_mode'] ?? 'full');
    $pins = parseJsonMaybe($_POST['pins'] ?? '[]', []);
    $pins = is_array($pins) ? array_values($pins) : [];
    $ccEmails = parseJsonMaybe($_POST['cc_emails'] ?? '[]', []);
    $ccEmails = is_array($ccEmails) ? array_values($ccEmails) : [];
    $components = parseJsonMaybe($_POST['address_components'] ?? '{}', []);
    $components = is_array($components) ? $components : [];
    $includeGutterMeasurements = shouldIncludeGutterMeasurements($projectType, $_POST['include_gutter_measurements'] ?? null);
    $lat = asNumberOrNull($_POST['lat'] ?? null);
    $lng = asNumberOrNull($_POST['lng'] ?? null);
    $googleApiKey = trim((string)($_POST['google_api_key'] ?? ''));
    $actor = currentActorFromSession();

    if (!featureFlagEnabled('offer_instant_reports', true)) {
        $reportMode = 'full';
    } elseif ($reportMode === 'instant') {
        $reportMode = 'both';
    }
    if (!featureFlagEnabled('offer_gutter_reports', false)) {
        $includeGutterMeasurements = false;
    }

    if (empty($actor['email'])) {
        jsonResponse(401, ['success' => false, 'error' => 'Authentication required.']);
    }
    if ($googleApiKey === '') {
        jsonResponse(400, ['success' => false, 'error' => 'Google Maps API key is unavailable for project processing.']);
    }

    $isVip = false;
    if (!empty($actor['organization_id'])) {
        try {
            $isVip = existingOrgProjectCount($actor) < 3;
        } catch (Throwable $e) {
            // Fail closed so clients cannot force VIP if the count check fails.
            error_log('portal queue vip check failed: ' . $e->getMessage());
            $isVip = false;
        }
    }

    try {
        $charge = legacyActionJson('portal_charge_order_credits', [
            'address' => $address,
            'project_type' => $projectType,
            'report_mode' => $reportMode,
            'include_gutter_measurements' => $includeGutterMeasurements ? '1' : '0',
            'pins' => json_encode($pins),
        ]);
    } catch (Throwable $e) {
        jsonResponse(400, ['success' => false, 'error' => $e->getMessage() ?: 'Unable to prepare billing for this order.']);
    }

    $chargeData = $charge['data'];
    $chargeOk = ($chargeData['success'] ?? false) === true;
    $chargeError = trim((string)($chargeData['error'] ?? $chargeData['message'] ?? ''));
    if (!$chargeOk || $chargeError !== '') {
        jsonResponse(
            ($charge['status'] >= 400 ? (int)$charge['status'] : 400),
            ['success' => false, 'error' => $chargeError !== '' ? $chargeError : 'Unable to prepare billing for this order.']
        );
    }

    $chargeToken = trim((string)($chargeData['charge_token'] ?? ''));
    $chargedAmount = isset($chargeData['charged_amount']) && is_numeric((string)$chargeData['charged_amount'])
        ? (float)$chargeData['charged_amount']
        : 0.0;

    if ($chargedAmount > 0 && $chargeToken === '') {
        jsonResponse(400, ['success' => false, 'error' => 'Unable to reserve billing for this order.']);
    }

    $payload = [
        'address' => $address,
        'is_custom_pin' => (string)($_POST['custom_coords'] ?? ($_POST['customCoords'] ?? '0')) === '1',
        'is_vip' => $isVip,
        'components' => !empty($components) ? $components : (object)[],
        'project_type' => $projectType,
        'report_mode' => $reportMode,
        'include_gutter_measurements' => $includeGutterMeasurements,
        'pins' => $pins,
        'cc_emails' => $ccEmails,
        'tech_notes' => trim((string)($_POST['tech_notes'] ?? '')) ?: null,
        'resident' => [
            'name' => trim((string)($_POST['residentName'] ?? '')),
            'email' => trim((string)($_POST['residentEmail'] ?? '')),
            'phone' => trim((string)($_POST['residentPhone'] ?? '')),
        ],
        'issuer' => [
            'name' => trim((string)($_POST['issuerName'] ?? sessionValue('user_name', ''))),
            'email' => trim((string)($_POST['issuerEmail'] ?? ($actor['email'] ?? ''))),
        ],
        'owner_ref' => [
            'name' => trim((string)($actor['name'] ?? ($_POST['issuerName'] ?? ''))),
            'email' => trim((string)($actor['email'] ?? ($_POST['issuerEmail'] ?? ''))),
        ],
        'amount_charged' => $chargedAmount,
        'charge_token' => $chargeToken,
        'report_mode' => $reportMode,
        'actor' => $actor,
        'google_api_key' => $googleApiKey,
        'process_async' => true,
    ];

    if ($lat !== null) {
        $payload['lat'] = $lat;
    }
    if ($lng !== null) {
        $payload['lng'] = $lng;
    }
    if (!empty($actor['organization_id'])) {
        $payload['organization_ref'] = ['id' => (string)$actor['organization_id']];
    }
    if (!empty($actor['team_id'])) {
        $payload['team_ref'] = ['id' => (string)$actor['team_id']];
    }

    try {
        if ($reportMode === 'instant') {
            $data = firstMeasurePostJson('instants', $payload);
        } else {
            $data = firstMeasurePostJson('projects/queue', $payload + [
                'instant_enabled' => $reportMode === 'both',
            ]);
        }
    } catch (Throwable $e) {
        refundReservedCredits($chargeToken, $projectType, $address);
        jsonResponse(400, ['success' => false, 'error' => $e->getMessage() ?: 'Order submission failed.']);
    }

    $queueFailed = !is_array($data) || (($data['success'] ?? true) === false) || (($data['ok'] ?? true) === false);
    if ($queueFailed) {
        refundReservedCredits($chargeToken, $projectType, $address);
        jsonResponse(400, [
            'success' => false,
            'error' => (string)($data['error'] ?? $data['message'] ?? 'Order submission failed.'),
        ]);
    }

    if ($chargeToken !== '') {
        try {
            legacyActionJson('portal_capture_order_credits', [
                'charge_token' => $chargeToken,
                'folder' => (string)($data['folder'] ?? ''),
                'address' => $address,
            ]);
        } catch (Throwable $e) {
            error_log('portal queue capture failed: ' . $e->getMessage());
        }
    }

    jsonResponse(201, [
        'success' => true,
        'folder' => $data['folder'] ?? null,
        'project' => $data['project'] ?? null,
        'manifest' => $data['manifest'] ?? ($data['project']['manifest'] ?? null),
        'is_vip' => $isVip,
        'report_mode' => $reportMode,
        'instant_url' => $data['instant_url'] ?? null,
    ]);
}

function handleRefundInstantRejection(): void
{
    $projectId = trim((string)($_POST['project_id'] ?? ''));
    $projectType = normalizeProjectType($_POST['project_type'] ?? 'residential');
    $address = trim((string)($_POST['address'] ?? ''));
    $chargeToken = trim((string)($_POST['charge_token'] ?? ''));
    $refundAmount = isset($_POST['refund_amount']) && is_numeric((string)$_POST['refund_amount'])
        ? (float)$_POST['refund_amount']
        : 0.0;
    $reportMode = normalizeReportMode($_POST['report_mode'] ?? 'instant');
    $refundReason = trim((string)($_POST['refund_reason'] ?? 'instant_no_coverage'));

    if ($projectId === '') {
        jsonResponse(400, ['success' => false, 'error' => 'Project id is required.']);
    }

    try {
        legacyActionJson('portal_refund_captured_order_credits', [
            'project_id' => $projectId,
            'project_type' => $projectType,
            'address' => $address,
            'charge_token' => $chargeToken,
            'report_mode' => $reportMode,
            'refund_amount' => $refundAmount,
        ]);
        firstMeasurePostJson('projects/' . rawurlencode($projectId) . '/instant/refund', [
            'refund_issued' => true,
            'refund_amount' => $refundAmount,
            'refund_reason' => $refundReason !== '' ? $refundReason : 'instant_no_coverage',
            'refund_pending' => false,
        ]);
    } catch (Throwable $e) {
        jsonResponse(400, ['success' => false, 'error' => $e->getMessage() ?: 'Unable to refund instant order credits.']);
    }

    jsonResponse(200, ['success' => true, 'refunded' => true]);
}

require_once __DIR__ . '/platform_api_bridge.php';

// Only allow GET/POST (matches your usage)
$method = requestMethod();
if (!in_array($method, ['GET', 'POST'], true)) {
    jsonResponse(405, ['success' => false, 'error' => 'Method not allowed']);
}

if ($method === 'POST' && platformHandlePortalAction((string)($_POST['action'] ?? ''))) {
    exit;
}

if ($method === 'POST' && (string)($_POST['action'] ?? '') === 'queue') {
    handleSecureQueue();
}

if ($method === 'POST' && (string)($_POST['action'] ?? '') === 'refund_instant_rejection') {
    handleRefundInstantRejection();
}

if ($method === 'POST' && (string)($_POST['action'] ?? '') === 'portal_bonus_upfront_match_status') {
    handleBonusUpfrontMatchStatus();
}

if ($method === 'POST' && (string)($_POST['action'] ?? '') === 'auth_status') {
    $actor = currentActorFromSession();
    jsonResponse(200, [
        'success' => true,
        'authenticated' => !empty($actor['email']),
        'user_email' => $actor['email'] ?? null,
    ]);
}

// Build absolute URL to backend on the same host
$backendUrl = sameHostUrl($BACKEND_PATH);

// Preserve query string on read requests
if (($method === 'GET' || $method === 'HEAD') && !empty($_SERVER['QUERY_STRING'])) {
    $backendUrl .= '?' . $_SERVER['QUERY_STRING'];
}

// Forward cookies so backend session works
$cookieHeader = currentCookieHeader();
$forwardHeaders = ['Accept: */*'];
if ($cookieHeader !== '') {
    $forwardHeaders[] = 'Cookie: ' . $cookieHeader;
}
if (!empty($_SERVER['HTTP_RANGE']) && ($method === 'GET' || $method === 'HEAD')) {
    $forwardHeaders[] = 'Range: ' . trim((string)$_SERVER['HTTP_RANGE']);
}

if (!function_exists('curl_init')) {
    if ($method === 'POST') {
        $contentType = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
        if (stripos($contentType, 'multipart/form-data') !== false) {
            jsonResponse(500, ['success' => false, 'error' => 'Multipart proxying requires the PHP curl extension.']);
        }
        $raw = file_get_contents('php://input');
        if ($raw !== false && strlen($raw) > 0 && stripos($contentType, 'application/json') !== false) {
            $bodyToForward = $raw;
            $fallbackHeaders = array_merge(['Accept: */*', 'Content-Type: application/json'], $cookieHeader !== '' ? ['Cookie: ' . $cookieHeader] : []);
        } else {
            $bodyToForward = http_build_query($_POST);
            $fallbackHeaders = array_merge(['Accept: */*', 'Content-Type: application/x-www-form-urlencoded'], $cookieHeader !== '' ? ['Cookie: ' . $cookieHeader] : []);
        }
    } else {
        $bodyToForward = null;
        $fallbackHeaders = $forwardHeaders;
    }

    $response = sendHttpRequest($backendUrl, $method === 'HEAD' ? 'GET' : $method, $bodyToForward, $fallbackHeaders);
    if (!$response['ok']) {
        jsonResponse(502, ['success' => false, 'error' => 'Proxy failed', 'detail' => $response['error'] ?: 'stream_request_failed']);
    }
    http_response_code((int)$response['status']);
    foreach (preg_split("/\r\n|\n|\r/", trim($response['headers_raw'])) as $line) {
        if ($line === '' || stripos($line, 'HTTP/') === 0) continue;
        $parts = explode(':', $line, 2);
        if (count($parts) !== 2) continue;
        $hName = strtolower(trim($parts[0]));
        $hVal = trim($parts[1]);
        if ($hName === 'set-cookie') {
            header('Set-Cookie: ' . portalExtendSessionSetCookieHeader($hVal), false);
        } elseif ($hName === 'content-type') {
            header('Content-Type: ' . $hVal);
        }
    }
    echo $response['body'];
    exit;
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $backendUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true); // so we can pass through content-type/status
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_TIMEOUT, $TIMEOUT_SEC);

curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);

// Forward method + payload
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'HEAD');
    curl_setopt($ch, CURLOPT_NOBODY, true);
}
if ($method === 'POST') {
    curl_setopt($ch, CURLOPT_POST, true);

    // If this is multipart/form-data (FormData with files), forward as multipart
    $contentType = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    $isMultipart = (stripos($contentType, 'multipart/form-data') !== false);

    if ($isMultipart) {
        $postFields = [];

        // Add normal POST fields
        foreach ($_POST as $k => $v) {
            $postFields[$k] = $v;
        }

        // Add uploaded files
        foreach ($_FILES as $fieldName => $fileInfo) {
            // handle both single and multi upload fields
            if (is_array($fileInfo['name'])) {
                // multiple files under same field
                $count = count($fileInfo['name']);
                for ($i = 0; $i < $count; $i++) {
                    if (($fileInfo['error'][$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                        continue;
                    }
                    $tmp  = $fileInfo['tmp_name'][$i];
                    $name = $fileInfo['name'][$i] ?? ('upload_' . $i);
                    $type = $fileInfo['type'][$i] ?? 'application/octet-stream';
                    // Use fieldName[] semantics
                    $postFields[$fieldName . "[$i]"] = new CURLFile($tmp, $type, $name);
                }
            } else {
                if (($fileInfo['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                    continue;
                }
                $tmp  = $fileInfo['tmp_name'];
                $name = $fileInfo['name'] ?? 'upload';
                $type = $fileInfo['type'] ?? 'application/octet-stream';
                $postFields[$fieldName] = new CURLFile($tmp, $type, $name);
            }
        }

        curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
    } else {
        // Could be application/x-www-form-urlencoded OR JSON
        // If client sent JSON, forward raw body; else forward parsed $_POST
        $raw = file_get_contents('php://input');
        if ($raw !== false && strlen($raw) > 0 && stripos($contentType, 'application/json') !== false) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $raw);
            curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge(
                ['Accept: */*'],
                ['Content-Type: application/json'],
                $cookieHeader !== '' ? ['Cookie: ' . $cookieHeader] : []
            ));
        } else {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $_POST);
        }
    }
}

// Execute
$resp = curl_exec($ch);
if ($resp === false) {
    $err = curl_error($ch);
    curl_close($ch);
    jsonResponse(502, ['success' => false, 'error' => 'Proxy failed', 'detail' => $err]);
}

$httpCode   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$rawHeaders = substr($resp, 0, $headerSize);
$body       = substr($resp, $headerSize);

// Pass through status code
http_response_code($httpCode);

// Pass through important headers (content-type, set-cookie)
// Avoid forwarding hop-by-hop headers
$lines = preg_split("/\r\n|\n|\r/", trim($rawHeaders));
foreach ($lines as $line) {
    if ($line === '' || stripos($line, 'HTTP/') === 0) {
        continue;
    }

    $parts = explode(':', $line, 2);
    if (count($parts) !== 2) {
        continue;
    }

    $hName = strtolower(trim($parts[0]));
    $hVal  = trim($parts[1]);

    // Skip hop-by-hop / unsafe headers
    if (in_array($hName, [
        'transfer-encoding',
        'content-length',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'upgrade',
    ], true)) {
        continue;
    }

    // Allow Set-Cookie for sessions
    if ($hName === 'set-cookie') {
        header('Set-Cookie: ' . portalExtendSessionSetCookieHeader($hVal), false);
        continue;
    }

    // Allow Content-Type so JSON stays JSON
    if ($hName === 'content-type') {
        header('Content-Type: ' . $hVal);
        continue;
    }
}

// Default content type if backend forgot it
if (!headers_sent()) {
    // If it looks like JSON, set JSON
    $trim = ltrim($body);
    if ($trim !== '' && ($trim[0] === '{' || $trim[0] === '[')) {
        header('Content-Type: application/json');
    }
}

// Output body
echo $body;
