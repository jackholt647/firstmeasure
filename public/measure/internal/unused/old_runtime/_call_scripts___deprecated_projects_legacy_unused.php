<?php
require_once dirname(__DIR__) . '/_storage.php';
/**
 * DEPRECATED LEGACY FILE
 * Formerly the legacy call-scripts projects module.
 *
 * This file is not part of the active FirstMeasure API runtime.
 * Live project / QA / manager workflow logic now lives under
 * `public/v1/firstmeasure/`.
 *
 * Keep only for historical reference and transitional maintenance scripts.
 *
 * _deprecated_projects_legacy_unused.php
 *
 * Project-related and queue-related functions and action handlers.
 * This file should be included AFTER all config, globals, org, user, and stripe functions are defined.
 *
 * Contains:
 * - Project helper functions (folder paths, manifest utilities, file operations)
 * - API processing functions (Google, Solar, Azure)
 * - Email tracking for projects
 * - Coverage rejection helpers
 * - Queue action handlers
 * - Project CRUD action handlers
 * - QA action handlers
 */
// ------------------------------------------------
// ---------------- PRICING CONSTANTS -------------
// ------------------------------------------------
define('PRICE_RESIDENTIAL', 7);
define('PRICE_COMMERCIAL',  12);
define('PRICE_MULTIFAMILY', 12);
define('PORTAL_GUTTER_REPORT_ADDON', 3);

define('FORCE_VIP_NON_TEST_ORGS', true);

function projectTypePrice($type) {
    $map = [
        'residential'  => PRICE_RESIDENTIAL,
        'commercial'   => PRICE_COMMERCIAL,
        'multifamily'  => PRICE_MULTIFAMILY,
    ];
    return $map[$type] ?? PRICE_RESIDENTIAL;
}


function projectIsTestOrg($manifest) {
    if (!is_array($manifest)) return false;

    // ── 1. org_id stored directly on manifest ──
    $orgId = orgNormalizeId($manifest['organization_id'] ?? '');

    // ── 2. Fall back to owner_email's org ──
    if ($orgId === '') {
        $ownerEmail = strtolower(trim((string)($manifest['owner_email'] ?? '')));
        if ($ownerEmail !== '' && $ownerEmail !== 'system') {
            $u = readUserDataByEmail($ownerEmail);
            if ($u) $orgId = orgNormalizeId($u['organization_id'] ?? '');
        }
    }

    // ── 3. Fall back to issuer email's org ──
    if ($orgId === '') {
        $issuerEmail = strtolower(trim((string)($manifest['issuer']['email'] ?? '')));
        if ($issuerEmail !== '' && strpos($issuerEmail, 'system') === false) {
            $u = readUserDataByEmail($issuerEmail);
            if ($u) $orgId = orgNormalizeId($u['organization_id'] ?? '');
        }
    }

    if ($orgId === '') return false;   // could not resolve org → not a test org

    $org = orgRead($orgId);
    return ($org && !empty($org['is_test']));
}

// ------------------------------------------------
// ---------------- SECURITY HELPERS --------------
// ------------------------------------------------
function getFolder($address) {
    return md5(strtolower(trim($address)));
}

function safeParseTs($s) {
    $t = strtotime($s);
    return $t ? $t : 0;
}

function computeComplexityRating($segmentCount) {
    $segmentCount = (int)$segmentCount;

    if ($segmentCount <= 0) return 3; // no data — assume moderate
    if ($segmentCount <= 5) return 1;
    if ($segmentCount <= 10) return 2;
    if ($segmentCount <= 20) return 3;
    if ($segmentCount <= 35) return 4;
    return 5;
}

function normalizeComplexity($value) {
    // Already numeric
    if (is_int($value) && $value >= 1 && $value <= 5) return $value;
    if (is_numeric($value)) {
        $v = (int)$value;
        return max(1, min(5, $v));
    }

    // Legacy string mapping
    $value = strtolower(trim((string)$value));
    if ($value === 'simple') return 1;
    if ($value === 'complex') return 3;

    // Unknown / empty — default to moderate
    return 3;
}

function manifestStatusRank($status) {
    $order = [
        'generating_filler',
        'queued',
        'ready',
        'processing',
        'in_progress',
        'correction_needed',
        'pending_rejection',
        'awaiting_review',
        'awaiting_manager_review',
        'completed',
        'rejected_no_coverage',
        'rejected',
    ];
    $idx = array_search((string)$status, $order, true);
    return $idx === false ? -1 : $idx;
}

/**
 * Save manifest with automatic backup of the previous version.
 * Creates timestamped backups in a 'manifest_backups' subdirectory.
 *
 * @param string $manifestPath Full path to manifest.json
 * @param array $data The manifest data to save
 * @return int|false Number of bytes written, or false on failure
 */
function saveManifest($manifestPath, $data) {
    // If manifest already exists, back it up first
    if (file_exists($manifestPath)) {
        // --- Status regression guard ---
        $existing = json_decode(@file_get_contents($manifestPath), true);
        if (is_array($existing)) {
            $currentStatus = (string)($existing['status'] ?? '');
            $newStatus     = (string)($data['status']    ?? '');
            $protectedStatuses = ['completed', 'rejected_no_coverage', 'rejected'];

            if (in_array($currentStatus, $protectedStatuses, true)
                && $newStatus !== $currentStatus
                && manifestStatusRank($newStatus) < manifestStatusRank($currentStatus)
            ) {
                error_log("saveManifest: blocked status regression from '{$currentStatus}' to '{$newStatus}' in {$manifestPath}");
                $data['status'] = $currentStatus;  // silently restore the protected status
            }
        }

        $projectDir = dirname($manifestPath);
        $backupDir = $projectDir . '/manifest_backups/';
        
        if (!file_exists($backupDir)) {
            @mkdir($backupDir, 0777, true);
        }
        
        $timestamp = date('Y-m-d_H-i-s');
        $backupPath = $backupDir . 'manifest_' . $timestamp . '.json';
        
        // Only backup if we haven't already backed up this exact second
        // (prevents duplicate backups from rapid saves)
        if (!file_exists($backupPath)) {
            @copy($manifestPath, $backupPath);
        }
        
        // Optional: prune old backups (keep last 50)
        $backups = glob($backupDir . 'manifest_*.json');
        if ($backups && count($backups) > 50) {
            usort($backups, function($a, $b) {
                return filemtime($a) - filemtime($b);
            });
            $toDelete = array_slice($backups, 0, count($backups) - 50);
            foreach ($toDelete as $old) {
                @unlink($old);
            }
        }
    }
//     return file_put_contents($manifestPath, json_encode($data, JSON_PRETTY_PRINT));
    $bytes = file_put_contents($manifestPath, json_encode($data, JSON_PRETTY_PRINT));
    if ($bytes !== false && function_exists('pj_upsert_from_manifest')) {
        $targetDir = rtrim(dirname($manifestPath), '/\\') . '/';
        // Only index real projects (under baseDir), not tutorials
        $tutorialDir = $GLOBALS['tutorialDir'] ?? null;
        $realTarget = realpath($targetDir) ?: $targetDir;
        $isTutorial = ($tutorialDir && strpos($realTarget, rtrim((string)$tutorialDir, '/\\')) === 0);
        if (!$isTutorial) {
            pj_upsert_from_manifest($targetDir, is_array($data) ? $data : []);
        }
    }
    return $bytes;    
}

function migrateSingleProjectAppMetadata($targetDir) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $manifestPath = $targetDir . 'manifest.json';
    $appMetaPath  = $targetDir . 'app_metadata.json';

    // Already migrated — separate file exists
    if (file_exists($appMetaPath)) {
        // Even if separate file exists, clean the manifest if it still has the old key
        if (file_exists($manifestPath)) {
            $m = json_decode(@file_get_contents($manifestPath), true);
            if (is_array($m) && isset($m['app_metadata'])) {
                unset($m['app_metadata']);
                saveManifest($manifestPath, $m);
                return ['migrated' => true, 'skipped' => false, 'error' => null, 'note' => 'cleaned_manifest_only'];
            }
        }
        return ['migrated' => false, 'skipped' => true, 'error' => null];
    }

    // No manifest at all
    if (!file_exists($manifestPath)) {
        return ['migrated' => false, 'skipped' => true, 'error' => 'no_manifest'];
    }

    $m = json_decode(@file_get_contents($manifestPath), true);
    if (!is_array($m)) {
        return ['migrated' => false, 'skipped' => false, 'error' => 'bad_manifest_json'];
    }

    // Nothing to migrate
    if (!isset($m['app_metadata']) || !is_array($m['app_metadata']) || empty($m['app_metadata'])) {
        return ['migrated' => false, 'skipped' => true, 'error' => null];
    }

    // Write the separate file
    $appMeta = $m['app_metadata'];
    $bytes = @file_put_contents($appMetaPath, json_encode($appMeta, JSON_PRETTY_PRINT));
    if ($bytes === false) {
        return ['migrated' => false, 'skipped' => false, 'error' => 'write_failed'];
    }

    // Strip from manifest and re-save
    unset($m['app_metadata']);
    saveManifest($manifestPath, $m);

    return ['migrated' => true, 'skipped' => false, 'error' => null];
}

/**
 * Determine whether a new project for $orgId should be auto-VIP.
 * The first 5 non-filler projects from any organization are VIP.
 *
 * @param  string|null $orgId  Normalized org ID
 * @return bool
 */
function projectShouldAutoVip($orgId) {
    $orgId = orgNormalizeId($orgId ?? '');
    if ($orgId === '') return false;

    // Don't auto-VIP for test organizations
    if (function_exists('orgRead')) {
        $org = orgRead($orgId);
        if ($org && !empty($org['is_test'])) return false;
    }

    $threshold = 5;

    if (function_exists('pj_db')) {
        $db = pj_db();
        $stmt = $db->prepare("
            SELECT COUNT(*) AS cnt
            FROM p
            WHERE org = :org AND fl = 0
        ");
        $stmt->bindValue(':org', $orgId, SQLITE3_TEXT);
        $res = $stmt->execute();
        $row = $res->fetchArray(SQLITE3_ASSOC);
        $res->finalize();
        return ((int)($row['cnt'] ?? 0)) < $threshold;
    }

    // Fallback: scan baseDir manifests (slow, but safe)
    $baseDir = $GLOBALS['baseDir'] ?? '';
    if ($baseDir === '' || !is_dir($baseDir)) return false;
    $count = 0;
    foreach (scandir($baseDir) as $f) {
        if ($f === '.' || $f === '..') continue;
        $mp = $baseDir . $f . '/manifest.json';
        if (!file_exists($mp)) continue;
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) continue;
        if (!empty($m['is_filler'])) continue;
        if (orgNormalizeId($m['organization_id'] ?? '') === $orgId) {
            $count++;
            if ($count >= $threshold) return false;
        }
    }
    return true;
}

/**
 * Migrate ALL projects in the base saves directory.
 *
 * Scans $baseDir for project folders containing manifest.json,
 * and runs migrateSingleProjectAppMetadata on each.
 *
 * @param string|null $overrideBaseDir  Optional override (defaults to global $baseDir)
 * @return array  Summary stats + per-project results
 */
function migrateAllAppMetadata($overrideBaseDir = null) {
    $baseDir = $overrideBaseDir ?: ($GLOBALS['baseDir'] ?? null);
    if (!$baseDir || !is_dir($baseDir)) {
        return ['success' => false, 'error' => 'invalid_base_dir'];
    }

    $baseDir = rtrim($baseDir, '/\\') . '/';

    $stats = [
        'total'    => 0,
        'migrated' => 0,
        'skipped'  => 0,
        'errors'   => 0,
        'cleaned'  => 0,
    ];
    $details = [];

    $entries = @scandir($baseDir);
    if (!$entries) {
        return ['success' => false, 'error' => 'scandir_failed'];
    }

    foreach ($entries as $folder) {
        if ($folder === '.' || $folder === '..') continue;
        $targetDir = $baseDir . $folder . '/';
        if (!is_dir($targetDir)) continue;
        if (!file_exists($targetDir . 'manifest.json')) continue;

        $stats['total']++;
        $result = migrateSingleProjectAppMetadata($targetDir);

        if (!empty($result['migrated'])) {
            $stats['migrated']++;
            if (($result['note'] ?? '') === 'cleaned_manifest_only') {
                $stats['cleaned']++;
            }
        }
        if (!empty($result['skipped'])) {
            $stats['skipped']++;
        }
        if (!empty($result['error'])) {
            $stats['errors']++;
            $details[] = ['folder' => $folder, 'error' => $result['error']];
        }
    }

    return [
        'success' => true,
        'stats'   => $stats,
        'errors'  => $details,
    ];
}

function handleMigrateAppMetadata() {
    if (!isAdmin()) {
        return json_encode(['success' => false, 'error' => 'Unauthorized']);
    }

    $result = migrateAllAppMetadata();
    return json_encode($result);
}

function maybeSpawnFillerProjects() {
    error_log('auto-filler: entered maybeSpawnFillerProjects');

    // ---- 1. Feature gate ----
    if (!serverConfigGet('auto_filler_enabled', false)) {
        error_log('auto-filler: disabled in config, exiting');
        return;
    }

    $minQueue = (int) serverConfigGet('auto_filler_min_queue', 2);
    if ($minQueue < 1) $minQueue = 1;

    // ---- 2. Count unstarted projects currently in queue ----
    if (!function_exists('pj_db')) return;
    $db = pj_db();

    $stmt = $db->prepare("
        SELECT COUNT(*) AS cnt
        FROM p
        WHERE st IN ('queued','ready')
          AND (sa IS NULL OR sa = 0)
    ");
    $res  = $stmt->execute();
    $row  = $res->fetchArray(SQLITE3_ASSOC);
    $res->finalize();
    $existingCount = (int) ($row['cnt'] ?? 0);

    // Fast exit – queue is healthy
    if ($existingCount >= $minQueue) {
        error_log("auto-filler: queue healthy ({$existingCount} >= {$minQueue}), skipping");
        _fillerCleanStalePending();
        return;
    }
    error_log("auto-filler: queue low ({$existingCount} < {$minQueue}), will attempt spawn");

    $baseDir = $GLOBALS['baseDir'] ?? '';
    if ($baseDir === '') return;

    // ---- 3. Atomically determine how many to spawn & register them ----
    //
    // We hold the config lock for just this planning phase so that
    // concurrent requests cannot over-count.
    $toGenerate = withConfigLock(function () use ($existingCount, $minQueue, $baseDir) {

        $data = serverConfigReadRaw();
        $pending = $data['settings']['auto_filler_pending'] ?? [];
        if (!is_array($pending)) $pending = [];

        // --- 3a. Clean stale / completed entries ---
        $staleTs  = time() - 600;          // 10 min timeout
        $cleaned  = [];
        foreach ($pending as $pf) {
            if (!is_array($pf)) continue;
            $folder = (string) ($pf['folder'] ?? '');
            if ($folder === '') continue;

            // Drop entries older than the stale window
            $created = strtotime($pf['created_at'] ?? '');
            if ($created && $created < $staleTs) continue;

            // If the manifest status is no longer generating_filler it finished
            $td = rtrim($baseDir, '/\\') . '/' . $folder . '/';
            $mp = $td . 'manifest.json';
            if (!file_exists($mp)) continue;
            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) continue;
            if (($m['status'] ?? '') !== 'generating_filler') continue;

            $cleaned[] = $pf;
        }

        $pendingCount = count($cleaned);
        $total    = $existingCount + $pendingCount;
        $maxTotal = $minQueue;               // the invariant cap
        $toSpawn  = max(0, $maxTotal - $total);

        if ($toSpawn <= 0) {
            // Nothing to spawn – just persist the cleaned list
            $data['settings']['auto_filler_pending'] = $cleaned;
            serverConfigWriteRaw($data);
            return [];
        }

        // --- 3b. Pick random addresses and register manifests ---
        $addressesPath = storageExistingPath('data/addresses.json', __DIR__ . '/addresses.json', true);
        if (!file_exists($addressesPath)) {
            error_log('maybeSpawnFillerProjects: addresses.json not found');
            $data['settings']['auto_filler_pending'] = $cleaned;
            serverConfigWriteRaw($data);
            return [];
        }
        $addresses = json_decode(@file_get_contents($addressesPath), true);
        if (!is_array($addresses) || empty($addresses)) {
            error_log('maybeSpawnFillerProjects: addresses.json empty or invalid');
            $data['settings']['auto_filler_pending'] = $cleaned;
            serverConfigWriteRaw($data);
            return [];
        }

        $newEntries = [];

        for ($i = 0; $i < $toSpawn; $i++) {
            // Try to find an address that doesn't already have a project
            $address   = null;
            $folder    = null;
            $targetDir = null;

            for ($attempt = 0; $attempt < 100; $attempt++) {
                $candidate = $addresses[array_rand($addresses)];
                $f  = getFolder($candidate);
                $td = rtrim($baseDir, '/\\') . '/' . $f . '/';

                if (file_exists($td . 'manifest.json')) continue;

                // Also make sure we haven't just picked it in this batch
                // or it's already in the pending list
                $dup = false;
                foreach ($cleaned as $c) {
                    if (($c['folder'] ?? '') === $f) { $dup = true; break; }
                }
                if (!$dup) {
                    foreach ($newEntries as $ne) {
                        if (($ne['folder'] ?? '') === $f) { $dup = true; break; }
                    }
                }
                if ($dup) continue;

                $address   = $candidate;
                $folder    = $f;
                $targetDir = $td;
                break;
            }

            if ($address === null) {
                // Couldn't find an unused address after 30 tries – stop
                break;
            }

            // Create directory + seed manifest so other requests see it
            if (!file_exists($targetDir)) @mkdir($targetDir, 0777, true);

            $now      = date('Y-m-d H:i:s');
            $manifest = [
                'id'         => $folder,
                'owner_email'=> 'system',
                'address'    => $address,
                'components' => [],
                'created_at' => $now,
                'queued_at'  => $now,
                'is_filler'  => true,
                'team_id'    => 'default',
                'resident'   => ['name' => 'Filler', 'email' => '', 'phone' => ''],
                'issuer'     => ['name' => 'System', 'email' => 'system@1m8.ai'],
                'status'     => 'generating_filler',
                'project_type' => 'residential',
                'pins'         => [],
                'cc_emails'    => [],
            ];
            saveManifest($targetDir . 'manifest.json', $manifest);

            $entry = [
                'folder'     => $folder,
                'address'    => $address,
                'created_at' => $now,
            ];
            $cleaned[]    = $entry;
            $newEntries[] = $entry;
        }

        // Persist the updated pending list
        $data['settings']['auto_filler_pending'] = $cleaned;
        serverConfigWriteRaw($data);

        return $newEntries;
    });

    if (!is_array($toGenerate) || empty($toGenerate)) {
        error_log('auto-filler: nothing to generate (lock returned empty)');
        return;
    }
    error_log('auto-filler: generating ' . count($toGenerate) . ' filler project(s)');


    // ---- 4. Process each filler project (outside the lock, slow) ----
    $GOOGLE_API_KEY = $GLOBALS['GOOGLE_API_KEY'] ?? '';
    $GEMINI_API_KEY = $GLOBALS['GEMINI_API_KEY'] ?? '';

    foreach ($toGenerate as $item) {
        $folder    = (string) ($item['folder'] ?? '');
        $address   = (string) ($item['address'] ?? '');
        $targetDir = rtrim($baseDir, '/\\') . '/' . $folder . '/';

        if ($folder === '' || $address === '') continue;

        // processProjectApis will set status → 'ready' and save the manifest.
        // is_filler is preserved because processProjectApis only touches
        // specific keys and never unsets is_filler.
        processProjectApis($targetDir, $address, $GOOGLE_API_KEY, $GEMINI_API_KEY);

        // Remove this entry from the pending list (atomic)
        _fillerRemovePending($folder);
    }
}

// ------------------------------------------------
// --------------- INTERNAL HELPERS ---------------
// ------------------------------------------------

function haversineMeters($lat1, $lng1, $lat2, $lng2) {
    $R = 6371000;
    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);
    $a = sin($dLat / 2) * sin($dLat / 2)
       + cos(deg2rad($lat1)) * cos(deg2rad($lat2))
       * sin($dLng / 2) * sin($dLng / 2);
    $c = 2 * atan2(sqrt($a), sqrt(1 - $a));
    return $R * $c;
}

/**
 * Call Google Solar buildingInsights:findClosest for a single point.
 * Returns the bounding box corners as an array of ['lat','lng'], or null if unavailable.
 *
 * @param  float  $lat
 * @param  float  $lng
 * @param  string $apiKey
 * @return array|null  Array of 4 corner points [['lat'=>…,'lng'=>…], ...] or null
 */
function fetchBuildingBoundingBox($lat, $lng, $apiKey) {
    $url = "https://solar.googleapis.com/v1/buildingInsights:findClosest"
         . "?location.latitude=" . urlencode($lat)
         . "&location.longitude=" . urlencode($lng)
         . "&requiredQuality=LOW"
         . "&key=" . urlencode($apiKey);

    $json = fetchUrl($url);
    if (!$json) return null;

    $data = json_decode($json, true);
    if (!is_array($data)) return null;

    $bb = $data['boundingBox'] ?? null;
    if (!is_array($bb)) return null;

    $sw = $bb['sw'] ?? null;
    $ne = $bb['ne'] ?? null;
    if (!is_array($sw) || !is_array($ne)) return null;

    $swLat = $sw['latitude'] ?? null;
    $swLng = $sw['longitude'] ?? null;
    $neLat = $ne['latitude'] ?? null;
    $neLng = $ne['longitude'] ?? null;

    if ($swLat === null || $swLng === null || $neLat === null || $neLng === null) return null;

    // Building center from the API (more accurate than bbox midpoint)
    $buildingCenter = null;
    $apiCenter = $data['center'] ?? null;
    if (is_array($apiCenter) && isset($apiCenter['latitude'], $apiCenter['longitude'])) {
        $buildingCenter = [
            'lat' => (float)$apiCenter['latitude'],
            'lng' => (float)$apiCenter['longitude'],
        ];
    }

    return [
        'corners' => [
            ['lat' => (float)$swLat, 'lng' => (float)$swLng],
            ['lat' => (float)$swLat, 'lng' => (float)$neLng],
            ['lat' => (float)$neLat, 'lng' => (float)$neLng],
            ['lat' => (float)$neLat, 'lng' => (float)$swLng],
        ],
        'center' => $buildingCenter,
    ];
}

/**
 * Compute the centroid lat/lng and a dynamic Solar-API radius from structure pins.
 *
 * - 0 pins  → returns nulls + default radius 60  (legacy behaviour)
 * - 1 pin   → that pin's coords, radius 30
 * - 2+ pins → centroid of all pins,
 *             radius = 30 + max distance between any two pins (the "diameter")
 *
 * @param  array $pins  Array of ['lat'=>…,'lng'=>…] entries
 * @return array        ['lat'=>float|null, 'lng'=>float|null, 'radius'=>int]
 */
function computePinGeometry($pins) {
    if (!is_array($pins) || empty($pins)) {
        return ['lat' => null, 'lng' => null, 'radius' => 60];
    }

    if (count($pins) === 1) {
        return [
            'lat'    => (float)$pins[0]['lat'],
            'lng'    => (float)$pins[0]['lng'],
            'radius' => 30,
        ];
    }

    // --- Centroid ---
    $sumLat = 0.0;
    $sumLng = 0.0;
    $n = count($pins);
    foreach ($pins as $p) {
        $sumLat += (float)$p['lat'];
        $sumLng += (float)$p['lng'];
    }
    $centerLat = $sumLat / $n;
    $centerLng = $sumLng / $n;

    // --- Diameter: max pairwise distance ---
    $maxDist = 0.0;
    for ($i = 0; $i < $n; $i++) {
        for ($j = $i + 1; $j < $n; $j++) {
            $d = haversineMeters(
                (float)$pins[$i]['lat'], (float)$pins[$i]['lng'],
                (float)$pins[$j]['lat'], (float)$pins[$j]['lng']
            );
            if ($d > $maxDist) $maxDist = $d;
        }
    }

    // radius = 30m padding + full pin spread
    $radius = (int)ceil(30 + $maxDist);

    return [
        'lat'    => $centerLat,
        'lng'    => $centerLng,
        'radius' => max(30, $radius),
    ];
}

function computeProjectGeometry($pins, $apiKey, $fallbackLat = null, $fallbackLng = null) {
    $DEFAULT_NO_BBOX_RADIUS = 20;
    $PADDING = 5;
    $MIN_RADIUS = 30;

    // --- 0 pins or 1 pin: use building center ONLY if pin falls within the structure bbox ---
    if (!is_array($pins) || count($pins) <= 1) {
        $queryLat = $fallbackLat;
        $queryLng = $fallbackLng;

        if (($queryLat === null || $queryLng === null) && is_array($pins) && count($pins) === 1) {
            $queryLat = (float)$pins[0]['lat'];
            $queryLng = (float)$pins[0]['lng'];
        }

        if ($queryLat === null || $queryLng === null) {
            return ['lat' => null, 'lng' => null, 'radius' => 60];
        }

        $bbox = fetchBuildingBoundingBox($queryLat, $queryLng, $apiKey);

        if ($bbox === null) {
            // No Solar data — use pin as center with a default radius
            return ['lat' => $queryLat, 'lng' => $queryLng, 'radius' => max($MIN_RADIUS, $DEFAULT_NO_BBOX_RADIUS + $PADDING)];
        }

        // Check if the pin actually falls within the returned building's bounding box.
        // The Solar API returns the *closest* structure, which may be a neighboring
        // building — we only snap to its center if the pin is on it.
        $bboxMinLat = min($bbox['corners'][0]['lat'], $bbox['corners'][2]['lat']);
        $bboxMaxLat = max($bbox['corners'][0]['lat'], $bbox['corners'][2]['lat']);
        $bboxMinLng = min($bbox['corners'][0]['lng'], $bbox['corners'][2]['lng']);
        $bboxMaxLng = max($bbox['corners'][0]['lng'], $bbox['corners'][2]['lng']);

        $pinInsideBbox = ($queryLat >= $bboxMinLat && $queryLat <= $bboxMaxLat
                       && $queryLng >= $bboxMinLng && $queryLng <= $bboxMaxLng);

        if ($pinInsideBbox && $bbox['center']) {
            // Pin is on this structure — use the building center
            $centerLat = $bbox['center']['lat'];
            $centerLng = $bbox['center']['lng'];
        } else {
            // Pin is NOT on the returned structure — stay centered on the pin
            $centerLat = $queryLat;
            $centerLng = $queryLng;
        }

        // Radius = distance from center to farthest bbox corner + padding
        $maxDist = 0.0;
        foreach ($bbox['corners'] as $c) {
            $d = haversineMeters($centerLat, $centerLng, $c['lat'], $c['lng']);
            if ($d > $maxDist) $maxDist = $d;
        }

        $radius = (int)ceil($maxDist + $PADDING);
        return [
            'lat'    => $centerLat,
            'lng'    => $centerLng,
            'radius' => max($MIN_RADIUS, $radius),
        ];
    }

    // --- 2+ pins: centroid of all pins ---
    $n = count($pins);
    $sumLat = 0.0;
    $sumLng = 0.0;
    foreach ($pins as $p) {
        $sumLat += (float)$p['lat'];
        $sumLng += (float)$p['lng'];
    }
    $centerLat = $sumLat / $n;
    $centerLng = $sumLng / $n;

    $allPoints = [];
    $missRadii = [];

    foreach ($pins as $p) {
        $pLat = (float)$p['lat'];
        $pLng = (float)$p['lng'];

        $bbox = fetchBuildingBoundingBox($pLat, $pLng, $apiKey);

        if ($bbox !== null) {
            foreach ($bbox['corners'] as $c) {
                $allPoints[] = $c;
            }
        } else {
            $allPoints[] = ['lat' => $pLat, 'lng' => $pLng];
            $missRadii[] = [
                'lat' => $pLat,
                'lng' => $pLng,
                'extra' => $DEFAULT_NO_BBOX_RADIUS,
            ];
        }
    }

    $maxDist = 0.0;
    foreach ($allPoints as $pt) {
        $d = haversineMeters($centerLat, $centerLng, $pt['lat'], $pt['lng']);
        if ($d > $maxDist) $maxDist = $d;
    }

    foreach ($missRadii as $mr) {
        $d = haversineMeters($centerLat, $centerLng, $mr['lat'], $mr['lng']) + $mr['extra'];
        if ($d > $maxDist) $maxDist = $d;
    }

    $radius = (int)ceil($maxDist + $PADDING);

    return [
        'lat'    => $centerLat,
        'lng'    => $centerLng,
        'radius' => max($MIN_RADIUS, $radius),
    ];
}



