<?php
require_once __DIR__ . '/_storage.php';

if (defined('FIRSTMEASURE_PROJECT_PROCESSING_LOADED')) {
    return;
}
define('FIRSTMEASURE_PROJECT_PROCESSING_LOADED', true);

function fm_proc_temp_root() {
    $base = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'firstmeasure-processing';
    if (!is_dir($base)) @mkdir($base, 0777, true);
    return $base;
}

function fm_proc_temp_dir($projectId) {
    $dir = fm_proc_temp_root() . DIRECTORY_SEPARATOR . preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$projectId);
    if (is_dir($dir)) fm_proc_rrmdir($dir);
    @mkdir($dir, 0777, true);
    return rtrim($dir, '/\\') . DIRECTORY_SEPARATOR;
}

function fm_proc_rrmdir($dir) {
    if (!is_dir($dir)) return;
    $items = @scandir($dir);
    if (!is_array($items)) return;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = rtrim($dir, '/\\') . DIRECTORY_SEPARATOR . $item;
        if (is_dir($path)) fm_proc_rrmdir($path);
        else @unlink($path);
    }
    @rmdir($dir);
}

function fm_proc_write_json($path, $data) {
    @file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function fm_proc_read_json($path) {
    if (!file_exists($path)) return [];
    $decoded = json_decode((string)@file_get_contents($path), true);
    return is_array($decoded) ? $decoded : [];
}

function fm_proc_compute_complexity_rating($segmentCount) {
    $segmentCount = (int)$segmentCount;
    if ($segmentCount <= 0) return 3;
    if ($segmentCount <= 5) return 1;
    if ($segmentCount <= 10) return 2;
    if ($segmentCount <= 20) return 3;
    if ($segmentCount <= 35) return 4;
    return 5;
}

function fm_proc_http_request($method, $url, $headers = [], $body = null) {
    $method = strtoupper(trim((string)$method));
    if (function_exists('curl_init')) {
        $respHeaders = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 90,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_FAILONERROR => false,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => function ($curl, $header) use (&$respHeaders) {
                $len = strlen($header);
                $parts = explode(':', $header, 2);
                if (count($parts) === 2) {
                    $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return $len;
            },
        ]);
        if ($body !== null && $method !== 'GET') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $resp = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        return [
            'ok' => ($error === '' && $status >= 200 && $status < 300),
            'status' => $status,
            'error' => $error !== '' ? $error : null,
            'headers' => $respHeaders,
            'body' => $resp === false ? '' : $resp,
        ];
    }

    $context = stream_context_create([
        'http' => [
            'method' => $method,
            'timeout' => 90,
            'ignore_errors' => true,
            'header' => implode("\r\n", $headers),
            'content' => ($method !== 'GET' && $body !== null) ? $body : ''
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false
        ]
    ]);
    $resp = @file_get_contents($url, false, $context);
    $status = 0;
    $respHeaders = [];
    foreach (($http_response_header ?? []) as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
            $status = (int)$m[1];
            continue;
        }
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) {
            $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
    }
    return [
        'ok' => ($status >= 200 && $status < 300),
        'status' => $status,
        'error' => $resp === false ? 'stream_request_failed' : null,
        'headers' => $respHeaders,
        'body' => $resp === false ? '' : $resp,
    ];
}

function fm_proc_fetch_url($url) {
    $res = fm_proc_http_request('GET', $url);
    return $res['ok'] ? $res['body'] : false;
}

function fm_proc_normalize_solar_tiff_url($url) {
    $parts = parse_url((string)$url);
    if (!$parts || empty($parts['query'])) return $url;
    parse_str($parts['query'], $q);
    $q['alt'] = 'media';
    $query = http_build_query($q, '', '&', PHP_QUERY_RFC3986);
    return ($parts['scheme'] ?? 'https') . '://' . ($parts['host'] ?? '') . ($parts['path'] ?? '') . '?' . $query;
}

function fm_proc_download_file($url, $destPath) {
    $res = fm_proc_http_request('GET', $url);
    if (!$res['ok']) {
        error_log("fm_proc_download_file failed status=" . ($res['status'] ?? 0) . " url=$url");
        return false;
    }
    return @file_put_contents($destPath, $res['body']) !== false;
}

