<?php
declare(strict_types=1);

const PORTAL_SESSION_LIFETIME_SECONDS = 1209600; // 14 days

function portalPlatformSessionCookieName(): string
{
    $configured = trim((string)(getenv('PLATFORM_SESSION_COOKIE_NAME') ?: ($_SERVER['PLATFORM_SESSION_COOKIE_NAME'] ?? '')));
    return preg_match('/^[A-Za-z0-9_-]{1,80}$/', $configured) ? $configured : 'fm_platform_session';
}

function portalSessionCookieOptions(?int $expires = null): array
{
    $params = session_get_cookie_params();
    $forwardedProto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    $secure = $forwardedProto === 'https'
        || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    $options = [
        'expires' => $expires ?? (time() + PORTAL_SESSION_LIFETIME_SECONDS),
        'path' => $params['path'] ?: '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => $params['samesite'] ?? 'Lax',
    ];

    if (!empty($params['domain'])) {
        $options['domain'] = $params['domain'];
    }

    return $options;
}

function portalStartSession(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    ini_set('session.gc_maxlifetime', (string)PORTAL_SESSION_LIFETIME_SECONDS);
    ini_set('session.cookie_lifetime', (string)PORTAL_SESSION_LIFETIME_SECONDS);

    $options = portalSessionCookieOptions();
    session_set_cookie_params([
        'lifetime' => PORTAL_SESSION_LIFETIME_SECONDS,
        'path' => $options['path'],
        'domain' => $options['domain'] ?? '',
        'secure' => $options['secure'],
        'httponly' => $options['httponly'],
        'samesite' => $options['samesite'],
    ]);

    session_start();

    if (session_id() !== '' && !headers_sent()) {
        setcookie(session_name(), session_id(), $options);
    }

    portalHydrateSessionFromNodeAuth();
}

function portalNodePlatformBaseUrl(): string
{
    $configured = trim((string)(getenv('FIRSTMEASURE_NODE_BASE_URL') ?: ($_SERVER['FIRSTMEASURE_NODE_BASE_URL'] ?? '')));
    if ($configured !== '') {
        return rtrim($configured, '/');
    }
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost' || $hostOnly === '10.0.2.2') {
        return 'http://127.0.0.1:3111/v1/platform';
    }
    $forwardedProto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    $scheme = $forwardedProto === 'https' || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . '/v1/platform';
}

function portalHydrateSessionFromNodeAuth(): void
{
    $cookie = (string)($_SERVER['HTTP_COOKIE'] ?? '');
    if ($cookie === '' || strpos($cookie, portalPlatformSessionCookieName() . '=') === false) {
        portalClearNodeBackedSessionState();
        return;
    }

    $url = portalNodePlatformBaseUrl() . '/auth/session';
    $headers = ['Accept: application/json', 'Cookie: ' . $cookie];
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => implode("\r\n", $headers),
            'ignore_errors' => true,
            'timeout' => 4,
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false,
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    if ((!is_string($raw) || $raw === '') && function_exists('curl_init')) {
        $ch = curl_init($url);
        if ($ch !== false) {
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_TIMEOUT => 4,
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_SSL_VERIFYHOST => false,
            ]);
            $curlRaw = curl_exec($ch);
            curl_close($ch);
            if (is_string($curlRaw) && $curlRaw !== '') {
                $raw = $curlRaw;
            }
        }
    }
    if (!is_string($raw) || $raw === '') {
        return;
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || empty($data['authenticated'])) {
        portalClearNodeBackedSessionState();
        return;
    }

    $identity = is_array($data['identity'] ?? null) ? $data['identity'] : [];
    $organization = is_array($data['organization'] ?? null) ? $data['organization'] : [];
    $user = is_array($data['user'] ?? null) ? $data['user'] : [];
    $membership = is_array($data['membership'] ?? null) ? $data['membership'] : [];
    $impersonation = is_array($data['impersonation'] ?? null) ? $data['impersonation'] : [];

    $email = strtolower(trim((string)($identity['email'] ?? $user['email'] ?? '')));
    if ($email === '') {
        return;
    }

    $_SESSION['user_email'] = $email;
    $_SESSION['user_name'] = (string)($identity['name'] ?? $user['name'] ?? $email);
    $_SESSION['user_company'] = (string)($organization['name'] ?? '');
    $_SESSION['user_org_id'] = (string)($membership['organization_id'] ?? $organization['id'] ?? '');
    $_SESSION['org_id'] = $_SESSION['user_org_id'];
    $_SESSION['platform_branch_id'] = (string)($membership['branch_id'] ?? 'default');
    $_SESSION['branch_id'] = $_SESSION['platform_branch_id'];
    $_SESSION['user_role'] = (string)($membership['role'] ?? $user['role'] ?? 'member');
    $_SESSION['user_org_perm_level'] = $_SESSION['user_role'];
    $_SESSION['platform_node_auth'] = true;
    if (!empty($impersonation['active'])) {
        $_SESSION['is_impersonating'] = true;
        $_SESSION['impersonating_from_email'] = (string)($impersonation['admin_email'] ?? '');
        $_SESSION['impersonation_started_at'] = (string)($impersonation['started_at'] ?? '');
    } else {
        unset($_SESSION['is_impersonating'], $_SESSION['impersonating_from_email'], $_SESSION['impersonation_started_at']);
    }
}

