<?php
require_once dirname(__DIR__) . '/_storage.php';

define('TERRITORY_DATA_DIR', storagePath('territory/data'));
define('TERRITORY_TILES_DIR', TERRITORY_DATA_DIR . '/tiles');
define('TERRITORY_FILTERS_DIR', TERRITORY_DATA_DIR . '/filters');
define('TERRITORY_DETAILS_DIR', TERRITORY_DATA_DIR . '/details');
define('TERRITORY_CONFIG_FILE', TERRITORY_DATA_DIR . '/config.json');
define('TERRITORY_DETAILS_INDEX_FILE', TERRITORY_DATA_DIR . '/details_index.json');
define('TERRITORY_COST_LEDGER_FILE', TERRITORY_DATA_DIR . '/cost_ledger.json');
define('TERRITORY_GOOGLE_API_KEY', 'REMOVED_CREDENTIAL');
define('TERRITORY_LEGACY_DATA_DIR', storagePath('lists/data/fetcher'));
define('TERRITORY_LEGACY_TILES_DIR', TERRITORY_LEGACY_DATA_DIR . '/tiles');
define('TERRITORY_LEGACY_FILTERS_DIR', TERRITORY_LEGACY_DATA_DIR . '/filters');
define('TERRITORY_LEGACY_DETAILS_DIR', TERRITORY_LEGACY_DATA_DIR . '/details');
define('TERRITORY_LEGACY_DETAILS_INDEX_FILE', TERRITORY_LEGACY_DATA_DIR . '/details_index.json');
define('TERRITORY_LEGACY_COST_LEDGER_FILE', TERRITORY_LEGACY_DATA_DIR . '/cost_ledger.json');

foreach ([TERRITORY_DATA_DIR, TERRITORY_TILES_DIR, TERRITORY_FILTERS_DIR, TERRITORY_DETAILS_DIR] as $dir) {
    if (!is_dir($dir)) mkdir($dir, 0755, true);
}

function territoryJsonRead($file, $default = []) {
    if (!file_exists($file)) return $default;
    $data = json_decode((string)file_get_contents($file), true);
    return is_array($data) ? $data : $default;
}

