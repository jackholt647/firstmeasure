<?php
require_once dirname(__DIR__) . '/includes/node_api.php';
header('Content-Type: application/json');
ignore_user_abort(true);
set_time_limit(60);

// Node's webhook bridge, from configuration only (never the request's Host).
// Stripe's signature, checked by Node, is the only proof this call carries.
function nodePlatformStripeWebhookUrl(): string {
    return fm_node_v1_url('platform/stripe-webhook-proxy', 'api', 3101);
}

$payload = file_get_contents('php://input');
$signature = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';
if (!$payload || !$signature) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Missing payload/signature']);
    exit;
}

$url = nodePlatformStripeWebhookUrl();
if ($url === '') {
    http_response_code(503);
    echo json_encode(['success' => false, 'error' => 'Stripe webhook bridge is not configured']);
    exit;
}

$ch = curl_init($url);
curl_setopt_array($ch, fm_node_curl_options() + [
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
if ($resp === false) error_log('Node Stripe webhook bridge failed: ' . $err);
echo $resp !== false ? $resp : json_encode(['success' => false, 'error' => 'Node Stripe webhook bridge failed']);
