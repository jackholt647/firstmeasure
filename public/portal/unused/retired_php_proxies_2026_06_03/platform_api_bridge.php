<?php
declare(strict_types=1);

function platformApiBaseUrl(): string
{
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost') {
        return 'http://' . $hostOnly . ':3111/v1/platform';
    }
    return sameHostUrl('/v1/platform');
}

function platformForwardSetCookieHeaders(string $headersRaw): void
{
    foreach (preg_split("/\r\n|\n|\r/", $headersRaw) as $line) {
        if (stripos($line, 'Set-Cookie:') === 0) {
            header(trim($line), false);
        }
    }
}

function platformApiRequest(string $method, string $path, ?array $payload = null, bool $forwardCookies = false): array
{
    $headers = ['Accept: application/json'];
    $cookieHeader = (string)($_SERVER['HTTP_COOKIE'] ?? '');
    if ($cookieHeader !== '') {
        $headers[] = 'Cookie: ' . $cookieHeader;
    }
    if (!empty($_COOKIE['fm_platform_session_csrf'])) {
        $headers[] = 'X-Platform-CSRF: ' . (string)$_COOKIE['fm_platform_session_csrf'];
    }
    $body = null;
    if ($payload !== null) {
        $headers[] = 'Content-Type: application/json';
        $body = json_encode($payload);
    }
    $response = sendHttpRequest(platformApiBaseUrl() . '/' . ltrim($path, '/'), $method, $body, $headers);
    if (!$response['ok']) {
        throw new RuntimeException('Platform API request failed: ' . ($response['error'] ?: 'Unknown error'));
    }
    if ($forwardCookies && !headers_sent()) {
        platformForwardSetCookieHeaders((string)($response['headers_raw'] ?? ''));
    }
    $data = json_decode((string)$response['body'], true);
    if (!is_array($data)) {
        throw new RuntimeException(sprintf('Platform API returned invalid JSON (%d).', (int)$response['status']));
    }
    if ((int)$response['status'] >= 400 || ($data['ok'] ?? true) === false) {
        throw new RuntimeException((string)($data['message'] ?? $data['error'] ?? 'Platform API request failed.'));
    }
    return $data;
}

function platformStorageRootPath(): string
{
    return dirname(__DIR__) . '/v1/storage/platform';
}

function platformSafeId(string $value, string $fallback = 'item'): string
{
    $id = strtolower(trim($value));
    $id = preg_replace('/[^a-z0-9_-]+/', '-', $id);
    $id = trim((string)$id, '-');
    return $id !== '' ? $id : $fallback . '_' . substr(bin2hex(random_bytes(8)), 0, 12);
}

function platformMediaUrl(string $orgId, string $mediaId, string $variant = 'original'): string
{
    return platformApiBaseUrl()
        . '/organizations/' . rawurlencode($orgId)
        . '/media/' . rawurlencode($mediaId)
        . '/file?variant=' . rawurlencode($variant);
}

function platformMediaExtension(string $mime, string $fileName = ''): string
{
    $nameExt = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
    if (preg_match('/^[a-z0-9]{2,6}$/', $nameExt)) return $nameExt;
    return match (strtolower($mime)) {
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
        'image/gif' => 'gif',
        'application/pdf' => 'pdf',
        'video/mp4' => 'mp4',
        'video/webm' => 'webm',
        default => 'bin',
    };
}

function platformApiMultipartRequest(string $path, array $fields, string $fileField, string $bytes, string $fileName, string $mime): array
{
    if (!function_exists('curl_init') || !class_exists('CURLFile')) {
        throw new RuntimeException('Multipart upload requires cURL.');
    }
    $tempPath = tempnam(sys_get_temp_dir(), 'platform-media-');
    if ($tempPath === false) {
        throw new RuntimeException('Could not create a temporary upload file.');
    }
    file_put_contents($tempPath, $bytes);
    $safeName = basename($fileName ?: 'upload.' . platformMediaExtension($mime, $fileName));
    $fields[$fileField] = new CURLFile($tempPath, $mime ?: 'application/octet-stream', $safeName);
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, platformApiBaseUrl() . '/' . ltrim($path, '/'));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $fields);
    $headers = ['Accept: application/json'];
    $cookieHeader = (string)($_SERVER['HTTP_COOKIE'] ?? '');
    if ($cookieHeader !== '') $headers[] = 'Cookie: ' . $cookieHeader;
    if (!empty($_COOKIE['fm_platform_session_csrf'])) $headers[] = 'X-Platform-CSRF: ' . (string)$_COOKIE['fm_platform_session_csrf'];
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    curl_setopt($ch, CURLOPT_TIMEOUT, 120);
    $response = curl_exec($ch);
    $error = $response === false ? curl_error($ch) : null;
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    @unlink($tempPath);
    if ($response === false) {
        throw new RuntimeException('Platform media upload failed: ' . ($error ?: 'Unknown error'));
    }
    $body = substr((string)$response, $headerSize);
    $data = json_decode($body, true);
    if (!is_array($data) || $status >= 400 || ($data['ok'] ?? true) === false) {
        throw new RuntimeException((string)($data['message'] ?? $data['error'] ?? 'Platform media upload failed.'));
    }
    return $data;
}

