<?php
require_once __DIR__ . '/firstmeasure_node.php';
require_once dirname(__DIR__, 2) . '/includes/provider_keys.php';

function fm_is_full_house_id($id) {
    return preg_match('/^fullhouse_[a-f0-9]{32}$/D', (string)$id) === 1;
}
function fm_full_house_headers() {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $secret = fm_provider_key_value('application', 'internal_api_secret') ?: getenv('FIRSTMEASURE_INTERNAL_API_SECRET');
    if ($email === '' || !$secret) return [];
    $time = (string)time();
    return ['X-FirstMeasure-Internal: ' . $secret, 'X-Full-House-User: ' . $email, 'X-Full-House-Time: ' . $time,
        'X-Full-House-Signature: ' . hash_hmac('sha256', $email . "\n" . $time, $secret)];
}
function fm_full_house_allowed() {
    if (empty($_SESSION['user_email'])) return false;
    $result = fm_api_request('GET', 'internal-exteriors/capability');
    return $result['status'] === 200 && !empty($result['json']['email']);
}
function fm_full_house_not_found() {
    http_response_code(404);
    header('Cache-Control: private, no-store');
    exit('Not found');
}
