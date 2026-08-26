<?php
$host = $_SERVER['HTTP_HOST'] ?? '127.0.0.1:8021';
$hostOnly = preg_replace('/:\d+$/', '', $host) ?: '127.0.0.1';
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$target = $scheme . '://' . $hostOnly . ':3111/v1/internal/diagnostics';
$query = $_SERVER['QUERY_STRING'] ?? '';
if ($query !== '') {
    $target .= '?' . $query;
}
header('Location: ' . $target, true, 302);
exit;
