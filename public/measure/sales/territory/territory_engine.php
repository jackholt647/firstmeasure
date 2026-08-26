<?php
require_once dirname(__DIR__, 3) . '/includes/provider_keys.php';
require_once dirname(__DIR__) . '/_storage.php';

define('TERRITORY_STORAGE_DIR', firstmateSalesStorageRoot('territory'));
define('TERRITORY_LEGACY_STORAGE_DIR', firstmateSalesLegacyStorageRoot('territory'));
define('TERRITORY_DATA_DIR', TERRITORY_STORAGE_DIR . '/data');
define('TERRITORY_TILES_DIR', TERRITORY_DATA_DIR . '/tiles');
define('TERRITORY_FILTERS_DIR', TERRITORY_DATA_DIR . '/filters');
define('TERRITORY_DETAILS_DIR', TERRITORY_DATA_DIR . '/details');
define('TERRITORY_CONFIG_FILE', TERRITORY_DATA_DIR . '/config.json');
define('TERRITORY_DETAILS_INDEX_FILE', TERRITORY_DATA_DIR . '/details_index.json');
define('TERRITORY_COST_LEDGER_FILE', TERRITORY_DATA_DIR . '/cost_ledger.json');
define('TERRITORY_GOOGLE_API_KEY', fm_google_provider_key('places'));
define('TERRITORY_LEGACY_DATA_DIR', TERRITORY_STORAGE_DIR . '/legacy_fetcher');
define('TERRITORY_LEGACY_TILES_DIR', TERRITORY_LEGACY_DATA_DIR . '/tiles');
define('TERRITORY_LEGACY_FILTERS_DIR', TERRITORY_LEGACY_DATA_DIR . '/filters');
define('TERRITORY_LEGACY_DETAILS_DIR', TERRITORY_LEGACY_DATA_DIR . '/details');
define('TERRITORY_LEGACY_DETAILS_INDEX_FILE', TERRITORY_LEGACY_DATA_DIR . '/details_index.json');
define('TERRITORY_LEGACY_COST_LEDGER_FILE', TERRITORY_LEGACY_DATA_DIR . '/cost_ledger.json');

foreach ([TERRITORY_DATA_DIR, TERRITORY_TILES_DIR, TERRITORY_FILTERS_DIR, TERRITORY_DETAILS_DIR] as $dir) {
    if (!is_dir($dir)) mkdir($dir, 0755, true);
}

function territoryLegacyPathFor($file) {
    $file = str_replace('\\', '/', (string)$file);
    $storageRoot = rtrim(str_replace('\\', '/', TERRITORY_STORAGE_DIR), '/');
    $legacyRoot = rtrim(str_replace('\\', '/', TERRITORY_LEGACY_STORAGE_DIR), '/');
    if (strpos($file, $storageRoot . '/') !== 0) return $file;
    return $legacyRoot . substr($file, strlen($storageRoot));
}

function territoryJsonRead($file, $default = []) {
    if (!file_exists($file)) {
        $legacyFile = territoryLegacyPathFor($file);
        if ($legacyFile !== $file && file_exists($legacyFile)) {
            $file = $legacyFile;
        } else {
            return $default;
        }
    }
    $data = json_decode((string)file_get_contents($file), true);
    return is_array($data) ? $data : $default;
}

function territoryJsonWrite($file, $data) {
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) return false;
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    if ($json === false) return false;
    return file_put_contents($file, $json) !== false;
}

function territorySafeName($value) {
    return preg_replace('/[^a-zA-Z0-9_\-]/', '_', (string)$value);
}

function territoryPost($key, $default = null) {
    return $_POST[$key] ?? $default;
}

function territoryJsonPost($key, $default = []) {
    $raw = trim((string)($_POST[$key] ?? ''));
    if ($raw === '') return $default;
    $data = json_decode($raw, true);
    return json_last_error() === JSON_ERROR_NONE ? $data : $default;
}

function territoryActorEmail() {
    return strtolower(trim((string)($_POST['actor_email'] ?? $_SESSION['user']['email'] ?? $_SESSION['email'] ?? '')));
}

function leadStateFromAddress($address, $fallback = '') {
    $raw = strtoupper((string)$address);
    if (preg_match('/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/', $raw, $m)) {
        return $m[1];
    }
    return strtoupper(trim((string)$fallback));
}

function territoryNodeApiBase() {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '127.0.0.1:8021' || $host === 'localhost:8021' || $host === '127.0.0.1' || $host === 'localhost') {
        return 'http://127.0.0.1:3111/v1';
    }
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') === '443');
    $origin = ($https ? 'https://' : 'http://') . (string)($_SERVER['HTTP_HOST'] ?? '');
    return rtrim($origin, '/') . '/v1';
}

function territoryNodeJson($method, $path, $payload = null) {
    $url = rtrim(territoryNodeApiBase(), '/') . '/' . ltrim((string)$path, '/');
    $body = $payload === null ? '' : json_encode($payload, JSON_UNESCAPED_UNICODE);
    $headers = "Accept: application/json\r\n";
    if ($payload !== null) $headers .= "Content-Type: application/json\r\n";
    $context = stream_context_create([
        'http' => [
            'method' => strtoupper((string)$method),
            'header' => $headers,
            'content' => $body,
            'timeout' => 120,
            'ignore_errors' => true,
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    $status = 0;
    foreach (($http_response_header ?? []) as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', (string)$header, $m)) {
            $status = (int)$m[1];
            break;
        }
    }
    $json = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($json)) {
        return ['success' => false, 'error' => 'Node CRM API returned invalid JSON', 'status_code' => $status, 'raw' => substr((string)$raw, 0, 500)];
    }
    if ($status >= 400 || (!empty($json['success']) && $json['success'] === false) || (!empty($json['ok']) && $json['ok'] === false)) {
        return ['success' => false, 'error' => (string)($json['message'] ?? $json['error'] ?? 'Node CRM API request failed'), 'status_code' => $status, 'response' => $json];
    }
    return $json;
}

function territoryGoogleGet($url) {
    $raw = false;
    $code = 0;
    $error = '';

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        $raw = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = (string)curl_error($ch);
        curl_close($ch);
    }

    if (($raw === false || $raw === '' || $code === 0) && function_exists('file_get_contents')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 30,
                'ignore_errors' => true,
                'header' => "User-Agent: FirstMate Territory\r\n",
            ],
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
        $headers = $http_response_header ?? [];
        foreach ($headers as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#i', (string)$header, $m)) {
                $code = (int)$m[1];
                break;
            }
        }
        if ($raw === false && $error === '') {
            $error = 'stream_request_failed';
        }
    }

    $body = is_string($raw) ? (json_decode($raw, true) ?: []) : [];
    if ($error !== '' && !isset($body['_transport_error'])) {
        $body['_transport_error'] = $error;
    }
    return ['code' => $code, 'body' => $body];
}

