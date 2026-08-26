<?php
require_once __DIR__ . '/_storage.php';
/**
 * reconcile.php
 *
 * User ↔ Project reconciliation tool.
 *
 * Scans every project manifest for emails (owner, issuer, assigned_to,
 * work_history workers, qa reviewers) and cross-references them against
 * the `projects` array stored in each user file.  Surfaces discrepancies
 * so an admin can review and apply fixes.
 *
 * Place this file next to server.php.  Access it directly in a browser.
 * Requires an active admin session (same cookie domain as server.php).
 */

ini_set('display_errors', 1);
error_reporting(E_ALL);
session_start();

// ── Paths (same conventions as server.php) ──
$baseDir = __DIR__ . '/saves/';
$userDir = storageDir('users');

// ── Lightweight auth guard ──
// We only need the session email + admin flag that server.php sets on login.
$loggedIn  = isset($_SESSION['user_email']);
$isAdmin   = !empty($_SESSION['user_is_admin']);
$actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));

// ── Helpers ──
function getUserFilename($email) {
    return preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email))) . '.json';
}
function atomicWrite($path, $data) {
    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) return false;
    $tmp = $path . '.tmp_' . uniqid('', true);
    if (@file_put_contents($tmp, $json) === false) return false;
    return @rename($tmp, $path);
}

