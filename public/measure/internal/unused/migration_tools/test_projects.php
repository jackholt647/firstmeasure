<?php
require_once __DIR__ . '/_storage.php';
/**
 * submit_on_behalf.php
 *
 * Admin tool: submit projects on behalf of test-organization users.
 * - Loads all test orgs + their member users
 * - Google Maps pin placement
 * - Submits via the existing queue action in server.php
 *
 * Extended:
 * - Per-org probabilistic scheduler with active-hour windows
 * - Address queue with pre-approved pins (localStorage)
 * - Queue builder UI for mass pin placement (keyboard-navigable)
 * - Daily submission tracking (user timezone-aware)
 */
session_start();

// --- AUTH CHECK ---
if (!isset($_SESSION['user_email'])) {
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

// --- LOAD DATA SERVER-SIDE ---
require_once __DIR__ . '/_config.php';
require_once __DIR__ . '/_organizations.php';
require_once __DIR__ . '/_users.php';
require_once __DIR__ . '/_project_api.php';

$actorEmail = $_SESSION['user_email'];

function sobReadTestOrg($orgId) {
    $orgId = function_exists('orgNormalizeId') ? orgNormalizeId($orgId) : trim((string)$orgId);
    if ($orgId === '') return null;
    $o = function_exists('orgRead') ? orgRead($orgId) : null;
    if (!is_array($o)) {
        $mp = orgDirPath() . $orgId . '/manifest.json';
        if (file_exists($mp)) $o = json_decode(file_get_contents($mp), true);
    }
    if (!is_array($o) || empty($o['is_test'])) return null;
    return $o;
}

// ============================================================
//  MINI API — handle AJAX actions before rendering HTML
// ============================================================
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !empty($_POST['_sob_action'])) {
    header('Content-Type: application/json');
    $sobAction = (string)$_POST['_sob_action'];

    if ($sobAction === 'grant_test_credits') {
        $orgId  = trim((string)($_POST['org_id'] ?? ''));
        $amount = (int)($_POST['amount'] ?? 0);
        if ($orgId === '' || $amount < 1) { echo json_encode(['success' => false, 'error' => 'Missing org_id or amount']); exit; }
        $o = sobReadTestOrg($orgId);
        if (!is_array($o)) { echo json_encode(['success' => false, 'error' => 'Test org not found: ' . $orgId]); exit; }
        $oldBal = (int)($o['credits_balance'] ?? 0);
        $appliedForEmail = strtolower(trim((string)($_POST['applied_for_email'] ?? '')));
        $result = function_exists('creditsAddByOrganizationId')
            ? creditsAddByOrganizationId($orgId, $amount, 'test_project_credit_grant', [
                'source' => 'test_projects.php',
                'granted_by' => $actorEmail,
                'test_tool' => true,
            ], $appliedForEmail)
            : ['ok' => false, 'error' => 'creditsAddByOrganizationId unavailable'];
        if (empty($result['ok'])) {
            echo json_encode(['success' => false, 'error' => $result['error'] ?? 'Failed to grant credits']);
            exit;
        }
        echo json_encode(['success' => true, 'old_balance' => $oldBal, 'new_balance' => (int)($result['new_balance'] ?? ($oldBal + $amount)), 'granted' => $amount]);
        exit;
    }

    if ($sobAction === 'spend_test_credits') {
        $orgId  = trim((string)($_POST['org_id'] ?? ''));
        $amount = (int)($_POST['amount'] ?? 0);
        if ($orgId === '' || $amount < 1) { echo json_encode(['success' => false, 'error' => 'Missing org_id or amount']); exit; }
        $o = sobReadTestOrg($orgId);
        if (!is_array($o)) { echo json_encode(['success' => false, 'error' => 'Test org not found: ' . $orgId]); exit; }
        $oldBal = (int)($o['credits_balance'] ?? 0);
        if ($oldBal < $amount) { echo json_encode(['success' => false, 'error' => 'Insufficient test credits']); exit; }
        $appliedForEmail = strtolower(trim((string)($_POST['applied_for_email'] ?? '')));
        $result = function_exists('creditsAddByOrganizationId')
            ? creditsAddByOrganizationId($orgId, -$amount, 'test_project_order_submitted', [
                'source' => 'test_projects.php',
                'project_id' => trim((string)($_POST['project_id'] ?? '')),
                'address' => trim((string)($_POST['address'] ?? '')),
                'project_type' => trim((string)($_POST['project_type'] ?? 'residential')),
                'test_tool' => true,
            ], $appliedForEmail)
            : ['ok' => false, 'error' => 'creditsAddByOrganizationId unavailable'];
        if (empty($result['ok'])) {
            echo json_encode(['success' => false, 'error' => $result['error'] ?? 'Failed to spend credits']);
            exit;
        }
        echo json_encode(['success' => true, 'old_balance' => $oldBal, 'new_balance' => (int)($result['new_balance'] ?? ($oldBal - $amount)), 'spent' => $amount]);
        exit;
    }

    if ($sobAction === 'get_balance') {
        $orgId = trim((string)($_POST['org_id'] ?? ''));
        if ($orgId === '') { echo json_encode(['success' => false, 'error' => 'Missing org_id']); exit; }
        $o = sobReadTestOrg($orgId);
        if (!is_array($o)) { echo json_encode(['success' => false, 'error' => 'Test org not found']); exit; }
        echo json_encode(['success' => true, 'balance' => (int)($o['credits_balance'] ?? 0)]);
        exit;
    }

    echo json_encode(['success' => false, 'error' => 'Unknown _sob_action']);
    exit;
}

// ============================================================
//  AJAX: count today's orders
// ============================================================
if (isset($_GET['_sob_action']) && $_GET['_sob_action'] === 'count_today') {
    header('Content-Type: application/json');
    $orgBase = orgDirPath();
    $counts = [];
    if (is_dir($orgBase)) {
        foreach (scandir($orgBase) as $f) {
            if ($f === '.' || $f === '..') continue;
            $mp = $orgBase . $f . '/manifest.json';
            if (!file_exists($mp)) continue;
            $o = json_decode(file_get_contents($mp), true);
            if (!is_array($o) || empty($o['is_test'])) continue;
            $orgId = $o['id'] ?? $f;
            $counts[$orgId] = countTodayProjects($orgBase, $orgId);
        }
    }
    echo json_encode(['success' => true, 'counts' => $counts]);
    exit;
}

function countTodayProjects($orgBase, $orgId) {
    $fmCount = countTodayProjectsFirstMeasure($orgId);
    if ($fmCount !== null) return $fmCount;

    $todayStr = date('Y-m-d');
    $count = 0;
    $dirsToScan = ['projects', 'queue', 'orders', 'reports'];
    foreach ($dirsToScan as $sub) {
        $projDir = $orgBase . $orgId . '/' . $sub . '/';
        if (!is_dir($projDir)) continue;
        foreach (scandir($projDir) as $pf) {
            if ($pf === '.' || $pf === '..') continue;
            $pp = $projDir . $pf;
            if (is_dir($pp)) {
                $metaFile = null;
                foreach (['meta.json', 'manifest.json', 'project.json', 'order.json'] as $mf) {
                    if (file_exists($pp . '/' . $mf)) { $metaFile = $pp . '/' . $mf; break; }
                }
                if ($metaFile) {
                    $pMeta = @json_decode(file_get_contents($metaFile), true);
                    if (is_array($pMeta)) {
                        $created = $pMeta['created_at'] ?? $pMeta['created'] ?? $pMeta['date'] ?? $pMeta['submitted_at'] ?? $pMeta['timestamp'] ?? '';
                        if ($created && strpos((string)$created, $todayStr) === 0) { $count++; continue; }
                        if (is_numeric($created) && date('Y-m-d', (int)$created) === $todayStr) { $count++; continue; }
                    }
                }
                if (date('Y-m-d', filemtime($pp)) === $todayStr) $count++;
            } elseif (pathinfo($pf, PATHINFO_EXTENSION) === 'json') {
                $pMeta = @json_decode(file_get_contents($pp), true);
                if (is_array($pMeta)) {
                    $created = $pMeta['created_at'] ?? $pMeta['created'] ?? $pMeta['date'] ?? $pMeta['submitted_at'] ?? $pMeta['timestamp'] ?? '';
                    if ($created && strpos((string)$created, $todayStr) === 0) { $count++; continue; }
                    if (is_numeric($created) && date('Y-m-d', (int)$created) === $todayStr) { $count++; continue; }
                }
                if (date('Y-m-d', filemtime($pp)) === $todayStr) $count++;
            }
        }
    }
    return $count;
}

function countTodayProjectsFirstMeasure($orgId) {
    if (!function_exists('fm_project_list')) return null;
    $orgId = trim((string)$orgId);
    if ($orgId === '') return null;

    $today = date('Y-m-d');
    $page = 1;
    $limit = 500;
    $count = 0;
    $maxPages = 20;

    do {
        $result = fm_project_list([
            'organization_id' => $orgId,
            'activity_start' => $today,
            'activity_end' => $today,
            'activity_fields' => ['created', 'queued'],
            'include_instant_only' => true,
            'include_all' => false,
            'limit' => $limit,
            'page' => $page,
        ]);
        if (empty($result['ok'])) return null;

        $batch = is_array($result['projects'] ?? null) ? $result['projects'] : [];
        $count += count($batch);

        $pagination = is_array($result['pagination'] ?? null) ? $result['pagination'] : [];
        $totalPages = (int)($pagination['total_pages'] ?? $page);
        if ($totalPages <= 0) $totalPages = $page;
        $page++;
    } while ($page <= $totalPages && $page <= $maxPages);

    return $count;
}

// Gather test organizations + their users
$testOrgs = [];
$orgBase = orgDirPath();
if (is_dir($orgBase)) {
    foreach (scandir($orgBase) as $f) {
        if ($f === '.' || $f === '..') continue;
        $mp = $orgBase . $f . '/manifest.json';
        if (!file_exists($mp)) continue;
        $o = json_decode(file_get_contents($mp), true);
        if (!is_array($o)) continue;
        if (empty($o['is_test'])) continue;
        orgEnsureDefaults($o);
        $orgId = $o['id'] ?? $f;
        $orgUsers = [];
        $uList = $o['users'] ?? [];
        $uMeta = $o['users_meta'] ?? [];
        foreach ($uList as $uid) {
            $meta = $uMeta[$uid] ?? [];
            $email = $meta['email'] ?? null;
            $name  = $meta['name'] ?? null;
            $teamId = $meta['team_id'] ?? null;
            $role = $meta['role'] ?? null;
            if ($email) {
                $ud = readUserDataByEmail($email);
                if ($ud) {
                    $name = $name ?: ($ud['name'] ?? $email);
                    $teamId = $teamId ?: ($ud['team_id'] ?? null);
                    $role = $role ?: ($ud['role'] ?? null);
                }
            }
            $orgUsers[] = [
                'id' => $uid,
                'email' => $email ?: $uid,
                'name' => $name ?: ($email ?: $uid),
                'organization_id' => $orgId,
                'team_id' => $teamId ?: 'default',
                'role' => $role ?: 'user',
            ];
        }
        $testOrgs[] = ['id' => $orgId, 'name' => $o['name'] ?? $orgId, 'users' => $orgUsers, 'balance' => (int)($o['credits_balance'] ?? 0), 'today' => 0];
    }
}

