<?php
require_once __DIR__ . '/_storage.php';
// apple_key_ingest.php
// Public CORS endpoint to store Apple Maps accessKey.
// Accepts POST { url: "...?....&accessKey=XYZ" } OR POST { key: "XYZ" }.
// Either payload may optionally include { tile_version: 10401 }.
// Extracts key as LAST query param if using url.
// Writes to ./apple_key.json in same format as server.php.
// Logs to ./logs/apple_key_ingest.ndjson

ignore_user_abort(true);
set_time_limit(30);

// CORS: allow any traffic
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-FirstMeasure-Debug, X-FirstMeasure-Debug-Source');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

function appleKeyPath() {
  return storagePath('config/apple_key.json', true);
}

function appleKeyReadPath() {
  return storagePath('config/apple_key.json', true);
}

function appleKeyLogPath() {
  $logDir = storageDir('logs');
  if (!file_exists($logDir)) @mkdir($logDir, 0777, true);
  return $logDir . '/apple_key_ingest.ndjson';
}

function appendAppleKeyIngestLog($line) {
  if (!is_array($line)) $line = [];
  $line = array_merge([
    'ts_utc' => gmdate('c'),
    'event' => 'unknown',
    'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
    'ua' => $_SERVER['HTTP_USER_AGENT'] ?? null,
    'method' => $_SERVER['REQUEST_METHOD'] ?? null,
  ], $line);
  @file_put_contents(appleKeyLogPath(), json_encode($line, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND);
}

function ensureStore() {
  $path = appleKeyReadPath();
  if (!file_exists($path)) {
    $path = appleKeyPath();
    $init = ['key' => '', 'updated_at_utc' => null, 'tile_version' => 10401];
    @file_put_contents($path, json_encode($init, JSON_PRETTY_PRINT));
    return $init;
  }
  $raw = @file_get_contents($path);
  $data = json_decode($raw ?: '{}', true);
  if (!is_array($data)) $data = [];
  if (!array_key_exists('key', $data)) $data['key'] = '';
  if (!array_key_exists('updated_at_utc', $data)) $data['updated_at_utc'] = null;
  if (!array_key_exists('tile_version', $data)) $data['tile_version'] = 10401;
  return $data;
}

function normalizeAppleTileVersion($value) {
  return filter_var($value, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1, 'max_range' => 999999999]
  ]);
}

function setAppleKey($newKey, $newTileVersion = null) {
  $newKey = trim((string)$newKey);
  if ($newKey === '') return false;

  $existing = ensureStore();
  $tileVersion = $newTileVersion === null
    ? normalizeAppleTileVersion($existing['tile_version'] ?? 10401)
    : normalizeAppleTileVersion($newTileVersion);
  if ($tileVersion === false) return false;

  $nowUtc = gmdate('c');
  $data = [
    'key' => $newKey,
    'updated_at_utc' => $nowUtc,
    'tile_version' => $tileVersion
  ];
  $json = json_encode($data, JSON_PRETTY_PRINT);
  if ($json === false) return false;

  return (@file_put_contents(appleKeyPath(), $json) !== false);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $info = ensureStore();
  $key = isset($info['key']) && is_string($info['key']) ? trim($info['key']) : '';
  echo json_encode([
    'success' => true,
    'endpoint' => 'apple_endpoint.php',
    'has_key' => $key !== '',
    'key_preview' => $key !== '' ? substr($key, 0, 6) . '...' . substr($key, -4) : null,
    'updated_at_utc' => $info['updated_at_utc'] ?? null,
    'tile_version' => normalizeAppleTileVersion($info['tile_version'] ?? 10401) ?: 10401
  ]);
  exit;
}

// Pull POST body (supports JSON or form POST)
$ct = $_SERVER['CONTENT_TYPE'] ?? '';
$payload = [];
if (stripos($ct, 'application/json') !== false) {
  $raw = file_get_contents('php://input');
  $payload = json_decode($raw ?: '{}', true);
  if (!is_array($payload)) $payload = [];
} else {
  $payload = $_POST;
}