// ── API handling (AJAX calls from the UI) ──
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !empty($_POST['_reconcile_action'])) {
    header('Content-Type: application/json');

    if (!$loggedIn || !$isAdmin) {
        echo json_encode(['success' => false, 'error' => 'Unauthorized']);
        exit;
    }

    $act = $_POST['_reconcile_action'];

    // ── SCAN: build the full discrepancy report ──
    if ($act === 'scan') {
        // 1. Collect every email→folders mapping from manifests
        $manifestMap = []; // email → [folder1, folder2, …]

        if (is_dir($baseDir)) {
            foreach (scandir($baseDir) as $folder) {
                if ($folder === '.' || $folder === '..') continue;
                $mp = $baseDir . $folder . '/manifest.json';
                if (!file_exists($mp)) continue;
                $m = json_decode(@file_get_contents($mp), true);
                if (!is_array($m)) continue;

                $emails = [];

                // owner
                $ow = strtolower(trim((string)($m['owner_email'] ?? '')));
                if ($ow !== '' && $ow !== 'system') $emails[$ow] = true;

                // issuer
                $ie = strtolower(trim((string)($m['issuer']['email'] ?? '')));
                if ($ie !== '' && strpos($ie, 'system') === false) $emails[$ie] = true;

                // assigned_to
                $at = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
                if ($at !== '') $emails[$at] = true;

                // work_history workers
                if (!empty($m['work_history']) && is_array($m['work_history'])) {
                    foreach ($m['work_history'] as $h) {
                        if (!is_array($h)) continue;
                        $we = strtolower(trim((string)($h['worker_email'] ?? '')));
                        if ($we !== '') $emails[$we] = true;
                        // qa
                        $qe = strtolower(trim((string)($h['qa_email'] ?? '')));
                        if ($qe !== '') $emails[$qe] = true;
                        $me2 = strtolower(trim((string)($h['manager_email'] ?? '')));
                        if ($me2 !== '') $emails[$me2] = true;
                    }
                }

                // qa_approved_by
                $qa = strtolower(trim((string)($m['qa_approved_by'] ?? '')));
                if ($qa !== '') $emails[$qa] = true;

                // qa_claimed_by_email
                $qc = strtolower(trim((string)($m['qa_claimed_by_email'] ?? '')));
                if ($qc !== '') $emails[$qc] = true;

                // correction_to_email
                $ct = strtolower(trim((string)($m['correction_to_email'] ?? '')));
                if ($ct !== '') $emails[$ct] = true;

                foreach (array_keys($emails) as $em) {
                    if (!isset($manifestMap[$em])) $manifestMap[$em] = [];
                    if (!in_array($folder, $manifestMap[$em], true)) {
                        $manifestMap[$em][] = $folder;
                    }
                }
            }
        }

        // 2. Read every user file
        $userFiles = []; // email → {projects: [...], file: path, name: ...}
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if ($f === '.' || $f === '..') continue;
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $p = $userDir . $f;
                $u = json_decode(@file_get_contents($p), true);
                if (!is_array($u)) continue;
                $em = strtolower(trim((string)($u['email'] ?? '')));
                if ($em === '') continue;
                $userFiles[$em] = [
                    'file' => $f,
                    'name' => (string)($u['name'] ?? ''),
                    'account_type' => (string)($u['account_type'] ?? ''),
                    'projects' => (isset($u['projects']) && is_array($u['projects'])) ? $u['projects'] : [],
                ];
            }
        }

        // 3. Compute discrepancies
        $discrepancies = [];

        foreach ($manifestMap as $email => $manifestFolders) {
            if (!isset($userFiles[$email])) {
                // User file doesn't exist — orphaned references
                $discrepancies[] = [
                    'email'       => $email,
                    'name'        => '',
                    'account_type'=> '',
                    'type'        => 'no_user_file',
                    'missing'     => $manifestFolders,
                    'extra'       => [],
                    'current'     => [],
                ];
                continue;
            }

            $uf = $userFiles[$email];
            $currentProjects = $uf['projects'];

            // Missing from user file (in manifest but not in user's projects[])
            $missing = array_values(array_diff($manifestFolders, $currentProjects));

            // Extra in user file (in user's projects[] but no manifest reference to this user)
            $extra = array_values(array_diff($currentProjects, $manifestFolders));

            if (!empty($missing) || !empty($extra)) {
                $discrepancies[] = [
                    'email'       => $email,
                    'name'        => $uf['name'],
                    'account_type'=> $uf['account_type'],
                    'type'        => 'mismatch',
                    'missing'     => $missing,
                    'extra'       => $extra,
                    'current'     => $currentProjects,
                ];
            }
        }

        // Also check for users that have projects[] entries pointing to
        // folders that don't even have manifests (stale references)
        foreach ($userFiles as $email => $uf) {
            foreach ($uf['projects'] as $pf) {
                $mp = $baseDir . $pf . '/manifest.json';
                if (!file_exists($mp)) {
                    // Find or create the discrepancy entry
                    $found = false;
                    foreach ($discrepancies as &$d) {
                        if ($d['email'] === $email) {
                            if (!in_array($pf, $d['extra'], true)) {
                                $d['extra'][] = $pf;
                            }
                            $found = true;
                            break;
                        }
                    }
                    unset($d);
                    if (!$found) {
                        $discrepancies[] = [
                            'email'       => $email,
                            'name'        => $uf['name'],
                            'account_type'=> $uf['account_type'],
                            'type'        => 'mismatch',
                            'missing'     => [],
                            'extra'       => [$pf],
                            'current'     => $uf['projects'],
                        ];
                    }
                }
            }
        }

        // Sort: biggest discrepancies first
        usort($discrepancies, function ($a, $b) {
            return (count($b['missing']) + count($b['extra'])) - (count($a['missing']) + count($a['extra']));
        });

        // Gather project address lookup for UI display
        $addressLookup = [];
        if (is_dir($baseDir)) {
            foreach (scandir($baseDir) as $folder) {
                if ($folder === '.' || $folder === '..') continue;
                $mp = $baseDir . $folder . '/manifest.json';
                if (!file_exists($mp)) continue;
                $m = json_decode(@file_get_contents($mp), true);
                if (!is_array($m)) continue;
                $addressLookup[$folder] = [
                    'address' => (string)($m['address'] ?? ''),
                    'status'  => (string)($m['status'] ?? ''),
                    'owner'   => (string)($m['owner_email'] ?? ''),
                ];
            }
        }

        echo json_encode([
            'success'        => true,
            'discrepancies'  => $discrepancies,
            'total_users'    => count($userFiles),
            'total_projects' => count($addressLookup),
            'addresses'      => $addressLookup,
        ]);
        exit;
    }

    // ── APPLY: patch a single user's projects[] array ──
    if ($act === 'apply') {
        $targetEmail = strtolower(trim((string)($_POST['email'] ?? '')));
        $addJson     = $_POST['add'] ?? '[]';

        $add = json_decode($addJson, true);
        if (!is_array($add)) $add = [];

        if ($targetEmail === '') {
            echo json_encode(['success' => false, 'error' => 'Missing email']);
            exit;
        }

        $uf = $userDir . getUserFilename($targetEmail);
        if (!file_exists($uf)) {
            echo json_encode(['success' => false, 'error' => 'User file not found']);
            exit;
        }

        $u = json_decode(@file_get_contents($uf), true);
        if (!is_array($u)) $u = [];
        if (!isset($u['projects']) || !is_array($u['projects'])) $u['projects'] = [];

        $before = $u['projects'];

        // Add only — never remove existing entries
        $actually_added = 0;
        foreach ($add as $f) {
            $f = (string)$f;
            if ($f !== '' && !in_array($f, $u['projects'], true)) {
                $u['projects'][] = $f;
                $actually_added++;
            }
        }

        $after = $u['projects'];
        $ok = atomicWrite($uf, $u);

        echo json_encode([
            'success' => $ok,
            'email'   => $targetEmail,
            'before'  => count($before),
            'after'   => count($after),
            'added'   => $actually_added,
        ]);
        exit;
    }

    echo json_encode(['success' => false, 'error' => 'Unknown action']);
    exit;
}