function portalClearNodeBackedSessionState(): void
{
    if (empty($_SESSION['platform_node_auth'])) {
        unset($_SESSION['is_impersonating'], $_SESSION['impersonating_from_email'], $_SESSION['impersonation_started_at']);
        return;
    }

    unset(
        $_SESSION['user_email'],
        $_SESSION['user_name'],
        $_SESSION['user_company'],
        $_SESSION['user_org_id'],
        $_SESSION['org_id'],
        $_SESSION['platform_branch_id'],
        $_SESSION['branch_id'],
        $_SESSION['user_role'],
        $_SESSION['user_org_perm_level'],
        $_SESSION['platform_node_auth'],
        $_SESSION['is_impersonating'],
        $_SESSION['impersonating_from_email'],
        $_SESSION['impersonation_started_at']
    );
}

function portalExpireSessionCookie(): void
{
    if (headers_sent()) {
        return;
    }

    setcookie(session_name(), '', portalSessionCookieOptions(time() - 3600));
    $platformCookie = portalPlatformSessionCookieName();
    setcookie($platformCookie, '', portalSessionCookieOptions(time() - 3600));
    setcookie($platformCookie . '_csrf', '', array_merge(portalSessionCookieOptions(time() - 3600), ['httponly' => false]));
}

function portalExtendSessionSetCookieHeader(string $headerValue): string
{
    $sessionName = session_name();
    if ($sessionName === '' || stripos($headerValue, $sessionName . '=') !== 0) {
        return $headerValue;
    }

    $parts = array_values(array_filter(array_map('trim', explode(';', $headerValue)), static function ($part): bool {
        $lower = strtolower($part);
        return $lower !== '' && strpos($lower, 'expires=') !== 0 && strpos($lower, 'max-age=') !== 0;
    }));

    $hasPath = false;
    $hasHttpOnly = false;
    $hasSecure = false;
    $hasSameSite = false;
    foreach ($parts as $part) {
        $lower = strtolower($part);
        $hasPath = $hasPath || strpos($lower, 'path=') === 0;
        $hasHttpOnly = $hasHttpOnly || $lower === 'httponly';
        $hasSecure = $hasSecure || $lower === 'secure';
        $hasSameSite = $hasSameSite || strpos($lower, 'samesite=') === 0;
    }

    $parts[] = 'Expires=' . gmdate('D, d M Y H:i:s T', time() + PORTAL_SESSION_LIFETIME_SECONDS);
    $parts[] = 'Max-Age=' . PORTAL_SESSION_LIFETIME_SECONDS;
    if (!$hasPath) {
        $parts[] = 'Path=/';
    }
    if (!$hasHttpOnly) {
        $parts[] = 'HttpOnly';
    }
    if (!$hasSecure && !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        $parts[] = 'Secure';
    }
    if (!$hasSameSite) {
        $parts[] = 'SameSite=Lax';
    }

    return implode('; ', $parts);
}