/**
 * Remove a single folder from the auto_filler_pending list.
 */
function _fillerRemovePending($folder) {
    withConfigLock(function () use ($folder) {
        $data    = serverConfigReadRaw();
        $pending = $data['settings']['auto_filler_pending'] ?? [];
        if (!is_array($pending)) $pending = [];

        $data['settings']['auto_filler_pending'] = array_values(
            array_filter($pending, function ($pf) use ($folder) {
                return ($pf['folder'] ?? '') !== $folder;
            })
        );
        serverConfigWriteRaw($data);
    });
}

/**
 * Housekeeping: clean stale entries even when no spawn is needed.
 * Called on the fast-exit path so the list stays tidy.
 */
function _fillerCleanStalePending() {
    $pending = serverConfigGet('auto_filler_pending', []);
    if (!is_array($pending) || empty($pending)) return;

    $baseDir  = $GLOBALS['baseDir'] ?? '';
    $staleTs  = time() - 600;
    $changed  = false;
    $cleaned  = [];

    foreach ($pending as $pf) {
        if (!is_array($pf)) { $changed = true; continue; }
        $folder = (string) ($pf['folder'] ?? '');
        if ($folder === '') { $changed = true; continue; }

        $created = strtotime($pf['created_at'] ?? '');
        if ($created && $created < $staleTs) { $changed = true; continue; }

        $td = rtrim($baseDir, '/\\') . '/' . $folder . '/';
        $mp = $td . 'manifest.json';
        if (!file_exists($mp)) { $changed = true; continue; }
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m) || ($m['status'] ?? '') !== 'generating_filler') {
            $changed = true;
            continue;
        }

        $cleaned[] = $pf;
    }

    if ($changed) {
        serverConfigSet('auto_filler_pending', $cleaned);
    }
}

/**
 * Flush the current output buffer and close the connection to the client.
 *
 * After calling this, the client has received the full response and the
 * PHP process can continue running background work (filler generation).
 */
function flushResponseAndClose() {
    $size = ob_get_length();
    if ($size !== false) {
        header("Content-Length: {$size}");
    }
    header('Connection: close');
    ob_end_flush();
    @ob_flush();
    flush();
    if (session_id()) session_write_close();
}

// ------------------------------------------------
// ---------------- ONLINE STATUS HELPERS ---------
// ------------------------------------------------
/**
 * Determine if a user is currently "online" / available.
 * 
 * This is a placeholder implementation that can be updated later
 * to use more sophisticated checks (WebSocket presence, session heartbeat, etc.)
 * 
 * Current implementation: Check if user has activity in the last N minutes
 * based on their last_activity timestamp in user data.
 * 
 * @param string $email User email to check
 * @param int $thresholdMinutes Consider offline after this many minutes of inactivity
 * @return bool True if user is considered online
 */

function isUserOnline($email, $thresholdMinutes = 30) {
    global $userDir;
    
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    
    // Read user data
    $userData = readUserDataByEmail($email);
    if (!$userData) return false;
    
    // Check if user is explicitly marked as offline/unavailable
    if (!empty($userData['is_offline'])) return false;
    if (!empty($userData['availability_status']) && $userData['availability_status'] === 'offline') return false;
    
    // Check last activity timestamp
    $lastActivity = $userData['last_activity_at'] ?? null;
    if (!$lastActivity) {
        // No activity recorded - check last_login as fallback
        $lastActivity = $userData['last_login_at'] ?? $userData['last_login'] ?? null;
    }
    
    if (!$lastActivity) {
        // No activity data available - assume online if user exists
        // This is a safe default until activity tracking is fully implemented
        return true;
    }
    
    $lastActivityTs = safeParseTs($lastActivity);
    if ($lastActivityTs <= 0) return true; // Invalid timestamp, assume online
    
    $thresholdSeconds = $thresholdMinutes * 60;
    $cutoff = time() - $thresholdSeconds;
    
    return ($lastActivityTs >= $cutoff);
}

/**
 * Update user's last activity timestamp.
 * Call this on meaningful user actions to keep their "online" status fresh.
 */
function updateUserActivity($email) {
    global $userDir;
    
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;
    
    $userFile = $userDir . getUserFilename($email);
    if (!file_exists($userFile)) return false;
    
    $userData = json_decode(@file_get_contents($userFile), true);
    if (!is_array($userData)) return false;
    
    $userData['last_activity_at'] = date('c');
    
    return (bool)@file_put_contents($userFile, json_encode($userData, JSON_PRETTY_PRINT));
}

/**
 * Check if a claimed/assigned user is available, with offline fallback.
 * Returns the email to use - either the original or null if should be released.
 * 
 * @param string $claimedEmail The email of the user who claimed/is assigned
 * @param int $offlineThresholdMinutes Minutes of inactivity before considering offline
 * @return array ['available' => bool, 'email' => string|null, 'reason' => string]
 */
function checkClaimAvailability($claimedEmail, $offlineThresholdMinutes = 30) {
    $claimedEmail = strtolower(trim((string)$claimedEmail));
    
    if ($claimedEmail === '') {
        return ['available' => false, 'email' => null, 'reason' => 'no_claim'];
    }
    
    if (isUserOnline($claimedEmail, $offlineThresholdMinutes)) {
        return ['available' => true, 'email' => $claimedEmail, 'reason' => 'online'];
    }
    
    return ['available' => false, 'email' => $claimedEmail, 'reason' => 'offline'];
}

// Atomic lock helper for queue operations
function withQueueLock($fn) {
    $lockFile = storagePath('locks/queue.lock', true);
    $fh = fopen($lockFile, 'c+');
    if (!$fh) return $fn();
    try {
        flock($fh, LOCK_EX);
        $out = $fn();
        flock($fh, LOCK_UN);
        fclose($fh);
        return $out;
    } catch (Exception $e) {
        try { flock($fh, LOCK_UN); fclose($fh); } catch (Exception $e2) {}
        return null;
    }
}
// ------------------------------------------------
// ---------------- FILE SYSTEM HELPERS ----------
// ------------------------------------------------
function recurseCopy($src, $dst) {
    $dir = opendir($src);
    @mkdir($dst, 0777, true);
    while(false !== ($file = readdir($dir))) {
        if ($file === '.' || $file === '..') continue;
        if (is_dir($src . '/' . $file)) {
            recurseCopy($src . '/' . $file, $dst . '/' . $file);
        } else {
            @copy($src . '/' . $file, $dst . '/' . $file);
        }
    }
    closedir($dir);
}

function locateProjectDir($folderId) {
    global $baseDir, $tutorialDir;
    if (is_dir($baseDir . $folderId)) return $baseDir . $folderId . '/';
    if (is_dir($tutorialDir . 'master/' . $folderId)) return $tutorialDir . 'master/' . $folderId . '/';
    $users = scandir($tutorialDir);
    foreach($users as $u) {
        if($u === '.' || $u === '..' || $u === 'master') continue;
        if(is_dir($tutorialDir . $u . '/' . $folderId)) {
            return $tutorialDir . $u . '/' . $folderId . '/';
        }
    }
    return false;
}

// ------------------------------------------------
// ---------------- MANIFEST HELPERS -------------
// ------------------------------------------------
function manifestEnsureWorkHistory(&$m) {
    if (!is_array($m)) $m = [];
    if (!isset($m['work_history']) || !is_array($m['work_history'])) $m['work_history'] = [];
}

function manifestAttemptedByEmails($m) {
    $emails = [];
    if (!is_array($m)) return $emails;
    // current/last assignment
    if (!empty($m['assigned_to_email'])) $emails[] = strtolower(trim((string)$m['assigned_to_email']));
    // historical attempts
    if (!empty($m['work_history']) && is_array($m['work_history'])) {
        foreach ($m['work_history'] as $h) {
            if (is_array($h) && !empty($h['worker_email'])) {
                $emails[] = strtolower(trim((string)$h['worker_email']));
            }
        }
    }
    // unique
    $emails = array_values(array_unique(array_filter($emails)));
    return $emails;
}

// ------------------------------------------------
// ---------------- QA CLAIM HELPERS -------------
// ------------------------------------------------
/**
 * Check if a QA item is available to a specific QA user.
 * 
 * Rules:
 * 1. If not claimed by anyone, it's available to all QA users
 * 2. If claimed by the current user, it's available
 * 3. If claimed by another user who is ONLINE, it's NOT available
 * 4. If claimed by another user who is OFFLINE, it's available (released)
 * 
 * @param array $manifest The project manifest
 * @param string $currentQaEmail The email of the QA user checking availability
 * @param int $offlineThresholdMinutes Minutes before considering a user offline
 * @return array ['available' => bool, 'reason' => string, 'claimed_by' => string|null]
 */
function isQaItemAvailableToUser($manifest, $currentQaEmail, $offlineThresholdMinutes = 30) {
    $currentQaEmail = strtolower(trim((string)$currentQaEmail));
    
    $claimedByEmail = strtolower(trim((string)($manifest['qa_claimed_by_email'] ?? '')));
    $claimedByName = $manifest['qa_claimed_by_name'] ?? null;
    
    // Not claimed - available to anyone
    if ($claimedByEmail === '') {
        return [
            'available' => true,
            'reason' => 'unclaimed',
            'claimed_by' => null,
            'claimed_by_name' => null
        ];
    }
    
    // Claimed by current user - available
    if ($claimedByEmail === $currentQaEmail) {
        return [
            'available' => true,
            'reason' => 'own_claim',
            'claimed_by' => $claimedByEmail,
            'claimed_by_name' => $claimedByName
        ];
    }
    
    // Claimed by someone else - check if they're online
    $claimStatus = checkClaimAvailability($claimedByEmail, $offlineThresholdMinutes);
    
    if ($claimStatus['available']) {
        // Claimer is online - NOT available to current user
        return [
            'available' => false,
            'reason' => 'claimed_by_online_user',
            'claimed_by' => $claimedByEmail,
            'claimed_by_name' => $claimedByName
        ];
    }
    
    // Claimer is offline - release to current user
    return [
        'available' => true,
        'reason' => 'claimer_offline',
        'claimed_by' => $claimedByEmail,
        'claimed_by_name' => $claimedByName,
        'original_claimer_offline' => true
    ];
}

/**
 * Claim a QA item for a specific QA user.
 * 
 * @param string $targetDir The project directory
 * @param array &$manifest The project manifest (will be modified)
 * @param string $qaEmail The email of the QA user claiming
 * @param string $qaName The name of the QA user claiming
 * @return bool Success
 */
function claimQaItem($targetDir, &$manifest, $qaEmail, $qaName) {
    $qaEmail = strtolower(trim((string)$qaEmail));
    $qaName = trim((string)$qaName);
    
    if ($qaEmail === '') return false;
    
    $now = date('Y-m-d H:i:s');
    
    $manifest['qa_claimed_by_email'] = $qaEmail;
    $manifest['qa_claimed_by_name'] = $qaName ?: $qaEmail;
    $manifest['qa_claimed_at'] = $now;
    
    manifestEnsureWorkHistory($manifest);
    $manifest['work_history'][] = [
        'ts' => date('c'),
        'event' => 'qa_claimed',
        'qa_email' => $qaEmail,
        'qa_name' => $qaName ?: $qaEmail,
    ];
    
    return true;
}

/**
 * Release a QA claim (used when explicitly releasing or when reassigning)
 */
function releaseQaClaim(&$manifest, $releasedBy = null, $reason = 'manual') {
    $previousClaimer = $manifest['qa_claimed_by_email'] ?? null;
    
    unset($manifest['qa_claimed_by_email']);
    unset($manifest['qa_claimed_by_name']);
    unset($manifest['qa_claimed_at']);
    
    if ($previousClaimer) {
        manifestEnsureWorkHistory($manifest);
        $manifest['work_history'][] = [
            'ts' => date('c'),
            'event' => 'qa_claim_released',
            'previous_claimer' => $previousClaimer,
            'released_by' => $releasedBy,
            'reason' => $reason,
        ];
    }
}

// ------------------------------------------------
// ---------------- PROJECT EMAIL TRACKING --------
// ------------------------------------------------
function manifestEnsureEmailTracking(&$m) {
    if (!is_array($m)) $m = [];
    if (!isset($m['email_state']) || !is_array($m['email_state'])) $m['email_state'] = [];
    if (!isset($m['email_events']) || !is_array($m['email_events'])) $m['email_events'] = [];
}
function manifestLogEmailEvent(&$m, $type, $to, $subject, $ret, $meta = []) {
    manifestEnsureEmailTracking($m);
    $ok = !empty($ret['ok']);
    $http = $ret['http'] ?? null;
    $postmark = $ret['postmark'] ?? null;
    $ev = [
        'ts_utc'   => gmdate('c'),
        'type'     => (string)$type,
        'to'       => (string)$to,
        'subject'  => (string)$subject,
        'ok'       => $ok,
        'http'     => $http,
        'meta'     => is_array($meta) ? $meta : [],
        // store the raw response for forensic debugging
        'postmark' => $postmark,
    ];
    $m['email_events'][] = $ev;
    // Maintain a per-type summary for quick UI
    $st = $m['email_state'][$type] ?? [];
    if (!is_array($st)) $st = [];
    $st['type'] = (string)$type;
    $st['last_attempt_utc'] = $ev['ts_utc'];
    $st['last_ok'] = $ok;
    $st['last_http'] = $http;
    $st['last_to'] = (string)$to;
    $st['last_subject'] = (string)$subject;
    $st['attempts'] = (int)($st['attempts'] ?? 0) + 1;
    if ($ok) {
        $st['sent_ok'] = true;
        $st['sent_at_utc'] = $ev['ts_utc'];
        // message id is usually in Postmark response fields, keep if present
        if (is_array($postmark)) {
            if (!empty($postmark['MessageID'])) $st['message_id'] = $postmark['MessageID'];
        }
    }
    // trim event list to keep manifests from growing forever
    $max = 200;
    if (count($m['email_events']) > $max) {
        $m['email_events'] = array_slice($m['email_events'], -$max);
    }
    $m['email_state'][$type] = $st;
}
function projectGetEmailSummary($m) {
    $sum = [
        'report_email' => [
            'sent_ok' => false,
            'sent_at_utc' => null,
            'attempts' => 0,
            'last_ok' => false,
            'last_attempt_utc' => null,
            'last_http' => null,
            'last_to' => null,
            'message_id' => null,
        ],
    ];
    if (!is_array($m)) return $sum;
    if (!isset($m['email_state']) || !is_array($m['email_state'])) return $sum;
    if (isset($m['email_state']['report_email']) && is_array($m['email_state']['report_email'])) {
        $st = $m['email_state']['report_email'];
        foreach ($sum['report_email'] as $k => $_) {
            if (array_key_exists($k, $st)) $sum['report_email'][$k] = $st[$k];
        }
    }
    return $sum;
}
function sendProjectReportEmailAndTrack($targetDir, &$m, $opts = []) {
    $force = !empty($opts['force']);
    $by = (string)($opts['by'] ?? 'system');
    manifestEnsureEmailTracking($m);
    // Idempotency check
    $st = $m['email_state']['report_email'] ?? [];
    if (!$force && is_array($st) && !empty($st['sent_ok'])) {
        return ['ok'=>true, 'skipped'=>true, 'already_sent'=>true];
    }
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $addr = (string)($m['address'] ?? 'Unknown Address');
    
    // Sanitize Address for Filenames
    $safeAddr = preg_replace('/[^a-zA-Z0-9 \-]/', '', $addr);
    $safeAddr = trim(preg_replace('/\s+/', ' ', $safeAddr));
    if ($safeAddr === '') $safeAddr = 'Project';
    // ONLY send to the issuer
    $toIssuer = strtolower(trim((string)($m['issuer']['email'] ?? '')));
    
    $recipients = [];
    if ($toIssuer !== '') $recipients[] = $toIssuer;

    // Also include CC addresses from the manifest
    $ccEmails = $m['cc_emails'] ?? [];
    if (is_array($ccEmails)) {
        foreach ($ccEmails as $cc) {
            $cc = strtolower(trim((string)$cc));
            if ($cc !== '' && strpos($cc, '@') !== false && !in_array($cc, $recipients, true)) {
                $recipients[] = $cc;
            }
        }
    }

    if (empty($recipients)) {
        return ['ok'=>false, 'error'=>'missing_recipient'];
    }
    // --- Build Attachments ---
    $attachments = [];
    // 1. Full Report
    $fpReport = $targetDir . 'Report.pdf';
    if (file_exists($fpReport)) {
        $pdfBytes = @file_get_contents($fpReport);
        if ($pdfBytes !== false) {
            $attachments[] = [
                'Name' => "Report - " . $safeAddr . ".pdf",
                'Content' => base64_encode($pdfBytes),
                'ContentType' => 'application/pdf',
            ];
        }
    } else {
        // Fail if main report missing
        return ['ok'=>false, 'error'=>'missing_pdf'];
    }
    // 2. Summary Report (Optional)
    $fpSummary = $targetDir . 'Summary.pdf';
    if (file_exists($fpSummary)) {
        $sumBytes = @file_get_contents($fpSummary);
        if ($sumBytes !== false) {
            $attachments[] = [
                'Name' => "Summary - " . $safeAddr . ".pdf",
                'Content' => base64_encode($sumBytes),
                'ContentType' => 'application/pdf',
            ];
        }
    }
    // 3. XML Model (Optional)
    $xmlPath = $targetDir . 'model_data.xml';
    if (file_exists($xmlPath)) {
        $xmlBytes = @file_get_contents($xmlPath);
        if ($xmlBytes !== false) {
            $attachments[] = [
                'Name' => "Model - " . $safeAddr . ".xml",
                'Content' => base64_encode($xmlBytes),
                'ContentType' => 'text/xml',
            ];
        }
    }
    $subject = "Report Ready: " . $addr;
    $text = "Attached is your completed roof report.\n\nAddress: " . $addr . "\n";
    $allOk = true;
    $last = null;
    foreach ($recipients as $to) {
        $emailType = ($to === $toIssuer) ? 'report_email' : 'report_email_cc';
        $ret = postmarkSendEmail(
            $to,
            $subject,
            $text,
            null,
            ($GLOBALS['POSTMARK_DEFAULT_FROM'] ?? 'noreply@1m8.ai'),
            $GLOBALS['POSTMARK_DEFAULT_REPLYTO'] ?? null,
            $attachments
        );
        $last = $ret;
        manifestLogEmailEvent($m, $emailType, $to, $subject, $ret, [
            'by' => $by,
            'force' => $force,
            'folder' => (string)($m['id'] ?? ''),
            'is_cc' => ($to !== $toIssuer),
        ]);
        if (empty($ret['ok'])) {
            $allOk = false;
            error_log("Postmark report send failed to=$to folder=" . (string)($m['id'] ?? '') . " ret=" . json_encode($ret));
        }
    }
    return ['ok'=>$allOk, 'last'=>$last];
}
// ------------------------------------------------
// -------- ADMIN ALERT: MISSING HEIGHTMAP --------
// ------------------------------------------------
function adminMissingHeightmapMarkerPath($targetDir) {
    return rtrim((string)$targetDir, '/\\') . '/admin_missing_heightmap_notified.json';
}
function maybeNotifyAdminMissingHeightmap($targetDir, $folderId = null) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) return false;
    $m = json_decode(@file_get_contents($mp), true);
    if (!is_array($m)) $m = [];
    // Define "missing heightmap" consistently with your queue logic:
    // processed_at exists AND dsm.tif missing
    $processedAt = trim((string)($m['processed_at'] ?? ''));
    if ($processedAt === '') return false;
    $dsmPath = $targetDir . 'dsm.tif';
    if (file_exists($dsmPath)) return false;
    // De-dupe: only email once per job
    $marker = adminMissingHeightmapMarkerPath($targetDir);
    if (file_exists($marker)) return false;
    $folderId = $folderId ?: (string)($m['id'] ?? '');
    $addr = (string)($m['address'] ?? 'Unknown address');
    $lat  = $m['lat'] ?? null;
    $lng  = $m['lng'] ?? null;
    $to = 'jack@1m8.ai';
    $reviewUrl = $GLOBALS['BACKEND_URL'];
    $subject = "Missing heightmap: " . ($addr ?: 'New request') . ($folderId ? " ($folderId)" : "");
    $text =
"New request is missing a heightmap (dsm.tif).
Address: " . ($addr ?: '-') . "
Folder: " . ($folderId ?: '-') . "
Processed at: " . ($processedAt ?: '-') . "
Lat/Lng: " . (($lat !== null && $lng !== null) ? ($lat . ", " . $lng) : '-') . "
Review: $reviewUrl
";
    $html =
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; font-size:14px; line-height:1.45; color:#111;">' .
            '<p style="margin:0 0 10px;"><b>New request is missing a heightmap (dsm.tif).</b></p>' .
            '<div style="margin:0 0 14px; padding:12px 14px; border:1px solid #f4b4ae; background:#fce8e6; border-radius:12px;">' .
                '<div><b>Address:</b> ' . htmlspecialchars($addr ?: '-') . '</div>' .
                '<div><b>Folder:</b> ' . htmlspecialchars($folderId ?: '-') . '</div>' .
                '<div><b>Processed at:</b> ' . htmlspecialchars($processedAt ?: '-') . '</div>' .
                '<div><b>Lat/Lng:</b> ' . htmlspecialchars((($lat !== null && $lng !== null) ? ($lat . ', ' . $lng) : '-')) . '</div>' .
            '</div>' .
            '<a href="' . htmlspecialchars($reviewUrl) . '" ' .
               'style="display:inline-block; padding:10px 14px; background:#db0000; color:#fff; text-decoration:none; border-radius:10px; font-weight:700;">' .
               'Review job' .
            '</a>' .
        '</div>';
    $ret = postmarkSendEmail(
        $to,
        $subject,
        $text,
        $html,
        $GLOBALS['POSTMARK_DEFAULT_FROM'] ?? 'noreply@1m8.ai',
        $GLOBALS['POSTMARK_DEFAULT_REPLYTO'] ?? null
    );
    // Write marker no matter what, so you don't spam if Postmark is having a moment.
    @file_put_contents($marker, json_encode([
        'ts' => gmdate('c'),
        'folder' => $folderId ?: null,
        'address' => $addr ?: null,
        'processed_at' => $processedAt ?: null,
        'postmark_ok' => !empty($ret['ok']),
        'postmark_http' => $ret['http'] ?? null,
        'postmark' => $ret['postmark'] ?? null,
    ], JSON_PRETTY_PRINT));
    if (empty($ret['ok'])) {
        error_log("Admin missing heightmap email failed folder=$folderId ret=" . json_encode($ret));
        return false;
    }
    return true;
}
// ------------------------------------------------
// ------------- COVERAGE REJECTION HELPERS -------
// ------------------------------------------------
function coverageRejectionDisclaimerText($refundAmount = null) {
    $text =
"We do not currently have coverage for this address. We currently cover 95% of all buildings in the United States and we are actively working on increasing our area to cover more of the remaining buildings. We've logged your interest in structures like this and will prioritize being able to cover these in the near future.
Note: Our coverage is based on individual structure, not area - so we may have coverage for other properties in this same neighborhood.";

    if ($refundAmount !== null && (int)$refundAmount > 0) {
        $text .= "\n\nA credit of \$" . (int)$refundAmount . " has been refunded to your account for this order.";
    }

    return $text;
}

function coverageRejectionDisclaimerHtml($refundAmount = null) {
    $t1 = "We do not currently have coverage for this address. We currently cover <b>95%</b> of all buildings in the United States and we are actively working on increasing our area to cover more of the remaining buildings. We've logged your interest in structures like this and will prioritize being able to cover these in the near future.";
    $t2 = "<b>Note:</b> Our coverage is based on individual structure, not area - so we may have coverage for other properties in this same neighborhood.";

    $refundHtml = '';
    if ($refundAmount !== null && (int)$refundAmount > 0) {
        $refundHtml =
            '<p style="margin:12px 0 0; padding:10px 14px; background:#fce8e6; border:1px solid #f4b4ae; border-radius:8px; color:#7a1b18; font-weight:600;">' .
                'A credit of $' . (int)$refundAmount . ' has been refunded to your account for this order.' .
            '</p>';
    }

    return
        "<div style=\"font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 14px; line-height: 1.45; color:#111;\">" .
            "<p style=\"margin:0 0 12px;\">$t1</p>" .
            "<p style=\"margin:0; color:#333;\">$t2</p>" .
            $refundHtml .
        "</div>";
}

