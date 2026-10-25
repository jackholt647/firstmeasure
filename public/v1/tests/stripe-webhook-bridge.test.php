<?php
// URL-only regression checks: never dispatch a webhook or contact Stripe.
// The bridge URL comes from configuration only, never from the request's Host
// (docs/architecture/request-security.md#service-calls).
$source = file_get_contents(__DIR__ . '/../../portal/stripe_webhook.php');
$start = strpos($source, 'function nodePlatformStripeWebhookUrl()');
$end = strpos($source, '$payload =', $start);
if ($start === false || $end === false) throw new RuntimeException('Bridge function not found');
ini_set('log_errors', '0');
require_once __DIR__ . '/../../includes/node_api.php';
eval(substr($source, $start, $end - $start));
$cases = [
    // Configured: the configured base, whatever Host says.
    [['HTTP_HOST' => 'evil.example', 'FIRSTMEASURE_NODE_BASE_URL' => 'http://127.0.0.1:3101/v1/platform'], 'http://127.0.0.1:3101/v1/platform/stripe-webhook-proxy'],
    [['HTTP_HOST' => 'dev.1m8.ai', 'FIRSTMEASURE_API_BASE' => 'https://dev.1m8.ai/v1/firstmeasure', 'FIRSTMEASURE_NODE_BASE_URL' => 'http://127.0.0.1:3201/v1/platform'], 'https://dev.1m8.ai/v1/platform/stripe-webhook-proxy'],
    // Unconfigured on a public host: refuse (empty), never build one from Host.
    [['HTTP_HOST' => 'dev.1m8.ai', 'HTTPS' => 'on', 'REMOTE_ADDR' => '203.0.113.9'], ''],
    [['HTTP_HOST' => 'localhost:8021', 'REMOTE_ADDR' => '203.0.113.9'], ''],
    // A developer's own machine.
    [['HTTP_HOST' => '127.0.0.1:8021', 'REMOTE_ADDR' => '127.0.0.1'], 'http://127.0.0.1:3101/v1/platform/stripe-webhook-proxy'],
];
foreach (['FIRSTMEASURE_API_BASE', 'FIRSTMEASURE_NODE_BASE_URL'] as $name) putenv($name);
foreach ($cases as $index => [$server, $expected]) {
    $_SERVER = $server;
    $actual = nodePlatformStripeWebhookUrl();
    if ($actual !== $expected) throw new RuntimeException("Bridge URL mismatch in case $index: $actual");
}
echo count($cases) . " Stripe bridge URL checks passed.\n";
