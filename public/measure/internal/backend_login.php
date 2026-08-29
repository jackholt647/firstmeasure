<?php
require_once __DIR__ . '/_storage.php';
/**
 * login.php - Backend Login (Staff Console)
 * Authenticates through the Node Platform API, then hydrates the legacy PHP
 * session keys that the internal shell still checks.
 */

session_start();

function backendNodeBaseUrl(): string
{
    $configured = trim((string)(getenv('FIRSTMEASURE_NODE_BASE_URL') ?: ($_SERVER['FIRSTMEASURE_NODE_BASE_URL'] ?? '')));
    if ($configured !== '') {
        $base = rtrim($configured, '/');
        // The shared PHP configuration points at the Platform API, while this
        // bridge also calls /v1/internal endpoints. Normalize it to /v1.
        if (substr($base, -9) === '/platform') {
            $base = substr($base, 0, -9);
        }
        return rtrim($base, '/');
    }
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost') {
        return 'http://127.0.0.1:3111/v1';
    }
    $forwardedProto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    $scheme = $forwardedProto === 'https' || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . '/v1';
}

function backendJsonResponse(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function backendCurlJson(string $url, array $headers = []): array
{
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'status' => 500, 'data' => null, 'error' => 'curl_missing'];
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array_merge(['Accept: application/json'], $headers),
        CURLOPT_TIMEOUT => 8,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    return [
        'ok' => $status >= 200 && $status < 300 && is_array($data),
        'status' => $status ?: 500,
        'data' => is_array($data) ? $data : null,
        'error' => $error,
    ];
}

function backendUserCanAccessInternal(array $user): bool
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

function backendCleanEmail($value): string
{
    return strtolower(trim((string)$value));
}

function backendUserIsStrictAdmin(array $user): bool
{
    $role = strtolower(trim((string)($user['role'] ?? '')));
    $permissions = is_array($user['permissions'] ?? null) ? $user['permissions'] : [];
    return $role === 'admin' || !empty($user['is_admin']) || !empty($permissions['is_admin_legacy']);
}

function backendInternalGet(string $path, string $actorEmail = '', string $actorName = ''): array
{
    $headers = [];
    if ($actorEmail !== '') {
        $headers[] = 'X-Internal-User-Email: ' . $actorEmail;
    }
    if ($actorName !== '') {
        $headers[] = 'X-Internal-User-Name: ' . $actorName;
    }
    return backendCurlJson(backendNodeBaseUrl() . '/internal/' . ltrim($path, '/'), $headers);
}

function backendFetchInternalUser(string $email, string $actorEmail = '', string $actorName = ''): ?array
{
    $cleanEmail = backendCleanEmail($email);
    if ($cleanEmail === '') return null;
    $res = backendInternalGet('users/' . rawurlencode($cleanEmail), $actorEmail, $actorName);
    $data = is_array($res['data'] ?? null) ? $res['data'] : [];
    $user = is_array($data['user'] ?? null) ? $data['user'] : null;
    return ($res['ok'] && is_array($user)) ? $user : null;
}

function backendApplyInternalUserSession(array $user): void
{
    $email = backendCleanEmail($user['email'] ?? $user['id'] ?? '');
    if ($email === '') {
        backendJsonResponse(500, ['success' => false, 'error' => 'target_missing_email']);
    }
    $role = strtolower(trim((string)($user['role'] ?? 'user')));
    $permissions = is_array($user['permissions'] ?? null) ? $user['permissions'] : [];
    $_SESSION['user_email'] = $email;
    $_SESSION['user_name'] = (string)($user['name'] ?? $email);
    $_SESSION['user_role'] = $role ?: 'user';
    $_SESSION['user_team_id'] = (string)($user['team_id'] ?? 'default');
    $_SESSION['user_branch_id'] = (string)($user['branch_id'] ?? 'default');
    $_SESSION['user_is_admin'] = backendUserIsStrictAdmin($user);
    $_SESSION['platform_node_auth'] = true;
}

function backendRequireStrictAdminSession(): array
{
    $email = backendCleanEmail($_SESSION['user_email'] ?? '');
    if ($email === '') {
        backendJsonResponse(401, ['success' => false, 'error' => 'missing_admin_session']);
    }
    $user = backendFetchInternalUser($email, $email, (string)($_SESSION['user_name'] ?? $email));
    if (!$user || !backendUserCanAccessInternal($user) || !backendUserIsStrictAdmin($user)) {
        backendJsonResponse(403, ['success' => false, 'error' => 'strict_admin_required']);
    }
    return $user;
}

