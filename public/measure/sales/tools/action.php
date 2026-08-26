<?php
session_start();
header('Content-Type: application/json');

if (!isset($_SESSION['user_email'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'Unauthorized']);
    exit;
}

function salesToolsNodeV1BaseUrl(): string {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

$raw = file_get_contents('php://input');
$payload = json_decode((string)$raw, true);
if (!is_array($payload)) {
    $payload = $_POST;
}

$payload['actor_email'] = $_SESSION['user_email'] ?? '';
$payload['actor_name'] = $_SESSION['user_name'] ?? '';
$payload['actor_role'] = $_SESSION['user_role'] ?? ($_SESSION['role'] ?? '');

if (!function_exists('curl_init')) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'PHP cURL is not available for the tools bridge.']);
    exit;
}

$ch = curl_init(rtrim(salesToolsNodeV1BaseUrl(), '/') . '/internal/legacy-action');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'],
    CURLOPT_POSTFIELDS => json_encode($payload),
    CURLOPT_TIMEOUT => 30,
]);
$response = curl_exec($ch);
$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

http_response_code($status > 0 ? $status : 502);
echo $response !== false && $response !== ''
    ? $response
    : json_encode(['success' => false, 'error' => 'Node tools bridge failed' . ($error ? ': ' . $error : '')]);