usort($testOrgs, function($a, $b) { return strcasecmp($a['name'], $b['name']); });

$testOrgs = array_values(array_filter($testOrgs, function($org) {
    foreach ($org['users'] as $u) {
        $e = strtolower($u['email'] ?? '');
        if (strpos($e, 'company') !== false && strpos($e, '1m8.ai') !== false) return true;
    }
    return false;
}));

foreach ($testOrgs as &$tOrg) {
    $tOrg['today'] = 0;
}
unset($tOrg);

$GOOGLE_API_KEY = $GLOBALS['GOOGLE_API_KEY'] ?? 'REMOVED_CREDENTIAL';
$selfUrl   = basename(__FILE__);
$firstMeasureApiBase = function_exists('fm_api_base_url') ? fm_api_base_url() : '/v1/firstmeasure';

// Load full_addresses.json for the queue builder
$addressesPath = storageExistingPath('data/full_addresses.json', __DIR__ . '/full_addresses.json', true);
$addresses = [];
if (file_exists($addressesPath)) {
    $raw = json_decode(file_get_contents($addressesPath), true);
    if (is_array($raw)) {
        foreach ($raw as $item) {
            if (is_string($item) && trim($item) !== '') {
                $addresses[] = trim($item);
            } elseif (is_array($item)) {
                $addr = $item['address'] ?? $item['full_address'] ?? $item[0] ?? null;
                if ($addr && is_string($addr) && trim($addr) !== '') $addresses[] = trim($addr);
            }
        }
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Submit on Behalf — Test Orgs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300..800;1,9..40,300..800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://maps.googleapis.com/maps/api/js?key=<?= htmlspecialchars($GOOGLE_API_KEY) ?>&libraries=places&v=weekly" defer></script>
<style>
  :root {
    --bg: #0c0c0e;
    --surface: #161619;
    --surface2: #1e1e22;
    --surface3: #26262b;
    --border: #2a2a30;
    --border-focus: #f0353590;
    --text: #e8e8ec;
    --text2: #9898a4;
    --text3: #606070;
    --accent: #f03535;
    --accent-dim: #f0353520;
    --accent-med: #f0353540;
    --green: #22c55e;
    --green-dim: #22c55e18;
    --blue: #3b82f6;
    --blue-dim: #3b82f618;
    --yellow: #eab308;
    --yellow-dim: #eab30818;
    --purple: #a855f7;
    --purple-dim: #a855f718;
    --radius: 12px;
    --radius-sm: 8px;
    --radius-lg: 16px;
    --mono: 'JetBrains Mono', monospace;
    --sans: 'DM Sans', system-ui, -apple-system, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  .shell {
    display: grid;
    grid-template-columns: 440px 1fr;
    height: 100vh;
    overflow: hidden;
  }

  /* ---- Left Panel ---- */
  .panel {
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .panel-header h1 {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.3px;
    margin-bottom: 2px;
  }

  .panel-header .sub {
    font-size: 11px;
    color: var(--text3);
    font-weight: 500;
  }

  /* ---- Tab Bar ---- */
  .tab-bar {
    display: flex;
    gap: 2px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }

  .tab-btn {
    flex: 1;
    padding: 7px 10px;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--text3);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    letter-spacing: 0.1px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }

  .tab-btn:hover { background: var(--surface2); color: var(--text2); }
  .tab-btn.active { background: var(--surface2); color: var(--text); }

  .tab-btn .tab-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--green);
    display: none;
  }

  .tab-btn.has-dot .tab-dot { display: block; }

  /* ---- Tab Panes ---- */
  .tab-pane {
    display: none;
    flex: 1;
    overflow-y: auto;
    flex-direction: column;
    min-height: 0;
  }

  .tab-pane.active { display: flex; }

  .tab-pane::-webkit-scrollbar { width: 5px; }
  .tab-pane::-webkit-scrollbar-track { background: transparent; }
  .tab-pane::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .pane-body {
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    flex: 1;
  }

  /* ---- Form elements ---- */
  .field { display: flex; flex-direction: column; gap: 5px; }

  .field-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    color: var(--text3);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .field-label .badge {
    font-size: 9px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 700;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }

  select, input[type="text"], input[type="number"], input[type="time"], textarea {
    width: 100%;
    padding: 9px 11px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 500;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  select:focus, input:focus, textarea:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }

  select {
    cursor: pointer; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239898a4' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 11px center;
    padding-right: 30px;
  }

  select option { background: var(--surface2); color: var(--text); }
  textarea { resize: vertical; min-height: 56px; line-height: 1.45; }

  .divider { height: 1px; background: var(--border); margin: 2px 0; }

  /* ---- Type Selector ---- */
  .type-group { display: flex; gap: 5px; }

  .type-btn {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 10px 4px 9px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border);
    background: var(--surface2);
    cursor: pointer; transition: all 0.15s; user-select: none;
  }

  .type-btn:hover { border-color: var(--text3); background: var(--surface3); }
  .type-btn.active { border-color: var(--accent); background: var(--accent-dim); }

  .type-btn .t-icon {
    width: 28px; height: 28px; border-radius: 7px;
    background: var(--surface3);
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; color: var(--text2); transition: all 0.15s;
  }

  .type-btn.active .t-icon { background: var(--accent-med); color: var(--accent); }
  .type-btn .t-label { font-size: 10px; font-weight: 700; color: var(--text2); }
  .type-btn .t-price { font-size: 9px; font-weight: 600; color: var(--text3); font-family: var(--mono); }
  .type-btn.active .t-label { color: var(--accent); }
  .type-btn.active .t-price { color: var(--accent); }

  /* ---- Org Buttons ---- */
  .org-group { display: flex; flex-direction: column; gap: 5px; }

  .org-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; border-radius: var(--radius-sm);
    border: 1.5px solid var(--border); background: var(--surface2);
    cursor: pointer; transition: all 0.15s; user-select: none; width: 100%;
  }

  .org-btn:hover { border-color: var(--text3); background: var(--surface3); }
  .org-btn.active { border-color: var(--accent); background: var(--accent-dim); }

  .org-btn .ob-name { font-size: 12px; font-weight: 700; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .org-btn.active .ob-name { color: var(--accent); }

  .org-btn .ob-badge {
    font-size: 10px; font-weight: 700; font-family: var(--mono);
    padding: 2px 7px; border-radius: 10px;
    background: var(--surface3); color: var(--text3); white-space: nowrap; line-height: 1.3;
  }

  .org-btn.active .ob-badge { background: var(--accent-med); color: var(--accent); }

  /* ---- Pin Info ---- */
  .pin-bar {
    display: flex; align-items: center; gap: 7px;
    padding: 8px 11px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
    font-size: 12px; font-weight: 600; color: var(--text2); transition: all 0.15s;
  }

  .pin-bar.has-pins { border-color: #22c55e40; background: var(--green-dim); color: var(--green); }

  .pin-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 20px; border-radius: 5px;
    background: var(--surface3); font-weight: 800; font-size: 11px;
    font-family: var(--mono); padding: 0 5px;
  }

  .pin-bar.has-pins .pin-count { background: #22c55e20; }

  .pin-clear {
    margin-left: auto; padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--surface);
    font-size: 10px; font-weight: 700; color: var(--text3);
    cursor: pointer; transition: 0.14s; display: none;
  }

  .pin-clear:hover { background: #f0353520; color: var(--accent); border-color: var(--accent); }
  .pin-bar.has-pins .pin-clear { display: block; }

  /* ---- Address Row ---- */
  .address-row { display: flex; gap: 6px; align-items: stretch; }
  .address-row input { flex: 1; }

  .btn-random {
    display: flex; align-items: center; justify-content: center; gap: 4px;
    padding: 0 11px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface2);
    color: var(--text2); font-family: var(--sans);
    font-size: 11px; font-weight: 700; cursor: pointer;
    transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
  }

  .btn-random:hover { border-color: var(--blue); color: var(--blue); background: var(--blue-dim); }
  .btn-random.loading { pointer-events: none; opacity: 0.5; }

  /* ---- Credit Banner ---- */
  .credit-banner {
    display: none; align-items: center; gap: 7px;
    padding: 8px 11px; border-radius: var(--radius-sm);
    font-size: 11px; font-weight: 700; line-height: 1.35;
  }

  .credit-banner.visible { display: flex; }
  .credit-banner.info { background: var(--blue-dim); border: 1px solid #3b82f630; color: #60a5fa; }

  /* ---- Org Card ---- */
  .org-card {
    padding: 10px 12px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
    display: none;
  }

  .org-card.visible { display: flex; gap: 11px; align-items: center; }

  .org-card .org-avatar {
    width: 34px; height: 34px; border-radius: 8px;
    background: var(--accent-dim);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 800; color: var(--accent); flex-shrink: 0;
  }

  .org-card .org-meta { flex: 1; min-width: 0; }
  .org-card .org-name { font-size: 13px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .org-card .org-detail { font-size: 11px; color: var(--text3); font-family: var(--mono); font-weight: 500; }

  .user-info { font-size: 11px; color: var(--text3); font-family: var(--mono); font-weight: 500; padding: 1px 0 0; }

  /* ---- Actions ---- */
  .actions {
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    display: flex; gap: 7px; flex-shrink: 0;
  }

  .btn {
    flex: 1; padding: 10px 12px; border-radius: var(--radius-sm); border: none;
    font-family: var(--sans); font-size: 13px; font-weight: 700;
    cursor: pointer; transition: all 0.15s; letter-spacing: -0.1px;
  }

  .btn-secondary { background: var(--surface2); color: var(--text2); border: 1px solid var(--border); }
  .btn-secondary:hover { background: var(--surface3); color: var(--text); }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #d42d2d; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-blue { background: var(--blue); color: #fff; border: none; }
  .btn-blue:hover { background: #2563eb; }
  .btn-blue:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-green { background: var(--green); color: #0a1a10; border: none; }
  .btn-green:hover { background: #16a34a; }

  /* ---- Map Area ---- */
  .map-area { position: relative; background: #0a0a0c; }
  #map { position: absolute; inset: 0; }

  .map-hint {
    position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
    background: var(--surface); border: 1px solid var(--border);
    padding: 7px 14px; border-radius: 999px;
    font-size: 12px; font-weight: 700; color: var(--text2);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    z-index: 5; pointer-events: none; transition: opacity 0.2s;
    white-space: nowrap;
  }

  .map-hint.hidden { opacity: 0; }

  /* ====================================================
     QUEUE BUILDER OVERLAY
     ==================================================== */
  .qb-overlay {
    position: absolute; inset: 0; z-index: 20;
    display: none;
    flex-direction: column;
    pointer-events: none;
  }

  .qb-overlay.active { display: flex; }

  /* Only the UI bars are interactive — middle gap passes clicks through to map */
  .qb-progress-bar,
  .qb-topbar,
  .qb-mid,
  .qb-bottombar { pointer-events: auto; }

  /* Top bar */
  .qb-topbar {
    background: rgba(12,12,14,0.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 10px 18px;
    display: flex; align-items: center; gap: 12px;
    flex-shrink: 0;
  }

  .qb-title { font-size: 13px; font-weight: 700; color: var(--text); }
  .qb-prog { font-size: 11px; font-weight: 600; color: var(--text3); font-family: var(--mono); }

  .qb-addr {
    flex: 1; font-size: 12px; font-weight: 600; color: var(--text2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: var(--surface2); border: 1px solid var(--border);
    padding: 6px 10px; border-radius: 7px;
  }

  .qb-status {
    font-size: 10px; font-weight: 700; font-family: var(--mono);
    padding: 4px 9px; border-radius: 6px;
    background: var(--green-dim); color: var(--green);
    border: 1px solid #22c55e30; white-space: nowrap;
  }

  .qb-status.loading { background: var(--yellow-dim); color: var(--yellow); border-color: #eab30830; }
  .qb-status.existing { background: var(--blue-dim); color: var(--blue); border-color: #3b82f630; }

  /* Pin type selector in QB */
  .qb-type-row {
    display: flex; gap: 5px; padding: 0 4px;
    flex-shrink: 0;
  }

  .qb-type-pill {
    padding: 4px 10px; border-radius: 20px;
    border: 1px solid var(--border); background: var(--surface2);
    font-size: 10px; font-weight: 700; color: var(--text3);
    cursor: pointer; transition: 0.14s; user-select: none;
  }

  .qb-type-pill.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }

  /* Bottom bar */
  .qb-bottombar {
    margin-top: auto;
    background: rgba(12,12,14,0.92);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--border);
    padding: 12px 18px;
    display: flex; align-items: center; gap: 10px;
  }

  .qb-nav-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 9px 16px; border-radius: var(--radius-sm);
    border: 1.5px solid var(--border); background: var(--surface2);
    color: var(--text2); font-family: var(--sans); font-size: 12px; font-weight: 700;
    cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }

  .qb-nav-btn:hover { border-color: var(--text2); color: var(--text); background: var(--surface3); }
  .qb-nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .qb-nav-btn.primary { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
  .qb-nav-btn.primary:hover { background: var(--accent); color: #fff; }

  .qb-kbd { font-size: 9px; padding: 2px 5px; border-radius: 4px; background: var(--surface3); color: var(--text3); font-family: var(--mono); }

  .qb-center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .qb-pin-count { font-size: 12px; font-weight: 700; color: var(--text2); font-family: var(--mono); }
  .qb-pin-clear { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text3); font-size: 10px; font-weight: 700; font-family: var(--sans); cursor: pointer; transition: 0.14s; }
  .qb-pin-clear:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .qb-skip-btn {
    padding: 5px 10px; border-radius: 6px;
    border: 1px dashed var(--border); background: transparent;
    color: var(--text3); font-size: 10px; font-weight: 700;
    font-family: var(--sans); cursor: pointer; transition: 0.14s;
  }

  .qb-skip-btn:hover { border-color: var(--yellow); color: var(--yellow); background: var(--yellow-dim); }

  .qb-done-btn {
    padding: 9px 16px; border-radius: var(--radius-sm);
    border: none; background: var(--green); color: #0a1a10;
    font-family: var(--sans); font-size: 12px; font-weight: 700;
    cursor: pointer; transition: all 0.15s;
  }

  .qb-done-btn:hover { background: #16a34a; }

  /* Progress bar */
  .qb-progress-bar {
    height: 3px; background: var(--border);
    flex-shrink: 0;
  }

  .qb-progress-fill {
    height: 100%; background: var(--accent);
    transition: width 0.3s ease;
  }

  /* Middle floating type selector */
  .qb-mid { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 18px; flex-shrink: 0; }

  /* ====================================================
     QUEUE TAB
     ==================================================== */
  .queue-stats-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
  }

  .stat-card {
    padding: 12px 14px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 4px;
  }

  .stat-card .sc-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); }
  .stat-card .sc-value { font-size: 22px; font-weight: 800; color: var(--text); font-family: var(--mono); line-height: 1; }
  .stat-card .sc-sub { font-size: 10px; font-weight: 600; color: var(--text3); }

  .stat-card.green { border-color: #22c55e30; }
  .stat-card.green .sc-value { color: var(--green); }
  .stat-card.blue { border-color: #3b82f630; }
  .stat-card.blue .sc-value { color: var(--blue); }
  .stat-card.yellow { border-color: #eab30830; }
  .stat-card.yellow .sc-value { color: var(--yellow); }

  .queue-actions { display: flex; gap: 7px; }
  .queue-actions .btn { font-size: 12px; padding: 9px 12px; }

  .queue-list-header {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; font-weight: 700; color: var(--text3);
    text-transform: uppercase; letter-spacing: 0.5px;
    padding: 0 2px;
  }

  .queue-list { display: flex; flex-direction: column; gap: 3px; }

  .queue-item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 11px; border-radius: 7px;
    background: var(--surface2); border: 1.5px solid var(--border);
    font-size: 11px; cursor: pointer; transition: all 0.12s;
    user-select: none;
  }

  .queue-item:hover { border-color: var(--text3); background: var(--surface3); }
  .queue-item.selected { border-color: var(--blue); background: var(--blue-dim); }

  .qi-idx { font-family: var(--mono); font-size: 10px; color: var(--text3); min-width: 22px; flex-shrink: 0; }
  .qi-addr { flex: 1; color: var(--text2); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .queue-item.selected .qi-addr { color: var(--blue); }
  .qi-pins { font-family: var(--mono); font-size: 10px; color: var(--green); white-space: nowrap; flex-shrink: 0; }
  .qi-type { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; padding: 2px 6px; border-radius: 4px; background: var(--surface3); color: var(--text3); flex-shrink: 0; }
  .qi-del {
    flex-shrink: 0; width: 20px; height: 20px; border-radius: 5px;
    border: 1px solid transparent; background: transparent;
    color: var(--text3); font-size: 12px; line-height: 1;
    cursor: pointer; transition: 0.12s; display: flex; align-items: center; justify-content: center;
    opacity: 0;
  }
  .queue-item:hover .qi-del { opacity: 1; }
  .qi-del:hover { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

  /* Search row */
  .queue-search-row {
    display: flex; align-items: center; gap: 8px; position: relative;
  }
  .queue-search-row input { padding-right: 60px; }
  .qs-count {
    position: absolute; right: 10px;
    font-size: 10px; font-weight: 700; color: var(--text3); font-family: var(--mono);
    pointer-events: none;
  }

  /* Queue map preview */
  .queue-preview {
    display: none; flex-direction: column;
    border-radius: var(--radius-sm); overflow: hidden;
    border: 1.5px solid var(--blue); background: var(--surface2);
    flex-shrink: 0;
  }

  .queue-preview.visible { display: flex; }

  .qp-header {
    padding: 8px 11px; display: flex; flex-direction: column; gap: 5px;
    border-bottom: 1px solid var(--border);
  }

  .qp-addr {
    font-size: 11px; font-weight: 700; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .qp-actions { display: flex; align-items: center; gap: 8px; }

  .qp-pins { font-size: 10px; font-weight: 600; color: var(--green); font-family: var(--mono); flex: 1; }

  .qp-delete-btn {
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--border); background: transparent;
    font-size: 10px; font-weight: 700; color: var(--text3);
    cursor: pointer; transition: 0.13s; font-family: var(--sans);
    white-space: nowrap;
  }

  .qp-delete-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .qp-map { height: 180px; background: var(--bg); }

  .queue-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 40px 20px; text-align: center;
    color: var(--text3); font-size: 13px; font-weight: 600;
  }

  .queue-empty .qe-icon { font-size: 32px; opacity: 0.4; }
  .queue-empty .qe-sub { font-size: 11px; font-weight: 500; color: var(--text3); max-width: 200px; line-height: 1.5; }

  /* ====================================================
     SCHEDULE TAB
     ==================================================== */
  .scheduler-global {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
  }

  .sched-totals {
    display: flex; align-items: center;
    padding: 10px 14px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
    gap: 0;
  }

  .st-cell {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; gap: 3px; padding: 2px 6px;
  }

  .st-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--text3); white-space: nowrap;
  }

  .st-value {
    font-size: 20px; font-weight: 800; font-family: var(--mono);
    color: var(--text); line-height: 1;
  }

  .st-divider {
    width: 1px; height: 32px; background: var(--border); flex-shrink: 0;
  }

  .sg-label { font-size: 12px; font-weight: 700; color: var(--text2); flex: 1; }
  .sg-status { font-size: 10px; font-weight: 700; font-family: var(--mono); color: var(--text3); }
  .sg-status.running { color: var(--green); }

  .scheduler-orgs { display: flex; flex-direction: column; gap: 10px; }

  .sched-card {
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border);
    background: var(--surface2);
    overflow: hidden; transition: border-color 0.2s;
  }

  .sched-card.enabled { border-color: #22c55e40; }

  .sched-card-header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; cursor: pointer; user-select: none;
    transition: background 0.15s;
  }

  .sched-card-header:hover { background: var(--surface3); }

  .sched-card-name { font-size: 12px; font-weight: 700; color: var(--text2); flex: 1; }
  .sched-card.enabled .sched-card-name { color: var(--text); }

  .sched-today {
    font-size: 10px; font-weight: 700; font-family: var(--mono);
    padding: 2px 7px; border-radius: 8px;
    background: var(--surface3); color: var(--text3);
  }

  .sched-card.enabled .sched-today { background: var(--green-dim); color: var(--green); }

  /* Toggle */
  .toggle {
    position: relative; width: 32px; height: 18px; flex-shrink: 0;
  }

  .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }

  .toggle-track {
    position: absolute; inset: 0; border-radius: 9px;
    background: var(--surface3); border: 1px solid var(--border);
    transition: all 0.2s; cursor: pointer;
  }

  .toggle input:checked ~ .toggle-track { background: var(--green); border-color: var(--green); }

  .toggle-thumb {
    position: absolute; top: 2px; left: 2px;
    width: 12px; height: 12px; border-radius: 50%;
    background: var(--text3); transition: all 0.2s;
    pointer-events: none;
  }

  .toggle input:checked ~ .toggle-track ~ .toggle-thumb {
    transform: translateX(14px); background: #fff;
  }

  .sched-card-body {
    padding: 0 14px 14px;
    display: none; flex-direction: column; gap: 10px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }

  .sched-card.open .sched-card-body { display: flex; }

  .sched-row { display: flex; gap: 8px; align-items: flex-end; }
  .sched-row .field { flex: 1; }

  .sched-estimate {
    display: flex; gap: 8px; margin-top: 2px;
  }

  .se-pill {
    display: flex; flex-direction: column; gap: 2px;
    padding: 8px 10px; border-radius: 7px;
    background: var(--surface3); border: 1px solid var(--border); flex: 1;
  }

  .se-pill .sep-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text3); }
  .se-pill .sep-value { font-size: 15px; font-weight: 800; color: var(--text); font-family: var(--mono); line-height: 1; }

  input[type="number"] { -moz-appearance: textfield; }
  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; }

  /* ====================================================
     TOAST
     ==================================================== */
  .toast-container {
    position: fixed; top: 16px; right: 16px; z-index: 9999;
    display: flex; flex-direction: column; gap: 7px;
  }

  .toast {
    padding: 10px 14px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
    font-size: 12px; font-weight: 600; color: var(--text);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    animation: toastIn 0.2s ease-out; max-width: 340px;
  }

  .toast.success { border-color: #22c55e50; background: #0f1f15; }
  .toast.error   { border-color: #f0353550; background: #1f0f0f; }
  .toast.auto    { border-color: #3b82f650; background: #0f1525; color: #60a5fa; }

  @keyframes toastIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .pac-container { z-index: 100000 !important; }

  /* Scheduler live indicator */
  .live-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green); display: inline-block;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.7); }
  }

  /* Next fire countdown */
  .next-fire { font-size: 10px; font-weight: 600; color: var(--text3); font-family: var(--mono); }
</style>
</head>
<body>

<div class="shell">

  <!-- ============================================================
       LEFT PANEL
       ============================================================ -->
  <div class="panel">
    <div class="panel-header">
      <h1>Submit on Behalf</h1>
      <div class="sub">Test-org scheduler with address queue &amp; organic submission patterns</div>
    </div>

    <!-- Tab Bar -->
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="submit">✏️ Submit</button>
      <button class="tab-btn" data-tab="queue" id="tabBtnQueue">📦 Queue</button>
      <button class="tab-btn" data-tab="schedule" id="tabBtnSchedule">
        <span class="tab-dot" id="schedDot"></span>⏱ Schedule
      </button>
    </div>

    <!-- ===================== SUBMIT TAB ===================== -->
    <div class="tab-pane active" id="tab-submit">
    <div class="pane-body">

      <div class="field">
        <div class="field-label">Test Organization</div>
        <div id="orgGroup" class="org-group"></div>
      </div>

      <div class="org-card" id="orgCard">
        <div class="org-avatar" id="orgAvatar">T</div>
        <div class="org-meta">
          <div class="org-name" id="orgName"></div>
          <div class="org-detail" id="orgDetail"></div>
        </div>
      </div>

      <div class="field">
        <div class="field-label">Submit As User</div>
        <select id="selUser" disabled>
          <option value="">— Select org first —</option>
        </select>
        <div class="user-info" id="userInfo"></div>
      </div>

      <div class="credit-banner info" id="creditBanner">
        <span>⚡</span>
        <span>Credits auto-granted before submission — test orders are always free.</span>
      </div>

      <div class="divider"></div>

      <div class="field">
        <div class="field-label">Project Type</div>
        <div class="type-group" id="typeGroup">
          <div class="type-btn" data-type="residential">
            <div class="t-icon">⌂</div>
            <div class="t-label">Residential</div>
            <div class="t-price">$7</div>
          </div>
          <div class="type-btn" data-type="commercial">
            <div class="t-icon">▦</div>
            <div class="t-label">Commercial</div>
            <div class="t-price">$12/pin</div>
          </div>
          <div class="type-btn" data-type="multifamily">
            <div class="t-icon">▧</div>
            <div class="t-label">Multi-Family</div>
            <div class="t-price">$12/pin</div>
          </div>
        </div>
      </div>

      <div class="field">
        <div class="field-label">Property Address</div>
        <div class="address-row">
          <input type="text" id="inpAddress" placeholder="Type an address or click the map…" autocomplete="off">
          <button class="btn-random" id="btnRandom" title="Pick random address from full_addresses.json">
            🎲 Roll
          </button>
        </div>
      </div>

      <div class="pin-bar" id="pinBar">
        <span class="pin-count" id="pinCount">0</span>
        <span id="pinText">Click the map to place pins</span>
        <button class="pin-clear" id="pinClear">Clear</button>
      </div>

      <div class="divider"></div>

      <div class="field">
        <div class="field-label">Tech Notes <span class="badge">optional</span></div>
        <textarea id="inpNotes" placeholder="Special instructions…" rows="2"></textarea>
      </div>

    </div><!-- /pane-body -->
    </div><!-- /tab-submit -->

    <!-- ===================== QUEUE TAB ===================== -->
    <div class="tab-pane" id="tab-queue" style="overflow:hidden;">
    <div class="pane-body" style="overflow:hidden;">

      <div class="queue-stats-grid">
        <div class="stat-card green">
          <div class="sc-label">In Queue</div>
          <div class="sc-value" id="qStatTotal">0</div>
          <div class="sc-sub">addresses</div>
        </div>
        <div class="stat-card blue">
          <div class="sc-label">Today</div>
          <div class="sc-value" id="qStatToday">0</div>
          <div class="sc-sub">submitted</div>
        </div>
        <div class="stat-card yellow">
          <div class="sc-label">Src Addresses</div>
          <div class="sc-value" id="qStatSrc">0</div>
          <div class="sc-sub">in full_addresses</div>
        </div>
      </div>

      <div class="queue-actions">
        <button class="btn btn-blue" id="btnBuildQueue" style="font-size:12px;">🗺 Build Queue</button>
        <button class="btn btn-secondary" id="btnClearQueue" style="font-size:12px;">🗑 Clear All</button>
      </div>

      <div class="queue-search-row">
        <input type="text" id="queueSearch" placeholder="Filter addresses…" autocomplete="off">
        <span class="qs-count" id="qsCount"></span>
      </div>

      <div id="queueListWrap" style="flex:1;overflow-y:auto;min-height:0;">
        <div class="queue-empty" id="queueEmpty">
          <div class="qe-icon">📭</div>
          <div>Queue is empty</div>
          <div class="qe-sub">Use "Build Queue" to go through addresses and pre-approve pin placements.</div>
        </div>
        <div class="queue-list" id="queueList"></div>
      </div>

      <!-- Map preview for selected queue item -->
      <div class="queue-preview" id="queuePreview">
        <div class="qp-header">
          <span class="qp-addr" id="qpAddr">—</span>
          <div class="qp-actions">
            <span class="qp-pins" id="qpPins"></span>
            <button class="qp-delete-btn" id="qpDelete">🗑 Remove from queue</button>
          </div>
        </div>
        <div class="qp-map" id="qpMap"></div>
      </div>

    </div><!-- /pane-body -->
    </div><!-- /tab-queue -->

    <!-- ===================== SCHEDULE TAB ===================== -->
    <div class="tab-pane" id="tab-schedule">
    <div class="pane-body">

      <div class="scheduler-global">
        <span id="liveDotWrap" style="display:none"><span class="live-dot"></span></span>
        <span class="sg-label">Scheduler Engine</span>
        <span class="sg-status" id="sgStatus">Stopped</span>
        <span class="next-fire" id="nextFireLabel"></span>
        <button class="btn btn-secondary" id="btnToggleScheduler" style="flex:none;padding:7px 12px;font-size:11px;">Start</button>
      </div>

      <!-- Totals summary across all orgs -->
      <div class="sched-totals">
        <div class="st-cell">
          <div class="st-label">Est. Daily Total</div>
          <div class="st-value" id="stTotalDaily">—</div>
        </div>
        <div class="st-divider"></div>
        <div class="st-cell">
          <div class="st-label">Est. Remaining</div>
          <div class="st-value" id="stTotalRemaining">—</div>
        </div>
        <div class="st-divider"></div>
        <div class="st-cell">
          <div class="st-label">Done Today</div>
          <div class="st-value" id="stTotalDone">—</div>
        </div>
        <div class="st-divider"></div>
        <div class="st-cell">
          <div class="st-label">Queue Left</div>
          <div class="st-value" id="stQueueLeft">—</div>
        </div>
      </div>

      <div id="schedOrgList" class="scheduler-orgs">
        <!-- Per-org scheduler cards rendered by JS -->
      </div>

    </div><!-- /pane-body -->
    </div><!-- /tab-schedule -->

    <!-- Actions (Submit tab only) -->
    <div class="actions" id="submitActions">
      <button class="btn btn-secondary" id="btnReset">Reset</button>
      <button class="btn btn-primary" id="btnSubmit" disabled>Submit Order</button>
    </div>

  </div><!-- /panel -->

  <!-- ============================================================
       MAP AREA
       ============================================================ -->
  <div class="map-area">
    <div id="map"></div>
    <div class="map-hint" id="mapHint">Click the map to place a pin — click a pin to remove it</div>

    <!-- Queue Builder Overlay -->
    <div class="qb-overlay" id="qbOverlay">

      <!-- Progress bar -->
      <div class="qb-progress-bar">
        <div class="qb-progress-fill" id="qbProgressFill" style="width:0%"></div>
      </div>

      <!-- Top bar -->
      <div class="qb-topbar">
        <span class="qb-title">Queue Builder</span>
        <span class="qb-prog" id="qbProg">0 / 0</span>
        <span class="qb-addr" id="qbAddr">Loading…</span>
        <span class="qb-status loading" id="qbStatus">Geocoding…</span>
      </div>

      <!-- Type selector -->
      <div class="qb-mid">
        <span style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;">Type:</span>
        <div class="qb-type-row" id="qbTypeRow">
          <div class="qb-type-pill active" data-type="residential">Residential</div>
          <div class="qb-type-pill" data-type="commercial">Commercial</div>
          <div class="qb-type-pill" data-type="multifamily">Multi-Family</div>
        </div>
      </div>

      <!-- Spacer (map is behind this) -->
      <div style="flex:1;pointer-events:none;"></div>

      <!-- Bottom bar -->
      <div class="qb-bottombar">
        <button class="qb-nav-btn" id="qbBack" disabled>
          ← Back <span class="qb-kbd">←</span>
        </button>

        <div class="qb-center">
          <span class="qb-pin-count" id="qbPinCount">0 pins</span>
          <button class="qb-pin-clear" id="qbPinClear">Clear pins</button>
          <button class="qb-skip-btn" id="qbSkip" title="Skip this address without adding it to the queue">⊘ Skip</button>
        </div>

        <button class="qb-nav-btn primary" id="qbNext">
          Next → <span class="qb-kbd">→</span>
        </button>

        <button class="qb-done-btn" id="qbDone">✓ Done</button>
      </div>

    </div><!-- /qb-overlay -->

  </div><!-- /map-area -->

</div><!-- /shell -->

<div class="toast-container" id="toasts"></div>

<script>
// ============================================================
//  CONSTANTS FROM PHP
// ============================================================
const TEST_ORGS   = <?= json_encode($testOrgs, JSON_UNESCAPED_UNICODE) ?>;
const ALL_ADDRS   = <?= json_encode($addresses, JSON_UNESCAPED_UNICODE) ?>;
const SELF_URL    = <?= json_encode($selfUrl) ?>;
const FIRSTMEASURE_API_BASE = <?= json_encode($firstMeasureApiBase) ?>;
const ACTOR_EMAIL = <?= json_encode($actorEmail) ?>;

const PRICES       = { residential: 7, commercial: 12, multifamily: 12 };
const PER_STRUCTURE = { commercial: true, multifamily: true };

function firstMeasureUrl(path) {
  const base = String(FIRSTMEASURE_API_BASE || '/v1/firstmeasure').replace(/\/+$/, '');
  return `${base}/${String(path || '').replace(/^\/+/, '')}`;
}

function normalizePin(pin) {
  return {
    lat: Number(pin?.lat),
    lng: Number(pin?.lng),
  };
}

function buildFirstMeasureActor(org, user) {
  const roles = [];
  if (user?.role) roles.push(String(user.role));
  return {
    id: user?.id || user?.email || '',
    name: user?.name || user?.email || 'Test User',
    email: user?.email || '',
    organization_id: org?.id || user?.organization_id || '',
    team_id: user?.team_id || 'default',
    roles,
  };
}

function buildFirstMeasurePayload(org, user, item, type, price) {
  const pins = (Array.isArray(item.pins) && item.pins.length ? item.pins : [{ lat: item.lat, lng: item.lng }])
    .map(normalizePin)
    .filter(pin => Number.isFinite(pin.lat) && Number.isFinite(pin.lng));
  const firstPin = pins[0] || { lat: Number(item.lat), lng: Number(item.lng) };
  const actor = buildFirstMeasureActor(org, user);
  return {
    address: item.address,
    lat: Number(firstPin.lat),
    lng: Number(firstPin.lng),
    is_custom_pin: true,
    components: item.components || {},
    project_type: type || 'residential',
    pins,
    cc_emails: [],
    tech_notes: item.tech_notes || '',
    amount_charged: Number(price || 0),
    report_mode: 'full',
    owner_ref: {
      id: user?.id || user?.email || '',
      name: user?.name || user?.email || 'Test User',
      email: user?.email || '',
    },
    issuer: {
      name: user?.name || user?.email || 'Test User',
      email: user?.email || '',
    },
    organization_ref: { id: org?.id || user?.organization_id || '' },
    team_ref: { id: user?.team_id || 'default' },
    actor,
    process_async: true,
  };
}

async function submitFirstMeasureProject(org, user, item, type, price) {
  const payload = buildFirstMeasurePayload(org, user, item, type, price);
  if (!payload.address || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng) || !payload.pins.length) {
    return { success: false, error: 'Missing address or valid pins' };
  }
  const resp = await fetch(firstMeasureUrl('/projects/queue'), {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-FirstMeasure-Debug-Source': 'test_projects_php',
    },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  });
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch(e) {
    return { success: false, error: `FirstMeasure returned invalid JSON (${resp.status})` };
  }
  if (!resp.ok || !(data.success || data.ok)) {
    return { success: false, error: data.error || data.message || `FirstMeasure request failed (${resp.status})`, data };
  }
  return {
    success: true,
    folder: data.folder || data.project_id || data.project?.manifest?.id || data.manifest?.id || '',
    data,
  };
}