function fm_proc_download_solar_tiff($url, $destPath) {
    $res = fm_proc_http_request('GET', fm_proc_normalize_solar_tiff_url($url), [
        'Accept: image/tiff,application/octet-stream,*/*'
    ]);
    if (!$res['ok']) {
        error_log("fm_proc_download_solar_tiff failed status=" . ($res['status'] ?? 0) . " url=$url");
        return false;
    }
    $body = (string)($res['body'] ?? '');
    $head = substr($body, 0, 4);
    $isTiff = ($head === "II*\0" || $head === "MM\0*");
    if (!$isTiff) {
        error_log("fm_proc_download_solar_tiff received non-TIFF response for $url");
        return false;
    }
    return @file_put_contents($destPath, $body) !== false;
}

function fm_proc_fetch_google_tiles_stitched($lat, $lng, $apiKey, $destPath, $zoom = 21, $radiusMeters = 65, $outputSize = 800) {
    if (!function_exists('imagecreatetruecolor')) return false;

    $sessionResp = fm_proc_http_request(
        'POST',
        'https://tile.googleapis.com/v1/createSession?key=' . urlencode($apiKey),
        ['Content-Type: application/json'],
        json_encode([
            'mapType' => 'satellite',
            'language' => 'en-US',
            'region' => 'US',
            'imageFormat' => 'jpeg',
            'highDpi' => false,
        ])
    );
    if (!$sessionResp['ok']) return false;
    $sessionData = json_decode((string)$sessionResp['body'], true);
    $sessionToken = is_array($sessionData) ? (string)($sessionData['session'] ?? '') : '';
    if ($sessionToken === '') return false;

    $tileSize = 256;
    $n = pow(2, $zoom);
    $xFrac = ($lng + 180.0) / 360.0 * $n;
    $latRad = deg2rad($lat);
    $yFrac = (1.0 - log(tan($latRad) + 1.0 / cos($latRad)) / M_PI) / 2.0 * $n;
    $mpp = 156543.03392 * cos($latRad) / $n;
    $diameterPx = ($radiusMeters * 2) / $mpp;
    $tilesNeeded = (int)(ceil($diameterPx / $tileSize)) + 2;
    if ($tilesNeeded % 2 === 0) $tilesNeeded++;
    $tilesNeeded = max(3, min(15, $tilesNeeded));

    $centerTileX = (int)floor($xFrac);
    $centerTileY = (int)floor($yFrac);
    $half = (int)floor($tilesNeeded / 2);

    $canvasW = $tilesNeeded * $tileSize;
    $canvasH = $tilesNeeded * $tileSize;
    $canvas = @imagecreatetruecolor($canvasW, $canvasH);
    if (!$canvas) return false;
    $bg = imagecolorallocate($canvas, 30, 30, 30);
    imagefill($canvas, 0, 0, $bg);

    $fetched = 0;
    for ($dy = 0; $dy < $tilesNeeded; $dy++) {
        for ($dx = 0; $dx < $tilesNeeded; $dx++) {
            $tx = $centerTileX - $half + $dx;
            $ty = $centerTileY - $half + $dy;
            $tx = (($tx % (int)$n) + (int)$n) % (int)$n;
            $tileUrl = "https://tile.googleapis.com/v1/2dtiles/{$zoom}/{$tx}/{$ty}?session=" . urlencode($sessionToken) . "&key=" . urlencode($apiKey);
            $tileData = fm_proc_fetch_url($tileUrl);
            if (!$tileData) continue;
            $tileImg = @imagecreatefromstring($tileData);
            if (!$tileImg) continue;
            imagecopy($canvas, $tileImg, $dx * $tileSize, $dy * $tileSize, 0, 0, imagesx($tileImg), imagesy($tileImg));
            imagedestroy($tileImg);
            $fetched++;
        }
    }
    if ($fetched === 0) {
        imagedestroy($canvas);
        return false;
    }

    $centerPxX = $half * $tileSize + ($xFrac - $centerTileX) * $tileSize;
    $centerPxY = $half * $tileSize + ($yFrac - $centerTileY) * $tileSize;
    $cropSize = (int)round($diameterPx);
    $cropSize = min($cropSize, $canvasW, $canvasH);
    $cropX = (int)max(0, min(round($centerPxX - $cropSize / 2), $canvasW - $cropSize));
    $cropY = (int)max(0, min(round($centerPxY - $cropSize / 2), $canvasH - $cropSize));
    $cropped = imagecreatetruecolor($cropSize, $cropSize);
    imagecopy($cropped, $canvas, 0, 0, $cropX, $cropY, $cropSize, $cropSize);
    imagedestroy($canvas);

    $outputSize = max(400, min(2400, (int)$outputSize));
    $output = imagecreatetruecolor($outputSize, $outputSize);
    imagecopyresampled($output, $cropped, 0, 0, 0, 0, $outputSize, $outputSize, $cropSize, $cropSize);
    imagedestroy($cropped);
    $ok = imagepng($output, $destPath, 6);
    imagedestroy($output);
    return $ok;
}

