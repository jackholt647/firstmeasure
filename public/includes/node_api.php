<?php
/**
 * PHP to Node (docs/architecture/request-security.md#service-calls).
 *
 * - Node is reached at a configured base URL, never one built from the
 *   request's Host. Without configuration PHP refuses (logged), except a
 *   loopback default for a developer's own machine.
 * - TLS is verified and redirects are never followed (a redirect would carry
 *   the signature or cookie to another host).
 * - A call made for the signed-in staff member is signed with the internal
 *   secret, actor = their email, and only when backend_login (or the staff
 *   gate) verified the platform session with Node. A call PHP makes on its own
 *   is signed as "system". A call made in the browser user's own context
 *   forwards their platform session cookie instead.
 *
 * The signature matches public/v1/platform/security/service.ts exactly:
 *   hex(HMAC-SHA256(secret, "v1\nMETHOD\npath?query\ntime\nactor\nbodysha256"))
 */

if (realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    http_response_code(404);
    exit;
}

if (!function_exists('fm_node_config')) {

require_once __DIR__ . '/provider_keys.php';

define('FM_NODE_UNSIGNED_PAYLOAD', 'UNSIGNED-PAYLOAD');
define('FM_STAFF_REVERIFY_SECONDS', 600);

/** A configuration value from the PHP-FPM environment or a fastcgi_param. */
function fm_node_config(string $name): string
{
    $value = getenv($name);
    if (!is_string($value) || trim($value) === '') $value = $_SERVER[$name] ?? '';
    return trim((string)$value);
}

/**
 * True only for a developer's own machine: the request names a loopback host
 * and really arrives over loopback (or the built-in PHP server). A forged
 * Host header on a public host never qualifies.
 */
function fm_node_request_is_local_dev(): bool
{
    if (PHP_SAPI === 'cli' && !isset($_SERVER['HTTP_HOST'])) return true;
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $host = preg_replace('/:\d+$/', '', $host);
    $host = trim((string)$host, '[]');
    if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true)) return false;
    if (PHP_SAPI === 'cli-server') return true;
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    return $remote === '127.0.0.1' || $remote === '::1';
}

function fm_node_strip_suffix(string $base, array $suffixes): string
{
    $base = rtrim($base, '/');
    foreach ($suffixes as $suffix) {
        if ($suffix !== '' && substr($base, -strlen($suffix)) === $suffix) return rtrim(substr($base, 0, -strlen($suffix)), '/');
    }
    return $base;
}

function fm_node_valid_base(string $base): bool
{
    $parts = parse_url($base);
    if (!is_array($parts)) return false;
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    return in_array($scheme, ['http', 'https'], true) && !empty($parts['host'])
        && !isset($parts['user']) && !isset($parts['pass']) && !isset($parts['query']) && !isset($parts['fragment']);
}

/**
 * The Node `/v1` base for a purpose:
 * - 'api': /v1/firstmeasure, /v1/internal, /v1/communications. From
 *   FIRSTMEASURE_API_BASE (a /v1/firstmeasure URL), else
 *   FIRSTMEASURE_NODE_BASE_URL (a /v1/platform URL).
 * - 'session': /v1/platform/auth/session, which the compatibility Node also
 *   answers on loopback. From FIRSTMEASURE_NODE_BASE_URL, else the API base.
 * '' when neither is configured (and logged): callers refuse.
 */
function fm_node_v1_base_url(string $purpose = 'api', int $localPort = 3111): string
{
    $api = fm_node_config('FIRSTMEASURE_API_BASE');
    $node = fm_node_config('FIRSTMEASURE_NODE_BASE_URL');
    $candidates = $purpose === 'session' ? [$node, $api] : [$api, $node];
    foreach ($candidates as $candidate) {
        if ($candidate === '') continue;
        $base = fm_node_strip_suffix($candidate, ['/firstmeasure', '/platform']);
        if (fm_node_valid_base($base)) return $base;
        error_log('FirstMeasure: ignoring an invalid Node base URL setting.');
    }
    if (fm_node_request_is_local_dev()) return 'http://127.0.0.1:' . $localPort . '/v1';
    static $logged = false;
    if (!$logged) {
        $logged = true;
        error_log('FirstMeasure: FIRSTMEASURE_API_BASE / FIRSTMEASURE_NODE_BASE_URL is not configured; refusing to call Node.');
    }
    return '';
}

