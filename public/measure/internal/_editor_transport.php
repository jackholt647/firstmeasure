<?php
// Stream a trusted Node JSON response without building a PHP string/array copy.
// Authentication and blind-review selection are performed by editor.php first.
function fm_editor_stream_node_bundle($url, &$upstreamStatus = null) {
    if (!function_exists('curl_init')) return false;
    $started = false;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HTTPGET => true,
        CURLOPT_HTTPHEADER => array_merge(['Accept: application/json'], strpos($url, '/projects/fullhouse_') !== false && function_exists('fm_full_house_headers') ? fm_full_house_headers() : []),
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT => 45,
        CURLOPT_FAILONERROR => true,
        CURLOPT_WRITEFUNCTION => function ($handle, $chunk) use (&$started) {
            $status = (int)curl_getinfo($handle, CURLINFO_HTTP_CODE);
            if ($status < 200 || $status >= 300) return 0;
            if (!$started) {
                header('Content-Type: application/json; charset=utf-8');
                header('Cache-Control: no-store');
                http_response_code($status);
                $started = true;
            }
            echo $chunk;
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $upstreamStatus = $status;
    curl_close($ch);
    if ($ok === false || !$started) {
        error_log('editor streamed bundle failed: upstream status ' . $status);
        if (!$started) return false;
        // A partial response remains invalid JSON: do not append a success body.
    }
    return true;
}