function fm_proc_process_into_dir($targetDir, $address, $googleKey, $geminiKey, $inputLat = null, $inputLng = null, $inputRadius = null) {
    $lat = $inputLat;
    $lng = $inputLng;
    $formattedAddress = $address;

    if (!$lat || !$lng) {
        $geoJson = fm_proc_fetch_url("https://maps.googleapis.com/maps/api/geocode/json?address=" . urlencode($address) . "&key=" . $googleKey);
        $geoData = json_decode((string)$geoJson, true);
        if (!$geoData || empty($geoData['results'][0]['geometry']['location'])) {
            return ['ok' => false, 'error' => 'geocode_failed'];
        }
        $location = $geoData['results'][0]['geometry']['location'];
        $lat = $location['lat'];
        $lng = $location['lng'];
        $formattedAddress = (string)($geoData['results'][0]['formatted_address'] ?? $address);
    }

    $insightsJson = fm_proc_fetch_url("https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=$lat&location.longitude=$lng&requiredQuality=LOW&key=$googleKey");
    $complexity = 3;
    if ($insightsJson) {
        @file_put_contents($targetDir . 'insights.json', $insightsJson);
        $insightsData = json_decode((string)$insightsJson, true);
        $segments = is_array($insightsData) ? ($insightsData['solarPotential']['roofSegmentStats'] ?? null) : null;
        if (is_array($segments)) {
            $complexity = fm_proc_compute_complexity_rating(count($segments));
        }
    }

    $radius = ($inputRadius !== null && (int)$inputRadius > 0) ? (int)$inputRadius : 60;
    $pixelSize = ($radius > 100) ? 0.5 : 0.1;
    $radius = min($radius, (int)($pixelSize * 1000));

    $layersJson = fm_proc_fetch_url(
        "https://solar.googleapis.com/v1/dataLayers:get"
        . "?location.latitude=$lat&location.longitude=$lng"
        . "&radius_meters=$radius"
        . "&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS"
        . "&requiredQuality=LOW"
        . "&pixelSizeMeters=$pixelSize"
        . "&key=$googleKey"
    );
    if ($layersJson) {
        $layersData = json_decode((string)$layersJson, true);
        if (!empty($layersData['rgbUrl'])) fm_proc_download_solar_tiff($layersData['rgbUrl'] . "&key=$googleKey", $targetDir . 'rgb.tif');
        if (!empty($layersData['dsmUrl'])) fm_proc_download_solar_tiff($layersData['dsmUrl'] . "&key=$googleKey", $targetDir . 'dsm.tif');
        if (!empty($layersData['maskUrl'])) fm_proc_download_solar_tiff($layersData['maskUrl'] . "&key=$googleKey", $targetDir . 'mask.tif');
    }

    $tileRadius = max(65, $radius);
    $stitched = fm_proc_fetch_google_tiles_stitched($lat, $lng, $googleKey, $targetDir . 'google.png', 21, $tileRadius, 800);
    if (!$stitched) {
        fm_proc_download_file(
            "https://maps.googleapis.com/maps/api/staticmap?center=$lat,$lng&zoom=20&size=640x640&scale=2&maptype=satellite&key=$googleKey",
            $targetDir . 'google.png'
        );
    }

    $azureKey = '';
    fm_proc_download_file(
        "https://atlas.microsoft.com/map/static?subscription-key=" . urlencode($azureKey)
        . "&api-version=2024-04-01&tilesetId=microsoft.imagery&zoom=19&center=" . urlencode($lng . "," . $lat)
        . "&width=800&height=800&language=en-US",
        $targetDir . 'azure.png'
    );

    return [
        'ok' => true,
        'lat' => $lat,
        'lng' => $lng,
        'address' => $formattedAddress,
        'complexity' => $complexity,
        'radius_meters' => $radius,
        'processed_at' => date('Y-m-d H:i:s'),
        'files' => [
            'insights.json',
            'rgb.tif',
            'dsm.tif',
            'mask.tif',
            'google.png',
            'azure.png'
        ]
    ];
}