/** `{v1 base}/{path}`, or '' when Node is not configured. */
function fm_node_v1_url(string $path, string $purpose = 'api', int $localPort = 3111): string
{
    $base = fm_node_v1_base_url($purpose, $localPort);
    return $base === '' ? '' : $base . '/' . ltrim($path, '/');
}

function fm_node_not_configured_result(): array
{
    return ['ok' => false, 'status' => 503, 'error' => 'node_base_url_not_configured', 'headers' => [], 'body' => '', 'json' => null, 'url' => ''];
}

/**
 * The secret that signs a request to `$url`. Every Node role accepts its
 * provider-key secret and its FIRSTMEASURE_INTERNAL_API_SECRET environment
 * value (platform/security/service.ts serviceSecrets), so one shared value
 * signs for web and compatibility alike. FIRSTMEASURE_NODE_SIGNING_SECRET
 * overrides it; the full-house signing secret (set where a compatibility
 * host's provider file differs from the web nodes') comes next.
 */
function fm_node_service_secret(string $url = ''): string
{
    $explicit = fm_node_config('FIRSTMEASURE_NODE_SIGNING_SECRET');
    if ($explicit !== '') return $explicit;
    $fullHouse = fm_node_config('FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET');
    if ($fullHouse !== '') return $fullHouse;
    $provider = fm_provider_key_value('application', 'internal_api_secret');
    if ($provider !== '') return $provider;
    return fm_node_config('FIRSTMEASURE_INTERNAL_API_SECRET');
}

/** The exact request target Node sees (`request.url`): path plus query. */
function fm_node_request_target(string $url): string
{
    $parts = parse_url($url);
    $target = (string)($parts['path'] ?? '/');
    if ($target === '') $target = '/';
    if (isset($parts['query']) && $parts['query'] !== '') $target .= '?' . $parts['query'];
    return $target;
}

/**
 * Signature headers for one request. `$body` is the exact string sent (null
 * for none); a multipart body cannot be hashed before curl builds it and is
 * signed as UNSIGNED-PAYLOAD, which Node accepts only for multipart.
 */
function fm_node_signature_headers(string $method, string $url, string $actor, $body = null, bool $multipart = false, ?int $time = null): array
{
    $actor = strtolower(trim($actor));
    $secret = fm_node_service_secret($url);
    if ($actor === '' || $secret === '') return [];
    $time = (string)($time ?? time());
    if ($multipart) $bodySha = FM_NODE_UNSIGNED_PAYLOAD;
    elseif (is_string($body)) $bodySha = hash('sha256', $body);
    else $bodySha = hash('sha256', '');
    $payload = implode("\n", ['v1', strtoupper($method), fm_node_request_target($url), $time, $actor, $bodySha]);
    return [
        'X-FM-Service-Time: ' . $time,
        'X-FM-Service-Actor: ' . $actor,
        'X-FM-Service-Body-Sha256: ' . $bodySha,
        'X-FM-Service-Signature: ' . hash_hmac('sha256', $payload, $secret),
    ];
}

/** Headers that sign a request whose body PHP streams from a file or php://input. */
function fm_node_signature_headers_for_stream(string $method, string $url, string $actor, string $streamPath): array
{
    $sha = @hash_file('sha256', $streamPath);
    if (!is_string($sha)) return [];
    $actor = strtolower(trim($actor));
    $secret = fm_node_service_secret($url);
    if ($actor === '' || $secret === '') return [];
    $time = (string)time();
    $payload = implode("\n", ['v1', strtoupper($method), fm_node_request_target($url), $time, $actor, $sha]);
    return [
        'X-FM-Service-Time: ' . $time,
        'X-FM-Service-Actor: ' . $actor,
        'X-FM-Service-Body-Sha256: ' . $sha,
        'X-FM-Service-Signature: ' . hash_hmac('sha256', $payload, $secret),
    ];
}

// ---------------------------------------------------------------------------
// Staff identity in the PHP session
// ---------------------------------------------------------------------------