// ============================================================
//  LOCAL STORAGE UTILITIES
// ============================================================
const LS = {
  get(k)    { try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.warn('LS set fail:', e); } },
  del(k)    { try { localStorage.removeItem(k); } catch {} },
};

const LSK = {
  queue:    'sob_queue',          // [{id,address,lat,lng,pins,components,type}]
  settings: 'sob_org_settings',  // {orgId:{enabled,rate,startHour,endHour,userId,type}}
  daily:    'sob_daily_log',      // {dateStr:{orgId:count}}
  qbIndex:  'sob_qb_index',      // last QB position
  org:      'sob_org',
  user:     'sob_user',
};

// ============================================================
//  QUEUE STATE
// ============================================================
let queue = [];

function loadQueue() {
  queue = LS.get(LSK.queue) || [];
  // Backfill ids for items saved before id was added
  let changed = false;
  queue.forEach(item => { if (!item.id) { item.id = genId(); changed = true; } });
  if (changed) LS.set(LSK.queue, queue);
}
function saveQueue()  { LS.set(LSK.queue, queue); updateQueueTab(); }

function queueAdd(item) {
  // Upsert by address string (case-insensitive match)
  const idx = queue.findIndex(q => q.address.toLowerCase() === item.address.toLowerCase());
  if (idx >= 0) queue[idx] = item;
  else queue.push(item);
  saveQueue();
}

