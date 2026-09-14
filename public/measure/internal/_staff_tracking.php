<?php
// Only server-verified, successful tutorial submissions enter this bridge.
// A tracking failure must never undo or delay a submitted exam beyond 750ms.
function fm_staff_tracking_submission($result, $email, $project) {
    if (getenv('STAFF_TRACKING_ENABLED') !== '1' || empty($result['success'])) return;
    $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $secret = (string)getenv('STAFF_TRACKING_BRIDGE_SECRET');
    $url = (string)getenv('STAFF_TRACKING_BRIDGE_URL');
    // Fixed loopback service address only; never derive destinations from Host.
    if ($actor === '' || strlen($secret) < 32 || !preg_match('#^http://127\.0\.0\.1:[0-9]+/v1/private/staff-tracking$#D', $url) || !function_exists('curl_init')) return;
    $manifest = $result['manifest'] ?? [];
    if (($manifest['status'] ?? '') !== 'tutorial_completed') return;
    $attempt = (string)($manifest['test_attempt_id'] ?? $manifest['draft_reject_attempt_id'] ?? '');
    $exam = !empty($manifest['test_attempt_id']) || (($manifest['tutorial_kind'] ?? '') === 'draft_reject' && ($manifest['draft_reject_mode'] ?? '') === 'test');
    $payload = json_encode([
        'email' => strtolower(trim((string)$email)), 'actor' => $actor,
        'at' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z'),
        'peer' => (string)($_SERVER['REMOTE_ADDR'] ?? ''),
        'forwarded' => substr((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''), 0, 2048),
        'session_ref' => hash('sha256', session_id()),
        'ua' => substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 400),
        'impersonated' => !empty($_SESSION['is_impersonating']),
        'kind' => $exam ? 'exam_submit' : 'training_submit',
        'course' => substr((string)($result['course_id'] ?? ''), 0, 120),
        'attempt' => substr($attempt, 0, 120), 'project' => substr((string)$project, 0, 120)
    ], JSON_UNESCAPED_SLASHES);
    if ($payload === false) return;
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT_MS => 200, CURLOPT_TIMEOUT_MS => 750,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['payload' => $payload, 'signature' => hash_hmac('sha256', $payload, $secret)])]);
    curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status !== 200) error_log('Staff tracking submission receipt failed; submission remains saved.');
}
