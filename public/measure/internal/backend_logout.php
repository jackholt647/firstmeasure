<?php
require_once __DIR__ . '/_storage.php';
require_once __DIR__ . '/_staff_session.php';
fm_internal_session_start();
// An administrator acting as someone stops doing so when they sign out.
if (!empty($_SESSION['is_impersonating']) && fm_platform_session_cookie() !== '') {
    fm_node_request('DELETE', fm_node_v1_url('internal/impersonation'), ['auth' => 'cookie', 'timeout' => 5]);
}
session_unset();
session_destroy();
$platformCookie = fm_platform_session_cookie_name();
$secure = fm_request_is_https();
setcookie(session_name(), '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => $secure,
    'httponly' => true,
    'samesite' => 'Lax',
]);
setcookie($platformCookie, '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => $secure,
    'httponly' => true,
    'samesite' => 'Lax',
]);
setcookie($platformCookie . '_csrf', '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => $secure,
    'httponly' => false,
    'samesite' => 'Lax',
]);
header("Location: backend_login.php");
exit;
