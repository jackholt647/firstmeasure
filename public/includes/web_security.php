<?php
/**
 * Browser-facing protections shared by /measure/internal, /portal and the
 * developer tools (docs/architecture/request-security.md#browser-protections):
 * session cookie flags, CSRF tokens, same-origin redirects and the headers
 * for serving files people uploaded.
 */

if (realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    http_response_code(404);
    exit;
}

if (!function_exists('fm_request_is_https')) {

function fm_request_is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') return true;
    // TLS terminates at the load balancer; nginx passes its X-Forwarded-Proto through.
    $forwarded = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    return $forwarded === 'https';
}

/** Cookie parameters for the PHP session cookie. Lifetime 0 is a browser-session cookie. */
function fm_session_cookie_params(int $lifetime = 0): array
{
    $current = session_get_cookie_params();
    return [
        'lifetime' => $lifetime,
        'path' => '/',
        'domain' => (string)($current['domain'] ?? ''),
        'secure' => fm_request_is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ];
}

/**
 * Start the PHP session with strict mode (no client-chosen ids) and an
 * HttpOnly, SameSite=Lax cookie that is Secure over HTTPS. Use this instead of
 * a bare session_start() anywhere under /measure/internal or the dev tools.
 */
function fm_session_start_secure(int $lifetime = 0): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    if (PHP_SAPI !== 'cli' && !headers_sent()) {
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.cookie_httponly', '1');
        if ($lifetime > 0) ini_set('session.cookie_lifetime', (string)$lifetime);
        session_set_cookie_params(fm_session_cookie_params($lifetime));
    }
    session_start();
}

/** A new session id for a new identity (login, impersonation start/stop). */
function fm_session_regenerate(): void
{
    if (session_status() === PHP_SESSION_ACTIVE && !headers_sent()) {
        session_regenerate_id(true);
    }
}

/** The CSRF token for a scope, created on first use. The session must be open. */
function fm_csrf_token(string $scope = 'default'): string
{
    if (session_status() !== PHP_SESSION_ACTIVE) return '';
    $tokens = is_array($_SESSION['fm_csrf'] ?? null) ? $_SESSION['fm_csrf'] : [];
    $token = (string)($tokens[$scope] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/D', $token)) {
        $token = bin2hex(random_bytes(32));
        $tokens[$scope] = $token;
        $_SESSION['fm_csrf'] = $tokens;
    }
    return $token;
}

/** Whether a presented token matches the session's token for the scope (never creates one). */
function fm_csrf_valid(string $scope, $presented): bool
{
    $tokens = is_array($_SESSION['fm_csrf'] ?? null) ? $_SESSION['fm_csrf'] : [];
    $expected = (string)($tokens[$scope] ?? '');
    $presented = is_string($presented) ? $presented : '';
    return $expected !== '' && $presented !== '' && hash_equals($expected, $presented);
}

/** The CSRF token a request presents in the X-CSRF-Token header or a csrf_token field. */
function fm_csrf_presented(): string
{
    $header = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if ($header !== '') return $header;
    $field = $_POST['csrf_token'] ?? '';
    return is_string($field) ? $field : '';
}

/**
 * A redirect target that stays on this site: a path starting with exactly one
 * "/" (never "//" or "/\"), or a plain relative path, with no scheme, no
 * backslash and no control or space characters. Anything else is $default.
 */
function fm_safe_redirect_path($raw, string $default = '/'): string
{
    $value = is_string($raw) ? trim($raw) : '';
    if ($value === '' || strlen($value) > 2048) return $default;
    if (preg_match('/[\x00-\x20\x7f\\\\]/', $value)) return $default;
    if ($value[0] === '/') {
        return (strlen($value) > 1 && $value[1] === '/') ? $default : $value;
    }
    // A relative reference must not start with a scheme ("javascript:", "https:").
    $head = preg_split('#[/?\#]#', $value, 2)[0];
    if (strpos($head, ':') !== false) return $default;
    return $value;
}

/** File extensions a person may upload as a tutorial artifact, with the type they are served as. */
function fm_upload_safe_types(): array
{
    return [
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
        'webp' => 'image/webp', 'avif' => 'image/avif', 'bmp' => 'image/bmp',
        'tif' => 'image/tiff', 'tiff' => 'image/tiff',
        'pdf' => 'application/pdf', 'json' => 'application/json', 'txt' => 'text/plain', 'csv' => 'text/csv',
        'glb' => 'model/gltf-binary', 'gltf' => 'model/gltf+json', 'bin' => 'application/octet-stream',
        'gz' => 'application/gzip', 'zip' => 'application/zip',
        'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime',
    ];
}

function fm_upload_extension_allowed(string $name): bool
{
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    return $ext !== '' && isset(fm_upload_safe_types()[$ext]);
}

/**
 * Headers for serving a stored file a person uploaded: the type comes from the
 * extension allowlist (never from sniffing the bytes), images other than SVG
 * and PDFs display inline, everything else downloads, and the response can
 * never run script in this origin.
 */
function fm_send_uploaded_file_headers(string $name): void
{
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $types = fm_upload_safe_types();
    $type = $types[$ext] ?? 'application/octet-stream';
    $inline = (strpos($type, 'image/') === 0) || $type === 'application/pdf';
    $safeName = preg_replace('/[^A-Za-z0-9._-]/', '_', basename($name)) ?: 'file';
    header('Content-Type: ' . $type);
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . $safeName . '"');
}

}
