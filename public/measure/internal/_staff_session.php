<?php
/**
 * The staff gate for /measure/internal
 * (docs/architecture/request-security.md#principals).
 *
 * A page here is for staff only. Being signed in to the shared PHP session is
 * not enough (a customer's portal login lands in the same session): the
 * session must carry the staff mark that is set only after Node verified the
 * platform session as staff. Every entry point starts its session with
 * fm_internal_session_start() and gates with fm_internal_require_staff().
 */

require_once dirname(__DIR__, 2) . '/includes/web_security.php';
require_once dirname(__DIR__, 2) . '/includes/node_api.php';

function fm_internal_session_start(): void
{
    fm_session_start_secure();
}

/**
 * Start the session (if needed) and require a Node-verified staff session.
 * $mode 'html' redirects to the staff sign-in; 'json' answers 401 JSON;
 * 'text' answers 401 text. Returns the staff email.
 */
function fm_internal_require_staff(string $mode = 'html'): string
{
    fm_internal_session_start();
    $email = fm_staff_session_resolve();
    if ($email !== '') return $email;
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    header('Cache-Control: private, no-store');
    if ($mode === 'json') {
        http_response_code(401);
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'error' => 'Unauthorized']);
        exit;
    }
    if ($mode === 'text') {
        http_response_code(401);
        header('Content-Type: text/plain; charset=utf-8');
        exit('Internal login required.');
    }
    $target = fm_safe_redirect_path((string)($_SERVER['REQUEST_URI'] ?? ''), '/measure/internal/');
    header('Location: backend_login.php?redirect=' . urlencode($target));
    exit;
}

/** A staff full admin (role admin / is_admin / is_admin_legacy), or 403. */
function fm_internal_require_staff_admin(string $mode = 'json'): string
{
    $email = fm_internal_require_staff($mode);
    if (!empty($_SESSION['user_is_admin'])) return $email;
    http_response_code(403);
    header('Cache-Control: private, no-store');
    if ($mode === 'json') {
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'error' => 'strict_admin_required']);
    } else {
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Administrator access is required.';
    }
    exit;
}