function queueRemoveFirst() {
  const item = queue.shift();
  saveQueue();
  return item;
}

function queueClear() { queue = []; saveQueue(); }

function genId() { return Math.random().toString(36).slice(2, 10); }

// ============================================================
//  DAILY LOG (timezone-aware)
// ============================================================
function getTodayKey() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local timezone
}

function getDailyLog() { return LS.get(LSK.daily) || {}; }

function logSubmission(orgId) {
  const log = getDailyLog();
  const today = getTodayKey();
  if (!log[today]) log[today] = {};
  log[today][orgId] = (log[today][orgId] || 0) + 1;
  LS.set(LSK.daily, log);
}

function getTodayCount(orgId) {
  const log = getDailyLog();
  const today = getTodayKey();
  return (log[today] || {})[orgId] || 0;
}

function getTotalTodayCount() {
  const log = getDailyLog();
  const today = getTodayKey();
  if (!log[today]) return 0;
  return Object.values(log[today]).reduce((a, b) => a + b, 0);
}

// ============================================================
//  ORG SETTINGS
// ============================================================
let orgSettings = {};

function loadOrgSettings() {
  orgSettings = LS.get(LSK.settings) || {};
  TEST_ORGS.forEach(o => {
    if (!orgSettings[o.id]) {
      orgSettings[o.id] = {
        enabled:   false,
        rate:      2,    // per hour
        startHour: 8,    // 8:00 AM
        endHour:   17,   // 5:00 PM
        userId:    o.users[0]?.email || '',
        type:      'residential',
      };
    }
  });
}