function territoryMergeAssoc($primary, $secondary) {
    return array_replace($secondary ?: [], $primary ?: []);
}

function territoryReadCombinedJson($newFile, $legacyFile, $default = []) {
    return territoryMergeAssoc(territoryJsonRead($newFile, $default), territoryJsonRead($legacyFile, $default));
}

function territoryRawBusinessRow($row, $tileKey) {
    return [
        'place_id' => (string)($row['place_id'] ?? ''),
        'name' => (string)($row['name'] ?? ''),
        'vicinity' => (string)($row['vicinity'] ?? ''),
        'lat' => $row['lat'] ?? null,
        'lng' => $row['lng'] ?? null,
        'rating' => $row['rating'] ?? null,
        'user_ratings_total' => $row['user_ratings_total'] ?? null,
        'business_status' => (string)($row['business_status'] ?? ''),
        'types' => is_array($row['types'] ?? null) ? array_values($row['types']) : [],
        'photo_count' => $row['photo_count'] ?? 0,
        'open_now' => $row['open_now'] ?? null,
        'price_level' => $row['price_level'] ?? null,
        '_tile' => (string)$tileKey,
    ];
}

function territoryStreamRawBusinessesResponse($legacyTileFiles, $nativeTileFiles) {
    $sourceFlags = [];
    $rawRows = 0;
    $missingPlaceId = 0;
    $duplicateRows = 0;
    $rawRowsLegacy = 0;
    $rawRowsNative = 0;
    $uniqueCount = 0;
    $first = true;
    $flagsBySource = ['legacy' => 1, 'native' => 2];

    echo '{"status":"ok","businesses":[';
    foreach ([['legacy', $legacyTileFiles], ['native', $nativeTileFiles]] as $source) {
        [$sourceName, $files] = $source;
        $sourceFlag = $flagsBySource[$sourceName];
        foreach ($files as $f) {
            $d = territoryJsonRead($f, []);
            $tileKey = $d['tile_key'] ?? '';
            foreach (($d['places'] ?? []) as $row) {
                $rawRows++;
                if ($sourceName === 'legacy') $rawRowsLegacy++;
                else $rawRowsNative++;

                $pid = (string)($row['place_id'] ?? '');
                if ($pid === '') {
                    $missingPlaceId++;
                    continue;
                }

                $previousFlags = $sourceFlags[$pid] ?? 0;
                $sourceFlags[$pid] = $previousFlags | $sourceFlag;
                if ($previousFlags !== 0) {
                    $duplicateRows++;
                    continue;
                }

                $encoded = json_encode(territoryRawBusinessRow($row, $tileKey), JSON_UNESCAPED_UNICODE);
                if ($encoded === false) {
                    $duplicateRows++;
                    continue;
                }
                echo ($first ? '' : ',') . $encoded;
                $first = false;
                $uniqueCount++;
            }
            unset($d);
        }
    }

    $legacyUnique = 0;
    $nativeUnique = 0;
    $bothUnique = 0;
    $nativeOnlyUnique = 0;
    $legacyOnlyUnique = 0;
    foreach ($sourceFlags as $flags) {
        $hasLegacy = (bool)($flags & $flagsBySource['legacy']);
        $hasNative = (bool)($flags & $flagsBySource['native']);
        if ($hasLegacy) $legacyUnique++;
        if ($hasNative) $nativeUnique++;
        if ($hasLegacy && $hasNative) $bothUnique++;
        if ($hasNative && !$hasLegacy) $nativeOnlyUnique++;
        if ($hasLegacy && !$hasNative) $legacyOnlyUnique++;
    }

    echo '],"count":' . $uniqueCount . ',"diagnostics":' . json_encode([
        'legacy_tile_file_count' => count($legacyTileFiles),
        'native_tile_file_count' => count($nativeTileFiles),
        'tile_file_count' => count($legacyTileFiles) + count($nativeTileFiles),
        'raw_tile_rows' => $rawRows,
        'raw_tile_rows_legacy' => $rawRowsLegacy,
        'raw_tile_rows_native' => $rawRowsNative,
        'unique_place_ids' => $uniqueCount,
        'unique_place_ids_legacy' => $legacyUnique,
        'unique_place_ids_native' => $nativeUnique,
        'unique_place_ids_in_both_sources' => $bothUnique,
        'unique_place_ids_native_only' => $nativeOnlyUnique,
        'unique_place_ids_legacy_only' => $legacyOnlyUnique,
        'duplicate_rows_dropped' => $duplicateRows,
        'missing_place_id_rows' => $missingPlaceId,
    ], JSON_UNESCAPED_UNICODE) . '}';
}

function territoryLegacyDetail($placeId) {
    return territoryJsonRead(TERRITORY_LEGACY_DETAILS_DIR . '/' . territorySafeName($placeId) . '.json', []);
}