function rejectProjectNoCoverage($targetDir, &$manifest, $opts = []) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $mp = $targetDir . 'manifest.json';

    $byEmail    = strtolower(trim((string)($opts['by_email'] ?? '')));
    $byName     = trim((string)($opts['by_name'] ?? $byEmail));
    $note       = trim((string)($opts['note'] ?? ''));
    $reasons    = (array)($opts['reasons'] ?? []);
    $source     = (string)($opts['source'] ?? 'direct');
    $reviewNotes = trim((string)($opts['review_notes'] ?? ''));
    $now        = date('Y-m-d H:i:s');

    // ---- 1. Set status & rejection metadata ----
    $manifest['status']               = 'rejected_no_coverage';
    $manifest['rejected_at']          = $now;
    $manifest['rejected_by']          = $byEmail;
    $manifest['rejection_reason']     = 'no_coverage';
    $manifest['rejection_disclaimer'] = coverageRejectionDisclaimerText();

    if (!empty($reasons)) {
        $manifest['rejection_reason_details'] = array_values($reasons);
    }

    // Combine note + reasons into rejection_notes for display
    $combinedNotes = $note;
    if ($combinedNotes === '' && !empty($reasons)) {
        $combinedNotes = implode('; ', $reasons);
    }
    $manifest['rejection_notes'] = $combinedNotes;

    if ($reviewNotes !== '') {
        $manifest['rejection_review_notes'] = $reviewNotes;
    }

    // ---- 2. Work history ----
    manifestEnsureWorkHistory($manifest);
    $manifest['work_history'][] = [
        'ts'        => date('c'),
        'event'     => 'rejected_no_coverage',
        'by_email'  => $byEmail,
        'by_name'   => $byName,
        'note'      => ($combinedNotes !== '' ? $combinedNotes : null),
        'source'    => $source,
    ];

    // ---- 3. Credit refund ----
    $refunded     = null;
    $refundAmount = null;
    $isFiller     = !empty($manifest['is_filler']);

    if (!$isFiller) {
        // Determine the amount to refund.
        // Prefer the exact amount we charged at order time (if stored).
        // Fall back to recalculating from project_type (legacy projects).
        $amountCharged = $manifest['amount_charged'] ?? null;

        if ($amountCharged !== null && is_numeric($amountCharged) && (int)$amountCharged > 0) {
            $refundAmount = (int)$amountCharged;
        } else {
            $projType = strtolower(trim((string)($manifest['project_type'] ?? 'residential')));
            $refundAmount = projectTypePrice($projType);
        }

        // Determine who to refund: the owner/issuer who was originally charged
        $refundEmail = strtolower(trim((string)($manifest['owner_email'] ?? '')));
        if ($refundEmail === '' || $refundEmail === 'system') {
            $refundEmail = strtolower(trim((string)($manifest['issuer']['email'] ?? '')));
        }

        if ($refundEmail !== '' && $refundEmail !== 'system' && $refundAmount > 0) {
            // Guard: only refund if we haven't already refunded this project
            if (empty($manifest['refund_issued'])) {
                if (function_exists('creditsRefundByEmail')) {
                    $refundResult = creditsRefundByEmail($refundEmail, $refundAmount, 'rejection_no_coverage', [
                        'folder'       => (string)($manifest['id'] ?? ''),
                        'address'      => (string)($manifest['address'] ?? ''),
                        'project_type' => (string)($manifest['project_type'] ?? 'residential'),
                        'rejected_by'  => $byEmail,
                    ]);
                    $refunded = !empty($refundResult['ok']);
                } else {
                    // creditsRefundByEmail not implemented yet — log so it's visible
                    error_log("rejectProjectNoCoverage: creditsRefundByEmail() not found. "
                        . "Refund of \${$refundAmount} to {$refundEmail} NOT issued. "
                        . "folder=" . ($manifest['id'] ?? ''));
                    $refunded = false;
                }

                // Record refund attempt in manifest regardless of outcome
                $manifest['refund_issued']    = $refunded;
                $manifest['refund_amount']    = $refundAmount;
                $manifest['refund_to_email']  = $refundEmail;
                $manifest['refund_at']        = $now;
                $manifest['refund_by']        = $byEmail;

                $manifest['work_history'][] = [
                    'ts'        => date('c'),
                    'event'     => $refunded ? 'credit_refunded' : 'credit_refund_failed',
                    'amount'    => $refundAmount,
                    'to_email'  => $refundEmail,
                    'by_email'  => $byEmail,
                ];
            } else {
                // Already refunded — don't double-refund
                $refunded     = true;
                $refundAmount = (int)($manifest['refund_amount'] ?? $refundAmount);
            }
        }
    }

    // ---- 4. Save manifest (before email, so state is persisted even if email fails) ----
    saveManifest($mp, $manifest);

    // ---- 5. Send coverage rejection email ----
    $mailOk = sendCoverageRejectionEmailFromManifest($manifest);

    return [
        'success'       => true,
        'emailed'       => $mailOk,
        'refunded'      => $refunded,
        'refund_amount' => $refundAmount,
    ];
}


function sendCoverageRejectionEmailFromManifest($m) {
    if (!is_array($m)) return false;
    $addr = (string)($m['address'] ?? '');
    $issuerEmail = strtolower(trim((string)($m['issuer']['email'] ?? '')));
    $residentEmail = strtolower(trim((string)($m['resident']['email'] ?? '')));

    // Pull refund info from manifest (set by rejectProjectNoCoverage before this is called)
    $refundAmount = null;
    if (!empty($m['refund_issued']) && !empty($m['refund_amount']) && (int)$m['refund_amount'] > 0) {
        $refundAmount = (int)$m['refund_amount'];
    }

    $subject = "Unable to generate report: " . ($addr ?: "Address");
    $discTxt = coverageRejectionDisclaimerText($refundAmount);
    $discHtml = coverageRejectionDisclaimerHtml($refundAmount);
    $text =
"Your roof measurement report request could not be completed.
Address: " . ($addr ?: '-') . "
" . $discTxt;
    $html =
        "<div style=\"font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 14px; line-height: 1.45; color:#111;\">" .
            "<p style=\"margin:0 0 10px;\"><b>Your roof measurement report request could not be completed.</b></p>" .
            "<p style=\"margin:0 0 14px;\"><b>Address:</b> " . htmlspecialchars($addr ?: '-') . "</p>" .
            "<div style=\"padding:12px 14px; border:1px solid #f4b4ae; background:#fce8e6; border-radius:12px;\">" .
                $discHtml .
            "</div>" .
        "</div>";
    $ok = true;
    if ($issuerEmail !== '') {
        $ret = postmarkSendEmail(
            $issuerEmail,
            $subject,
            $text,
            $html,
            $GLOBALS['POSTMARK_DEFAULT_FROM'] ?? 'noreply@1m8.ai',
            $GLOBALS['POSTMARK_DEFAULT_REPLYTO'] ?? null
        );
        $ok = $ok && !empty($ret['ok']);
        if (empty($ret['ok'])) error_log("Coverage rejection email failed issuer=$issuerEmail ret=" . json_encode($ret));
    }
    if ($residentEmail !== '' && $residentEmail !== $issuerEmail) {
        $ret2 = postmarkSendEmail(
            $residentEmail,
            $subject,
            $text,
            $html,
            $GLOBALS['POSTMARK_DEFAULT_FROM'] ?? 'noreply@1m8.ai',
            $GLOBALS['POSTMARK_DEFAULT_REPLYTO'] ?? null
        );
        $ok = $ok && !empty($ret2['ok']);
        if (empty($ret2['ok'])) error_log("Coverage rejection email failed resident=$residentEmail ret=" . json_encode($ret2));
    }
    return $ok;
}

// ------------------------------------------------
// ---------------- URL / API UTILS --------------
// ------------------------------------------------
function fetchUrl($url) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    $data = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ($httpCode === 200) ? $data : false;
}
function normalizeSolarGeoTiffUrl($url) {
    $parts = parse_url($url);
    if (!$parts || empty($parts['query'])) return $url;
    parse_str($parts['query'], $q);
    $q['alt'] = 'media';
    $parts['query'] = http_build_query($q, '', '&', PHP_QUERY_RFC3986);
    return
        ($parts['scheme'] ?? 'https') . '://' .
        ($parts['host'] ?? '') .
        ($parts['path'] ?? '') .
        '?' . $parts['query'];
}
function downloadSolarGeoTiff($url, $destPath) {
    $url = normalizeSolarGeoTiffUrl($url);
    $maxAttempts = 5;
    $attempt = 0;
    $backoffMs = 300;
    while ($attempt < $maxAttempts) {
        $attempt++;
        $tmp = $destPath . '.tmp_' . uniqid();
        $fp = fopen($tmp, 'wb');
        if (!$fp) return false;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FILE            => $fp,
            CURLOPT_FOLLOWLOCATION  => true,
            CURLOPT_TIMEOUT         => 60,
            CURLOPT_SSL_VERIFYPEER  => false,
            CURLOPT_FAILONERROR     => false,
            CURLOPT_IPRESOLVE       => CURL_IPRESOLVE_V4,
            CURLOPT_HTTP_VERSION    => CURL_HTTP_VERSION_1_1,
            CURLOPT_USERAGENT       => 'Mozilla/5.0',
            CURLOPT_HTTPHEADER      => ['Accept: image/tiff,application/octet-stream,*/*'],
        ]);
        curl_exec($ch);
        $curlErr  = curl_error($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $ct       = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);
        fclose($fp);
        $head = '';
        $fh = fopen($tmp, 'rb');
        if ($fh) { $head = fread($fh, 4); fclose($fh); }
        $isTiff = ($head === "II*\0" || $head === "MM\0*");
        if ($httpCode === 200 && $isTiff) {
            rename($tmp, $destPath);
            return true;
        }
        $dbg = $destPath . ".http{$httpCode}.attempt{$attempt}";
        @rename($tmp, $dbg . ".bin");
        error_log("downloadSolarGeoTiff HTTP $httpCode ct=$ct attempt $attempt url=$url curlErr=" . ($curlErr ?: 'none'));
        if ($httpCode >= 500 && $attempt < $maxAttempts) {
            usleep($backoffMs * 1000);
            $backoffMs = min(5000, $backoffMs * 2);
            continue;
        }
        return false;
    }
    return false;
}
function downloadFile($url, $destPath) {
    $maxAttempts = 2;
    $attempt = 0;
    $backoffMs = 250;
    while ($attempt < $maxAttempts) {
        $attempt++;
        $tmp = $destPath . '.tmp_' . uniqid();
        $fp = fopen($tmp, 'wb');
        if (!$fp) return false;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FILE            => $fp,
            CURLOPT_FOLLOWLOCATION  => true,
            CURLOPT_TIMEOUT         => 60,
            CURLOPT_SSL_VERIFYPEER  => false,
            CURLOPT_FAILONERROR     => false,
        ]);
        curl_exec($ch);
        $curlErr  = curl_error($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        fclose($fp);
        if ($httpCode === 200) {
            @rename($tmp, $destPath);
            return true;
        }
        @rename($tmp, $destPath . ".http{$httpCode}.error.bin");
        error_log("downloadFile HTTP $httpCode for $url (attempt $attempt) curlErr=" . ($curlErr ?: 'none'));
        if ($httpCode >= 500 && $attempt < $maxAttempts) {
            usleep($backoffMs * 1000);
            $backoffMs *= 2;
            continue;
        }
        return false;
    }
    return false;
}
function generateAiGeometry($targetDir, $geminiKey) { return false; }
function processProjectApis($targetDir, $address, $googleKey, $geminiKey, $inputLat = null, $inputLng = null, $inputRadius = null) {
    $lat = $inputLat;
    $lng = $inputLng;
    $formattedAddress = $address;

    if (!$lat || !$lng) {
        $geoUrl = "https://maps.googleapis.com/maps/api/geocode/json?address=" . urlencode($address) . "&key=" . $googleKey;
        $geoJson = fetchUrl($geoUrl);
        $geoData = json_decode($geoJson, true);
        if (!$geoData || empty($geoData['results'])) return false;
        $location = $geoData['results'][0]['geometry']['location'];
        $lat = $location['lat'];
        $lng = $location['lng'];
        $formattedAddress = $geoData['results'][0]['formatted_address'];
    }

    $manifestFile = $targetDir . 'manifest.json';
    $manifest = file_exists($manifestFile) ? json_decode(file_get_contents($manifestFile), true) : [];
    if (!is_array($manifest)) $manifest = [];
    $manifest['lat'] = $lat;
    $manifest['lng'] = $lng;
    if (!$inputLat || !$inputLng) $manifest['address'] = $formattedAddress;
    saveManifest($manifestFile, $manifest);

    // Solar insights -> complexity
    $insightsUrl = "https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=$lat&location.longitude=$lng&requiredQuality=LOW&key=$googleKey";
    $insightsJson = fetchUrl($insightsUrl);
    $complexityRating = 3;
    if ($insightsJson) {
        file_put_contents($targetDir . 'insights.json', $insightsJson);
        $insightsData = json_decode($insightsJson, true);
        if (isset($insightsData['solarPotential']['roofSegmentStats']) && is_array($insightsData['solarPotential']['roofSegmentStats'])) {
            $segmentCount = count($insightsData['solarPotential']['roofSegmentStats']);
            $complexityRating = computeComplexityRating($segmentCount);
        }
    }
    $manifest = file_exists($manifestFile) ? json_decode(file_get_contents($manifestFile), true) : [];
    if (!is_array($manifest)) $manifest = [];
    $manifest['complexity'] = $complexityRating;
    saveManifest($manifestFile, $manifest);

    // ---- Dynamic radius ----
    $radius = ($inputRadius !== null && (int)$inputRadius > 0)
        ? (int)$inputRadius
        : 60;
    // Safe max for IMAGERY_AND_ANNUAL_FLUX_LAYERS at 0.1m pixel size = 100m
    // At 0.5m pixel size = 500m. We'll use 0.5 if radius > 100.
    $pixelSize = 0.1;
    if ($radius > 100) {
        $pixelSize = 0.5;
    }
    $maxRadius = (int)($pixelSize * 1000);
    $radius = min($radius, $maxRadius);

    // Persist for later use (e.g. fetch_mask)
    $manifest['radius_meters'] = $radius;
    saveManifest($manifestFile, $manifest);

    // Data layers — using IMAGERY_AND_ANNUAL_FLUX_LAYERS (no monthly flux / hourly shade)
    $layersUrl = "https://solar.googleapis.com/v1/dataLayers:get"
        . "?location.latitude=$lat&location.longitude=$lng"
        . "&radius_meters=$radius"
        . "&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS"
        . "&requiredQuality=LOW"
        . "&pixelSizeMeters=$pixelSize"
        . "&key=$googleKey";
    $layersJson = fetchUrl($layersUrl);
    if ($layersJson) {
        $layersData = json_decode($layersJson, true);
        if (isset($layersData['rgbUrl']))  downloadSolarGeoTiff($layersData['rgbUrl'] . "&key=$googleKey", $targetDir . 'rgb.tif');
        if (isset($layersData['dsmUrl']))  downloadSolarGeoTiff($layersData['dsmUrl'] . "&key=$googleKey", $targetDir . 'dsm.tif');
        if (isset($layersData['maskUrl'])) downloadSolarGeoTiff($layersData['maskUrl'] . "&key=$googleKey", $targetDir . 'mask.tif');
    }

    // Static map — stitch tiles with the same radius
    $tileRadius = max(65, $radius);
    $stitchOk = fetchGoogleTilesStitched($lat, $lng, $googleKey, $targetDir . 'google.png', 21, $tileRadius, 800);
    if (!$stitchOk) {
        error_log("processProjectApis: tile stitch failed for $targetDir — falling back to static map");
        $staticMapUrl = "https://maps.googleapis.com/maps/api/staticmap?center=$lat,$lng&zoom=20&size=640x640&scale=2&maptype=satellite&key=$googleKey";
        downloadFile($staticMapUrl, $targetDir . 'google.png');
    }

    // Azure
    $azureKey = function_exists('fm_azure_maps_provider_key') ? fm_azure_maps_provider_key() : '';
    $azureZoom = 19;
    $azureWidth = 800;
    $azureHeight = 800;
    $azureUrl =
        "https://atlas.microsoft.com/map/static" .
        "?subscription-key=" . urlencode($azureKey) .
        "&api-version=2024-04-01" .
        "&tilesetId=microsoft.imagery" .
        "&zoom=" . urlencode($azureZoom) .
        "&center=" . urlencode($lng . "," . $lat) .
        "&width=" . urlencode($azureWidth) .
        "&height=" . urlencode($azureHeight) .
        "&language=en-US";
    downloadFile($azureUrl, $targetDir . 'azure.png');

    generateAiGeometry($targetDir, $geminiKey);

    // Finalize
    $manifest = file_exists($manifestFile) ? json_decode(file_get_contents($manifestFile), true) : [];
    if (!is_array($manifest)) $manifest = [];
    $manifest['status'] = 'ready';
    $manifest['processed_at'] = date('Y-m-d H:i:s');
    if (empty($manifest['complexity'])) $manifest['complexity'] = $complexityRating;
    saveManifest($manifestFile, $manifest);

    maybeNotifyAdminMissingHeightmap($targetDir, $manifest['id'] ?? null);
    return true;
}

/**
 * Fetch Google satellite tiles at zoom 21 and stitch them to match
 * the Solar API's coverage area (~120m diameter / 60m radius).
 *
 * Uses the official Google Map Tiles API (same API key).
 */
function fetchGoogleTilesStitched($lat, $lng, $apiKey, $destPath, $zoom = 21, $radiusMeters = 65, $outputSize = 800) {
    // Step 1: Create a Map Tiles API session
    $sessionUrl = "https://tile.googleapis.com/v1/createSession?key=" . urlencode($apiKey);
    $ch = curl_init($sessionUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode([
            'mapType'     => 'satellite',
            'language'    => 'en-US',
            'region'      => 'US',
            'imageFormat' => 'jpeg',
            'highDpi'     => false,
        ]),
    ]);
    $resp     = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);
    if ($httpCode !== 200 || !$resp) {
        error_log("fetchGoogleTilesStitched: createSession failed HTTP=$httpCode err=$curlErr resp=" . substr((string)$resp, 0, 300));
        return false;
    }
    $sessionData  = json_decode($resp, true);
    $sessionToken = $sessionData['session'] ?? '';
    if ($sessionToken === '') {
        error_log("fetchGoogleTilesStitched: no session token in response");
        return false;
    }
    // Step 2: Calculate tile grid
    $tileSize = 256;
    $n = pow(2, $zoom);
    $xFrac  = ($lng + 180.0) / 360.0 * $n;
    $latRad = deg2rad($lat);
    $yFrac  = (1.0 - log(tan($latRad) + 1.0 / cos($latRad)) / M_PI) / 2.0 * $n;
    $mpp        = 156543.03392 * cos($latRad) / $n;
    $diameterPx = ($radiusMeters * 2) / $mpp;
    $tilesNeeded = (int)(ceil($diameterPx / $tileSize)) + 2;
    if ($tilesNeeded % 2 === 0) $tilesNeeded++;
    if ($tilesNeeded < 3) $tilesNeeded = 3;
    if ($tilesNeeded > 15) $tilesNeeded = 15;
    $centerTileX = (int)floor($xFrac);
    $centerTileY = (int)floor($yFrac);
    $half = (int)floor($tilesNeeded / 2);
    // Step 3: Fetch tiles and stitch
    $canvasW = $tilesNeeded * $tileSize;
    $canvasH = $tilesNeeded * $tileSize;
    $canvas = @imagecreatetruecolor($canvasW, $canvasH);
    if (!$canvas) {
        error_log("fetchGoogleTilesStitched: GD imagecreatetruecolor failed");
        return false;
    }
    $bg = imagecolorallocate($canvas, 30, 30, 30);
    imagefill($canvas, 0, 0, $bg);
    $fetched = 0;
    $failed  = 0;
    for ($dy = 0; $dy < $tilesNeeded; $dy++) {
        for ($dx = 0; $dx < $tilesNeeded; $dx++) {
            $tx = $centerTileX - $half + $dx;
            $ty = $centerTileY - $half + $dy;
            $tx = (($tx % (int)$n) + (int)$n) % (int)$n;
            $tileUrl = "https://tile.googleapis.com/v1/2dtiles/{$zoom}/{$tx}/{$ty}"
                     . "?session=" . urlencode($sessionToken)
                     . "&key=" . urlencode($apiKey);
            $tileData = fetchUrl($tileUrl);
            if (!$tileData) { $failed++; continue; }
            $tileImg = @imagecreatefromstring($tileData);
            if (!$tileImg) { $failed++; continue; }
            imagecopy($canvas, $tileImg, $dx * $tileSize, $dy * $tileSize, 0, 0, imagesx($tileImg), imagesy($tileImg));
            imagedestroy($tileImg);
            $fetched++;
        }
    }
    if ($fetched === 0) {
        imagedestroy($canvas);
        error_log("fetchGoogleTilesStitched: 0 tiles fetched, $failed failed");
        return false;
    }
    // Step 4: Crop to exact coverage centered on lat/lng
    $centerPxX = $half * $tileSize + ($xFrac - $centerTileX) * $tileSize;
    $centerPxY = $half * $tileSize + ($yFrac - $centerTileY) * $tileSize;
    $cropSize = (int)round($diameterPx);
    $cropSize = min($cropSize, $canvasW, $canvasH);
    $cropX = (int)max(0, min(round($centerPxX - $cropSize / 2), $canvasW - $cropSize));
    $cropY = (int)max(0, min(round($centerPxY - $cropSize / 2), $canvasH - $cropSize));
    $cropped = imagecreatetruecolor($cropSize, $cropSize);
    imagecopy($cropped, $canvas, 0, 0, $cropX, $cropY, $cropSize, $cropSize);
    imagedestroy($canvas);
    // Step 5: Resize to target output size
    $outputSize = max(400, min(2400, (int)$outputSize));
    $output = imagecreatetruecolor($outputSize, $outputSize);
    imagecopyresampled($output, $cropped, 0, 0, 0, 0, $outputSize, $outputSize, $cropSize, $cropSize);
    imagedestroy($cropped);
    $result = imagepng($output, $destPath, 6);
    imagedestroy($output);
    error_log("fetchGoogleTilesStitched: zoom=$zoom grid={$tilesNeeded}x{$tilesNeeded} fetched=$fetched failed=$failed crop={$cropSize}px output={$outputSize}px mpp=" . number_format($mpp, 4));
    return $result;
}
// ------------------------------------------------
// ---------------- QA ASSETS DIRECTORY -----------
// ------------------------------------------------
function qaEnsureAssetsDir($targetDir) {
    $d = rtrim($targetDir, '/\\') . '/qa_assets/';
    if (!file_exists($d)) mkdir($d, 0777, true);
    return $d;
}
// ------------------------------------------------
// ---------------- QA: UPLOAD IMAGE -------------
// ------------------------------------------------
// This handler allows both QA and drafters to upload images
// POST: action=qa_upload_asset, folder, image (file)
function handleQaUploadAsset() {
    global $baseDir;
    
    if (!isset($_SESSION['user_email'])) {
        return json_encode(['error' => 'Not logged in']);
    }
    
    $folder = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
    if (!$folder) {
        return json_encode(['error' => 'Missing folder']);
    }
    
    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';
    
    // Security: Check manifest exists
    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['error' => 'Not found']);
    }
    
    $m = json_decode(@file_get_contents($mp), true);
    $email = strtolower(trim($_SESSION['user_email']));
    
    // Authorization: QA users, admins, or the assigned drafter
    $isQA = canQAUser();
    $isAdmin = isAdmin();
    $isDrafter = (strtolower(trim($m['assigned_to_email'] ?? '')) === $email);
    
    if (!$isQA && !$isAdmin && !$isDrafter) {
        return json_encode(['error' => 'Unauthorized']);
    }
    
    if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) {
        return json_encode(['error' => 'No file uploaded']);
    }
    
    // Validate file type
    $allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mimeType = finfo_file($finfo, $_FILES['image']['tmp_name']);
    finfo_close($finfo);
    
    if (!in_array($mimeType, $allowedTypes)) {
        return json_encode(['error' => 'Invalid file type']);
    }
    
    // Determine extension
    $extMap = [
        'image/png' => 'png',
        'image/jpeg' => 'jpg',
        'image/jpg' => 'jpg',
        'image/gif' => 'gif',
        'image/webp' => 'webp'
    ];
    $ext = $extMap[$mimeType] ?? 'png';
    
    // Create assets directory
    $assetsDir = qaEnsureAssetsDir($targetDir);
    
    // Generate unique filename
    $filename = 'qa_' . uniqid() . '_' . time() . '.' . $ext;
    $destPath = $assetsDir . $filename;
    
    if (move_uploaded_file($_FILES['image']['tmp_name'], $destPath)) {
        // Build relative URL path
        $relPath = '';
        if (strpos($targetDir, '/saves/') !== false) {
            $relPath = 'saves/' . $folder . '/qa_assets/' . $filename;
        } elseif (strpos($targetDir, '/tutorials/master/') !== false) {
            $relPath = 'tutorials/master/' . $folder . '/qa_assets/' . $filename;
        } else {
            $userSafe = basename(dirname($targetDir));
            $relPath = 'tutorials/' . $userSafe . '/' . $folder . '/qa_assets/' . $filename;
        }
        
        return json_encode(['success' => true, 'url' => $relPath]);
    } else {
        return json_encode(['error' => 'Failed to save file']);
    }
}

// ------------------------------------------------
// ---------------- QA: CLAIM ITEM ---------------
// ------------------------------------------------
// POST: action=qa_claim_item, folder
// Claims a QA item for the current QA user
function handleQaClaimItem() {
    global $baseDir;
    
    if (!canQAUser()) {
        return json_encode(['error' => 'Unauthorized']);
    }
    
    $folder = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
    if (!$folder) {
        return json_encode(['error' => 'Missing folder']);
    }
    
    $qaEmail = strtolower(trim($_SESSION['user_email'] ?? ''));
    $qaName = $_SESSION['user_name'] ?? $qaEmail;
    
    // Update activity timestamp for online status
    updateUserActivity($qaEmail);
    
    $result = withQueueLock(function() use ($baseDir, $folder, $qaEmail, $qaName) {
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) {
            return ['success' => false, 'error' => 'Project not found'];
        }
        
        $m = json_decode(file_get_contents($mp), true);
        if (!is_array($m)) $m = [];
        
        // Check if project is in QA status
        $status = $m['status'] ?? '';
        if ($status !== 'awaiting_review') {
            return ['success' => false, 'error' => 'Project is not in QA queue', 'status' => $status];
        }
        
        // Check if available to this user
        $availability = isQaItemAvailableToUser($m, $qaEmail);
        
        if (!$availability['available']) {
            return [
                'success' => false,
                'error' => 'Item is claimed by another QA user who is online',
                'claimed_by' => $availability['claimed_by'],
                'claimed_by_name' => $availability['claimed_by_name']
            ];
        }
        
        // Claim it
        claimQaItem($targetDir, $m, $qaEmail, $qaName);
        
        saveManifest($mp, $m);
        
        return [
            'success' => true,
            'folder' => $folder,
            'claimed_by' => $qaEmail,
            'claimed_by_name' => $qaName,
            'was_released' => !empty($availability['original_claimer_offline'])
        ];
    });
    
    if (!$result) {
        return json_encode(['success' => false, 'error' => 'Queue lock failed']);
    }
    
    return json_encode($result);
}

// ------------------------------------------------
// ---------------- QA: RELEASE CLAIM ------------
// ------------------------------------------------
// POST: action=qa_release_claim, folder
// Releases a QA claim (admin or the claimer themselves)
function handleQaReleaseClaim() {
    global $baseDir;
    
    $folder = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
    if (!$folder) {
        return json_encode(['error' => 'Missing folder']);
    }
    
    $actorEmail = strtolower(trim($_SESSION['user_email'] ?? ''));
    
    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';
    
    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['error' => 'Project not found']);
    }
    
    $m = json_decode(file_get_contents($mp), true);
    if (!is_array($m)) $m = [];
    
    $claimedBy = strtolower(trim($m['qa_claimed_by_email'] ?? ''));
    
    // Only admin or the claimer can release
    if (!isAdmin() && $actorEmail !== $claimedBy) {
        return json_encode(['error' => 'Unauthorized - only admin or claimer can release']);
    }
    
    releaseQaClaim($m, $actorEmail, 'manual');
    
    saveManifest($mp, $m);
    
    return json_encode(['success' => true, 'folder' => $folder]);
}

/**
 * Check if the current session user is a shift manager.
 * Recognised signals (any one is sufficient):
 *   • isAdmin()
 *   • user record has  shift_manager = true
 *   • user record has  role = 'shift_manager'
 *   • user record has  'shift_manager' in permissions array
 */
// ✅ AFTER (fixed)
function canShiftManager() {
    if (isAdmin()) return true;

    $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($email === '') return false;

    $userData = readUserDataByEmail($email);
    if (!$userData) return false;

    // Explicit flag
    if (!empty($userData['shift_manager'])) return true;

    // Role string — accept both 'shift_manager' and 'manager'
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    if ($role === 'shift_manager' || $role === 'manager') return true;

    // Permissions (associative array: key => bool)
    $perms = $userData['permissions'] ?? ($userData['perms'] ?? []);
    if (is_array($perms)) {
        if (!empty($perms['shift_manager'])) return true;
        if (!empty($perms['manage_qa'])) return true;
    }

    return false;
}


