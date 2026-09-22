<?php
declare(strict_types=1);
require_once dirname(__DIR__, 2) . '/external-apps/registry.php';
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
$id = $_GET['app'] ?? '';
$relative = $_GET['file'] ?? '';
$packages = fm_external_packages();
$package = is_string($id) ? ($packages[$id] ?? null) : null;
$file = $package && is_string($relative) ? fm_external_file($package['frontend'], $relative) : null;
$content = $file === null ? false : @file_get_contents($file);
if ($content === false) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'External app asset unavailable.';
    exit;
}
$types = ['js' => 'text/javascript', 'css' => 'text/css', 'json' => 'application/json', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif', 'woff' => 'font/woff', 'woff2' => 'font/woff2'];
header('Content-Type: ' . $types[strtolower(pathinfo($file, PATHINFO_EXTENSION))]);
echo $content;
