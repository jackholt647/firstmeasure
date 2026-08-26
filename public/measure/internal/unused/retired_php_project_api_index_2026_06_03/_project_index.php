<?php
require_once __DIR__ . '/_storage.php';
/**
 * project_index.php
 * Centralized project file writers + lightweight SQLite index + full rebuild.
 *
 * Usage (typical):
 *   require_once __DIR__ . '/project_index.php';
 *
 *   // Replace: saveManifest($mp, $m);
 *   pj_save_manifest($targetDir, $m);
 *
 *   // Replace: file_put_contents($targetDir.'Report.pdf', $bytes);
 *   pj_write_file($targetDir, 'Report.pdf', $bytes);
 *
 * Nightly rebuild:
 *   pj_rebuild_index_from_zero();
 */

// -----------------------------
// Config
// -----------------------------
function pj_db_path() {
    // Keep next to server.php / internal code
    return storageExistingPath('databases/pj_idx.sqlite', __DIR__ . '/pj_idx.sqlite', true);
}
function pj_lock_path() {
    return storagePath('locks/pj_idx.lock', true);
}

function pj_set_last_error($message) {
    $GLOBALS['pj_last_error'] = trim((string)$message);
}

function pj_get_last_error() {
    return trim((string)($GLOBALS['pj_last_error'] ?? ''));
}

function pj_exec_pragma_safely($db, $sql, $label) {
    $ok = @$db->exec($sql);
    if ($ok === false) {
        $msg = '';
        try {
            $msg = trim((string)$db->lastErrorMsg());
        } catch (Throwable $e) {
            $msg = trim((string)$e->getMessage());
        }
        if ($msg !== '' && stripos($msg, 'not an error') === false) {
            error_log("pj_db: failed to apply {$label}: {$msg}");
        }
    }
    return $ok;
}

// -----------------------------
// SQLite init + handle
// -----------------------------
function pj_db() {
    static $db = null;
    if ($db instanceof SQLite3) return $db;

    if (!class_exists('SQLite3')) {
        throw new Exception('SQLite3 extension not available');
    }

    $db = new SQLite3(pj_db_path());
    if (method_exists($db, 'busyTimeout')) {
        @$db->busyTimeout(5000);
    }
    pj_exec_pragma_safely($db, "PRAGMA busy_timeout = 5000;", 'busy_timeout');
    pj_exec_pragma_safely($db, "PRAGMA journal_mode = WAL;", 'journal_mode');
    pj_exec_pragma_safely($db, "PRAGMA synchronous = NORMAL;", 'synchronous');
    pj_exec_pragma_safely($db, "PRAGMA temp_store = MEMORY;", 'temp_store');
    pj_db_init($db);
    return $db;
}

function projectIndexDb() {
    return pj_db();
}