function saveOrgSettings() { LS.set(LSK.settings, orgSettings); updateSchedTotals(); }

function getOrgSetting(orgId) { return orgSettings[orgId] || {}; }

// ============================================================
//  SCHEDULER ENGINE
// ============================================================
const TICK_MS = 30000; // 30 seconds per tick

let schedulerTimer   = null;
let schedulerRunning = false;
let nextTickCountdown = TICK_MS;
let countdownTimer   = null;

// Per-org: timestamp of last submission dispatch (prevents double-fire within one tick)
const orgLastSubmit = {};

// Submitted address set for this session — absolute duplicate guard.
// Persisted to sessionStorage so a page refresh resets it intentionally,
// but duplicates within a session are impossible.
const submittedAddresses = new Set(
  (() => { try { return JSON.parse(sessionStorage.getItem('sob_submitted') || '[]'); } catch { return []; } })()
);
function markAddressSubmitted(addr) {
  submittedAddresses.add(addr.toLowerCase());
  try { sessionStorage.setItem('sob_submitted', JSON.stringify([...submittedAddresses])); } catch {}
}
function addressAlreadySubmitted(addr) {
  return submittedAddresses.has(addr.toLowerCase());
}

function schedulerTick() {
  if (queue.length === 0) return;

  const now = new Date();
  const currentDecimalHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const nowMs = Date.now();

  TEST_ORGS.forEach(org => {
    const s = orgSettings[org.id];
    if (!s || !s.enabled) return;

    // Active time window check
    const start = parseFloat(s.startHour);
    const end   = parseFloat(s.endHour);
    if (currentDecimalHour < start || currentDecimalHour >= end) return;

    if (queue.length === 0) return;

    // Prevent same org from firing more than once per tick
    const minGapMs = TICK_MS * 0.9;
    if (orgLastSubmit[org.id] && (nowMs - orgLastSubmit[org.id]) < minGapMs) return;

    // Poisson probability
    const ticksPerHour = 3600000 / TICK_MS;
    const prob = s.rate / ticksPerHour;
    if (Math.random() >= prob) return;

    // Find first queue item that hasn't already been submitted this session
    const candidateIdx = queue.findIndex(item => !addressAlreadySubmitted(item.address));
    if (candidateIdx === -1) {
      // Every remaining item was already submitted — clear the queue to avoid looping forever
      toast('[Auto] All queue items already submitted this session — clearing queue', false);
      queueClear();
      return;
    }

    // Splice out (not always index 0, skips already-submitted items)
    const [item] = queue.splice(candidateIdx, 1);
    saveQueue();

    const user = org.users.find(u => u.email === s.userId) || org.users[0];
    if (!user) {
      // No user configured — discard item rather than re-queue
      toast(`[Auto] No user for ${org.name} — item discarded`, false);
      return;
    }

    orgLastSubmit[org.id] = nowMs;

    // Mark as submitted BEFORE the async call — prevents any concurrent tick
    // for another org from picking up the same address while this fetch is in flight
    markAddressSubmitted(item.address);

    const submType = s.type || item.type || 'residential';

    autoSubmitItem(org, user, item, submType).then(success => {
      if (success) {
        logSubmission(org.id);
        updateSchedulerStatus();
        updateQueueTab();
        updateSchedTotals();
        toast(`[Auto] ${org.name}: ${item.address.split(',')[0]}`, true, 'auto');
        renderSchedCard(org.id);
      } else {
        // Failure → item is permanently discarded (no re-queue, no retry).
        // The address is already in submittedAddresses so it won't be picked again.
        toast(`[Auto] Failed & discarded: ${item.address.split(',')[0]}`, false);
        updateQueueTab();
        updateSchedTotals();
      }
    });
  });
}

async function autoSubmitItem(org, user, item, type) {
  const pinCount = Array.isArray(item.pins) ? item.pins.length : 1;
  const price = (PER_STRUCTURE[type] ? PRICES[type] * Math.max(1, pinCount) : PRICES[type]) || 7;
  const creditResult = await ensureCredits(org.id, price, user.email);
  if (!creditResult.ok) {
    console.warn('[Auto] Credit grant failed:', creditResult.error);
    return false;
  }

  try {
    const data = await submitFirstMeasureProject(org, user, item, type, price);
    if (!data.success) {
      console.warn('[Auto] FirstMeasure submit failed:', data.error);
      return false;
    }
    const spend = await spendTestCredits(org.id, price, user.email, data.folder, item.address, type);
    if (spend.ok) org.balance = spend.balance;
    else console.warn('[Auto] Test credit spend failed:', spend.error);
    return true;
  } catch(e) {
    console.warn('[Auto] Fetch error:', e);
    return false;
  }
}

function startScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  schedulerTimer = setInterval(schedulerTick, TICK_MS);

  // Countdown ticker
  nextTickCountdown = TICK_MS;
  countdownTimer = setInterval(() => {
    nextTickCountdown -= 1000;
    if (nextTickCountdown < 0) nextTickCountdown = TICK_MS;
    const s = Math.round(nextTickCountdown / 1000);
    const lbl = document.getElementById('nextFireLabel');
    if (lbl) lbl.textContent = `next tick: ${s}s`;
  }, 1000);

  updateSchedulerStatus();
  toast('Scheduler started', true);
}

function stopScheduler() {
  if (!schedulerRunning) return;
  schedulerRunning = false;
  if (schedulerTimer)  { clearInterval(schedulerTimer);  schedulerTimer  = null; }
  if (countdownTimer)  { clearInterval(countdownTimer);  countdownTimer  = null; }
  updateSchedulerStatus();
  toast('Scheduler stopped');
}

function updateSchedulerStatus() {
  const sgStatus  = document.getElementById('sgStatus');
  const liveDot   = document.getElementById('liveDotWrap');
  const toggleBtn = document.getElementById('btnToggleScheduler');
  const schedDot  = document.getElementById('schedDot');
  const nextLbl   = document.getElementById('nextFireLabel');
  const tabBtn    = document.querySelector('[data-tab="schedule"]');

  if (sgStatus)  { sgStatus.textContent = schedulerRunning ? 'Running' : 'Stopped'; sgStatus.className = 'sg-status' + (schedulerRunning ? ' running' : ''); }
  if (liveDot)   liveDot.style.display  = schedulerRunning ? 'inline-flex' : 'none';
  if (toggleBtn) toggleBtn.textContent  = schedulerRunning ? 'Stop' : 'Start';
  if (nextLbl && !schedulerRunning) nextLbl.textContent = '';
  if (schedDot)  schedDot.style.display = schedulerRunning ? 'block' : 'none';
  if (tabBtn)    tabBtn.classList.toggle('has-dot', schedulerRunning);
}