/**
 * The staff email this PHP session may act for, or ''. Set only after Node
 * verified the platform session as staff (fm_staff_apply_verified_user); a
 * customer login copied into the shared session (portal session_bootstrap)
 * never satisfies it, and any change of user_email invalidates it.
 */
function fm_staff_session_email(): string
{
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $verified = is_array($_SESSION['fm_staff'] ?? null) ? $_SESSION['fm_staff'] : [];
    $verifiedEmail = strtolower(trim((string)($verified['email'] ?? '')));
    if ($email === '' || $verifiedEmail === '' || !hash_equals($verifiedEmail, $email)) return '';
    return $email;
}

function fm_staff_session_is_admin(): bool
{
    return fm_staff_session_email() !== '' && !empty($_SESSION['user_is_admin']);
}

/** The actor a call made for this request signs as: the verified staff email, or ''. */
function fm_node_session_actor(): string
{
    return fm_staff_session_email();
}

function fm_platform_session_cookie_name(): string
{
    $configured = fm_node_config('PLATFORM_SESSION_COOKIE_NAME');
    return preg_match('/^[A-Za-z0-9_-]{1,80}$/D', $configured) ? $configured : 'fm_platform_session';
}

/**
 * The browser's platform cookies, as sent: [[name, raw value], ...] for the
 * session, its CSRF cookie and the account-device cookie. A browser can hold
 * two session cookies with the same name (different paths or domains); Node
 * picks the newest live one, so every occurrence is kept, in order.
 */
function fm_platform_cookie_pairs(): array
{
    $name = fm_platform_session_cookie_name();
    $wanted = [$name, $name . '_csrf', $name . '_accounts'];
    $pairs = [];
    foreach (explode(';', (string)($_SERVER['HTTP_COOKIE'] ?? '')) as $part) {
        $eq = strpos($part, '=');
        if ($eq === false) continue;
        $key = trim(substr($part, 0, $eq));
        $value = trim(substr($part, $eq + 1));
        if ($value === '' || !in_array($key, $wanted, true) || preg_match('/[\x00-\x1f\x7f;,\s]/', $value)) continue;
        $pairs[] = [$key, $value];
    }
    return $pairs;
}

/** The browser's platform session cookie value (the first one sent), or ''. */
function fm_platform_session_cookie(): string
{
    $name = fm_platform_session_cookie_name();
    foreach (fm_platform_cookie_pairs() as [$key, $value]) {
        if ($key === $name) return $value;
    }
    return '';
}

/**
 * Headers that let Node see the browser user's own platform session: the
 * platform cookies only (not PHP's), and for a write the browser's own
 * Origin plus the double-submit CSRF header, so Node's cross-site write check
 * applies to the browser's request exactly as if it called Node itself.
 */
function fm_node_cookie_headers(bool $write = false): array
{
    $name = fm_platform_session_cookie_name();
    if (fm_platform_session_cookie() === '') return [];
    $cookies = [];
    $csrf = '';
    foreach (fm_platform_cookie_pairs() as [$key, $value]) {
        $cookies[] = $key . '=' . $value;
        if ($key === $name . '_csrf' && $csrf === '') $csrf = rawurldecode($value);
    }
    if (preg_match('/[\r\n]/', $csrf)) $csrf = '';
    $headers = ['Cookie: ' . implode('; ', $cookies)];
    if ($write) {
        $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
        $referer = (string)($_SERVER['HTTP_REFERER'] ?? '');
        if ($origin !== '' && !preg_match('/[\r\n]/', $origin)) $headers[] = 'Origin: ' . $origin;
        elseif ($referer !== '' && !preg_match('/[\r\n]/', $referer)) $headers[] = 'Referer: ' . $referer;
        if ($csrf !== '') $headers[] = 'X-Platform-CSRF: ' . $csrf;
    }
    return $headers;
}

/**
 * Identity headers for a request. `$auth`:
 * - 'session' (default): sign as the verified staff member; nothing when
 *   there is none (Node then refuses, as it should).
 * - 'system': sign as "system", for work PHP does on its own.
 * - 'cookie': forward the browser's platform session.
 * - 'none': no identity.
 */
