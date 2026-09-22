<?php
// Local PHP preview only. Production and the normal local stack use NGINX.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/sites/')) { require dirname(__DIR__) . '/public/sites/index.php'; return true; }
// EventSource includes credentials; direct loopback CORS streaming avoids
// blocking PHP's single-threaded Windows development server.
if (str_starts_with($path, '/v1/') && str_ends_with($path, '/events/stream')) {
    header('Location: http://127.0.0.1:3101' . $_SERVER['REQUEST_URI'], true, 307);
    return true;
}
if (str_starts_with($path, '/v1/')) {
    foreach ($_FILES as $file) {
        if (in_array($file['error'] ?? UPLOAD_ERR_OK, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
            http_response_code(413);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'upload_too_large', 'message' => 'The local upload server rejected this file size. Start the preview with upload_max_filesize=8M and post_max_size=12M.']);
            return true;
        }
    }
    $body = file_get_contents('php://input');
    // PHP consumes form bodies before a router runs. Re-encode parsed fields
    // for the local Node proxy; NGINX forwards the original body in deployments.
    $parsedForm = !$body && !empty($_POST) && empty($_FILES);
    if ($parsedForm) $body = json_encode($_POST);
    $multipartType = null;
    if (!$body && !empty($_FILES)) {
        $boundary = 'local-preview-' . bin2hex(random_bytes(16));
        $quote = static fn($value) => str_replace(["\r", "\n", '"'], ['', '', '%22'], (string)$value);
        $body = '';
        foreach ($_POST as $name => $value) {
            if (!is_scalar($value)) continue;
            $body .= "--$boundary\r\nContent-Disposition: form-data; name=\"" . $quote($name) . "\"\r\n\r\n$value\r\n";
        }
        foreach ($_FILES as $name => $file) {
            if (!is_string($file['tmp_name'] ?? null) || ($file['error'] ?? 1) !== UPLOAD_ERR_OK) continue;
            $body .= "--$boundary\r\nContent-Disposition: form-data; name=\"" . $quote($name) . "\"; filename=\"" . $quote($file['name']) . "\"\r\nContent-Type: " . $quote($file['type'] ?: 'application/octet-stream') . "\r\n\r\n";
            $body .= file_get_contents($file['tmp_name']) . "\r\n";
        }
        $body .= "--$boundary--\r\n";
        $multipartType = "multipart/form-data; boundary=$boundary";
    }
    $headers = [];
    foreach (getallheaders() as $name => $value) {
        if (($parsedForm || $multipartType) && strtolower($name) === 'content-type') continue;
        if (!in_array(strtolower($name), ['host', 'connection', 'content-length'], true)) $headers[] = "$name: $value";
    }
    if ($parsedForm) $headers[] = 'Content-Type: application/json';
    if ($multipartType) $headers[] = 'Content-Type: ' . $multipartType;
    $context = stream_context_create(['http' => [
        'method' => $_SERVER['REQUEST_METHOD'], 'header' => implode("\r\n", $headers),
        'content' => $body, 'ignore_errors' => true, 'follow_location' => 0, 'timeout' => 60
    ]]);
    $body = @file_get_contents('http://127.0.0.1:3101' . $_SERVER['REQUEST_URI'], false, $context);
    foreach (($http_response_header ?? []) as $header) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', $header, $match)) http_response_code((int)$match[1]);
        elseif (!preg_match('/^(transfer-encoding|connection|content-length):/i', $header)) header($header, false);
    }
    if ($body === false) { http_response_code(502); echo '{"error":"local_api_unavailable"}'; }
    else echo $body;
    return true;
}
return false;