function territoryLogCost($type, $calls, $context = '') {
    $ledger = territoryJsonRead(TERRITORY_COST_LEDGER_FILE, []);
    $ledger[] = [
        'type' => $type,
        'calls' => (int)$calls,
        'context' => (string)$context,
        'timestamp' => date('c'),
    ];
    territoryJsonWrite(TERRITORY_COST_LEDGER_FILE, $ledger);
}

function territoryCostSummary() {
    $ledger = array_merge(
        territoryJsonRead(TERRITORY_LEGACY_COST_LEDGER_FILE, []),
        territoryJsonRead(TERRITORY_COST_LEDGER_FILE, [])
    );
    $prices = [
        'nearby_search' => 0.032,
        'place_detail' => 0.017,
        'hunter_domain' => 0.0,
        'hunter_lead' => 0.0,
    ];
    $summary = [
        'nearby_search' => ['calls' => 0, 'cost' => 0],
        'place_detail' => ['calls' => 0, 'cost' => 0],
        'hunter_domain' => ['calls' => 0, 'cost' => 0],
        'hunter_lead' => ['calls' => 0, 'cost' => 0],
    ];
    $byDate = [];
    foreach ($ledger as $entry) {
        $type = (string)($entry['type'] ?? '');
        $calls = (int)($entry['calls'] ?? 0);
        if (isset($summary[$type])) {
            $summary[$type]['calls'] += $calls;
            $summary[$type]['cost'] += $calls * ($prices[$type] ?? 0);
        }
        $date = substr((string)($entry['timestamp'] ?? ''), 0, 10);
        if (!isset($byDate[$date])) $byDate[$date] = ['calls' => 0, 'cost' => 0];
        $byDate[$date]['calls'] += $calls;
        $byDate[$date]['cost'] += $calls * ($prices[$type] ?? 0);
    }
    return [
        'by_type' => $summary,
        'by_date' => $byDate,
        'total_calls' => array_sum(array_column($summary, 'calls')),
        'total_cost' => round(array_sum(array_column($summary, 'cost')), 4),
        'entries' => count($ledger),
    ];
}

function territoryNearbySearch($lat, $lng, $radiusMeters, $type, $pageToken = null) {
    $params = ['location' => "$lat,$lng", 'radius' => round($radiusMeters), 'type' => $type, 'key' => TERRITORY_GOOGLE_API_KEY];
    if ($pageToken) $params['pagetoken'] = $pageToken;
    return territoryGoogleGet('https://maps.googleapis.com/maps/api/place/nearbysearch/json?' . http_build_query($params));
}

function territoryPullTile($tileKey, $lat, $lng, $radiusMeters, $type, $tileSideMiles = null) {
    $results = [];
    $pageToken = null;
    $apiCalls = 0;
    $lastStatus = 'UNKNOWN';
    for ($page = 0; $page < 3; $page++) {
        if ($page > 0 && !$pageToken) break;
        if ($pageToken) sleep(2);
        $res = territoryNearbySearch($lat, $lng, $radiusMeters, $type, $pageToken);
        $apiCalls++;
        $status = $res['body']['status'] ?? 'UNKNOWN';
        $lastStatus = $status;
        if ($status !== 'OK' && $status !== 'ZERO_RESULTS') break;
        foreach (($res['body']['results'] ?? []) as $row) {
            $results[] = [
                'place_id' => $row['place_id'] ?? '',
                'name' => $row['name'] ?? '',
                'vicinity' => $row['vicinity'] ?? '',
                'lat' => $row['geometry']['location']['lat'] ?? null,
                'lng' => $row['geometry']['location']['lng'] ?? null,
                'rating' => $row['rating'] ?? null,
                'user_ratings_total' => $row['user_ratings_total'] ?? null,
                'business_status' => $row['business_status'] ?? '',
                'types' => $row['types'] ?? [],
                'photo_count' => isset($row['photos']) ? count($row['photos']) : 0,
                'open_now' => $row['opening_hours']['open_now'] ?? null,
                'price_level' => $row['price_level'] ?? null,
            ];
        }
        $pageToken = $res['body']['next_page_token'] ?? null;
        if (!$pageToken) break;
    }

    $cfg = territoryJsonRead(TERRITORY_CONFIG_FILE, []);
    $sideMiles = $tileSideMiles ?? (float)($cfg['tile_side_miles'] ?? 1.0);
    $sideKm = $sideMiles * 1.60934;
    $halfDegLat = ($sideKm / 111.32) / 2;
    $halfDegLng = ($sideKm / (111.32 * max(cos(deg2rad($lat)), 0.2))) / 2;

    $tileData = [
        'tile_key' => $tileKey,
        'center_lat' => $lat,
        'center_lng' => $lng,
        'radius_meters' => $radiusMeters,
        'type' => $type,
        'pulled_at' => date('c'),
        'api_calls' => $apiCalls,
        'api_status' => $lastStatus,
        'result_count' => count($results),
        'tile_side_miles' => $sideMiles,
        'bounds' => [
            'south' => $lat - $halfDegLat,
            'north' => $lat + $halfDegLat,
            'west' => $lng - $halfDegLng,
            'east' => $lng + $halfDegLng,
        ],
        'places' => $results,
    ];
    $tileFile = TERRITORY_TILES_DIR . '/' . territorySafeName($tileKey) . '.json';
    if (!territoryJsonWrite($tileFile, $tileData)) {
        return [
            'tile_key' => $tileKey,
            'result_count' => count($results),
            'api_calls' => $apiCalls,
            'api_status' => 'WRITE_FAILED',
            'pulled_at' => $tileData['pulled_at'],
            'error' => 'Tile data could not be written to disk: ' . $tileFile
        ];
    }
    territoryLogCost('nearby_search', $apiCalls, 'tile:' . $tileKey);
    return [
        'tile_key' => $tileKey,
        'result_count' => count($results),
        'api_calls' => $apiCalls,
        'api_status' => $lastStatus,
        'pulled_at' => $tileData['pulled_at']
    ];
}

