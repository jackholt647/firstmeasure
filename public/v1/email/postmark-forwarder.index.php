<?php
/**
 * TEST-ONLY public Postmark inbox.
 *
 * Place on the public server as:
 *   /v1/email/inbound/postmark/index.php
 *
 * This is not the production inbound email path. It is only a hosted placeholder
 * that stores real Postmark payloads so a local dev machine can pull and replay
 * them into the local V1 Email API without ngrok/cloudflared.
 *
 * Required server env for download/ack:
 *   FIRSTMATE_POSTMARK_SPOOL_KEY=make-a-long-random-secret
 *
 * Pull queued emails:
 *   GET  /v1/email/inbound/postmark/index.php?action=download&key=...
 *
 * Ack successfully replayed emails:
 *   POST /v1/email/inbound/postmark/index.php
 *   {"action":"ack","key":"...","ids":["email_..."]}
 */

$SPOOL_KEY = getenv('FIRSTMATE_POSTMARK_SPOOL_KEY') ?: '';
$SPOOL_DIR = __DIR__ . '/.postmark_spool';
$MAX_DOWNLOAD = 100;

function fm_json_response(int $status, array $payload): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

function fm_read_json_body(): array {
    $raw = file_get_contents('php://input') ?: '';
    $json = json_decode($raw, true);
    return is_array($json) ? $json : [];
}

function fm_request_value(string $key): string {
    $body = fm_read_json_body();
    return (string)($_GET[$key] ?? $_POST[$key] ?? $body[$key] ?? '');
}

function fm_require_key(string $expected): void {
    $provided = fm_request_value('key');
    if ($expected === '') {
        fm_json_response(500, [
            'ok' => false,
            'error' => 'spool_key_not_configured',
            'message' => 'Set FIRSTMATE_POSTMARK_SPOOL_KEY on the public server before downloading queued emails.'
        ]);
    }
    if (!hash_equals($expected, $provided)) {
        fm_json_response(403, ['ok' => false, 'error' => 'invalid_key']);
    }
}

function fm_headers(): array {
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) return $headers;
    }
    $headers = [];
    foreach ($_SERVER as $key => $value) {
        if (strpos($key, 'HTTP_') !== 0) continue;
        $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($key, 5)))));
        $headers[$name] = $value;
    }
    if (isset($_SERVER['CONTENT_TYPE'])) $headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    return $headers;
}

function fm_ensure_spool(string $dir): void {
    if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
        fm_json_response(500, ['ok' => false, 'error' => 'spool_unavailable']);
    }
    $deny = $dir . '/.htaccess';
    if (!file_exists($deny)) {
        @file_put_contents($deny, "Deny from all\nRequire all denied\n");
    }
}

function fm_message_path(string $dir, string $id): string {
    $safe = preg_replace('/[^a-zA-Z0-9_-]/', '', $id);
    return $dir . '/' . $safe . '.json';
}

function fm_save_message(string $dir, string $rawBody, array $headers): array {
    fm_ensure_spool($dir);
    $decoded = json_decode($rawBody, true);
    $messageId = is_array($decoded) ? (string)($decoded['MessageID'] ?? $decoded['MessageId'] ?? '') : '';
    $id = 'email_' . gmdate('Ymd_His') . '_' . bin2hex(random_bytes(5));
    $record = [
        'id' => $id,
        'received_at' => gmdate('c'),
        'remote_addr' => $_SERVER['REMOTE_ADDR'] ?? '',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'POST',
        'content_type' => $headers['Content-Type'] ?? $headers['content-type'] ?? 'application/json',
        'headers' => $headers,
        'postmark_message_id' => $messageId,
        'body' => $rawBody,
        'json' => is_array($decoded) ? $decoded : null,
        'acked_at' => null
    ];
    $path = fm_message_path($dir, $id);
    file_put_contents($path, json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    return $record;
}

function fm_download_messages(string $dir, int $max): array {
    fm_ensure_spool($dir);
    $files = glob($dir . '/email_*.json') ?: [];
    sort($files, SORT_STRING);
    $messages = [];
    foreach ($files as $file) {
        if (count($messages) >= $max) break;
        $record = json_decode(file_get_contents($file) ?: '', true);
        if (!is_array($record) || !empty($record['acked_at'])) continue;
        $messages[] = $record;
    }
    return $messages;
}

function fm_ack_messages(string $dir, array $ids): array {
    fm_ensure_spool($dir);
    $acked = [];
    foreach ($ids as $id) {
        $id = (string)$id;
        $path = fm_message_path($dir, $id);
        if (!file_exists($path)) continue;
        $record = json_decode(file_get_contents($path) ?: '', true);
        if (!is_array($record)) continue;
        $record['acked_at'] = gmdate('c');
        file_put_contents($path, json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
        $acked[] = $id;
    }
    return $acked;
}

$action = strtolower(trim(fm_request_value('action')));

if ($action === 'download') {
    fm_require_key($SPOOL_KEY);
    fm_json_response(200, [
        'ok' => true,
        'messages' => fm_download_messages($SPOOL_DIR, $MAX_DOWNLOAD)
    ]);
}

if ($action === 'ack') {
    fm_require_key($SPOOL_KEY);
    $body = fm_read_json_body();
    $ids = $body['ids'] ?? $_POST['ids'] ?? [];
    if (is_string($ids)) $ids = array_filter(array_map('trim', explode(',', $ids)));
    if (!is_array($ids)) $ids = [];
    fm_json_response(200, [
        'ok' => true,
        'acked' => fm_ack_messages($SPOOL_DIR, $ids)
    ]);
}

$headers = fm_headers();
$rawBody = file_get_contents('php://input') ?: '';
$record = fm_save_message($SPOOL_DIR, $rawBody, $headers);

fm_json_response(202, [
    'ok' => true,
    'accepted' => true,
    'spooled' => true,
    'id' => $record['id'] ?? null
]);