// ================================================
// ========  REPLACED: handleQaDecision() =========
// ================================================
// POST: action=qa_decision, folder, status, threads (JSON)
function handleQaDecision() {
    global $baseDir;

    if (!canQAUser()) {
        return json_encode(['error' => 'Unauthorized']);
    }

    $folder  = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
    $status  = $_POST['status'] ?? '';
    $threads = json_decode($_POST['threads'] ?? '[]', true);

    if (!$folder) {
        return json_encode(['error' => 'Missing folder']);
    }

    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';

    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['error' => 'Project not found']);
    }

    $m = json_decode(file_get_contents($mp), true);
    if (!is_array($m)) $m = [];

    $user     = $_SESSION['user_email'] ?? 'unknown';
    $userName = $_SESSION['user_name']  ?? $user;

    // Update activity timestamp
    updateUserActivity($user);

    // Save the threads into the manifest
    $m['qa_threads'] = is_array($threads) ? $threads : [];

    if ($status === 'approved') {

        $isVip = !empty($m['is_vip']);

        if ($isVip) {
            // ── VIP: send to manager review instead of completing ──
            $m['status']              = 'awaiting_manager_review';
            $m['qa_reviewed_at']      = date('Y-m-d H:i:s');
            $m['qa_reviewed_by']      = $user;
            $m['qa_reviewed_by_name'] = $userName;

            // Record who would be paid once the manager gives final approval
            $m['qa_paid_to_email'] = $m['assigned_to_email'] ?? null;
            $m['qa_paid_to_name']  = $m['assigned_to_name']  ?? null;

            // Release QA claim — manager section ignores claims
            releaseQaClaim($m, $user, 'qa_approved_vip');

            // Work history
            manifestEnsureWorkHistory($m);
            $m['work_history'][] = [
                'ts'       => date('c'),
                'event'    => 'qa_approved_pending_manager',
                'qa_email' => $user,
                'qa_name'  => $userName,
            ];

            // NOTE: Do NOT send the report email yet — that happens
            //       when the manager gives final sign-off.

        } else {
            // ── Non-VIP: complete immediately (existing behaviour) ──
            $m['status']               = 'completed';
            $m['completed_at']         = date('Y-m-d H:i:s');
            $m['qa_approved_by']       = $user;
            $m['qa_approved_by_name']  = $userName;
            $m['qa_paid_to_email']     = $m['assigned_to_email'] ?? null;
            $m['qa_paid_to_name']      = $m['assigned_to_name']  ?? null;

            // Clear QA claim on completion
            releaseQaClaim($m, $user, 'approved');

            // Log to work history
            manifestEnsureWorkHistory($m);
            $m['work_history'][] = [
                'ts'       => date('c'),
                'event'    => 'qa_approved',
                'qa_email' => $user,
                'qa_name'  => $userName,
            ];

            // Send report email
            if (function_exists('sendProjectReportEmailAndTrack')) {
                try {
                    ob_start();
                    sendProjectReportEmailAndTrack($targetDir, $m, [
                        'force' => false,
                        'by'    => $user,
                    ]);
                    $stray = ob_get_clean();
                    if ($stray !== '' && $stray !== false) {
                        error_log('QA approve email stray output: ' . substr($stray, 0, 500));
                    }
                } catch (Throwable $e) {
                    @ob_end_clean();
                    error_log('QA approve email error: ' . $e->getMessage());
                }
            }
        }

    } elseif ($status === 'rejected') {
        // ── Rejection (unchanged) ──
        $rejCount = (int)($m['qa_reject_count'] ?? 0);
        $rejCount++;
        $m['qa_reject_count'] = $rejCount;

        // Extract active issues from threads for logging
        $activeFailures = [];
        if (is_array($threads)) {
            foreach ($threads as $t) {
                $tStatus = $t['status'] ?? 'open';
                if ($tStatus !== 'closed' && $tStatus !== 'resolved') {
                    $lastMsg = !empty($t['history']) ? end($t['history']) : null;
                    $activeFailures[] = [
                        'item'   => $t['label'] ?? 'Unknown',
                        'status' => $tStatus,
                        'notes'  => $lastMsg ? ($lastMsg['text'] ?? '') : ''
                    ];
                }
            }
        }

        // Ensure history arrays exist
        if (!isset($m['qa_history']) || !is_array($m['qa_history'])) $m['qa_history'] = [];
        manifestEnsureWorkHistory($m);

        // Log QA rejection
        $m['qa_history'][] = [
            'date'           => date('Y-m-d H:i:s'),
            'inspector'      => $user,
            'inspector_name' => $userName,
            'status'         => 'rejected',
            'reject_count'   => $rejCount,
            'failures'       => $activeFailures,
            'thread_count'   => count($threads)
        ];

        $m['work_history'][] = [
            'ts'            => date('c'),
            'event'         => 'qa_rejected',
            'reject_count'  => $rejCount,
            'worker_email'  => $m['assigned_to_email'] ?? null,
            'worker_name'   => $m['assigned_to_name']  ?? null,
            'qa_email'      => $user,
            'qa_name'       => $userName,
            'active_issues' => count($activeFailures),
        ];

        // KEEP the QA claim — when it comes back to QA, same QA user will see it
        $m['status'] = 'correction_needed';
        $origEmail = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
        $origName  = (string)($m['assigned_to_name'] ?? '');

        $m['correction_to_email']       = ($origEmail !== '') ? $origEmail : null;
        $m['correction_to_name']        = ($origName  !== '') ? $origName  : null;
        $m['correction_requested_at']   = date('Y-m-d H:i:s');
        $m['correction_requested_by']   = $user;

        // Clear any old "QA fix required" flags
        unset($m['qa_fix_required'], $m['qa_fix_by_email'], $m['qa_fix_by_name'], $m['qa_fix_required_at']);
    }

    saveManifest($mp, $m);
    return json_encode(['success' => true]);
}


// ================================================
// ========  NEW: handleManagerQueue() ============
// ================================================
/**
 * Returns all VIP projects that have passed QA and are awaiting
 * shift-manager sign-off.
 *
 * POST: action=manager_queue
 * Access: shift_manager or admin
 */
function handleManagerQueue() {
    global $baseDir;

    if (!canShiftManager()) {
        return json_encode(['error' => 'Unauthorized']);
    }

    $currentEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($currentEmail !== '') updateUserActivity($currentEmail);

    if (!function_exists('pj_db')) {
        return json_encode(['success' => false, 'error' => 'project index not loaded']);
    }

    $db = pj_db();

    $pending = [];
    $history = [];

    // ── Pending: awaiting_manager_review ──
    $stmtP = $db->prepare("
        SELECT id
        FROM p
        WHERE st = 'awaiting_manager_review'
        ORDER BY COALESCE(ua, ca, qa, 0) ASC
        LIMIT 500
    ");
    $resP = $stmtP->execute();

    while ($row = $resP->fetchArray(SQLITE3_ASSOC)) {
        $folder = (string)($row['id'] ?? '');
        if ($folder === '') continue;

        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) continue;

        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) continue;

        $pending[] = [
            'id'                 => $folder,
            'address'            => $m['address'] ?? 'Unknown',
            'status'             => $m['status'] ?? 'awaiting_manager_review',
            'is_vip'             => !empty($m['is_vip']),
            'is_filler'          => !empty($m['is_filler']),
            'project_type'       => $m['project_type'] ?? 'residential',
            'complexity'         => $m['complexity'] ?? null,
            'team_id'            => $m['team_id'] ?? 'default',
            'created_at'         => $m['created_at'] ?? null,
            'queued_at'          => $m['queued_at'] ?? null,
            'started_at'         => $m['started_at'] ?? null,
            'uploaded_at'        => $m['uploaded_at'] ?? null,
            'qa_reviewed_at'     => $m['qa_reviewed_at'] ?? null,
            'qa_reviewed_by'     => $m['qa_reviewed_by'] ?? null,
            'qa_reviewed_by_name'=> $m['qa_reviewed_by_name'] ?? null,
            'assigned_to_email'  => $m['assigned_to_email'] ?? null,
            'assigned_to_name'   => $m['assigned_to_name'] ?? null,
            'issuer'             => $m['issuer']['name'] ?? ($m['issuer_name'] ?? 'System'),
            'issuer_email'       => $m['issuer']['email'] ?? ($m['issuer_email'] ?? null),
            'resident'           => $m['resident']['name'] ?? '-',
            'pins'               => $m['pins'] ?? [],
            'cc_emails'          => $m['cc_emails'] ?? [],
        ];
    }
    $resP->finalize();

    // ── Recent history: completed VIP projects (manager-approved) ──
    $stmtH = $db->prepare("
        SELECT id
        FROM p
        WHERE st = 'completed'
        ORDER BY COALESCE(da, ua, ca, 0) DESC
        LIMIT 200
    ");
    $resH = $stmtH->execute();

    while ($row = $resH->fetchArray(SQLITE3_ASSOC)) {
        $folder = (string)($row['id'] ?? '');
        if ($folder === '') continue;

        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) continue;

        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) continue;

        // Only include VIP projects that went through manager approval
        if (empty($m['is_vip'])) continue;
        if (empty($m['manager_approved_by'])) continue;

        $history[] = [
            'id'                      => $folder,
            'address'                 => $m['address'] ?? 'Unknown',
            'status'                  => $m['status'] ?? 'completed',
            'is_vip'                  => true,
            'is_filler'               => !empty($m['is_filler']),
            'completed_at'            => $m['completed_at'] ?? null,
            'manager_approved_by'     => $m['manager_approved_by'] ?? null,
            'manager_approved_by_name'=> $m['manager_approved_by_name'] ?? null,
            'assigned_to_name'        => $m['assigned_to_name'] ?? null,
            'assigned_to_email'       => $m['assigned_to_email'] ?? null,
            'qa_reviewed_by_name'     => $m['qa_reviewed_by_name'] ?? null,
        ];

        if (count($history) >= 30) break;
    }
    $resH->finalize();

    usort($pending, function($a, $b) {
        return safeParseTs($a['qa_reviewed_at'] ?? $a['uploaded_at'] ?? '') <=> safeParseTs($b['qa_reviewed_at'] ?? $b['uploaded_at'] ?? '');
    });
    usort($history, function($a, $b) {
        return safeParseTs($b['completed_at'] ?? '') <=> safeParseTs($a['completed_at'] ?? '');
    });

    return json_encode([
        'success' => true,
        'pending' => $pending,
        'history' => $history,
    ]);
}


// ================================================
// ========  NEW: handleManagerDecision() =========
// ================================================
/**
 * Shift-manager approves or rejects a VIP project that has already
 * passed QA review.
 *
 * POST: action=manager_decision, folder, status ('approved'|'rejected'),
 *        threads (JSON, optional), notes (string, optional)
 * Access: shift_manager or admin
 */
function handleManagerDecision() {
    global $baseDir;

    if (!canShiftManager()) {
        return json_encode(['error' => 'Unauthorized']);
    }

    $folder  = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
    $status  = $_POST['status'] ?? '';
    $threads = json_decode($_POST['threads'] ?? '[]', true);
    $notes   = trim((string)($_POST['notes'] ?? ''));

    if (!$folder) {
        return json_encode(['error' => 'Missing folder']);
    }

    if (!in_array($status, ['approved', 'rejected'], true)) {
        return json_encode(['error' => 'Invalid status — must be "approved" or "rejected"']);
    }

    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';

    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['error' => 'Project not found']);
    }

    $m = json_decode(file_get_contents($mp), true);
    if (!is_array($m)) $m = [];

    if (($m['status'] ?? '') !== 'awaiting_manager_review') {
        return json_encode([
            'error'          => 'Project is not awaiting manager review',
            'current_status' => $m['status'] ?? ''
        ]);
    }

    $user     = strtolower(trim((string)($_SESSION['user_email'] ?? 'unknown')));
    $userName = $_SESSION['user_name'] ?? $user;

    updateUserActivity($user);

    // Save manager threads if provided
    if (is_array($threads) && !empty($threads)) {
        $m['manager_threads'] = $threads;
    }

    if ($status === 'approved') {
        // ── Final approval — project is now complete ──
        $m['status']                    = 'completed';
        $m['completed_at']              = date('Y-m-d H:i:s');
        $m['manager_approved_by']       = $user;
        $m['manager_approved_by_name']  = $userName;
        $m['manager_approved_at']       = date('Y-m-d H:i:s');

        // The QA decision already stored qa_paid_to_email/name

        manifestEnsureWorkHistory($m);
        $m['work_history'][] = [
            'ts'            => date('c'),
            'event'         => 'manager_approved',
            'manager_email' => $user,
            'manager_name'  => $userName,
            'notes'         => ($notes !== '') ? $notes : null,
        ];

        // NOW send the report email (final gate passed)
        if (function_exists('sendProjectReportEmailAndTrack')) {
            try {
                ob_start();
                sendProjectReportEmailAndTrack($targetDir, $m, [
                    'force' => false,
                    'by'    => $user,
                ]);
                $stray = ob_get_clean();
                if ($stray !== '' && $stray !== false) {
                    error_log('Manager approve email stray output: ' . substr($stray, 0, 500));
                }
            } catch (Throwable $e) {
                @ob_end_clean();
                error_log('Manager approve email error: ' . $e->getMessage());
            }
        }

    } elseif ($status === 'rejected') {
        // ── Manager rejection — send back to drafter for corrections ──
        $m['status'] = 'correction_needed';

        $m['manager_reject_count'] = (int)($m['manager_reject_count'] ?? 0) + 1;

        $origEmail = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
        $origName  = (string)($m['assigned_to_name'] ?? '');

        $m['correction_to_email']     = ($origEmail !== '') ? $origEmail : null;
        $m['correction_to_name']      = ($origName  !== '') ? $origName  : null;
        $m['correction_requested_at'] = date('Y-m-d H:i:s');
        $m['correction_requested_by'] = $user;

        // Extract active issues from manager threads for logging
        $activeIssues = 0;
        if (is_array($threads)) {
            foreach ($threads as $t) {
                $tStatus = $t['status'] ?? 'open';
                if ($tStatus !== 'closed' && $tStatus !== 'resolved') $activeIssues++;
            }
        }

        manifestEnsureWorkHistory($m);
        $m['work_history'][] = [
            'ts'             => date('c'),
            'event'          => 'manager_rejected',
            'manager_email'  => $user,
            'manager_name'   => $userName,
            'notes'          => ($notes !== '') ? $notes : null,
            'active_issues'  => $activeIssues,
            'worker_email'   => $m['assigned_to_email'] ?? null,
            'worker_name'    => $m['assigned_to_name']  ?? null,
        ];
    }

    saveManifest($mp, $m);
    return json_encode(['success' => true]);
}




// ------------------------------------------------
// ---------------- DRAFTER SUBMIT FIXES ---------
// ------------------------------------------------
// POST: action=drafter_submit_fixes, folder, threads (JSON)
function handleDrafterSubmitFixes() {
    global $baseDir, $userDir;
    
    if (!isset($_SESSION['user_email'])) {
        return json_encode(['error' => 'Not logged in']);
    }
    
    $folder = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
    $threads = json_decode($_POST['threads'] ?? '[]', true);
    
    if (!$folder) {
        return json_encode(['error' => 'Missing folder']);
    }
    
    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';
    
    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['error' => 'Project not found']);
    }
    
    $m = json_decode(file_get_contents($mp), true);
    if (!is_array($m)) $m =[];
    
    // Verify ownership - must be the assigned drafter or admin
    $email = strtolower(trim($_SESSION['user_email']));
    $assigned = strtolower(trim($m['assigned_to_email'] ?? ''));
    
    // Update activity timestamp
    updateUserActivity($email);
    
    if ($email !== $assigned && !isAdmin()) {
        return json_encode(['error' => 'Unauthorized']);
    }
    
    // Check if this project has already passed initial QA
    $isManagerCorrection = (!empty($m['is_vip']) && !empty($m['qa_reviewed_at']));
    
    if ($isManagerCorrection) {
        $m['manager_threads'] = is_array($threads) ? $threads : [];
        $m['status'] = 'awaiting_manager_review';
    } else {
        $m['qa_threads'] = is_array($threads) ? $threads : [];
        $m['status'] = 'awaiting_review';
    }
    
    $m['uploaded_at'] = date('Y-m-d H:i:s'); // Bump timestamp so it shows at top of queue
    
    // Log the correction submission
    manifestEnsureWorkHistory($m);
    $m['work_history'][] =[
        'ts' => date('c'),
        'event' => 'correction_submitted',
        'worker_email' => $email,
        'worker_name' => $_SESSION['user_name'] ?? $email,
        'thread_count' => count($threads),
    ];
    
    // Count how many issues were addressed
    $fixedCount = 0;
    $disputedCount = 0;
    if (is_array($threads)) {
        foreach ($threads as $t) {
            $tStatus = $t['status'] ?? 'open';
            if ($tStatus === 'fixed') $fixedCount++;
            elseif ($tStatus === 'disputed') $disputedCount++;
        }
    }
    
    $m['last_correction_stats'] =[
        'submitted_at' => date('Y-m-d H:i:s'),
        'fixed_count' => $fixedCount,
        'disputed_count' => $disputedCount,
        'total_threads' => count($threads)
    ];
    
    saveManifest($mp, $m);
    return json_encode(['success' => true]);
}

// ================================================
// ========  WORKER KICK / AFK FUNCTIONS  =========
// ================================================

/**
 * Admin force-kicks a worker off a project they are actively editing.
 * Sets a 'force_kick' signal in the manifest which the worker's browser
 * polls for every 5 seconds. Their UI will show a 10-second countdown
 * then redirect them to the portal.
 *
 * POST: action=admin_kick_worker, folder, reason (optional)
 * Access: admin or queue_admin
 */
function handleAdminKickWorker() {
    global $baseDir;

    if (!isAdmin() && !isQueueAdminUser()) {
        return json_encode(['success' => false, 'error' => 'Unauthorized']);
    }

    $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
    if ($folder === '') {
        return json_encode(['success' => false, 'error' => 'Missing folder']);
    }

    $reason     = trim((string)($_POST['reason'] ?? ''));
    $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $actorName  = $_SESSION['user_name'] ?? $actorEmail;

    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';

    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['success' => false, 'error' => 'Project not found']);
    }

    $m = json_decode(@file_get_contents($mp), true);
    if (!is_array($m)) $m = [];

    $workerEmail = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
    $workerName  = (string)($m['assigned_to_name'] ?? $workerEmail);

    if ($workerEmail === '') {
        return json_encode(['success' => false, 'error' => 'No worker currently assigned to this project']);
    }

    $now = date('Y-m-d H:i:s');

    // Plant the kick signal — worker polling will detect this within ~5 seconds
    $m['force_kick'] = [
        'email'          => $workerEmail,
        'name'           => $workerName,
        'by'             => $actorEmail,
        'by_name'        => $actorName,
        'at'             => $now,
        'reason'         => ($reason !== '') ? $reason : null,
        'acknowledged'   => false,
    ];

    // Log the event immediately (assignment is cleared when worker acknowledges)
    manifestEnsureWorkHistory($m);
    $m['work_history'][] = [
        'ts'             => date('c'),
        'event'          => 'force_kicked',
        'worker_email'   => $workerEmail,
        'worker_name'    => $workerName,
        'kicked_by'      => $actorEmail,
        'kicked_by_name' => $actorName,
        'reason'         => ($reason !== '') ? $reason : null,
    ];

    saveManifest($mp, $m);

    return json_encode([
        'success'      => true,
        'kicked_email' => $workerEmail,
        'kicked_name'  => $workerName,
    ]);
}

/**
 * Worker polls this to find out if an admin has kicked them off the project.
 * Called every 5 seconds by monitor.js when a project folder is loaded.
 *
 * POST: action=check_for_kick, folder
 */
function handleCheckForKick() {
    global $baseDir;

    if (!isset($_SESSION['user_email'])) {
        return json_encode(['success' => false, 'error' => 'Not logged in']);
    }

    $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
    if ($folder === '') {
        return json_encode(['success' => false, 'error' => 'Missing folder']);
    }

    $myEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));

    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';

    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['success' => true, 'kicked' => false]);
    }

    $m = json_decode(@file_get_contents($mp), true);
    if (!is_array($m)) {
        return json_encode(['success' => true, 'kicked' => false]);
    }

    $kick = $m['force_kick'] ?? null;

    // No kick signal, or already acknowledged, or targeted at someone else
    if (!is_array($kick) || empty($kick['email'])) {
        return json_encode(['success' => true, 'kicked' => false]);
    }
    if (!empty($kick['acknowledged'])) {
        return json_encode(['success' => true, 'kicked' => false]);
    }
    if (strtolower(trim($kick['email'])) !== $myEmail) {
        return json_encode(['success' => true, 'kicked' => false]);
    }

    return json_encode([
        'success'   => true,
        'kicked'    => true,
        'kicked_by' => $kick['by_name'] ?? $kick['by'] ?? 'An administrator',
        'reason'    => $kick['reason'] ?? null,
        'at'        => $kick['at'] ?? null,
    ]);
}

/**
 * Worker calls this once they have seen the kick notification and are
 * about to redirect. Clears their assignment so the project re-enters
 * the queue for another worker to pick up.
 *
 * POST: action=acknowledge_kick, folder
 */
function handleAcknowledgeKick() {
    global $baseDir;

    if (!isset($_SESSION['user_email'])) {
        return json_encode(['success' => false, 'error' => 'Not logged in']);
    }

    $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
    if ($folder === '') {
        return json_encode(['success' => false, 'error' => 'Missing folder']);
    }

    $myEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));

    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';

    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['success' => false, 'error' => 'Project not found']);
    }

    $m = json_decode(@file_get_contents($mp), true);
    if (!is_array($m)) $m = [];

    // Mark the force_kick as acknowledged
    if (is_array($m['force_kick'] ?? null)
        && strtolower(trim($m['force_kick']['email'] ?? '')) === $myEmail) {
        $m['force_kick']['acknowledged']    = true;
        $m['force_kick']['acknowledged_at'] = date('Y-m-d H:i:s');
    }

    // Release the assignment so the project re-enters the queue
    $m['assigned_to_email'] = null;
    $m['assigned_to_name']  = null;
    $m['started_at']        = null;
    $m['status']            = 'queued';

    manifestEnsureWorkHistory($m);
    $m['work_history'][] = [
        'ts'           => date('c'),
        'event'        => 'kick_acknowledged',
        'worker_email' => $myEmail,
    ];

    saveManifest($mp, $m);

    return json_encode(['success' => true]);
}

/**
 * Worker's browser self-reports that they were AFK-kicked.
 * Clears their assignment and records the idle duration.
 *
 * POST: action=report_afk_kick, folder, idle_seconds
 */
function handleReportAfkKick() {
    global $baseDir;

    if (!isset($_SESSION['user_email'])) {
        return json_encode(['success' => false, 'error' => 'Not logged in']);
    }

    $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
    if ($folder === '') {
        return json_encode(['success' => false, 'error' => 'Missing folder']);
    }

    $myEmail  = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    $myName   = $_SESSION['user_name'] ?? $myEmail;
    $idleSecs = max(0, (int)($_POST['idle_seconds'] ?? 300));

    $targetDir = locateProjectDir($folder);
    if (!$targetDir) $targetDir = $baseDir . $folder . '/';

    $mp = $targetDir . 'manifest.json';
    if (!file_exists($mp)) {
        return json_encode(['success' => false, 'error' => 'Project not found']);
    }

    $m = json_decode(@file_get_contents($mp), true);
    if (!is_array($m)) $m = [];

    // Only let the actually-assigned worker self-report
    $assignedEmail = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
    if ($assignedEmail !== $myEmail) {
        // Still return success so the client redirects cleanly
        return json_encode(['success' => true, 'note' => 'not_assigned']);
    }

    $now = date('Y-m-d H:i:s');

    // Record AFK kick metadata for admin visibility
    $m['afk_kick'] = [
        'email'        => $myEmail,
        'name'         => $myName,
        'at'           => $now,
        'idle_seconds' => $idleSecs,
    ];

    // Release assignment — project returns to the queue
    $m['assigned_to_email'] = null;
    $m['assigned_to_name']  = null;
    $m['started_at']        = null;
    $m['status']            = 'queued';

    manifestEnsureWorkHistory($m);
    $m['work_history'][] = [
        'ts'           => date('c'),
        'event'        => 'afk_kicked',
        'worker_email' => $myEmail,
        'worker_name'  => $myName,
        'idle_seconds' => $idleSecs,
        'idle_minutes' => round($idleSecs / 60, 1),
    ];

    saveManifest($mp, $m);

    return json_encode(['success' => true]);
}




