function platformStoreMediaBytes(string $orgId, string $scope, string $ownerType, string $ownerId, string $slot, string $bytes, string $mime, string $fileName = ''): array
{
    try {
        $data = platformApiMultipartRequest(
            '/organizations/' . rawurlencode($orgId) . '/media',
            [
                'owner_type' => $ownerType,
                'owner_id' => $ownerId,
                'slot' => $slot,
                'collection' => $scope,
                'scope' => $scope,
                'replace_slot' => 'true',
                'thumbnails' => json_encode(['enabled' => true, 'sizes' => [160, 320, 640], 'format' => 'webp']),
                'compression' => json_encode(['enabled' => true, 'max_width' => 2400, 'quality' => 82, 'format' => 'webp']),
            ],
            'file',
            $bytes,
            $fileName ?: 'upload.' . platformMediaExtension($mime, $fileName),
            $mime ?: 'application/octet-stream'
        );
        if (is_array($data['media'] ?? null)) {
            return $data['media'];
        }
    } catch (Throwable $e) {
        error_log('Platform media V1 upload failed, falling back to local original-only storage: ' . $e->getMessage());
    }
    return platformStoreMediaBytesLocal($orgId, $scope, $ownerType, $ownerId, $slot, $bytes, $mime, $fileName);
}

