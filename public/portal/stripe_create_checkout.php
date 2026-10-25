<?php
require_once __DIR__ . '/session_bootstrap.php';
portalStartSession();
header('Content-Type: application/json');

// Node's portal actions, from configuration only (never the request's Host).
function nodePlatformPortalActionUrl(): string {
    return fm_node_v1_url('platform/portal-action', 'api', 3101);
}

if (empty($_SESSION['user_email'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'Not authenticated']);
    exit;
}

$scheme = fm_request_is_https() ? 'https' : 'http';
$payload = [
    'action' => 'stripe_create_checkout',
    'actor_email' => $_SESSION['user_email'] ?? '',
    'actor_name' => $_SESSION['user_name'] ?? '',
    'actor_org_id' => $_SESSION['user_org_id'] ?? ($_SESSION['organization_id'] ?? ''),
    'qty' => $_POST['qty'] ?? 1,
    'offer_id' => $_POST['offer_id'] ?? '',
    'offer_token' => $_POST['offer_token'] ?? '',
    'acquisition_bonus_token' => $_POST['acquisition_bonus_token'] ?? ($_POST['offer_token'] ?? ''),
    'return_base_url' => $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? '') . '/portal',
];
session_write_close();

$url = nodePlatformPortalActionUrl();
if ($url === '') {
    http_response_code(503);
    echo json_encode(['success' => false, 'error' => 'Node Stripe bridge is not configured']);
    exit;
}
$body = json_encode($payload);
// Acts as the signed-in customer: Node reads their forwarded platform session.
$ch = curl_init($url);
curl_setopt_array($ch, fm_node_curl_options() + [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json'], fm_node_cookie_headers(true)),
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_TIMEOUT => 30,
]);
$resp = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

http_response_code($http >= 400 ? $http : 200);
if ($resp === false) error_log('Node Stripe bridge failed: ' . $err);
echo $resp !== false ? $resp : json_encode(['success' => false, 'error' => 'Node Stripe bridge failed']);
