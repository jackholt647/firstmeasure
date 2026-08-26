<?php
require_once __DIR__ . '/_storage.php';
header('Content-Type: application/json');

$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
$allowed = in_array($remoteAddr, ['127.0.0.1', '::1'], true);

if (!$allowed) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'localhost_only']);
    exit;
}

$extensions = get_loaded_extensions();
sort($extensions);

echo json_encode([
    'ok' => true,
    'remote_addr' => $remoteAddr,
    'php_version' => PHP_VERSION,
    'sapi' => PHP_SAPI,
    'curl_loaded' => extension_loaded('curl'),
    'sqlite3_loaded' => extension_loaded('sqlite3'),
    'pdo_sqlite_loaded' => extension_loaded('pdo_sqlite'),
    'session_save_path' => session_save_path(),
    'loaded_ini' => php_ini_loaded_file(),
    'extensions' => $extensions,
], JSON_PRETTY_PRINT);
