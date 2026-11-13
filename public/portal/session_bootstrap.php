<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/includes/web_security.php';
require_once dirname(__DIR__) . '/includes/node_api.php';

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
    // Never adopt a session id the server did not issue.
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');

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

// From configuration only (FIRSTMEASURE_NODE_BASE_URL, includes/node_api.php),
// never the request's Host. '' when unconfigured: the session check then
// fails closed as a backend failure.
function portalNodePlatformBaseUrl(): string
{
    $v1 = fm_node_v1_base_url('session', 3101);
    return $v1 === '' ? '' : $v1 . '/platform';
}

function portalHydrateSessionFromNodeAuth(): void
{
    if (fm_platform_session_cookie() === '') {
        portalClearNodeBackedSessionState();
        return;
    }

    $base = portalNodePlatformBaseUrl();
    if ($base === '') {
        portalDecodeAuthSessionResponse(false, 0);
        return;
    }
    $url = $base . '/auth/session';
    // Only the platform session cookies go to Node, not PHP's or anyone else's.
    $headers = array_merge(['Accept: application/json'], fm_node_cookie_headers(false));
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => implode("\r\n", $headers),
            'ignore_errors' => true,
            'follow_location' => 0,
            'timeout' => 4,
        ],
        'ssl' => fm_node_stream_ssl_options(),
    ]);
    $raw = @file_get_contents($url, false, $context);
    $status = 0;
    foreach (($http_response_header ?? []) as $line) {
        if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $line, $match)) {
            $status = (int)$match[1];
        }
    }
    if ((!is_string($raw) || $raw === '') && function_exists('curl_init')) {
        $ch = curl_init($url);
        if ($ch !== false) {
            curl_setopt_array($ch, fm_node_curl_options() + [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_TIMEOUT => 4,
                CURLOPT_CONNECTTIMEOUT => 2,
            ]);
            $curlRaw = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            curl_close($ch);
            if (is_string($curlRaw) && $curlRaw !== '') {
                $raw = $curlRaw;
            }
        }
    }
    $data = portalDecodeAuthSessionResponse($raw, $status);
    if (empty($data['authenticated'])) {
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

    // A new identity in this browser gets a new PHP session id (login fixation).
    if (strtolower(trim((string)($_SESSION['user_email'] ?? ''))) !== $email && !headers_sent()) {
        session_regenerate_id(true);
        setcookie(session_name(), session_id(), portalSessionCookieOptions());
    }

    $_SESSION['user_email'] = $email;
    $_SESSION['user_name'] = (string)($identity['name'] ?? $user['name'] ?? $email);
    $_SESSION['user_company'] = (string)($organization['name'] ?? '');
    $_SESSION['user_org_id'] = (string)($membership['organization_id'] ?? $organization['id'] ?? '');
    $_SESSION['platform_user_id'] = (string)($membership['user_id'] ?? $user['id'] ?? '');
    $_SESSION['org_id'] = $_SESSION['user_org_id'];
    $_SESSION['platform_branch_id'] = (string)($membership['branch_id'] ?? 'default');
    $_SESSION['branch_id'] = $_SESSION['platform_branch_id'];
    $_SESSION['user_role'] = (string)($membership['role'] ?? $user['role'] ?? 'member');
    $_SESSION['user_org_perm_level'] = $_SESSION['user_role'];
    $_SESSION['platform_node_auth'] = true;
    $_SESSION['platform_expanded_access'] = ($data['platform_expanded_access'] ?? false) === true;
    $_SESSION['platform_assistant_access'] = ($data['platform_assistant_access'] ?? false) === true;
    if (!empty($impersonation['active'])) {
        $_SESSION['is_impersonating'] = true;
        $_SESSION['impersonating_from_email'] = (string)($impersonation['admin_email'] ?? '');
        $_SESSION['impersonation_started_at'] = (string)($impersonation['started_at'] ?? '');
    } else {
        unset($_SESSION['is_impersonating'], $_SESSION['impersonating_from_email'], $_SESSION['impersonation_started_at']);
    }
}

function portalDecodeAuthSessionResponse($raw, int $status): array
{
    if ($status === 401 || $status === 403) {
        return ['authenticated' => false];
    }
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if ($status !== 200 || !is_array($data) || !array_key_exists('authenticated', $data)) {
        // A transport/backend failure is not evidence that the user's session
        // expired. Fail closed without clearing auth state or redirecting to login.
        http_response_code(503);
        header('Retry-After: 2');
        header('Cache-Control: no-store');
        header('Content-Type: text/html; charset=utf-8');
        echo portalUnavailablePage();
        exit;
    }
    return $data;
}

// Stands alone: the backend is down, so no platform script, stylesheet or
// language catalog. It looks like the portal's boot cover in its error state.
// Reloading is the person's choice (the button), never automatic.
function portalUnavailablePage(): string
{
    return <<<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f5f6f8">
<title>FirstMate is temporarily unavailable</title>
<style>
html,body{margin:0;height:100%}
body{display:grid;place-items:center;box-sizing:border-box;min-height:100vh;min-height:100dvh;padding:max(24px,env(safe-area-inset-top,0px)) 24px max(24px,env(safe-area-inset-bottom,0px));background:#f5f6f8;color:#667085;font-family:Inter,Arial,sans-serif;-webkit-text-size-adjust:100%}
.fm-unavailable{display:grid;justify-items:center;gap:18px;width:min(340px,100%);text-align:center}
.fm-unavailable-logo{width:148px;height:56px;background:#d93025;-webkit-mask:url('/images/logo_white.png') center / contain no-repeat;mask:url('/images/logo_white.png') center / contain no-repeat}
.fm-unavailable h1{margin:0;font-size:16px;font-weight:800;line-height:1.4;color:#101828}
.fm-unavailable p{margin:-8px 0 0;font-size:14px;font-weight:600;line-height:1.5;color:#667085}
.fm-unavailable button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 22px;border:0;border-radius:10px;background:#d93025;color:#fff;font:800 14px Inter,Arial,sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent}
.fm-unavailable button:active{background:#b5281f}
.fm-unavailable button:focus-visible{outline:3px solid rgba(217,48,37,.35);outline-offset:2px}
.fm-unavailable button svg{width:16px;height:16px;flex:none}
</style>
</head>
<body>
<main class="fm-unavailable" role="alert">
<span class="fm-unavailable-logo" role="img" aria-label="FirstMate"></span>
<h1>The portal is temporarily unavailable</h1>
<p>Please refresh in a moment.</p>
<button type="button" id="fmUnavailableRefresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>Refresh</button>
</main>
<script>
document.getElementById('fmUnavailableRefresh').addEventListener('click', function () {
  this.disabled = true;
  window.location.reload();
});
</script>
</body>
</html>
HTML;
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
        $_SESSION['platform_expanded_access'],
        $_SESSION['platform_assistant_access'],
        $_SESSION['is_impersonating'],
        $_SESSION['impersonating_from_email'],
        $_SESSION['impersonation_started_at'],
        $_SESSION['fm_staff'],
        $_SESSION['user_is_admin']
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
