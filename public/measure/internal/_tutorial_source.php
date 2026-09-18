<?php
require_once __DIR__ . '/_full_house.php';

function fm_tutorial_bridge($body) {
    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    // The training API runs on compatibility, whose secret may differ from the
    // web-only full-house signing override. Prefer the existing shared PHP bridge key.
    $secret = getenv('STAFF_TRACKING_BRIDGE_SECRET') ?: (fm_provider_key_value('application', 'internal_api_secret') ?: getenv('FIRSTMEASURE_INTERNAL_API_SECRET'));
    if (!$email || !$secret) return ['status' => 403, 'body' => '', 'json' => null];
    $time = (string)time();
    $json = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $signature = hash_hmac('sha256', $email . "\n" . $time . "\n" . $json, $secret);
    $base = preg_replace('#/firstmeasure/?$#', '/internal', rtrim(fm_api_base_url(), '/'));
    $ch = curl_init($base . '/tutorial-exteriors');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => $json,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Tutorial-User: ' . $email, 'X-Tutorial-Time: ' . $time, 'X-Tutorial-Signature: ' . $signature],
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 120]);
    $raw = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    return ['status' => $status ?: 502, 'body' => $raw ?: '', 'json' => json_decode($raw ?: '', true)];
}

function fm_tutorial_source_request($tutorialId, $student, $course, $name = '') {
    return fm_tutorial_bridge(['operation' => 'source', 'tutorial_id' => $tutorialId, 'student_email' => $student, 'course_id' => $course, 'name' => $name]);
}

function fm_tutorial_fetch_source_bundle($tutorialId, $student, $course) {
    $found = fm_tutorial_find_project($tutorialId, $student, $course);
    if (!$found) return null;
    $source = $found['manifest']['source_project_id'] ?? '';
    // Preserve legacy roof sources and environments without the experimental feature.
    if (!fm_is_full_house_id($source) && ($found['manifest']['measurement_scope'] ?? '') !== 'full_house') return fm_fetch_project_bundle($source);
    $result = fm_tutorial_source_request($tutorialId, $student, $course);
    if ($result['status'] !== 200 || !is_array($result['json'])) return null;
    $bundle = $result['json']; $assets = []; $files = [];
    $bundle['manifest'] = fm_legacy_manifest($bundle['manifest'] ?? []);
    foreach ($bundle['files'] ?? [] as $file) {
        $name = $file['name'] ?? '';
        if (!preg_match('/^(google\.(png|jpg)|rgb\.tif|dsm\.tif|mask\.tif|insights\.json|internal-resource-[a-zA-Z0-9._-]+|internal-markup-part-[a-zA-Z0-9._-]+)$/D', $name)) continue;
        $url = 'tutorial_sources.php?' . http_build_query(['tutorial_id' => $tutorialId, 'student_email' => $student, 'course_id' => $course, 'name' => $name]);
        $assets[strtolower(pathinfo($name, PATHINFO_FILENAME))] = $url;
        $file['url'] = $url; $files[] = $file;
    }
    $bundle['assets'] = $assets; $bundle['files'] = $files;
    return $bundle;
}