function territoryFetchPlaceDetail($placeId) {
    $fields = 'name,formatted_address,geometry,formatted_phone_number,international_phone_number,website,url,rating,user_ratings_total,business_status,types,opening_hours,place_id';
    $url = 'https://maps.googleapis.com/maps/api/place/details/json?' . http_build_query([
        'place_id' => $placeId,
        'fields' => $fields,
        'key' => TERRITORY_GOOGLE_API_KEY,
    ]);
    $res = territoryGoogleGet($url);
    if (($res['body']['status'] ?? '') !== 'OK' || empty($res['body']['result'])) return null;
    $r = $res['body']['result'];
    return [
        'place_id' => $r['place_id'] ?? $placeId,
        'name' => $r['name'] ?? '',
        'formatted_address' => $r['formatted_address'] ?? '',
        'lat' => $r['geometry']['location']['lat'] ?? null,
        'lng' => $r['geometry']['location']['lng'] ?? null,
        'rating' => $r['rating'] ?? null,
        'user_ratings_total' => $r['user_ratings_total'] ?? null,
        'business_status' => $r['business_status'] ?? '',
        'formatted_phone_number' => $r['formatted_phone_number'] ?? '',
        'international_phone_number' => $r['international_phone_number'] ?? '',
        'website' => $r['website'] ?? '',
        'google_maps_url' => $r['url'] ?? '',
        'types' => $r['types'] ?? [],
        'weekday_text' => $r['opening_hours']['weekday_text'] ?? [],
        'detailed_at' => date('c'),
    ];
}

function territoryBuildCrmListPlan($listName, $chunkSize, $groupMode = 'by_state') {
    $territory = territoryReadCombinedJson(
        TERRITORY_FILTERS_DIR . '/' . territorySafeName($listName) . '.json',
        TERRITORY_LEGACY_FILTERS_DIR . '/' . territorySafeName($listName) . '.json',
        []
    );
    if (!$territory || empty($territory['place_ids'])) return ['success' => false, 'error' => 'Territory list not found or empty'];
    $groupMode = $groupMode === 'ignore_state' ? 'ignore_state' : 'by_state';

    $placeIds = array_values(array_filter(array_map('strval', $territory['place_ids'] ?? [])));
    $rawById = [];
    foreach (array_merge(glob(TERRITORY_LEGACY_TILES_DIR . '/*.json') ?: [], glob(TERRITORY_TILES_DIR . '/*.json') ?: []) as $f) {
        $tile = territoryJsonRead($f, []);
        $tileKey = $tile['tile_key'] ?? '';
        foreach (($tile['places'] ?? []) as $row) {
            $pid = (string)($row['place_id'] ?? '');
            if ($pid !== '' && in_array($pid, $placeIds, true) && !isset($rawById[$pid])) {
                $row['_tile'] = $tileKey;
                $rawById[$pid] = $row;
            }
        }
    }

    $byRegion = [];
    foreach ($placeIds as $pid) {
        $raw = $rawById[$pid] ?? [];
        $detail = territoryMergeAssoc(
            territoryJsonRead(TERRITORY_DETAILS_DIR . '/' . territorySafeName($pid) . '.json', []),
            territoryLegacyDetail($pid)
        );
        if (!$raw && !$detail) continue;
        $address = trim((string)($detail['formatted_address'] ?? $raw['vicinity'] ?? ''));
        $state = function_exists('leadStateFromAddress') ? leadStateFromAddress($address) : '';
        if ($state === '') $state = strtoupper(trim((string)($territory['filter']['state'] ?? 'UNASSIGNED')));
        $region = $state !== '' ? $state : 'UNASSIGNED';
        $bucketKey = $groupMode === 'ignore_state' ? '__all__' : $region;
        if (!isset($byRegion[$bucketKey])) {
            $byRegion[$bucketKey] = [
                'region' => $region,
                'rows' => [],
                'states' => []
            ];
        }
        $byRegion[$bucketKey]['states'][$region] = true;
        $byRegion[$bucketKey]['rows'][] = [
            'external_key' => $pid,
            'company' => trim((string)($detail['name'] ?? $raw['name'] ?? '')),
            'phone' => trim((string)($detail['formatted_phone_number'] ?? '')),
            'website' => trim((string)($detail['website'] ?? '')),
            'address' => $address,
            'region' => $region,
            'region_code' => $region,
            'rating' => $detail['rating'] ?? $raw['rating'] ?? null,
            'user_ratings_total' => $detail['user_ratings_total'] ?? $raw['user_ratings_total'] ?? null,
            'business_status' => $detail['business_status'] ?? $raw['business_status'] ?? '',
            'types' => $detail['types'] ?? $raw['types'] ?? [],
            'lat' => $detail['lat'] ?? $raw['lat'] ?? null,
            'lng' => $detail['lng'] ?? $raw['lng'] ?? null,
            'google_maps_url' => $detail['google_maps_url'] ?? '',
            'source' => 'territory_builder',
            'metadata' => [
                'territory_list_name' => $listName,
                'territory_filter' => $territory['filter'] ?? [],
                'territory_tile' => $raw['_tile'] ?? '',
                'detail_available' => !empty($detail)
            ]
        ];
    }
    if (!$byRegion) return ['success' => false, 'error' => 'No territory businesses were available to import'];

    ksort($byRegion);
    $groups = [];
    foreach ($byRegion as $bucketKey => $bucket) {
        $rows = $bucket['rows'] ?? [];
        usort($rows, function($a, $b) { return strcmp((string)($a['company'] ?? ''), (string)($b['company'] ?? '')); });
        $chunks = $chunkSize > 0 ? array_chunk($rows, $chunkSize) : [$rows];
        $states = array_keys($bucket['states'] ?? []);
        sort($states);
        $groups[] = [
            'bucket_key' => $bucketKey,
            'region' => $bucketKey === '__all__' ? 'ALL' : (string)($bucket['region'] ?? $bucketKey),
            'state_codes' => $states,
            'lead_count' => count($rows),
            'chunk_count' => count($chunks),
            'chunks' => array_map(function($chunk, $idx) {
                return [
                    'index' => $idx + 1,
                    'lead_count' => count($chunk)
                ];
            }, $chunks, array_keys($chunks)),
            'rows' => $rows
        ];
    }

    return [
        'success' => true,
        'territory' => $territory,
        'list_name' => $listName,
        'group_mode' => $groupMode,
        'selected_count' => count($placeIds),
        'group_count' => count($groups),
        'groups' => $groups
    ];
}

