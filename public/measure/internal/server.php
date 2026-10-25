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

require_once dirname(__DIR__, 2) . '/includes/web_security.php';
require_once dirname(__DIR__, 2) . '/includes/node_api.php';

// Stripe calls this server to server and the billing pages are same-origin:
// no cross-origin access (it was "*" until 2026-10-24).
header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

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

// $auth: 'none' for Stripe's own signed webhook; 'cookie' to act as the
// signed-in browser user (Node reads their platform session).
function fm_forward_json_to_node(string $path, array $payload, int $timeout = 45, string $auth = 'none'): void {
    if (!function_exists('curl_init')) {
        fm_json_response(500, ['success' => false, 'error' => 'PHP cURL is not available for the Stripe compatibility bridge.']);
    }

    // Platform routes are served by the web nodes: the API base, from configuration only.
    $url = fm_node_v1_url($path, 'api', 3111);
    if ($url === '') {
        fm_json_response(503, ['success' => false, 'error' => 'The Stripe compatibility bridge is not configured.']);
    }
    $body = json_encode($payload);
    $headers = array_merge(['Content-Type: application/json', 'Accept: application/json'], fm_node_identity_headers($auth, 'POST', $url, $body));
    $ch = curl_init($url);
    curl_setopt_array($ch, fm_node_curl_options() + [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body,
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
    $scheme = fm_request_is_https() ? 'https' : 'http';
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

    // Who is acting comes from the session (and Node reads the forwarded
    // platform cookie), never from the request body.
    $requestedReturn = is_string($body['return_base_url'] ?? null) ? $body['return_base_url'] : '';
    unset($body['actor_email'], $body['actor_name'], $body['actor_org_id'], $body['actor'], $body['return_base_url']);
    // Stripe sends the customer back to this site only.
    $siteOrigin = fm_public_base_url('');
    $returnBase = strpos($requestedReturn, $siteOrigin . '/') === 0 ? $requestedReturn : fm_public_base_url('/portal');
    $payload = array_merge($body, [
        'action' => $action,
        'actor_email' => (string)($_SESSION['user_email'] ?? ''),
        'actor_name' => (string)($_SESSION['user_name'] ?? ''),
        'actor_org_id' => (string)($_SESSION['user_org_id'] ?? ($_SESSION['organization_id'] ?? '')),
        'return_base_url' => $returnBase,
    ]);

    fm_forward_json_to_node('platform/portal-action', $payload, 45, 'cookie');
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
]);