function updateSchedTotals() {
  let totalDaily = 0, totalRemaining = 0, totalDone = 0;
  TEST_ORGS.forEach(org => {
    const s = orgSettings[org.id];
    if (!s) return;
    totalDaily     += getDailyEstimate(org.id);
    totalRemaining += Math.round(s.rate * getHoursRemaining(org.id) * 10) / 10;
    totalDone      += getTodayCount(org.id);
  });

  const fmt = n => Number.isInteger(n) ? n : n.toFixed(1);

  const elDaily  = document.getElementById('stTotalDaily');
  const elRemain = document.getElementById('stTotalRemaining');
  const elDone   = document.getElementById('stTotalDone');
  const elQueue  = document.getElementById('stQueueLeft');

  if (elDaily)  elDaily.textContent  = fmt(Math.round(totalDaily  * 10) / 10);
  if (elRemain) elRemain.textContent = fmt(Math.round(totalRemaining * 10) / 10);
  if (elDone)   elDone.textContent   = totalDone;
  if (elQueue)  elQueue.textContent  = queue.length;

  if (elRemain) {
    elRemain.style.color = totalRemaining <= 0
      ? 'var(--text3)'
      : totalRemaining < totalDone * 0.5
        ? 'var(--yellow)'
        : 'var(--green)';
  }

  if (elQueue) {
    elQueue.style.color = queue.length === 0
      ? 'var(--accent)'
      : queue.length < 10
        ? 'var(--yellow)'
        : 'var(--text)';
  }
}

function getDailyEstimate(orgId) {
  const s = orgSettings[orgId];
  if (!s) return 0;
  const hours = Math.max(0, s.endHour - s.startHour);
  return Math.round(s.rate * hours * 10) / 10;
}

function getHoursRemaining(orgId) {
  const s = orgSettings[orgId];
  if (!s) return 0;
  const now = new Date();
  const cur = now.getHours() + now.getMinutes() / 60;
  return Math.round(Math.max(0, s.endHour - Math.max(cur, s.startHour)) * 10) / 10;
}

// ============================================================
//  RENDER SCHEDULE TAB
// ============================================================
function renderSchedTab() {
  const container = document.getElementById('schedOrgList');
  container.innerHTML = '';
  TEST_ORGS.forEach(org => {
    const card = document.createElement('div');
    card.className = 'sched-card' + (orgSettings[org.id]?.enabled ? ' enabled' : '');
    card.id = 'scard-' + org.id;
    container.appendChild(card);
    renderSchedCard(org.id);
  });
}

function renderSchedCard(orgId) {
  const org = TEST_ORGS.find(o => o.id === orgId);
  if (!org) return;
  const card = document.getElementById('scard-' + orgId);
  if (!card) return;

  const s          = orgSettings[orgId];
  const todayCount = getTodayCount(orgId);
  const dailyEst   = getDailyEstimate(orgId);
  const hrRemain   = getHoursRemaining(orgId);
  const estRemain  = Math.round(s.rate * hrRemain * 10) / 10;
  const isOpen     = card.classList.contains('open');

  card.className = 'sched-card' + (s.enabled ? ' enabled' : '') + (isOpen ? ' open' : '');
  card.innerHTML = `
    <div class="sched-card-header" data-toggle-org="${orgId}">
      <label class="toggle" onclick="event.stopPropagation()">
        <input type="checkbox" id="stog-${orgId}" ${s.enabled ? 'checked' : ''}>
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
      <span class="sched-card-name">${org.name}</span>
      <span class="sched-today">${todayCount} today</span>
      <span style="font-size:11px;color:var(--text3);margin-left:2px;">▾</span>
    </div>
    <div class="sched-card-body">
      <div class="field">
        <div class="field-label">Default User</div>
        <select id="suser-${orgId}">
          ${org.users.map(u => `<option value="${u.email}" ${s.userId===u.email?'selected':''}>${u.name} (${u.email})</option>`).join('')}
        </select>
      </div>
      <div class="sched-row">
        <div class="field">
          <div class="field-label">Rate (per hour)</div>
          <input type="number" id="srate-${orgId}" value="${s.rate}" min="0.1" max="60" step="0.1">
        </div>
        <div class="field">
          <div class="field-label">Start Time</div>
          <input type="time" id="sstart-${orgId}" value="${String(Math.floor(s.startHour)).padStart(2,'0')}:${String(Math.round((s.startHour % 1)*60)).padStart(2,'0')}">
        </div>
        <div class="field">
          <div class="field-label">End Time</div>
          <input type="time" id="send-${orgId}" value="${String(Math.floor(s.endHour)).padStart(2,'0')}:${String(Math.round((s.endHour % 1)*60)).padStart(2,'0')}">
        </div>
      </div>
      <div class="field">
        <div class="field-label">Default Project Type</div>
        <select id="stype-${orgId}">
          <option value="residential" ${s.type==='residential'?'selected':''}>Residential ($7)</option>
          <option value="commercial" ${s.type==='commercial'?'selected':''}>Commercial ($12/pin)</option>
          <option value="multifamily" ${s.type==='multifamily'?'selected':''}>Multi-Family ($12/pin)</option>
        </select>
      </div>
      <div class="sched-estimate">
        <div class="se-pill">
          <div class="sep-label">Est. daily</div>
          <div class="sep-value" id="sest-${orgId}">${dailyEst}</div>
        </div>
        <div class="se-pill">
          <div class="sep-label">Est. remaining</div>
          <div class="sep-value" id="srem-${orgId}">${estRemain}</div>
        </div>
        <div class="se-pill">
          <div class="sep-label">Today done</div>
          <div class="sep-value" id="sdone-${orgId}">${todayCount}</div>
        </div>
      </div>
    </div>
  `;

  card.querySelector(`[data-toggle-org]`).addEventListener('click', () => {
    card.classList.toggle('open');
  });

  const tog = card.querySelector(`#stog-${orgId}`);
  tog.addEventListener('change', () => {
    orgSettings[orgId].enabled = tog.checked;
    saveOrgSettings();
    card.classList.toggle('enabled', tog.checked);
    updateSchedulerStatus();
  });

  const bindSave = (id, key, parser) => {
    const el = card.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      orgSettings[orgId][key] = parser(el.value);
      saveOrgSettings();
      const est = getDailyEstimate(orgId);
      const rem = Math.round(orgSettings[orgId].rate * getHoursRemaining(orgId) * 10) / 10;
      const estEl = card.querySelector(`#sest-${orgId}`);
      const remEl = card.querySelector(`#srem-${orgId}`);
      if (estEl) estEl.textContent = est;
      if (remEl) remEl.textContent = rem;
    });
  };

  bindSave(`suser-${orgId}`,  'userId',    v => v);
  bindSave(`srate-${orgId}`,  'rate',      v => Math.max(0.1, parseFloat(v) || 1));
  bindSave(`stype-${orgId}`,  'type',      v => v);

  const parseTime = v => { const [h, m] = (v || '00:00').split(':').map(Number); return h + m / 60; };
  bindSave(`sstart-${orgId}`, 'startHour', parseTime);
  bindSave(`send-${orgId}`,   'endHour',   parseTime);
}

// ============================================================
//  QUEUE TAB
// ============================================================
let queuePreviewMap     = null;
let queuePreviewMarkers = [];
let selectedQueueItem   = null;

function updateQueueTab() {
  document.getElementById('qStatTotal').textContent = queue.length;
  document.getElementById('qStatToday').textContent = getTotalTodayCount();
  document.getElementById('qStatSrc').textContent   = ALL_ADDRS.length;
  updateSchedTotals();
  renderQueueList();
}

function getQueueFilter() {
  const el = document.getElementById('queueSearch');
  return el ? el.value.trim().toLowerCase() : '';
}

function renderQueueList() {
  const total    = queue.length;
  const filter   = getQueueFilter();
  const filtered = filter ? queue.filter(item => item.address.toLowerCase().includes(filter)) : queue;

  const queueEmpty = document.getElementById('queueEmpty');
  const queueList  = document.getElementById('queueList');
  const qsCount    = document.getElementById('qsCount');

  if (qsCount) qsCount.textContent = filter ? `${filtered.length}/${total}` : `${total}`;

  if (total === 0) {
    queueEmpty.style.display = '';
    queueList.innerHTML = '';
    hideQueuePreview();
    return;
  }

  queueEmpty.style.display = 'none';

  queueList.innerHTML = filtered.map(item => {
    const realIdx = queue.indexOf(item);
    const isSel   = selectedQueueItem && selectedQueueItem.id === item.id;
    return `
      <div class="queue-item${isSel ? ' selected' : ''}" data-queue-id="${item.id}">
        <span class="qi-idx">${realIdx + 1}</span>
        <span class="qi-addr" title="${item.address}">${item.address}</span>
        <span class="qi-pins">📍 ${(item.pins||[]).length || 1}</span>
        <span class="qi-type">${item.type || 'res'}</span>
        <button class="qi-del" data-del-id="${item.id}" title="Remove from queue">✕</button>
      </div>
    `;
  }).join('');

  queueList.querySelectorAll('.queue-item').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.qi-del')) return;
      const id   = row.dataset.queueId;
      const item = queue.find(q => q.id === id);
      if (item) previewQueueItem(item);
    });
  });

  queueList.querySelectorAll('.qi-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteQueueItem(btn.dataset.delId);
    });
  });
}

function deleteQueueItem(id) {
  const item = queue.find(q => q.id === id);
  if (!item) return;
  queue = queue.filter(q => q.id !== id);
  if (selectedQueueItem && selectedQueueItem.id === id) { hideQueuePreview(); selectedQueueItem = null; }
  saveQueue();
  toast(`Removed: ${item.address.split(',')[0]}`);
}

function previewQueueItem(item) {
  selectedQueueItem = item;

  const preview = document.getElementById('queuePreview');
  preview.classList.add('visible');
  document.getElementById('qpAddr').textContent = item.address;
  document.getElementById('qpPins').textContent = `📍 ${(item.pins||[]).length || 1} pin${(item.pins||[]).length !== 1 ? 's' : ''}`;
  document.getElementById('qpDelete').onclick = () => deleteQueueItem(item.id);

  renderQueueList();

  const mapEl = document.getElementById('qpMap');
  if (!queuePreviewMap && window.google) {
    queuePreviewMap = new google.maps.Map(mapEl, {
      zoom: 19, mapTypeId: 'satellite', tilt: 0,
      disableDefaultUI: true, gestureHandling: 'none', keyboardShortcuts: false,
    });
  }
  if (!queuePreviewMap) return;

  queuePreviewMarkers.forEach(m => m.setMap(null));
  queuePreviewMarkers = [];

  const pins = item.pins && item.pins.length > 0 ? item.pins : [{ lat: item.lat, lng: item.lng }];
  queuePreviewMap.setCenter(pins[0]);
  queuePreviewMap.setZoom(20);

  pins.forEach(p => {
    const m = new google.maps.Marker({
      map: queuePreviewMap, position: p,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#f03535', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
    });
    queuePreviewMarkers.push(m);
  });
}

function hideQueuePreview() {
  document.getElementById('queuePreview').classList.remove('visible');
  selectedQueueItem = null;
  queuePreviewMarkers.forEach(m => m.setMap(null));
  queuePreviewMarkers = [];
}

document.getElementById('queueSearch').addEventListener('input', renderQueueList);

// ============================================================
//  QUEUE BUILDER
// ============================================================
let qb = {
  active: false,
  index: 0,
  addresses: [],
  type: 'residential',
  geoSeq: 0,
};

