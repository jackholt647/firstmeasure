<?php
session_start();
if (empty($_SESSION['full_house_csrf'])) $_SESSION['full_house_csrf'] = bin2hex(random_bytes(32));
$csrf = $_SESSION['full_house_csrf'];
session_write_close();
require_once __DIR__ . '/_full_house.php';
header('Cache-Control: private, no-store');
if (!fm_full_house_allowed()) fm_full_house_not_found();

// A session-authenticated, streaming bridge keeps the large editor payloads
// within the existing PHP memory budget. The Node gate checks every operation.
if (isset($_GET['path'])) {
    $path = (string)$_GET['path'];
    if (!preg_match('#^/projects/fullhouse_[a-f0-9]{32}(?:[/?]|$)#D', $path)
        || preg_match('/[\r\n\\\\]/', $path) || strpos($path, '..') !== false) fm_full_house_not_found();
    $method = $_SERVER['REQUEST_METHOD'];
    if (!in_array($method, ['GET', 'HEAD', 'POST', 'PUT'], true)) fm_full_house_not_found();
    if (!in_array($method, ['GET', 'HEAD'], true) && !hash_equals($csrf, (string)($_SERVER['HTTP_X_FULL_HOUSE_CSRF'] ?? ''))) {
        http_response_code(403); exit('Invalid request');
    }
    set_time_limit(240);
    $headers = fm_full_house_headers();
    $headers[] = 'Accept: */*';
    if (isset($_SERVER['HTTP_RANGE'])) $headers[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
    $ch = curl_init(rtrim(fm_api_base_url(), '/') . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 240,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) {
            if (preg_match('#^HTTP/\S+ (\d+)#', $line, $match)) http_response_code((int)$match[1]);
            elseif (preg_match('/^(Content-Type|Content-Disposition|Content-Range|Accept-Ranges):/i', $line)) header(trim($line));
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) { echo $chunk; return strlen($chunk); }]);
    if ($method === 'HEAD') curl_setopt($ch, CURLOPT_NOBODY, true);
    if (in_array($method, ['POST', 'PUT'], true)) {
        if (!empty($_FILES)) {
            $body = $_POST;
            foreach ($_FILES as $key => $file) {
                if ($file['error'] !== UPLOAD_ERR_OK) { http_response_code(400); exit('Upload failed'); }
                $body[$key] = new CURLFile($file['tmp_name'], $file['type'], $file['name']);
            }
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        } else {
            $input = fopen('php://input', 'rb');
            $headers[] = 'Content-Type: ' . ($_SERVER['CONTENT_TYPE'] ?? 'application/json');
            curl_setopt_array($ch, [CURLOPT_HTTPHEADER => $headers, CURLOPT_UPLOAD => true,
                CURLOPT_CUSTOMREQUEST => $method, CURLOPT_INFILE => $input,
                CURLOPT_INFILESIZE => (int)($_SERVER['CONTENT_LENGTH'] ?? 0)]);
        }
    }
    $ok = curl_exec($ch);
    if ($ok === false) { error_log('Full-house upstream transport failed: ' . curl_errno($ch)); if (!headers_sent()) http_response_code(502); }
    curl_close($ch);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');
    if (!hash_equals($csrf, (string)($_SERVER['HTTP_X_FULL_HOUSE_CSRF'] ?? ''))) { http_response_code(403); exit('{"error":"Invalid request"}'); }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || !is_string($body['address'] ?? null) || trim($body['address']) === ''
        || !is_numeric($body['lat'] ?? null) || !is_numeric($body['lng'] ?? null)
        || !is_finite((float)$body['lat']) || !is_finite((float)$body['lng'])
        || abs((float)$body['lat']) > 90 || abs((float)$body['lng']) > 180) {
        http_response_code(400); exit('{"error":"Select a property address from the Google suggestions."}');
    }
    $body = ['address' => trim($body['address']), 'lat' => (float)$body['lat'], 'lng' => (float)$body['lng'], 'measurement_scope' => 'full_house'];
    set_time_limit(240);
    $result = fm_api_request('POST', 'internal-exteriors/projects', ['json' => $body, 'timeout' => 230]);
    http_response_code($result['status'] ?: 502); echo $result['body']; exit;
}
$result = fm_api_request('GET', 'internal-exteriors/projects');
$projects = $result['json']['projects'] ?? [];
$googleKey = fm_google_provider_key('browser_internal');
?>
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Full-house measurements · FirstMeasure</title>
<style>body{font:16px system-ui;background:#f4f6f8;color:#233443;margin:0}main{max-width:820px;margin:60px auto;padding:0 24px}h1{font-size:30px}form,article{background:white;border:1px solid #dbe2e8;border-radius:12px;padding:24px;margin:20px 0}input[type=text]{display:block;width:100%;box-sizing:border-box;padding:12px;margin:10px 0 20px;border:1px solid #a9b6c2;border-radius:6px;font:inherit}button{display:block;margin-top:20px;padding:12px 20px;background:#1e5269;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}a{color:#1e5269}li{margin:14px 0}small{color:#5a6a78}#status{white-space:pre-wrap}</style></head><body><main>
<a href="./">FirstMeasure</a><h1>Full-house measurements</h1><p>Internal measurement drafts for roof, walls and exterior resources.</p>
<form id="submit" data-csrf="<?=htmlspecialchars($csrf, ENT_QUOTES, 'UTF-8')?>"><label for="address">Property address</label><input id="address" type="text" required autocomplete="off" disabled aria-describedby="address-help" placeholder="Start typing a street address">
<small id="address-help">Choose a Google suggestion to use its address and map location.</small>
<div id="order-references"></div>
<button id="create" type="submit" disabled>Create measurement</button><p id="status" role="status">Loading address search…</p></form>
<article><h2>Measurements</h2><ul><?php foreach ($projects as $project): ?>
<li><a href="editor.php?folder=<?=rawurlencode($project['id'])?>"><?=htmlspecialchars($project['address'], ENT_QUOTES, 'UTF-8')?></a> <small><?=htmlspecialchars($project['status'], ENT_QUOTES, 'UTF-8')?></small></li>
<?php endforeach; ?></ul><?php if (!$projects): ?><p>No full-house measurements yet.</p><?php endif; ?></article>
</main>
<script src="portal_scripts/full_house_references.js?v=<?=filemtime(__DIR__ . '/portal_scripts/full_house_references.js')?>"></script>
<script src="portal_scripts/full_house_address.js?v=<?=filemtime(__DIR__ . '/portal_scripts/full_house_address.js')?>"></script>
<?php if ($googleKey !== ''): ?>
<script async src="https://maps.googleapis.com/maps/api/js?key=<?=rawurlencode($googleKey)?>&amp;libraries=places&amp;loading=async&amp;callback=initFullHouseAddress" onerror="fullHouseAddressUnavailable()"></script>
<?php else: ?>
<script>fullHouseAddressUnavailable();</script>
<?php endif; ?>
</body></html>