// ── Render the HTML UI ──
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>User ↔ Project Reconciliation</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap');

  :root {
    --bg: #0c0e12;
    --surface: #151820;
    --surface2: #1c2030;
    --border: #2a2f42;
    --text: #d8dce8;
    --text-dim: #6b7394;
    --accent: #ff4444;
    --accent-glow: rgba(255,68,68,.15);
    --green: #22c55e;
    --green-glow: rgba(34,197,94,.12);
    --amber: #f59e0b;
    --amber-glow: rgba(245,158,11,.12);
    --blue: #3b82f6;
    --radius: 10px;
  }

  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 0;
  }

  .topbar {
    position: sticky; top: 0; z-index: 100;
    background: rgba(12,14,18,.85);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--border);
    padding: 16px 28px;
    display: flex; align-items: center; gap: 16px;
  }
  .topbar h1 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px; font-weight: 700;
    letter-spacing: -.02em;
    color: var(--accent);
  }
  .topbar .stats {
    font-size: 12px; color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
  }
  .topbar .stats b { color: var(--text); }

  .actions-bar {
    padding: 16px 28px;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  }

  button, .btn {
    font-family: 'DM Sans', sans-serif;
    font-size: 13px; font-weight: 600;
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    cursor: pointer;
    transition: all .15s;
  }
  button:hover { background: var(--border); }
  button:disabled { opacity: .4; cursor: not-allowed; }

  .btn-accent {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-accent:hover { background: #e03333; }

  .btn-green {
    background: var(--green);
    border-color: var(--green);
    color: #fff;
  }
  .btn-green:hover { background: #1aab50; }

  .btn-sm { padding: 5px 10px; font-size: 11px; }

  .container { padding: 0 28px 48px; }

  .empty-state {
    text-align: center; padding: 80px 20px;
    color: var(--text-dim);
  }
  .empty-state h2 { font-size: 20px; margin-bottom: 8px; color: var(--text); }

  .loading {
    text-align: center; padding: 80px 20px;
    color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }
  .loading .spinner {
    display: inline-block; width: 20px; height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .6s linear infinite;
    margin-bottom: 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .auth-wall {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; text-align: center;
  }
  .auth-wall h2 { color: var(--accent); margin-bottom: 8px; }
  .auth-wall p { color: var(--text-dim); font-size: 14px; }

  /* Card grid */
  .card-grid { display: flex; flex-direction: column; gap: 12px; }

  .user-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color .15s;
  }
  .user-card:hover { border-color: #3a4060; }
  .user-card.applied { border-color: var(--green); background: var(--green-glow); }

  .card-header {
    padding: 14px 18px;
    display: flex; align-items: center; gap: 12px;
    cursor: default; user-select: none;
  }
  .card-header:hover { background: var(--surface2); }

  .card-email {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px; font-weight: 600;
  }
  .card-name { font-size: 12px; color: var(--text-dim); }
  .card-type {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    padding: 2px 8px; border-radius: 4px;
    background: var(--surface2); color: var(--text-dim);
    border: 1px solid var(--border);
  }

  .badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; font-weight: 700;
    padding: 3px 8px; border-radius: 5px;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .badge-missing { background: var(--accent-glow); color: var(--accent); }
  .badge-extra { background: var(--amber-glow); color: var(--amber); }
  .badge-ok { background: var(--green-glow); color: var(--green); }
  .badge-no-file { background: var(--surface2); color: var(--text-dim); }

  .card-spacer { flex: 1; }
  .card-chevron {
    color: var(--text-dim); font-size: 14px;
    transition: transform .2s;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .card-chevron:hover { background: var(--surface2); color: var(--text); }
  .card-chevron.open { transform: rotate(90deg); }

  .card-body {
    display: none;
    padding: 0 18px 16px;
    border-top: 1px solid var(--border);
  }
  .card-body.open { display: block; padding-top: 14px; }

  .section-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; font-weight: 700;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 8px; margin-top: 14px;
  }
  .section-label:first-child { margin-top: 0; }

  .folder-list { display: flex; flex-direction: column; gap: 4px; }

  .folder-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: var(--surface2);
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }
  .folder-item .addr {
    color: var(--text-dim); font-family: 'DM Sans', sans-serif;
    font-size: 12px; margin-left: 4px;
  }
  .folder-item .status-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .status-completed { background: var(--green); }
  .status-processing, .status-in_progress { background: var(--blue); }
  .status-queued, .status-ready { background: var(--amber); }
  .status-other { background: var(--text-dim); }

  .folder-item input[type=checkbox] {
    accent-color: var(--accent);
    width: 14px; height: 14px;
  }

  .card-actions {
    margin-top: 14px;
    display: flex; gap: 8px; align-items: center;
  }
  .card-actions .result {
    font-size: 12px; color: var(--green);
    font-family: 'JetBrains Mono', monospace;
  }

  .filter-bar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .filter-bar input {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    width: 240px;
  }
  .filter-bar input::placeholder { color: var(--text-dim); }
  .filter-bar input:focus { outline: none; border-color: var(--accent); }

  .filter-chip {
    font-size: 12px; font-weight: 600;
    padding: 6px 12px; border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent; color: var(--text-dim);
    cursor: pointer; transition: all .15s;
  }
  .filter-chip:hover { border-color: var(--text-dim); }
  .filter-chip.active {
    background: var(--accent); border-color: var(--accent);
    color: #fff;
  }

  .summary-row {
    display: flex; gap: 20px; padding: 12px 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px; color: var(--text-dim);
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .summary-row b { color: var(--text); }

  /* Selection */
  .user-card.selected {
    border-color: var(--blue);
    box-shadow: 0 0 0 1px var(--blue), 0 0 12px rgba(59,130,246,.15);
  }
  .user-card.selected .card-header::before {
    content: '✓';
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; border-radius: 5px;
    background: var(--blue); color: #fff;
    font-size: 10px; font-weight: 700;
    flex-shrink: 0;
  }
  .user-card:not(.selected) .card-header::before {
    content: '';
    display: inline-block;
    width: 18px; height: 18px; border-radius: 5px;
    border: 2px solid var(--border);
    flex-shrink: 0;
  }
  .user-card:not(.selected) .card-header:hover::before {
    border-color: var(--text-dim);
  }

  /* Selection bar (sticky bottom) */
  .selection-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    z-index: 200;
    background: rgba(28,32,48,.92);
    backdrop-filter: blur(16px);
    border-top: 1px solid var(--blue);
    padding: 12px 28px;
    display: flex; align-items: center; gap: 14px;
    transform: translateY(100%);
    transition: transform .2s ease;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }
  .selection-bar.visible { transform: translateY(0); }
  .selection-bar .sel-count { color: var(--blue); font-weight: 700; }
  .selection-bar .sel-spacer { flex: 1; }

  /* Account type toggle chips */
  .toggle-chip {
    font-size: 11px; font-weight: 600;
    padding: 5px 10px; border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent; color: var(--text-dim);
    cursor: pointer; transition: all .15s;
    user-select: none;
  }
  .toggle-chip:hover { border-color: var(--text-dim); }
  .toggle-chip.on {
    background: var(--surface2); border-color: var(--text-dim);
    color: var(--text);
  }
  .toggle-chip .dot {
    display: inline-block; width: 7px; height: 7px;
    border-radius: 50%; margin-right: 4px;
    vertical-align: middle;
  }
  .toggle-chip .dot-emp { background: var(--blue); }
  .toggle-chip .dot-cust { background: var(--amber); }
  .toggle-chip .dot-other { background: var(--text-dim); }

  .filter-sep {
    width: 1px; height: 20px; background: var(--border);
    margin: 0 4px;
  }
</style>
</head>
<body>

<?php if (!$loggedIn || !$isAdmin): ?>
<div class="auth-wall">
  <div>
    <h2>Admin access required</h2>
    <p>Log in to the main app as an admin, then visit this page.</p>
  </div>
</div>
<?php else: ?>

<div class="topbar">
  <h1>RECONCILE</h1>
  <div class="stats" id="stats">User ↔ Project sync tool</div>
</div>

<div class="actions-bar">
  <button class="btn-accent" onclick="doScan()" id="scanBtn">Scan for discrepancies</button>
  <button onclick="applyAllVisible()" id="applyAllBtn" disabled>Add missing → all visible</button>
  <div style="flex:1"></div>
  <div class="filter-bar" id="filterBar" style="display:none">
    <input type="text" id="searchInput" placeholder="Filter by email or address…" oninput="applyFilters()">
    <button class="filter-chip active" data-filter="all" onclick="setFilter(this)">All</button>
    <button class="filter-chip" data-filter="missing" onclick="setFilter(this)">Missing only</button>
    <button class="filter-chip" data-filter="extra" onclick="setFilter(this)">Extra only</button>
    <button class="filter-chip" data-filter="no_file" onclick="setFilter(this)">No user file</button>
    <div class="filter-sep"></div>
    <button class="toggle-chip on" id="toggleEmp" onclick="toggleAccountType('employee')"><span class="dot dot-emp"></span>Employees</button>
    <button class="toggle-chip on" id="toggleCust" onclick="toggleAccountType('customer')"><span class="dot dot-cust"></span>Customers</button>
    <button class="toggle-chip on" id="toggleOther" onclick="toggleAccountType('other')"><span class="dot dot-other"></span>Other</button>
  </div>
</div>

<!-- Selection bar (fixed bottom, slides up when items selected) -->
<div class="selection-bar" id="selectionBar">
  <span class="sel-count" id="selCount">0 selected</span>
  <button class="btn-green btn-sm" onclick="applySelected()">Add missing → selected users</button>
  <button class="btn-sm" onclick="clearSelection()">Clear selection</button>
  <span class="sel-spacer"></span>
  <span style="color:var(--text-dim); font-size:11px">Click to select · Ctrl+Click to add · Shift+Click for range</span>
</div>

<div class="container" id="content">
  <div class="empty-state">
    <h2>Ready to scan</h2>
    <p>Click "Scan for discrepancies" to cross-reference project manifests against user files.</p>
  </div>
</div>

<script>
let DATA = null;
let FILTER = 'all';
let APPLIED = new Set();
let SELECTED = new Set();      // set of card indices
let LAST_CLICK_IDX = null;     // for shift-click range
let VISIBLE_ITEMS = [];        // current filtered list (needed for shift-range)
let SHOW_ACCOUNT = { employee: true, customer: true, other: true };

async function doScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  SELECTED.clear();
  LAST_CLICK_IDX = null;
  updateSelectionBar();

  document.getElementById('content').innerHTML =
    '<div class="loading"><div class="spinner"></div><br>Scanning manifests & user files…</div>';

  const fd = new FormData();
  fd.append('_reconcile_action', 'scan');

  try {
    const res = await fetch(location.href, { method: 'POST', body: fd });
    DATA = await res.json();

    if (!DATA.success) {
      document.getElementById('content').innerHTML =
        '<div class="empty-state"><h2>Error</h2><p>' + (DATA.error || 'Unknown error') + '</p></div>';
      return;
    }

    document.getElementById('stats').innerHTML =
      '<b>' + DATA.total_projects + '</b> projects · ' +
      '<b>' + DATA.total_users + '</b> users · ' +
      '<b>' + DATA.discrepancies.length + '</b> discrepancies';

    document.getElementById('filterBar').style.display = 'flex';
    renderCards();
  } catch (e) {
    document.getElementById('content').innerHTML =
      '<div class="empty-state"><h2>Network error</h2><p>' + e.message + '</p></div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan for discrepancies';
  }
}

// ── Type filter (single-select) ──
function setFilter(el) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  FILTER = el.dataset.filter;
  SELECTED.clear(); LAST_CLICK_IDX = null; updateSelectionBar();
  renderCards();
}

// ── Account type toggles (independent on/off) ──
function toggleAccountType(type) {
  SHOW_ACCOUNT[type] = !SHOW_ACCOUNT[type];
  document.getElementById(
    type === 'employee' ? 'toggleEmp' : type === 'customer' ? 'toggleCust' : 'toggleOther'
  ).classList.toggle('on', SHOW_ACCOUNT[type]);
  SELECTED.clear(); LAST_CLICK_IDX = null; updateSelectionBar();
  renderCards();
}

function applyFilters() {
  SELECTED.clear(); LAST_CLICK_IDX = null; updateSelectionBar();
  renderCards();
}

function accountBucket(acctType) {
  const t = (acctType || '').toLowerCase();
  if (t === 'employee') return 'employee';
  if (t === 'customer') return 'customer';
  return 'other';
}

function renderCards() {
  if (!DATA) return;
  const search = (document.getElementById('searchInput').value || '').toLowerCase();
  const container = document.getElementById('content');
  let items = DATA.discrepancies;

  // Type filter
  items = items.filter(d => {
    if (FILTER === 'missing' && d.missing.length === 0) return false;
    if (FILTER === 'extra' && d.extra.length === 0) return false;
    if (FILTER === 'no_file' && d.type !== 'no_user_file') return false;
    return true;
  });

  // Account type toggle
  items = items.filter(d => {
    const bucket = accountBucket(d.account_type);
    return SHOW_ACCOUNT[bucket];
  });

  // Text search
  if (search) {
    items = items.filter(d => {
      const haystack = (d.email + ' ' + d.name + ' ' +
        d.missing.map(f => addrFor(f)).join(' ') +
        d.extra.map(f => addrFor(f)).join(' ')).toLowerCase();
      return haystack.includes(search);
    });
  }

  VISIBLE_ITEMS = items;

  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state"><h2>No discrepancies found</h2>' +
      '<p>' + (DATA.discrepancies.length > 0 ? 'Try adjusting filters.' : 'All user files match their project manifests.') + '</p></div>';
    document.getElementById('applyAllBtn').disabled = true;
    return;
  }

  let totalMissing = 0, totalExtra = 0;
  items.forEach(d => { totalMissing += d.missing.length; totalExtra += d.extra.length; });

  let html = '<div class="summary-row">' +
    '<span>Showing <b>' + items.length + '</b> users</span>' +
    '<span><b style="color:var(--accent)">' + totalMissing + '</b> missing entries (will add)</span>' +
    '<span><b style="color:var(--amber)">' + totalExtra + '</b> extra entries (info only)</span>' +
    '</div>';

  html += '<div class="card-grid">';
  items.forEach((d, i) => {
    const applied = APPLIED.has(d.email);
    const selected = SELECTED.has(i);
    const fixable = d.type !== 'no_user_file' && d.missing.length > 0;
    html += '<div class="user-card' +
      (applied ? ' applied' : '') +
      (selected ? ' selected' : '') +
      '" id="card-' + i + '" data-idx="' + i + '" data-fixable="' + (fixable ? '1' : '0') + '" data-email="' + esc(d.email) + '">';
    html += '<div class="card-header" onclick="handleCardClick(event,' + i + ')">';

    html += '<div><div class="card-email">' + esc(d.email) + '</div>';
    if (d.name) html += '<div class="card-name">' + esc(d.name) + '</div>';
    html += '</div>';

    if (d.account_type) html += '<span class="card-type">' + esc(d.account_type) + '</span>';

    if (d.type === 'no_user_file') {
      html += '<span class="badge badge-no-file">NO USER FILE</span>';
    }
    if (d.missing.length > 0) {
      html += '<span class="badge badge-missing">+' + d.missing.length + ' missing</span>';
    }
    if (d.extra.length > 0) {
      html += '<span class="badge badge-extra">' + d.extra.length + ' extra</span>';
    }
    if (applied) {
      html += '<span class="badge badge-ok">✓ Applied</span>';
    }

    html += '<span class="card-spacer"></span>';
    html += '<span class="card-chevron" id="chev-' + i + '" onclick="toggleCard(' + i + '); event.stopPropagation();" title="Expand details">▸</span>';
    html += '</div>'; // header

    html += '<div class="card-body" id="body-' + i + '">';

    if (d.missing.length > 0) {
      html += '<div class="section-label">Missing from user file (will add)</div>';
      html += '<div class="folder-list">';
      d.missing.forEach(f => {
        const info = DATA.addresses[f] || {};
        html += '<div class="folder-item">' +
          '<input type="checkbox" checked data-email="' + esc(d.email) + '" data-folder="' + esc(f) + '" data-action="add">' +
          statusDot(info.status) +
          '<span>' + esc(f.substring(0,10)) + '…</span>' +
          '<span class="addr">' + esc(info.address || 'Unknown') + '</span>' +
          '<span class="addr" style="color:var(--text-dim);font-size:10px">' + esc(info.status || '') + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    if (d.extra.length > 0) {
      html += '<div class="section-label">Extra in user file <span style="font-weight:400;text-transform:none;color:var(--text-dim)">(info only — will not be removed)</span></div>';
      html += '<div class="folder-list">';
      d.extra.forEach(f => {
        const info = DATA.addresses[f] || {};
        html += '<div class="folder-item" style="opacity:.55">' +
          statusDot(info.status) +
          '<span>' + esc(f.substring(0,10)) + '…</span>' +
          '<span class="addr">' + esc(info.address || 'No manifest') + '</span>' +
          '<span class="addr" style="color:var(--text-dim);font-size:10px">' + esc(info.status || 'missing') + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    if (d.type !== 'no_user_file' && d.missing.length > 0) {
      html += '<div class="card-actions">' +
        '<button class="btn-green btn-sm" onclick="applyOne(\'' + esc(d.email) + '\',' + i + ')">Add missing projects</button>' +
        '<span class="result" id="result-' + i + '"></span>' +
        '</div>';
    } else if (d.type !== 'no_user_file' && d.missing.length === 0) {
      html += '<div class="card-actions"><span style="color:var(--text-dim);font-size:12px">Extras only — nothing to add.</span></div>';
    } else {
      html += '<div class="card-actions"><span style="color:var(--text-dim);font-size:12px">Cannot auto-fix: no user file exists for this email.</span></div>';
    }

    html += '</div>'; // body
    html += '</div>'; // card
  });
  html += '</div>';

  container.innerHTML = html;

  const hasFixable = items.some(d => d.type !== 'no_user_file' && d.missing.length > 0);
  document.getElementById('applyAllBtn').disabled = !hasFixable;
}

// ── Card click: click = select, Ctrl/Cmd = toggle, Shift = range ──
function handleCardClick(e, idx) {
  // Don't interfere with checkboxes, buttons, or the chevron inside the card
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  if (e.target.closest('.card-chevron')) return;

  e.preventDefault();
  const isCtrl = e.ctrlKey || e.metaKey;
  const isShift = e.shiftKey;

  if (isShift && LAST_CLICK_IDX !== null) {
    // Range select: add everything between last click and this one
    const lo = Math.min(LAST_CLICK_IDX, idx);
    const hi = Math.max(LAST_CLICK_IDX, idx);
    for (let j = lo; j <= hi; j++) SELECTED.add(j);
  } else if (isCtrl) {
    // Toggle this one in/out of selection
    if (SELECTED.has(idx)) SELECTED.delete(idx);
    else SELECTED.add(idx);
    LAST_CLICK_IDX = idx;
  } else {
    // Plain click: select only this one (replace selection)
    SELECTED.clear();
    SELECTED.add(idx);
    LAST_CLICK_IDX = idx;
  }

  syncSelectionVisuals();
  updateSelectionBar();
}

function toggleCard(i) {
  const body = document.getElementById('body-' + i);
  const chev = document.getElementById('chev-' + i);
  if (body) body.classList.toggle('open');
  if (chev) chev.classList.toggle('open');
}

function syncSelectionVisuals() {
  document.querySelectorAll('.user-card').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    el.classList.toggle('selected', SELECTED.has(idx));
  });
}

function updateSelectionBar() {
  const bar = document.getElementById('selectionBar');
  if (SELECTED.size === 0) {
    bar.classList.remove('visible');
    return;
  }
  bar.classList.add('visible');
  // Count how many selected are fixable
  let fixable = 0;
  SELECTED.forEach(idx => {
    const card = document.getElementById('card-' + idx);
    if (card && card.dataset.fixable === '1') fixable++;
  });
  document.getElementById('selCount').textContent =
    SELECTED.size + ' selected' + (fixable < SELECTED.size ? ' (' + fixable + ' fixable)' : '');
}

function clearSelection() {
  SELECTED.clear();
  LAST_CLICK_IDX = null;
  syncSelectionVisuals();
  updateSelectionBar();
}

// ── Apply: single user ──
async function applyOne(email, cardIndex) {
  const card = document.getElementById('card-' + cardIndex);
  const boxes = card.querySelectorAll('input[type=checkbox]');
  const add = [];

  boxes.forEach(cb => {
    if (!cb.checked) return;
    if (cb.dataset.action === 'add') add.push(cb.dataset.folder);
  });

  if (add.length === 0) {
    document.getElementById('result-' + cardIndex).textContent = 'Nothing selected';
    return;
  }

  const fd = new FormData();
  fd.append('_reconcile_action', 'apply');
  fd.append('email', email);
  fd.append('add', JSON.stringify(add));

  try {
    const res = await fetch(location.href, { method: 'POST', body: fd });
    const j = await res.json();
    if (j.success) {
      APPLIED.add(email);
      document.getElementById('result-' + cardIndex).textContent =
        '✓ Done — added ' + j.added + ' project(s)';
      card.classList.add('applied');
    } else {
      document.getElementById('result-' + cardIndex).textContent = '✗ ' + (j.error || 'Failed');
    }
  } catch (e) {
    document.getElementById('result-' + cardIndex).textContent = '✗ ' + e.message;
  }
}

// ── Apply: all visible ──
async function applyAllVisible() {
  if (!confirm('Add all checked missing projects for all visible users? (Nothing will be removed.)')) return;
  const cards = document.querySelectorAll('.user-card');
  for (const card of cards) {
    if (card.classList.contains('applied')) continue;
    const btn = card.querySelector('.btn-green');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 80));
  }
}

// ── Apply: selected only ──
async function applySelected() {
  const indices = [...SELECTED].sort((a, b) => a - b);
  const fixable = indices.filter(idx => {
    const card = document.getElementById('card-' + idx);
    return card && card.dataset.fixable === '1' && !card.classList.contains('applied');
  });

  if (fixable.length === 0) {
    alert('No fixable users in selection.');
    return;
  }

  if (!confirm('Add missing projects for ' + fixable.length + ' selected user(s)? (Nothing will be removed.)')) return;

  for (const idx of fixable) {
    const card = document.getElementById('card-' + idx);
    if (!card) continue;
    const btn = card.querySelector('.btn-green');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 80));
  }

  clearSelection();
}

function addrFor(f) {
  if (!DATA || !DATA.addresses[f]) return '';
  return DATA.addresses[f].address || '';
}

function statusDot(s) {
  s = (s || '').toLowerCase();
  let cls = 'status-other';
  if (s === 'completed') cls = 'status-completed';
  else if (s === 'processing' || s === 'in_progress') cls = 'status-processing';
  else if (s === 'queued' || s === 'ready') cls = 'status-queued';
  return '<span class="status-dot ' + cls + '"></span>';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
</script>

<?php endif; ?>
</body>
</html>