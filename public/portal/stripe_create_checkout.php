<?php
require_once __DIR__ . '/session_bootstrap.php';
portalStartSession();
header('Content-Type: application/json');

function nodePlatformPortalActionUrl(): string {
    $host = $_SERVER['HTTP_HOST'] ?? '127.0.0.1:8021';
    $hostOnly = explode(':', $host, 2)[0];
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost') {
        return 'http://' . $hostOnly . ':3111/v1/platform/portal-action';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return $scheme . '://' . $host . '/v1/platform/portal-action';
}

$payload = [
    'action' => 'stripe_create_checkout',
    'actor_email' => $_SESSION['user_email'] ?? '',
    'actor_name' => $_SESSION['user_name'] ?? '',
    'actor_org_id' => $_SESSION['user_org_id'] ?? ($_SESSION['organization_id'] ?? ''),
    'qty' => $_POST['qty'] ?? 1,
    'offer_id' => $_POST['offer_id'] ?? '',
    'offer_token' => $_POST['offer_token'] ?? '',
    'acquisition_bonus_token' => $_POST['acquisition_bonus_token'] ?? ($_POST['offer_token'] ?? ''),
    'return_base_url' => (($_SERVER['REQUEST_SCHEME'] ?? 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? '') . '/portal'),
];

$ch = curl_init(nodePlatformPortalActionUrl());
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'],
    CURLOPT_POSTFIELDS => json_encode($payload),
    CURLOPT_TIMEOUT => 30,
]);
$resp = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

http_response_code($http >= 400 ? $http : 200);
echo $resp !== false ? $resp : json_encode(['success' => false, 'error' => 'Node Stripe bridge failed: ' . $err]);