function platformStoreMediaBytesLocal(string $orgId, string $scope, string $ownerType, string $ownerId, string $slot, string $bytes, string $mime, string $fileName = ''): array
{
    $mediaId = platformSafeId($ownerType . '_' . $ownerId . '_' . $slot, 'media');
    $ext = platformMediaExtension($mime, $fileName);
    $mediaDir = platformStorageRootPath() . '/organizations/' . platformSafeId($orgId, 'org') . '/media/' . $mediaId;
    $originalDir = $mediaDir . '/original';
    $renditionsDir = $mediaDir . '/renditions';
    $markupDir = $mediaDir . '/markup';
    if (!is_dir($originalDir)) mkdir($originalDir, 0775, true);
    if (!is_dir($renditionsDir)) mkdir($renditionsDir, 0775, true);
    if (!is_dir($markupDir)) mkdir($markupDir, 0775, true);
    $storedName = 'original.' . $ext;
    file_put_contents($originalDir . '/' . $storedName, $bytes);
    $metadata = [
        'schema_version' => 1,
        'id' => $mediaId,
        'organization_id' => $orgId,
        'scope' => $scope,
        'owner' => [
            'type' => $ownerType,
            'id' => $ownerId,
            'slot' => $slot,
        ],
        'kind' => str_starts_with(strtolower($mime), 'image/') ? 'image' : (str_starts_with(strtolower($mime), 'video/') ? 'video' : 'file'),
        'content_type' => $mime,
        'file_name' => $fileName ?: $storedName,
        'size_bytes' => strlen($bytes),
        'variants' => [
            'original' => [
                'path' => 'original/' . $storedName,
                'content_type' => $mime,
                'file_name' => $fileName ?: $storedName,
                'size_bytes' => strlen($bytes),
            ],
        ],
        'renditions' => [],
        'markup' => [
            'layers' => [],
            'current_layer_id' => null,
        ],
        'created_at' => gmdate('c'),
        'updated_at' => gmdate('c'),
    ];
    file_put_contents($mediaDir . '/metadata.json', json_encode($metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    return $metadata;
}

function platformLocalIdentityByEmail(string $email): array
{
    $normalized = strtolower(trim($email));
    if ($normalized === '') return [];
    $indexPath = platformStorageRootPath() . '/auth_index/email/' . hash('sha256', $normalized) . '.json';
    if (!is_file($indexPath)) return [];
    $index = json_decode((string)file_get_contents($indexPath), true);
    if (!is_array($index) || empty($index['identity_id'])) return [];
    $identityId = preg_replace('/[^a-z0-9_-]/i', '-', (string)$index['identity_id']);
    $identityPath = platformStorageRootPath() . '/identities/' . $identityId . '.json';
    if (!is_file($identityPath)) return [];
    $identity = json_decode((string)file_get_contents($identityPath), true);
    return is_array($identity) ? $identity : [];
}

function platformCanHandleAction(string $action): bool
{
    return in_array($action, [
        'login',
        'register',
        'auth_status',
        'get_credits',
        'org_get_my',
        'org_update_my',
        'org_update_my_report_settings',
        'org_update_my_billing',
        'org_upload_logo_my',
        'org_users_upload_avatar_my',
        'billing_autotopup_setup_start',
        'billing_autotopup_setup_finish',
        'onboarding_complete',
        'org_billing_history_my',
        'org_monthly_statement',
        'org_users_list_my',
        'org_users_add_my',
        'org_users_update_my',
        'org_users_delete_my',
        'org_users_set_disabled_my',
        'org_users_set_perms_my',
        'portal_charge_order_credits',
        'portal_capture_order_credits',
        'portal_refund_order_credits',
        'portal_refund_captured_order_credits',
        'org_offer_mark_shown',
    ], true);
}

function platformCurrentOrgId(): string
{
    return trim((string)sessionValue('user_org_id', sessionValue('org_id', '')));
}

function platformCurrentUserId(): string
{
    return trim((string)sessionValue('platform_user_id', sessionValue('user_id', '')));
}

function platformCurrentBranchId(): string
{
    return trim((string)sessionValue('platform_branch_id', sessionValue('branch_id', 'default'))) ?: 'default';
}

function platformReadBranch(string $orgId, ?string $branchId = null): array
{
    $id = $branchId ?: platformCurrentBranchId();
    try {
        $doc = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/branch/' . rawurlencode($id))['document'] ?? [];
        $data = is_array($doc['data'] ?? null) ? $doc['data'] : [];
        return array_merge(['id' => $doc['id'] ?? $id], $data);
    } catch (Throwable $e) {
        $created = platformApiRequest('PUT', '/organizations/' . rawurlencode($orgId) . '/branch/' . rawurlencode($id), [
            'data' => [
                'name' => sessionValue('user_company', 'Main'),
                'status' => 'active',
                'contact' => ['email' => '', 'phone' => '', 'address' => ''],
                'branding' => ['logo' => null, 'colors' => ['primary' => '#d93025', 'secondary' => '#202124', 'accent' => '#1a73e8']],
                'report_settings' => [],
            ],
            'metadata' => ['kind' => 'branch'],
        ])['document'] ?? [];
        $data = is_array($created['data'] ?? null) ? $created['data'] : [];
        return array_merge(['id' => $created['id'] ?? $id], $data);
    }
}

function platformPatchBranch(string $orgId, array $patch, ?string $branchId = null): array
{
    $id = $branchId ?: platformCurrentBranchId();
    $current = platformReadBranch($orgId, $id);
    $data = array_replace_recursive($current, $patch);
    unset($data['id']);
    $result = platformApiRequest('PUT', '/organizations/' . rawurlencode($orgId) . '/branch/' . rawurlencode($id), [
        'data' => $data,
        'metadata' => ['kind' => 'branch'],
    ]);
    return $result['document'] ?? [];
}

function platformReadBranchModule(string $orgId, string $moduleId, ?string $branchId = null): array
{
    $id = $branchId ?: platformCurrentBranchId();
    try {
        $result = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/branch/' . rawurlencode($id) . '/modules/' . rawurlencode($moduleId));
        return is_array($result['module'] ?? null) ? $result['module'] : [];
    } catch (Throwable $e) {
        return [];
    }
}

function platformSaveBranchModule(string $orgId, string $moduleId, array $data, array $metadata = [], ?string $branchId = null): array
{
    $id = $branchId ?: platformCurrentBranchId();
    $result = platformApiRequest('PUT', '/organizations/' . rawurlencode($orgId) . '/branch/' . rawurlencode($id) . '/modules/' . rawurlencode($moduleId), [
        'data' => $data,
        'metadata' => $metadata,
    ]);
    return is_array($result['module'] ?? null) ? $result['module'] : [];
}

function platformSyncPresentationStyleBranding(string $orgId, array $branchData): void
{
    $module = platformReadBranchModule($orgId, 'presentation_style');
    $data = is_array($module['data'] ?? null) ? $module['data'] : [];
    $branding = is_array($data['branding'] ?? null) ? $data['branding'] : [];
    $branchBranding = is_array($branchData['branding'] ?? null) ? $branchData['branding'] : [];
    $branchColors = is_array($branchBranding['colors'] ?? null) ? $branchBranding['colors'] : [];
    $branding['colors'] = array_replace_recursive(
        is_array($branding['colors'] ?? null) ? $branding['colors'] : [],
        array_filter([
            'primary' => $branchColors['primary'] ?? null,
            'secondary' => $branchColors['secondary'] ?? null,
            'accent' => $branchColors['accent'] ?? ($branchColors['primary'] ?? null),
        ], static fn($value) => $value !== null && $value !== '')
    );
    if (!empty($branchBranding['logo_media_id'])) {
        $branding['logo_media_id'] = $branchBranding['logo_media_id'];
        unset($branding['logo'], $branding['logoUrl'], $branding['companyLogo']);
    }
    if (!empty($branchData['name'])) {
        $data['companyName'] = (string)$branchData['name'];
    }
    $data['branding'] = $branding;
    $data['default_theme'] = (string)($data['default_theme'] ?? 'margin');
    $data['marketing_pages'] = is_array($data['marketing_pages'] ?? null) ? $data['marketing_pages'] : [];
    $data['proposal_pages'] = is_array($data['proposal_pages'] ?? null) ? $data['proposal_pages'] : [
        'include_cover' => true,
        'include_scope' => true,
        'include_pricing' => true,
        'include_signature' => true,
        'include_fine_print' => true,
    ];
    platformSaveBranchModule($orgId, 'presentation_style', $data, ['source' => 'company_settings_sync']);
}

function platformReadOrg(string $orgId): array
{
    $org = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId))['organization'] ?? [];
    $global = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/global')['document'] ?? [];
    $globalData = is_array($global['data'] ?? null) ? $global['data'] : [];
    $branch = platformReadBranch($orgId);
    $merged = array_replace_recursive(is_array($org) ? $org : [], $globalData, $branch);
    $merged['id'] = (string)($org['id'] ?? $orgId);
    $merged['branch_id'] = $branch['id'] ?? platformCurrentBranchId();
    $merged['branch'] = $branch;
    if (isset($merged['branding']['logo']) && str_starts_with((string)$merged['branding']['logo'], 'organizations/')) {
        $merged['branding']['logo'] = null;
    }
    if (!empty($merged['branding']['logo_media_id'])) {
        $merged['branding']['logo'] = platformMediaUrl($orgId, (string)$merged['branding']['logo_media_id']);
    }
    $merged['global'] = $global;
    return $merged;
}

