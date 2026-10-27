<?php
// Same-origin health check for the login billboard. A cross-origin frame fires "load" on a 404 too,
// so login.php asks here before revealing it. Results are cached for five minutes per web host.
require __DIR__ . '/billboard_source.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$cacheFile = sys_get_temp_dir() . '/firstmate-login-billboard-status.json';
$cached = json_decode((string)@file_get_contents($cacheFile), true);
if (is_array($cached) && (int)($cached['checked_at'] ?? 0) > time() - 300) {
    echo json_encode(['ok' => !empty($cached['ok'])]);
    exit;
}

$status = 0;
if (function_exists('curl_init')) {
    $request = curl_init(LOGIN_BILLBOARD_URL);
    curl_setopt_array($request, [
        CURLOPT_NOBODY => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => 3,
        CURLOPT_RETURNTRANSFER => true,
    ]);
    curl_exec($request);
    $status = (int)curl_getinfo($request, CURLINFO_RESPONSE_CODE);
    curl_close($request);
} else {
    $context = stream_context_create(['http' => ['method' => 'HEAD', 'timeout' => 3, 'ignore_errors' => true]]);
    @file_get_contents(LOGIN_BILLBOARD_URL, false, $context);
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match)) $status = (int)$match[1];
    }
}

// No HTTP answer (timeout, DNS, TLS) is "unknown", not "missing": the page then trusts the frame itself.
if ($status === 0) {
    echo json_encode(['ok' => null]);
    exit;
}
$ok = $status >= 200 && $status < 300;
@file_put_contents($cacheFile, json_encode(['ok' => $ok, 'status' => $status, 'checked_at' => time()]), LOCK_EX);
echo json_encode(['ok' => $ok]);