function pj_db_init($db) {
    // Ultra-light schema (short column names)
    // id = folder
    // p  = path type (saves|tm|tu) (optional but useful)
    // st = status
    // org= org id
    // tm = team id
    // ow = owner_email
    // as = assigned_to_email
    // rs = reserved_to_email
    // qc = qa_claimed_by_email
    // fl = is_filler (0/1)
    // cx = complexity
    // ca = created_at (unix)
    // qa = queued_at (unix)
    // pa = processed_at (unix)
    // ua = uploaded_at (unix)
    // da = completed_at (unix)
    // sa = started_at (unix)
    // mt = manifest mtime (unix)
    // ht = has_thumb (0/1) [google.png]
    // hr = has_report (0/1) [Report.pdf AND status completed]
    $db->exec("
        CREATE TABLE IF NOT EXISTS p (
            id TEXT PRIMARY KEY,
            p  TEXT,
            st TEXT,
            org TEXT,
            tm TEXT,
            ow TEXT,
            asn TEXT,
            rs TEXT,
            qc TEXT,
            fl INTEGER,
            cx TEXT,
            ca INTEGER,
            qa INTEGER,
            pa INTEGER,
            ua INTEGER,
            da INTEGER,
            sa INTEGER,
            mt INTEGER,
            ht INTEGER,
            hr INTEGER
        );
    ");

    // Indexes for your hot endpoints
    $db->exec("CREATE INDEX IF NOT EXISTS p_st_ua   ON p(st, ua);");
    $db->exec("CREATE INDEX IF NOT EXISTS p_st_ca   ON p(st, ca);");
    $db->exec("CREATE INDEX IF NOT EXISTS p_org_ca  ON p(org, ca);");
    $db->exec("CREATE INDEX IF NOT EXISTS p_tm_ca   ON p(tm, ca);");
    $db->exec("CREATE INDEX IF NOT EXISTS p_asn_st  ON p(asn, st);");
    $db->exec("CREATE INDEX IF NOT EXISTS p_rs_st   ON p(rs, st);");
}

function pj_with_lock($fn) {
    pj_set_last_error('');
    $fh = @fopen(pj_lock_path(), 'c+');
    if (!$fh) {
        pj_set_last_error('lock_open_failed');
        return null;
    }
    try {
        if (!@flock($fh, LOCK_EX)) {
            pj_set_last_error('lock_acquire_failed');
            fclose($fh);
            return null;
        }
        $out = $fn();
        flock($fh, LOCK_UN);
        fclose($fh);
        return $out;
    } catch (Throwable $e) {
        pj_set_last_error($e->getMessage() ?: get_class($e));
        try { flock($fh, LOCK_UN); fclose($fh); } catch (Throwable $e2) {}
        return null;
    }
}

// -----------------------------
// Small helpers
// -----------------------------
function pj_ts($s) {
    $s = trim((string)$s);
    if ($s === '') return null;
    $t = strtotime($s);
    return $t ? $t : null;
}
function pj_i01($v) { return !empty($v) ? 1 : 0; }

function pj_atomic_write($path, $bytes) {
    $dir = dirname($path);
    if (!file_exists($dir)) @mkdir($dir, 0777, true);
    $tmp = $path . '.tmp_' . uniqid('', true);
    if (@file_put_contents($tmp, $bytes) === false) return false;
    return @rename($tmp, $path);
}

// -----------------------------
// Index upsert
// -----------------------------
function pj_upsert_from_manifest($targetDir, $m, $pathType = null) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    if (!is_array($m)) $m = [];
    $id = (string)($m['id'] ?? '');
    if ($id === '') {
        // fall back to folder name if manifest missing id
        $id = basename(rtrim($targetDir, '/\\'));
    }

    $st  = (string)($m['status'] ?? '');
    $org = (string)($m['organization_id'] ?? '');
    $tm  = (string)($m['team_id'] ?? 'default');
    $ow  = (string)($m['owner_email'] ?? '');
    $asn = (string)($m['assigned_to_email'] ?? '');
    $rs  = (string)($m['reserved_to_email'] ?? '');
    $qc  = (string)($m['qa_claimed_by_email'] ?? '');
    $fl  = pj_i01($m['is_filler'] ?? false);
    $cx  = (string)($m['complexity'] ?? 'complex');

    $ca = pj_ts($m['created_at'] ?? '') ?: null;
    $qa = pj_ts($m['queued_at'] ?? '') ?: null;
    $pa = pj_ts($m['processed_at'] ?? '') ?: null;
    $ua = pj_ts($m['uploaded_at'] ?? '') ?: null;
    $da = pj_ts($m['completed_at'] ?? '') ?: null;
    $sa = pj_ts($m['started_at'] ?? '') ?: null;

    $mp = $targetDir . 'manifest.json';
    $mt = @filemtime($mp) ?: time();
    $ht = file_exists($targetDir . 'google.png') ? 1 : 0;
    $hasPdf = file_exists($targetDir . 'Report.pdf');
    $hr = ($hasPdf && $st === 'completed') ? 1 : 0;

    if ($pathType === null) {
        // Optional: tag where it lives (saves/tutorials/master/tutorials/user)
        if (strpos($targetDir, '/saves/') !== false) $pathType = 'saves';
        else if (strpos($targetDir, '/tutorials/master/') !== false) $pathType = 'tm';
        else if (strpos($targetDir, '/tutorials/') !== false) $pathType = 'tu';
        else $pathType = '';
    }

    return pj_with_lock(function() use ($id,$pathType,$st,$org,$tm,$ow,$asn,$rs,$qc,$fl,$cx,$ca,$qa,$pa,$ua,$da,$sa,$mt,$ht,$hr) {
        $db = pj_db();
        $stmt = $db->prepare("
            INSERT INTO p (id,p,st,org,tm,ow,asn,rs,qc,fl,cx,ca,qa,pa,ua,da,sa,mt,ht,hr)
            VALUES (:id,:p,:st,:org,:tm,:ow,:asn,:rs,:qc,:fl,:cx,:ca,:qa,:pa,:ua,:da,:sa,:mt,:ht,:hr)
            ON CONFLICT(id) DO UPDATE SET
                p=excluded.p,
                st=excluded.st,
                org=excluded.org,
                tm=excluded.tm,
                ow=excluded.ow,
                asn=excluded.asn,
                rs=excluded.rs,
                qc=excluded.qc,
                fl=excluded.fl,
                cx=excluded.cx,
                ca=excluded.ca,
                qa=excluded.qa,
                pa=excluded.pa,
                ua=excluded.ua,
                da=excluded.da,
                sa=excluded.sa,
                mt=excluded.mt,
                ht=excluded.ht,
                hr=excluded.hr
        ");
        $stmt->bindValue(':id',  $id, SQLITE3_TEXT);
        $stmt->bindValue(':p',   $pathType, SQLITE3_TEXT);
        $stmt->bindValue(':st',  $st, SQLITE3_TEXT);
        $stmt->bindValue(':org', $org, SQLITE3_TEXT);
        $stmt->bindValue(':tm',  $tm, SQLITE3_TEXT);
        $stmt->bindValue(':ow',  $ow, SQLITE3_TEXT);
        $stmt->bindValue(':asn', $asn, SQLITE3_TEXT);
        $stmt->bindValue(':rs',  $rs, SQLITE3_TEXT);
        $stmt->bindValue(':qc',  $qc, SQLITE3_TEXT);
        $stmt->bindValue(':fl',  (int)$fl, SQLITE3_INTEGER);
        $stmt->bindValue(':cx',  $cx, SQLITE3_TEXT);

        foreach (['ca'=>$ca,'qa'=>$qa,'pa'=>$pa,'ua'=>$ua,'da'=>$da,'sa'=>$sa,'mt'=>$mt] as $k=>$v) {
            if ($v === null) $stmt->bindValue(':'.$k, null, SQLITE3_NULL);
            else $stmt->bindValue(':'.$k, (int)$v, SQLITE3_INTEGER);
        }

        $stmt->bindValue(':ht', (int)$ht, SQLITE3_INTEGER);
        $stmt->bindValue(':hr', (int)$hr, SQLITE3_INTEGER);

        $ok = @$stmt->execute();
        if ($ok instanceof SQLite3Result) $ok->finalize();
        return true;
    });
}

// -----------------------------
// Central writers
// -----------------------------
/**
 * Save a manifest (atomic) + update index.
 * Replaces saveManifest($mp, $m) in most places.
 */
function pj_save_manifest($targetDir, &$m) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    if (!is_array($m)) $m = [];

    // Ensure id is set (your code often relies on this)
    if (empty($m['id'])) {
        $m['id'] = basename(rtrim($targetDir, '/\\'));
    }

    $mp = $targetDir . 'manifest.json';

    // Optional backup behavior: keep yours if you want, but keep this lean:
    // (If you want backups, call your existing saveManifest() from here instead.)
    $json = json_encode($m, JSON_PRETTY_PRINT);
    if ($json === false) return false;

    $ok = pj_atomic_write($mp, $json);
    if (!$ok) return false;

    // Update index
    pj_upsert_from_manifest($targetDir, $m);

    return true;
}