// Accept either key or url
$key = isset($payload['key']) ? $payload['key'] : null;
$url = isset($payload['url']) ? $payload['url'] : null;
$hasTileVersion = array_key_exists('tile_version', $payload);
$tileVersion = $hasTileVersion ? normalizeAppleTileVersion($payload['tile_version']) : null;
appendAppleKeyIngestLog([
  'event' => 'request_received',
  'content_type' => $ct,
  'payload_keys' => array_keys($payload),
  'has_key' => is_string($key) && trim($key) !== '',
  'has_url' => is_string($url) && trim($url) !== '',
  'has_tile_version' => $hasTileVersion,
]);

if ($hasTileVersion && $tileVersion === false) {
  appendAppleKeyIngestLog([
    'event' => 'rejected',
    'error' => 'Bad tile version',
  ]);
  http_response_code(400);
  echo json_encode(['success' => false, 'error' => 'tile_version must be a positive whole number']);
  exit;
}

// If url provided, extract LAST query param and require it be accessKey=...
if (($key === null || $key === '') && is_string($url) && $url !== '') {
  $q = parse_url($url, PHP_URL_QUERY);
  if (is_string($q) && $q !== '') {
    $parts = array_values(array_filter(explode('&', $q), fn($p) => $p !== ''));
    if (count($parts) > 0) {
      $last = $parts[count($parts) - 1];
      if (strpos($last, 'accessKey=') === 0) {
        $key = urldecode(substr($last, strlen('accessKey=')));
      }
    }
  }
}

// Sanity checks
if (!is_string($key)) {
  appendAppleKeyIngestLog([
    'event' => 'rejected',
    'error' => 'Missing key',
    'has_url' => is_string($url) && trim($url) !== '',
  ]);
  http_response_code(400);
  echo json_encode(['success' => false, 'error' => 'Missing key']);
  exit;
}
$key = trim($key);

// Basic: length + characters (allow URL-safe/base64-ish tokens)
if ($key === '' || strlen($key) < 8 || strlen($key) > 512) {
  appendAppleKeyIngestLog([
    'event' => 'rejected',
    'error' => 'Bad key length',
    'key_length' => strlen($key),
  ]);
  http_response_code(400);
  echo json_encode(['success' => false, 'error' => 'Bad key length']);
  exit;
}
// allow alnum + common token chars
if (!preg_match('/^[A-Za-z0-9\-\._~%+=:\/]+$/', $key)) {
  appendAppleKeyIngestLog([
    'event' => 'rejected',
    'error' => 'Bad key characters',
    'key_preview' => substr($key, 0, 6) . '...' . substr($key, -4),
  ]);
  http_response_code(400);
  echo json_encode(['success' => false, 'error' => 'Bad key characters']);
  exit;
}

// Store
ensureStore();
$ok = setAppleKey($key, $tileVersion);
if (!$ok) {
  appendAppleKeyIngestLog([
    'event' => 'write_failed',
    'key_preview' => substr($key, 0, 6) . '...' . substr($key, -4),
  ]);
  http_response_code(500);
  echo json_encode(['success' => false, 'error' => 'Write failed']);
  exit;
}

// Audit log (optional, lightweight)
$info = json_decode(@file_get_contents(appleKeyPath()) ?: '{}', true);
$activeTileVersion = normalizeAppleTileVersion($info['tile_version'] ?? 10401) ?: 10401;
appendAppleKeyIngestLog([
  'event' => 'stored',
  'key_preview' => substr($key, 0, 6) . '...' . substr($key, -4),
  'from_url' => (is_string($url) && $url !== ''),
  'tile_version' => $activeTileVersion,
  'tile_version_supplied' => $hasTileVersion
]);

echo json_encode([
  'success' => true,
  'updated_at_utc' => $info['updated_at_utc'] ?? null,
  'tile_version' => $activeTileVersion
]);