function platformReadCurrentUser(): array
{
    $orgId = platformCurrentOrgId();
    $userId = platformCurrentUserId();
    if ($orgId === '' || $userId === '') return [];
    $doc = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId))['document'] ?? [];
    return is_array($doc['data'] ?? null) ? array_merge(['id' => $doc['id'] ?? $userId], $doc['data']) : [];
}

function platformPatchOrgGlobal(string $orgId, array $patch): array
{
    $result = platformApiRequest('PATCH', '/organizations/' . rawurlencode($orgId) . '/global', ['data' => $patch]);
    return $result['document'] ?? [];
}

function platformCreditLedger(string $orgId, int $limit = 500): array
{
    $result = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/credits?limit=' . max(0, min(500, $limit)));
    return is_array($result['ledger'] ?? null) ? $result['ledger'] : [];
}

function platformCreditAmountForToken(string $orgId, string $chargeToken): float
{
    if ($chargeToken === '') return 0.0;
    foreach (platformCreditLedger($orgId, 500) as $entry) {
        if (!is_array($entry)) continue;
        $meta = is_array($entry['meta'] ?? null) ? $entry['meta'] : [];
        if ((string)($meta['charge_token'] ?? '') !== $chargeToken) continue;
        $delta = (float)($entry['delta'] ?? 0);
        if ($delta < 0) return abs($delta);
    }
    return 0.0;
}

function platformComputeOrderCreditAmount(array $fields): array
{
    $projectType = normalizeProjectType($fields['project_type'] ?? 'residential');
    $reportMode = normalizeReportMode($fields['report_mode'] ?? 'full');
    $pins = parseJsonMaybe($fields['pins'] ?? '[]', []);
    $pinCount = max(1, is_array($pins) ? count($pins) : 1);
    $amount = ($projectType === 'commercial' || $projectType === 'multifamily') ? 12 * $pinCount : 7;
    if ($reportMode === 'both') $amount += ($projectType === 'residential' ? 2 : 4);
    $includeGutter = shouldIncludeGutterMeasurements($projectType, $fields['include_gutter_measurements'] ?? null);
    if ($includeGutter) $amount += 3;
    return [
        'amount' => (float)$amount,
        'project_type' => $projectType,
        'report_mode' => $reportMode,
        'pin_count' => $pinCount,
        'include_gutter_measurements' => $includeGutter,
    ];
}

