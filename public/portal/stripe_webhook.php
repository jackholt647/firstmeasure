<?php
header('Content-Type: application/json');
ignore_user_abort(true);
set_time_limit(60);

function nodePlatformStripeWebhookUrl(): string {
    $host = $_SERVER['HTTP_HOST'] ?? '127.0.0.1:8021';
    $hostOnly = explode(':', $host, 2)[0];
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost') {
        return 'http://' . $hostOnly . ':3111/v1/platform/stripe-webhook-proxy';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return $scheme . '://' . $host . '/v1/platform/stripe-webhook-proxy';
}

$payload = file_get_contents('php://input');
$signature = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';
if (!$payload || !$signature) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Missing payload/signature']);
    exit;
}

$ch = curl_init(nodePlatformStripeWebhookUrl());
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'],
    CURLOPT_POSTFIELDS => json_encode([
        'payload_base64' => base64_encode($payload),
        'signature' => $signature,
        'source' => 'platform_php_webhook_compat',
    ]),
    CURLOPT_TIMEOUT => 30,
]);
$resp = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

http_response_code($http ?: 500);
echo $resp !== false ? $resp : json_encode(['success' => false, 'error' => 'Node Stripe webhook bridge failed: ' . $err]);
