<?php
require_once __DIR__ . '/_storage.php';
session_start();
session_unset();
session_destroy();
setcookie('fm_platform_session', '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
]);
setcookie('fm_platform_session_csrf', '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => false,
    'samesite' => 'Lax',
]);
header("Location: backend_login.php");
exit;
?>