function backendImpersonateInternalUser(): void
{
    if (!empty($_SESSION['is_impersonating'])) {
        backendJsonResponse(409, ['success' => false, 'error' => 'already_impersonating']);
    }

    $admin = backendRequireStrictAdminSession();
    $adminEmail = backendCleanEmail($admin['email'] ?? $_SESSION['user_email'] ?? '');
    $targetEmail = backendCleanEmail($_POST['email'] ?? $_POST['target_email'] ?? '');
    if ($targetEmail === '') {
        backendJsonResponse(400, ['success' => false, 'error' => 'missing_target_email']);
    }
    if ($targetEmail === $adminEmail) {
        backendJsonResponse(400, ['success' => false, 'error' => 'cannot_impersonate_self']);
    }

    $target = backendFetchInternalUser($targetEmail, $adminEmail, (string)($admin['name'] ?? $adminEmail));
    if (!$target) {
        backendJsonResponse(404, ['success' => false, 'error' => 'target_not_found']);
    }
    if (!backendUserCanAccessInternal($target)) {
        backendJsonResponse(403, ['success' => false, 'error' => 'target_not_internal_user']);
    }

    session_regenerate_id(true);
    $_SESSION['is_impersonating'] = true;
    $_SESSION['impersonating_from_email'] = $adminEmail;
    $_SESSION['impersonating_from_name'] = (string)($admin['name'] ?? $adminEmail);
    $_SESSION['impersonating_from_role'] = (string)($admin['role'] ?? 'admin');
    $_SESSION['impersonating_started_at'] = date('c');
    backendApplyInternalUserSession($target);

    backendJsonResponse(200, [
        'success' => true,
        'impersonating' => true,
        'admin_email' => $adminEmail,
        'target_email' => $_SESSION['user_email'],
        'target_name' => $_SESSION['user_name'],
        'target_role' => $_SESSION['user_role'],
    ]);
}

function backendStopInternalImpersonation(): void
{
    $adminEmail = backendCleanEmail($_SESSION['impersonating_from_email'] ?? '');
    if (empty($_SESSION['is_impersonating']) || $adminEmail === '') {
        backendJsonResponse(409, ['success' => false, 'error' => 'not_impersonating']);
    }

    $admin = backendFetchInternalUser($adminEmail, $adminEmail, (string)($_SESSION['impersonating_from_name'] ?? $adminEmail));
    if (!$admin || !backendUserIsStrictAdmin($admin)) {
        backendJsonResponse(403, ['success' => false, 'error' => 'admin_restore_failed']);
    }

    session_regenerate_id(true);
    unset(
        $_SESSION['is_impersonating'],
        $_SESSION['impersonating_from_email'],
        $_SESSION['impersonating_from_name'],
        $_SESSION['impersonating_from_role'],
        $_SESSION['impersonating_started_at']
    );
    backendApplyInternalUserSession($admin);

    backendJsonResponse(200, [
        'success' => true,
        'impersonating' => false,
        'user_email' => $_SESSION['user_email'],
        'user_name' => $_SESSION['user_name'],
    ]);
}

