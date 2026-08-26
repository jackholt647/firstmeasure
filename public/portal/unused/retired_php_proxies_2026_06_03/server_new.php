<?php
/**
 * /app/server_new.php
 * Proxy that forwards requests to: /backend/training/measure/server_new.php
 *
 * Place this file next to /app/server_new.php so existing frontend calls like:
 *   fetch('server_new.php', { method:'POST', body: formData })
 * keep working after moving the frontend to /app.
 */

declare(strict_types=1);

// --- CONFIG ---
$BACKEND_PATH = '/backend/training/measure/server_new.php'; // web path on same domain
$TIMEOUT_SEC  = 120;

// --- BASIC HARDENING ---
header('X-Proxy: app-server-php');
header('X-Content-Type-Options: nosniff');

// Only allow GET/POST (matches your usage)
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!in_array($method, ['GET', 'POST'], true)) {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
    exit;
}

// Build absolute URL to backend on the same host
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
$backendUrl = $scheme . '://' . $host . $BACKEND_PATH;

// Preserve query string on GET
if ($method === 'GET' && !empty($_SERVER['QUERY_STRING'])) {
    $backendUrl .= '?' . $_SERVER['QUERY_STRING'];
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $backendUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true); // so we can pass through content-type/status
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_TIMEOUT, $TIMEOUT_SEC);

// Forward cookies so backend session works
$cookieHeader = $_SERVER['HTTP_COOKIE'] ?? '';
if ($cookieHeader !== '') {
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Cookie: ' . $cookieHeader,
        'Accept: */*',
    ]);
} else {
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Accept: */*',
    ]);
}

// Forward method + payload
if ($method === 'POST') {
    curl_setopt($ch, CURLOPT_POST, true);

    // If this is multipart/form-data (FormData with files), forward as multipart
    $contentType = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    $isMultipart = (stripos($contentType, 'multipart/form-data') !== false);

    if ($isMultipart) {
        $postFields = [];

        // Add normal POST fields
        foreach ($_POST as $k => $v) {
            $postFields[$k] = $v;
        }

        // Add uploaded files
        foreach ($_FILES as $fieldName => $fileInfo) {
            // handle both single and multi upload fields
            if (is_array($fileInfo['name'])) {
                // multiple files under same field
                $count = count($fileInfo['name']);
                for ($i = 0; $i < $count; $i++) {
                    if (($fileInfo['error'][$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) continue;
                    $tmp  = $fileInfo['tmp_name'][$i];
                    $name = $fileInfo['name'][$i] ?? ('upload_' . $i);
                    $type = $fileInfo['type'][$i] ?? 'application/octet-stream';
                    // Use fieldName[] semantics
                    $postFields[$fieldName . "[$i]"] = new CURLFile($tmp, $type, $name);
                }
            } else {
                if (($fileInfo['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) continue;
                $tmp  = $fileInfo['tmp_name'];
                $name = $fileInfo['name'] ?? 'upload';
                $type = $fileInfo['type'] ?? 'application/octet-stream';
                $postFields[$fieldName] = new CURLFile($tmp, $type, $name);
            }
        }

        curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
    } else {
        // Could be application/x-www-form-urlencoded OR JSON
        // If client sent JSON, forward raw body; else forward parsed $_POST
        $raw = file_get_contents('php://input');
        if ($raw !== false && strlen($raw) > 0 && stripos($contentType, 'application/json') !== false) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $raw);
            curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge(
                (array)curl_getinfo($ch, CURLINFO_HEADER_OUT),
                ['Content-Type: application/json', 'Accept: */*', ($cookieHeader ? 'Cookie: '.$cookieHeader : '')]
            ));
        } else {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $_POST);
        }
    }
}

// Execute
$resp = curl_exec($ch);
if ($resp === false) {
    $err = curl_error($ch);
    curl_close($ch);
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Proxy failed', 'detail' => $err]);
    exit;
}

$httpCode   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$rawHeaders = substr($resp, 0, $headerSize);
$body       = substr($resp, $headerSize);

// Pass through status code
http_response_code($httpCode);

// Pass through important headers (content-type, set-cookie)
// Avoid forwarding hop-by-hop headers
$lines = preg_split("/\r\n|\n|\r/", trim($rawHeaders));
foreach ($lines as $line) {
    if ($line === '' || stripos($line, 'HTTP/') === 0) continue;

    $parts = explode(':', $line, 2);
    if (count($parts) !== 2) continue;

    $hName = strtolower(trim($parts[0]));
    $hVal  = trim($parts[1]);

    // Skip hop-by-hop / unsafe headers
    if (in_array($hName, [
        'transfer-encoding',
        'content-length',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'upgrade',
    ], true)) {
        continue;
    }

    // Allow Set-Cookie for sessions
    if ($hName === 'set-cookie') {
        header('Set-Cookie: ' . $hVal, false);
        continue;
    }

    // Allow Content-Type so JSON stays JSON
    if ($hName === 'content-type') {
        header('Content-Type: ' . $hVal);
        continue;
    }
}

// Default content type if backend forgot it
if (!headers_sent()) {
    // If it looks like JSON, set JSON
    $trim = ltrim($body);
    if ($trim !== '' && ($trim[0] === '{' || $trim[0] === '[')) {
        header('Content-Type: application/json');
    }
}

// Output body
echo $body;