function territoryPreviewCrmLists($listName, $chunkSize, $groupMode = 'by_state') {
    $plan = territoryBuildCrmListPlan($listName, $chunkSize, $groupMode);
    if (empty($plan['success'])) return $plan;
    $previewGroups = [];
    foreach (($plan['groups'] ?? []) as $group) {
        $previewGroups[] = [
            'region' => $group['region'],
            'state_codes' => $group['state_codes'],
            'lead_count' => $group['lead_count'],
            'chunk_count' => $group['chunk_count'],
            'chunks' => $group['chunks']
        ];
    }
    return [
        'success' => true,
        'list_name' => $listName,
        'group_mode' => $plan['group_mode'],
        'selected_count' => $plan['selected_count'],
        'group_count' => $plan['group_count'],
        'groups' => $previewGroups
    ];
}

function territorySalesLeadImportRows($plan) {
    $rows = [];
    foreach (($plan['groups'] ?? []) as $group) {
        $region = (string)($group['region'] ?? 'UNASSIGNED');
        foreach (($group['rows'] ?? []) as $row) {
            $metadata = is_array($row['metadata'] ?? null) ? $row['metadata'] : [];
            $metadata['territory_import_name'] = (string)($plan['list_name'] ?? '');
            $metadata['territory_group_region'] = $region;
            $metadata['rating'] = $row['rating'] ?? '';
            $metadata['user_ratings_total'] = $row['user_ratings_total'] ?? '';
            $metadata['business_status'] = (string)($row['business_status'] ?? '');
            $metadata['google_maps_url'] = (string)($row['google_maps_url'] ?? '');
            $metadata['types'] = $row['types'] ?? [];
            $metadata['lat'] = $row['lat'] ?? '';
            $metadata['lng'] = $row['lng'] ?? '';

            $rows[] = [
                'external_key' => (string)($row['external_key'] ?? ''),
                'company' => (string)($row['company'] ?? ''),
                'phone' => (string)($row['phone'] ?? ''),
                'website' => (string)($row['website'] ?? ''),
                'address' => (string)($row['address'] ?? ''),
                'city' => (string)($row['city'] ?? ''),
                'state' => (string)($row['state'] ?? $row['region_code'] ?? $row['region'] ?? $region),
                'region' => (string)($row['region'] ?? $region),
                'region_code' => (string)($row['region_code'] ?? $region),
                'status' => (string)($row['status'] ?? 'new'),
                'source' => 'territory_builder',
                'metadata' => $metadata,
                'Territory List' => (string)($plan['list_name'] ?? ''),
                'Territory Region' => $region,
                'Rating' => $row['rating'] ?? '',
                'Review Count' => $row['user_ratings_total'] ?? '',
                'Business Status' => (string)($row['business_status'] ?? ''),
                'Google Maps URL' => (string)($row['google_maps_url'] ?? ''),
                'Latitude' => $row['lat'] ?? '',
                'Longitude' => $row['lng'] ?? '',
            ];
        }
    }
    return $rows;
}

function territoryPreviewSalesLeadImport($listName, $groupMode = 'by_state') {
    $plan = territoryBuildCrmListPlan($listName, 0, $groupMode);
    if (empty($plan['success'])) return $plan;
    $rows = territorySalesLeadImportRows($plan);
    if (!$rows) return ['success' => false, 'error' => 'No territory businesses were available to import'];

    $preview = territoryNodeJson('POST', 'internal/crm/leads/imports/preview', [
        'actor_email' => territoryActorEmail(),
        'rows' => $rows,
    ]);
    if (empty($preview['success']) && empty($preview['ok'])) return $preview;

    $previewGroups = [];
    foreach (($plan['groups'] ?? []) as $group) {
        $previewGroups[] = [
            'region' => $group['region'],
            'state_codes' => $group['state_codes'],
            'lead_count' => $group['lead_count'],
        ];
    }
    $preview['success'] = true;
    $preview['list_name'] = $listName;
    $preview['group_mode'] = $plan['group_mode'];
    $preview['selected_count'] = $plan['selected_count'];
    $preview['group_count'] = $plan['group_count'];
    $preview['groups'] = $previewGroups;
    $preview['row_count'] = count($rows);
    return $preview;
}

function territoryCommitSalesLeadImport($importId, $newAction, $duplicateAction, $unchangedAction) {
    $importId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$importId);
    if ($importId === '') return ['success' => false, 'error' => 'import_id required'];
    $validNew = ['create', 'skip'];
    $validDuplicate = ['update', 'skip', 'create'];
    $validUnchanged = ['skip', 'touch'];
    if (!in_array($newAction, $validNew, true)) $newAction = 'create';
    if (!in_array($duplicateAction, $validDuplicate, true)) $duplicateAction = 'update';
    if (!in_array($unchangedAction, $validUnchanged, true)) $unchangedAction = 'skip';

    return territoryNodeJson('POST', 'internal/crm/leads/imports/' . rawurlencode($importId) . '/commit', [
        'actor_email' => territoryActorEmail(),
        'new_action' => $newAction,
        'duplicate_action' => $duplicateAction,
        'unchanged_action' => $unchangedAction,
    ]);
}

