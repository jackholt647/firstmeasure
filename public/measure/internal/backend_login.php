<?php
require_once __DIR__ . '/_storage.php';
require_once __DIR__ . '/_staff_session.php';
/**
 * backend_login.php - Backend Login (Staff Console)
 * The browser signs in to the Node Platform API; this page then asks Node
 * whether that platform session is staff (GET /v1/internal/me with the
 * session cookie) and only then marks the PHP session as staff
 * (docs/architecture/request-security.md#principals).
 *
 * Impersonation is Node's mark on the admin's platform session
 * (POST/DELETE /v1/internal/impersonation); PHP mirrors it so the console
 * renders as the target and keeps the admin's email for "stop".
 */

fm_internal_session_start();

function backendJsonResponse(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($payload);
    exit;
}

function backendCleanEmail($value): string
{
    return strtolower(trim((string)$value));
}

function backendUserCanAccessInternal(array $user): bool
{
    return fm_staff_user_can_access_internal($user);
}

function backendUserIsStrictAdmin(array $user): bool
{
    return fm_staff_user_is_strict_admin($user);
}

function backendRequireConsoleCsrf(): void
{
    if (!fm_csrf_valid('staff_console', fm_csrf_presented())) {
        backendJsonResponse(403, ['success' => false, 'error' => 'invalid_csrf_token']);
    }
}

function backendNodeError(array $res, string $fallback): string
{
    $json = is_array($res['json'] ?? null) ? $res['json'] : [];
    $error = (string)($json['error'] ?? $json['message'] ?? '');
    return $error !== '' ? substr($error, 0, 200) : $fallback;
}

function backendImpersonateInternalUser(): void
{
    backendRequireConsoleCsrf();
    if (!empty($_SESSION['is_impersonating'])) {
        backendJsonResponse(409, ['success' => false, 'error' => 'already_impersonating']);
    }
    $adminEmail = fm_staff_session_resolve();
    if ($adminEmail === '') {
        backendJsonResponse(401, ['success' => false, 'error' => 'missing_admin_session']);
    }
    if (empty($_SESSION['user_is_admin'])) {
        backendJsonResponse(403, ['success' => false, 'error' => 'strict_admin_required']);
    }
    $adminName = (string)($_SESSION['user_name'] ?? $adminEmail);
    $adminRole = (string)($_SESSION['user_role'] ?? 'admin');
    $targetEmail = backendCleanEmail($_POST['email'] ?? $_POST['target_email'] ?? '');
    if ($targetEmail === '' || !filter_var($targetEmail, FILTER_VALIDATE_EMAIL)) {
        backendJsonResponse(400, ['success' => false, 'error' => 'missing_target_email']);
    }
    if ($targetEmail === $adminEmail) {
        backendJsonResponse(400, ['success' => false, 'error' => 'cannot_impersonate_self']);
    }

    // Node checks the admin, the target and records the start in its audit log.
    $start = fm_node_request('POST', fm_node_v1_url('internal/impersonation'), [
        'auth' => 'cookie', 'json' => ['target_email' => $targetEmail], 'timeout' => 10,
    ]);
    if (!$start['ok']) {
        $status = (int)$start['status'];
        $code = $status === 404 ? 404 : ($status === 403 ? 403 : ($status === 409 ? 409 : 502));
        backendJsonResponse($code, ['success' => false, 'error' => backendNodeError($start, $code === 502 ? 'impersonation_failed' : 'target_not_internal_user')]);
    }

    $verified = fm_staff_verify_with_node();
    if ($verified['state'] !== 'staff' || $verified['user']['email'] !== $targetEmail) {
        // Do not leave Node acting as someone the console cannot show.
        fm_node_request('DELETE', fm_node_v1_url('internal/impersonation'), ['auth' => 'cookie', 'timeout' => 10]);
        backendJsonResponse(502, ['success' => false, 'error' => 'impersonation_not_confirmed']);
    }

    fm_session_regenerate();
    fm_staff_apply_verified_user($verified['user']);
    $startJson = is_array($start['json'] ?? null) ? $start['json'] : [];
    $_SESSION['is_impersonating'] = true;
    $_SESSION['impersonating_from_email'] = $adminEmail;
    $_SESSION['impersonating_from_name'] = $adminName;
    $_SESSION['impersonating_from_role'] = $adminRole;
    $_SESSION['impersonating_started_at'] = date('c');
    $_SESSION['impersonation_expires_at'] = (string)($startJson['expires_at'] ?? '');

    backendJsonResponse(200, [
        'success' => true,
        'impersonating' => true,
        'admin_email' => $adminEmail,
        'target_email' => $_SESSION['user_email'],
        'target_name' => $_SESSION['user_name'],
        'target_role' => $_SESSION['user_role'],
        'expires_at' => $_SESSION['impersonation_expires_at'],
    ]);
}