function territoryJsonWrite($file, $data) {
    file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
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
    territoryJsonWrite(TERRITORY_TILES_DIR . '/' . territorySafeName($tileKey) . '.json', $tileData);
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

function territoryCreateCrmLists($listName, $chunkSize) {
    $territory = territoryReadCombinedJson(
        TERRITORY_FILTERS_DIR . '/' . territorySafeName($listName) . '.json',
        TERRITORY_LEGACY_FILTERS_DIR . '/' . territorySafeName($listName) . '.json',
        []
    );
    if (!$territory || empty($territory['place_ids'])) return ['success' => false, 'error' => 'Territory list not found or empty'];

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
        $byRegion[$region][] = [
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

    $db = leadDb();
    $actor = leadActorEmail();
    $now = time();
    $runKey = 'territory:' . territorySafeName($listName) . ':' . date('Ymd_His');
    $created = [];
    ksort($byRegion);
    foreach ($byRegion as $region => $rows) {
        usort($rows, function($a, $b) { return strcmp((string)($a['company'] ?? ''), (string)($b['company'] ?? '')); });
        $chunks = $chunkSize > 0 ? array_chunk($rows, $chunkSize) : [$rows];
        foreach ($chunks as $idx => $chunk) {
            if (!$chunk) continue;
            $name = count($chunks) > 1 ? ($listName . ' - ' . $region . ' #' . ($idx + 1)) : ($listName . ' - ' . $region);
            $saved = leadUpsertGeneratedList($db, [
                'id' => leadId('list'),
                'name' => $name,
                'region' => $region,
                'region_code' => $region,
                'type' => 'territory',
                'source_kind' => 'territory_filter_list',
                'source_key' => $runKey . ':' . strtolower($region) . ':' . ($idx + 1),
                'description' => 'Generated from the native territory builder.',
                'status' => 'active',
                'assigned_to_email' => '',
                'assigned_by_email' => '',
                'sort_order' => $idx + 1,
                'metadata_json' => [
                    'territory_list_name' => $listName,
                    'territory_filter' => $territory['filter'] ?? [],
                    'chunk_size' => count($chunk)
                ]
            ], $actor, $now);
            if (empty($saved['success'])) return $saved;
            $listId = $saved['id'];
            leadDeleteListLeads($db, $listId);
            foreach ($chunk as $row) {
                $normalized = leadNormalizeLeadPayload($row, $region, $region, '', 'territory_builder');
                leadInsertLead($db, $listId, $normalized, $actor, $now);
            }
            $count = leadSyncListLeadCount($db, $listId);
            $created[] = ['id' => $listId, 'name' => $name, 'lead_count' => $count];
        }
    }
    return ['success' => true, 'lists' => $created];
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
            $all = []; $seen = [];
            foreach (array_merge(glob(TERRITORY_LEGACY_TILES_DIR . '/*.json') ?: [], glob(TERRITORY_TILES_DIR . '/*.json') ?: []) as $f) {
                $d = territoryJsonRead($f, []); $tileKey = $d['tile_key'] ?? '';
                foreach (($d['places'] ?? []) as $row) {
                    $pid = $row['place_id'] ?? null;
                    if ($pid && !isset($seen[$pid])) { $seen[$pid] = true; $row['_tile'] = $tileKey; $all[] = $row; }
                }
            }
            echo json_encode(['status' => 'ok', 'count' => count($all), 'businesses' => $all]);
            return true;
        case 'save_filter_list':
            $name = (string)territoryPost('list_name', 'default');
            $placeIds = territoryJsonPost('place_ids', []);
            $data = ['list_name' => $name, 'filter' => territoryJsonPost('filter', []), 'place_ids' => $placeIds, 'count' => count($placeIds), 'created_at' => date('c')];
            territoryJsonWrite(TERRITORY_FILTERS_DIR . '/' . territorySafeName($name) . '.json', $data);
            echo json_encode(['status' => 'ok', 'list' => $data]);
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
            territoryJsonWrite(TERRITORY_DETAILS_DIR . '/' . territorySafeName($pid) . '.json', $detail);
            $ix = territoryJsonRead(TERRITORY_DETAILS_INDEX_FILE, []); $ix[$pid] = ['name' => $detail['name'], 'detailed_at' => $detail['detailed_at']];
            territoryJsonWrite(TERRITORY_DETAILS_INDEX_FILE, $ix);
            territoryLogCost('place_detail', 1, 'place:' . $pid);
            echo json_encode(['status' => 'ok', 'detail' => $detail]);
            return true;
        case 'pull_details_batch':
            $pids = territoryJsonPost('place_ids', []); $results = []; $ix = territoryReadCombinedJson(TERRITORY_DETAILS_INDEX_FILE, TERRITORY_LEGACY_DETAILS_INDEX_FILE, []); $calls = 0;
            foreach ($pids as $pid) {
                $pid = (string)$pid;
                if (isset($ix[$pid])) continue;
                $detail = territoryFetchPlaceDetail($pid); $calls++;
                if ($detail) { territoryJsonWrite(TERRITORY_DETAILS_DIR . '/' . territorySafeName($pid) . '.json', $detail); $ix[$pid] = ['name' => $detail['name'], 'detailed_at' => $detail['detailed_at']]; $results[] = $detail; }
                usleep(120000);
            }
            territoryJsonWrite(TERRITORY_DETAILS_INDEX_FILE, $ix);
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
            if ($listName === '') die(json_encode(['success' => false, 'error' => 'list_name required']));
            echo json_encode(territoryCreateCrmLists($listName, $chunkSize));
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