function territoryCreateCrmLists($listName, $chunkSize, $groupMode = 'by_state') {
    $plan = territoryBuildCrmListPlan($listName, $chunkSize, $groupMode);
    if (empty($plan['success'])) return $plan;
    $actor = territoryActorEmail();
    $created = [];
    $totals = ['created' => 0, 'updated' => 0, 'unchanged' => 0, 'skipped' => 0, 'invalid' => 0];
    foreach (($plan['groups'] ?? []) as $group) {
        $region = (string)($group['region'] ?? 'UNASSIGNED');
        $rows = $group['rows'] ?? [];
        $chunks = $chunkSize > 0 ? array_chunk($rows, $chunkSize) : [$rows];
        foreach ($chunks as $idx => $chunk) {
            if (!$chunk) continue;
            $name = count($chunks) > 1 ? ($listName . ' - ' . $region . ' #' . ($idx + 1)) : ($listName . ' - ' . $region);
            $importRows = [];
            foreach ($chunk as $row) {
                $metadata = is_array($row['metadata'] ?? null) ? $row['metadata'] : [];
                $metadata['territory_import_name'] = $name;
                $metadata['territory_group_region'] = $region;
                $importRows[] = [
                    'external_key' => (string)($row['external_key'] ?? ''),
                    'company' => (string)($row['company'] ?? ''),
                    'phone' => (string)($row['phone'] ?? ''),
                    'website' => (string)($row['website'] ?? ''),
                    'address' => (string)($row['address'] ?? ''),
                    'city' => (string)($row['city'] ?? ''),
                    'state' => (string)($row['state'] ?? $row['region_code'] ?? $row['region'] ?? $region),
                    'region' => (string)($row['region'] ?? $region),
                    'region_code' => (string)($row['region_code'] ?? $region),
                    'status' => (string)($row['status'] ?? 'new'),
                    'source' => 'territory_builder',
                    'metadata' => $metadata,
                    'Rating' => $row['rating'] ?? '',
                    'Review Count' => $row['user_ratings_total'] ?? '',
                    'Business Status' => (string)($row['business_status'] ?? ''),
                    'Google Maps URL' => (string)($row['google_maps_url'] ?? ''),
                    'Latitude' => $row['lat'] ?? '',
                    'Longitude' => $row['lng'] ?? '',
                ];
            }
            $preview = territoryNodeJson('POST', 'internal/crm/leads/imports/preview', [
                'actor_email' => $actor,
                'rows' => $importRows,
            ]);
            if (empty($preview['success']) && empty($preview['ok'])) return $preview;
            $importId = (string)($preview['import_id'] ?? '');
            if ($importId === '') return ['success' => false, 'error' => 'Node CRM import preview did not return an import id'];
            $commit = territoryNodeJson('POST', 'internal/crm/leads/imports/' . rawurlencode($importId) . '/commit', [
                'actor_email' => $actor,
                'new_action' => 'create',
                'duplicate_action' => 'update',
                'unchanged_action' => 'skip',
            ]);
            if (empty($commit['success']) && empty($commit['ok'])) return $commit;
            $counts = is_array($commit['counts'] ?? null) ? $commit['counts'] : [];
            foreach ($totals as $key => $_value) $totals[$key] += (int)($counts[$key] ?? 0);
            $created[] = [
                'id' => $importId,
                'name' => $name,
                'lead_count' => count($chunk),
                'import_id' => $importId,
                'counts' => $counts,
            ];
        }
    }
    return ['success' => true, 'lists' => $created, 'group_mode' => $groupMode, 'counts' => $totals, 'node_import' => true];
}

function territoryMigrateLegacyData() {
    $copied = ['tiles' => 0, 'filters' => 0, 'details' => 0];
    $pairs = [
        [TERRITORY_LEGACY_TILES_DIR, TERRITORY_TILES_DIR, 'tiles'],
        [TERRITORY_LEGACY_FILTERS_DIR, TERRITORY_FILTERS_DIR, 'filters'],
        [TERRITORY_LEGACY_DETAILS_DIR, TERRITORY_DETAILS_DIR, 'details'],
    ];
    foreach ($pairs as [$fromDir, $toDir, $key]) {
        foreach (glob($fromDir . '/*.json') ?: [] as $path) {
            $dest = $toDir . '/' . basename($path);
            if (!file_exists($dest)) {
                copy($path, $dest);
                $copied[$key]++;
            }
        }
    }
    $mergedIndex = territoryReadCombinedJson(TERRITORY_DETAILS_INDEX_FILE, TERRITORY_LEGACY_DETAILS_INDEX_FILE, []);
    territoryJsonWrite(TERRITORY_DETAILS_INDEX_FILE, $mergedIndex);
    return ['success' => true, 'copied' => $copied, 'detail_index_count' => count($mergedIndex)];
}

