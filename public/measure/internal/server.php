<?php
/**
 * Stripe compatibility endpoint.
 *
 * This file intentionally does not load the old internal PHP application.
 * It exists so existing Stripe webhook URLs can keep pointing at
 * /measure/internal/server.php while fulfillment, credits, and billing logic
 * run through the Node platform API.
 */

declare(strict_types=1);

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Stripe-Signature, X-FirstMeasure-Debug, X-FirstMeasure-Debug-Source');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

ignore_user_abort(true);
set_time_limit(90);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(200);
    echo json_encode(['success' => true]);
    exit;
}

function fm_json_response(int $status, array $payload): void {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

function fm_node_v1_base_url(): string {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function fm_request_json(): array {
    $raw = file_get_contents('php://input');
    if (is_string($raw) && trim($raw) !== '') {
        $json = json_decode($raw, true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($json)) {
            return $json;
        }
    }
    return [];
}

function fm_post_body(): array {
    $json = fm_request_json();
    if (!empty($json)) return $json;
    return $_POST;
}

function fm_forward_json_to_node(string $path, array $payload, int $timeout = 45): void {
    if (!function_exists('curl_init')) {
        fm_json_response(500, ['success' => false, 'error' => 'PHP cURL is not available for the Stripe compatibility bridge.']);
    }

    $url = rtrim(fm_node_v1_base_url(), '/') . '/' . ltrim($path, '/');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_TIMEOUT => $timeout,
    ]);
    $response = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    http_response_code($status > 0 ? $status : 502);
    if ($response !== false && $response !== '') {
        echo $response;
        exit;
    }
    echo json_encode(['success' => false, 'error' => 'Node Stripe bridge failed' . ($error ? ': ' . $error : '')]);
    exit;
}

function fm_stripe_webhook_bridge(): void {
    $payload = file_get_contents('php://input');
    $signature = (string)($_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '');
    if (!is_string($payload) || $payload === '' || $signature === '') {
        fm_json_response(400, ['success' => false, 'error' => 'Missing Stripe payload/signature']);
    }

    fm_forward_json_to_node('platform/stripe-webhook-proxy', [
        'payload_base64' => base64_encode($payload),
        'signature' => $signature,
        'source' => 'measure_internal_server_php_stripe_compat',
    ]);
}

function fm_public_base_url(string $fallbackPath): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $host . $fallbackPath;
}

function fm_stripe_action_bridge(string $action): void {
    $body = fm_post_body();
    $sessionStarted = false;
    $bootstrap = __DIR__ . '/../../portal/session_bootstrap.php';
    if (is_file($bootstrap)) {
        require_once $bootstrap;
        if (function_exists('portalStartSession')) {
            portalStartSession();
            $sessionStarted = true;
        }
    }
    if (!$sessionStarted && session_status() !== PHP_SESSION_ACTIVE) {
        @session_start();
    }

    $payload = array_merge($body, [
        'action' => $action,
        'actor_email' => $body['actor_email'] ?? ($_SESSION['user_email'] ?? ''),
        'actor_name' => $body['actor_name'] ?? ($_SESSION['user_name'] ?? ''),
        'actor_org_id' => $body['actor_org_id'] ?? ($_SESSION['user_org_id'] ?? ($_SESSION['organization_id'] ?? '')),
    ]);

    if (empty($payload['return_base_url'])) {
        $payload['return_base_url'] = fm_public_base_url('/portal');
    }

    fm_forward_json_to_node('platform/portal-action', $payload);
}

$method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');
$action = (string)($_POST['action'] ?? $_GET['action'] ?? '');
$isStripeWebhook = $method === 'POST'
    && (!empty($_SERVER['HTTP_STRIPE_SIGNATURE']) || (string)($_GET['stripe_webhook'] ?? '') === '1');

if ($isStripeWebhook) {
    fm_stripe_webhook_bridge();
}

$stripeActions = [
    'stripe_create_checkout' => true,
    'stripe_fulfill_session' => true,
    'billing_autotopup_setup_finish' => true,
    'billing_autotopup_setup_start' => true,
];

if ($action !== '' && isset($stripeActions[$action])) {
    fm_stripe_action_bridge($action);
}

fm_json_response(410, [
    'success' => false,
    'error' => 'This compatibility endpoint now supports Stripe callbacks and Stripe billing actions only.',
    'node_endpoint' => rtrim(fm_node_v1_base_url(), '/') . '/platform/stripe-webhook-proxy',
]);