function fm_process_project_assets($projectId, $address, $googleKey, $geminiKey, $inputLat = null, $inputLng = null, $inputRadius = null) {
    $projectId = trim((string)$projectId);
    if ($projectId === '') return false;

    $targetDir = fm_proc_temp_dir($projectId);
    $current = fm_fetch_project_manifest($projectId);
    if (!is_array($current)) $current = [];

    fm_proc_write_json($targetDir . 'manifest.json', array_merge($current, [
        'id' => $projectId,
        'address' => $address,
        'lat' => $inputLat,
        'lng' => $inputLng,
        'radius_meters' => $inputRadius,
    ]));

    $result = fm_proc_process_into_dir($targetDir, $address, $googleKey, $geminiKey, $inputLat, $inputLng, $inputRadius);
    if (empty($result['ok'])) {
        fm_proc_rrmdir(rtrim($targetDir, '/\\'));
        return false;
    }

    $mimeMap = [
        'insights.json' => 'application/json',
        'rgb.tif' => 'image/tiff',
        'dsm.tif' => 'image/tiff',
        'mask.tif' => 'image/tiff',
        'google.png' => 'image/png',
        'azure.png' => 'image/png',
    ];
    foreach ($result['files'] as $fileName) {
        $filePath = $targetDir . $fileName;
        if (!file_exists($filePath)) continue;
        fm_project_upload_file($projectId, $filePath, $fileName, $mimeMap[$fileName] ?? 'application/octet-stream');
    }

    fm_project_patch($projectId, [
        'address' => $result['address'],
        'lat' => $result['lat'],
        'lng' => $result['lng'],
        'complexity' => $result['complexity'],
        'radius_meters' => $result['radius_meters'],
        'status' => 'ready',
        'timestamps' => [
            'processed_at' => $result['processed_at']
        ]
    ]);

    fm_proc_rrmdir(rtrim($targetDir, '/\\'));
    return true;
}

function fm_generate_project_mask_artifact($projectId, $googleKey) {
    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) return false;
    $lat = $manifest['lat'] ?? null;
    $lng = $manifest['lng'] ?? null;
    if (!$lat || !$lng) return false;
    $radius = is_numeric($manifest['radius_meters'] ?? null) ? (float)$manifest['radius_meters'] : 20.0;
    $layersJson = fm_proc_fetch_url(
        "https://solar.googleapis.com/v1/dataLayers:get"
        . "?location.latitude=$lat&location.longitude=$lng"
        . "&radius_meters=$radius"
        . "&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS"
        . "&requiredQuality=LOW"
        . "&key=$googleKey"
    );
    if (!$layersJson) return false;
    $layersData = json_decode((string)$layersJson, true);
    $maskUrl = is_array($layersData) ? ($layersData['maskUrl'] ?? '') : '';
    if ($maskUrl === '') return false;

    $targetDir = fm_proc_temp_dir($projectId . '-mask');
    $maskPath = $targetDir . 'mask.tif';
    $ok = fm_proc_download_solar_tiff($maskUrl . "&key=$googleKey", $maskPath);
    if ($ok && file_exists($maskPath)) {
        $ok = fm_project_upload_file($projectId, $maskPath, 'mask.tif', 'image/tiff');
    }
    fm_proc_rrmdir(rtrim($targetDir, '/\\'));
    return $ok;
}
