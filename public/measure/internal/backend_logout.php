<?php
require_once __DIR__ . '/_storage.php';
session_start();
session_unset();
session_destroy();
$configuredCookie = trim((string)(getenv('PLATFORM_SESSION_COOKIE_NAME') ?: ($_SERVER['PLATFORM_SESSION_COOKIE_NAME'] ?? '')));
$platformCookie = preg_match('/^[A-Za-z0-9_-]{1,80}$/', $configuredCookie) ? $configuredCookie : 'fm_platform_session';
setcookie($platformCookie, '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
]);
setcookie($platformCookie . '_csrf', '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => false,
    'samesite' => 'Lax',
]);
header("Location: backend_login.php");
exit;
?>