function platformChargeOrderCredits(string $orgId, array $fields): array
{
    $computed = platformComputeOrderCreditAmount($fields);
    $chargeToken = bin2hex(random_bytes(16));
    $result = platformApiRequest('POST', '/organizations/' . rawurlencode($orgId) . '/credits/charge', [
        'amount' => $computed['amount'],
        'reason' => 'order_submitted',
        'meta' => [
            'address' => (string)($fields['address'] ?? ''),
            'project_type' => $computed['project_type'],
            'report_mode' => $computed['report_mode'],
            'pin_count' => $computed['pin_count'],
            'include_gutter_measurements' => $computed['include_gutter_measurements'],
            'charge_token' => $chargeToken,
            'source' => 'platform_api_bridge',
        ],
    ]);
    return [
        'success' => true,
        'charge_token' => $chargeToken,
        'charged_amount' => $computed['amount'],
        'balance' => $result['balance'] ?? null,
    ];
}

function platformRefundOrderCredits(string $orgId, array $fields): array
{
    $chargeToken = trim((string)($fields['charge_token'] ?? ''));
    $amount = isset($fields['refund_amount']) && is_numeric((string)$fields['refund_amount'])
        ? (float)$fields['refund_amount']
        : platformCreditAmountForToken($orgId, $chargeToken);
    if ($amount <= 0) return ['success' => true, 'refunded_amount' => 0];
    $result = $chargeToken !== ''
        ? platformApiRequest('POST', '/organizations/' . rawurlencode($orgId) . '/credits/order-refund', [
            'charge_token' => $chargeToken,
            'refund_amount' => $amount,
            'reason' => 'order_refund',
            'meta' => array_merge($fields, [
                'charge_token' => $chargeToken,
                'source' => 'platform_api_bridge',
            ]),
        ])
        : platformApiRequest('POST', '/organizations/' . rawurlencode($orgId) . '/credits/refund', [
        'amount' => $amount,
        'reason' => 'refund',
        'meta' => array_merge($fields, [
            'charge_token' => $chargeToken,
            'source' => 'platform_api_bridge',
        ]),
    ]);
    return [
        'success' => true,
        'refunded_amount' => $result['refunded_amount'] ?? $amount,
        'balance' => $result['balance'] ?? null,
    ];
}

function platformSetSession(array $identity, array $membership): void
{
    $org = is_array($membership['organization'] ?? null) ? $membership['organization'] : [];
    $userDoc = is_array($membership['user'] ?? null) ? $membership['user'] : [];
    $user = is_array($userDoc['data'] ?? null) ? $userDoc['data'] : (is_array($userDoc) ? $userDoc : []);
    portalStartSession();
    session_regenerate_id(true);
    $_SESSION['user_email'] = (string)($identity['email'] ?? $user['email'] ?? '');
    $_SESSION['user_name'] = (string)($user['name'] ?? $identity['name'] ?? '');
    $_SESSION['user_company'] = (string)($org['name'] ?? '');
    $_SESSION['user_org_id'] = (string)($org['id'] ?? '');
    $_SESSION['org_id'] = (string)($org['id'] ?? '');
    $_SESSION['user_id'] = (string)($userDoc['id'] ?? '');
    $_SESSION['platform_user_id'] = (string)($userDoc['id'] ?? '');
    $_SESSION['platform_identity_id'] = (string)($identity['id'] ?? '');
    $_SESSION['user_team_id'] = (string)($user['team_id'] ?? 'default');
    $_SESSION['platform_branch_id'] = (string)($user['branch_id'] ?? 'default');
    $_SESSION['branch_id'] = (string)($user['branch_id'] ?? 'default');
    session_write_close();
}

function platformSessionPayload(): array
{
    $email = trim((string)sessionValue('user_email', ''));
    return [
        'success' => true,
        'authenticated' => $email !== '',
        'user_email' => $email !== '' ? $email : null,
        'user_name' => sessionValue('user_name', null),
        'org_id' => platformCurrentOrgId() ?: null,
    ];
}

function platformSanitizeUser(array $doc): array
{
    $data = is_array($doc['data'] ?? null) ? $doc['data'] : $doc;
    $user = array_merge(['id' => $doc['id'] ?? ($data['id'] ?? '')], $data);
    unset($user['password_hash']);
    $user['org_permissions'] = [
        'level' => ($user['role'] ?? '') === 'owner' ? 'super_admin' : ($user['role'] ?? 'viewer'),
        'items' => $user['permissions'] ?? [],
    ];
    $user['disabled'] = (($user['status'] ?? 'active') === 'disabled');
    return $user;
}

