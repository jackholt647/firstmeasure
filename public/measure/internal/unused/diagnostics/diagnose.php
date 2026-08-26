<?php
require_once __DIR__ . '/_storage.php';
/**
 * diagnose.php — Drop this next to server.php and hit it in the browser.
 * It checks the SQLite project index for the exact issue we're debugging.
 * DELETE THIS FILE when you're done.
 */
header('Content-Type: text/html; charset=utf-8');

// Load your existing config so we get the DB path
$dir = __DIR__ . '/';
foreach (['_config.php','config.php','_globals.php','globals.php'] as $f) {
    if (file_exists($dir . $f)) require_once $dir . $f;
}
// Try to load the project index module
foreach (['_pj_index.php','pj_index.php','_project_index.php','project_index.php'] as $f) {
    if (file_exists($dir . $f)) { require_once $dir . $f; break; }
}

// Find the SQLite file
$dbPath = null;
$candidates = [
    $dir . 'pj_idx.sqlite',
    $dir . 'bpj_idx.sqlite',
    $dir . 'pj_index.sqlite',
    $dir . 'projects.sqlite',
    ($GLOBALS['baseDir'] ?? '') . '../pj_idx.sqlite',
];
foreach ($candidates as $c) {
    if ($c && file_exists($c)) { $dbPath = realpath($c); break; }
}
// Also try pj_db() if available
if (!$dbPath && function_exists('pj_db')) {
    try {
        $db = pj_db();
        // Can't easily get path from SQLite3 object, but at least we have a handle
    } catch (Exception $e) {}
}