/**
 * Write any project file (atomic) + update index if it affects queue/list logic.
 * Good for: Report.pdf, Summary.pdf, google.png, dsm.tif, etc.
 */
function pj_write_file($targetDir, $relName, $bytes) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $relName = ltrim((string)$relName, '/\\');
    if ($relName === '') return false;

    $path = $targetDir . $relName;
    $ok = pj_atomic_write($path, $bytes);
    if (!$ok) return false;

    // If file impacts “has_report” / “has_thumb” / eligibility, refresh index from manifest
    $touch = strtolower($relName);
    if ($touch === 'report.pdf' || $touch === 'google.png' || $touch === 'manifest.json' || $touch === 'dsm.tif') {
        $mp = $targetDir . 'manifest.json';
        $m = file_exists($mp) ? json_decode(@file_get_contents($mp), true) : [];
        if (!is_array($m)) $m = [];
        pj_upsert_from_manifest($targetDir, $m);
    }

    return true;
}

// -----------------------------
// Full rebuild (from zero)
// -----------------------------
/**
 * Rebuild index by scanning ALL manifest.json files.
 * Safe to run nightly (cron).
 */
function pj_rebuild_index_from_zero($opts = []) {
    $limit = (int)($opts['limit'] ?? 0);

    $baseDir = $GLOBALS['baseDir'] ?? null;

    if (!$baseDir || !is_dir($baseDir)) return ['ok'=>false,'error'=>'baseDir_missing'];

    $manifests = [];

    // saves/*/manifest.json only
    foreach (glob(rtrim($baseDir, '/\\') . '/*/manifest.json', GLOB_NOSORT) as $mp) {
        $manifests[] = $mp;
        if ($limit > 0 && count($manifests) >= $limit) break;
    }

    // Drop and recreate the table
    $out = pj_with_lock(function() {
        $db = pj_db();
        $db->exec("DROP TABLE IF EXISTS p;");
        pj_db_init($db);
        return true;
    });
    if ($out !== true) {
        $err = pj_get_last_error();
        return ['ok'=>false,'error'=>$err !== '' ? $err : 'lock_failed'];
    }

    $n = 0; $bad = 0;
    foreach ($manifests as $mp) {
        $targetDir = dirname($mp) . '/';
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) { $bad++; continue; }
        pj_upsert_from_manifest($targetDir, $m, 'saves');
        $n++;
    }

    return ['ok'=>true,'count'=>$n,'bad'=>$bad];
}