// ------------------------------------------------
// ---------------- PROJECT ACTION HANDLERS ------
// ------------------------------------------------
function handleProjectActions($action) {
    global $baseDir, $userDir, $tutorialDir, $GOOGLE_API_KEY, $GEMINI_API_KEY;
    if ($action === 'qa_upload_asset') {
        echo handleQaUploadAsset();
        return true;
    }
    if ($action === 'qa_claim_item') {
        echo handleQaClaimItem();
        return true;
    }
    if ($action === 'qa_release_claim') {
        echo handleQaReleaseClaim();
        return true;
    }
    if ($action === 'qa_decision') {
        echo handleQaDecision();
        return true;
    }
    if ($action === 'drafter_submit_fixes') {
        echo handleDrafterSubmitFixes();
        return true;
    }
   if ($action === 'manager_queue') {
       echo handleManagerQueue();
       return true;
   }
   if ($action === 'manager_decision') {
       echo handleManagerDecision();
       return true;
   }
    
    // ------------------------------------------------
    // ---------------- UPDATE USER ACTIVITY ---------
    // ------------------------------------------------
    // Called periodically by the frontend to keep online status fresh
    if ($action === 'heartbeat' || $action === 'update_activity') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }
        $email = strtolower(trim($_SESSION['user_email']));
        $ok = updateUserActivity($email);
        echo json_encode(['success' => $ok, 'ts' => date('c')]);
        return true;
    }

    // ------------------------------------------------
    // ---------------- SET BREAK STATUS --------------
    // ------------------------------------------------
    if ($action === 'set_break_status') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }
        $email = strtolower(trim((string)$_SESSION['user_email']));
        $goOnBreak = filter_var($_POST['on_break'] ?? false, FILTER_VALIDATE_BOOLEAN);

        global $userDir;
        $userFile = $userDir . getUserFilename($email);
        if (!file_exists($userFile)) {
            echo json_encode(['success' => false, 'error' => 'User not found']);
            return true;
        }
        $userData = json_decode(@file_get_contents($userFile), true);
        if (!is_array($userData)) $userData = [];

        if ($goOnBreak) {
            $userData['on_break'] = true;
            $userData['break_started_at'] = date('c');
        } else {
            $userData['on_break'] = false;
            unset($userData['break_started_at']);
        }
        @file_put_contents($userFile, json_encode($userData, JSON_PRETTY_PRINT));

        echo json_encode([
            'success' => true,
            'on_break' => !empty($userData['on_break']),
            'break_started_at' => $userData['break_started_at'] ?? null,
        ]);
        return true;
    }
    
    // ------------------------------------------------
    // ---------------- CHECK USER ONLINE STATUS -----
    // ------------------------------------------------
    if ($action === 'check_user_online') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }
        $checkEmail = strtolower(trim($_POST['email'] ?? ''));
        if ($checkEmail === '') {
            echo json_encode(['success' => false, 'error' => 'Missing email']);
            return true;
        }
        $thresholdMinutes = (int)($_POST['threshold_minutes'] ?? 30);
        if ($thresholdMinutes < 1) $thresholdMinutes = 30;
        
        $isOnline = isUserOnline($checkEmail, $thresholdMinutes);
        echo json_encode([
            'success' => true,
            'email' => $checkEmail,
            'online' => $isOnline,
            'threshold_minutes' => $thresholdMinutes
        ]);
        return true;
    }
    
    // ------------------------------------------------
    // ---------------- UPLOAD MODEL DATA ------------
    // ------------------------------------------------
    if ($action === 'upload_model_data') {
        $fid = $_POST['folder'] ?? '';
        // Security check on folder format
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        
        if (!$folder) die(json_encode(['error' => 'Invalid folder']));
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        // Authorization check
//         if (!isAuthorized($folder) && !isAdmin()) die(json_encode(['error' => 'Unauthorized']));
        if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);
        // Save the XML file
        if (isset($_FILES['xml_file']) && $_FILES['xml_file']['error'] === UPLOAD_ERR_OK) {
            $dest = $targetDir . 'model_data.xml';
            if (move_uploaded_file($_FILES['xml_file']['tmp_name'], $dest)) {
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['error' => 'Failed to move uploaded XML']);
            }
        } else {
            echo json_encode(['error' => 'No XML file received']);
        }
        return true;
    }
    
    // ------------------------------------------------
    // -------- REQUEST REJECTION (PENDING REVIEW) ---
    // ------------------------------------------------
    // POST: action=request_rejection, folder, reject_reasons (JSON array of strings),
    //        reject_notes (string, optional)
    //
    // Sets status to 'pending_rejection' so a QA reviewer can confirm or overturn.
    // Saves all rejection metadata into the manifest for the reviewer.
    if ($action === 'request_rejection') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }

        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') {
            die(json_encode(['success' => false, 'error' => 'Missing folder']));
        }

        // Locate project
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';

        if (!isAuthorized($folder) && !isAdmin()) {
            http_response_code(403);
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) {
            die(json_encode(['success' => false, 'error' => 'Project not found']));
        }

        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];

        // Parse inputs
        $rawReasons = $_POST['reject_reasons'] ?? '[]';
        $reasons = json_decode($rawReasons, true);
        if (!is_array($reasons)) $reasons = [];
        $reasons = array_values(array_filter(array_map(function($r) {
            return trim((string)$r);
        }, $reasons)));

        $notes = trim((string)($_POST['reject_notes'] ?? ''));

        if (empty($reasons) && $notes === '') {
            die(json_encode(['success' => false, 'error' => 'At least one rejection reason or note is required']));
        }

        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $actorName  = $_SESSION['user_name'] ?? $actorEmail;
        $now        = date('Y-m-d H:i:s');

        // Store previous status so the reviewer can restore if overturned
        $previousStatus = (string)($m['status'] ?? '');

        $m['status'] = 'pending_rejection';

        // Save full rejection request metadata for the reviewer
        $m['rejection_request'] = [
            'requested_at'      => $now,
            'requested_by'      => $actorEmail,
            'requested_by_name' => $actorName,
            'reasons'           => $reasons,
            'notes'             => $notes,
            'previous_status'   => $previousStatus,
            'reviewed'          => false,
            'review_decision'   => null,   // 'confirmed' or 'overturned'
            'reviewed_at'       => null,
            'reviewed_by'       => null,
            'reviewed_by_name'  => null,
            'review_notes'      => null,
        ];

        manifestEnsureWorkHistory($m);
        $m['work_history'][] = [
            'ts'              => date('c'),
            'event'           => 'rejection_requested',
            'by_email'        => $actorEmail,
            'by_name'         => $actorName,
            'reasons'         => $reasons,
            'notes'           => $notes,
            'previous_status' => $previousStatus,
        ];

        saveManifest($mp, $m);

        echo json_encode([
            'success' => true,
            'folder'  => $folder,
            'status'  => 'pending_rejection',
        ]);
        return true;
    }

    // ------------------------------------------------
    // -------- REVIEW REJECTION (QA CONFIRMS/OVERTURNS)
    // ------------------------------------------------
    // POST: action=review_rejection, folder, decision ('confirmed' | 'overturned'),
    //        review_notes (string, optional)
    //
    // If confirmed:  status -> 'rejected' (final)
    // If overturned: status -> restored to previous_status (or 'processing' fallback)
    if ($action === 'review_rejection') {
        if (!canQAUser() && !isAdmin()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized — QA or admin required']));
        }

        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') {
            die(json_encode(['success' => false, 'error' => 'Missing folder']));
        }

        $decision = strtolower(trim((string)($_POST['decision'] ?? '')));
        if (!in_array($decision, ['confirmed', 'overturned'], true)) {
            die(json_encode(['success' => false, 'error' => 'Invalid decision — must be "confirmed" or "overturned"']));
        }

        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';

        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) {
            die(json_encode(['success' => false, 'error' => 'Project not found']));
        }

        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];

        if (($m['status'] ?? '') !== 'pending_rejection') {
            die(json_encode([
                'success' => false,
                'error' => 'Project is not pending rejection',
                'current_status' => $m['status'] ?? ''
            ]));
        }

        $reviewerEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $reviewerName  = $_SESSION['user_name'] ?? $reviewerEmail;
        $reviewNotes   = trim((string)($_POST['review_notes'] ?? ''));
        $now           = date('Y-m-d H:i:s');

        if ($reviewerEmail) updateUserActivity($reviewerEmail);

        // Update the rejection_request block (common to both decisions)
        if (isset($m['rejection_request']) && is_array($m['rejection_request'])) {
            $m['rejection_request']['reviewed']         = true;
            $m['rejection_request']['review_decision']  = $decision;
            $m['rejection_request']['reviewed_at']      = $now;
            $m['rejection_request']['reviewed_by']      = $reviewerEmail;
            $m['rejection_request']['reviewed_by_name'] = $reviewerName;
            $m['rejection_request']['review_notes']     = $reviewNotes;
        }

        if ($decision === 'confirmed') {
            // Delegate entirely to the centralized rejection function
            $reqReasons = (array)($m['rejection_request']['reasons'] ?? []);
            $reqNotes   = trim((string)($m['rejection_request']['notes'] ?? ''));

            $result = rejectProjectNoCoverage($targetDir, $m, [
                'by_email'     => $reviewerEmail,
                'by_name'      => $reviewerName,
                'note'         => $reqNotes,
                'reasons'      => $reqReasons,
                'source'       => 'rejection_review',
                'review_notes' => $reviewNotes,
            ]);

            echo json_encode([
                'success'       => true,
                'folder'        => $folder,
                'decision'      => 'confirmed',
                'status'        => $m['status'],
                'emailed'       => $result['emailed'],
                'refunded'      => $result['refunded'],
                'refund_amount' => $result['refund_amount'],
            ]);
        } else {
            // Overturned — send back to production
            $m['status'] = 'processing';

            manifestEnsureWorkHistory($m);
            $m['work_history'][] = [
                'ts'               => date('c'),
                'event'            => 'rejection_reviewed',
                'decision'         => 'overturned',
                'reviewer_email'   => $reviewerEmail,
                'reviewer_name'    => $reviewerName,
                'review_notes'     => $reviewNotes,
                'resulting_status' => 'processing',
            ];

            saveManifest($mp, $m);

            echo json_encode([
                'success'  => true,
                'folder'   => $folder,
                'decision' => 'overturned',
                'status'   => 'processing',
            ]);
        }
        return true;
    }



    // ------------------------------------------------
    // ---------------- UPLOAD SOURCES (FINALIZE) ----
    // ------------------------------------------------
    if ($action === 'upload_sources') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['error' => 'Not logged in']));

        $folder = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
        if (!$folder) die(json_encode(['error' => 'Missing folder']));

        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';

