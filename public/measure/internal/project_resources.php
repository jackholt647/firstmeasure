<?php
// Internal resource uploads use bounded chunks in the existing QA artifact store.
session_start();
require_once __DIR__ . '/_full_house.php';
require_once dirname(__DIR__, 2) . '/includes/provider_keys.php';
header('Cache-Control: private, no-store');
function resource_error($status, $message) {
    if (!headers_sent()) { http_response_code($status); header('Content-Type: application/json'); echo json_encode(['error'=>$message]); }
    exit;
}
if (empty($_SESSION['user_email'])) resource_error(401, 'Internal login required.');
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_SERVER['HTTP_X_RESOURCE_REQUEST'] ?? '') !== '1') resource_error(403, 'Invalid resource request.');
$resourceActor = ['email'=>(string)$_SESSION['user_email'], 'name'=>(string)($_SESSION['user_name'] ?? $_SESSION['user_email'])];
session_write_close();
$project = (string)($_GET['project'] ?? '');
$name = (string)($_GET['name'] ?? '');
if (!fm_is_full_house_id($project) || !fm_full_house_allowed()) resource_error(404, 'Not found.');
if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $project)) resource_error(400, 'Open a saved project first.');
if (strlen($name) > 100 || ($name !== '' && !preg_match('/^internal-(resource|markup)-[a-zA-Z0-9._-]+$/D', $name))) resource_error(400, 'Invalid resource name.');
$method = $_SERVER['REQUEST_METHOD'];
if (!in_array($method, ['GET','HEAD','POST'], true)) resource_error(405, 'Method not supported.');
$secret = fm_full_house_secret();
if (!$secret) resource_error(503, 'Internal resource storage is not configured.');
$artifactBase = rtrim(fm_api_base_url(), '/') . '/projects/' . rawurlencode($project) . '/artifacts';
const RESOURCE_CHUNK_BYTES = 8 * 1024 * 1024;
function resource_api($name = '', $body = null) {
    global $artifactBase, $secret;
    $headers = fm_full_house_headers();
    $upload = $body !== null;
    if ($upload) {
        $boundary = 'resources' . bin2hex(random_bytes(16));
        $headers[] = 'Content-Type: multipart/form-data; boundary=' . $boundary;
        $body = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$name\"\r\nContent-Type: application/octet-stream\r\n\r\n" . $body . "\r\n--$boundary--\r\n";
    }
    $ch = curl_init($artifactBase . (!$upload && $name !== '' ? '/' . rawurlencode($name) : ''));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_CUSTOMREQUEST=>$upload?'POST':'GET', CURLOPT_HTTPHEADER=>$headers, CURLOPT_TIMEOUT=>180]);
    if ($upload) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $result = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($result === false || !$status) resource_error(502, 'Resource storage is unavailable.');
    if ($status < 200 || $status >= 300) resource_error($status, 'Resource storage request failed (' . $status . ').');
    return $result;
}
function resource_part_name($id, $index) { return 'internal-markup-part-' . $id . '-' . str_pad((string)$index, 8, '0', STR_PAD_LEFT) . '.bin'; }
function resource_index($name, $raw) {
    if (!preg_match('/^internal-resource-v2-([0-9a-f-]{36})-/', $name, $match)) return null;
    $index = json_decode($raw, true);
    if (!is_array($index) || ($index['format'] ?? '') !== 'firstmeasure-resource-chunks-v1'
        || ($index['id'] ?? '') !== $match[1] || !is_int($index['size'] ?? null) || $index['size'] < 1
        || ($index['chunkSize'] ?? 0) !== RESOURCE_CHUNK_BYTES
        || ($index['parts'] ?? 0) !== (int)ceil($index['size'] / RESOURCE_CHUNK_BYTES)) resource_error(422, 'Invalid resource upload index.');
    if (isset($index['sha256'])) {
        if (!is_array($index['sha256']) || count($index['sha256']) !== $index['parts']) resource_error(422, 'Invalid resource checksums.');
        foreach ($index['sha256'] as $digest) if (!is_string($digest) || !preg_match('/^[a-f0-9]{64}$/D', $digest)) resource_error(422, 'Invalid resource checksum.');
    }
    return $index;
}
if ($method === 'POST') {
    if (!$name) resource_error(400, 'Resource name required.');
    // This bounds a single request, not the total file. The browser sends 8 MB chunks.
    $input = fopen('php://input', 'rb');
    $body = stream_get_contents($input, RESOURCE_CHUNK_BYTES + 1); fclose($input);
    if (strlen($body) > RESOURCE_CHUNK_BYTES) resource_error(413, 'Upload chunk is too large. Refresh the editor to use chunked uploads.');
    if ($body === '') resource_error(400, 'The uploaded file is empty.');
    $digest = (string)($_SERVER['HTTP_X_RESOURCE_SHA256'] ?? '');
    if ($digest !== '' && (!preg_match('/^[a-f0-9]{64}$/D', $digest) || !hash_equals($digest, hash('sha256', $body)))) resource_error(422, 'Upload checksum mismatch. Retry the file.');
    $index = resource_index($name, $body);
    if ($index) {
        // Publish only after every chunk is present with the expected size.
        $inventory = json_decode(resource_api(), true); $sizes = [];
        foreach ($inventory['files'] ?? [] as $file) $sizes[$file['name']] = (int)$file['size'];
        for ($part = 0; $part < $index['parts']; $part++) {
            $expected = min(RESOURCE_CHUNK_BYTES, $index['size'] - $part * RESOURCE_CHUNK_BYTES);
            if (($sizes[resource_part_name($index['id'], $part)] ?? -1) !== $expected) resource_error(409, 'Upload is incomplete. Retry the file.');
        }
    }
    if ($index) {
        $originalName = $index['original_name'] ?? preg_replace('/^internal-resource-v2-[0-9a-f-]{36}-/', '', $name);
        if (!is_string($originalName) || strlen($originalName) > 4096) resource_error(422, 'Invalid original filename.');
        $index['original_name'] = preg_replace('/[\x00-\x1f\x7f]/', ' ', $originalName);
        $index['project_id'] = $project;
        $index['uploaded_at'] = gmdate('c');
        $index['uploaded_by'] = $resourceActor;
        $body = json_encode($index);
    } elseif (preg_match('/^internal-markup-[0-9a-f-]{36}-.*\.json$/D', $name)) {
        $markup = json_decode($body, true);
        if (!is_array($markup)) resource_error(422, 'Invalid markup document.');
        $markup['savedAt'] = gmdate('c'); $markup['savedBy'] = $resourceActor; $markup['project_id'] = $project;
        $body = json_encode($markup);
    }
    $result = json_decode(resource_api($name, $body), true);
    if ($digest !== '') {
        // Verify the bytes read back from project storage before acknowledging this part.
        $storedDigest = hash('sha256', resource_api($name));
        if (!hash_equals($digest, $storedDigest)) resource_error(502, 'Stored upload checksum mismatch. Retry the file.');
        $result['sha256'] = $storedDigest;
    }
    if ($index && isset($result['artifact'])) $result['artifact']['size'] = $index['size'];
    header('Content-Type: application/json'); echo json_encode($result); exit;
}
if (!$name) {
    $data = json_decode(resource_api(), true); $files = [];
    foreach ($data['files'] ?? [] as $file) {
        if (!preg_match('/^internal-(resource|markup)-/', $file['name']) || strpos($file['name'], 'internal-markup-part-') === 0) continue;
        if (strpos($file['name'], 'internal-resource-v2-') === 0) {
            $index = resource_index($file['name'], resource_api($file['name'])); $file['size'] = $index['size'];
            foreach (['original_name', 'uploaded_at', 'uploaded_by'] as $field) if (isset($index[$field])) $file[$field] = $index[$field];
        }
        $files[] = $file;
    }
    header('Content-Type: application/json'); echo json_encode(['ok'=>true, 'files'=>$files]); exit;
}
$raw = resource_api($name);
$index = resource_index($name, $raw);
$size = $index ? $index['size'] : strlen($raw);
$start = 0; $end = $size - 1;
if (isset($_SERVER['HTTP_RANGE'])) {
    // Single ranges are sufficient for browser video seeking; ignore unsupported multi-ranges.
    if (preg_match('/^bytes=(\d*)-(\d*)$/D', trim($_SERVER['HTTP_RANGE']), $range) && ($range[1] !== '' || $range[2] !== '')) {
        if ($range[1] === '') $start = max(0, $size - (int)$range[2]);
        else { $start = (int)$range[1]; if ($range[2] !== '') $end = min($end, (int)$range[2]); }
        if ($start > $end || $start >= $size) { header('Content-Range: bytes */' . $size); resource_error(416, 'Requested range is outside the resource.'); }
        http_response_code(206); header("Content-Range: bytes $start-$end/$size");
    }
}
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: sandbox; default-src 'none'");
$ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
$types = ['jpg'=>'image/jpeg','jpeg'=>'image/jpeg','png'=>'image/png','gif'=>'image/gif','webp'=>'image/webp','avif'=>'image/avif','mp4'=>'video/mp4','webm'=>'video/webm','mov'=>'video/quicktime','mp3'=>'audio/mpeg','wav'=>'audio/wav','ogg'=>'audio/ogg','m4a'=>'audio/mp4','pdf'=>'application/pdf','json'=>'application/json'];
header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
header('Accept-Ranges: bytes'); header('Content-Length: ' . ($end - $start + 1));
if (!isset($types[$ext])) header('Content-Disposition: attachment; filename="' . $name . '"');
if ($method === 'HEAD') exit;
if (!$index) { echo substr($raw, $start, $end - $start + 1); exit; }
unset($raw);
set_time_limit(0);
// No whole-file assembly: at most one 8 MB part is held while serving a range.
while (ob_get_level()) ob_end_flush();
for ($part = intdiv($start, RESOURCE_CHUNK_BYTES); $part <= intdiv($end, RESOURCE_CHUNK_BYTES); $part++) {
    if (connection_aborted()) break;
    $bytes = resource_api(resource_part_name($index['id'], $part));
    if (isset($index['sha256'][$part]) && !hash_equals($index['sha256'][$part], hash('sha256', $bytes))) resource_error(502, 'Stored resource failed its integrity check.');
    $offset = $part * RESOURCE_CHUNK_BYTES;
    echo substr($bytes, max(0, $start - $offset), min(strlen($bytes) - max(0, $start - $offset), $end - max($start, $offset) + 1));
    unset($bytes); flush();
}