function platformActionJson(string $action, array $fields = []): array
{
    if ($action === 'auth_status') return platformSessionPayload();

    if ($action === 'login') {
        $email = strtolower(trim((string)($_POST['email'] ?? $fields['email'] ?? '')));
        $password = (string)($_POST['password'] ?? $fields['password'] ?? '');
        $result = platformApiRequest('POST', '/auth/login', ['email' => $email, 'password' => $password], true);
        $identity = is_array($result['identity'] ?? null) ? $result['identity'] : [];
        $user = is_array($result['user'] ?? null) ? $result['user'] : [];
        $organization = is_array($result['organization'] ?? null) ? $result['organization'] : [];
        platformSetSession($identity, [
            'organization' => $organization,
            'user' => ['id' => $user['id'] ?? '', 'data' => $user],
        ]);
        return ['success' => true, 'first_login' => false];
    }

    if ($action === 'register') {
        $email = strtolower(trim((string)($_POST['email'] ?? '')));
        $password = (string)($_POST['password'] ?? '');
        $company = trim((string)($_POST['company'] ?? ''));
        if ($email === '' || $password === '' || $company === '') return ['success' => false, 'error' => 'Missing required account fields.'];
        $result = platformApiRequest('POST', '/auth/register', [
            'email' => $email,
            'password' => $password,
            'name' => trim((string)($_POST['name'] ?? '')),
            'phone' => trim((string)($_POST['phone'] ?? '')),
            'company' => $company,
            'identity_metadata' => [
                'referral_code' => trim((string)($_POST['referral_code'] ?? '')),
                'referral_attribution_id' => trim((string)($_POST['referral_attribution_id'] ?? '')),
            ],
        ], true);
        platformSetSession($result['identity'] ?? [], [
            'organization' => $result['organization'] ?? [],
            'user' => $result['user'] ?? [],
        ]);
        return ['success' => true, 'first_login' => true];
    }

    $orgId = platformCurrentOrgId();
    if ($orgId === '') return ['success' => false, 'error' => 'Authentication required.'];
    $org = platformReadOrg($orgId);
    $currentUser = platformReadCurrentUser();

    if ($action === 'get_credits') {
        return [
            'success' => true,
            'credits_balance' => $org['credits_balance'] ?? 0,
            'permissions' => $currentUser['permissions'] ?? ['*' => true],
            'referral_discount' => null,
        ];
    }

    if ($action === 'org_get_my') return ['success' => true, 'org' => $org];

    if ($action === 'org_update_my') {
        $patch = [];
        if (isset($fields['name'])) $patch['name'] = trim((string)$fields['name']);
        if (isset($fields['accent']) || isset($fields['secondary'])) {
            $branding = is_array($org['branding'] ?? null) ? $org['branding'] : [];
            unset($branding['logo']);
            $colors = is_array($branding['colors'] ?? null) ? $branding['colors'] : [];
            if (trim((string)($fields['accent'] ?? '')) !== '') {
                $colors['primary'] = trim((string)$fields['accent']);
                $colors['accent'] = trim((string)$fields['accent']);
            }
            if (trim((string)($fields['secondary'] ?? '')) !== '') $colors['secondary'] = trim((string)$fields['secondary']);
            $branding['colors'] = $colors;
            $patch['branding'] = $branding;
        }
        $contact = is_array($org['contact'] ?? null) ? $org['contact'] : [];
        foreach (['company_email' => 'email', 'company_phone' => 'phone', 'company_address' => 'address'] as $source => $target) {
            if (array_key_exists($source, $fields)) $contact[$target] = trim((string)$fields[$source]);
        }
        $patch['contact'] = $contact;
        if ($patch) {
            platformPatchBranch($orgId, $patch);
            platformSyncPresentationStyleBranding($orgId, platformReadBranch($orgId));
        }
        return ['success' => true, 'org' => platformReadOrg($orgId)];
    }

    if ($action === 'org_update_my_report_settings') {
        $settings = parseJsonMaybe($fields['report_settings_json'] ?? '{}', []);
        platformPatchBranch($orgId, ['report_settings' => is_array($settings) ? $settings : []]);
        return ['success' => true, 'report_settings' => $settings];
    }

    if ($action === 'org_update_my_billing') {
        $billingPatch = parseJsonMaybe($fields['billing_json'] ?? '{}', []);
        $billing = array_replace_recursive(is_array($org['billing'] ?? null) ? $org['billing'] : [], is_array($billingPatch) ? $billingPatch : []);
        platformPatchOrgGlobal($orgId, ['billing' => $billing]);
        return ['success' => true, 'billing' => $billing];
    }

    if ($action === 'billing_autotopup_setup_start' || $action === 'billing_autotopup_setup_finish') {
        return ['success' => false, 'error' => 'Card setup is not connected to the Platform API yet.'];
    }

    if ($action === 'onboarding_complete') {
        platformPatchOrgGlobal($orgId, [
            'onboarding_completed' => true,
            'onboarding_completed_at' => gmdate('c'),
            'onboarding_meta' => [
                'completed_by' => sessionValue('user_email', null),
                'did_purchase' => filter_var($fields['did_purchase'] ?? false, FILTER_VALIDATE_BOOLEAN),
                'did_add_card' => filter_var($fields['did_add_card'] ?? false, FILTER_VALIDATE_BOOLEAN),
            ],
        ]);
        return ['success' => true];
    }

    if ($action === 'org_upload_logo_my') {
        $file = $_FILES['logo'] ?? null;
        if (!is_array($file) || (int)($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            return ['success' => false, 'error' => 'No logo upload received.'];
        }
        $bytes = file_get_contents((string)$file['tmp_name']);
        if ($bytes === false) return ['success' => false, 'error' => 'Could not read logo upload.'];
        $mime = (string)($file['type'] ?? 'image/png');
        $media = platformStoreMediaBytes($orgId, 'branch', 'branch', platformCurrentBranchId(), 'logo', $bytes, $mime, (string)($file['name'] ?? 'logo'));
        $branding = is_array($org['branding'] ?? null) ? $org['branding'] : [];
        unset($branding['logo']);
        $branding['logo_media_id'] = $media['id'];
        $branding['logo_updated_at_utc'] = gmdate('c');
        platformPatchBranch($orgId, ['branding' => $branding]);
        platformSyncPresentationStyleBranding($orgId, platformReadBranch($orgId));
        return ['success' => true, 'logo' => platformMediaUrl($orgId, (string)$media['id']), 'logo_media_id' => $media['id']];
    }

    if ($action === 'org_users_upload_avatar_my') {
        $userId = trim((string)($fields['user_id'] ?? ''));
        $file = $_FILES['avatar'] ?? null;
        if ($userId === '' || !is_array($file) || (int)($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            return ['success' => false, 'error' => 'No avatar upload received.'];
        }
        $bytes = file_get_contents((string)$file['tmp_name']);
        if ($bytes === false) return ['success' => false, 'error' => 'Could not read avatar upload.'];
        $mime = (string)($file['type'] ?? 'image/png');
        $media = platformStoreMediaBytes($orgId, 'users', 'user', $userId, 'avatar', $bytes, $mime, (string)($file['name'] ?? 'avatar'));
        $current = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId))['document'] ?? [];
        $data = is_array($current['data'] ?? null) ? $current['data'] : [];
        $data['profile'] = is_array($data['profile'] ?? null) ? $data['profile'] : [];
        $data['profile']['avatar_media_id'] = $media['id'];
        $saved = platformApiRequest('PUT', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId), ['data' => $data, 'metadata' => ['kind' => 'organization_user']])['document'] ?? [];
        return ['success' => true, 'avatar_url' => platformMediaUrl($orgId, (string)$media['id']), 'avatar_media_id' => $media['id'], 'user' => platformSanitizeUser($saved)];
    }

    if ($action === 'org_billing_history_my') {
        $ledger = is_array($org['credits_ledger'] ?? null) ? $org['credits_ledger'] : [];
        $events = is_array($org['billing']['events'] ?? null) ? $org['billing']['events'] : [];
        return ['success' => true, 'items' => $ledger, 'ledger' => $ledger, 'events' => $events];
    }
    if ($action === 'org_monthly_statement') {
        $month = max(1, min(12, (int)($fields['month'] ?? gmdate('n'))));
        $year = max(2000, min(2100, (int)($fields['year'] ?? gmdate('Y'))));
        $ledger = is_array($org['credits_ledger'] ?? null) ? $org['credits_ledger'] : [];
        $transactions = [];
        $totalIn = 0.0;
        $totalOut = 0.0;
        $byType = [];
        foreach ($ledger as $entry) {
            if (!is_array($entry)) continue;
            $ts = (string)($entry['ts'] ?? $entry['created_at'] ?? $entry['date'] ?? '');
            $time = $ts !== '' ? strtotime($ts) : false;
            if ($time === false || (int)gmdate('n', $time) !== $month || (int)gmdate('Y', $time) !== $year) continue;
            $delta = (float)($entry['delta'] ?? 0);
            if ($delta >= 0) $totalIn += $delta;
            else $totalOut += abs($delta);
            $reason = (string)($entry['reason'] ?? $entry['type'] ?? 'transaction');
            $byType[$reason] = (int)($byType[$reason] ?? 0) + 1;
            $transactions[] = $entry;
        }
        return [
            'success' => true,
            'month' => $month,
            'year' => $year,
            'month_label' => gmdate('F Y', gmmktime(0, 0, 0, $month, 1, $year)),
            'transactions' => $transactions,
            'ledger' => $transactions,
            'orders' => array_values(array_filter($transactions, static fn($entry) => is_array($entry) && (($entry['reason'] ?? '') === 'order_submitted'))),
            'total_transactions' => count($transactions),
            'total_orders' => count(array_filter($transactions, static fn($entry) => is_array($entry) && (($entry['reason'] ?? '') === 'order_submitted'))),
            'total_payments' => count(array_filter($transactions, static fn($entry) => is_array($entry) && (float)($entry['delta'] ?? 0) > 0)),
            'total_in' => $totalIn,
            'total_out' => $totalOut,
            'net_change' => $totalIn - $totalOut,
            'total_spent' => $totalOut,
            'by_type' => $byType,
        ];
    }

    if ($action === 'org_users_list_my') {
        $docs = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/users')['documents'] ?? [];
        return ['success' => true, 'users' => array_map('platformSanitizeUser', is_array($docs) ? $docs : [])];
    }

    if (in_array($action, ['org_users_update_my', 'org_users_set_disabled_my', 'org_users_set_perms_my'], true)) {
        $userId = trim((string)($fields['user_id'] ?? ''));
        if ($userId === '') return ['success' => false, 'error' => 'Missing user id.'];
        $current = platformApiRequest('GET', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId))['document'] ?? [];
        $data = is_array($current['data'] ?? null) ? $current['data'] : [];
        if ($action === 'org_users_update_my') {
            if (isset($fields['email'])) $data['email'] = strtolower(trim((string)$fields['email']));
            if (isset($fields['name'])) $data['name'] = trim((string)$fields['name']);
        }
        if ($action === 'org_users_set_disabled_my') $data['status'] = filter_var($fields['disabled'] ?? false, FILTER_VALIDATE_BOOLEAN) ? 'disabled' : 'active';
        if ($action === 'org_users_set_perms_my') {
            $data['role'] = trim((string)($fields['perm_level'] ?? 'viewer'));
            $data['permissions'] = parseJsonMaybe($fields['perm_items_json'] ?? '{}', []);
        }
        $saved = platformApiRequest('PUT', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId), ['data' => $data, 'metadata' => ['kind' => 'organization_user']])['document'] ?? [];
        return ['success' => true, 'user' => platformSanitizeUser($saved)];
    }

    if ($action === 'org_users_delete_my') {
        $userId = trim((string)($fields['user_id'] ?? ''));
        if ($userId !== '') platformApiRequest('DELETE', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId));
        return ['success' => true];
    }

    if ($action === 'org_users_add_my') {
        $email = strtolower(trim((string)($fields['email'] ?? '')));
        $userId = 'user_' . substr(hash('sha256', $email), 0, 16);
        $data = [
            'identity_id' => null,
            'email' => $email,
            'name' => trim((string)($fields['name'] ?? '')),
            'phone' => '',
            'role' => trim((string)($fields['perm_level'] ?? 'viewer')),
            'roles' => parseJsonMaybe($fields['roles_json'] ?? '[]', []),
            'status' => 'invited',
            'permissions' => parseJsonMaybe($fields['perm_items_json'] ?? '{}', []),
            'profile' => [],
            'stats' => ['projects_ordered' => 0, 'commissions_earned' => 0],
        ];
        $saved = platformApiRequest('PUT', '/organizations/' . rawurlencode($orgId) . '/users/' . rawurlencode($userId), ['data' => $data, 'metadata' => ['kind' => 'organization_user']])['document'] ?? [];
        return ['success' => true, 'user' => platformSanitizeUser($saved), 'emailed' => false, 'activate_url' => null];
    }

    if (in_array($action, ['portal_charge_order_credits', 'portal_capture_order_credits', 'portal_refund_order_credits', 'portal_refund_captured_order_credits'], true)) {
        if ($action === 'portal_charge_order_credits') {
            return platformChargeOrderCredits($orgId, $fields);
        }
        if ($action === 'portal_capture_order_credits') return ['success' => true];
        if (str_starts_with($action, 'portal_refund')) {
            return platformRefundOrderCredits($orgId, $fields);
        }
        return ['success' => true];
    }

    if ($action === 'org_offer_mark_shown') return ['success' => true, 'offer' => []];

    return ['success' => false, 'error' => 'Unsupported Platform action.'];
}

function platformHandlePortalAction(string $action): bool
{
    if (!platformCanHandleAction($action)) return false;
    try {
        jsonResponse(200, platformActionJson($action, $_POST));
    } catch (Throwable $e) {
        jsonResponse(400, ['success' => false, 'error' => $e->getMessage()]);
    }
    return true;
}