//         if (!isAuthorized($folder) && !isAdmin()) die(json_encode(['error' => 'Unauthorized']));

        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) die(json_encode(['error' => 'Project not found']));

        $m = json_decode(file_get_contents($mp), true);
        if (!is_array($m)) $m = [];

        $notes = trim((string)($_POST['notes'] ?? ''));

        // Save images into the shared qa_assets directory
        $assetsDir = qaEnsureAssetsDir($targetDir);
        $savedImages = [];

        // Build relative URL path (same logic as handleQaUploadAsset)
        $relPath = '';
        if (strpos($targetDir, '/saves/') !== false) {
            $relPath = 'saves/' . $folder . '/qa_assets/';
        } elseif (strpos($targetDir, '/tutorials/master/') !== false) {
            $relPath = 'tutorials/master/' . $folder . '/qa_assets/';
        } else {
            $userSafe = basename(dirname($targetDir));
            $relPath = 'tutorials/' . $userSafe . '/' . $folder . '/qa_assets/';
        }

        $allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
        $extMap = [
            'image/png' => 'png', 'image/jpeg' => 'jpg', 'image/jpg' => 'jpg',
            'image/gif' => 'gif', 'image/webp' => 'webp'
        ];

        foreach ($_FILES as $key => $file) {
            if (strpos($key, 'source_image_') !== 0) continue;
            if ($file['error'] !== UPLOAD_ERR_OK) continue;

            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            $mime = finfo_file($finfo, $file['tmp_name']);
            finfo_close($finfo);

            if (!in_array($mime, $allowedTypes)) continue;

            $ext = $extMap[$mime] ?? 'png';
            $filename = 'source_' . uniqid() . '_' . time() . '.' . $ext;
            $destPath = $assetsDir . $filename;

            if (move_uploaded_file($file['tmp_name'], $destPath)) {
                $savedImages[] = [
                    'filename' => $filename,
                    'url' => $relPath . $filename,
                    'original_name' => $file['name'] ?? $filename,
                    'uploaded_at' => date('c'),
                ];
            }
        }

        // Persist into manifest under submission_sources
        $m['submission_sources'] = [
            'notes' => $notes,
            'images' => $savedImages,
            'submitted_at' => date('c'),
            'submitted_by' => strtolower(trim((string)($_SESSION['user_email'] ?? ''))),
        ];

        saveManifest($mp, $m);

        echo json_encode(['success' => true, 'images_saved' => count($savedImages)]);
        return true;
    }
    // ------------------------------------------------
    // ---------------- QUEUE RESERVE PROJECT --------
    // ------------------------------------------------
    if ($action === 'queue_reserve_project') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        if (!isQueueAdminUser() && !isAdmin()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));
        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success'=>false,'error'=>'Missing folder']));
        $userEmail = strtolower(trim((string)($_POST['user_email'] ?? ''))); // empty => clear
        // Locate project directory (supports tutorials too)
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = rtrim($baseDir, '/\\') . '/' . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) die(json_encode(['success'=>false,'error'=>'Project not found']));
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $now = date('Y-m-d H:i:s');
        $out = withQueueLock(function() use ($mp, $userEmail, $actor, $now) {
            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) $m = [];
            // Helper: check user eligibility ("live and training_complete")
            $resolveEligibleUser = function($email) {
                $email = strtolower(trim((string)$email));
                if ($email === '') return ['ok'=>false,'error'=>'Missing user_email'];
                $u = readUserDataByEmail($email);
                if (!$u) return ['ok'=>false,'error'=>'User not found'];
                // Must be training_complete
                if (empty($u['training_complete'])) return ['ok'=>false,'error'=>'User not training_complete'];
                // Optional guards if present
                if (array_key_exists('disabled', $u) && !empty($u['disabled'])) return ['ok'=>false,'error'=>'User disabled'];
                if (array_key_exists('is_verified', $u) && empty($u['is_verified'])) return ['ok'=>false,'error'=>'User not verified'];
                return [
                    'ok'=>true,
                    'email'=>$email,
                    'name'=>(string)($u['name'] ?? $email),
                    'id'=>(string)($u['id'] ?? ''),
                    'team_id'=>(string)($u['team_id'] ?? 'default'),
                ];
            };
            // Clear reservation
            if ($userEmail === '') {
                unset($m['reserved_to_email'], $m['reserved_to_name'], $m['reserved_at'], $m['reserved_by']);
                manifestEnsureWorkHistory($m);
                $m['work_history'][] = [
                    'ts' => date('c'),
                    'event' => 'reservation_cleared',
                    'by_email' => $actor ?: null,
                ];
                @saveManifest($mp, $m);
                return [
                    'success'=>true,
                    'cleared'=>true,
                    'folder'=>(string)($m['id'] ?? null),
                    'reserved_to_email'=>null,
                    'reserved_to_name'=>null,
                    'reserved_at'=>null,
                ];
            }
            // Set reservation
            $ru = $resolveEligibleUser($userEmail);
            if (empty($ru['ok'])) return ['success'=>false,'error'=>($ru['error'] ?? 'Invalid user')];
            $m['reserved_to_email'] = $ru['email'];
            $m['reserved_to_name']  = $ru['name'];
            $m['reserved_at']       = $now;
            $m['reserved_by']       = $actor ?: null;
            // Optional convenience: if team_id missing, align it (helps admin filters)
            if (empty($m['team_id']) && !empty($ru['team_id'])) $m['team_id'] = $ru['team_id'];
            manifestEnsureWorkHistory($m);
            $m['work_history'][] = [
                'ts' => date('c'),
                'event' => 'reserved_for_user',
                'by_email' => $actor ?: null,
                'reserved_to_email' => $ru['email'],
                'reserved_to_name'  => $ru['name'],
            ];
            @saveManifest($mp, $m);
            return [
                'success'=>true,
                'folder'=>(string)($m['id'] ?? null),
                'reserved_to_email'=>$ru['email'],
                'reserved_to_name'=>$ru['name'],
                'reserved_at'=>$now,
                'reserved_by'=>$actor ?: null,
            ];
        });
        if (!$out) die(json_encode(['success'=>false,'error'=>'Queue lock failed']));
        echo json_encode($out);
        return true;
    }
    // ------------------------------------------------
    // ------------- PROJECT: MARK REJECTED (COVERAGE)
    // ------------------------------------------------
    if ($action === 'mark_rejected_no_coverage') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        if (!isAdmin() && !isQueueAdminUser()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success'=>false,'error'=>'Missing folder']));

        $note = trim((string)($_POST['note'] ?? ''));

        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';

        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) die(json_encode(['success'=>false,'error'=>'Project not found']));

        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];

        $result = rejectProjectNoCoverage($targetDir, $m, [
            'by_email' => (string)($_SESSION['user_email'] ?? ''),
            'by_name'  => (string)($_SESSION['user_name'] ?? $_SESSION['user_email'] ?? ''),
            'note'     => $note,
            'source'   => 'direct',
        ]);

        echo json_encode([
            'success'       => true,
            'emailed'       => $result['emailed'],
            'refunded'      => $result['refunded'],
            'refund_amount' => $result['refund_amount'],
        ]);
        return true;
    }

    
    // ------------------------------------------------
    // ---------------- QUEUE STATUS ------------------
    // ------------------------------------------------
    if ($action === 'queue_status') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['error' => 'Not logged in']));
        $email = strtolower(trim((string)$_SESSION['user_email']));

        // Update activity on queue status check
        updateUserActivity($email);

        // Fallback to legacy if index not available
        if (!function_exists('pj_db')) {
            echo json_encode(['success'=>false,'error'=>'project index not loaded']);
            return true;
        }

        $db = pj_db();

        // Helper: minimal eligibility check w/ only needed file IO
        $isEligibleHeightmapWise = function($folder) {
            $baseDir = $GLOBALS['baseDir'] ?? null;
            if (!$baseDir) return true;

            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = rtrim($baseDir, '/\\') . '/' . $folder . '/';

            $mp = $targetDir . 'manifest.json';
            if (!file_exists($mp)) return false;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) $m = [];

            $status = strtolower((string)($m['status'] ?? ''));
            if (!empty($m['pushed_forward_no_coverage'])) return true;
            if (!empty($m['allow_no_coverage'])) return true;
            if ($status === 'queued_forced') return true;

            $processedAt = trim((string)($m['processed_at'] ?? ''));
            if ($processedAt === '') return true;

            $dsmPath = rtrim($targetDir, '/\\') . '/dsm.tif';
            return file_exists($dsmPath);
        };

        // -------- Corrections count (availability logic: locked user online/offline) --------
        $countCorrections = 0;

        $stmt = $db->prepare("
            SELECT id, asn
            FROM p
            WHERE st='correction_needed'
        ");
        $res = $stmt->execute();
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $folder = (string)($row['id'] ?? '');
            if ($folder === '') continue;

            $lock = strtolower(trim((string)($row['asn'] ?? ''))); // original drafter (usually)
            if ($lock === '') continue;

            if ($email === $lock) {
                $countCorrections++;
            } else {
                // available if original drafter is offline
                if (!isUserOnline($lock)) $countCorrections++;
            }
        }
        $res->finalize();

        // -------- Normal/reserved count (queued/ready, not started, reservation rules) ------
        $countNormal   = 0;
        $countReserved = 0;

        $stmt2 = $db->prepare("
            SELECT id, rs
            FROM p
            WHERE st IN ('queued','ready')
              AND (sa IS NULL OR sa=0)
              AND (rs IS NULL OR rs='' OR rs=:me)
        ");
        $stmt2->bindValue(':me', $email, SQLITE3_TEXT);
        $res2 = $stmt2->execute();

        while ($row = $res2->fetchArray(SQLITE3_ASSOC)) {
            $folder = (string)($row['id'] ?? '');
            if ($folder === '') continue;

            // Heightmap eligibility (small IO only for candidates)
            if (!$isEligibleHeightmapWise($folder)) continue;

            $resTo = strtolower(trim((string)($row['rs'] ?? '')));
            if ($resTo !== '' && $resTo === $email) $countReserved++;
            else $countNormal++;
        }
        $res2->finalize();

        $total = $countCorrections + $countReserved + $countNormal;

        $workerData = readUserDataByEmail($email);
        $queueMode  = strtolower(trim((string)($workerData['queue_mode'] ?? 'disabled')));
        $modeLabels = [
            'disabled'          => 'Hot Swapping Disabled',
            'wait_for_feedback' => 'Wait for Feedback',
            'hot_swap'          => 'Hot Swapping Enabled',
        ];

        // Wait-for-feedback block state (only check the user's own assigned jobs via index)
        $queueBlocked       = false;
        $queueBlockedReason = null;

        if ($queueMode === 'wait_for_feedback') {
            $stmt3 = $db->prepare("
                SELECT id, st
                FROM p
                WHERE asn=:me AND st IN ('awaiting_review','correction_needed','awaiting_manager_review')
                LIMIT 1
            ");
            $stmt3->bindValue(':me', $email, SQLITE3_TEXT);
            $res3 = $stmt3->execute();
            $row3 = $res3->fetchArray(SQLITE3_ASSOC);
            $res3->finalize();

            if ($row3) {
                $queueBlocked = true;
                $queueBlockedReason = 'Projects pending QA review must be completed first.';
            }
        }

        // Break status
        $onBreak = !empty($workerData['on_break']);
        $breakStartedAt = $workerData['break_started_at'] ?? null;

        // Last submitted timestamp (when user last sent work to QA)
        $lastSubmittedAt = null;
        $stmtLastSub = $db->prepare("SELECT MAX(ua) as last_sub FROM p WHERE asn=:me AND ua IS NOT NULL AND ua > 0");
        $stmtLastSub->bindValue(':me', $email, SQLITE3_TEXT);
        $resLastSub = $stmtLastSub->execute();
        $rowLastSub = $resLastSub->fetchArray(SQLITE3_ASSOC);
        $resLastSub->finalize();
        if ($rowLastSub && $rowLastSub['last_sub'] && (int)$rowLastSub['last_sub'] > 0) {
            $lastSubmittedAt = date('c', (int)$rowLastSub['last_sub']);
        }

        echo json_encode([
            'success'     => true,
            'queue_count' => $total,
            'has_next'    => ($total > 0),
            'queue_breakdown' => [
                'corrections' => $countCorrections,
                'reserved'    => $countReserved,
                'normal'      => $countNormal,
            ],
            'queue_mode'       => $queueMode,
            'queue_mode_label' => $modeLabels[$queueMode] ?? $queueMode,
            'queue_blocked'    => $queueBlocked,
            'queue_blocked_reason' => $queueBlockedReason,
            'on_break'         => $onBreak,
            'break_started_at' => $breakStartedAt,
            'last_submitted_at'=> $lastSubmittedAt,
        ]);
        return true;
    }

    
    // ----------------------------------------------------------------
    //  CHECK HOT SWAP
    // ----------------------------------------------------------------
    if ($action === 'check_hot_swap') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        $workerEmail   = strtolower(trim((string)$_SESSION['user_email']));
        $currentFolder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['current_folder'] ?? ''));
        if ($currentFolder === '') die(json_encode(['success'=>false,'error'=>'Missing current_folder']));

        if (!function_exists('pj_db')) {
            echo json_encode(['success'=>false,'error'=>'project index not loaded']);
            return true;
        }

        $workerData = readUserDataByEmail($workerEmail);
        $queueMode  = strtolower(trim((string)($workerData['queue_mode'] ?? 'disabled')));
        if ($queueMode !== 'hot_swap') {
            echo json_encode(['success'=>true, 'has_swap'=>false, 'reason'=>'mode_not_hot_swap']);
            return true;
        }

        // Read current manifest
        $currentDir = locateProjectDir($currentFolder);
        if (!$currentDir) $currentDir = $baseDir . $currentFolder . '/';
        $currentMp = $currentDir . 'manifest.json';
        if (!file_exists($currentMp)) {
            echo json_encode(['success'=>true, 'has_swap'=>false, 'reason'=>'current_project_not_found']);
            return true;
        }
        $cm = json_decode(@file_get_contents($currentMp), true);
        if (!is_array($cm)) $cm = [];

        $currentIsFiller = !empty($cm['is_filler']);

        // Determine if current is correction
        $currentIsCorrection = false;
        $wh = (isset($cm['work_history']) && is_array($cm['work_history'])) ? $cm['work_history'] : [];
        for ($i = count($wh) - 1; $i >= 0; $i--) {
            $ev = is_array($wh[$i]) ? $wh[$i] : [];
            $evType = (string)($ev['event'] ?? '');
            if ($evType === 'claimed_correction') { $currentIsCorrection = true; break; }
            if ($evType === 'claimed_new') { break; }
        }

        // Determine current project's priority tier:
        //   1 = non-filler correction  (highest)
        //   2 = non-filler queued
        //   3 = filler correction
        //   4 = filler queued           (lowest)
        $currentPriority = 4;
        if (!$currentIsFiller && $currentIsCorrection)  $currentPriority = 1;
        elseif (!$currentIsFiller && !$currentIsCorrection) $currentPriority = 2;
        elseif ($currentIsFiller && $currentIsCorrection)  $currentPriority = 3;
        // else: filler + not correction = 4

        // Tier 1 — nothing beats it
        if ($currentPriority <= 1) {
            echo json_encode(['success'=>true, 'has_swap'=>false, 'reason'=>'on_highest_priority']);
            return true;
        }

        $db = pj_db();

        $isEligibleHeightmapWise = function($folder) use ($baseDir) {
            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = $baseDir . $folder . '/';
            $mp = $targetDir . 'manifest.json';
            if (!file_exists($mp)) return false;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) $m = [];

            if (!empty($m['pushed_forward_no_coverage'])) return true;
            if (!empty($m['allow_no_coverage'])) return true;

            $st = strtolower((string)($m['status'] ?? ''));
            if ($st === 'queued_forced') return true;

            $processedAt = trim((string)($m['processed_at'] ?? ''));
            if ($processedAt === '') return true;

            return file_exists($targetDir . 'dsm.tif');
        };

        // ------------------------------------------------------------------
        // Helper: look for a correction with given filler flag
        // ------------------------------------------------------------------
        $findCorrection = function($fillerFlag) use ($db, $workerEmail, $currentFolder) {
            $fl = $fillerFlag ? 1 : 0;
            $stmt = $db->prepare("
                SELECT id, asn, COALESCE(ua, ca, qa, 0) t
                FROM p
                WHERE st='correction_needed'
                  AND fl=:fl
                  AND id != :cur
                  AND (rs IS NULL OR rs='' OR rs=:me)
                ORDER BY
                  CASE WHEN asn=:me THEN 0 ELSE 1 END ASC,
                  t ASC
                LIMIT 250
            ");
            $stmt->bindValue(':fl', $fl, SQLITE3_INTEGER);
            $stmt->bindValue(':cur', $currentFolder, SQLITE3_TEXT);
            $stmt->bindValue(':me', $workerEmail, SQLITE3_TEXT);
            $res = $stmt->execute();

            while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                $folder = (string)($row['id'] ?? '');
                if ($folder === '') continue;

                $corrTo = strtolower(trim((string)($row['asn'] ?? '')));
                $ok = false;
                if ($corrTo !== '' && $corrTo === $workerEmail) $ok = true;
                elseif ($corrTo !== '' && !isUserOnline($corrTo)) $ok = true;
                elseif ($corrTo === '') $ok = true;

                if ($ok) {
                    $res->finalize();
                    return $folder;
                }
            }
            $res->finalize();
            return null;
        };

        // ------------------------------------------------------------------
        // Helper: look for a queued item with given filler flag
        // ------------------------------------------------------------------
        $findQueued = function($fillerFlag) use ($db, $workerEmail, $currentFolder, $isEligibleHeightmapWise) {
            $fl = $fillerFlag ? 1 : 0;
            $stmt = $db->prepare("
                SELECT id, COALESCE(pa, qa, ca, 0) t
                FROM p
                WHERE st IN ('queued','ready')
                  AND (sa IS NULL OR sa=0)
                  AND id != :cur
                  AND fl=:fl
                  AND (rs IS NULL OR rs='' OR rs=:me)
                ORDER BY t ASC
                LIMIT 200
            ");
            $stmt->bindValue(':fl', $fl, SQLITE3_INTEGER);
            $stmt->bindValue(':cur', $currentFolder, SQLITE3_TEXT);
            $stmt->bindValue(':me', $workerEmail, SQLITE3_TEXT);
            $res = $stmt->execute();

            while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                $folder = (string)($row['id'] ?? '');
                if ($folder === '') continue;
                if (!$isEligibleHeightmapWise($folder)) continue;

                $res->finalize();
                return $folder;
            }
            $res->finalize();
            return null;
        };

        // ==================================================================
        //  Check each tier that beats $currentPriority, in order.
        //
        //    Tier 1: non-filler correction   (check if currentPriority > 1)
        //    Tier 2: non-filler queued        (check if currentPriority > 2)
        //    Tier 3: filler correction        (check if currentPriority > 3)
        //
        //  Tier 4 (filler queued) is never a swap target — it would be a
        //  lateral or downward move.
        // ==================================================================

        // Tier 1: non-filler correction
        if ($currentPriority > 1) {
            $found = $findCorrection(false);
            if ($found) {
                echo json_encode([
                    'success'        => true,
                    'has_swap'       => true,
                    'reason'         => 'non_filler_correction_available',
                    'target_folder'  => $found,
                    'target_address' => '',
                ]);
                return true;
            }
        }

        // Tier 2: non-filler queued
        if ($currentPriority > 2) {
            $found = $findQueued(false);
            if ($found) {
                echo json_encode([
                    'success'        => true,
                    'has_swap'       => true,
                    'reason'         => 'non_filler_queued_available',
                    'target_folder'  => $found,
                    'target_address' => '',
                ]);
                return true;
            }
        }

        // Tier 3: filler correction
        if ($currentPriority > 3) {
            $found = $findCorrection(true);
            if ($found) {
                echo json_encode([
                    'success'        => true,
                    'has_swap'       => true,
                    'reason'         => 'filler_correction_available',
                    'target_folder'  => $found,
                    'target_address' => '',
                ]);
                return true;
            }
        }

        echo json_encode([
            'success'  => true,
            'has_swap' => false,
            'reason'   => 'no_higher_priority',
        ]);
        return true;
    }

    // ----------------------------------------------------------------
    //  EXECUTE HOT SWAP
    // ----------------------------------------------------------------
    if ($action === 'execute_hot_swap') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));
        $workerEmail  = strtolower(trim((string)$_SESSION['user_email']));
        $workerName   = $_SESSION['user_name'] ?? $workerEmail;

        // Block hot swap while on break
        $hsWorkerData = readUserDataByEmail($workerEmail);
        if (!empty($hsWorkerData['on_break'])) {
            echo json_encode(['success'=>false,'error'=>'On break','blocked_by_break'=>true]);
            return true;
        }

        $targetFolder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['target_folder'] ?? ''));
        if ($targetFolder === '') die(json_encode(['success'=>false,'error'=>'Missing target_folder']));
        $result = withQueueLock(function() use ($baseDir, $targetFolder, $workerEmail, $workerName, $userDir) {
            $mp = $baseDir . $targetFolder . '/manifest.json';
            if (!file_exists($mp)) return ['success'=>false, 'error'=>'Project not found'];
            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) return ['success'=>false, 'error'=>'Bad manifest'];
            $status = $m['status'] ?? '';
            // Verify project is still available
            $isCorrection = ($status === 'correction_needed');
            $isQueued     = in_array($status, ['queued', 'ready'], true) && empty($m['started_at']);
            if (!$isCorrection && !$isQueued) {
                return ['success'=>false, 'error'=>'Project no longer available', 'current_status'=>$status];
            }
            // FIX: Enforce reservation — if reserved for someone else, block the claim
            $reservedTo = strtolower(trim((string)($m['reserved_to_email'] ?? '')));
            if ($reservedTo !== '' && $reservedTo !== $workerEmail) {
                return ['success'=>false, 'error'=>'Project is reserved for another user'];
            }
            // If correction, verify it's available (locked to this user OR original tech is offline)
            if ($isCorrection) {
                $corrTo = strtolower(trim((string)($m['correction_to_email'] ?? ($m['assigned_to_email'] ?? ''))));
                if ($corrTo !== '' && $corrTo !== $workerEmail) {
                    // Check if original is offline
                    if (isUserOnline($corrTo)) {
                        return ['success'=>false, 'error'=>'Correction is assigned to another drafter who is online'];
                    }
                    // Original is offline, allow claiming
                }
            }
            // Claim it
            $now = date('Y-m-d H:i:s');
            $m['started_at']         = $now;
            $m['assigned_at']        = $now;
            $m['assigned_to_email']  = $workerEmail;
            $m['assigned_to_name']   = $workerName;
            $m['status']             = 'processing';
            if (empty($m['team_id'])) {
                $m['team_id'] = getUserTeamId($m['owner_email'] ?? $workerEmail);
            }
            manifestEnsureWorkHistory($m);
            $m['work_history'][] = [
                'ts'           => date('c'),
                'event'        => $isCorrection ? 'claimed_correction' : 'claimed_new',
                'worker_email' => $workerEmail,
                'worker_name'  => $workerName,
                'via'          => 'hot_swap',
            ];
            saveManifest($mp, $m);
            // Add to user's project list
            $workerFile = $userDir . getUserFilename($workerEmail);
            if (file_exists($workerFile)) {
                $uData = json_decode(@file_get_contents($workerFile), true);
                if (!is_array($uData)) $uData = [];
                if (!isset($uData['projects']) || !is_array($uData['projects'])) $uData['projects'] = [];
                if (!in_array($targetFolder, $uData['projects'], true)) {
                    $uData['projects'][] = $targetFolder;
                    file_put_contents($workerFile, json_encode($uData, JSON_PRETTY_PRINT));
                }
            }
            return [
                'success' => true,
                'folder'  => $targetFolder,
                'source'  => $isCorrection ? 'correction_needed' : 'queued_ready',
                'address' => $m['address'] ?? '',
            ];
        });

        if (!$result) die(json_encode(['success'=>false, 'error'=>'Queue lock failed']));

        echo json_encode($result);

        // Close connection to client BEFORE slow filler work
        if (session_id()) session_write_close();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        }

        // Background: spawn filler projects if queue is low
        if (!empty($result['success']) && function_exists('maybeSpawnFillerProjects')) {
            try {
                error_log('auto-filler: starting maybeSpawnFillerProjects after claim');
                maybeSpawnFillerProjects();
                error_log('auto-filler: finished maybeSpawnFillerProjects');
            } catch (Throwable $e) {
                error_log('auto-filler: EXCEPTION: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            }
        }

        return true;
    }


    // ------------------------------------------------
    // ---------------- CLAIM NEXT IN QUEUE ----------
    // ------------------------------------------------
    if ($action === 'claim_next_in_queue') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['error' => 'Not logged in']));
        $workerEmail = strtolower(trim((string)$_SESSION['user_email']));
        $workerName  = $_SESSION['user_name'] ?? $workerEmail;

        $workerData = readUserDataByEmail($workerEmail);
        $complexityPref = $workerData['complexity_preference'] ?? 'all';

        // Block claims while on break
        if (!empty($workerData['on_break'])) {
            echo json_encode([
                'success' => false,
                'error' => 'You are currently on a break. Return from your break first.',
                'blocked_by_break' => true,
            ]);
            return true;
        }

        updateUserActivity($workerEmail);

        if (!function_exists('pj_db')) {
            echo json_encode(['success'=>false,'error'=>'project index not loaded']);
            return true;
        }

        // ========== QUEUE MODE 2: Wait for Feedback ==========
        $queueMode = strtolower(trim((string)($workerData['queue_mode'] ?? 'disabled')));
        if ($queueMode === 'wait_for_feedback') {
            $db = pj_db();
            $stmtBlock = $db->prepare("
                SELECT id, st
                FROM p
                WHERE asn=:me AND st IN ('awaiting_review','correction_needed','awaiting_manager_review')
                LIMIT 25
            ");
            $stmtBlock->bindValue(':me', $workerEmail, SQLITE3_TEXT);
            $resBlock = $stmtBlock->execute();

            $pendingDetails = [];
            while ($r = $resBlock->fetchArray(SQLITE3_ASSOC)) {
                $pendingDetails[] = [
                    'folder'  => (string)($r['id'] ?? ''),
                    'address' => '',
                    'status'  => (string)($r['st'] ?? ''),
                ];
            }
            $resBlock->finalize();

            if (!empty($pendingDetails)) {
                echo json_encode([
                    'success'         => false,
                    'error'           => 'You have projects pending QA review. Complete or resolve those before pulling new work.',
                    'blocked_by_mode' => 'wait_for_feedback',
                    'pending'         => $pendingDetails,
                ]);
                return true;
            }
        }

        $result = withQueueLock(function() use ($workerEmail, $workerName, $complexityPref) {
            $db = pj_db();
            $baseDir = $GLOBALS['baseDir'] ?? null;
            $userDir = $GLOBALS['userDir'] ?? null;

            $isEligibleHeightmapWise = function($folder) use ($baseDir) {
                $targetDir = locateProjectDir($folder);
                if (!$targetDir) $targetDir = rtrim($baseDir, '/\\') . '/' . $folder . '/';

                $mp = $targetDir . 'manifest.json';
                if (!file_exists($mp)) return false;

                $m = json_decode(@file_get_contents($mp), true);
                if (!is_array($m)) $m = [];

                $status = strtolower((string)($m['status'] ?? ''));
                if (!empty($m['pushed_forward_no_coverage'])) return true;
                if (!empty($m['allow_no_coverage'])) return true;
                if ($status === 'queued_forced') return true;

                $processedAt = trim((string)($m['processed_at'] ?? ''));
                if ($processedAt === '') return true;

                return file_exists($targetDir . 'dsm.tif');
            };

            // ------------------------------------------------------------------
            // Helper: read VIP flag from manifest for a given folder
            // ------------------------------------------------------------------
            $readIsVip = function($folder) use ($baseDir) {
                $td = locateProjectDir($folder);
                if (!$td) $td = rtrim($baseDir, '/\\') . '/' . $folder . '/';
                $mp = $td . 'manifest.json';
                if (!file_exists($mp)) return false;
                $mData = json_decode(@file_get_contents($mp), true);
                return (is_array($mData) && !empty($mData['is_vip']));
            };

            // ------------------------------------------------------------------
            // Helper: claim a picked project, update manifest + user file
            // ------------------------------------------------------------------
            $doClaimProject = function($pick, $source, $extraHistory = []) use ($workerEmail, $workerName, $baseDir, $userDir) {
                $targetDir = locateProjectDir($pick);
                if (!$targetDir) $targetDir = rtrim($baseDir, '/\\') . '/' . $pick . '/';
                $mp = $targetDir . 'manifest.json';
                if (!file_exists($mp)) return ['success'=>false,'error'=>'Project not found'];

                $m = json_decode(@file_get_contents($mp), true);
                if (!is_array($m)) $m = [];

                $now = date('Y-m-d H:i:s');
                $m['started_at']         = $now;
                $m['assigned_at']        = $now;
                $m['assigned_to_email']  = $workerEmail;
                $m['assigned_to_name']   = $workerName;
                $m['status']             = 'processing';
                if (empty($m['team_id'])) $m['team_id'] = getUserTeamId($m['owner_email'] ?? $workerEmail);

                manifestEnsureWorkHistory($m);
                $m['work_history'][] = array_merge([
                    'ts'           => date('c'),
                    'worker_email' => $workerEmail,
                    'worker_name'  => $workerName,
                ], $extraHistory);

                saveManifest($mp, $m);

                // Add to user's project list
                if ($userDir) {
                    $workerFile = rtrim($userDir, '/\\') . '/' . getUserFilename($workerEmail);
                    if (file_exists($workerFile)) {
                        $uData = json_decode(@file_get_contents($workerFile), true);
                        if (!is_array($uData)) $uData = [];
                        if (!isset($uData['projects']) || !is_array($uData['projects'])) $uData['projects'] = [];
                        if (!in_array($pick, $uData['projects'], true)) {
                            $uData['projects'][] = $pick;
                            if (function_exists('atomicWriteJson')) atomicWriteJson($workerFile, $uData);
                            else @file_put_contents($workerFile, json_encode($uData, JSON_PRETTY_PRINT));
                        }
                    }
                }

                return ['success'=>true, 'folder'=>$pick, 'source'=>$source];
            };

            // ------------------------------------------------------------------
            // Helper: scan corrections for a given filler flag (0 or 1)
            // Returns a result array on success, or null if nothing found.
            // VIP projects are prioritized within the eligible set.
            // ------------------------------------------------------------------
            $tryCorrection = function($fillerFlag) use ($db, $workerEmail, $doClaimProject, $readIsVip) {
                $fl = $fillerFlag ? 1 : 0;
                $stmt = $db->prepare("
                    SELECT id, asn, COALESCE(ua, ca, qa, 0) t
                    FROM p
                    WHERE st='correction_needed'
                      AND fl=:fl
                      AND (rs IS NULL OR rs='' OR rs=:me)
                    ORDER BY
                      CASE WHEN asn=:me THEN 0 ELSE 1 END ASC,
                      t ASC
                    LIMIT 250
                ");
                $stmt->bindValue(':fl', $fl, SQLITE3_INTEGER);
                $stmt->bindValue(':me', $workerEmail, SQLITE3_TEXT);
                $res = $stmt->execute();

                $eligible = [];
                while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                    $folder = (string)($row['id'] ?? '');
                    if ($folder === '') continue;

                    $lock = strtolower(trim((string)($row['asn'] ?? '')));
                    $wasOfflineRelease = false;

                    if ($lock === '' || $lock === $workerEmail) {
                        // available directly
                    } elseif (!isUserOnline($lock)) {
                        $wasOfflineRelease = true;
                    } else {
                        continue; // locked to an online user
                    }

                    $eligible[] = [
                        'folder'              => $folder,
                        'is_vip'              => $readIsVip($folder),
                        'was_offline_release' => $wasOfflineRelease,
                    ];

                    // Cap manifest reads — 20 eligible candidates is plenty
                    if (count($eligible) >= 20) break;
                }
                $res->finalize();

                if (empty($eligible)) return null;

                // VIP first, preserve relative timestamp order otherwise
                usort($eligible, function($a, $b) {
                    return (int)$b['is_vip'] - (int)$a['is_vip'];
                });

                $pick = $eligible[0];
                return $doClaimProject($pick['folder'], 'correction_needed', [
                    'event'               => 'claimed_correction',
                    'was_offline_release'  => $pick['was_offline_release'],
                ]);
            };

            // ------------------------------------------------------------------
            // Helper: scan queued/ready for a given filler flag (0 or 1)
            // Uses windowed + complexity-preference logic.
            // VIP projects are prioritized within the candidate set.
            // ------------------------------------------------------------------
            $tryQueued = function($fillerFlag) use ($db, $workerEmail, $complexityPref, $isEligibleHeightmapWise, $doClaimProject, $readIsVip) {
                $fl = $fillerFlag ? 1 : 0;
                $stmt = $db->prepare("
                    SELECT id, cx, rs, COALESCE(pa, qa, ca, 0) t
                    FROM p
                    WHERE st IN ('queued','ready')
                      AND (sa IS NULL OR sa=0)
                      AND fl=:fl
                      AND (rs IS NULL OR rs='' OR rs=:me)
                    ORDER BY t ASC
                    LIMIT 200
                ");
                $stmt->bindValue(':fl', $fl, SQLITE3_INTEGER);
                $stmt->bindValue(':me', $workerEmail, SQLITE3_TEXT);
                $res = $stmt->execute();

                $cands = [];
                while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                    $folder = (string)($row['id'] ?? '');
                    if ($folder === '') continue;
                    if (!$isEligibleHeightmapWise($folder)) continue;

                    $cands[] = [
                        'id'     => $folder,
                        't'      => (int)($row['t'] ?? 0),
                        'cx'     => (string)($row['cx'] ?? 'complex'),
                        'is_vip' => $readIsVip($folder),
                    ];
                    if (count($cands) >= 60) break;
                }
                $res->finalize();

                if (empty($cands)) return null;

                // VIP first, then oldest first
                usort($cands, function($a, $b) {
                    $vipCmp = (int)$b['is_vip'] - (int)$a['is_vip'];
                    if ($vipCmp !== 0) return $vipCmp;
                    return $a['t'] <=> $b['t'];
                });

                $windowSize = 10;
                $window = array_slice($cands, 0, $windowSize);

                $selectedId = null;
                if ($complexityPref === 'simple') {
                    foreach ($window as $j) {
                        $cx = normalizeComplexity($j['cx'] ?? 3);
                        if ($cx <= 2) { $selectedId = $j['id']; break; }
                    }
                } elseif ($complexityPref === 'complex') {
                    foreach ($window as $j) {
                        $cx = normalizeComplexity($j['cx'] ?? 3);
                        if ($cx >= 3) { $selectedId = $j['id']; break; }
                    }
                }
                if (!$selectedId) $selectedId = $window[0]['id'];

                return $doClaimProject($selectedId, 'queued_ready', [
                    'event' => 'claimed_new',
                ]);
            };

            // ==================================================================
            //  4-pass priority:
            //    1. Non-filler corrections  (VIP first within tier)
            //    2. Non-filler queued        (VIP first within tier)
            //    3. Filler corrections        (VIP first within tier)
            //    4. Filler queued             (VIP first within tier)
            // ==================================================================

            $r = $tryCorrection(false);
            if ($r) return $r;

            $r = $tryQueued(false);
            if ($r) return $r;

            $r = $tryCorrection(true);
            if ($r) return $r;

            $r = $tryQueued(true);
            if ($r) return $r;

            return ['success'=>false,'error'=>'Queue empty'];
        });

        if (!$result) die(json_encode(['success' => false, 'error' => 'Queue lock failed']));

        echo json_encode($result);

        // Close connection to client BEFORE slow filler work
        if (session_id()) session_write_close();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        }

        // Background: spawn filler projects if queue is low
        if (!empty($result['success']) && function_exists('maybeSpawnFillerProjects')) {
            try {
                error_log('auto-filler: starting maybeSpawnFillerProjects after claim');
                maybeSpawnFillerProjects();
                error_log('auto-filler: finished maybeSpawnFillerProjects');
            } catch (Throwable $e) {
                error_log('auto-filler: EXCEPTION: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            }
        }

        return true;
    }


    // ------------------------------------------------
    // ---------------- QUEUE ADMIN TEAMS ------------
    // ------------------------------------------------
    if ($action === 'queue_admin_teams') {
        if (!isQueueAdminUser()) die(json_encode(['error' => 'Unauthorized']));
        $teams = [];
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $u = json_decode(file_get_contents($userDir . $f), true);
                if (!$u) continue;
                $t = $u['team_id'] ?? 'default';
                if (!in_array($t, $teams)) $teams[] = $t;
            }
        }
        sort($teams);
        echo json_encode(['success' => true, 'teams' => $teams]);
        return true;
    }
    // ------------------------------------------------
    // ---------------- QUEUE ADMIN OVERVIEW ----------
    // ------------------------------------------------
    // ------------------------------------------------
    // ---------------- QUEUE ADMIN OVERVIEW ----------
    // ------------------------------------------------
    if ($action === 'queue_admin_overview') {
        if (!isQueueAdminUser()) die(json_encode(['error' => 'Unauthorized']));
        if (!function_exists('pj_db')) {
            echo json_encode(['success'=>false,'error'=>'project index not loaded']);
            return true;
        }

        $team = $_POST['team'] ?? 'all';
        $db = pj_db();

        $queued = [];
        $inProgress = [];
        $qa = [];
        $completedToday = [];
        $completedAny = [];
        $rejected = [];

        $today = date('Y-m-d');
        $cutoff = time() - (48 * 3600);

        // ── Query 1: Active statuses (small result set, no limit needed) ──
        $sqlActive = "
            SELECT id
            FROM p
            WHERE (
                (st IN ('queued','ready') AND (sa IS NULL OR sa=0)) OR
                (st IN ('processing','in_progress') AND (sa IS NOT NULL AND sa!=0)) OR
                (st='awaiting_review') OR
                (st='pending_rejection') OR
                (st='correction_needed')
            )
        ";
        if ($team !== 'all') $sqlActive .= " AND tm = :tm ";
        $sqlActive .= " ORDER BY COALESCE(pa, qa, ca, 0) ASC LIMIT 500";

        $stmtA = $db->prepare($sqlActive);
        if ($team !== 'all') $stmtA->bindValue(':tm', (string)$team, SQLITE3_TEXT);
        $resA = $stmtA->execute();

        $activeIds = [];
        while ($row = $resA->fetchArray(SQLITE3_ASSOC)) {
            $id = (string)($row['id'] ?? '');
            if ($id !== '') $activeIds[] = $id;
        }
        $resA->finalize();

        // ── Query 2: Completed (recent only, newest first) ──
        $sqlCompleted = "
            SELECT id
            FROM p
            WHERE st = 'completed'
              AND COALESCE(da, ua, ca, 0) >= :cutoff
        ";
        if ($team !== 'all') $sqlCompleted .= " AND tm = :tm ";
        $sqlCompleted .= " ORDER BY COALESCE(da, ua, ca, 0) DESC LIMIT 500";

        $stmtC = $db->prepare($sqlCompleted);
        $stmtC->bindValue(':cutoff', $cutoff, SQLITE3_INTEGER);
        if ($team !== 'all') $stmtC->bindValue(':tm', (string)$team, SQLITE3_TEXT);
        $resC = $stmtC->execute();

        $completedIds = [];
        while ($row = $resC->fetchArray(SQLITE3_ASSOC)) {
            $id = (string)($row['id'] ?? '');
            if ($id !== '') $completedIds[] = $id;
        }
        $resC->finalize();

        // ── Query 3: Rejected (recent only, newest first) ──
        $sqlRejected = "
            SELECT id
            FROM p
            WHERE st IN ('rejected','rejected_no_coverage')
              AND COALESCE(da, ca, 0) >= :cutoff
        ";
        if ($team !== 'all') $sqlRejected .= " AND tm = :tm ";
        $sqlRejected .= " ORDER BY COALESCE(da, ca, 0) DESC LIMIT 3000";

        $stmtR = $db->prepare($sqlRejected);
        $stmtR->bindValue(':cutoff', $cutoff, SQLITE3_INTEGER);
        if ($team !== 'all') $stmtR->bindValue(':tm', (string)$team, SQLITE3_TEXT);
        $resR = $stmtR->execute();

        $rejectedIds = [];
        while ($row = $resR->fetchArray(SQLITE3_ASSOC)) {
            $id = (string)($row['id'] ?? '');
            if ($id !== '') $rejectedIds[] = $id;
        }
        $resR->finalize();

        // ── Merge and dedupe IDs ──
        $allIds = array_unique(array_merge($activeIds, $completedIds, $rejectedIds));

        foreach ($allIds as $folder) {

            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = $baseDir . $folder . '/';
            $mp = $targetDir . 'manifest.json';
            if (!file_exists($mp)) continue;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) continue;

            $status = (string)($m['status'] ?? '');
            $teamId = (string)($m['team_id'] ?? 'default');
            if ($team !== 'all' && $teamId !== $team) continue;

            $item = [
                'id' => $folder,
                'address' => $m['address'] ?? '',
                'team_id' => $teamId,
                'created_at' => $m['created_at'] ?? '',
                'queued_at' => $m['queued_at'] ?? ($m['created_at'] ?? ''),
                'started_at' => $m['started_at'] ?? null,
                'qa_at' => $m['uploaded_at'] ?? ($m['qa_at'] ?? null),
                'completed_at' => $m['completed_at'] ?? null,
                'rejected_at' => $m['rejected_at'] ?? null,
                'assigned_to_email' => $m['assigned_to_email'] ?? null,
                'assigned_to_name' => $m['assigned_to_name'] ?? null,
                'owner' => $m['owner_email'] ?? 'Unknown',
                'reserved_to_email' => $m['reserved_to_email'] ?? null,
                'reserved_to_name'  => $m['reserved_to_name'] ?? null,
                'reserved_at'       => $m['reserved_at'] ?? null,
                'qa_claimed_by_email' => $m['qa_claimed_by_email'] ?? null,
                'qa_claimed_by_name'  => $m['qa_claimed_by_name'] ?? null,
                'qa_claimed_at'       => $m['qa_claimed_at'] ?? null,
                'thumbnail' => file_exists($targetDir.'google.png') ? (
                    (strpos($targetDir, '/saves/') !== false) ? 'saves/'.$folder.'/google.png' :
                    ((strpos($targetDir, '/tutorials/master/') !== false) ? 'tutorials/master/'.$folder.'/google.png' :
                     ('tutorials/'.basename(dirname($targetDir)).'/'.$folder.'/google.png'))
                ) : null,
                'processed_at' => $m['processed_at'] ?? null,
                'status' => $status,
                'complexity' => $m['complexity'] ?? 'complex',
                'is_filler' => !empty($m['is_filler']),
                'is_vip' => !empty($m['is_vip']),
                'project_type' => $m['project_type'] ?? 'residential',
                'pins' => $m['pins'] ?? [],
                'pin_count' => (isset($m['pins']) && is_array($m['pins']) && count($m['pins']) > 0) ? count($m['pins']) : 1,
                'cc_emails' => $m['cc_emails'] ?? [],
                'rejection_reason' => $m['rejection_reason'] ?? null,
                'rejection_note' => $m['rejection_note'] ?? null,
                'rejected_by' => $m['rejected_by'] ?? null,
            ];

            $item['email_summary'] = projectGetEmailSummary($m);

            if (in_array($status, ['queued','ready'], true) && empty($item['started_at'])) {
                $queued[] = $item;
            } elseif (in_array($status, ['processing','in_progress'], true) && !empty($item['started_at'])) {
                $inProgress[] = $item;
            } elseif ($status === 'awaiting_review') {
                $qa[] = $item;
            } elseif (in_array($status, ['rejected','rejected_no_coverage'], true)) {
                $rAt = (string)($item['rejected_at'] ?? $item['created_at'] ?? '');
                if ($rAt !== '') {
                    $t = safeParseTs($rAt);
                    if ($t > 0 && $t >= $cutoff) $rejected[] = $item;
                }
            } elseif ($status === 'completed') {
                $cAt = (string)($item['completed_at'] ?? '');
                if ($cAt !== '') {
                    $t = safeParseTs($cAt);
                    if ($t > 0 && $t >= $cutoff) $completedAny[] = $item;
                    if (strpos($cAt, $today) === 0) $completedToday[] = $item;
                }
            }
        }

        usort($queued, function($a, $b){
            $ta = safeParseTs($a['processed_at'] ?? $a['queued_at'] ?? '');
            $tb = safeParseTs($b['processed_at'] ?? $b['queued_at'] ?? '');
            return $ta <=> $tb;
        });
        usort($inProgress, function($a, $b){
            return safeParseTs($a['started_at'] ?? '') <=> safeParseTs($b['started_at'] ?? '');
        });
        usort($qa, function($a, $b){
            return safeParseTs($a['qa_at'] ?? '') <=> safeParseTs($b['qa_at'] ?? '');
        });
        usort($completedToday, function($a, $b){
            return safeParseTs($b['completed_at'] ?? '') <=> safeParseTs($a['completed_at'] ?? '');
        });
        usort($completedAny, function($a, $b){
            return safeParseTs($b['completed_at'] ?? '') <=> safeParseTs($a['completed_at'] ?? '');
        });
        usort($rejected, function($a, $b){
            return safeParseTs($b['rejected_at'] ?? $b['created_at'] ?? '') <=> safeParseTs($a['rejected_at'] ?? $a['created_at'] ?? '');
        });

        if (count($completedAny) > 300) $completedAny = array_slice($completedAny, 0, 300);
        if (count($rejected) > 200) $rejected = array_slice($rejected, 0, 200);

        echo json_encode([
            'success' => true,
            'queued' => $queued,
            'in_progress' => $inProgress,
            'qa' => $qa,
            'completed_today' => $completedToday,
            'completed_any' => $completedAny,
            'rejected' => $rejected
        ]);
        return true;
    }
    
    // ------------------------------------------------
    // -------- FETCH ALL PROJECTS (ADMIN) -----------
    // ------------------------------------------------
    // Single directory scan returning all projects. Used by the Customers
    // admin page instead of N individual fetch_user_projects calls.
    if ($action === 'fetch_all_projects') {
        if (!isAdmin() && !userHasPerm($_SESSION['user_email'] ?? '', 'manage_users')) {
            die(json_encode(['error' => 'Unauthorized']));
        }

        $projects = [];

        foreach (scandir($baseDir) as $folder) {
            if ($folder === '.' || $folder === '..') continue;
            $mp = $baseDir . $folder . '/manifest.json';
            if (!file_exists($mp)) continue;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) continue;

            $projects[] = [
                'id'           => $folder,
                'address'      => $m['address'] ?? '',
                'status'       => $m['status'] ?? 'queued',
                'created_at'   => $m['created_at'] ?? '',
                'completed_at' => $m['completed_at'] ?? null,
                'owner_email'  => $m['owner_email'] ?? '',
                'issuer'       => $m['issuer'] ?? [],
                'resident'     => $m['resident'] ?? [],
            ];
        }

        echo json_encode(['success' => true, 'projects' => $projects]);
        return true;
    }


    // ------------------------------------------------
    // ---------------- LIST PROJECTS ----------------
    // ------------------------------------------------
    if ($action === 'list_projects') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['projects' => [], 'error' => 'Not logged in']);
            return true;
        }

        if (!function_exists('pj_db')) {
            echo json_encode(['projects' => [], 'error' => 'project index not loaded']);
            return true;
        }

        $email  = strtolower(trim((string)$_SESSION['user_email']));
        $filter = $_POST['filter'] ?? 'org';
        $search = trim((string)($_POST['search'] ?? ''));

        $me = readUserDataByEmail($email);
        $myTeamId = getUserTeamId($email);
        $myOrgId = ($me && !empty($me['organization_id'])) ? orgNormalizeId($me['organization_id']) : null;

        $canTeam = isAdmin() || userHasGlobalPerm($email, 'view_team_projects');
        $canAll  = isAdmin() || userHasGlobalPerm($email, 'view_all_projects');
        $canOrg  = ($myOrgId && userHasOrgPerm($email, $myOrgId, 'view_reports')) || isAdmin();

        if ($filter === 'all'  && !$canAll)  $filter = 'org';
        if ($filter === 'team' && !$canTeam) $filter = 'org';
        if ($filter === 'org'  && (!$canOrg || !$myOrgId)) $filter = 'mine';

        $projects = [];
        $seen = [];

        $buildProj = function($folder, $basePath, $relPrefix = null) use ($baseDir) {
            $mPath = $basePath . $folder . '/manifest.json';
            if (!file_exists($mPath)) return null;
            $m = json_decode(@file_get_contents($mPath), true);
            if (!is_array($m)) return null;

            $status = (string)($m['status'] ?? 'queued');
            $hasRep = file_exists($basePath.$folder.'/Report.pdf') && ($status === 'completed');

            $thumb = null;
            if (file_exists($basePath.$folder.'/google.png')) {
                if ($relPrefix !== null) $thumb = $relPrefix . $folder . '/google.png';
                else if (strpos($basePath, '/saves/') !== false) $thumb = 'saves/'.$folder.'/google.png';
            }

            $reportUrl = null;
            if ($hasRep) {
                if ($relPrefix !== null) $reportUrl = $relPrefix . $folder . '/Report.pdf';
                else $reportUrl = 'saves/'.$folder.'/Report.pdf';
            }

            return [
                'id' => $folder,
                'address' => $m['address'] ?? '',
                'components' => $m['components'] ?? [],
                'lat' => $m['lat'] ?? 0,
                'lng' => $m['lng'] ?? 0,
                'status' => $status,
                'complexity' => $m['complexity'] ?? 'complex',
                'is_filler' => !empty($m['is_filler']),
                'is_vip' => !empty($m['is_vip']),
                'created_at' => $m['created_at'] ?? '',
                'queued_at'  => $m['queued_at'] ?? ($m['created_at'] ?? ''),
                'owner' => $m['owner_email'] ?? null,
                'issuer' => $m['issuer']['name'] ?? ($m['issuer_name'] ?? ''),
                'issuer_email' => $m['issuer']['email'] ?? ($m['issuer_email'] ?? ''),
                'organization_id' => $m['organization_id'] ?? null,
                'team_id' => $m['team_id'] ?? 'default',
                'started_at'   => $m['started_at'] ?? null,
                'completed_at' => $m['completed_at'] ?? null,
                'assigned_to_email' => $m['assigned_to_email'] ?? null,
                'assigned_to_name'  => $m['assigned_to_name'] ?? null,
                'qa_paid_to_email' => $m['qa_paid_to_email'] ?? null,
                'qa_paid_to_name'  => $m['qa_paid_to_name'] ?? null,
                'qa_approved_by'      => $m['qa_approved_by'] ?? null,
                'qa_approved_by_name' => $m['qa_approved_by_name'] ?? null,
                'thumbnail' => $thumb,
                'has_report' => $hasRep,
                'report_url' => $reportUrl,
                'resident' => $m['resident']['name'] ?? '',
                'resident_email' => $m['resident']['email'] ?? '',
                'resident_phone' => $m['resident']['phone'] ?? '',
                'is_tutorial_instance' => $m['is_tutorial_instance'] ?? false,
                'original_master_id' => $m['original_master_id'] ?? null,
                'work_history' => (isset($m['work_history']) && is_array($m['work_history'])) ? $m['work_history'] : [],
                'qa_history'   => (isset($m['qa_history']) && is_array($m['qa_history'])) ? $m['qa_history'] : [],
                'project_type' => $m['project_type'] ?? 'residential',
                'pins' => $m['pins'] ?? [],
                'cc_emails' => $m['cc_emails'] ?? [],
                'tech_notes' => $m['tech_notes'] ?? null,
                'refund_issued' => !empty($m['refund_issued']),
                'refund_amount' => $m['refund_amount'] ?? null,
            ];
        };

        $db = pj_db();

        $fetchIds = function($sql, $bind = []) use ($db) {
            $stmt = $db->prepare($sql);
            foreach ($bind as $k => $v) $stmt->bindValue($k, $v, SQLITE3_TEXT);
            $res = $stmt->execute();
            $ids = [];
            while ($r = $res->fetchArray(SQLITE3_ASSOC)) {
                $id = (string)($r['id'] ?? '');
                if ($id !== '') $ids[] = $id;
            }
            $res->finalize();
            return $ids;
        };

        // ============================================================
        // NEW: Search mode — search across ALL accessible projects
        // ============================================================
        $isSearchMode = ($search !== '' && strlen($search) >= 2);

        if ($isSearchMode) {
            // Search ALL projects in the index (up to 5000), then filter by address match
            // We fetch all IDs and do manifest-level address matching since the index
            // may not have an address column.
            $searchLower = strtolower($search);

            // Determine scope: admin sees all, otherwise respect filter
            $scopeIds = [];

            if (isAdmin() || $canAll) {
                // Admin/all: search everything
                $scopeIds = $fetchIds("SELECT id FROM p ORDER BY COALESCE(ca,0) DESC LIMIT 5000");
            } elseif ($filter === 'org' && $myOrgId && $canOrg) {
                $scopeIds = $fetchIds(
                    "SELECT id FROM p WHERE org=:org ORDER BY COALESCE(ca,0) DESC LIMIT 5000",
                    [':org' => $myOrgId]
                );
            } elseif ($filter === 'team' && $canTeam) {
                $scopeIds = $fetchIds(
                    "SELECT id FROM p WHERE tm=:tm ORDER BY COALESCE(ca,0) DESC LIMIT 5000",
                    [':tm' => $myTeamId]
                );
            } else {
                // 'mine' filter — get user's projects + assigned projects
                // Assigned to me
                $assigned = $fetchIds(
                    "SELECT id FROM p WHERE asn=:me ORDER BY COALESCE(ca,0) DESC LIMIT 2000",
                    [':me' => $email]
                );
                // Owned by me (from user file)
                $userFile = $userDir . getUserFilename($email);
                $userProjects = [];
                if (file_exists($userFile)) {
                    $userData = json_decode(@file_get_contents($userFile), true);
                    $userProjects = $userData['projects'] ?? [];
                }
                $scopeIds = array_unique(array_merge($assigned, $userProjects));
            }

            // Now read manifests and filter by address
            foreach ($scopeIds as $folder) {
                if (isset($seen[$folder])) continue;

                $loc = locateProjectDir($folder);
                if (!$loc) $loc = $baseDir . $folder . '/';

                $mPath = $loc . 'manifest.json';
                if (!file_exists($mPath)) continue;

                $m = json_decode(@file_get_contents($mPath), true);
                if (!is_array($m)) continue;

                // Match against address (case-insensitive partial match)
                $addr = strtolower((string)($m['address'] ?? ''));
                $folderId = strtolower((string)($m['id'] ?? $folder));

                if (strpos($addr, $searchLower) === false && strpos($folderId, $searchLower) === false) {
                    continue;
                }

                $basePath = dirname($loc) . '/';
                $relPrefix = null;
                if (strpos($loc, '/tutorials/master/') !== false) $relPrefix = 'tutorials/master/';
                elseif (strpos($loc, '/tutorials/') !== false) $relPrefix = 'tutorials/' . basename(dirname($loc)) . '/';

                $p = $buildProj($folder, $basePath, $relPrefix);
                if ($p) {
                    $projects[] = $p;
                    $seen[$folder] = true;
                }
            }

        } else {
            // ============================================================
            // EXISTING: Normal filter-based project listing (unchanged)
            // ============================================================

            // -------- 1) Admin can see everything --------
            if (isAdmin()) {
                $ids = $fetchIds("SELECT id FROM p ORDER BY COALESCE(ca,0) DESC LIMIT 3000");
                foreach ($ids as $folder) {
                    if (isset($seen[$folder])) continue;
                    $p = $buildProj($folder, $baseDir, null);
                    if ($p) { $projects[] = $p; $seen[$folder] = true; }
                }
            }

            // -------- 2) Org-wide view --------
            if ($filter === 'org' && $myOrgId && ($canOrg || isAdmin())) {
                $ids = $fetchIds("SELECT id FROM p WHERE org=:org ORDER BY COALESCE(ca,0) DESC LIMIT 3000", [':org' => $myOrgId]);
                foreach ($ids as $folder) {
                    if (isset($seen[$folder])) continue;
                    $p = $buildProj($folder, $baseDir, null);
                    if ($p) { $projects[] = $p; $seen[$folder] = true; }
                }
            }

            // -------- 3) Team view --------
            if ($filter === 'team' && ($canTeam || isAdmin())) {
                $ids = $fetchIds("SELECT id FROM p WHERE tm=:tm ORDER BY COALESCE(ca,0) DESC LIMIT 3000", [':tm' => $myTeamId]);
                foreach ($ids as $folder) {
                    if (isset($seen[$folder])) continue;
                    $p = $buildProj($folder, $baseDir, null);
                    if ($p) { $projects[] = $p; $seen[$folder] = true; }
                }
            }

            // -------- 4) User-linked projects --------
            $userFile = $userDir . getUserFilename($email);
            if (file_exists($userFile)) {
                $userData = json_decode(@file_get_contents($userFile), true);
                $myProjectIds = $userData['projects'] ?? [];
                foreach ($myProjectIds as $folder) {
                    if (isset($seen[$folder])) continue;
                    $loc = locateProjectDir($folder);
                    if (!$loc) continue;

                    $basePath = dirname($loc) . '/';
                    $relPrefix = null;
                    if (strpos($loc, '/tutorials/master/') !== false) $relPrefix = 'tutorials/master/';
                    elseif (strpos($loc, '/tutorials/') !== false) $relPrefix = 'tutorials/' . basename(dirname($loc)) . '/';

                    $p = $buildProj($folder, $basePath, $relPrefix);
                    if ($p) { $projects[] = $p; $seen[$folder] = true; }
                }
            }

            // -------- 5) Apply filter semantics --------
            $projects = array_values(array_filter($projects, function($p) use ($filter, $email, $myTeamId, $myOrgId) {
                $me = strtolower(trim((string)$email));
                if ($filter === 'mine') {
                    $assigned = strtolower(trim((string)($p['assigned_to_email'] ?? '')));
                    $owner    = strtolower(trim((string)($p['owner'] ?? '')));
                    $issuerE  = strtolower(trim((string)($p['issuer_email'] ?? '')));

                    if (($assigned && $assigned === $me) || ($owner && $owner === $me) || ($issuerE && $issuerE === $me)) return true;

                    $wh = $p['work_history'] ?? [];
                    if (is_array($wh)) {
                        foreach ($wh as $ev) {
                            if (!is_array($ev)) continue;
                            if (($ev['event'] ?? '') !== 'qa_rejected') continue;
                            $w = strtolower(trim((string)($ev['worker_email'] ?? '')));
                            if ($w && $w === $me) return true;
                        }
                    }
                    return false;
                }
                if ($filter === 'team') return (($p['team_id'] ?? 'default') === $myTeamId);
                if ($filter === 'org') {
                    $pid = orgNormalizeId($p['organization_id'] ?? '');
                    return ($myOrgId && $pid === $myOrgId);
                }
                return true;
            }));
        }

        // Sort by created_at descending (applies to both search and non-search)
        usort($projects, function($a, $b) {
            return strtotime($b['created_at'] ?? '1970-01-01') - strtotime($a['created_at'] ?? '1970-01-01');
        });

        // -------- Status filter (viewer) --------
        $statusFilter = strtolower(trim((string)($_POST['status_filter'] ?? '')));
        if ($statusFilter && $statusFilter !== 'all') {
            $projects = array_values(array_filter($projects, function($p) use ($statusFilter) {
                $st = (string)($p['status'] ?? '');
                if ($statusFilter === 'rejected') return $st === 'rejected_no_coverage';
                if ($statusFilter === 'ready')    return !empty($p['has_report']) && $st !== 'rejected_no_coverage';
                if ($statusFilter === 'processing') return empty($p['has_report']) && $st !== 'rejected_no_coverage';
                return true;
            }));
        }

        // -------- Pagination --------
        $totalCount = count($projects);
        $page  = max(1, (int)($_POST['page']  ?? 1));
        $rawLimit = (int)($_POST['limit'] ?? 0);
        $limit = ($rawLimit > 0) ? min($rawLimit, 200) : 0;
        if ($limit > 0) {
            $totalPages = (int)ceil($totalCount / $limit);
            if ($page > $totalPages && $totalPages > 0) $page = $totalPages;
            $offset = ($page - 1) * $limit;
            $projects = array_slice($projects, $offset, $limit);
            echo json_encode([
                'projects'   => $projects,
                'filter'     => $filter,
                'search'     => $search ?: null,
                'pagination' => [
                    'current_page' => $page,
                    'total_pages'  => $totalPages,
                    'total_count'  => $totalCount,
                    'limit'        => $limit,
                ],
            ]);
        } else {
            echo json_encode(['projects' => $projects, 'filter' => $filter, 'search' => $search ?: null]);
        }
        return true;
    }


    // ------------------------------------------------
    // ---------------- QUEUE (CUSTOMER SUBMITS) -----
    // ------------------------------------------------
    if ($action === 'queue') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['error' => 'Please log in']));
        $userEmail = strtolower(trim((string)$_SESSION['user_email']));
        $address   = $_POST['address'] ?? '';
        $orgId = actorOrgIdByEmail($userEmail);
        if ($orgId && !isEmployeeUserByEmail($userEmail)) {
            if (!userHasOrgPerm($userEmail, $orgId, 'order_reports')) {
                die(json_encode(['success'=>false,'error'=>'Unauthorized']));
            }
        }
        $lat = $_POST['lat'] ?? null;
        $lng = $_POST['lng'] ?? null;
        $customCoords = $_POST['custom_coords'] ?? '0';
        $residentName  = $_POST['residentName'] ?? 'Resident';
        $residentEmail = $_POST['residentEmail'] ?? '';
        $residentPhone = $_POST['residentPhone'] ?? '';
        $isFillerInput = $_POST['is_filler'] ?? false;
        $isFiller = filter_var($isFillerInput, FILTER_VALIDATE_BOOLEAN);
        $issuerName  = $_POST['issuerName'] ?? ($_SESSION['user_name'] ?? 'System');
        $issuerEmail = $_POST['issuerEmail'] ?? $userEmail;
        $addrComponents = json_decode($_POST['address_components'] ?? '{}', true);
        if (!is_array($addrComponents)) $addrComponents = [];

        // ---- Project type, pins, CC emails ----
        $projectType = strtolower(trim((string)($_POST['project_type'] ?? 'residential')));
        $validTypes = ['residential', 'commercial', 'multifamily'];
        if (!in_array($projectType, $validTypes, true)) $projectType = 'residential';
        $includeGutterMeasurements = ($projectType === 'residential')
            ? filter_var($_POST['include_gutter_measurements'] ?? false, FILTER_VALIDATE_BOOLEAN)
            : false;

        $pinsRaw = json_decode($_POST['pins'] ?? '[]', true);
        $pins = [];
        if (is_array($pinsRaw)) {
            foreach ($pinsRaw as $pin) {
                if (is_array($pin) && isset($pin['lat']) && isset($pin['lng'])) {
                    $pins[] = [
                        'lat' => (float)$pin['lat'],
                        'lng' => (float)$pin['lng'],
                    ];
                }
            }
        }
        if (count($pins) > 15) $pins = array_slice($pins, 0, 15);

        // =====================================================
        //  Derive centroid + dynamic radius from pins + building bboxes
        // =====================================================
        $pinGeo = computeProjectGeometry(
            $pins,
            $GOOGLE_API_KEY,
            ($lat !== null && $lat !== '') ? (float)$lat : null,
            ($lng !== null && $lng !== '') ? (float)$lng : null
        );
        $pinRadius = (int)$pinGeo['radius'];

        // Only override lat/lng if multi-pin centroid was computed
        if ($pinGeo['lat'] !== null && $pinGeo['lng'] !== null) {
            $lat = $pinGeo['lat'];
            $lng = $pinGeo['lng'];
        }

        $ccEmailsRaw = json_decode($_POST['cc_emails'] ?? '[]', true);
        $ccEmails = [];
        if (is_array($ccEmailsRaw)) {
            foreach ($ccEmailsRaw as $cc) {
                $cc = strtolower(trim((string)$cc));
                if ($cc !== '' && strpos($cc, '@') !== false && !in_array($cc, $ccEmails, true)) {
                    $ccEmails[] = $cc;
                }
            }
        }
        if (count($ccEmails) > 10) $ccEmails = array_slice($ccEmails, 0, 10);

        $techNotes = trim((string)($_POST['tech_notes'] ?? ''));

        if (!$address) die(json_encode(['error' => 'No address']));
        $folder = getFolder($address);
        $targetDir = $baseDir . $folder . '/';

        if (file_exists($targetDir . 'manifest.json')) {
            $folder = md5($address . '_' . bin2hex(random_bytes(8)));
            $targetDir = $baseDir . $folder . '/';
        }
        if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);
        $userFile = $userDir . getUserFilename($userEmail);
        if (file_exists($userFile)) {
            $uData = json_decode(file_get_contents($userFile), true);
            if (!is_array($uData)) $uData = [];
            if (!isset($uData['projects']) || !is_array($uData['projects'])) $uData['projects'] = [];
            if (!in_array($folder, $uData['projects'], true)) {
                $uData['projects'][] = $folder;
                if (function_exists('atomicWriteJson')) atomicWriteJson($userFile, $uData);
                else file_put_contents($userFile, json_encode($uData, JSON_PRETTY_PRINT));
            }
        }