function enterQueueBuilder() {
  if (ALL_ADDRS.length === 0) { toast('full_addresses.json is empty or not loaded', false); return; }
  qb.active    = true;
  qb.addresses = [...ALL_ADDRS];

  const saved = LS.get(LSK.qbIndex);
  if (saved !== null && saved >= 0 && saved < qb.addresses.length) {
    qb.index = saved;
  } else {
    const queuedLower = new Set(queue.map(q => q.address.toLowerCase()));
    const firstNew = qb.addresses.findIndex(a => !queuedLower.has(a.toLowerCase()));
    qb.index = firstNew >= 0 ? firstNew : 0;
  }

  document.getElementById('qbOverlay').classList.add('active');

  if (map) { map.setCenter({ lat: 39.83, lng: -98.58 }); map.setZoom(4); map.setMapTypeId('satellite'); }

  qbLoadCurrent();
}

function exitQueueBuilder() {
  qb.active = false;
  document.getElementById('qbOverlay').classList.remove('active');
  clearPins();
  toast(`Queue saved — ${queue.length} items`, true);
  updateQueueTab();
  switchTab('queue');
}

function qbLoadCurrent() {
  if (qb.index >= qb.addresses.length) { exitQueueBuilder(); return; }

  const mySeq = ++qb.geoSeq;
  const addr  = qb.addresses[qb.index];
  clearPins();

  document.getElementById('qbAddr').textContent     = addr;
  document.getElementById('qbProg').textContent     = `${qb.index + 1} / ${qb.addresses.length}`;
  document.getElementById('qbProgressFill').style.width = ((qb.index + 1) / qb.addresses.length * 100) + '%';
  document.getElementById('qbBack').disabled        = qb.index === 0;
  document.getElementById('qbPinCount').textContent = '0 pins';

  const existing  = queue.find(q => q.address.toLowerCase() === addr.toLowerCase());
  const statusEl  = document.getElementById('qbStatus');

  if (existing && existing.lat && existing.lng) {
    statusEl.textContent = 'Existing';
    statusEl.className   = 'qb-status existing';
    map.setCenter({ lat: existing.lat, lng: existing.lng });
    map.setZoom(20); map.setMapTypeId('hybrid'); map.setTilt(0);
    (existing.pins || [{ lat: existing.lat, lng: existing.lng }]).forEach(p => addPin(new google.maps.LatLng(p.lat, p.lng), true, true));
    setQbType(existing.type || 'residential');
  } else {
    statusEl.textContent = 'Geocoding…';
    statusEl.className   = 'qb-status loading';

    if (!geocoder) { setTimeout(() => { if (mySeq === qb.geoSeq) qbLoadCurrent(); }, 400); return; }

    geocoder.geocode({ address: addr }, (results, status) => {
      if (mySeq !== qb.geoSeq) return;
      if (status === 'OK' && results?.[0]) {
        const loc = results[0].geometry.location;
        const lat = loc.lat(), lng = loc.lng();
        if (Math.abs(lat) < 1 && Math.abs(lng) < 1) {
          statusEl.textContent = 'Bad geocode'; statusEl.className = 'qb-status loading';
          toast(`Geocoder returned (0,0) for: ${addr}`, false); return;
        }
        addressComponents = parseComponents(results[0].address_components);
        addressText = results[0].formatted_address || addr;
        map.setCenter(loc); map.setZoom(20); map.setMapTypeId('hybrid'); map.setTilt(0);
        if (markers.length === 0) {
          addPin(loc, true, true);
          document.getElementById('qbPinCount').textContent = '1 pin';
        }
        statusEl.textContent = 'Ready'; statusEl.className = 'qb-status';
      } else {
        statusEl.textContent = 'Not found'; statusEl.className = 'qb-status loading';
        toast(`Could not geocode: ${addr}`, false);
      }
    });
  }
}

function qbSaveCurrent() {
  const addr  = qb.addresses[qb.index];
  const pins  = getPinsData();
  if (!pins[0]) return; // no pins → skip
  queueAdd({ id: genId(), address: addr, lat: pins[0].lat, lng: pins[0].lng, pins, components: { ...addressComponents }, type: qb.type });
}

function qbNext() { qbSaveCurrent(); qb.index++; LS.set(LSK.qbIndex, qb.index); qbLoadCurrent(); }
function qbBack() { if (qb.index === 0) return; qbSaveCurrent(); qb.index--; LS.set(LSK.qbIndex, qb.index); qbLoadCurrent(); }

function setQbType(type) {
  qb.type = type;
  document.querySelectorAll('.qb-type-pill').forEach(p => p.classList.toggle('active', p.dataset.type === type));
}

document.getElementById('qbTypeRow').addEventListener('click', e => { const p = e.target.closest('.qb-type-pill'); if (p) setQbType(p.dataset.type); });
document.getElementById('qbNext').addEventListener('click', qbNext);
document.getElementById('qbBack').addEventListener('click', qbBack);
document.getElementById('qbSkip').addEventListener('click', () => { clearPins(); qb.index++; LS.set(LSK.qbIndex, qb.index); qbLoadCurrent(); });
document.getElementById('qbDone').addEventListener('click', () => { qbSaveCurrent(); exitQueueBuilder(); });
document.getElementById('qbPinClear').addEventListener('click', () => { clearPins(); document.getElementById('qbPinCount').textContent = '0 pins'; });

document.addEventListener('keydown', e => {
  if (!qb.active) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); qbNext(); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); qbBack(); }
});

// ============================================================
//  DOM REFS (Submit tab)
// ============================================================
const orgGroup     = document.getElementById('orgGroup');
const selUser      = document.getElementById('selUser');
const orgCard      = document.getElementById('orgCard');
const orgAvatar    = document.getElementById('orgAvatar');
const orgName      = document.getElementById('orgName');
const orgDetail    = document.getElementById('orgDetail');
const userInfo     = document.getElementById('userInfo');
const typeGroup    = document.getElementById('typeGroup');
const inpAddress   = document.getElementById('inpAddress');
const btnRandom    = document.getElementById('btnRandom');
const creditBanner = document.getElementById('creditBanner');
const pinBar       = document.getElementById('pinBar');
const pinCount     = document.getElementById('pinCount');
const pinText      = document.getElementById('pinText');
const pinClear     = document.getElementById('pinClear');
const inpNotes     = document.getElementById('inpNotes');
const btnReset     = document.getElementById('btnReset');
const btnSubmit    = document.getElementById('btnSubmit');
const mapHint      = document.getElementById('mapHint');

// ============================================================
//  TABS
// ============================================================
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  document.getElementById('submitActions').style.display = name === 'submit' ? '' : 'none';
}

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ============================================================
//  TOAST
// ============================================================
function toast(msg, ok = true, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || (ok ? 'success' : 'error'));
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, type === 'auto' ? 2500 : 3500);
}

// ============================================================
//  ORG/USER SELECTORS (Submit tab)
// ============================================================
let selectedOrg  = null;
let selectedUser = null;
let selectedType = null;

function populateOrgs() {
  orgGroup.innerHTML = '';
  TEST_ORGS.forEach(o => {
    const btn = document.createElement('div');
    btn.className = 'org-btn';
    btn.dataset.orgId = o.id;
    btn.innerHTML = `<span class="ob-name">${o.name}</span><span class="ob-badge" data-org-badge="${o.id}">${o.today} today</span>`;
    orgGroup.appendChild(btn);
  });
}

async function refreshTodayCounts() {
  try {
    const resp = await fetch(SELF_URL + '?_sob_action=count_today', { credentials: 'same-origin' });
    const data = await resp.json();
    if (data.success && data.counts) {
      TEST_ORGS.forEach(org => {
        if (data.counts[org.id] !== undefined) {
          org.today = data.counts[org.id];
          const badge = document.querySelector(`[data-org-badge="${org.id}"]`);
          if (badge) badge.textContent = `${org.today} today`;
        }
      });
    }
  } catch(e) {}
}

function selectOrg(id) {
  selectedOrg  = TEST_ORGS.find(o => o.id === id) || null;
  selectedUser = null;
  userInfo.textContent = '';

  orgGroup.querySelectorAll('.org-btn').forEach(b => b.classList.toggle('active', b.dataset.orgId === id));
  try { localStorage.setItem(LSK.org, id); } catch(e) {}

  selUser.innerHTML = '';
  if (!selectedOrg) {
    selUser.disabled = true;
    selUser.innerHTML = '<option value="">— Select org first —</option>';
    orgCard.classList.remove('visible');
    creditBanner.classList.remove('visible');
    updateSubmitState(); return;
  }

  orgAvatar.textContent = selectedOrg.name.charAt(0).toUpperCase();
  orgName.textContent   = selectedOrg.name;
  orgDetail.textContent = `${selectedOrg.users.length} users · Balance: $${selectedOrg.balance}`;
  orgCard.classList.add('visible');
  selUser.disabled = false;

  selectedOrg.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.email;
    opt.textContent = `${u.name}  (${u.email})`;
    selUser.appendChild(opt);
  });

  let autoEmail = '';
  try { autoEmail = localStorage.getItem(LSK.user) || ''; } catch(e) {}
  const remembered = autoEmail && selectedOrg.users.find(u => u.email === autoEmail);
  if (remembered) selUser.value = remembered.email;
  else if (selectedOrg.users.length > 0) selUser.value = selectedOrg.users[0].email;
  applyUserSelection();
  updateSubmitState();
}

orgGroup.addEventListener('click', e => { const btn = e.target.closest('.org-btn'); if (btn) selectOrg(btn.dataset.orgId); });

function applyUserSelection() {
  if (!selectedOrg) return;
  const email  = selUser.value;
  selectedUser = selectedOrg.users.find(u => u.email === email) || null;
  userInfo.textContent = selectedUser ? `Submitting as: ${selectedUser.email}` : '';
  creditBanner.classList.toggle('visible', !!selectedUser);
  if (selectedUser) try { localStorage.setItem(LSK.user, selectedUser.email); } catch(e) {}
}

selUser.addEventListener('change', () => { applyUserSelection(); updateSubmitState(); });

// ============================================================
//  TYPE SELECTOR
// ============================================================
function selectType(typeName) {
  selectedType = typeName;
  typeGroup.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === typeName));
  updateSubmitState();
}

typeGroup.addEventListener('click', e => { const btn = e.target.closest('.type-btn'); if (btn) selectType(btn.dataset.type); });

// ============================================================
//  PIN MANAGEMENT
// ============================================================
let map = null;
let markers = [];
let geocoder = null;
let addressLatLng = null;
let addressText = '';
let addressComponents = {};
let lastRandomIdx = -1;

function addPin(latLng, draggable = true, qbMode = false) {
  const m = new google.maps.Marker({
    map, position: latLng, draggable,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#f03535', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 },
    title: 'Click to remove',
  });
  m.addListener('click', () => {
    removePin(m);
    if (qb.active) document.getElementById('qbPinCount').textContent = `${markers.length} pin${markers.length !== 1 ? 's' : ''}`;
  });
  markers.push(m);
  renderPins();
  if (qb.active) document.getElementById('qbPinCount').textContent = `${markers.length} pin${markers.length !== 1 ? 's' : ''}`;
  updateSubmitState();
}

function removePin(m) { m.setMap(null); markers = markers.filter(x => x !== m); renderPins(); updateSubmitState(); }

function clearPins() { markers.forEach(m => m.setMap(null)); markers = []; renderPins(); updateSubmitState(); }