function fm_node_identity_headers(string $auth, string $method, string $url, $body = null, bool $multipart = false): array
{
    switch ($auth) {
        case 'system':
            return fm_node_signature_headers($method, $url, 'system', $body, $multipart);
        case 'cookie':
            return fm_node_cookie_headers(!in_array(strtoupper($method), ['GET', 'HEAD', 'OPTIONS'], true));
        case 'none':
            return [];
        default:
            $actor = fm_node_session_actor();
            return $actor === '' ? [] : fm_node_signature_headers($method, $url, $actor, $body, $multipart);
    }
}

/** The curl options every PHP to Node request uses. */
function fm_node_curl_options(): array
{
    $options = [
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROXY => '',
    ];
    if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTP') && defined('CURLPROTO_HTTPS')) {
        $options[CURLOPT_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
    }
    return $options;
}

/** Stream-context TLS options with verification on. */
function fm_node_stream_ssl_options(): array
{
    return ['verify_peer' => true, 'verify_peer_name' => true];
}

/**
 * One JSON-ish request to Node. Options: json (encoded and sent), body (raw
 * string), headers, auth ('session'|'system'|'cookie'|'none'), timeout,
 * connect_timeout. Returns ok/status/json/body/error/headers/url.
 */
function fm_node_request(string $method, string $url, array $opts = []): array
{
    $method = strtoupper(trim($method));
    if ($url === '') return fm_node_not_configured_result();
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'status' => 500, 'error' => 'curl_missing', 'headers' => [], 'body' => '', 'json' => null, 'url' => $url];
    }
    $headers = array_merge(['Accept: application/json'], (array)($opts['headers'] ?? []));
    $body = null;
    if (array_key_exists('json', $opts)) {
        $body = json_encode($opts['json']);
        $headers[] = 'Content-Type: application/json';
    } elseif (isset($opts['body']) && is_string($opts['body'])) {
        $body = $opts['body'];
    }
    $sent = ($body !== null && $method !== 'GET' && $method !== 'HEAD') ? $body : null;
    $headers = array_merge($headers, fm_node_identity_headers((string)($opts['auth'] ?? 'session'), $method, $url, $sent));

    $responseHeaders = [];
    $ch = curl_init($url);
    curl_setopt_array($ch, fm_node_curl_options() + [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => (int)($opts['timeout'] ?? 15),
        CURLOPT_CONNECTTIMEOUT => (int)($opts['connect_timeout'] ?? 3),
        CURLOPT_HEADERFUNCTION => function ($curl, $line) use (&$responseHeaders) {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
            return strlen($line);
        },
    ]);
    if ($sent !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $sent);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    $text = is_string($raw) ? $raw : '';
    $json = $text !== '' ? json_decode($text, true) : null;
    return [
        'ok' => $error === '' && $status >= 200 && $status < 300,
        'status' => $status,
        'error' => $error !== '' ? $error : null,
        'headers' => $responseHeaders,
        'body' => $text,
        'json' => is_array($json) ? $json : null,
        'url' => $url,
    ];
}

// ---------------------------------------------------------------------------
// Verifying staff with Node
// ---------------------------------------------------------------------------

/** Whether an internal user record may use the staff console (unchanged rule). */
function fm_staff_user_can_access_internal(array $user): bool
{
    $status = strtolower(trim((string)($user['status'] ?? 'active')));
    if ($status === 'disabled' || $status === 'inactive') return false;
    $role = strtolower(trim((string)($user['role'] ?? '')));
    $permissions = is_array($user['permissions'] ?? null) ? $user['permissions'] : [];
    if (($user['account_type'] ?? '') === 'employee') return true;
    if (in_array($role, ['admin', 'manager', 'qa', 'technician', 'sales_manager', 'salesperson', 'trainee'], true)) return true;
    foreach (['is_admin_legacy', 'view_all_projects', 'manage_queue', 'manage_users', 'manage_qa', 'manage_sales_users'] as $key) {
        if (!empty($permissions[$key])) return true;
    }
    return false;
}

function fm_staff_user_is_strict_admin(array $user): bool
{
    $role = strtolower(trim((string)($user['role'] ?? '')));
    $permissions = is_array($user['permissions'] ?? null) ? $user['permissions'] : [];
    return $role === 'admin' || !empty($user['is_admin']) || !empty($permissions['is_admin_legacy']);
}

