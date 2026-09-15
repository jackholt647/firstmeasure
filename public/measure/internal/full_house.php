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
    set_time_limit(240);
    $result = fm_api_request('POST', 'internal-exteriors/projects', ['json' => $body, 'timeout' => 230]);
    http_response_code($result['status'] ?: 502); echo $result['body']; exit;
}
$result = fm_api_request('GET', 'internal-exteriors/projects');
$projects = $result['json']['projects'] ?? [];
?>
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Full-house measurements · FirstMeasure</title>
<style>body{font:16px system-ui;background:#f4f6f8;color:#233443;margin:0}main{max-width:820px;margin:60px auto;padding:0 24px}h1{font-size:30px}form,article{background:white;border:1px solid #dbe2e8;border-radius:12px;padding:24px;margin:20px 0}input[type=text]{display:block;width:100%;box-sizing:border-box;padding:12px;margin:10px 0 20px;border:1px solid #a9b6c2;border-radius:6px;font:inherit}button{display:block;margin-top:20px;padding:12px 20px;background:#1e5269;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}a{color:#1e5269}li{margin:14px 0}small{color:#5a6a78}#status{white-space:pre-wrap}</style></head><body><main>
<a href="./">FirstMeasure</a><h1>Full-house measurements</h1><p>Internal measurement drafts for roof, walls and exterior resources.</p>
<form id="submit"><label for="address">Property address</label><input id="address" type="text" required autocomplete="street-address" placeholder="Street address, city, state">
<label><input id="scope" type="checkbox" required> Full house measurements</label><br><small>Keep this draft in the internal workspace.</small>
<button id="create" type="submit">Create measurement</button><p id="status" role="status"></p></form>
<article><h2>Measurements</h2><ul><?php foreach ($projects as $project): ?>
<li><a href="editor.php?folder=<?=rawurlencode($project['id'])?>"><?=htmlspecialchars($project['address'], ENT_QUOTES, 'UTF-8')?></a> <small><?=htmlspecialchars($project['status'], ENT_QUOTES, 'UTF-8')?></small></li>
<?php endforeach; ?></ul><?php if (!$projects): ?><p>No full-house measurements yet.</p><?php endif; ?></article>
</main><script>
document.getElementById('submit').onsubmit=async event=>{event.preventDefault();const button=document.getElementById('create'),status=document.getElementById('status');button.disabled=true;status.textContent='Preparing imagery…';try{const response=await fetch('full_house.php',{method:'POST',headers:{'Content-Type':'application/json','X-Full-House-CSRF':<?=json_encode($csrf)?>},body:JSON.stringify({address:document.getElementById('address').value.trim(),measurement_scope:document.getElementById('scope').checked?'full_house':null})});const data=await response.json();if(!response.ok)throw Error(data.message||data.error||'Unable to create measurement');location.href='editor.php?folder='+encodeURIComponent(data.folder);}catch(error){status.textContent=error.message;button.disabled=false;}};
</script></body></html>