function renderPins() {
  const n = markers.length;
  pinBar.classList.toggle('has-pins', n > 0);
  pinCount.textContent = n;
  pinText.textContent = n === 0 ? 'Click the map to place pins' : (n === 1 ? '1 pin placed' : `${n} pins placed`);
  updateSubmitLabel();
}

pinClear.addEventListener('click', clearPins);

function getPinsData() { return markers.map(m => { const p = m.getPosition(); return { lat: p.lat(), lng: p.lng() }; }); }

// ============================================================
//  PRICE / LABEL
// ============================================================
function currentPrice() {
  if (!selectedType) return 0;
  const base = PRICES[selectedType] || 7;
  return PER_STRUCTURE[selectedType] ? base * Math.max(1, markers.length) : base;
}

function updateSubmitLabel() {
  const p = currentPrice();
  btnSubmit.textContent = p > 0 ? `Submit Order · $${p} (free)` : 'Submit Order';
}

function updateSubmitState() { updateSubmitLabel(); btnSubmit.disabled = !(selectedOrg && selectedUser && selectedType && markers.length > 0 && addressText); }

// ============================================================
//  RANDOM ADDRESS
// ============================================================
function pickRandomAddress() {
  if (!ALL_ADDRS.length) { toast('full_addresses.json is empty or missing', false); return; }
  if (!geocoder) { toast('Map not ready', false); return; }
  btnRandom.classList.add('loading');
  let idx;
  if (ALL_ADDRS.length === 1) idx = 0;
  else do { idx = Math.floor(Math.random() * ALL_ADDRS.length); } while (idx === lastRandomIdx);
  lastRandomIdx = idx;
  const addr = ALL_ADDRS[idx];
  inpAddress.value = addr;
  addressText = addr;
  geocoder.geocode({ address: addr }, (results, status) => {
    btnRandom.classList.remove('loading');
    if (status === 'OK' && results?.[0]) {
      loadPlace(results[0].geometry.location, results[0].address_components, results[0].formatted_address);
      toast(`Loaded: ${results[0].formatted_address}`);
      selectType('residential');
    } else {
      toast(`Could not geocode: ${addr}`, false);
    }
  });
}

btnRandom.addEventListener('click', pickRandomAddress);

// ============================================================
//  CREDITS — auto-grant before submit
// ============================================================
async function ensureCredits(orgId, needed, appliedForEmail = '') {
  try {
    const balBody = new FormData();
    balBody.append('_sob_action', 'get_balance');
    balBody.append('org_id', orgId);
    const balResp = await fetch(SELF_URL, { method: 'POST', body: balBody, credentials: 'same-origin' });
    const balData = await balResp.json();
    if (!balData.success) return { ok: false, error: balData.error || 'balance_check_failed' };
    const current = balData.balance || 0;
    if (current >= needed) return { ok: true, balance: current, granted: 0 };
    const shortfall = needed - current + 50;
    const grantBody = new FormData();
    grantBody.append('_sob_action', 'grant_test_credits');
    grantBody.append('org_id', orgId);
    grantBody.append('amount', String(shortfall));
    grantBody.append('applied_for_email', appliedForEmail || '');
    const grantResp = await fetch(SELF_URL, { method: 'POST', body: grantBody, credentials: 'same-origin' });
    const grantData = await grantResp.json();
    if (!grantData.success) return { ok: false, error: grantData.error || 'grant_failed' };
    return { ok: true, balance: grantData.new_balance, granted: shortfall };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function spendTestCredits(orgId, amount, userEmail, projectId, address, projectType) {
  try {
    const body = new FormData();
    body.append('_sob_action', 'spend_test_credits');
    body.append('org_id', orgId);
    body.append('amount', String(amount));
    body.append('applied_for_email', userEmail || '');
    body.append('project_id', projectId || '');
    body.append('address', address || '');
    body.append('project_type', projectType || 'residential');
    const resp = await fetch(SELF_URL, { method: 'POST', body, credentials: 'same-origin' });
    const data = await resp.json();
    if (!data.success) return { ok: false, error: data.error || 'spend_failed' };
    return { ok: true, balance: data.new_balance, spent: data.spent || amount };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
//  GOOGLE MAPS
// ============================================================
function initMap() {
  if (!window.google || !google.maps) { setTimeout(initMap, 150); return; }

  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 39.83, lng: -98.58 }, zoom: 4,
    mapTypeId: 'satellite', tilt: 0,
    mapTypeControl: false, streetViewControl: false, rotateControl: false, gestureHandling: 'greedy',
  });

  geocoder = new google.maps.Geocoder();

  map.addListener('click', e => {
    addPin(e.latLng);
    if (!qb.active) {
      if (!addressText) {
        map.setCenter(e.latLng);
        if (map.getZoom() < 18) map.setZoom(20);
        map.setMapTypeId('hybrid'); map.setTilt(0);
        reverseGeocode(e.latLng);
      }
      addressLatLng = e.latLng;
    }
    if (qb.active) document.getElementById('qbPinCount').textContent = `${markers.length} pin${markers.length !== 1 ? 's' : ''}`;
  });

  const ac = new google.maps.places.Autocomplete(inpAddress, { fields: ['formatted_address', 'geometry', 'address_components'] });
  ac.addListener('place_changed', () => {
    const place = ac.getPlace();
    if (!place?.geometry?.location) { const text = inpAddress.value.trim(); if (text) forwardGeocode(text); return; }
    loadPlace(place.geometry.location, place.address_components, place.formatted_address);
  });

  inpAddress.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = inpAddress.value.trim();
    if (text) setTimeout(() => { if (!addressLatLng) forwardGeocode(text); }, 250);
  });
}

function loadPlace(location, components, formatted) {
  clearPins();
  if (components) addressComponents = parseComponents(components);
  if (formatted)  inpAddress.value  = formatted;
  addressText   = inpAddress.value.trim();
  addressLatLng = location;
  map.setCenter(location); map.setZoom(20); map.setMapTypeId('hybrid'); map.setTilt(0);
  addPin(location);
  mapHint.classList.remove('hidden');
  updateSubmitState();
}

function reverseGeocode(latLng) {
  geocoder.geocode({ location: latLng }, (results, status) => {
    if (status === 'OK' && results?.[0]) {
      inpAddress.value = results[0].formatted_address || '';
      addressText = inpAddress.value.trim();
      if (results[0].address_components) addressComponents = parseComponents(results[0].address_components);
    } else {
      inpAddress.value = `${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}`;
      addressText = inpAddress.value;
    }
    addressLatLng = latLng;
    updateSubmitState();
  });
}

function forwardGeocode(text) {
  geocoder.geocode({ address: text }, (results, status) => {
    if (status === 'OK' && results?.[0]) loadPlace(results[0].geometry.location, results[0].address_components, results[0].formatted_address);
    else toast('Address not found', false);
  });
}

function parseComponents(c) {
  const r = { street_number: '', route: '', city: '', state: '', state_short: '', zip: '', country: '' };
  (c || []).forEach(x => {
    if (x.types?.includes('street_number'))               r.street_number = x.long_name;
    if (x.types?.includes('route'))                       r.route = x.long_name;
    if (x.types?.includes('locality'))                    r.city = x.long_name;
    if (x.types?.includes('administrative_area_level_1')) { r.state = x.long_name; r.state_short = x.short_name; }
    if (x.types?.includes('postal_code'))                 r.zip = x.long_name;
  });
  return r;
}

// ============================================================
//  MANUAL SUBMIT
// ============================================================
btnSubmit.addEventListener('click', async () => {
  if (btnSubmit.disabled) return;
  if (!selectedOrg || !selectedUser || !selectedType || markers.length === 0 || !addressText) return;

  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Granting credits…';

  const price = currentPrice();
  const creditResult = await ensureCredits(selectedOrg.id, price, selectedUser.email);

  if (!creditResult.ok) {
    toast('Failed to grant credits: ' + (creditResult.error || 'unknown'), false);
    btnSubmit.disabled = false; updateSubmitLabel(); return;
  }

  if (creditResult.granted > 0) {
    toast(`Auto-granted $${creditResult.granted} to ${selectedOrg.name}`);
    selectedOrg.balance = creditResult.balance;
    orgDetail.textContent = `${selectedOrg.users.length} users · Balance: $${creditResult.balance}`;
  }

  btnSubmit.textContent = 'Submitting…';

  const pins = getPinsData();
  const item = {
    address: addressText,
    lat: pins[0]?.lat,
    lng: pins[0]?.lng,
    pins,
    components: addressComponents,
    tech_notes: inpNotes.value.trim(),
  };

  try {
    const data = await submitFirstMeasureProject(selectedOrg, selectedUser, item, selectedType, price);
    if (data.success) {
      const spend = await spendTestCredits(selectedOrg.id, price, selectedUser.email, data.folder, addressText, selectedType);
      if (spend.ok) {
        selectedOrg.balance = spend.balance;
        orgDetail.textContent = `${selectedOrg.users.length} users | Balance: $${spend.balance}`;
      } else {
        toast('Submitted, but test credit spend failed: ' + (spend.error || 'unknown'), false);
      }
      toast(`Order submitted for ${addressText}`);
      logSubmission(selectedOrg.id);
      updateQueueTab();
      updateSchedTotals();
      refreshTodayCounts();
      resetForm();
    } else {
      toast(data.error || 'Submission failed', false);
    }
  } catch (err) {
    toast('Network error: ' + err.message, false);
  }

  btnSubmit.disabled = false;
  updateSubmitLabel();
});

// ============================================================
//  RESET
// ============================================================
function resetForm() {
  selectedType = null;
  typeGroup.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  inpAddress.value = '';
  addressText = ''; addressLatLng = null; addressComponents = {};
  clearPins();
  inpNotes.value = '';
  mapHint.classList.remove('hidden');
  updateSubmitState();
  if (map) { map.setCenter({ lat: 39.83, lng: -98.58 }); map.setZoom(4); map.setMapTypeId('satellite'); }
}

btnReset.addEventListener('click', resetForm);

// ============================================================
//  QUEUE TAB BUTTONS
// ============================================================
document.getElementById('btnBuildQueue').addEventListener('click', enterQueueBuilder);
document.getElementById('btnClearQueue').addEventListener('click', () => {
  if (!confirm(`Clear all ${queue.length} items from the queue?`)) return;
  queueClear();
  toast('Queue cleared');
});

// ============================================================
//  SCHEDULER TOGGLE
// ============================================================
document.getElementById('btnToggleScheduler').addEventListener('click', () => {
  if (schedulerRunning) stopScheduler(); else startScheduler();
});

// ============================================================
//  INIT
// ============================================================
loadQueue();
loadOrgSettings();
populateOrgs();
refreshTodayCounts();

let initOrgId = null;
try { const saved = localStorage.getItem(LSK.org); if (saved && TEST_ORGS.find(o => o.id === saved)) initOrgId = saved; } catch(e) {}
if (!initOrgId && TEST_ORGS.length > 0) initOrgId = TEST_ORGS[0].id;
if (initOrgId) selectOrg(initOrgId);

updateQueueTab();
renderSchedTab();
updateSchedulerStatus();
updateSchedTotals();

document.getElementById('submitActions').style.display = '';

window.addEventListener('load', () => setTimeout(initMap, 100));

setInterval(() => { refreshTodayCounts(); updateSchedTotals(); }, 60000);
</script>
</body>
</html>
