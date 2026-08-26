<?php
declare(strict_types=1);

$variants = [
    'measurements' => __DIR__ . '/variants/measurements/index.php',
    'customer-referral' => __DIR__ . '/variants/customer-referral/index.php',
    'referral' => __DIR__ . '/variants/customer-referral/index.php',
    'representative-referral' => __DIR__ . '/variants/representative-referral/index.php',
    'rep-referral' => __DIR__ . '/variants/representative-referral/index.php',
    'manufacturer-referral' => __DIR__ . '/variants/representative-referral/index.php',
    'meta-619a' => __DIR__ . '/variants/meta-619a/index.php',
    'smoke-metadata-20260615211729-page' => __DIR__ . '/variants/smoke-metadata-20260615211729-page/index.php',
    'sample' => __DIR__ . '/variants/sample/index.php',
    'email' => __DIR__ . '/variants/email/index.php',
    'instantly-signup' => __DIR__ . '/variants/instantly-signup/index.php',
    'main-site-page' => __DIR__ . '/variants/main-site-page/index.php',
];

$variant = strtolower(trim((string)($_GET['variant'] ?? 'measurements')));
$variant = preg_replace('/[^a-z0-9_-]/', '', $variant) ?: 'measurements';

if (!isset($variants[$variant])) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Landing page not found.';
    exit;
}

require $variants[$variant];