function handleTerritoryActions($action) {
    if (strpos($action, 'territory_') !== 0) return false;
    if (function_exists('leadRequireAccess')) leadRequireAccess();
    if (function_exists('leadCanManageLists') && !leadCanManageLists()) {
        echo json_encode(['status' => 'error', 'message' => 'Unauthorized']);
        return true;
    }

    $action = substr($action, strlen('territory_'));

    switch ($action) {
        case 'get_config':
            echo json_encode([
                'status' => 'ok',
                'config' => territoryReadCombinedJson(TERRITORY_CONFIG_FILE, TERRITORY_LEGACY_DATA_DIR . '/config.json', [
                    'center_lat' => 47.6062, 'center_lng' => -122.3321, 'tile_side_miles' => 1.0, 'search_type' => 'roofing_contractor', 'zoom' => 11,
                ]),
                'legacy_config' => territoryJsonRead(TERRITORY_LEGACY_DATA_DIR . '/config.json', []),
            ]);
            return true;
        case 'save_config':
            $cfg = territoryJsonRead(TERRITORY_CONFIG_FILE, []);
            foreach (['center_lat','center_lng','tile_side_miles','search_type','zoom'] as $key) {
                if (isset($_POST[$key])) $cfg[$key] = $_POST[$key];
            }
            territoryJsonWrite(TERRITORY_CONFIG_FILE, $cfg);
            echo json_encode(['status' => 'ok']);
            return true;
        case 'get_tile_status':
            $tiles = [];
            foreach (array_merge(glob(TERRITORY_LEGACY_TILES_DIR . '/*.json') ?: [], glob(TERRITORY_TILES_DIR . '/*.json') ?: []) as $f) {
                $d = territoryJsonRead($f, []);
                $tiles[$d['tile_key'] ?? basename($f,'.json')] = [
                    'pulled_at' => $d['pulled_at'] ?? null,
                    'result_count' => $d['result_count'] ?? 0,
                    'api_calls' => $d['api_calls'] ?? 0,
                    'api_status' => $d['api_status'] ?? '',
                    'center_lat' => $d['center_lat'] ?? null,
                    'center_lng' => $d['center_lng'] ?? null,
                    'radius_meters' => $d['radius_meters'] ?? null,
                    'tile_side_miles' => $d['tile_side_miles'] ?? null,
                    'bounds' => $d['bounds'] ?? null,
                ];
            }
            echo json_encode(['status' => 'ok', 'tiles' => $tiles]);
            return true;
        case 'pull_tile':
            echo json_encode(['status' => 'ok', 'result' => territoryPullTile(
                (string)territoryPost('tile_key', ''),
                floatval(territoryPost('center_lat', 0)),
                floatval(territoryPost('center_lng', 0)),
                floatval(territoryPost('radius_meters', 1200)),
                (string)territoryPost('search_type', 'roofing_contractor'),
                isset($_POST['tile_side_miles']) ? floatval($_POST['tile_side_miles']) : null
            )]);
            return true;
        case 'delete_tile':
            $tileKey = (string)territoryPost('tile_key', '');
            if ($tileKey === '') die(json_encode(['status' => 'error', 'message' => 'tile_key required']));
            $file = TERRITORY_TILES_DIR . '/' . territorySafeName($tileKey) . '.json';
            if (file_exists($file)) unlink($file);
            echo json_encode(['status' => 'ok']);
            return true;
        case 'get_raw_businesses':
            $legacyTileFiles = glob(TERRITORY_LEGACY_TILES_DIR . '/*.json') ?: [];
            $nativeTileFiles = glob(TERRITORY_TILES_DIR . '/*.json') ?: [];
            territoryStreamRawBusinessesResponse($legacyTileFiles, $nativeTileFiles);
            return true;
        case 'save_filter_list':
            $name = (string)territoryPost('list_name', 'default');
            $placeIds = territoryJsonPost('place_ids', []);
            $data = ['list_name' => $name, 'filter' => territoryJsonPost('filter', []), 'place_ids' => $placeIds, 'count' => count($placeIds), 'created_at' => date('c')];
            $ok = territoryJsonWrite(TERRITORY_FILTERS_DIR . '/' . territorySafeName($name) . '.json', $data);
            echo json_encode($ok ? ['status' => 'ok', 'list' => $data] : ['status' => 'error', 'message' => 'Could not write saved filter list to disk']);
            return true;
        case 'get_filter_lists':
            $lists = [];
            $detailIndex = territoryReadCombinedJson(TERRITORY_DETAILS_INDEX_FILE, TERRITORY_LEGACY_DETAILS_INDEX_FILE, []);
            $allPlaceIds = [];
            foreach (array_merge(glob(TERRITORY_LEGACY_FILTERS_DIR . '/*.json') ?: [], glob(TERRITORY_FILTERS_DIR . '/*.json') ?: []) as $f) {
                $d = territoryJsonRead($f, []);
                $name = $d['list_name'] ?? basename($f, '.json');
                $placeIds = array_values(array_filter(array_map('strval', $d['place_ids'] ?? [])));
                $doneCount = 0;
                foreach ($placeIds as $pid) {
                    if (isset($detailIndex[$pid])) $doneCount++;
                    $allPlaceIds[$pid] = true;
                }
                $count = count($placeIds);
                $lists[$name] = [
                    'list_name' => $name,
                    'count' => $count ?: ($d['count'] ?? 0),
                    'done_count' => $doneCount,
                    'created_at' => $d['created_at'] ?? null,
                    'filter' => $d['filter'] ?? [],
                ];
            }
            echo json_encode([
                'status' => 'ok',
                'lists' => array_values($lists),
                'all_place_ids' => array_keys($allPlaceIds),
            ]);
            return true;
        case 'delete_filter_list':
            $file = TERRITORY_FILTERS_DIR . '/' . territorySafeName((string)territoryPost('list_name', '')) . '.json';
            if (file_exists($file)) unlink($file);
            echo json_encode(['status' => 'ok']);
            return true;
        case 'get_filter_list_detail':
            echo json_encode(['status' => 'ok', 'list' => territoryReadCombinedJson(
                TERRITORY_FILTERS_DIR . '/' . territorySafeName((string)territoryPost('list_name', '')) . '.json',
                TERRITORY_LEGACY_FILTERS_DIR . '/' . territorySafeName((string)territoryPost('list_name', '')) . '.json',
                []
            )]);
            return true;
        case 'get_detail_index':
            echo json_encode(['status' => 'ok', 'index' => territoryReadCombinedJson(TERRITORY_DETAILS_INDEX_FILE, TERRITORY_LEGACY_DETAILS_INDEX_FILE, [])]);
            return true;
        case 'get_detail_queue':
            $ld = territoryReadCombinedJson(
                TERRITORY_FILTERS_DIR . '/' . territorySafeName((string)territoryPost('list_name', '')) . '.json',
                TERRITORY_LEGACY_FILTERS_DIR . '/' . territorySafeName((string)territoryPost('list_name', '')) . '.json',
                []
            );
            $pids = $ld['place_ids'] ?? []; $ix = territoryReadCombinedJson(TERRITORY_DETAILS_INDEX_FILE, TERRITORY_LEGACY_DETAILS_INDEX_FILE, []); $needed = []; $done = [];
            foreach ($pids as $pid) { if (isset($ix[$pid])) $done[] = $pid; else $needed[] = $pid; }
            echo json_encode(['status' => 'ok', 'total' => count($pids), 'needed' => count($needed), 'done' => count($done), 'needed_ids' => $needed]);
            return true;
        case 'pull_detail':
            $pid = (string)territoryPost('place_id', '');
            if ($pid === '') die(json_encode(['status' => 'error', 'message' => 'place_id required']));
            $detail = territoryFetchPlaceDetail($pid);
            if (!$detail) { echo json_encode(['status' => 'error', 'message' => 'Failed']); return true; }
            if (!territoryJsonWrite(TERRITORY_DETAILS_DIR . '/' . territorySafeName($pid) . '.json', $detail)) {
                echo json_encode(['status' => 'error', 'message' => 'Could not write place detail to disk']);
                return true;
            }
            $ix = territoryJsonRead(TERRITORY_DETAILS_INDEX_FILE, []); $ix[$pid] = ['name' => $detail['name'], 'detailed_at' => $detail['detailed_at']];
            if (!territoryJsonWrite(TERRITORY_DETAILS_INDEX_FILE, $ix)) {
                echo json_encode(['status' => 'error', 'message' => 'Could not update detail index']);
                return true;
            }
            territoryLogCost('place_detail', 1, 'place:' . $pid);
            echo json_encode(['status' => 'ok', 'detail' => $detail]);
            return true;
        case 'pull_details_batch':
            $pids = territoryJsonPost('place_ids', []); $results = []; $ix = territoryReadCombinedJson(TERRITORY_DETAILS_INDEX_FILE, TERRITORY_LEGACY_DETAILS_INDEX_FILE, []); $calls = 0;
            foreach ($pids as $pid) {
                $pid = (string)$pid;
                if (isset($ix[$pid])) continue;
                $detail = territoryFetchPlaceDetail($pid); $calls++;
                if ($detail) {
                    if (!territoryJsonWrite(TERRITORY_DETAILS_DIR . '/' . territorySafeName($pid) . '.json', $detail)) {
                        echo json_encode(['status' => 'error', 'message' => 'Could not write batch place detail to disk']);
                        return true;
                    }
                    $ix[$pid] = ['name' => $detail['name'], 'detailed_at' => $detail['detailed_at']];
                    $results[] = $detail;
                }
                usleep(120000);
            }
            if (!territoryJsonWrite(TERRITORY_DETAILS_INDEX_FILE, $ix)) {
                echo json_encode(['status' => 'error', 'message' => 'Could not update batch detail index']);
                return true;
            }
            territoryLogCost('place_detail', $calls, 'batch:' . count($pids) . ' places');
            echo json_encode(['status' => 'ok', 'fetched' => count($results), 'api_calls' => $calls, 'details' => $results]);
            return true;
        case 'get_detailed_places':
            $listName = (string)territoryPost('list_name', '');
            $filterIds = null;
            if ($listName !== '') {
                $ld = territoryReadCombinedJson(
                    TERRITORY_FILTERS_DIR . '/' . territorySafeName($listName) . '.json',
                    TERRITORY_LEGACY_FILTERS_DIR . '/' . territorySafeName($listName) . '.json',
                    []
                );
                $filterIds = array_flip($ld['place_ids'] ?? []);
            }
            $all = [];
            foreach (array_merge(glob(TERRITORY_LEGACY_DETAILS_DIR . '/*.json') ?: [], glob(TERRITORY_DETAILS_DIR . '/*.json') ?: []) as $f) {
                $d = territoryJsonRead($f, []); $pid = $d['place_id'] ?? null;
                if (!$pid) continue;
                if ($filterIds !== null && !isset($filterIds[$pid])) continue;
                $all[$pid] = $d;
            }
            echo json_encode(['status' => 'ok', 'count' => count($all), 'places' => array_values($all)]);
            return true;
        case 'create_crm_lists':
            $listName = (string)territoryPost('list_name', '');
            $chunkSize = max(0, min(5000, (int)territoryPost('chunk_size', 250)));
            $groupMode = (string)territoryPost('group_mode', 'by_state');
            if ($listName === '') die(json_encode(['success' => false, 'error' => 'list_name required']));
            echo json_encode(territoryCreateCrmLists($listName, $chunkSize, $groupMode));
            return true;
        case 'preview_crm_lists':
            $listName = (string)territoryPost('list_name', '');
            $chunkSize = max(0, min(5000, (int)territoryPost('chunk_size', 250)));
            $groupMode = (string)territoryPost('group_mode', 'by_state');
            if ($listName === '') die(json_encode(['success' => false, 'error' => 'list_name required']));
            echo json_encode(territoryPreviewCrmLists($listName, $chunkSize, $groupMode));
            return true;
        case 'preview_sales_lead_import':
            $listName = (string)territoryPost('list_name', '');
            $groupMode = (string)territoryPost('group_mode', 'by_state');
            if ($listName === '') die(json_encode(['success' => false, 'error' => 'list_name required']));
            echo json_encode(territoryPreviewSalesLeadImport($listName, $groupMode));
            return true;
        case 'commit_sales_lead_import':
            echo json_encode(territoryCommitSalesLeadImport(
                (string)territoryPost('import_id', ''),
                (string)territoryPost('new_action', 'create'),
                (string)territoryPost('duplicate_action', 'update'),
                (string)territoryPost('unchanged_action', 'skip')
            ));
            return true;
        case 'migrate_legacy_data':
            echo json_encode(territoryMigrateLegacyData());
            return true;
        case 'get_costs':
            echo json_encode(['status' => 'ok', 'costs' => territoryCostSummary()]);
            return true;
        case 'reset_costs':
            territoryJsonWrite(TERRITORY_COST_LEDGER_FILE, []);
            echo json_encode(['status' => 'ok']);
            return true;
        default:
            echo json_encode(['status' => 'error', 'message' => 'Unknown action: ' . $action]);
            return true;
    }
}
