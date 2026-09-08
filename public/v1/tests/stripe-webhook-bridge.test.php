<?php
// URL-only regression checks: never dispatch a webhook or contact Stripe.
$source = file_get_contents(__DIR__ . '/../../portal/stripe_webhook.php');
$start = strpos($source, 'function nodePlatformStripeWebhookUrl()');
$end = strpos($source, '$payload =', $start);
if ($start === false || $end === false) throw new RuntimeException('Bridge function not found');
eval(substr($source, $start, $end - $start));
$cases = [
    [['HTTP_HOST'=>'dev.1m8.ai', 'HTTPS'=>'on'], 'https://dev.1m8.ai/v1/platform/stripe-webhook-proxy'],
    [['HTTP_HOST'=>'dev.1m8.ai', 'HTTPS'=>'off', 'HTTP_X_FORWARDED_PROTO'=>'https'], 'https://dev.1m8.ai/v1/platform/stripe-webhook-proxy'],
    [['HTTP_HOST'=>'dev.1m8.ai', 'HTTP_X_FORWARDED_PROTO'=>'https, http'], 'https://dev.1m8.ai/v1/platform/stripe-webhook-proxy'],
    [['HTTP_HOST'=>'localhost:8021'], 'http://localhost:3111/v1/platform/stripe-webhook-proxy'],
    [['HTTP_HOST'=>'127.0.0.1:8021'], 'http://127.0.0.1:3111/v1/platform/stripe-webhook-proxy'],
];
foreach ($cases as [$server, $expected]) {
    $_SERVER = $server;
    if (nodePlatformStripeWebhookUrl() !== $expected) throw new RuntimeException('Bridge URL mismatch');
}
echo count($cases) . " Stripe bridge URL checks passed.\n";