function pj_fetch_queue_status_counts($workerEmail) {
    $workerEmail = strtolower(trim((string)$workerEmail));
    $db = pj_db();

    // queued/ready not started, heightmap filtering still needs a check if you keep it file-based
    // but even with a small follow-up check, this avoids scanning 1000 dirs.
    $stmt = $db->prepare("
        SELECT st, COUNT(*) c
        FROM p
        WHERE st IN ('queued','ready')
          AND (sa IS NULL OR sa=0)
          AND (rs IS NULL OR rs='' OR rs=:me)
        GROUP BY st
    ");
    $stmt->bindValue(':me', $workerEmail, SQLITE3_TEXT);
    $res = $stmt->execute();

    $count = 0;
    while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
        $count += (int)$row['c'];
    }
    $res->finalize();

    return $count;
}



function pj_pick_next_project($workerEmail, $complexityPref = 'all') {
    $workerEmail = strtolower(trim((string)$workerEmail));
    $complexityPref = strtolower(trim((string)$complexityPref));
    $db = pj_db();

    // 1) corrections first
    // correction_needed rows must exist in index; you already store st + asn + uploaded/updated times
    $q1 = $db->prepare("
        SELECT id
        FROM p
        WHERE st='correction_needed'
          AND (asn IS NULL OR asn='' OR asn=:me OR asn IN (
              SELECT asn FROM p WHERE asn IS NOT NULL AND asn!='' -- placeholder, keep your offline logic in PHP if needed
          ))
        ORDER BY fl ASC, COALESCE(ua,ca,qa,0) ASC
        LIMIT 1
    ");
    $q1->bindValue(':me', $workerEmail, SQLITE3_TEXT);
    $r1 = $q1->execute();
    $row = $r1->fetchArray(SQLITE3_ASSOC);
    $r1->finalize();
    if ($row && !empty($row['id'])) return $row['id'];

    // 2) normal queue
    // windowed pick: first 10 by time, then choose by complexityPref
    $q2 = $db->prepare("
        SELECT id, cx, fl, COALESCE(pa,qa,ca,0) t
        FROM p
        WHERE st IN ('queued','ready')
          AND (sa IS NULL OR sa=0)
          AND (rs IS NULL OR rs='' OR rs=:me)
        ORDER BY fl ASC, t ASC
        LIMIT 10
    ");
    $q2->bindValue(':me', $workerEmail, SQLITE3_TEXT);
    $r2 = $q2->execute();
    $rows = [];
    while ($rr = $r2->fetchArray(SQLITE3_ASSOC)) $rows[] = $rr;
    $r2->finalize();

    if (!$rows) return null;
    if ($complexityPref === 'simple') {
        foreach ($rows as $rr) if (($rr['cx'] ?? '') === 'simple') return $rr['id'];
    } elseif ($complexityPref === 'complex') {
        foreach ($rows as $rr) if (($rr['cx'] ?? '') !== 'simple') return $rr['id'];
    }
    return $rows[0]['id'];
}