/**
 * Ask Node who the browser's platform session is as staff:
 * GET {api}/internal/me with the session cookie. Returns
 * ['state' => 'staff', 'user' => [...]] | ['state' => 'not_staff'] |
 * ['state' => 'error', 'status' => n]. Node answers 200 with `user` only for
 * a staff session (as the impersonated target while an admin acts as them).
 */
function fm_staff_verify_with_node(): array
{
    if (fm_platform_session_cookie() === '') return ['state' => 'not_staff', 'status' => 401];
    $url = fm_node_v1_url('internal/me');
    if ($url === '') return ['state' => 'error', 'status' => 503];
    $res = fm_node_request('GET', $url, ['auth' => 'cookie', 'timeout' => 8]);
    $status = (int)$res['status'];
    if ($status === 401 || $status === 403 || $status === 404) return ['state' => 'not_staff', 'status' => $status];
    if (!$res['ok'] || !is_array($res['json'])) {
        error_log('FirstMeasure staff verification failed: HTTP ' . $status);
        return ['state' => 'error', 'status' => $status ?: 502];
    }
    $meUser = is_array($res['json']['user'] ?? null) ? $res['json']['user'] : [];
    $email = strtolower(trim((string)($meUser['email'] ?? '')));
    if ($email === '') return ['state' => 'not_staff', 'status' => 403];

    // Second, independent proof: the staff record itself, which Node serves
    // only to a staff principal ({staff: any}). An older /me answered every
    // signed-in identity with a synthetic user built from its own role, so
    // /me alone must never make anyone staff.
    $recordUrl = fm_node_v1_url('internal/users/' . rawurlencode($email));
    $record = fm_node_request('GET', $recordUrl, ['auth' => 'cookie', 'timeout' => 8]);
    $recordStatus = (int)$record['status'];
    if ($recordStatus === 401 || $recordStatus === 403 || $recordStatus === 404) return ['state' => 'not_staff', 'status' => $recordStatus];
    if (!$record['ok'] || !is_array($record['json'])) {
        error_log('FirstMeasure staff record lookup failed: HTTP ' . $recordStatus);
        return ['state' => 'error', 'status' => $recordStatus ?: 502];
    }
    $user = is_array($record['json']['user'] ?? null) ? $record['json']['user'] : [];
    if (strtolower(trim((string)($user['email'] ?? $user['id'] ?? ''))) !== $email || !fm_staff_user_can_access_internal($user)) {
        return ['state' => 'not_staff', 'status' => 403];
    }
    $user['email'] = $email;
    return ['state' => 'staff', 'user' => $user, 'me' => $res['json']];
}

/**
 * Node's impersonation mark for the admin's session:
 * ['target_email','admin_email','expires_at','started_at'], or null when there
 * is none. $failed is set when Node could not be asked (keep what PHP has).
 */
function fm_staff_node_impersonation(?bool &$failed = null): ?array
{
    $failed = false;
    $url = fm_node_v1_url('internal/impersonation');
    if ($url === '' || fm_platform_session_cookie() === '') return null;
    $res = fm_node_request('GET', $url, ['auth' => 'cookie', 'timeout' => 6]);
    if (!$res['ok'] || !is_array($res['json'])) {
        $failed = !in_array((int)$res['status'], [401, 403, 404], true);
        return null;
    }
    $data = is_array($res['json']['impersonation'] ?? null) ? $res['json']['impersonation'] : $res['json'];
    $target = strtolower(trim((string)($data['target_email'] ?? '')));
    if ($target === '' || (isset($data['active']) && !$data['active'])) return null;
    $expires = (string)($data['expires_at'] ?? '');
    if ($expires !== '' && strtotime($expires) !== false && strtotime($expires) <= time()) return null;
    return [
        'target_email' => $target,
        'admin_email' => strtolower(trim((string)($data['admin_email'] ?? ''))),
        'expires_at' => $expires,
        'started_at' => (string)($data['started_at'] ?? ''),
    ];
}