echo '<html><head><title>Queue Diagnostic</title><style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:1100px;margin:20px auto;padding:0 20px;background:#f8f9fa;color:#111;}
h1{font-size:20px;} h2{font-size:16px;margin-top:30px;border-bottom:2px solid #1a73e8;padding-bottom:6px;}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}
th{background:#e8f0fe;font-weight:900;font-size:11px;text-transform:uppercase;}
tr:nth-child(even){background:#f4f6f8;}
.warn{background:#fff3e0;color:#e65100;padding:10px;border-radius:8px;font-weight:700;}
.err{background:#fce8e6;color:#b0261e;padding:10px;border-radius:8px;font-weight:700;}
.ok{background:#e6f4ea;color:#137333;padding:10px;border-radius:8px;font-weight:700;}
code{background:#eee;padding:2px 6px;border-radius:4px;font-size:12px;}
.highlight{background:#fff3e0;font-weight:900;}
</style></head><body>';

echo '<h1>🔧 Queue Diagnostic</h1>';

if (!$dbPath) {
    echo '<div class="err">Could not find SQLite database file. Tried: ' . implode(', ', $candidates) . '</div>';
    echo '<p>If your DB is in a different location, edit the $candidates array in this file.</p>';
    echo '</body></html>';
    exit;
}

echo '<p>Database: <code>' . htmlspecialchars($dbPath) . '</code> (' . number_format(filesize($dbPath)) . ' bytes)</p>';

$db = new SQLite3($dbPath, SQLITE3_OPEN_READONLY);

// ── 1. Status × Filler breakdown (the key diagnostic) ──
echo '<h2>1. Active Projects by Status × Filler Flag</h2>';
echo '<p>This is the main thing — are non-filler active projects in the index?</p>';

$sql = "SELECT st, fl, COUNT(*) as cnt FROM p WHERE st IN ('queued','ready','processing','in_progress','awaiting_review','correction_needed','pending_rejection','awaiting_manager_review') GROUP BY st, fl ORDER BY st, fl";
$res = $db->query($sql);
$rows = [];
while ($row = $res->fetchArray(SQLITE3_ASSOC)) $rows[] = $row;

if (empty($rows)) {
    echo '<div class="err">NO active projects found in index at all!</div>';
} else {
    echo '<table><tr><th>Status (st)</th><th>Filler (fl)</th><th>Count</th><th>Note</th></tr>';
    $hasNonFillerActive = false;
    foreach ($rows as $r) {
        $isFiller = (int)$r['fl'];
        $cls = (!$isFiller && $r['cnt'] > 0) ? ' class="highlight"' : '';
        if (!$isFiller) $hasNonFillerActive = true;
        $note = $isFiller ? 'filler' : '<strong>⚡ REAL (non-filler)</strong>';
        echo "<tr{$cls}><td>{$r['st']}</td><td>{$isFiller}</td><td>{$r['cnt']}</td><td>{$note}</td></tr>";
    }
    echo '</table>';
    if (!$hasNonFillerActive) {
        echo '<div class="err">⚠️ ZERO non-filler projects in any active status! This confirms the index is the problem.</div>';
    } else {
        echo '<div class="ok">✅ Non-filler active projects exist in the index.</div>';
    }
}

// ── 2. Check the specific project from the bug report ──
echo '<h2>2. Specific Project Check</h2>';
$testId = '43ccb4fd81fe83d63cb4dac90a825c27';
echo '<p>Checking <code>' . $testId . '</code> (the awaiting_review project from your manifest):</p>';

$stmt = $db->prepare("SELECT * FROM p WHERE id = :id");
$stmt->bindValue(':id', $testId, SQLITE3_TEXT);
$res = $stmt->execute();
$row = $res->fetchArray(SQLITE3_ASSOC);

if (!$row) {
    echo '<div class="err">NOT FOUND in index! This project exists on disk but the index doesn\'t have it.</div>';
} else {
    echo '<table><tr>';
    foreach (array_keys($row) as $k) echo '<th>' . htmlspecialchars($k) . '</th>';
    echo '</tr><tr>';
    foreach ($row as $k => $v) {
        $cls = '';
        if ($k === 'st') $cls = ($v === 'awaiting_review') ? ' class="ok"' : ' class="err"';
        if ($k === 'fl') $cls = ($v == 0) ? ' class="ok"' : ' class="err"';
        echo "<td{$cls}>" . htmlspecialchars($v ?? 'NULL') . '</td>';
    }
    echo '</tr></table>';
    
    $st = $row['st'] ?? '???';
    $fl = (int)($row['fl'] ?? -1);
    if ($st !== 'awaiting_review') echo '<div class="err">⚠️ Status is "' . htmlspecialchars($st) . '" but manifest says "awaiting_review"!</div>';
    if ($fl !== 0) echo '<div class="err">⚠️ Filler flag is ' . $fl . ' but manifest says is_filler=false!</div>';
    if ($st === 'awaiting_review' && $fl === 0) echo '<div class="ok">✅ This row looks correct — status and filler flag match the manifest.</div>';
}

// ── 3. All statuses in the DB ──
echo '<h2>3. All Statuses in Index</h2>';
$res = $db->query("SELECT st, COUNT(*) as cnt FROM p GROUP BY st ORDER BY cnt DESC");
echo '<table><tr><th>Status (st)</th><th>Count</th></tr>';
while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
    echo '<tr><td>' . htmlspecialchars($row['st'] ?? 'NULL') . '</td><td>' . $row['cnt'] . '</td></tr>';
}
echo '</table>';

// ── 4. Filler flag distribution ──
echo '<h2>4. Filler Flag Distribution</h2>';
$res = $db->query("SELECT fl, COUNT(*) as cnt FROM p GROUP BY fl ORDER BY fl");
echo '<table><tr><th>Filler (fl)</th><th>Count</th></tr>';
while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
    echo '<tr><td>' . htmlspecialchars($row['fl'] ?? 'NULL') . '</td><td>' . $row['cnt'] . '</td></tr>';
}
echo '</table>';

// ── 5. Check what queue_admin_overview WOULD match ──
echo '<h2>5. Simulating queue_admin_overview Query</h2>';
echo '<p>This runs the exact WHERE clause from your PHP code:</p>';

$sql = "SELECT id, st, fl, sa FROM p WHERE (
    (st IN ('queued','ready') AND (sa IS NULL OR sa=0)) OR
    (st IN ('processing','in_progress') AND (sa IS NOT NULL AND sa!=0)) OR
    (st='awaiting_review') OR
    (st='completed') OR
    (st IN ('rejected','rejected_no_coverage'))
) LIMIT 50";
$res = $db->query($sql);
$matched = 0;
$matchedNonFiller = 0;
$byStatus = [];
echo '<table><tr><th>ID (first 12)</th><th>Status</th><th>Filler</th><th>sa (started_at)</th></tr>';
while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
    $matched++;
    $fl = (int)($row['fl'] ?? 0);
    if (!$fl) $matchedNonFiller++;
    $st = $row['st'] ?? '';
    $byStatus[$st] = ($byStatus[$st] ?? 0) + 1;
    if ($matched <= 30) {
        $cls = $fl ? '' : ' class="highlight"';
        echo "<tr{$cls}><td>" . substr($row['id'], 0, 12) . '…</td><td>' . htmlspecialchars($st) . '</td><td>' . $fl . '</td><td>' . htmlspecialchars($row['sa'] ?? 'NULL') . '</td></tr>';
    }
}
echo '</table>';
if ($matched > 30) echo '<p>(...showing first 30 of ' . $matched . ')</p>';
echo '<p>Matched: <strong>' . $matched . '</strong> total, <strong>' . $matchedNonFiller . '</strong> non-filler</p>';

// ── 6. Sample of non-filler awaiting_review directly ──
echo '<h2>6. Direct Query: Non-filler awaiting_review</h2>';
$res = $db->query("SELECT id, st, fl, sa FROM p WHERE st='awaiting_review' AND fl=0 LIMIT 20");
$found = 0;
echo '<table><tr><th>ID</th><th>Status</th><th>Filler</th><th>sa</th></tr>';
while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
    $found++;
    echo '<tr><td>' . htmlspecialchars($row['id']) . '</td><td>' . htmlspecialchars($row['st']) . '</td><td>' . $row['fl'] . '</td><td>' . htmlspecialchars($row['sa'] ?? 'NULL') . '</td></tr>';
}
echo '</table>';
if ($found === 0) {
    echo '<div class="err">⚠️ ZERO rows match st="awaiting_review" AND fl=0. The index has no non-filler QA items!</div>';
} else {
    echo '<div class="ok">✅ Found ' . $found . ' non-filler awaiting_review rows.</div>';
}

// ── 7. WAL status ──
echo '<h2>7. WAL / Journal Files</h2>';
$walPath = $dbPath . '-wal';
$shmPath = $dbPath . '-shm';
$walExists = file_exists($walPath);
$shmExists = file_exists($shmPath);
echo '<p>WAL file: ' . ($walExists ? '<strong>' . number_format(filesize($walPath)) . ' bytes</strong>' : 'not present') . '</p>';
echo '<p>SHM file: ' . ($shmExists ? '<strong>' . number_format(filesize($shmPath)) . ' bytes</strong>' : 'not present') . '</p>';
if ($walExists && filesize($walPath) > 0) {
    echo '<div class="warn">WAL file has data. Recent writes may not be visible to readers. Consider running: <code>PRAGMA wal_checkpoint(TRUNCATE);</code></div>';
}

echo '<hr><p style="color:#999;font-size:11px;">Generated ' . date('Y-m-d H:i:s T') . ' — <strong>Delete this file when done!</strong></p>';
echo '</body></html>';