function backendHydratePhpSessionFromNode(): void
{
    $cookie = (string)($_SERVER['HTTP_COOKIE'] ?? '');
    if ($cookie === '' || strpos($cookie, 'fm_platform_session=') === false) {
        backendJsonResponse(401, ['success' => false, 'error' => 'missing_node_session']);
    }

    $base = backendNodeBaseUrl();
    $session = backendCurlJson($base . '/platform/auth/session', ['Cookie: ' . $cookie]);
    $sessionData = is_array($session['data'] ?? null) ? $session['data'] : [];
    if (!$session['ok'] || empty($sessionData['authenticated'])) {
        backendJsonResponse(401, ['success' => false, 'error' => 'node_session_invalid']);
    }

    $identity = is_array($sessionData['identity'] ?? null) ? $sessionData['identity'] : [];
    $membership = is_array($sessionData['membership'] ?? null) ? $sessionData['membership'] : [];
    $email = strtolower(trim((string)($identity['email'] ?? '')));
    if ($email === '') {
        backendJsonResponse(401, ['success' => false, 'error' => 'node_session_missing_email']);
    }

    $internal = backendCurlJson($base . '/internal/me', [
        'X-Internal-User-Email: ' . $email,
        'X-Internal-User-Name: ' . (string)($identity['name'] ?? $email),
    ]);
    $internalData = is_array($internal['data'] ?? null) ? $internal['data'] : [];
    $user = is_array($internalData['user'] ?? null) ? $internalData['user'] : [];
    if (!$internal['ok'] || !backendUserCanAccessInternal($user)) {
        backendJsonResponse(403, ['success' => false, 'error' => 'This account is not an internal staff account.']);
    }

    $role = strtolower(trim((string)($user['role'] ?? ($membership['role'] ?? 'user'))));
    $permissions = is_array($user['permissions'] ?? null) ? $user['permissions'] : [];

    session_regenerate_id(true);
    $_SESSION['user_email'] = $email;
    $_SESSION['user_name'] = (string)($user['name'] ?? $identity['name'] ?? $email);
    $_SESSION['user_role'] = $role ?: 'user';
    $_SESSION['user_team_id'] = (string)($user['team_id'] ?? 'default');
    $_SESSION['user_branch_id'] = (string)($user['branch_id'] ?? 'default');
    $_SESSION['user_is_admin'] = $role === 'admin' || !empty($user['is_admin']) || !empty($permissions['is_admin_legacy']);
    $_SESSION['platform_node_auth'] = true;

    backendJsonResponse(200, [
        'success' => true,
        'user_email' => $_SESSION['user_email'],
        'user_name' => $_SESSION['user_name'],
        'role' => $_SESSION['user_role'],
        'is_admin' => $_SESSION['user_is_admin'],
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'hydrate_node_session') {
    backendHydratePhpSessionFromNode();
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'impersonate_internal_user') {
    backendImpersonateInternalUser();
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'stop_internal_impersonation') {
    backendStopInternalImpersonation();
}

// If already logged in as any internal staff user, go straight to backend.
if (isset($_SESSION['user_email']) && backendFetchInternalUser((string)$_SESSION['user_email'], (string)$_SESSION['user_email'], (string)($_SESSION['user_name'] ?? ''))) {
    header("Location: portal.php");
    exit;
}

// Preserve redirect target back to this backend login after standard login/OTP.
// If someone came here with ?redirect=..., keep it, else default to portal.php.
$redirect = isset($_GET['redirect']) ? $_GET['redirect'] : 'portal.php';

$requestPath = strtolower((string)($_SERVER['REQUEST_URI'] ?? ''));
$platformLoginPath = strpos($requestPath, '/measure-dev/') !== false ? '/platform-dev/login.php' : '/platform/login.php';
$clientLoginUrl = $platformLoginPath . '?redirect=' . urlencode($redirect);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Mate - Staff Console</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">
    <style>
        body {
            font-family: 'Segoe UI', Roboto, sans-serif;
            background: #202124; /* Dark Background */
            display: flex; align-items: center; justify-content: center;
            height: 100vh; margin: 0;
        }
        .container {
            background: white; width: 380px;
            border-radius: 8px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.5);
            overflow: hidden;
        }
        .header {
            background: #37474f; /* Dark Slate */
            color: white; padding: 30px; text-align: center;
            border-bottom: 4px solid #263238;
        }
        .header img {
            display: block;
            margin: 0 auto 10px auto;
            max-width: 200px;
            height: auto;
        }
        .header h2 { margin: 5px 0 0; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; opacity: 0.8; font-weight: 600; }

        .form-area { padding: 40px 30px; }
        .form-group { margin-bottom: 20px; }
        .form-group label {
            display: block; font-size: 11px; font-weight: 700; color: #5f6368;
            margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;
        }
        input {
            width: 100%; padding: 12px; border: 2px solid #eee; border-radius: 4px;
            box-sizing: border-box; font-size: 14px; background: #f8f9fa; transition: 0.2s;
        }
        input:focus { border-color: #37474f; background: #fff; outline: none; }

        .btn {
            width: 100%; padding: 14px; background: #37474f; color: white; border: none;
            border-radius: 4px; font-weight: 700; cursor: pointer; margin-top: 10px;
            text-transform: uppercase; font-size: 13px; letter-spacing: 1px;
            transition: background 0.2s;
        }
        .btn:hover { background: #102027; }
        .btn:disabled { opacity: 0.7; cursor: not-allowed; }

        .error {
            background: #ffebee; color: #c62828;
            padding: 10px; border-radius: 4px; font-size: 13px;
            text-align: center; margin-top: 20px; display: none; border: 1px solid #ffcdd2;
        }
        .back-link {
            text-align: center; margin-top: 20px;
        }
        .back-link a { color: #999; font-size: 12px; text-decoration: none; }
        .back-link a:hover { color: #555; }
    </style>
</head>
<body>

<div class="container">
    <div class="header">
        <img src="/images/logo_white.png" alt="First Mate" height="50">
        <h2>Backend Access</h2>
    </div>

    <div class="form-area">
        <form id="loginForm" autocomplete="on">
            <div class="form-group">
                <label>Staff Email</label>
                <input type="email" name="email" required placeholder="admin@1m8.ai" autocomplete="username">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" name="password" required placeholder="••••••••" autocomplete="current-password">
            </div>
            <button type="submit" class="btn" id="btnSubmit">Authenticate</button>
            <div id="loginError" class="error"></div>
        </form>

        <div class="back-link">
            <a href="<?php echo htmlspecialchars($clientLoginUrl, ENT_QUOTES); ?>">
                <i class="fas fa-arrow-left"></i> Return to Client Login
            </a>
        </div>
    </div>
</div>

<script>
    // Where to send them after success (default portal.php). If this page has ?redirect=..., use it.
    const urlParams = new URLSearchParams(window.location.search);
    const redirectTarget = urlParams.get('redirect') || 'portal.php';
    const loginDiagPrefix = '[BackendLogin]';

    const clientLoginUrl = <?php echo json_encode($clientLoginUrl); ?>;

    function loginDiag(stage, details){
        try { console.log(loginDiagPrefix, stage, details || {}); } catch (_) {}
    }

    async function readJsonResponse(res, stage){
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        loginDiag(stage, {
            status: res.status,
            ok: res.ok,
            contentType: res.headers.get('content-type') || '',
            bytes: text.length,
            preview: text.slice(0, 180)
        });
        if (!data) {
            throw new Error(`${stage}: non_json_response_${res.status}`);
        }
        return data;
    }

    function platformApiBaseUrl(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.protocol}//${location.hostname}:3111/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
    }

    async function nodeLogin(formData){
        const url = `${platformApiBaseUrl()}/auth/legacy-action`;
        loginDiag('node_login:start', { url, email: String(formData.get('email') || '').toLowerCase(), redirectTarget });
        const res = await fetch(`${platformApiBaseUrl()}/auth/legacy-action`, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'login',
                email: String(formData.get('email') || ''),
                password: String(formData.get('password') || '')
            })
        });
        const data = await readJsonResponse(res, 'node_login:response');
        if (!res.ok || !data) throw new Error((data && (data.error || data.message)) || `Authentication failed (${res.status}).`);
        loginDiag('node_login:parsed', { success: Boolean(data.success), error: data.error || data.message || '', authenticated: Boolean(data.authenticated) });
        return data;
    }

    async function hydrateLegacySession(){
        const fd = new FormData();
        fd.append('action', 'hydrate_node_session');
        loginDiag('hydrate:start', { url: 'backend_login.php' });
        const res = await fetch('backend_login.php', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            body: fd
        });
        const data = await readJsonResponse(res, 'hydrate:response');
        if (!res.ok || !data || !data.success) {
            throw new Error((data && (data.error || data.message)) || `Could not open internal session (${res.status}).`);
        }
        loginDiag('hydrate:parsed', { success: Boolean(data.success), user_email: data.user_email || '', redirectTarget });
        return data;
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const btn = document.getElementById('btnSubmit');
        const err = document.getElementById('loginError');

        btn.disabled = true;
        btn.innerText = "Verifying...";
        err.style.display = 'none';
        err.innerText = '';

        const fd = new FormData(e.target);

        try {
            const data = await nodeLogin(fd);

            if (data && data.success) {
                await hydrateLegacySession();
                loginDiag('redirect', { redirectTarget });
                window.location.href = redirectTarget;
                return;
            }

            if (data && data.require_otp) {
                // Backend UI stays single-form; OTP handled on standard login.
                // Preserve any redirect so they come back here after verifying.
                window.location.href = clientLoginUrl;
                return;
            }

            err.innerText = (data && (data.error || data.message)) ? (data.error || data.message) : "Authentication failed.";
            err.style.display = 'block';
        } catch (ex) {
            err.innerText = ex && ex.message ? ex.message : 'Connection Error';
            err.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerText = "Authenticate";
        }
    });
</script>

</body>
</html>