/** Set the PHP session to a Node-verified staff user (the console renders as them). */
function fm_staff_apply_verified_user(array $user): void
{
    $email = strtolower(trim((string)($user['email'] ?? '')));
    $role = strtolower(trim((string)($user['role'] ?? 'user')));
    $_SESSION['user_email'] = $email;
    $_SESSION['user_name'] = (string)($user['name'] ?? $email);
    $_SESSION['user_role'] = $role ?: 'user';
    $_SESSION['user_team_id'] = (string)($user['team_id'] ?? 'default');
    $_SESSION['user_branch_id'] = (string)($user['branch_id'] ?? 'default');
    $_SESSION['user_is_admin'] = fm_staff_user_is_strict_admin($user);
    $_SESSION['platform_node_auth'] = true;
    $_SESSION['fm_staff'] = ['email' => $email, 'verified_at' => time()];
}

/** Record (or clear) the impersonation Node reports, keeping the admin for "stop". */
function fm_staff_apply_impersonation(?array $impersonation, string $staffEmail): void
{
    if ($impersonation && $impersonation['target_email'] === $staffEmail) {
        $_SESSION['is_impersonating'] = true;
        $admin = $impersonation['admin_email'] !== '' ? $impersonation['admin_email'] : (string)($_SESSION['impersonating_from_email'] ?? '');
        $_SESSION['impersonating_from_email'] = $admin;
        if (empty($_SESSION['impersonating_from_name'])) $_SESSION['impersonating_from_name'] = $admin;
        if (empty($_SESSION['impersonating_started_at'])) $_SESSION['impersonating_started_at'] = $impersonation['started_at'] ?: date('c');
        $_SESSION['impersonation_expires_at'] = $impersonation['expires_at'];
        return;
    }
    unset(
        $_SESSION['is_impersonating'],
        $_SESSION['impersonating_from_email'],
        $_SESSION['impersonating_from_name'],
        $_SESSION['impersonating_from_role'],
        $_SESSION['impersonating_started_at'],
        $_SESSION['impersonation_expires_at']
    );
}

/** Drop the staff identity (a customer's portal state in the shared session is left alone). */
function fm_staff_clear_session(): void
{
    if (empty($_SESSION['fm_staff'])) return;
    unset(
        $_SESSION['fm_staff'],
        $_SESSION['user_email'],
        $_SESSION['user_name'],
        $_SESSION['user_role'],
        $_SESSION['user_is_admin'],
        $_SESSION['user_team_id'],
        $_SESSION['user_branch_id']
    );
    fm_staff_apply_impersonation(null, '');
}

/**
 * Verify the browser's platform session with Node and, when it is staff, set
 * the PHP session from Node's answer. A changed identity gets a new session id.
 * Returns the fm_staff_verify_with_node() result.
 */
function fm_staff_refresh_from_node(): array
{
    $result = fm_staff_verify_with_node();
    if ($result['state'] === 'staff') {
        $email = $result['user']['email'];
        if (strtolower(trim((string)($_SESSION['user_email'] ?? ''))) !== $email && function_exists('fm_session_regenerate')) {
            fm_session_regenerate();
        }
        fm_staff_apply_verified_user($result['user']);
        $impersonation = fm_staff_node_impersonation($impersonationFailed);
        if (!$impersonationFailed) fm_staff_apply_impersonation($impersonation, $email);
    } elseif ($result['state'] === 'not_staff') {
        fm_staff_clear_session();
    }
    return $result;
}

/**
 * The staff email for this request, re-verifying with Node when the session
 * has none yet (the platform cookie may already be a staff session) or the
 * last verification is older than FM_STAFF_REVERIFY_SECONDS. '' when not
 * staff. A Node outage on re-verification fails closed with 503.
 * The PHP session must be open.
 */
function fm_staff_session_resolve(): string
{
    $email = fm_staff_session_email();
    $verifiedAt = (int)(($_SESSION['fm_staff']['verified_at'] ?? 0));
    if ($email !== '' && time() - $verifiedAt < FM_STAFF_REVERIFY_SECONDS) return $email;
    if ($email === '' && fm_platform_session_cookie() === '') return '';
    $result = fm_staff_refresh_from_node();
    if ($result['state'] === 'error') {
        http_response_code(503);
        header('Retry-After: 2');
        header('Cache-Control: no-store');
        header('Content-Type: text/plain; charset=utf-8');
        exit('Staff access could not be verified right now. Please refresh in a moment.');
    }
    return fm_staff_session_email();
}

}