function backendStopInternalImpersonation(): void
{
    backendRequireConsoleCsrf();
    $adminEmail = backendCleanEmail($_SESSION['impersonating_from_email'] ?? '');
    if (empty($_SESSION['is_impersonating']) || $adminEmail === '') {
        $node = fm_staff_node_impersonation();
        if (!$node) backendJsonResponse(409, ['success' => false, 'error' => 'not_impersonating']);
    }

    $stop = fm_node_request('DELETE', fm_node_v1_url('internal/impersonation'), ['auth' => 'cookie', 'timeout' => 10]);
    if (!$stop['ok']) {
        backendJsonResponse(502, ['success' => false, 'error' => backendNodeError($stop, 'admin_restore_failed')]);
    }

    $verified = fm_staff_verify_with_node();
    if ($verified['state'] !== 'staff') {
        fm_staff_clear_session();
        backendJsonResponse(403, ['success' => false, 'error' => 'admin_restore_failed']);
    }
    fm_session_regenerate();
    fm_staff_apply_impersonation(null, '');
    fm_staff_apply_verified_user($verified['user']);

    backendJsonResponse(200, [
        'success' => true,
        'impersonating' => false,
        'user_email' => $_SESSION['user_email'],
        'user_name' => $_SESSION['user_name'],
    ]);
}

function backendHydratePhpSessionFromNode(): void
{
    if (fm_platform_session_cookie() === '') {
        backendJsonResponse(401, ['success' => false, 'error' => 'missing_node_session']);
    }

    $result = fm_staff_refresh_from_node();
    if ($result['state'] === 'error') {
        backendJsonResponse(502, ['success' => false, 'error' => 'Could not verify staff access. Please try again or contact support.']);
    }
    if ($result['state'] !== 'staff') {
        if ((int)($result['status'] ?? 0) === 401) {
            backendJsonResponse(401, ['success' => false, 'error' => 'node_session_invalid']);
        }
        backendJsonResponse(403, ['success' => false, 'error' => 'This account is not an internal staff account.']);
    }

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

// Only same-site paths: ?redirect= is attacker-chosen.
$redirect = fm_safe_redirect_path($_GET['redirect'] ?? '', 'portal.php');

// Already a verified staff session (or a platform session Node confirms is
// staff): go straight to the console.
if (fm_staff_session_resolve() !== '') {
    header('Location: ' . $redirect);
    exit;
}

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
    // The server already reduced ?redirect= to a same-site path; check again here.
    function sameOriginPath(raw, fallback){
        try {
            const url = new URL(String(raw || ''), window.location.href);
            if (url.origin !== window.location.origin) return fallback;
            return url.pathname + url.search + url.hash;
        } catch (_) {
            return fallback;
        }
    }
    const redirectTarget = sameOriginPath(<?php echo json_encode($redirect); ?>, 'portal.php');
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
            return `${location.origin}/v1/platform`;
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