//         if (file_exists($targetDir . 'manifest.json')) {
//             echo json_encode(['success' => true, 'folder' => $folder, 'message' => 'Project loaded from archives']);
//             return true;
//         }
        $isEmployee = isEmployeeUserByEmail($userEmail);
        if (!$isEmployee) {
            // Per-structure pricing for commercial & multifamily
            $pinCountForPricing = max(1, count($pins));
            if (in_array($projectType, ['commercial', 'multifamily'], true)) {
                $roofCost = projectTypePrice($projectType) * $pinCountForPricing;
            } else {
                $roofCost = projectTypePrice($projectType) + ($includeGutterMeasurements ? PORTAL_GUTTER_REPORT_ADDON : 0);
            }

            $spend = creditsSpendByEmail($userEmail, $roofCost, 'order_submitted', [
                'address'      => $address,
                'roof_cost'    => $roofCost,
                'project_type' => $projectType,
                'include_gutter_measurements' => $includeGutterMeasurements,
            ]);
            if (!empty($spend['ok']) && (($spend['scope'] ?? '') === 'org')) {
                $balNow = (int)($spend['new_balance'] ?? 0);
                if ($balNow <= 0) {
                    $bal = creditsGetBalanceByEmail($userEmail);
                    $balNow = (int)($bal['balance'] ?? 0);
                }
                $orgId = (string)($spend['org_id'] ?? '');
                if ($orgId !== '') {
                    withStripeLock(function() use ($orgId, $userEmail, $balNow, $roofCost, $address, $includeGutterMeasurements) {
                        orgAutoTopupTry($orgId, $userEmail, $balNow, [
                            'reason'=>'order_submitted',
                            'roof_cost'=>$roofCost,
                            'address'=>$address,
                            'include_gutter_measurements' => $includeGutterMeasurements,
                        ]);
                        return true;
                    });
                }
            }
            if (empty($spend['ok'])) {
                $bal = creditsGetBalanceByEmail($userEmail);
                $have = (int)($bal['balance'] ?? 0);
                echo json_encode(['success'=>false,'error'=>"Insufficient credit. This order costs \$$roofCost. You have \$$have. Please add credit to submit an order."]);
                return true;
            }
        }
        $sobEmail = strtolower(trim((string)($_POST['_submit_on_behalf_of'] ?? '')));
        $orgSourceEmail = ($sobEmail !== '') ? $sobEmail : (($issuerEmail !== '') ? strtolower(trim($issuerEmail)) : $userEmail);
        $projectOrgId = function_exists('actorOrgIdByEmail') ? (actorOrgIdByEmail($orgSourceEmail) ?: null) : null;
        $isVip = (bool)filter_var($_POST['is_vip'] ?? false, FILTER_VALIDATE_BOOLEAN);
        if (!$isVip && !$isFiller) {
            $isVip = projectShouldAutoVip($projectOrgId);
        }
        // Temporary: force VIP for all non-test org projects when toggle is on
        if (FORCE_VIP_NON_TEST_ORGS && !$isVip && !$isFiller) {
            $orgForVipCheck = $projectOrgId ? orgRead($projectOrgId) : null;
            if (!$orgForVipCheck || empty($orgForVipCheck['is_test'])) {
                $isVip = true;
            }
        }

        $now = date('Y-m-d H:i:s');
        $manifest = [
            'id' => $folder,
            'owner_email' => $userEmail,
            'organization_id' => $projectOrgId,
            'address' => $address,
            'components' => $addrComponents,
            'lat' => $lat,
            'lng' => $lng,
            'is_custom_pin' => ($customCoords == '1'),
            'created_at' => $now,
            'queued_at'  => $now,
            'is_filler' => $isFiller,
            'is_vip' => $isVip,
            'team_id'   => getUserTeamId($userEmail),
            'amount_charged' => $isEmployee ? 0 : (in_array($projectType, ['commercial', 'multifamily'], true) ? projectTypePrice($projectType) * max(1, count($pins)) : projectTypePrice($projectType) + ($includeGutterMeasurements ? PORTAL_GUTTER_REPORT_ADDON : 0)),
            'include_gutter_measurements' => $includeGutterMeasurements,
            'resident' => ['name' => $residentName, 'email' => $residentEmail, 'phone' => $residentPhone],
            'issuer'   => ['name' => $issuerName, 'email' => $issuerEmail],
            'status' => 'queued',
            'project_type' => $projectType,
            'pins' => $pins,
            'cc_emails' => $ccEmails,
            'tech_notes' => ($techNotes !== '') ? $techNotes : null,
            'radius_meters' => $pinRadius,
            'app_metadata' => []
        ];
        saveManifest($targetDir . 'manifest.json', $manifest);
        ob_start();
        echo json_encode(['success' => true, 'folder' => $folder]);
        $size = ob_get_length();
        header("Content-Length: {$size}");
        header("Connection: close");
        ob_end_flush();
        @ob_flush();
        flush();
        if (session_id()) session_write_close();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        }
        $mForNotify = $manifest;
        // Skip notification email for test organizations
        // Skip notification email for test organizations
        if (!projectIsTestOrg($mForNotify)) {
            opsNotifyNewRequest($targetDir, $mForNotify);
        }
        processProjectApis($targetDir, $address, $GOOGLE_API_KEY, $GEMINI_API_KEY, $lat, $lng, $pinRadius);
        return true;
    }


    // ------------------------------------------------
    // ---------------- CHECK ------------------------
    // ------------------------------------------------
    if ($action === 'check') {
        $address = $_POST['address'] ?? '';
        if (!$address) die(json_encode(['error' => 'No address']));
        $folder = getFolder($address);
        if (file_exists($baseDir . $folder . '/manifest.json')) echo json_encode(['exists' => true, 'folder' => $folder]);
        else echo json_encode(['exists' => false, 'folder' => $folder]);
        return true;
    }
    // ------------------------------------------------
    // ---------------- LOAD -------------------------
    // ------------------------------------------------
    if ($action === 'load') {
        if (!isset($_SESSION['user_email'])) { http_response_code(403); die(json_encode(['error'=>'Not logged in'])); }
        $folder = preg_replace('/[^a-f0-9]/', '', $_POST['folder'] ?? '');
        if ($folder === '') { http_response_code(400); die(json_encode(['error'=>'Missing folder'])); }
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        if (!file_exists($targetDir . 'manifest.json')) { http_response_code(404); return true; }
        $manifest = json_decode(file_get_contents($targetDir . 'manifest.json'), true);
        if (!is_array($manifest)) $manifest = [];
        $meEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $meOrgId = actorOrgIdByEmail($meEmail);
        $projOrg = orgNormalizeId($manifest['organization_id'] ?? '');
        $ok = true;
        if (isAdmin()) $ok = true;
        else if (isAuthorized($folder)) $ok = true;
        else if ($meOrgId && $projOrg && $meOrgId === $projOrg && userHasOrgPerm($meEmail, $meOrgId, 'view_reports')) $ok = true;
        if (!$ok) { http_response_code(403); die(json_encode(['error'=>'Unauthorized'])); }
        $insights = file_exists($targetDir . 'insights.json') ? json_decode(file_get_contents($targetDir . 'insights.json'), true) : null;
        $assets = [];
        $files = scandir($targetDir);
        $relPath = '';
        if (strpos($targetDir, '/saves/') !== false) $relPath = 'saves/' . $folder . '/';
        elseif (strpos($targetDir, '/tutorials/master/') !== false) $relPath = 'tutorials/master/' . $folder . '/';
        else {
            $userSafe = basename(dirname($targetDir));
            $relPath = 'tutorials/' . $userSafe . '/' . $folder . '/';
        }
        foreach ($files as $f) {
            if ($f === '.' || $f === '..') continue;
            if (pathinfo($f, PATHINFO_EXTENSION) === 'json') continue;
            $assets[pathinfo($f, PATHINFO_FILENAME)] = $relPath . $f;
        }
        $orgData = null;
        $orgId = $manifest['organization_id'] ?? null;
        if (!$orgId && !empty($manifest['owner_email'])) {
            $u = readUserDataByEmail($manifest['owner_email']);
            $orgId = $u['organization_id'] ?? null;
        }
        if ($orgId) {
            $org = orgRead($orgId);
            if ($org) {
                $orgData = [
                    'id' => $orgId,
                    'name' => $org['name'] ?? '',
                    'branding' => $org['branding'] ?? null,
                    'report_settings' => $org['report_settings'] ?? []
                ];
            }
        }
        // Load app_metadata from separate file
        $appMeta = null;
        $appMetaPath = $targetDir . 'app_metadata.json';
        if (file_exists($appMetaPath)) {
            $appMeta = json_decode(@file_get_contents($appMetaPath), true);
        } elseif (isset($manifest['app_metadata']) && is_array($manifest['app_metadata'])) {
            $appMeta = $manifest['app_metadata'];
        }

        // Strip app_metadata from manifest response
        $manifestClean = $manifest;
        unset($manifestClean['app_metadata']);

        echo json_encode([
            'manifest'     => $manifestClean,
            'insights'     => $insights,
            'assets'       => $assets,
            'organization' => $orgData,
            'app_metadata' => $appMeta
        ]);
        return true;
    }
    // ------------------------------------------------
    // ---------------- SAVE -------------------------
    // ------------------------------------------------
    if ($action === 'save') {
        $fid = $_POST['folder'] ?? '';
        if (!$fid && isset($_POST['address'])) $fid = getFolder($_POST['address']);
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) {
            if (!isAuthorized($folder)) { 
//                 http_response_code(403); 
//                 die(json_encode(['error' => 'Unauthorized']));
            }
            $targetDir = $baseDir . $folder . '/';
            if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);
        } else {
            if (!isAuthorized($folder) && !isAdmin()) { http_response_code(403); die(json_encode(['error' => 'Unauthorized'])); }
        }
        if (strpos($targetDir, '/tutorials/master/') !== false && !isAdmin()) {
            die(json_encode(['error' => 'Only admins can edit Master Templates']));
        }
        $currentData = [];
        if (file_exists($targetDir . 'manifest.json')) $currentData = json_decode(file_get_contents($targetDir . 'manifest.json'), true);
        if (!is_array($currentData)) $currentData = [];
        $newMeta = json_decode($_POST['metadata'] ?? '{}', true);

        // Write app_metadata to its own file (keeps manifest lean)
        if (is_array($newMeta) && !empty($newMeta)) {
            @file_put_contents(
                $targetDir . 'app_metadata.json',
                json_encode($newMeta, JSON_PRETTY_PRINT)
            );
        }

        // Strip from manifest and save
        unset($currentData['app_metadata']);
        saveManifest($targetDir . 'manifest.json', $currentData);
        if (!empty($_FILES)) {
            foreach ($_FILES as $key => $file) {
                $ext = pathinfo($file['name'], PATHINFO_EXTENSION) ?: 'png';
                move_uploaded_file($file['tmp_name'], $targetDir . $key . '.' . $ext);
            }
        }
        echo json_encode(['success' => true, 'folder' => $folder]);
        return true;
    }
    // ------------------------------------------------
    // ---------------- NEXT QUEUE (LEGACY) ----------
    // ------------------------------------------------
    if ($action === 'next_queue') {
        $exclude = $_POST['exclude'] ?? '';
        $readyCandidate = null;
        foreach (scandir($baseDir) as $folder) {
            if ($folder === '.' || $folder === '..') continue;
            $mp = $baseDir . $folder . '/manifest.json';
            if (file_exists($mp)) {
                $d = json_decode(file_get_contents($mp), true);
                $status = $d['status'] ?? '';
                if ($exclude && trim($d['address'] ?? '') === trim($exclude)) continue;
                if ($status === 'correction_needed') {
                    echo json_encode(['found' => true, 'folder' => $folder, 'address' => $d['address'], 'resident' => $d['resident']['name'] ?? '']);
                    return true;
                }
                if ($status === 'ready' && !$readyCandidate) {
                    $readyCandidate = ['folder' => $folder, 'address' => $d['address'], 'resident' => $d['resident']['name'] ?? ''];
                }
            }
        }
        if ($readyCandidate) { echo json_encode(array_merge(['found' => true], $readyCandidate)); return true; }
        echo json_encode(['found' => false]);
        return true;
    }
    // ------------------------------------------------
    // ---------------- MARK COMPLETE / SET STATUS ---
    // ------------------------------------------------
    if ($action === 'mark_complete' || $action === 'set_status') {
        $fid = $_POST['folder'] ?? '';
        if (!$fid && isset($_POST['address'])) $fid = getFolder($_POST['address']);
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        if (!isAuthorized($folder) && !isAdmin()) die(json_encode(['error' => 'Unauthorized']));
        $mp = $targetDir . 'manifest.json';
        if (file_exists($mp)) {
            $d = json_decode(file_get_contents($mp), true);
            if (!is_array($d)) $d =[];
            if ($action === 'mark_complete') {
                $currentStatus = (string)($d['status'] ?? '');
                if ($currentStatus === 'awaiting_manager_review') {
                    // no-op: stay in manager review
                } elseif ($currentStatus === 'awaiting_review') {
                    // no-op: stay in QA review — editor saves must not disrupt an active review
                } elseif (!empty($d['is_vip']) && !empty($d['qa_reviewed_at'])) {
                    $d['status'] = 'awaiting_manager_review';
                } else {
                    $d['status'] = 'awaiting_review';
                }
            } else {
                $rawStatus = $_POST['status'] ?? '';
                if ($rawStatus) {
                    $newStatus = strtolower(str_replace(' ', '_', trim($rawStatus)));
                    $currentStatus = (string)($d['status'] ?? '');

                    // Guard: don't let editor saves regress review/terminal states
                    // back to production. QA and manager actions use their own
                    // dedicated handlers (qa_decision, manager_decision) which
                    // bypass this path entirely.
                    $protectedStates  = ['awaiting_review', 'awaiting_manager_review',
                                         'completed', 'rejected_no_coverage', 'rejected'];
                    $productionStates = ['processing', 'in_progress', 'queued',
                                         'ready', 'generating_filler'];

                    if (in_array($currentStatus, $protectedStates, true)
                        && in_array($newStatus, $productionStates, true)) {
                        error_log("set_status: blocked regression from '{$currentStatus}' to '{$newStatus}' folder={$folder}");
                        // silently keep current status
                    } else {
                        $d['status'] = $newStatus;
                    }
                }
            }
            saveManifest($mp, $d);
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Not found']);
        }
        return true;
    }
    // ------------------------------------------------
    // ---------------- UPLOAD REPORT ----------------
    // ------------------------------------------------
    if ($action === 'upload_report') {
        $fid = $_POST['folder'] ?? '';
        if (!$fid && isset($_POST['address'])) $fid = getFolder($_POST['address']);
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        if (!isAuthorized($folder) && !isAdmin()) die(json_encode(['error' => 'Unauthorized']));
        if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);
        if (move_uploaded_file($_FILES['pdf_file']['tmp_name'], $targetDir . 'Report.pdf')) {
            $mp = $targetDir . 'manifest.json';
            if (file_exists($mp)) {
                $m = json_decode(file_get_contents($mp), true);
                manifestEnsureWorkHistory($m);
                $m['work_history'][] =[
                    'ts' => date('c'),
                    'event' => 'submitted_for_qa',
                    'worker_email' => $m['assigned_to_email'] ?? null,
                    'worker_name'  => $m['assigned_to_name'] ?? null,
                ];
                if (!is_array($m)) $m = [];
                
                // If already in manager review, preserve that status —
                // only the explicit manager_decision action can move it out.
                $currentStatus = (string)($m['status'] ?? '');
                if ($currentStatus === 'awaiting_manager_review') {
                    // no-op: stay in manager review
                } elseif ($currentStatus === 'awaiting_review') {
                    // no-op: stay in QA review — re-upload during review must not reset status
                } elseif (!empty($m['is_vip']) && !empty($m['qa_reviewed_at'])) {
                    $m['status'] = 'awaiting_manager_review';
                } else {
                    $m['status'] = 'awaiting_review';
                }
                
                $m['uploaded_at'] = date('Y-m-d H:i:s');
                // Skip QA notification for test organizations
                if (!projectIsTestOrg($m)) {
                    opsNotifyNewQaItem($targetDir, $m);
                }
                saveManifest($mp, $m);
            }
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Save failed']);
        }
        return true;
    }
    // ------------------------------------------------
    // ---------------- UPLOAD SUMMARY ---------------
    // ------------------------------------------------
    if ($action === 'upload_summary') {
        $fid = $_POST['folder'] ?? '';
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        if (!isAuthorized($folder) && !isAdmin()) die(json_encode(['error' => 'Unauthorized']));
        if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);
        if (move_uploaded_file($_FILES['pdf_file']['tmp_name'], $targetDir . 'Summary.pdf')) {
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Save failed']);
        }
        return true;
    }
    // ------------------------------------------------
    // ---------------- QA QUEUE ----------------------
    // ------------------------------------------------
    if ($action === 'qa_queue') {
        if (!isAdmin() && !canQAUser()) die(json_encode(['error' => 'Unauthorized']));
        $currentQaEmail = strtolower(trim($_SESSION['user_email'] ?? ''));

        if ($currentQaEmail) updateUserActivity($currentQaEmail);

        if (!function_exists('pj_db')) {
            echo json_encode(['success'=>false,'error'=>'project index not loaded']);
            return true;
        }

        $db = pj_db();

        $pending = [];
        $history = [];

        // Pull pending awaiting_review from index (oldest first)
        $stmtP = $db->prepare("
            SELECT id
            FROM p
            WHERE st IN ('awaiting_review','pending_rejection')
            ORDER BY COALESCE(ua, ca, qa, 0) ASC
            LIMIT 1000
        ");
        $resP = $stmtP->execute();
        while ($row = $resP->fetchArray(SQLITE3_ASSOC)) {
            $folder = (string)($row['id'] ?? '');
            if ($folder === '') continue;

            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = $baseDir . $folder . '/';
            $mp = $targetDir . 'manifest.json';
            if (!file_exists($mp)) continue;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) continue;

            $availability = isQaItemAvailableToUser($m, $currentQaEmail);

            $item = [
                'id' => $folder,
                'address' => $m['address'] ?? 'Unknown',
                'resident' => $m['resident']['name'] ?? '-',
                'issuer' => $m['issuer']['name'] ?? ($m['issuer_name'] ?? 'System'),
                'issuer_email' => $m['issuer']['email'] ?? ($m['issuer_email'] ?? null),
                'assigned_to_name' => $m['assigned_to_name'] ?? null,
                'assigned_to_email' => $m['assigned_to_email'] ?? null,
                'date' => $m['uploaded_at'] ?? ($m['created_at'] ?? ''),
                'created_at' => $m['created_at'] ?? null,
                'queued_at' => $m['queued_at'] ?? null,
                'started_at' => $m['started_at'] ?? null,
                'uploaded_at' => $m['uploaded_at'] ?? null,
                'completed_at' => $m['completed_at'] ?? null,
                'team_id' => $m['team_id'] ?? 'default',
                'complexity' => $m['complexity'] ?? null,
                'is_filler' => !empty($m['is_filler']),
                'is_vip' => !empty($m['is_vip']),
                'status' => $m['status'] ?? 'awaiting_review',
                'qa_claimed_by_email' => $m['qa_claimed_by_email'] ?? null,
                'qa_claimed_by_name'  => $m['qa_claimed_by_name'] ?? null,
                'qa_claimed_at'       => $m['qa_claimed_at'] ?? null,
                'project_type' => $m['project_type'] ?? 'residential',
                'pins' => $m['pins'] ?? [],
                'cc_emails' => $m['cc_emails'] ?? [],
            ];

            if (!empty($availability['available'])) {
                $item['qa_available'] = true;
                $item['qa_availability_reason'] = $availability['reason'];
                $pending[] = $item;
            } else {
                // Show locked items to all QA users so they can see who's reviewing what
                $item['qa_available'] = false;
                $item['qa_availability_reason'] = $availability['reason'];
                $item['hidden_from_queue'] = true;
                $pending[] = $item;
            }
        }
        $resP->finalize();

        // Pull recent history (completed/correction_needed/processing) from index, newest first
        $stmtH = $db->prepare("
            SELECT id
            FROM p
            WHERE st IN ('completed','correction_needed','processing')
            ORDER BY COALESCE(da, ua, sa, ca, 0) DESC
            LIMIT 3000
        ");
        $resH = $stmtH->execute();
        while ($row = $resH->fetchArray(SQLITE3_ASSOC)) {
            $folder = (string)($row['id'] ?? '');
            if ($folder === '') continue;

            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = $baseDir . $folder . '/';
            $mp = $targetDir . 'manifest.json';
            if (!file_exists($mp)) continue;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) continue;

            $history[] = [
                'id' => $folder,
                'address' => $m['address'] ?? 'Unknown',
                'resident' => $m['resident']['name'] ?? '-',
                'issuer' => $m['issuer']['name'] ?? ($m['issuer_name'] ?? 'System'),
                'issuer_email' => $m['issuer']['email'] ?? ($m['issuer_email'] ?? null),
                'assigned_to_name' => $m['assigned_to_name'] ?? null,
                'assigned_to_email' => $m['assigned_to_email'] ?? null,
                'date' => $m['uploaded_at'] ?? ($m['created_at'] ?? ''),
                'created_at' => $m['created_at'] ?? null,
                'queued_at' => $m['queued_at'] ?? null,
                'started_at' => $m['started_at'] ?? null,
                'uploaded_at' => $m['uploaded_at'] ?? null,
                'completed_at' => $m['completed_at'] ?? null,
                'team_id' => $m['team_id'] ?? 'default',
                'complexity' => $m['complexity'] ?? null,
                'is_filler' => !empty($m['is_filler']),
                'is_vip' => !empty($m['is_vip']),
                'status' => $m['status'] ?? '',
                'qa_claimed_by_email' => $m['qa_claimed_by_email'] ?? null,
                'qa_claimed_by_name'  => $m['qa_claimed_by_name'] ?? null,
                'qa_claimed_at'       => $m['qa_claimed_at'] ?? null,
                'project_type' => $m['project_type'] ?? 'residential',
            ];
        }
        $resH->finalize();

        // Keep existing semantics: pending oldest first, history newest first
        usort($pending, function($a, $b) { return strtotime($a['date'] ?? '') - strtotime($b['date'] ?? ''); });
        usort($history, function($a, $b) { return strtotime($b['date'] ?? '') - strtotime($a['date'] ?? ''); });

        echo json_encode([
            'success' => true,
            'pending' => $pending,
            'history' => array_slice($history, 0, 50)
        ]);
        return true;
    }
    
    // ------------------------------------------------
    // ---------------- STATS DATA (LIGHTWEIGHT) -----
    // ------------------------------------------------
    // Returns all completed projects with only the fields stats.js needs,
    // queried entirely from the SQL index — zero manifest file reads.
    if ($action === 'stats_data') {
        if (!isAdmin() && !isQueueAdminUser()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        if (!function_exists('pj_db')) {
            die(json_encode(['success' => false, 'error' => 'project index not loaded']));
        }

        $db = pj_db();

        $stmt = $db->prepare("
            SELECT id, ca, da, sa, ua, asn, fl, tm, org, cx
            FROM p
            WHERE st = 'completed'
            ORDER BY da DESC
        ");
        $res = $stmt->execute();

        $rows = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $rows[] = $row;
        }
        $res->finalize();

        $projects = [];
        foreach ($rows as $row) {
            $folder = (string)$row['id'];
            if ($folder === '') continue;

            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = rtrim($baseDir, '/\\') . '/' . $folder . '/';
            $mp = $targetDir . 'manifest.json';

            $m = file_exists($mp) ? (json_decode(@file_get_contents($mp), true) ?: []) : [];

            $projects[] = [
                'id'                => $folder,
                'status'            => 'completed',
                'created_at'        => $row['ca'] ? date('Y-m-d H:i:s', (int)$row['ca']) : null,
                'completed_at'      => $row['da'] ? date('Y-m-d H:i:s', (int)$row['da']) : null,
                'started_at'        => $row['sa'] ? date('Y-m-d H:i:s', (int)$row['sa']) : null,
                'uploaded_at'       => $row['ua'] ? date('Y-m-d H:i:s', (int)$row['ua']) : null,
                'assigned_to_email' => $row['asn'] ?: null,
                'is_filler'         => !empty($row['fl']),
                'is_test_org'       => projectIsTestOrg($m),

                // ── NEW: service type & pricing ──
                'project_type'      => $m['project_type']  ?? 'residential',
                'amount_charged'    => isset($m['amount_charged']) ? (float)$m['amount_charged'] : null,
                'pin_count'         => isset($m['pins']) && is_array($m['pins']) ? count($m['pins']) : 1,

                'team_id'           => $row['tm'] ?: 'default',
                'organization_id'   => $row['org'] ?: null,
                'complexity'        => $row['cx'] ?: 'complex',

                // QA bonus fields
                'qa_reject_count'   => isset($m['qa_reject_count']) ? (int)$m['qa_reject_count'] : null,
                'qa_history'        => $m['qa_history'] ?? [],
                'work_history'      => $m['work_history'] ?? [],
            ];
        }

        echo json_encode([
            'success'  => true,
            'projects' => $projects,
            'count'    => count($projects),
        ]);
        return true;
    }


    // ------------------------------------------------
    // ---------------- SAVE IMAGE -------------------
    // ------------------------------------------------
    if ($action === 'save_image') {
        $fid = $_POST['folder'] ?? '';
        if (!$fid && isset($_POST['address'])) $fid = getFolder($_POST['address']);
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        if (!isAuthorized($folder) && !isAdmin()) { http_response_code(403); die(json_encode(['error' => 'Unauthorized'])); }
        if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);
        if (isset($_FILES['image_file'])) {
            $filename = preg_replace('/[^a-zA-Z0-9_-]/', '', $_POST['filename'] ?? 'image');
            move_uploaded_file($_FILES['image_file']['tmp_name'], $targetDir . $filename . '.png');
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'No file received']);
        }
        return true;
    }
    // ------------------------------------------------
    // ---------------- FETCH MASK -------------------
    // ------------------------------------------------
    if ($action === 'fetch_mask') {
        $fid = $_POST['folder'] ?? '';
        $folder = preg_replace('/[^a-f0-9]/', '', $fid);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        if (!isAuthorized($folder) && !isAdmin()) { http_response_code(403); die(json_encode(['success'=>false,'error'=>'Unauthorized'])); }
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) die(json_encode(['success'=>false,'error'=>'Manifest not found']));
        $maskPath = $targetDir . 'mask.tif';
        $relPath = '';
        if (strpos($targetDir, '/saves/') !== false) $relPath = 'saves/' . $folder . '/';
        elseif (strpos($targetDir, '/tutorials/master/') !== false) $relPath = 'tutorials/master/' . $folder . '/';
        else {
            $userSafe = basename(dirname($targetDir));
            $relPath = 'tutorials/' . $userSafe . '/' . $folder . '/';
        }
        if (file_exists($maskPath)) {
            echo json_encode(['success' => true, 'already' => true, 'url' => $relPath . 'mask.tif']);
            return true;
        }
        $m = json_decode(file_get_contents($mp), true);
        $lat = $m['lat'] ?? null;
        $lng = $m['lng'] ?? null;
        if (!$lat || !$lng) die(json_encode(['success'=>false,'error'=>'Missing coords']));
        $radius = 20;
        if (isset($m['app_metadata']['radius_meters'])) $radius = (int)$m['app_metadata']['radius_meters'];
        $layersUrl = "https://solar.googleapis.com/v1/dataLayers:get?location.latitude=$lat&location.longitude=$lng&radius_meters=$radius&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS&requiredQuality=LOW&key=".$GLOBALS['GOOGLE_API_KEY'];
        $layersJson = fetchUrl($layersUrl);
        if (!$layersJson) die(json_encode(['success'=>false,'error'=>'API failed']));
        $layersData = json_decode($layersJson, true);
        if (empty($layersData['maskUrl'])) die(json_encode(['success'=>false,'error'=>'No mask URL']));
        downloadFile($layersData['maskUrl'] . "&key=".$GLOBALS['GOOGLE_API_KEY'], $maskPath);
        echo json_encode(['success' => true, 'already' => false, 'url' => $relPath . 'mask.tif']);
        return true;
    }
    
    // ------------------------------------------------
    // -------- MONTHLY STATEMENT (ORG BILLING) ------
    // ------------------------------------------------
    // POST: action=org_monthly_statement, month (1-12), year (YYYY)
    //
    // Returns all orders placed by this org in the given calendar month,
    // each with address, type, cost, status, and issuer info.
    if ($action === 'org_monthly_statement') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }

        $email = strtolower(trim((string)$_SESSION['user_email']));
        $orgId = function_exists('actorOrgIdByEmail') ? actorOrgIdByEmail($email) : null;

        if (!$orgId) {
            die(json_encode(['success' => false, 'error' => 'No organization']));
        }

        if (!isAdmin() && !userHasOrgPerm($email, $orgId, 'manage_billing')) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $month = max(1, min(12, (int)($_POST['month'] ?? (int)date('n'))));
        $year  = max(2020, min((int)date('Y') + 1, (int)($_POST['year'] ?? (int)date('Y'))));

        // Build date range (unix timestamps)
        $startTs = mktime(0, 0, 0, $month, 1, $year);
        // Last second of last day of the month
        $endTs   = mktime(23, 59, 59, $month + 1, 0, $year);

        if (!function_exists('pj_db')) {
            die(json_encode(['success' => false, 'error' => 'Project index not loaded']));
        }

        $db = pj_db();

        $stmt = $db->prepare("
            SELECT id, ca, st, cx
            FROM p
            WHERE org = :org
              AND ca >= :start
              AND ca <= :end
            ORDER BY ca DESC
        ");
        $stmt->bindValue(':org', (string)$orgId, SQLITE3_TEXT);
        $stmt->bindValue(':start', $startTs, SQLITE3_INTEGER);
        $stmt->bindValue(':end', $endTs, SQLITE3_INTEGER);
        $res = $stmt->execute();

        $orders     = [];
        $totalSpent = 0;
        $byType     = [];

        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $folder = (string)($row['id'] ?? '');
            if ($folder === '') continue;

            // Read manifest for full details
            $targetDir = locateProjectDir($folder);
            if (!$targetDir) $targetDir = rtrim($baseDir, '/\\') . '/' . $folder . '/';
            $mp = $targetDir . 'manifest.json';
            if (!file_exists($mp)) continue;

            $m = json_decode(@file_get_contents($mp), true);
            if (!is_array($m)) continue;

            // Skip filler projects — they aren't real customer orders
            if (!empty($m['is_filler'])) continue;

            $projType = strtolower(trim((string)($m['project_type'] ?? 'residential')));
            $cost     = projectTypePrice($projType);
            $status   = (string)($m['status'] ?? '');

            // Only count cost for non-rejected orders
            $rejected = in_array($status, ['rejected', 'rejected_no_coverage'], true);
            if (!$rejected) {
                $totalSpent += $cost;
                $byType[$projType] = ($byType[$projType] ?? 0) + 1;
            }

            $orders[] = [
                'id'           => $folder,
                'address'      => (string)($m['address'] ?? ''),
                'project_type' => $projType,
                'cost'         => $rejected ? 0 : $cost,
                'cost_nominal' => $cost,
                'status'       => $status,
                'rejected'     => $rejected,
                'created_at'   => (string)($m['created_at'] ?? ''),
                'completed_at' => (string)($m['completed_at'] ?? ''),
                'issuer_name'  => (string)($m['issuer']['name'] ?? ''),
                'issuer_email' => (string)($m['issuer']['email'] ?? ''),
                'complexity'   => (string)($m['complexity'] ?? 'complex'),
            ];
        }
        $res->finalize();

        // Month label for convenience
        $monthLabel = date('F Y', $startTs);

        echo json_encode([
            'success'      => true,
            'month'        => $month,
            'year'         => $year,
            'month_label'  => $monthLabel,
            'orders'       => $orders,
            'total_orders' => count($orders),
            'total_spent'  => $totalSpent,
            'by_type'      => $byType,
        ]);
        return true;
    }
    
    // ------------------------------------------------
    // ---------------- SET PROJECT VIP ---------------
    // ------------------------------------------------
    if ($action === 'set_project_vip') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }
        if (!isAdmin() && !isQueueAdminUser()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') {
            echo json_encode(['success' => false, 'error' => 'Missing folder']);
            return true;
        }
        $isVip = filter_var($_POST['is_vip'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) {
            echo json_encode(['success' => false, 'error' => 'Project not found']);
            return true;
        }
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];
        $m['is_vip'] = $isVip;
        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        manifestEnsureWorkHistory($m);
        $m['work_history'][] = [
            'ts'       => date('c'),
            'event'    => $isVip ? 'marked_vip' : 'unmarked_vip',
            'by_email' => $actorEmail,
        ];
        saveManifest($mp, $m);
        echo json_encode(['success' => true, 'is_vip' => $isVip]);
        return true;
    }
    
    
    if ($action === 'manager_audit_mark') {
        if (!canShiftManager()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') {
            die(json_encode(['success' => false, 'error' => 'Missing folder']));
        }
        $auditStatus = strtolower(trim((string)($_POST['audit_status'] ?? '')));
        $validStatuses = ['reviewed', 'flagged', 'clear', '_save_annot'];
        if (!in_array($auditStatus, $validStatuses, true)) {
            die(json_encode(['success' => false, 'error' => 'Invalid audit_status']));
        }
        $note = trim((string)($_POST['note'] ?? ''));
        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $actorName  = $_SESSION['user_name'] ?? $actorEmail;
        $now = date('Y-m-d H:i:s');

        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) {
            die(json_encode(['success' => false, 'error' => 'Project not found']));
        }
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];

        // Parse annotations (shared by flagged + _save_annot)
        $annotRaw = (string)($_POST['annotations'] ?? '');
        $annotObj = null;
        if ($annotRaw !== '') {
            $annotObj = json_decode($annotRaw, true);
            if (!is_array($annotObj)) $annotObj = null;
        }

        if ($auditStatus === '_save_annot') {
            // Auto-save annotations only — don't change audit status or log history
            if ($annotObj !== null) {
                $m['manager_audit_annotations'] = $annotObj;
            }
            saveManifest($mp, $m);
            echo json_encode(['success' => true, 'folder' => $folder, 'saved' => 'annotations']);
            return true;
        }

        if ($auditStatus === 'clear') {
            unset($m['manager_audit_status'], $m['manager_audit_at'],
                  $m['manager_audit_by'], $m['manager_audit_by_name'],
                  $m['manager_audit_note'], $m['manager_audit_annotations']);
        } elseif ($auditStatus === 'reviewed') {
            $m['manager_audit_status']  = 'reviewed';
            $m['manager_audit_at']      = $now;
            $m['manager_audit_by']      = $actorEmail;
            $m['manager_audit_by_name'] = $actorName;
            $m['manager_audit_note']    = null;
            unset($m['manager_audit_annotations']);
        } else {
            // flagged
            $m['manager_audit_status']  = 'flagged';
            $m['manager_audit_at']      = $now;
            $m['manager_audit_by']      = $actorEmail;
            $m['manager_audit_by_name'] = $actorName;
            $m['manager_audit_note']    = ($note !== '') ? $note : null;
            if ($annotObj !== null) {
                $m['manager_audit_annotations'] = $annotObj;
            }
        }

        manifestEnsureWorkHistory($m);
        $m['work_history'][] = [
            'ts'       => date('c'),
            'event'    => 'manager_audit_' . $auditStatus,
            'by_email' => $actorEmail,
            'by_name'  => $actorName,
            'note'     => ($note !== '') ? $note : null,
        ];

        saveManifest($mp, $m);
        echo json_encode([
            'success'      => true,
            'folder'       => $folder,
            'audit_status' => ($auditStatus === 'clear') ? null : $auditStatus,
        ]);
        return true;
    }

    
    
    // ------------------------------------------------
    // -------- PROJECT EMAIL STATUS + RESEND --------
    // ------------------------------------------------
    if ($action === 'project_email_get') {
        if (!canQAUser() && !isQueueAdminUser() && !isAdmin()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));
        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success'=>false,'error'=>'Missing folder']));
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) die(json_encode(['success'=>false,'error'=>'Project not found']));
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];
        $summary = projectGetEmailSummary($m);
        echo json_encode([
            'success'=>true,
            'folder'=>$folder,
            'email_summary'=>$summary,
            'recent_events'=>array_slice((array)($m['email_events'] ?? []), -25),
        ]);
        return true;
    }
    if ($action === 'project_email_send_report') {
        if (!canQAUser() && !isQueueAdminUser() && !isAdmin()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));
        $folder = preg_replace('/[^a-f0-9]/', '', (string)($_POST['folder'] ?? ''));
        if ($folder === '') die(json_encode(['success'=>false,'error'=>'Missing folder']));
        $force = isset($_POST['force']) ? filter_var($_POST['force'], FILTER_VALIDATE_BOOLEAN) : true;
        $targetDir = locateProjectDir($folder);
        if (!$targetDir) $targetDir = $baseDir . $folder . '/';
        $mp = $targetDir . 'manifest.json';
        if (!file_exists($mp)) die(json_encode(['success'=>false,'error'=>'Project not found']));
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];
        $by = (string)($_SESSION['user_email'] ?? 'system');
        $ret = sendProjectReportEmailAndTrack($targetDir, $m, [
            'force' => $force,
            'by' => $by,
        ]);
        @saveManifest($mp, $m);
        echo json_encode([
            'success'=>true,
            'result'=>$ret,
            'email_summary'=>projectGetEmailSummary($m),
        ]);
        return true;
    }
    
    
    if ($action === 'admin_kick_worker')  { echo handleAdminKickWorker();  return true; }
    if ($action === 'check_for_kick')     { echo handleCheckForKick();      return true; }
    if ($action === 'acknowledge_kick')   { echo handleAcknowledgeKick();   return true; }
    if ($action === 'report_afk_kick')    { echo handleReportAfkKick();     return true; }
    // Action not handled by this file
    return false;
}
