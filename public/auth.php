<?php
/**
 * auth.php — Include at the top of any file you want to protect.
 *
 * Setup: Create auth_users.json in the same directory:
 * [
 *   {"username": "admin", "password_hash": "$2y$10$...", "access": "root"},
 *   {"username": "viewer", "password_hash": "$2y$10$...", "access": ["measure", "reports"]}
 * ]
 *
 * access: "root"          → full access to everything
 * access: ["dir1","dir2"] → only those top-level directories
 * access omitted          → defaults to "root" for backwards compatibility
 *
 * Generate a hash at: login.php?hash=YourPassword
 * Or CLI: php -r "echo password_hash('YourPassword', PASSWORD_DEFAULT);"
 */
if (session_status() === PHP_SESSION_NONE) {
    $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    ini_set('session.cookie_httponly', '1');
    ini_set('session.cookie_secure', $isHttps ? '1' : '0');
    ini_set('session.use_strict_mode', '1');
    session_start();
}
define('AUTH_USERS_FILE', __DIR__ . '/auth_users.json');
define('AUTH_SESSION_KEY', 'ide_authenticated');
define('AUTH_SESSION_USER', 'ide_username');
define('AUTH_SESSION_EXPIRY', 'ide_auth_expiry');
define('AUTH_SESSION_ACCESS', 'ide_access');
define('AUTH_TIMEOUT', 86400 * 7); // 7 days
define('AUTH_HARD_ROOT_USER', 'admin');
define('AUTH_HARD_PROTECTED_TOP_DIRS', ['67841']);

function auth_is_logged_in(): bool {
    if (empty($_SESSION[AUTH_SESSION_KEY])) return false;
    if (!empty($_SESSION[AUTH_SESSION_EXPIRY]) && time() > $_SESSION[AUTH_SESSION_EXPIRY]) {
        auth_logout();
        return false;
    }
    return true;
}

function auth_get_user(): ?string {
    return $_SESSION[AUTH_SESSION_USER] ?? null;
}

function auth_is_hard_root_user(): bool {
    return strtolower((string)auth_get_user()) === strtolower(AUTH_HARD_ROOT_USER);
}

/**
 * Get the current user's access permissions.
 * Returns "root" or an array of allowed top-level directory names.
 */
function auth_get_access(): string|array {
    return $_SESSION[AUTH_SESSION_ACCESS] ?? 'root';
}

/**
 * Check if the current user has root (full) access.
 */
function auth_has_root(): bool {
    return auth_get_access() === 'root';
}

function auth_top_dir_from_path(string $relPath): string {
    $relPath = trim(str_replace('\\', '/', $relPath), '/');
    if ($relPath === '' || $relPath === '.') return '';
    $firstSlash = strpos($relPath, '/');
    return ($firstSlash !== false) ? substr($relPath, 0, $firstSlash) : $relPath;
}

function auth_is_hard_protected_top_dir(string $dirName): bool {
    foreach (AUTH_HARD_PROTECTED_TOP_DIRS as $protectedDir) {
        if (strcasecmp($dirName, $protectedDir) === 0) {
            return true;
        }
    }
    return false;
}

function auth_is_hard_blocked_path(string $relPath): bool {
    if (auth_is_hard_root_user()) return false;
    $topDir = auth_top_dir_from_path($relPath);
    return $topDir !== '' && auth_is_hard_protected_top_dir($topDir);
}

/**
 * Check if the current user can access a given relative path.
 * Empty path (root listing) is always allowed — filtering happens at list time.
 */
function auth_can_access_path(string $relPath): bool {
    $relPath = trim(str_replace('\\', '/', $relPath), '/');
    if ($relPath === '' || $relPath === '.') {
        // Root listing is allowed; items are filtered in list/tree actions.
        return true;
    }
    if (auth_is_hard_blocked_path($relPath)) return false;
    if (auth_has_root()) return true;

    $allowed = auth_get_access();
    if (!is_array($allowed)) return false;

    // Get the first path segment
    $topDir = auth_top_dir_from_path($relPath);

    foreach ($allowed as $dir) {
        if (strcasecmp($topDir, $dir) === 0) {
            return true;
        }
    }

    return false;
}

/**
 * Check if a top-level directory name is visible to the current user.
 * Used when listing the root to hide unauthorized directories entirely.
 */
function auth_can_see_top_dir(string $dirName): bool {
    if (auth_is_hard_protected_top_dir($dirName) && !auth_is_hard_root_user()) return false;
    if (auth_has_root()) return true;

    $allowed = auth_get_access();
    if (!is_array($allowed)) return false;

    foreach ($allowed as $dir) {
        if (strcasecmp($dirName, $dir) === 0) {
            return true;
        }
    }

    return false;
}

function auth_login(string $username, string $password): bool {
    $users = auth_load_users();
    foreach ($users as $u) {
        if (strtolower($u['username']) === strtolower($username)) {
            if (password_verify($password, $u['password_hash'])) {
                session_regenerate_id(true);
                $_SESSION[AUTH_SESSION_KEY] = true;
                $_SESSION[AUTH_SESSION_USER] = $u['username'];
                $_SESSION[AUTH_SESSION_EXPIRY] = time() + AUTH_TIMEOUT;
                // Store access: "root" (default) or array of directory names
                $_SESSION[AUTH_SESSION_ACCESS] = $u['access'] ?? 'root';
                return true;
            }
        }
    }
    return false;
}

function auth_logout(): void {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}

function auth_load_users(): array {
    if (!file_exists(AUTH_USERS_FILE)) return [];
    $data = json_decode(file_get_contents(AUTH_USERS_FILE), true);
    return is_array($data) ? $data : [];
}

function auth_require_login(): void {
    if (!auth_is_logged_in()) {
        if (
            (isset($_SERVER['HTTP_ACCEPT']) && strpos($_SERVER['HTTP_ACCEPT'], 'application/json') !== false) ||
            (isset($_SERVER['HTTP_X_REQUESTED_WITH']) && $_SERVER['HTTP_X_REQUESTED_WITH'] === 'XMLHttpRequest')
        ) {
            http_response_code(401);
            header('Content-Type: application/json');
            echo json_encode(['ok' => false, 'error' => 'Authentication required']);
            exit;
        }
        $return = $_SERVER['REQUEST_URI'] ?? '';
        header('Location: /login.php' . ($return ? '?return=' . urlencode($return) : ''));
        exit;
    }
}
