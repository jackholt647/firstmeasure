<?php
require_once __DIR__ . '/_storage.php';
/**
 * portal.php - Project Browser, Team Manager, Tutorial System & Student Admin
 * DROP-IN REPLACEMENT
 *
 * Adds (NEW):
 * - Optional "Apple Key" tab (visible only if permission manage_apple_key is granted OR role admin OR is_admin_legacy)
 * - Admin UI to view:
 *   - last updated UTC timestamp
 *   - minutes/seconds since last set
 *   - warning banner if > 25 minutes (keys expire ~30m)
 * - Admin UI to set Apple Maps key (writes apple_key.json)
 *
 * Adds (NEW - Training / Curriculum gating):
 * - Removes video/project count indicators from Training Chapter tiles
 * - Adds optional "description" per chapter (editable in Curriculum Editor + displayed in chapter view)
 * - Prevents advancing to next chapter until ALL videos + projects in that chapter have been opened
 *   - No popups on success
 *   - Popup only on failure: "You need to complete X, Y, Z first."
 * - Adds user flag: training_complete (admin set, never automatic)
 *   - “Next in Queue” is disabled (greyed out) until training_complete is true
 *
 * Notes:
 * - Stores Apple key in: ./apple_key.json (same directory as this file)
 * - Format: { "key": "...", "updated_at_utc": "2026-01-14T..." }
 */

session_start();

// --- CONFIGURATION ---
$userDir = storageDir('users');
$saveDir = __DIR__ . '/saves/';
$tutorialDir = storageDir('tutorials');

// Apple key store
$APPLE_KEY_PATH = storageExistingPath('config/apple_key.json', __DIR__ . '/apple_key.json', true);

// --- PERMISSION DEFINITIONS ---
function getPermissionPresets($role) {
    // Default: User (Mine only)
    $perms = [
        'view_all_projects'   => false,
        'view_team_projects'  => false,
        'manage_users'        => false,
        'create_users'        => false,
        'assign_teams'        => false,
        'manage_tutorials'    => false, // Curriculum Editing & Student Progress
        'is_admin_legacy'     => false,
        'manage_queue'        => false,
        // Apple key management
        'manage_apple_key'    => false,
    ];

    if ($role === 'admin') {
        foreach ($perms as $k => $v) $perms[$k] = true;
    } elseif ($role === 'lead') {
        $perms['view_team_projects'] = true;
        $perms['manage_tutorials'] = true;
        // Optional: leaders can monitor queue
        // $perms['manage_queue'] = true;
    }

    return $perms;
}

// --- AUTH CHECK ---
if (!isset($_SESSION['user_email'])) {
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = $_SESSION['user_email'];
$currentUserName  = $_SESSION['user_name'];

// Load User Data
function getUserFile($email) {
    global $userDir;
    return $userDir . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email))) . '.json';
}

$uFile = getUserFile($currentUserEmail);
if (!file_exists($uFile)) { header("Location: backend_logout.php"); exit; }
$myUserData = json_decode(file_get_contents($uFile), true);

// Normalize permissions if missing
$myPerms = $myUserData['permissions'] ?? getPermissionPresets($myUserData['role'] ?? 'user');
// Back-compat: ensure new perms exist
if (!array_key_exists('manage_queue', $myPerms)) $myPerms['manage_queue'] = false;
if (!array_key_exists('manage_apple_key', $myPerms)) $myPerms['manage_apple_key'] = false;

$myTeam  = $myUserData['team_id'] ?? 'default';

// NEW: Training completion flag (admin-set only)
$myTrainingComplete = !empty($myUserData['training_complete']);

// Derive queue-admin ability:
$isQueueAdmin = !!($myPerms['manage_queue'] ?? false) || !!($myPerms['is_admin_legacy'] ?? false) || (($myUserData['role'] ?? '') === 'admin');

// Apple key admin ability:
$isAppleKeyAdmin = !!($myPerms['manage_apple_key'] ?? false) || !!($myPerms['is_admin_legacy'] ?? false) || (($myUserData['role'] ?? '') === 'admin');

// --- APPLE KEY STORE HELPERS (JSON) ---
function appleKeyFilePath() {
    global $APPLE_KEY_PATH;
    return $APPLE_KEY_PATH;
}

function appleKeyEnsureStore() {
    $path = appleKeyFilePath();
    if (!file_exists($path)) {
        $init = [
            'key' => '',
            'updated_at_utc' => null
        ];
        @file_put_contents($path, json_encode($init, JSON_PRETTY_PRINT));
        return $init;
    }
    $raw = @file_get_contents($path);
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) $data = [];
    if (!array_key_exists('key', $data)) $data['key'] = '';
    if (!array_key_exists('updated_at_utc', $data)) $data['updated_at_utc'] = null;
    if (!is_string($data['key'])) $data['key'] = '';
    if (!is_null($data['updated_at_utc']) && !is_string($data['updated_at_utc'])) $data['updated_at_utc'] = null;
    return $data;
}

function appleKeyGetInfo() {
    $s = appleKeyEnsureStore();
    $k = trim((string)($s['key'] ?? ''));
    $ts = $s['updated_at_utc'] ?? null;
    $ts = is_string($ts) ? trim($ts) : null;

    return [
        'key' => ($k !== '') ? $k : null,
        'updated_at_utc' => ($ts !== '') ? $ts : null
    ];
}

function appleKeySet($newKey) {
    $newKey = trim((string)$newKey);
    if ($newKey === '') return false;

    $path = appleKeyFilePath();
    $nowUtc = gmdate('c'); // ISO8601 UTC

    $data = [
        'key' => $newKey,
        'updated_at_utc' => $nowUtc
    ];

    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) return false;

    return (@file_put_contents($path, $json) !== false);
}

// --- API HANDLER ---
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');
    $action = $_POST['action'] ?? '';

    // APPLE KEY GET
    if ($action === 'get_apple_key_info') {
        if (!$isAppleKeyAdmin) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $info = appleKeyGetInfo();
        echo json_encode([
            'success' => true,
            'key' => $info['key'],
            'updated_at_utc' => $info['updated_at_utc']
        ]);
        exit;
    }

    // APPLE KEY SET
    if ($action === 'set_apple_key') {
        if (!$isAppleKeyAdmin) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $k = $_POST['key'] ?? '';
        if (!appleKeySet($k)) die(json_encode(['success' => false, 'error' => 'Invalid key or write failed']));
        $info = appleKeyGetInfo();
        echo json_encode(['success' => true, 'updated_at_utc' => $info['updated_at_utc']]);
        exit;
    }

    // 1. GET PROJECT DETAILS (For Modal)
    if ($action === 'get_project_details') {
        $fid = $_POST['folder_id'] ?? '';

        // Simple logic: Assume standard project first
        $path = $saveDir . $fid . '/';
        $isTutorial = false;

        if (!is_dir($path)) {
            // Check if it's a tutorial user instance
            $found = false;
            if (is_dir($tutorialDir)) {
                $users = scandir($tutorialDir);
                foreach($users as $u) {
                    if($u === '.' || $u === '..' || $u === 'master') continue;
                    if(is_dir($tutorialDir . $u . '/' . $fid)) {
                        $path = $tutorialDir . $u . '/' . $fid . '/';
                        $found = true;
                        $isTutorial = true;
                        break;
                    }
                }
            }
            if (!$found) die(json_encode(['error' => 'Project not found']));
        }

        if(!file_exists($path . 'manifest.json')) die(json_encode(['error' => 'Manifest missing']));

        $manifest = json_decode(file_get_contents($path . 'manifest.json'), true);
        // Force the flag if we found it in tutorials dir
        if($isTutorial) $manifest['is_tutorial_instance'] = true;

        // Scan for assets
        $images = [];
        $files = scandir($path);
        foreach ($files as $f) {
            $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
            if (in_array($ext, ['png', 'jpg', 'jpeg'])) {
                $relUrl = "";
                if (strpos($path, '/saves/') !== false) $relUrl = "saves/$fid/$f";
                else $relUrl = substr($path, strlen(__DIR__) + 1) . $f;

                $images[] = [
                    'name' => $f,
                    'url' => $relUrl
                ];
            }
        }

        $pdfUrl = null;
        if (file_exists($path.'Report.pdf')) {
             if (strpos($path, '/saves/') !== false) $pdfUrl = "saves/$fid/Report.pdf";
             else $pdfUrl = substr($path, strlen(__DIR__) + 1) . "Report.pdf";
        }

        echo json_encode([
            'success' => true,
            'manifest' => $manifest,
            'images' => $images,
            'pdf_url' => $pdfUrl
        ]);
        exit;
    }

    // 2. FETCH USERS
    if ($action === 'fetch_users') {
        if (!$myPerms['manage_users']) die(json_encode(['error' => 'Unauthorized']));

        $users = [];
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $u = json_decode(file_get_contents($userDir . $f), true);
                if ($u) {
                    unset($u['password_hash']);
                    if (!isset($u['permissions'])) $u['permissions'] = getPermissionPresets($u['role']??'user');
                    // Back-compat on outgoing
                    if (!array_key_exists('manage_queue', $u['permissions'])) $u['permissions']['manage_queue'] = false;
                    if (!array_key_exists('manage_apple_key', $u['permissions'])) $u['permissions']['manage_apple_key'] = false;

                    // NEW: training_complete (default false)
                    $u['training_complete'] = !empty($u['training_complete']);

                    $users[] = $u;
                }
            }
        }
        echo json_encode(['success' => true, 'users' => $users]);
        exit;
    }

    // 3. SAVE USER
    if ($action === 'save_user') {
        $mode = $_POST['mode'];

        if ($mode === 'create' && !$myPerms['create_users']) die(json_encode(['error' => 'Unauthorized to create']));
        if ($mode === 'edit' && !$myPerms['manage_users']) die(json_encode(['error' => 'Unauthorized to edit']));

        $email = strtolower(trim($_POST['email'] ?? ''));
        $name = $_POST['name'] ?? '';
        $role = $_POST['role'] ?? 'user';
        $team = $_POST['team'] ?? 'default';
        $compPref = $_POST['complexity_preference'] ?? 'all';
        $perms = json_decode($_POST['permissions'], true);
        $pass = $_POST['password'] ?? '';

        // NEW: training_complete (admin-set)
        $trainingCompleteRaw = $_POST['training_complete'] ?? '0';
        $trainingComplete = filter_var($trainingCompleteRaw, FILTER_VALIDATE_BOOLEAN);

        if (!$email) die(json_encode(['error' => 'Email required']));

        // Back-compat: ensure new perms exist if missing
        if (is_array($perms) && !array_key_exists('manage_queue', $perms)) $perms['manage_queue'] = false;
        if (is_array($perms) && !array_key_exists('manage_apple_key', $perms)) $perms['manage_apple_key'] = false;

        $file = getUserFile($email);
        $uData = [];

        if ($mode === 'create') {
            if (file_exists($file)) die(json_encode(['error' => 'User already exists']));
            if (!$pass) die(json_encode(['error' => 'Password required for new users']));
            $uData = [
                'email' => $email,
                'created_at' => date('Y-m-d H:i:s'),
                'is_verified' => true,
                // NEW: default training_complete false unless explicitly set
                'training_complete' => $trainingComplete ? true : false,
            ];
        } else {
            if (!file_exists($file)) die(json_encode(['error' => 'User not found']));
            $uData = json_decode(file_get_contents($file), true);
            if (!is_array($uData)) $uData = [];
            // preserve if missing; overwritten below from UI
        }

        $uData['name'] = $name;
        $uData['role'] = $role;
        $uData['team_id'] = $team;
        $uData['complexity_preference'] = $compPref;
        $uData['permissions'] = $perms;
        $uData['is_admin'] = $perms['is_admin_legacy'] ?? false;

        // NEW: training_complete (admin-set only)
        $uData['training_complete'] = $trainingComplete ? true : false;

        if ($pass) {
            $uData['password_hash'] = password_hash($pass, PASSWORD_DEFAULT);
        }

        if (file_put_contents($file, json_encode($uData, JSON_PRETTY_PRINT))) {
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'File write error']);
        }
        exit;
    }

    // 4. DELETE USER
    if ($action === 'delete_user') {
        if (!$myPerms['assign_teams']) die(json_encode(['error' => 'Unauthorized']));
        $email = $_POST['email'];
        $file = getUserFile($email);
        if(file_exists($file)) {
            unlink($file);
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['error' => 'Not found']);
        }
        exit;
    }

    // 5. FETCH ALL STUDENT PROGRESS (Admin/Manager)
    if ($action === 'fetch_student_list') {
        if (!$myPerms['manage_tutorials']) die(json_encode(['error' => 'Unauthorized']));

        $students = [];
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $u = json_decode(file_get_contents($userDir . $f), true);
                if (!$u) continue;

                // Get Progress
                $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($u['email'])));
                $progFile = $tutorialDir . $userSafe . '/progress.json';
                $progress = ['current_chapter' => 1];
                if(file_exists($progFile)) {
                    $progress = json_decode(file_get_contents($progFile), true);
                }

                $students[] = [
                    'email' => $u['email'],
                    'name' => $u['name'] ?? 'Unknown',
                    'current_chapter' => $progress['current_chapter'] ?? 1,
                    'last_active' => 'Unknown'
                ];
            }
        }
        echo json_encode(['success' => true, 'students' => $students]);
        exit;
    }

    // 6. FETCH STUDENT DETAILS (Admin/Manager)
    if ($action === 'fetch_student_details') {
        if (!$myPerms['manage_tutorials']) die(json_encode(['error' => 'Unauthorized']));

        $email = $_POST['email'];
        $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email)));

        // 1. Get Progress
        $progFile = $tutorialDir . $userSafe . '/progress.json';
        $progress = file_exists($progFile) ? json_decode(file_get_contents($progFile), true) : ['current_chapter'=>1, 'completed_videos'=>[]];

        // 2. Scan Projects
        $projects = [];
        $uTutDir = $tutorialDir . $userSafe . '/';
        if(is_dir($uTutDir)) {
            foreach(scandir($uTutDir) as $f) {
                if($f === '.' || $f === '..' || !is_dir($uTutDir.$f)) continue;
                $mFile = $uTutDir . $f . '/manifest.json';
                if(file_exists($mFile)) {
                    $m = json_decode(file_get_contents($mFile), true);
                    $projects[] = [
                        'id' => $f,
                        'address' => $m['address'],
                        'status' => $m['status'],
                        'updated_at' => $m['app_metadata']['last_saved'] ?? $m['created_at'],
                        'thumbnail' => "tutorials/$userSafe/$f/google.png",
                        'master_id' => $m['original_master_id'] ?? null
                    ];
                }
            }
        }

        echo json_encode(['success' => true, 'progress' => $progress, 'projects' => $projects]);
        exit;
    }

    // Fallthrough: unknown API action
    echo json_encode(['error' => 'Unknown action']);
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Mate - Dashboard</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">

    <!-- Google Maps Places Library -->
    <script async defer src="https://maps.googleapis.com/maps/api/js?key=REMOVED_CREDENTIAL&libraries=places&callback=initMapsCallback"></script>

    <style>
        :root {
            --primary: #d93025;
            --primary-light: #fce8e6;
            --bg-page: #f0f2f5;
            --bg-panel: #ffffff;
            --text-main: #202124;
            --text-muted: #5f6368;
            --border: #dadce0;
            --sidebar-width: 270px;
        }

        body {
            background: var(--bg-page);
            color: var(--text-main);
            font-family: 'Segoe UI', Roboto, sans-serif;
            margin: 0; padding: 0;
            height: 100vh; display: flex; overflow: hidden;
        }

        /* SIDEBAR */
        .sidebar {
            width: var(--sidebar-width); background: var(--bg-panel);
            border-right: 1px solid var(--border);
            display: flex; flex-direction: column; z-index: 10;
        }
        .logo-area {
            height: 80px; display: flex; align-items: center; gap: 10px;
            padding: 0 25px; border-bottom: 1px solid var(--border);
            font-size: 18px; font-weight: 800; color: var(--primary);
        }

        /* Next in Queue button zone */
        .queue-cta-wrap {
            padding: 14px 18px;
            border-bottom: 1px solid var(--border);
            background: #fff;
        }
        .btn-queue {
            width: 100%;
            border: 1px solid var(--primary);
            background: var(--primary);
            color: #fff;
            padding: 12px 14px;
            border-radius: 10px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            transition: 0.2s;
            box-shadow: 0 2px 8px rgba(217,48,37,0.15);
        }
        .btn-queue:hover { background: #b0261e; }
        .btn-queue:disabled,
        .btn-queue.disabled {
            background: #f1f3f4;
            border-color: #dadce0;
            color: #9aa0a6;
            cursor: not-allowed;
            box-shadow: none;
        }
        .queue-sub {
            margin-top: 8px;
            font-size: 11px;
            color: #80868b;
            display: flex;
            justify-content: space-between;
            gap: 10px;
        }
        .queue-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #f8f9fa;
            border: 1px solid #eee;
            border-radius: 999px;
            padding: 2px 8px;
            font-weight: 700;
            color: #5f6368;
        }
        .queue-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #34a853;
        }
        .queue-dot.empty { background: #9aa0a6; }

        .nav-links { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 5px; }
        .nav-btn {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 16px; border-radius: 8px;
            background: transparent; border: none;
            color: var(--text-muted); font-weight: 600; font-size: 14px;
            cursor: pointer; transition: 0.2s; text-align: left; text-decoration: none;
        }
        .nav-btn:hover { background: #f1f3f4; color: var(--text-main); }
        .nav-btn.active { background: var(--primary-light); color: var(--primary); }
        .nav-btn i { width: 20px; text-align: center; }

        .user-panel {
            padding: 20px; border-top: 1px solid var(--border);
            font-size: 12px; color: var(--text-muted);
        }
        .user-pill {
            display: inline-block; padding: 2px 8px; border-radius: 12px;
            background: #eee; font-weight: 700; font-size: 10px;
            text-transform: uppercase; margin-top: 5px;
        }

        /* MAIN AREA */
        .main-content { flex: 1; padding: 30px; overflow-y: auto; display: flex; flex-direction: column; position: relative; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; gap: 15px; }
        h1 { margin: 0; font-size: 24px; color: #202124; }

        /* FILTERS */
        .filter-group { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 4px; display: flex; }
        .filter-btn {
            padding: 8px 16px; border: none; background: transparent;
            font-weight: 600; font-size: 13px; color: var(--text-muted);
            border-radius: 6px; cursor: pointer; transition: 0.2s;
        }
        .filter-btn.active { background: var(--bg-page); color: var(--text-main); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }

        /* GRID TILES */
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
        .tile {
            background: white; border-radius: 12px; overflow: hidden;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05); border: 1px solid var(--border);
            cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
            display: flex; flex-direction: column; position: relative;
        }
        .tile:hover { transform: translateY(-3px); box-shadow: 0 10px 20px rgba(0,0,0,0.1); }

        .tile-thumb { height: 160px; background: #eee; position: relative; }
        .tile-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .badge {
            position: absolute; top: 10px; right: 10px; padding: 4px 10px;
            border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2); color: #fff;
            z-index: 5;
        }
        .badge-complexity {
            position: absolute; top: 35px;
            right: 10px; padding: 4px 10px;
            border-radius: 20px; font-size: 9px; font-weight: 700; text-transform: uppercase;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2); color: #fff; z-index: 5;
        }
        .bg-simple { background: #34a853; }
        .bg-complex { background: #d93025; }
        .bg-queued { background: #fbbc04; color: #333; }
        .bg-processing { background: #4285f4; }
        .bg-ready { background: #34a853; }
        .bg-review { background: #ea4335; }
        .bg-tutorial { background: #673ab7; left: 10px; right: auto; }

        .tile-content { padding: 15px; flex: 1; display: flex; flex-direction: column; }
        .tile-addr { font-weight: 700; font-size: 14px; margin-bottom: 5px; line-height: 1.4; }
        .tile-meta { font-size: 12px; color: #777; margin-bottom: 10px; }

        /* Chapter tile description clamp */
        .chap-desc {
            color: #666;
            margin-bottom: 8px;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        /* MODALS */
        .modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 2000; display: none;
            align-items: center; justify-content: center; backdrop-filter: blur(3px);
        }
        .modal-card {
            background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            display: flex; flex-direction: column; overflow: hidden; max-height: 90vh;
        }
        .md-user { width: 500px; }
        .md-project { width: 900px; height: 80vh; }
        .md-editor { width: 1200px; height: 90vh; }
        .md-student { width: 1000px; height: 85vh; }

        .modal-header { padding: 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { margin: 0; font-size: 18px; }
        .modal-body { padding: 25px; overflow-y: auto; flex: 1; }
        .modal-footer { padding: 20px; border-top: 1px solid #eee; background: #fafafa; display: flex; justify-content: flex-end; gap: 10px; }

        /* PROJECT DETAILS SPECIFIC */
        .proj-layout { display: flex; height: 100%; }
        .proj-meta { width: 300px; border-right: 1px solid #eee; padding-right: 25px; display: flex; flex-direction: column; }
        .proj-gallery { flex: 1; padding-left: 25px; overflow-y: auto; }

        .meta-group { margin-bottom: 20px; }
        .meta-label { font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase; margin-bottom: 4px; }
        .meta-val { font-size: 14px; color: #333; }
        .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 15px; }
        .gal-item { border: 1px solid #eee; border-radius: 8px; overflow: hidden; aspect-ratio: 1; background: #f9f9f9; }
        .gal-item img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }

        /* FORMS */
        .presets { display: flex; gap: 10px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .btn-preset { flex: 1; padding: 10px; border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
        .btn-preset:hover { background: #f9f9f9; }

        .perm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
        .perm-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #333; }

        .form-row { margin-bottom: 15px; }
        .form-row label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #777; margin-bottom: 5px; }
        .form-row input, .form-group textarea, .form-row textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }

        /* BUTTONS */
        .btn-primary { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .btn-secondary { background: #fff; border: 1px solid #ccc; color: #333; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .btn-danger { background: #fff; border: 1px solid #d93025; color: #d93025; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        .btn-big-edit { background: var(--primary); color: white; border: none; padding: 12px; border-radius: 6px; font-size: 16px; font-weight: 700; width: 100%; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: auto; text-decoration: none; }
        .btn-big-edit:hover { background: #b0261e; }

        /* TUTORIALS CSS */
        .chapter-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; background:white; padding:20px; border-radius:8px; border:1px solid var(--border); box-shadow:0 2px 4px rgba(0,0,0,0.05); }
        .chapter-desc-card {
            background: white;
            border: 1px solid var(--border);
            border-radius: 8px;
            box-shadow:0 2px 4px rgba(0,0,0,0.05);
            padding: 14px 20px;
            margin-bottom: 20px;
            color: #555;
            line-height: 1.5;
            display: none;
            white-space: pre-wrap;
        }

        .res-list { display:flex; flex-direction:column; gap:10px; }
        .res-item { display:flex; align-items:center; gap:10px; padding:12px; background:white; border:1px solid #eee; border-radius:6px; text-decoration:none; color:#333; transition:0.2s; }
        .res-item:hover { background:#f8f9fa; border-color:#ccc; transform:translateX(5px); }
        .res-icon { width:30px; text-align:center; color:var(--primary); font-size:16px; }
        .check-icon { margin-left:auto; color:#34a853; }

        /* 3-COLUMN LAYOUT */
        .col-3-layout {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 25px;
        }
        .col-3-layout > div {
            min-width: 0;
            display: flex;
            flex-direction: column;
        }
        .col-3-layout .tile, .col-3-layout .res-item { max-width: 100%; }

        /* FLOATING ACTION BUTTON */
        .fab-next {
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: var(--primary);
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            font-weight: bold;
            font-size: 16px;
            border: none;
            cursor: pointer;
            transition: transform 0.2s, background 0.2s;
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 100;
        }
        .fab-next:hover { transform: scale(1.05); background: #b0261e; }

        /* EDITOR UI */
        .chapter-editor-item { border:1px solid #eee; padding:20px; margin-bottom:15px; background:#f9f9f9; border-radius:8px; }
        .resource-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: center; }
        .resource-row input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
        .resource-row .status { width: 120px; font-size: 11px; color: #666; text-align: center; }

        .pagination { display: flex; gap: 5px; align-items: center; flex:1; }
        .page-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: white; font-weight: bold; color: #555; }
        .page-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
        .page-btn:hover:not(.active) { background: #eee; }

        /* TABLES */
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        th { background: #f8f9fa; padding: 12px 15px; text-align: left; font-size: 12px; color: #555; text-transform: uppercase; border-bottom: 1px solid #eee; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; font-size: 13px; }
        tr:hover td { background:#f9f9f9; }

        /* QUEUE ADMIN VIEW */
        .queue-panel { background:#fff; border:1px solid var(--border); border-radius:12px; padding:18px; box-shadow:0 2px 5px rgba(0,0,0,0.05); }
        .queue-head { display:flex; justify-content:space-between; align-items:center; gap:15px; margin-bottom:14px; }
        .queue-title { font-weight:900; letter-spacing:0.2px; }
        .queue-team-filter { display:flex; gap:8px; align-items:center; }
        .queue-team-filter select {
            padding:8px 10px; border-radius:8px; border:1px solid var(--border);
            font-weight:700; font-size:12px; color:#444; background:#fff;
        }
        .queue-section { margin-top:18px; }
        .queue-section h3 { margin:0 0 8px 0; font-size:13px; color:#444; display:flex; align-items:center; gap:8px; }
        .hscroll {
            display:flex; gap:12px; overflow-x:auto; padding:8px 2px 10px 2px;
            scroll-snap-type:x proximity;
        }
        .hscroll::-webkit-scrollbar { height: 8px; }
        .hscroll::-webkit-scrollbar-thumb { background:#dadce0; border-radius:999px; }
        .qcard {
            min-width: 280px;
            max-width: 280px;
            border:1px solid #eee;
            border-radius:12px;
            background:#fff;
            padding:12px;
            box-shadow:0 2px 8px rgba(0,0,0,0.04);
            scroll-snap-align:start;
            cursor:pointer;
            transition: transform 0.15s, box-shadow 0.15s;
        }
        .qcard:hover { transform: translateY(-2px); box-shadow:0 10px 20px rgba(0,0,0,0.08); }
        .qline1 { font-weight:900; font-size:13px; line-height:1.3; margin-bottom:6px; }
        .qline2 { font-size:12px; color:#666; display:flex; justify-content:space-between; gap:10px; }
        .qmeta { font-size:11px; color:#888; margin-top:8px; display:flex; gap:10px; flex-wrap:wrap; }
        .qtag { background:#f8f9fa; border:1px solid #eee; padding:2px 8px; border-radius:999px; font-weight:800; color:#5f6368; }
        .qtag.red { border-color:#fce8e6; background:#fce8e6; color:#b0261e; }
        .qtag.blue { border-color:#e8f0fe; background:#e8f0fe; color:#1a73e8; }
        .qtag.green { border-color:#e6f4ea; background:#e6f4ea; color:#137333; }
        .qempty { color:#9aa0a6; font-style:italic; padding:10px 2px; }

        /* APPLE KEY PANEL */
        .panel-card {
            background:#fff;
            border:1px solid var(--border);
            border-radius:12px;
            padding:18px;
            box-shadow:0 2px 5px rgba(0,0,0,0.05);
            max-width: 900px;
        }
        .apple-alert {
            display:none;
            align-items:flex-start;
            gap:10px;
            border:1px solid #fbbc04;
            background:#fff7e0;
            color:#7a4b00;
            padding:12px 14px;
            border-radius:10px;
            margin-bottom:14px;
            font-weight:700;
            font-size:13px;
        }
        .apple-alert.show { display:flex; }
        .apple-ok {
            display:none;
            align-items:center;
            gap:10px;
            border:1px solid #c8e6c9;
            background:#e8f5e9;
            color:#137333;
            padding:10px 12px;
            border-radius:10px;
            margin-bottom:14px;
            font-weight:800;
            font-size:13px;
        }
        .apple-ok.show { display:flex; }
        .apple-kv {
            display:grid;
            grid-template-columns: 220px 1fr;
            gap:10px 14px;
            font-size:13px;
            align-items:center;
        }
        .apple-kv .k { color:#666; font-weight:900; text-transform:uppercase; font-size:11px; }
        .apple-kv .v { color:#202124; font-weight:700; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; }
        .apple-row {
            display:flex;
            gap:10px;
            align-items:center;
            margin-top:14px;
        }
        .apple-row input {
            flex:1;
            padding:12px 12px;
            border-radius:10px;
            border:1px solid #ccc;
            font-size:13px;
        }
        .btn-inline {
            display:inline-flex;
            align-items:center;
            gap:8px;
            padding:12px 14px;
            border-radius:10px;
            border:1px solid var(--border);
            background:#fff;
            font-weight:900;
            cursor:pointer;
        }
        .btn-inline.primary {
            background: var(--primary);
            border-color: var(--primary);
            color:#fff;
        }
        .btn-inline.primary:disabled {
            background:#f1f3f4;
            border-color:#dadce0;
            color:#9aa0a6;
            cursor:not-allowed;
        }
        .small-note { color:#777; font-size:12px; margin-top:8px; }
    </style>
</head>
<body>

    <!-- SIDEBAR -->
    <div class="sidebar">
        <div class="logo-area" style="gap:10px;">
            <img src="/images/logo_red.png" alt="First Mate" height="34"
                onerror="this.style.display='none'; document.getElementById('logoTxt').style.display='block';">
            <span id="logoTxt" style="display:none;">First Mate</span>
        </div>

        <!-- Next in Queue -->
        <div class="queue-cta-wrap">
            <button id="btnNextQueue" class="btn-queue" onclick="handleNextInQueueClick()" disabled>
                <i class="fas fa-forward"></i> Next in Queue
            </button>

            <!-- Always show hint; only show queue count pill for queue admins -->
            <div class="queue-sub">
                <?php if ($isQueueAdmin): ?>
                    <span class="queue-pill">
                        <span id="queueDot" class="queue-dot empty"></span>
                        <span id="queueCountText">Queue: …</span>
                    </span>
                <?php else: ?>
                    <span></span>
                <?php endif; ?>
                <span id="queueHint">Checking…</span>
            </div>
        </div>

        <div class="nav-links">
            <button class="nav-btn active" onclick="switchView('projects', this)" id="navProjectsBtn">
                <i class="fas fa-th-large"></i> Project Browser
            </button>

            <?php if ($isQueueAdmin): ?>
            <button class="nav-btn" onclick="switchView('queue', this)" id="navQueueBtn">
                <i class="fas fa-stream"></i> Queue
            </button>
            <?php endif; ?>

            <?php if ($isAppleKeyAdmin): ?>
            <button class="nav-btn" onclick="switchView('apple-key', this)" id="navAppleKeyBtn">
                <i class="fas fa-apple-alt"></i> Apple Key
            </button>
            <?php endif; ?>

            <button class="nav-btn" onclick="switchView('tutorials', this)">
                <i class="fas fa-graduation-cap"></i> Tutorials
            </button>

            <?php if ($myPerms['manage_users'] || $myPerms['create_users']): ?>
            <button class="nav-btn" onclick="switchView('users', this)">
                <i class="fas fa-users-cog"></i> Users & Teams
            </button>
            <?php endif; ?>

            <div style="flex:1"></div>
            <a href="editor.php" class="nav-btn">
                <i class="fas fa-edit"></i> Open Editor
            </a>
        </div>

        <div class="user-panel">
            <strong><?= htmlspecialchars($currentUserName) ?></strong><br>
            <span style="font-size:11px;"><?= htmlspecialchars($currentUserEmail) ?></span><br>
            <span class="user-pill"><?= htmlspecialchars($myUserData['role']??'User') ?></span>
            <?php if ($myTrainingComplete): ?>
                <span class="user-pill" style="background:#e6f4ea; color:#137333; margin-left:6px;">Training Complete</span>
            <?php else: ?>
                <span class="user-pill" style="background:#fce8e6; color:#b0261e; margin-left:6px;">Training Pending</span>
            <?php endif; ?>
            <div style="margin-top:10px;">
                <a href="backend_logout.php" style="color:var(--primary); text-decoration:none; font-weight:600;">Sign Out</a>
            </div>
        </div>
    </div>

    <!-- MAIN CONTENT -->
    <div class="main-content">

        <!-- PROJECT VIEW -->
        <div id="view-projects">
            <div class="header-bar">
                <h1>Projects</h1>
                <div class="filter-group" id="filterContainer"></div>
            </div>
            <div class="grid" id="projectsGrid"></div>
        </div>

        <!-- QUEUE VIEW (ADMIN) -->
        <?php if ($isQueueAdmin): ?>
        <div id="view-queue" style="display:none;">
            <div class="header-bar">
                <h1>Queue Monitor</h1>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="queue-team-filter">
                        <span style="font-size:12px; color:#666; font-weight:800;">Team</span>
                        <select id="queueTeamSelect" onchange="refreshQueueAdmin(true)"></select>
                    </div>
                    <button class="btn-secondary" onclick="refreshQueueAdmin(true)"><i class="fas fa-sync"></i> Refresh</button>
                </div>
            </div>

            <div class="queue-panel">
                <div class="queue-head">
                    <div class="queue-title">Live overview</div>
                    <div style="font-size:12px; color:#666; font-weight:800;" id="queueAdminStatus">…</div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-layer-group" style="color:#fbbc04;"></i> Queued (not started)</h3>
                    <div class="hscroll" id="qRowQueued"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-person-digging" style="color:#1a73e8;"></i> In Progress</h3>
                    <div class="hscroll" id="qRowInProgress"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-clipboard-check" style="color:#b0261e;"></i> In QA</h3>
                    <div class="hscroll" id="qRowQA"></div>
                </div>

                <div class="queue-section">
                    <h3><i class="fas fa-calendar-day" style="color:#137333;"></i> Completed Today</h3>
                    <div class="grid" id="qCompletedGrid" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:16px;"></div>
                </div>
            </div>
        </div>
        <?php endif; ?>

        <!-- APPLE KEY VIEW -->
        <?php if ($isAppleKeyAdmin): ?>
        <div id="view-apple-key" style="display:none;">
            <div class="header-bar">
                <h1>Apple Maps Key</h1>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="refreshAppleKey(true)"><i class="fas fa-sync"></i> Refresh</button>
                </div>
            </div>

            <div class="panel-card">
                <div id="appleWarn" class="apple-alert">
                    <i class="fas fa-triangle-exclamation" style="margin-top:2px;"></i>
                    <div>
                        <div>Key looks stale (over 25 minutes old).</div>
                        <div style="font-weight:600; font-size:12px; opacity:0.9;">Apple keys expire at ~30 minutes. Set a fresh one now.</div>
                    </div>
                </div>

                <div id="appleOk" class="apple-ok">
                    <i class="fas fa-circle-check"></i>
                    <div>Key age is under 25 minutes.</div>
                </div>

                <div class="apple-kv">
                    <div class="k">Status</div>
                    <div class="v" id="appleStatusText">Loading…</div>

                    <div class="k">Updated (UTC)</div>
                    <div class="v mono" id="appleUpdatedUtc">—</div>

                    <div class="k">Age</div>
                    <div class="v" id="appleAge">—</div>

                    <div class="k">Key (masked)</div>
                    <div class="v mono" id="appleKeyMasked">—</div>
                </div>

                <div class="apple-row">
                    <input id="appleKeyInput" class="mono" placeholder="Paste Apple Maps accessKey here (exact string)…" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <button id="btnAppleSave" class="btn-inline primary" onclick="saveAppleKey()">
                        <i class="fas fa-save"></i> Save Key
                    </button>
                </div>

                <div class="small-note">
                    Tip: You can paste a new key anytime. This panel will warn you after 25 minutes.
                </div>
            </div>
        </div>
        <?php endif; ?>

        <!-- TUTORIALS VIEW -->
        <div id="view-tutorials" style="display:none;">
            <div class="header-bar">
                <h1>Training Curriculum</h1>
                <div style="display:flex; gap:10px;">
                    <?php if($myPerms['manage_tutorials']): ?>
                        <button class="btn-secondary" onclick="openStudentProgress()">
                            <i class="fas fa-chart-line"></i> Student Progress
                        </button>
                        <button class="btn-secondary" onclick="openEditor()">
                            <i class="fas fa-edit"></i> Edit Curriculum
                        </button>
                    <?php endif; ?>
                </div>
            </div>

            <div id="chapterGrid" class="grid"></div>

            <div id="chapterDetail" style="display:none;">
                <button onclick="showChapterGrid()" style="margin-bottom:15px; background:none; border:none; color:#666; cursor:pointer; font-weight:600;">
                    <i class="fas fa-arrow-left"></i> Back to Chapters
                </button>

                <div class="chapter-header">
                    <h2 id="chapTitle" style="margin:0;">Chapter 1</h2>
                    <span id="chapProgress" style="background:#e8f0fe; color:#1a73e8; padding:4px 10px; border-radius:12px; font-size:12px; font-weight:bold;">—</span>
                </div>

                <!-- NEW: Chapter description -->
                <div id="chapDescCard" class="chapter-desc-card"></div>

                <div class="col-3-layout">
                    <div>
                        <h3><i class="fas fa-video" style="color:#555;"></i> Videos</h3>
                        <div id="resList" class="res-list"></div>
                    </div>

                    <div>
                        <h3><i class="fas fa-file-pdf" style="color:#555;"></i> Guides</h3>
                        <div id="guideList" class="res-list"></div>
                    </div>

                    <div>
                        <h3><i class="fas fa-project-diagram" style="color:#555;"></i> Hands-on Projects</h3>
                        <div id="projList" class="res-list" style="display:flex; flex-direction:column; gap:15px;"></div>
                    </div>
                </div>

                <button class="fab-next" onclick="completeChapter()" id="btnNextChapter">
                    Next Chapter <i class="fas fa-arrow-right"></i>
                </button>
            </div>
        </div>

        <!-- STUDENT PROGRESS VIEW -->
        <div id="view-student-progress" style="display:none;">
            <div class="header-bar">
                <div style="display:flex; align-items:center; gap:15px;">
                    <button class="btn-secondary" onclick="switchView('tutorials')" title="Back"><i class="fas fa-arrow-left"></i></button>
                    <h1>Student Progress</h1>
                </div>
                <button class="btn-secondary" onclick="fetchStudentList()"><i class="fas fa-sync"></i> Refresh</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Student Name</th>
                        <th>Email</th>
                        <th>Current Chapter</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody id="studentTable">
                    <tr><td colspan="4" style="text-align:center; padding:30px;">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <!-- USER VIEW -->
        <div id="view-users" style="display:none;">
            <div class="header-bar">
                <h1>User Management</h1>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="fetchUsers()"><i class="fas fa-sync"></i> Refresh</button>
                    <?php if ($myPerms['create_users']): ?>
                    <button class="btn-primary" onclick="openUserModal('create')"><i class="fas fa-plus"></i> Add User</button>
                    <?php endif; ?>
                </div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Name</th><th>Email</th><th>Role</th><th>Team ID</th><th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody id="usersTable"></tbody>
            </table>
        </div>

    </div>

    <!-- STUDENT DETAIL MODAL -->
    <div class="modal-overlay" id="studentModal">
        <div class="modal-card md-student">
            <div class="modal-header">
                <h2 id="stModalTitle">Student Details</h2>
                <button onclick="closeModal('studentModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div style="display:grid; grid-template-columns: 1fr 2fr; gap:20px; height:100%;">
                    <div style="background:#f9f9f9; padding:20px; border-radius:8px;">
                        <h3 style="margin-top:0;">Progress</h3>
                        <div class="meta-group">
                            <div class="meta-label">Current Chapter</div>
                            <div class="meta-val" id="stCurrentChap" style="font-size:18px; font-weight:bold; color:var(--primary);"></div>
                        </div>
                        <hr>
                        <h4>Video Watch History</h4>
                        <div id="stVideoList" class="res-list" style="max-height:400px; overflow-y:auto;"></div>
                    </div>

                    <div style="display:flex; flex-direction:column;">
                        <h3 style="margin-top:0;">Started Projects</h3>
                        <p style="font-size:12px; color:#777; margin-bottom:15px;">These are the specific instances created by this student. Click to review or edit their work.</p>
                        <div id="stProjectGrid" class="grid" style="grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));"></div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="closeModal('studentModal')">Close</button>
            </div>
        </div>
    </div>

    <!-- EDITOR MODAL -->
    <div class="modal-overlay" id="editorModal">
        <div class="modal-card md-editor">
            <div class="modal-header">
                <h2>Curriculum Editor</h2>
                <button onclick="closeModal('editorModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div id="editorContent"></div>
            </div>
            <div class="modal-footer">
                <div id="paginationCtr" class="pagination"></div>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="addEditorChapter()">+ New Chapter</button>
                    <button class="btn-primary" onclick="saveCurriculum()">Save Curriculum</button>
                </div>
            </div>
        </div>
    </div>

    <!-- PROJECT DETAILS MODAL -->
    <div class="modal-overlay" id="projModal">
        <div class="modal-card md-project">
            <div class="modal-header">
                <h2>Project Details</h2>
                <button onclick="closeModal('projModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body" style="padding:0;">
                <div class="proj-layout">
                    <div class="proj-meta" style="padding:25px; background:#f9f9f9;">
                        <div class="meta-group">
                            <div class="meta-label">Address</div>
                            <div class="meta-val" id="pmAddress"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Status</div>
                            <div class="meta-val" id="pmStatus"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Owner</div>
                            <div class="meta-val" id="pmOwner"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Date Created</div>
                            <div class="meta-val" id="pmDate"></div>
                        </div>

                        <div style="margin-top:auto; display:flex; gap:10px; flex-direction:column;">
                            <a href="#" target="_blank" id="pmPdfBtn" class="btn-secondary" style="text-align:center; text-decoration:none; gap: 10px;">
                                <i class="fas fa-file-pdf"></i> Download PDF
                            </a>
                            <button class="btn-big-edit" id="pmEditBtn">
                                <i class="fas fa-edit"></i> Open in Editor
                            </button>
                        </div>
                    </div>
                    <div class="proj-gallery" style="padding:25px;">
                        <h3 style="margin-top:0; font-size:14px; color:#555;">Project Assets</h3>
                        <div class="gallery-grid" id="pmGallery"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- USER MODAL -->
    <div class="modal-overlay" id="userModal">
        <div class="modal-card md-user">
            <div class="modal-header">
                <h2 id="uModalTitle">Edit User</h2>
                <button onclick="closeModal('userModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <form id="userForm">
                    <input type="hidden" id="uMode">
                    <div class="form-row"><label>Email</label><input type="email" id="uEmail" required></div>
                    <div class="form-row"><label>Full Name</label><input type="text" id="uName"></div>
                    <div class="form-row"><label>Password <span style="font-weight:normal; font-size:10px;">(Leave blank to keep existing)</span></label><input type="text" id="uPass"></div>
                    <div class="form-row"><label>Team Identifier</label><input type="text" id="uTeam" placeholder="default"></div>

                    <div class="form-row">
                        <label>Queue Priority</label>
                        <select id="uComplexityPref" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="all">No Preference (FIFO)</option>
                            <option value="simple">Prioritize Simple</option>
                            <option value="complex">Prioritize Complex</option>
                        </select>
                    </div>

                    <!-- NEW: Training Complete flag (admin set; not automatic) -->
                    <div class="form-row">
                        <label>Training Complete</label>
                        <label style="display:flex; align-items:center; gap:10px; font-size:13px; text-transform:none; font-weight:700; color:#333; margin:0;">
                            <input type="checkbox" id="uTrainingComplete">
                            Approved to use “Next in Queue”
                        </label>
                        <div style="font-size:11px; color:#777; margin-top:6px;">
                            Set manually by admin only. Not set automatically when chapters are finished.
                        </div>
                    </div>

                    <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#777; margin-bottom:5px;">Permissions Preset</label>
                    <div class="presets">
                        <button type="button" class="btn-preset" onclick="applyPreset('admin')">Admin</button>
                        <button type="button" class="btn-preset" onclick="applyPreset('lead')">Team Lead</button>
                        <button type="button" class="btn-preset" onclick="applyPreset('user')">User</button>
                    </div>

                    <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#777; margin-bottom:5px;">Detailed Permissions</label>
                    <div class="perm-grid">
                        <label class="perm-item"><input type="checkbox" id="p_view_all"> View All Projects</label>
                        <label class="perm-item"><input type="checkbox" id="p_view_team"> View Team Projects</label>
                        <label class="perm-item"><input type="checkbox" id="p_manage_users"> Edit Users</label>
                        <label class="perm-item"><input type="checkbox" id="p_create_users"> Add/Delete Users</label>
                        <label class="perm-item"><input type="checkbox" id="p_assign_teams"> Assign Teams</label>
                        <label class="perm-item"><input type="checkbox" id="p_manage_tutorials"> Manage Tutorials</label>
                        <label class="perm-item"><input type="checkbox" id="p_admin_legacy"> Admin Legacy</label>
                        <label class="perm-item"><input type="checkbox" id="p_manage_queue"> Manage Queue</label>
                        <label class="perm-item"><input type="checkbox" id="p_manage_apple_key"> Manage Apple Key</label>
                    </div>
                    <input type="hidden" id="uRoleLabel">
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn-danger" id="btnDeleteUser" style="margin-right:auto; display:none;" onclick="deleteUser()">Delete</button>
                <button class="btn-secondary" onclick="closeModal('userModal')">Cancel</button>
                <button class="btn-primary" onclick="saveUser()">Save User</button>
            </div>
        </div>
    </div>

<script>
    const MY_PERMS = <?php echo json_encode($myPerms); ?>;
    const CURRENT_USER_EMAIL = "<?php echo $currentUserEmail; ?>";
    const CURRENT_USER_NAME  = "<?php echo htmlspecialchars($currentUserName, ENT_QUOTES); ?>";
    const IS_QUEUE_ADMIN = <?php echo $isQueueAdmin ? 'true' : 'false'; ?>;
    const IS_APPLE_KEY_ADMIN = <?php echo $isAppleKeyAdmin ? 'true' : 'false'; ?>;

    // NEW: training completion flag (admin set)
    const MY_TRAINING_COMPLETE = <?php echo $myTrainingComplete ? 'true' : 'false'; ?>;

    let currentFilter = 'mine';
    let curriculum = { chapters: [] };
    let progress = { completed_videos: [], completed_projects: [], current_chapter: 1 };
    let currentChapIdx = 0;
    let currentEditorPage = 0;

    // Project lists
    let myProjectList = [];          // whatever current project-browser filter returns
    let myTutorialProjectList = [];  // always "mine" for tutorial gating

    // Next-in-queue button state
    let queueHasNext = false;
    let queueCount = null;
    let queuePollTimer = null;
    let queueBusy = false;

    // Queue admin state
    let queueAdminTimer = null;
    let queueAdminTeam = 'all';
    let queueAdminTeams = [];

    // Apple key state
    let appleKeyTimer = null;
    let appleKeyInfo = { key: null, updated_at_utc: null };

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    document.addEventListener('DOMContentLoaded', () => {
        initFilters();
        fetchProjects();
        if(MY_PERMS.manage_users) fetchUsers();

        // Init queue button (always)
        refreshQueueButton(true);

        if (IS_QUEUE_ADMIN) {
            initQueueAdminTeams().then(() => {});
        }
    });

    function initMapsCallback() { console.log("Maps Loaded for Autocomplete"); }

    async function switchView(id, btn) {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        if(btn) btn.classList.add('active');

        // hide all
        ['projects','users','tutorials','student-progress','queue','apple-key'].forEach(v => {
            const el = document.getElementById('view-'+v);
            if(el) el.style.display='none';
        });

        // stop timers when switching
        if (queueAdminTimer) { clearInterval(queueAdminTimer); queueAdminTimer = null; }
        if (appleKeyTimer) { clearInterval(appleKeyTimer); appleKeyTimer = null; }

        // show selected
        const target = document.getElementById('view-' + id);
        if (target) target.style.display = 'block';

        if(id === 'users') fetchUsers();
        if(id === 'projects') fetchProjects();

        if(id === 'tutorials') {
            // ensure we have ONLY my projects for tutorial gating
            await fetchTutorialProjectsMine();
            fetchTutorials();
        }

        if(id === 'queue' && IS_QUEUE_ADMIN) {
            await initQueueAdminTeams();
            refreshQueueAdmin(true);
            queueAdminTimer = setInterval(() => refreshQueueAdmin(false), 5000);
        }

        if(id === 'apple-key' && IS_APPLE_KEY_ADMIN) {
            await refreshAppleKey(true);
            appleKeyTimer = setInterval(() => renderAppleKeyInfo(appleKeyInfo), 5000);
        }
    }

    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    // --- APPLE KEY UI ---
    function maskKey(k) {
        if (!k) return '—';
        const s = String(k);
        if (s.length <= 12) return '************';
        return s.slice(0, 6) + '…' + s.slice(-6);
    }

    function parseUtcIso(ts) {
        if (!ts) return null;
        const t = Date.parse(ts);
        return isNaN(t) ? null : t;
    }

    function fmtAgeMs(ms) {
        if (ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const remS = s % 60;
        if (h > 0) return `${h}h ${m%60}m`;
        if (m > 0) return `${m}m ${remS}s`;
        return `${s}s`;
    }

    function renderAppleKeyInfo(info) {
        const statusEl = document.getElementById('appleStatusText');
        const utcEl = document.getElementById('appleUpdatedUtc');
        const ageEl = document.getElementById('appleAge');
        const maskedEl = document.getElementById('appleKeyMasked');
        const warnEl = document.getElementById('appleWarn');
        const okEl = document.getElementById('appleOk');

        const hasKey = !!(info && info.key);
        const t = parseUtcIso(info && info.updated_at_utc ? info.updated_at_utc : null);
        const now = Date.now();
        const ageMs = (t ? (now - t) : null);
        const ageMin = (ageMs !== null) ? (ageMs / 60000) : null;

        if (maskedEl) maskedEl.textContent = maskKey(info && info.key ? info.key : null);
        if (utcEl) utcEl.textContent = info && info.updated_at_utc ? info.updated_at_utc : '—';

        if (!hasKey) {
            if (statusEl) statusEl.textContent = 'No key set';
            if (ageEl) ageEl.textContent = '—';
            if (warnEl) warnEl.classList.add('show');
            if (okEl) okEl.classList.remove('show');
            return;
        }

        if (!t) {
            if (statusEl) statusEl.textContent = 'Key set (timestamp missing)';
            if (ageEl) ageEl.textContent = '—';
            if (warnEl) warnEl.classList.add('show');
            if (okEl) okEl.classList.remove('show');
            return;
        }

        if (statusEl) statusEl.textContent = 'Key present';
        if (ageEl) ageEl.textContent = fmtAgeMs(ageMs);

        const isWarn = (ageMin !== null && ageMin > 25);
        if (warnEl) warnEl.classList.toggle('show', isWarn);
        if (okEl) okEl.classList.toggle('show', !isWarn);
    }

    async function refreshAppleKey(force=false) {
        if (!IS_APPLE_KEY_ADMIN) return;

        try {
            const fd = new FormData();
            fd.append('action','get_apple_key_info');
            const res = await fetch('portal.php', { method:'POST', body: fd });
            const data = await res.json();
            if (!data || !data.success) throw new Error(data && data.error ? data.error : 'Fetch failed');
            appleKeyInfo = { key: data.key || null, updated_at_utc: data.updated_at_utc || null };
            renderAppleKeyInfo(appleKeyInfo);
        } catch (e) {
            appleKeyInfo = { key: null, updated_at_utc: null };
            renderAppleKeyInfo(appleKeyInfo);
            alert("Apple key fetch failed.");
        }
    }

    async function saveAppleKey() {
        if (!IS_APPLE_KEY_ADMIN) return;
        const inp = document.getElementById('appleKeyInput');
        const btn = document.getElementById('btnAppleSave');
        const key = inp ? inp.value.trim() : '';
        if (!key) { alert("Paste a key first."); return; }

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }

        try {
            const fd = new FormData();
            fd.append('action','set_apple_key');
            fd.append('key', key);

            const res = await fetch('portal.php', { method:'POST', body: fd });
            const data = await res.json();

            if (!data || !data.success) throw new Error(data && data.error ? data.error : 'Save failed');

            if (inp) inp.value = '';
            await refreshAppleKey(true);

        } catch (e) {
            alert("Apple key save failed.");
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Key'; }
        }
    }

    // --- NEXT IN QUEUE (Sidebar) ---
    function setQueueButtonState({ hasNext, count, hint, busy=false }) {
        queueHasNext = !!hasNext;
        queueCount = (typeof count === 'number') ? count : queueCount;

        const btn = document.getElementById('btnNextQueue');
        const dot = document.getElementById('queueDot');
        const cTxt = document.getElementById('queueCountText');
        const hTxt = document.getElementById('queueHint');

        if (cTxt) cTxt.textContent = (queueCount === null) ? 'Queue: …' : `Queue: ${queueCount}`;
        if (dot) dot.classList.toggle('empty', !queueHasNext);

        // NEW: training gate
        const trainingOk = !!MY_TRAINING_COMPLETE;
        const ready = trainingOk && queueHasNext;

        let finalHint = hint || (queueHasNext ? 'Ready' : 'Empty');
        if (!trainingOk) finalHint = 'Training required';

        if (hTxt) hTxt.textContent = finalHint;

        if (btn) {
            btn.disabled = busy || !ready;
            btn.classList.toggle('disabled', btn.disabled);

            if (!trainingOk) {
                btn.innerHTML = busy
                    ? `<i class="fas fa-circle-notch fa-spin"></i> Assigning…`
                    : `<i class="fas fa-lock"></i> Next in Queue`;
            } else {
                btn.innerHTML = busy
                    ? `<i class="fas fa-circle-notch fa-spin"></i> Assigning…`
                    : `<i class="fas fa-forward"></i> Next in Queue`;
            }
        }
    }

    async function refreshQueueButton(force = false) {
        // Even if training isn't complete, still refresh so admins can see counts/hints.
        try {
            const fd = new FormData();
            fd.append('action', 'queue_status');

            const res = await fetch('server.php', { method:'POST', body: fd });
            const data = await res.json();

            const hasNext = !!data.has_next;
            const count = (typeof data.queue_count === 'number') ? data.queue_count : null;

            setQueueButtonState({ hasNext, count, hint: hasNext ? 'Ready' : 'Empty' });

            if (!hasNext) {
                if (!queuePollTimer) queuePollTimer = setInterval(() => refreshQueueButton(false), 10000);
            } else {
                if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
            }
        } catch (e) {
            setQueueButtonState({ hasNext: false, count: queueCount, hint: 'Error' });
            if (!queuePollTimer) queuePollTimer = setInterval(() => refreshQueueButton(false), 10000);
        }
    }

    async function handleNextInQueueClick() {
        if (!MY_TRAINING_COMPLETE) return; // hard gate

        if (queueBusy) return;
        queueBusy = true;
        setQueueButtonState({ hasNext: queueHasNext, count: queueCount, hint: 'Assigning…', busy: true });

        try {
            const fd = new FormData();
            fd.append('action', 'claim_next_in_queue');

            const res = await fetch('server.php', { method:'POST', body: fd });
            const data = await res.json();

            if (!data || !data.success) {
                queueBusy = false;
                await refreshQueueButton(true);
                alert(data.error || 'No project available.');
                return;
            }

            const folder = data.folder;
            localStorage.setItem('autoLoadProject', folder);
            window.location.href = 'editor.php';
        } catch (e) {
            queueBusy = false;
            await refreshQueueButton(true);
            alert("Failed to claim next project.");
        }
    }

    // --- QUEUE ADMIN TAB ---
    function fmtAge(ms) {
        if (ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);
        if (d > 0) return `${d}d ${h%24}h`;
        if (h > 0) return `${h}h ${m%60}m`;
        if (m > 0) return `${m}m`;
        return `${s}s`;
    }

    async function initQueueAdminTeams() {
        if (!IS_QUEUE_ADMIN) return;
        if (queueAdminTeams && queueAdminTeams.length) return;

        try {
            const fd = new FormData();
            fd.append('action', 'queue_admin_teams');
            const res = await fetch('server.php', { method:'POST', body: fd });
            const data = await res.json();
            queueAdminTeams = data.teams || [];
        } catch (e) {
            queueAdminTeams = [];
        }

        const sel = document.getElementById('queueTeamSelect');
        if (!sel) return;

        sel.innerHTML = '';
        const optAll = document.createElement('option');
        optAll.value = 'all';
        optAll.textContent = 'All';
        sel.appendChild(optAll);

        queueAdminTeams.forEach(t => {
            const o = document.createElement('option');
            o.value = t;
            o.textContent = t;
            sel.appendChild(o);
        });

        sel.value = queueAdminTeam || 'all';
    }

    function renderQueueRow(containerId, items, kind) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';

        if (!items || items.length === 0) {
            el.innerHTML = `<div class="qempty">Nothing here.</div>`;
            return;
        }

        const now = Date.now();

        items.forEach(p => {
            const created = p.created_at ? Date.parse(p.created_at.replace(' ', 'T')) : null;
            const queuedAt = p.queued_at ? Date.parse(p.queued_at.replace(' ', 'T')) : created;
            const startedAt = p.started_at ? Date.parse(p.started_at.replace(' ', 'T')) : null;
            const qaAt = p.qa_at ? Date.parse(p.qa_at.replace(' ', 'T')) : null;

            let ageMs = 0;
            let ageLabel = 'Age';
            if (kind === 'queued') {
                ageMs = queuedAt ? (now - queuedAt) : 0;
                ageLabel = 'In queue';
            } else if (kind === 'in_progress') {
                ageMs = startedAt ? (now - startedAt) : 0;
                ageLabel = 'Working';
            } else if (kind === 'qa') {
                ageMs = qaAt ? (now - qaAt) : 0;
                ageLabel = 'QA';
            }

            const assigned = p.assigned_to_name || p.assigned_to_email || '—';
            const team = p.team_id || 'default';

            const tagCls = (kind === 'queued') ? 'red' : (kind === 'in_progress' ? 'blue' : 'green');
            const tagText = (kind === 'queued') ? 'QUEUED' : (kind === 'in_progress' ? 'IN PROGRESS' : 'QA');

            const fillerTag = p.is_filler
                ? `<span class="qtag" style="background:#555; color:#fff; border-color:#333;">FILLER</span>`
                : '';

            const compClass = (p.complexity === 'simple') ? 'green' : 'red';
            const compLabel = (p.complexity === 'simple') ? 'SMPL' : 'CMPLX';
            const complexityTag = `<span class="qtag ${compClass}" style="font-size:9px;">${compLabel}</span>`;

            const div = document.createElement('div');
            div.className = 'qcard';
            div.innerHTML = `
                <div class="qline1">${escapeHtml(p.address || '(no address)')}</div>
                <div class="qline2">
                    <span><b>${ageLabel}:</b> ${fmtAge(ageMs)}</span>
                    <span style="color:#888; font-weight:800;">${escapeHtml(team)}</span>
                </div>
                <div class="qmeta">
                    ${fillerTag}
                    ${complexityTag}
                    <span class="qtag ${tagCls}">${tagText}</span>
                    ${kind !== 'queued' ? `<span class="qtag">${escapeHtml(assigned)}</span>` : `<span class="qtag">waiting</span>`}
                    <span class="qtag">${escapeHtml(p.id || '')}</span>
                </div>
            `;
            div.onclick = () => openProjectModal(p.id);
            el.appendChild(div);
        });
    }

    function renderCompletedToday(items) {
        const grid = document.getElementById('qCompletedGrid');
        if (!grid) return;
        grid.innerHTML = '';

        if (!items || items.length === 0) {
            grid.innerHTML = `<div style="grid-column:1/-1; color:#9aa0a6; font-style:italic; padding:12px 2px;">Nothing completed today.</div>`;
            return;
        }

        items.forEach(p => {
            const div = document.createElement('div');
            div.className = 'tile';
            div.innerHTML = `
                <div class="tile-thumb" style="height:140px;">
                    <img src="${p.thumbnail || ''}" onerror="this.style.display='none'">
                    <div class="badge bg-ready">completed</div>
                </div>
                <div class="tile-content" style="padding:12px;">
                    <div class="tile-addr" style="font-size:13px;">${escapeHtml(p.address || '-')}</div>
                    <div class="tile-meta" style="margin:0; color:#777;">
                        ${escapeHtml(p.assigned_to_name || p.assigned_to_email || p.owner || '-')}
                        &bull;
                        ${p.completed_at ? new Date(p.completed_at).toLocaleTimeString() : ''}
                    </div>
                </div>
            `;
            div.onclick = () => openProjectModal(p.id);
            grid.appendChild(div);
        });
    }

    async function refreshQueueAdmin(force = false) {
        if (!IS_QUEUE_ADMIN) return;
        const view = document.getElementById('view-queue');
        if (!view || view.style.display === 'none') return;

        const sel = document.getElementById('queueTeamSelect');
        if (sel) queueAdminTeam = sel.value || 'all';

        const statusEl = document.getElementById('queueAdminStatus');
        if (statusEl && force) {
            statusEl.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Refreshing…`;
        }

        try {
            const fd = new FormData();
            fd.append('action', 'queue_admin_overview');
            fd.append('team', queueAdminTeam);

            const res = await fetch('server.php', { method:'POST', body: fd });
            const data = await res.json();

            if (!data || !data.success) throw new Error('bad');

            const queued = data.queued || [];
            const inProg = data.in_progress || [];
            const qa = data.qa || [];
            const done = data.completed_today || [];

            renderQueueRow('qRowQueued', queued, 'queued');
            renderQueueRow('qRowInProgress', inProg, 'in_progress');
            renderQueueRow('qRowQA', qa, 'qa');
            renderCompletedToday(done);

            setQueueSectionCount('qRowQueued', queued.length);
            setQueueSectionCount('qRowInProgress', inProg.length);
            setQueueSectionCount('qRowQA', qa.length);
            setQueueSectionCount('qCompletedGrid', done.length);

            if (statusEl) {
                statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
            }

        } catch (e) {
            if (statusEl) statusEl.textContent = 'Refresh failed';
        }
    }

    function setQueueSectionCount(containerId, count) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const section = container.closest('.queue-section');
        if (!section) return;

        const h3 = section.querySelector('h3');
        if (!h3) return;

        h3.innerHTML = h3.innerHTML.replace(/\s*\(\d+\)$/, '');
        h3.innerHTML += ` (${count})`;
    }

    // --- PROJECTS LOGIC ---
    function initFilters() {
        const c = document.getElementById('filterContainer');
        c.innerHTML = '';
        const add = (id, lbl) => {
            const b = document.createElement('button');
            b.className = 'filter-btn ' + (currentFilter===id?'active':'');
            b.innerText = lbl;
            b.onclick = () => { currentFilter=id; initFilters(); fetchProjects(); };
            c.appendChild(b);
        };
        if(MY_PERMS.view_all_projects) { add('all','All'); add('team','Team'); add('mine','Mine'); }
        else if(MY_PERMS.view_team_projects) { add('team','Team'); add('mine','Mine'); }
        else { add('mine','My Projects'); }
    }

    async function fetchProjects() {
        const grid = document.getElementById('projectsGrid');

        if(document.getElementById('view-projects').style.display !== 'none') {
             grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#999;padding:40px;">Loading...</div>';
        }

        const fd = new FormData(); fd.append('action','list_projects'); fd.append('filter',currentFilter);
        const res = await fetch('server.php', {method:'POST', body:fd});
        const data = await res.json();

        if(data.projects) myProjectList = data.projects;

        if(document.getElementById('view-projects').style.display === 'none') return;

        grid.innerHTML = '';
        if(!data.projects || data.projects.length===0) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#ccc;padding:40px;">No projects.</div>';
            return;
        }

        data.projects.forEach(p => {
            let cls='bg-queued';
            if(p.status==='completed') cls='bg-ready';
            else if(p.status==='processing' || p.status==='in_progress') cls='bg-processing';
            else if(p.status==='awaiting_review') cls='bg-review';

            let ownerDisplay = p.owner;
            if(p.assigned_to_email && p.assigned_to_email === CURRENT_USER_EMAIL) ownerDisplay = "Me";
            if(p.owner === CURRENT_USER_EMAIL) ownerDisplay = "Me";
            if(!ownerDisplay || ownerDisplay === 'Unknown') ownerDisplay = "Me";

            let tutorialHtml = '';
            let titlePrefix = '';
            if (p.is_tutorial_instance) {
                tutorialHtml = `<div class="badge bg-tutorial">TUTORIAL</div>`;
                titlePrefix = `<i class="fas fa-graduation-cap" style="color:#673ab7; margin-right:5px;"></i>`;
            }

            const complexity = p.complexity || 'complex';
            const compClass = complexity === 'simple' ? 'bg-simple' : 'bg-complex';
            const compLabel = complexity === 'simple' ? 'SIMPLE' : 'COMPLEX';

            const div = document.createElement('div');
            div.className = 'tile';
            div.innerHTML = `
                <div class="tile-thumb">
                    ${tutorialHtml}
                    <img src="${p.thumbnail || ''}" onerror="this.style.display='none'">
                    <div class="badge ${cls}">${escapeHtml(p.status || '')}</div>
                    <div class="badge-complexity ${compClass}" style="top: calc(100% - 30px);">${compLabel}</div>
                </div>
                <div class="tile-content">
                    <div class="tile-addr">${titlePrefix}${escapeHtml(p.address || '')}</div>
                    <div class="tile-meta">${escapeHtml(ownerDisplay || '')} &bull; ${p.created_at ? new Date(p.created_at).toLocaleDateString() : ''}</div>
                </div>
            `;
            div.onclick = () => openProjectModal(p.id);
            grid.appendChild(div);
        });

        refreshQueueButton(false);
    }

    function directOpen(id) {
        // Inline onclick handlers often expose a global `event` in the browser.
        const evt = (typeof event !== 'undefined' && event) ? event : (window.event || null);

        const openNewTab =
            !!evt && (
                evt.ctrlKey ||            // Ctrl+Click (Windows/Linux)
                evt.metaKey ||            // Cmd+Click (Mac)
                evt.button === 1          // Middle mouse click
            );

        if (openNewTab) {
            // Don't let the click bubble to row handlers / modal handlers.
            try { evt.preventDefault(); } catch(e) {}
            try { evt.stopPropagation(); } catch(e) {}

            // Keep existing editor auto-load mechanism.
            localStorage.setItem('autoLoadProject', id);

            // Open editor in a new tab without navigating this one.
            window.open('editor.php', '_blank', 'noopener');
            return;
        }

        // Default: same-tab behavior (unchanged)
        localStorage.setItem('autoLoadProject', id);
        window.location.href = 'editor.php';
    }


    async function openProjectModal(id) {
        const fd = new FormData(); fd.append('action','get_project_details'); fd.append('folder_id',id);
        const res = await fetch('portal.php',{method:'POST', body:fd});
        const data = await res.json();

        if(!data.success) return alert(data.error || "Could not load details");

        const m = data.manifest;

        let addrDisplay = m.address || '-';
        if (m.is_tutorial_instance) {
            addrDisplay = `TRAINING: ${addrDisplay}`;
            document.getElementById('pmAddress').style.color = "#673ab7";
            document.getElementById('pmAddress').style.fontWeight = "bold";
        } else {
            document.getElementById('pmAddress').style.color = "#333";
            document.getElementById('pmAddress').style.fontWeight = "normal";
        }

        document.getElementById('pmAddress').innerText = addrDisplay;
        document.getElementById('pmStatus').innerText = m.status || '-';
        document.getElementById('pmOwner').innerText = (m.issuer?m.issuer.name:'') || m.owner_email || '-';
        document.getElementById('pmDate').innerText = m.created_at || '-';

        const pdfBtn = document.getElementById('pmPdfBtn');
        if(data.pdf_url) { pdfBtn.href=data.pdf_url; pdfBtn.style.display='flex'; }
        else pdfBtn.style.display='none';

        document.getElementById('pmEditBtn').onclick = () => directOpen(id);

        const gal = document.getElementById('pmGallery');
        gal.innerHTML = '';
        data.images.forEach(img => {
            const d = document.createElement('div');
            d.className = 'gal-item';
            d.innerHTML = `<img src="${img.url}" title="${escapeHtml(img.name || '')}" onclick="window.open(this.src)">`;
            gal.appendChild(d);
        });

        document.getElementById('projModal').style.display = 'flex';
    }

    // --- TUTORIALS LOGIC ---
    async function fetchTutorialProjectsMine() {
        try {
            const fd = new FormData();
            fd.append('action','list_projects');
            fd.append('filter','mine');
            const res = await fetch('server.php', { method:'POST', body: fd });
            const data = await res.json();
            myTutorialProjectList = data.projects || [];
        } catch (e) {
            myTutorialProjectList = [];
        }
    }

    function normalizeCurriculumAndProgress() {
        if (!curriculum || typeof curriculum !== 'object') curriculum = { chapters: [] };
        if (!Array.isArray(curriculum.chapters)) curriculum.chapters = [];

        curriculum.chapters = curriculum.chapters.map(ch => {
            const out = Object.assign({}, ch || {});
            out.title = (typeof out.title === 'string' && out.title.trim() !== '') ? out.title : 'Untitled';
            out.description = (typeof out.description === 'string') ? out.description : '';
            out.videos = Array.isArray(out.videos) ? out.videos : [];
            out.pdfs = Array.isArray(out.pdfs) ? out.pdfs : [];
            out.projects = Array.isArray(out.projects) ? out.projects : [];
            return out;
        });

        if (!progress || typeof progress !== 'object') progress = {};
        if (!Array.isArray(progress.completed_videos)) progress.completed_videos = [];
        if (!Array.isArray(progress.completed_projects)) progress.completed_projects = [];
        progress.current_chapter = parseInt(progress.current_chapter || 1, 10);
        if (!progress.current_chapter || progress.current_chapter < 1) progress.current_chapter = 1;
    }

    function isVideoOpened(url) {
        return (progress.completed_videos || []).some(v => (typeof v === 'string' ? v === url : (v && v.url === url)));
    }

    function startedMasterIdSet() {
        const s = new Set();
        (myTutorialProjectList || []).forEach(p => {
            if (!p) return;
            if (!p.is_tutorial_instance) return;
            if (!p.original_master_id) return;
            s.add(String(p.original_master_id));
        });
        return s;
    }

    function chapterGateReport(chap) {
        const missing = [];
        let openedCount = 0;
        let totalCount = 0;

        const vids = chap?.videos || [];
        const projs = chap?.projects || [];

        const started = startedMasterIdSet();

        vids.forEach(v => {
            if (!v || !v.url) return;
            totalCount++;
            if (isVideoOpened(v.url)) openedCount++;
            else missing.push(`Video: ${v.title || v.url}`);
        });

        projs.forEach(p => {
            if (!p || !p.id) return;
            totalCount++;
            if (started.has(String(p.id))) openedCount++;
            else missing.push(`Project: ${p.name || p.id}`);
        });

        return { missing, openedCount, totalCount };
    }

    function renderChapterProgressPill(chap) {
        const pill = document.getElementById('chapProgress');
        if (!pill) return;

        const rep = chapterGateReport(chap);
        if (rep.totalCount <= 0) {
            pill.textContent = 'Ready';
            pill.style.background = '#e6f4ea';
            pill.style.color = '#137333';
            return;
        }

        const pct = Math.round((rep.openedCount / rep.totalCount) * 100);
        pill.textContent = `${pct}% Opened (${rep.openedCount}/${rep.totalCount})`;

        if (pct >= 100) {
            pill.style.background = '#e6f4ea';
            pill.style.color = '#137333';
        } else {
            pill.style.background = '#e8f0fe';
            pill.style.color = '#1a73e8';
        }
    }

    async function fetchTutorials() {
        const fd = new FormData(); fd.append('action', 'fetch_curriculum');
        const res = await fetch('server.php', {method:'POST', body:fd});
        const data = await res.json();
        curriculum = data.curriculum;
        progress = data.progress;

        normalizeCurriculumAndProgress();
        renderChapters();
    }

    function renderChapters() {
        const grid = document.getElementById('chapterGrid');
        grid.innerHTML = '';
        showChapterGrid();

        curriculum.chapters.forEach((chap, idx) => {
            const num = idx + 1;
            const locked = num > progress.current_chapter;
            const opacity = locked ? '0.6' : '1';
            const icon = locked ? '<i class="fas fa-lock"></i>' : '<i class="fas fa-book-open"></i>';
            const status = locked ? 'Locked' : (num < progress.current_chapter ? 'Completed' : 'In Progress');
            const statusColor = locked ? '#999' : (num < progress.current_chapter ? '#34a853' : '#1a73e8');

            const desc = (chap.description || '').trim();

            const div = document.createElement('div');
            div.className = 'tile';
            div.style.opacity = opacity;
            div.style.pointerEvents = locked ? 'none' : 'auto';
            div.innerHTML = `
                <div class="tile-thumb" style="display:flex; align-items:center; justify-content:center; background:#f8f9fa; color:#ccc; font-size:40px;">
                    ${icon}
                </div>
                <div class="tile-content">
                    <div class="tile-addr">Chapter ${num}: ${escapeHtml(chap.title || '')}</div>
                    <div class="tile-meta">
                        ${desc ? `<div class="chap-desc">${escapeHtml(desc)}</div>` : `<div class="chap-desc" style="color:#aaa; font-style:italic;">No description</div>`}
                        <span style="color:${statusColor}; font-weight:bold;">${status}</span>
                    </div>
                </div>
            `;
            if(!locked) div.onclick = () => openChapter(idx);
            grid.appendChild(div);
        });
    }

    async function openChapter(idx) {
        currentChapIdx = idx;
        const chap = curriculum.chapters[idx];

        document.getElementById('chapterGrid').style.display = 'none';
        const detail = document.getElementById('chapterDetail');
        detail.style.display = 'block';

        document.getElementById('chapTitle').innerText = `Chapter ${idx+1}: ${chap.title}`;

        // NEW: description card
        const descCard = document.getElementById('chapDescCard');
        const d = (chap.description || '').trim();
        if (descCard) {
            if (d) {
                descCard.style.display = 'block';
                descCard.textContent = d;
            } else {
                descCard.style.display = 'none';
                descCard.textContent = '';
            }
        }

        // VIDEOS
        const resList = document.getElementById('resList');
        resList.innerHTML = '';
        (chap.videos || []).forEach(vid => {
            const done = isVideoOpened(vid.url);
            resList.innerHTML += `
                <a href="${vid.url}" target="_blank" class="res-item" data-video-url="${escapeHtml(vid.url)}" onclick="markVideo('${vid.url.replace(/'/g, "\\'")}');">
                    <div class="res-icon"><i class="fas fa-play-circle"></i></div>
                    <div style="flex:1;">
                        <strong>${escapeHtml(vid.title || vid.url)}</strong><br>
                        <span style="font-size:11px; color:#777;">Video Guide</span>
                    </div>
                    <i class="fas fa-check-circle check-icon" style="${done ? '' : 'display:none;'}"></i>
                </a>`;
        });
        if(resList.innerHTML === '') resList.innerHTML = '<div style="color:#999; font-style:italic;">No videos.</div>';

        // GUIDES
        const guideList = document.getElementById('guideList');
        guideList.innerHTML = '';
        if(chap.pdfs && chap.pdfs.length > 0) {
            chap.pdfs.forEach(pdf => {
                guideList.innerHTML += `
                    <a href="${pdf.url}" target="_blank" class="res-item">
                        <div class="res-icon"><i class="fas fa-file-pdf"></i></div>
                        <div style="flex:1;">
                            <strong>${escapeHtml(pdf.title || pdf.url)}</strong><br>
                            <span style="font-size:11px; color:#777;">Reference Guide</span>
                        </div>
                    </a>`;
            });
        }
        if(guideList.innerHTML === '') guideList.innerHTML = '<div style="color:#999; font-style:italic;">No guides.</div>';

        // PROJECTS
        const projList = document.getElementById('projList');
        projList.innerHTML = '';

        (chap.projects || []).forEach(p => {
            const existingInstance = (myTutorialProjectList || []).find(proj => String(proj.original_master_id) === String(p.id));

            let btnAction = () => startTutorialProject(p.id);
            let btnText = "Start Project";
            let statusText = "Click to Open Workspace";
            let btnClass = "btn-secondary";
            let statusStyle = '#777';

            if (existingInstance) {
                btnAction = () => directOpen(existingInstance.id);
                btnText = "Resume Work";
                statusText = "Saved Progress Available";
                btnClass = "btn-primary";
                statusStyle = '#34a853';
            }

            const wrap = document.createElement('div');
            wrap.className = 'tile';
            wrap.style.display = 'flex';
            wrap.style.flexDirection = 'row';
            wrap.style.alignItems = 'center';
            wrap.onclick = btnAction;

            wrap.innerHTML = `
                <div style="width:100px; height:100px; background:#eee; position:relative;">
                    <img src="tutorials/master/${p.id}/google.png" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'">
                </div>
                <div class="tile-content" style="padding:15px;">
                    <div class="tile-addr">${escapeHtml(p.name || '')}</div>
                    <div class="tile-meta" style="color:${statusStyle}; font-weight:bold;">${escapeHtml(statusText)}</div>
                    <button class="${btnClass}" style="font-size:11px; padding:4px 8px; margin-top:5px;" onclick="event.stopPropagation(); (${btnAction.toString()})();">${escapeHtml(btnText)}</button>
                </div>
            `;
            projList.appendChild(wrap);
        });
        if(projList.innerHTML === '') projList.innerHTML = '<div style="color:#999; font-style:italic;">No projects.</div>';

        // Button label
        const btnNext = document.getElementById('btnNextChapter');
        if(idx === curriculum.chapters.length - 1) btnNext.innerHTML = 'Finish Course <i class="fas fa-flag-checkered"></i>';
        else btnNext.innerHTML = 'Next Chapter <i class="fas fa-arrow-right"></i>';

        // Progress pill
        renderChapterProgressPill(chap);
    }

    function showChapterGrid() {
        document.getElementById('chapterGrid').style.display = 'grid';
        document.getElementById('chapterDetail').style.display = 'none';
    }

    // NEW: Marking a video as "opened" immediately (no success popup)
    function markVideo(url) {
        // update local progress immediately so gating works instantly
        if (!isVideoOpened(url)) {
            progress.completed_videos.push({ url: url, date: new Date().toISOString() });
        }

        // update check icons + pill
        document.querySelectorAll('#resList [data-video-url]').forEach(a => {
            const u = a.getAttribute('data-video-url');
            const done = isVideoOpened(u);
            const icon = a.querySelector('.check-icon');
            if (icon) icon.style.display = done ? '' : 'none';
        });

        const chap = curriculum.chapters[currentChapIdx];
        renderChapterProgressPill(chap);

        // fire-and-forget to server
        const fd = new FormData();
        fd.append('action', 'update_progress');
        fd.append('type', 'video');
        fd.append('id', url);

        fetch('server.php', { method:'POST', body:fd, keepalive:true }).catch(() => {});
    }

    // NEW: Chapter completion gating (no popup if complete, popup only if missing)
    async function completeChapter() {
        const chap = curriculum.chapters[currentChapIdx];
        const rep = chapterGateReport(chap);

        if (rep.missing.length > 0) {
            alert(`You need to complete ${rep.missing.join(', ')} first.`);
            return;
        }

        const fd = new FormData();
        fd.append('action', 'update_progress');
        fd.append('type', 'chapter_complete');
        fd.append('id', currentChapIdx + 1);

        // no success popup
        await fetch('server.php', {method:'POST', body:fd});

        progress.current_chapter = Math.max(progress.current_chapter, currentChapIdx + 2);

        // Move forward quietly
        if(currentChapIdx < curriculum.chapters.length - 1) {
            renderChapters();
            await openChapter(currentChapIdx + 1);
        } else {
            // finished curriculum flow (does NOT set training_complete)
            renderChapters();
            showChapterGrid();
        }
    }

    async function startTutorialProject(masterId) {
        const fd = new FormData();
        fd.append('action', 'start_tutorial_project');
        fd.append('master_id', masterId);

        const res = await fetch('server.php', {method:'POST', body:fd});
        const data = await res.json();

        if(data.success) {
            localStorage.setItem('autoLoadProject', data.folder);
            window.location.href = 'editor.php';
        } else {
            alert("Error creating project instance: " + data.error);
        }
    }

    // --- STUDENT PROGRESS MANAGEMENT ---
    function openStudentProgress() {
        switchView('student-progress');
        fetchStudentList();
    }

    async function fetchStudentList() {
        const tbody = document.getElementById('studentTable');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px;">Loading...</td></tr>';

        const fd = new FormData(); fd.append('action', 'fetch_student_list');
        const res = await fetch('portal.php', {method:'POST', body:fd});
        const data = await res.json();

        tbody.innerHTML = '';
        if(!data.students || data.students.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No students found.</td></tr>';
            return;
        }

        data.students.forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><b>${escapeHtml(s.name||'')}</b></td>
                <td>${escapeHtml(s.email||'')}</td>
                <td>Chapter ${escapeHtml(s.current_chapter||1)}</td>
                <td style="text-align:right">
                    <button class="btn-secondary btn-sm" onclick="openStudentDetails('${String(s.email).replace(/'/g,"\\'")}', '${String(s.name).replace(/'/g,"\\'")}')">View Progress</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    async function openStudentDetails(email, name) {
        document.getElementById('stModalTitle').innerText = `Details for ${name}`;

        const fd = new FormData();
        fd.append('action', 'fetch_student_details');
        fd.append('email', email);

        const res = await fetch('portal.php', {method:'POST', body:fd});
        const data = await res.json();

        if(!data.success) return alert("Could not fetch details");

        document.getElementById('stCurrentChap').innerText = `Chapter ${data.progress.current_chapter}`;
        const vidList = document.getElementById('stVideoList');
        vidList.innerHTML = '';

        if(!data.progress.completed_videos || data.progress.completed_videos.length === 0) {
            vidList.innerHTML = '<div style="color:#999; font-style:italic;">No videos watched yet.</div>';
        } else {
            data.progress.completed_videos.forEach(item => {
                let url = '';
                let dateDisplay = '';

                if (typeof item === 'string') {
                    url = item;
                } else {
                    url = item.url;
                    if(item.date) {
                        dateDisplay = `<span style="font-size:10px; color:#888; display:block; margin-top:2px;">Watched: ${new Date(item.date).toLocaleString()}</span>`;
                    }
                }

                vidList.innerHTML += `
                    <div class="res-item">
                        <div class="res-icon"><i class="fas fa-play-circle"></i></div>
                        <div style="flex:1; overflow:hidden; text-overflow:ellipsis; font-size:12px;">
                            ${escapeHtml(url)}
                            ${dateDisplay}
                        </div>
                        <i class="fas fa-check-circle check-icon"></i>
                    </div>`;
            });
        }

        const projGrid = document.getElementById('stProjectGrid');
        projGrid.innerHTML = '';

        if(!data.projects || data.projects.length === 0) {
            projGrid.innerHTML = '<div style="grid-column:1/-1; color:#999; font-style:italic; padding:20px;">No projects started.</div>';
        } else {
            data.projects.forEach(p => {
                let statusColor = '#fbbc04';
                if(p.status === 'completed') statusColor = '#34a853';

                const div = document.createElement('div');
                div.className = 'tile';
                div.innerHTML = `
                    <div class="tile-thumb" style="height:120px;">
                        <img src="${p.thumbnail}" onerror="this.style.display='none'">
                        <div class="badge" style="background:${statusColor}">${escapeHtml(p.status||'')}</div>
                    </div>
                    <div class="tile-content" style="padding:10px;">
                        <div class="tile-addr" style="font-size:12px;">${escapeHtml(p.address||'')}</div>
                        <div style="display:flex; gap:5px; margin-top:10px;">
                            <button class="btn-primary" style="font-size:10px; flex:1;" onclick="directOpen('${p.id}')">Edit</button>
                            <button class="btn-secondary" style="font-size:10px;" onclick="openProjectModal('${p.id}')"><i class="fas fa-info-circle"></i></button>
                        </div>
                    </div>
                `;
                projGrid.appendChild(div);
            });
        }

        document.getElementById('studentModal').style.display = 'flex';
    }

    // --- ADMIN EDITOR LOGIC ---
    function openEditor() {
        currentEditorPage = 0;
        document.getElementById('editorModal').style.display = 'flex';
        renderEditor();
    }

    function renderEditor() {
        const container = document.getElementById('editorContent');
        const pagination = document.getElementById('paginationCtr');

        container.innerHTML = '';
        pagination.innerHTML = '';

        if(curriculum.chapters.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:40px; color:#999;">No chapters yet. Click "New Chapter".</div>';
            return;
        }

        const total = curriculum.chapters.length;
        if(currentEditorPage >= total) currentEditorPage = total - 1;

        let pHtml = `<div class="page-btn" onclick="if(currentEditorPage>0){currentEditorPage--; renderEditor();}"><i class="fas fa-chevron-left"></i></div>`;
        for(let i=0; i<total; i++) {
            pHtml += `<div class="page-btn ${i===currentEditorPage?'active':''}" onclick="currentEditorPage=${i}; renderEditor();">${i+1}</div>`;
        }
        pHtml += `<div class="page-btn" onclick="if(currentEditorPage<${total-1}){currentEditorPage++; renderEditor();}"><i class="fas fa-chevron-right"></i></div>`;
        pagination.innerHTML = pHtml;

        const chap = curriculum.chapters[currentEditorPage];
        if (typeof chap.description !== 'string') chap.description = '';
        if (!Array.isArray(chap.videos)) chap.videos = [];
        if (!Array.isArray(chap.pdfs)) chap.pdfs = [];
        if (!Array.isArray(chap.projects)) chap.projects = [];

        container.innerHTML = `
            <div class="chapter-editor-item">
                <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
                    <strong>Chapter ${currentEditorPage+1} of ${total}</strong>
                    <button class="btn-danger btn-sm" onclick="removeEditorChapter(${currentEditorPage})">Delete Chapter</button>
                </div>

                <div class="form-row">
                    <label>Chapter Title</label>
                    <input value="${escapeHtml(chap.title)}" onchange="curriculum.chapters[${currentEditorPage}].title = this.value">
                </div>

                <!-- NEW: Optional chapter description -->
                <div class="form-row">
                    <label>Chapter Description <span style="font-weight:normal; font-size:10px;">(Optional)</span></label>
                    <textarea rows="3" onchange="curriculum.chapters[${currentEditorPage}].description = this.value">${escapeHtml(chap.description || '')}</textarea>
                </div>

                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

                <div class="form-row">
                    <label>Videos</label>
                    <div id="videoList"></div>
                    <div class="resource-row">
                        <input id="newVidTitle" placeholder="Video Title">
                        <input id="newVidUrl" placeholder="Video URL (Vimeo/YouTube)">
                        <button class="btn-secondary btn-sm" onclick="addResource('videos')"><i class="fas fa-plus"></i></button>
                    </div>
                </div>

                <div class="form-row">
                    <label>Guides (PDFs)</label>
                    <div id="pdfList"></div>
                    <div class="resource-row">
                        <input id="newPdfTitle" placeholder="PDF Title">
                        <input id="newPdfUrl" placeholder="PDF URL">
                        <button class="btn-secondary btn-sm" onclick="addResource('pdfs')"><i class="fas fa-plus"></i></button>
                    </div>
                </div>

                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

                <div class="form-row">
                    <label>Projects (Master Templates)</label>
                    <div id="projEditorList"></div>
                    <div class="resource-row">
                        <input id="newProjTitle" placeholder="Project Name">
                        <input id="newProjAddr" placeholder="Type Address to Search..." class="maps-autocomplete">
                        <button class="btn-secondary btn-sm" onclick="addProjectToChapter()"><i class="fas fa-plus"></i> Add</button>
                    </div>
                    <div style="margin-top:10px; text-align:right;">
                        <button id="btnGenerateBatch" class="btn-secondary btn-sm" onclick="generatePendingProjects(${currentEditorPage})">
                            <i class="fas fa-magic"></i> Generate Pending Projects
                        </button>
                    </div>
                </div>
            </div>`;

        renderResourceList('videos', currentEditorPage);
        renderResourceList('pdfs', currentEditorPage);
        renderProjectList(currentEditorPage);

        attachAutocomplete();
    }

    function attachAutocomplete() {
        if(!window.google || !google.maps || !google.maps.places) return;

        const inputs = document.querySelectorAll('.maps-autocomplete');
        inputs.forEach(input => {
            if(input.getAttribute('data-init') === 'true') return;
            input.setAttribute('data-init', 'true');

            const autocomplete = new google.maps.places.Autocomplete(input);
            autocomplete.addListener('place_changed', () => {
                const place = autocomplete.getPlace();
                if(place.formatted_address) {
                    input.value = place.formatted_address;
                    input.dispatchEvent(new Event('change'));
                }
            });
        });
    }

    function renderResourceList(type, chapIdx) {
        const container = document.getElementById(type === 'videos' ? 'videoList' : 'pdfList');
        container.innerHTML = '';
        const items = curriculum.chapters[chapIdx][type] || [];

        items.forEach((item, idx) => {
            container.innerHTML += `
                <div class="resource-row">
                    <input value="${escapeHtml(item.title||'')}" onchange="updateResource('${type}', ${chapIdx}, ${idx}, 'title', this.value)">
                    <input value="${escapeHtml(item.url||'')}" onchange="updateResource('${type}', ${chapIdx}, ${idx}, 'url', this.value)">
                    <button class="btn-danger btn-sm" onclick="removeResource('${type}', ${chapIdx}, ${idx})"><i class="fas fa-trash"></i></button>
                </div>`;
        });
    }

    function renderProjectList(chapIdx) {
        const container = document.getElementById('projEditorList');
        container.innerHTML = '';
        const items = curriculum.chapters[chapIdx].projects || [];

        items.forEach((p, idx) => {
            const statusColor = p.id ? '#34a853' : '#fbbc04';
            const statusText = p.id ? 'Ready' : 'Pending Generation';
            const idVal = p.id || '';
            const isGenerated = !!p.id;

            const addrInput = isGenerated
                ? `<input value="${escapeHtml(p.address||'')}" readonly style="flex:2; background:#f9f9f9; color:#555;" title="Address">`
                : `<input value="${escapeHtml(p.address||'')}" class="maps-autocomplete" onchange="updateProject(${chapIdx}, ${idx}, 'address', this.value)" style="flex:2;" placeholder="Address">`;

            const editBtn = isGenerated
                ? `<button class="btn-secondary btn-sm" onclick="directOpen('${p.id}')" title="Edit Master Template"><i class="fas fa-edit"></i></button>`
                : '';

            container.innerHTML += `
                <div class="resource-row" id="proj-row-${idx}">
                    <input value="${escapeHtml(p.name||'')}" onchange="updateProject(${chapIdx}, ${idx}, 'name', this.value)" style="flex:1;">
                    ${addrInput}
                    <input value="${escapeHtml(idVal)}" readonly style="width:80px; font-size:10px; background:#eee; color:#777;" title="ID (Auto-filled)">
                    <div class="status" style="color:${statusColor}; font-weight:bold;">${statusText}</div>
                    ${editBtn}
                    <button class="btn-danger btn-sm" onclick="removeProject(${chapIdx}, ${idx})"><i class="fas fa-trash"></i></button>
                </div>`;
        });
    }

    function addResource(type) {
        const titleId = type === 'videos' ? 'newVidTitle' : 'newPdfTitle';
        const urlId = type === 'videos' ? 'newVidUrl' : 'newPdfUrl';
        const title = document.getElementById(titleId).value;
        const url = document.getElementById(urlId).value;
        if(!title || !url) return alert("Enter both title and URL");
        if(!curriculum.chapters[currentEditorPage][type]) curriculum.chapters[currentEditorPage][type] = [];
        curriculum.chapters[currentEditorPage][type].push({ title, url });
        renderEditor();
    }

    function removeResource(type, chapIdx, itemIdx) {
        curriculum.chapters[chapIdx][type].splice(itemIdx, 1);
        renderEditor();
    }

    function updateResource(type, chapIdx, itemIdx, field, val) {
        curriculum.chapters[chapIdx][type][itemIdx][field] = val;
    }

    function addProjectToChapter() {
        const name = document.getElementById('newProjTitle').value;
        const addr = document.getElementById('newProjAddr').value;
        if(!name || !addr) return alert("Enter Project Name and Address");
        curriculum.chapters[currentEditorPage].projects.push({ name: name, address: addr, id: "" });
        renderEditor();
    }

    function updateProject(chapIdx, itemIdx, field, val) {
        curriculum.chapters[chapIdx].projects[itemIdx][field] = val;
    }

    function removeProject(chapIdx, itemIdx) {
        curriculum.chapters[chapIdx].projects.splice(itemIdx, 1);
        renderEditor();
    }

    async function generatePendingProjects(chapIdx) {
        const projects = curriculum.chapters[chapIdx].projects;
        const pendingIndices = [];
        projects.forEach((p, idx) => { if(!p.id || p.id === "") pendingIndices.push(idx); });

        if(pendingIndices.length === 0) return alert("All projects already generated!");
        const btn = document.getElementById('btnGenerateBatch');
        btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Processing...';

        for (const idx of pendingIndices) {
            const p = projects[idx];
            const row = document.getElementById(`proj-row-${idx}`);
            const statusDiv = row.querySelector('.status');
            statusDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working...';
            statusDiv.style.color = '#1a73e8';

            try {
                const fd = new FormData();
                fd.append('action', 'create_master_project');
                fd.append('address', p.address);
                const res = await fetch('server.php', { method: 'POST', body: fd });
                const data = await res.json();
                if (data.success) {
                    p.id = data.folder;
                    statusDiv.innerHTML = '<i class="fas fa-check"></i> Done';
                    statusDiv.style.color = '#34a853';
                    row.querySelector('input[readonly]').value = data.folder;
                } else {
                    statusDiv.innerText = 'Failed'; statusDiv.style.color = 'red';
                }
            } catch (e) {
                statusDiv.innerText = 'Error'; statusDiv.style.color = 'red';
            }
        }
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-magic"></i> Generate Pending Projects';
        await saveCurriculum(true);
        alert("Batch processing complete and Saved!");
        renderEditor();
    }

    function addEditorChapter() {
        curriculum.chapters.push({ title: "New Chapter", description: "", videos: [], projects: [], pdfs: [] });
        currentEditorPage = curriculum.chapters.length - 1;
        renderEditor();
    }

    function removeEditorChapter(idx) {
        if(confirm("Delete this chapter?")) {
            curriculum.chapters.splice(idx, 1);
            currentEditorPage = Math.max(0, currentEditorPage - 1);
            renderEditor();
        }
    }

    async function saveCurriculum(silent = false) {
        const fd = new FormData();
        fd.append('action', 'save_curriculum');
        fd.append('curriculum', JSON.stringify(curriculum, null, 2));
        await fetch('server.php', {method:'POST', body:fd});
        if(!silent) {
            alert("Curriculum Saved");
            closeModal('editorModal');
            fetchTutorials();
        }
    }

    // --- USERS LOGIC ---
    async function fetchUsers() {
        const res = await fetch('portal.php',{method:'POST', body:new URLSearchParams({action:'fetch_users'})});
        const data = await res.json();
        const tb = document.getElementById('usersTable');
        tb.innerHTML = '';
        if(data.users) data.users.forEach(u => {
            const trainedPill = u.training_complete
                ? `<span class="user-pill" style="background:#e6f4ea; color:#137333; margin-left:6px;">Trained</span>`
                : `<span class="user-pill" style="background:#fce8e6; color:#b0261e; margin-left:6px;">Untrained</span>`;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><b>${escapeHtml(u.name||'-')}</b></td>
                <td>${escapeHtml(u.email||'-')}</td>
                <td>
                    <span class="user-pill">${escapeHtml(u.role||'user')}</span>
                    ${trainedPill}
                </td>
                <td>${escapeHtml(u.team_id||'default')}</td>
                <td style="text-align:right">
                    <button class="btn-secondary btn-sm" onclick='openUserModal("edit", ${JSON.stringify(u)})'>Edit</button>
                </td>
            `;
            tb.appendChild(tr);
        });
    }

    function openUserModal(mode, user=null) {
        document.getElementById('uModalTitle').innerText = mode==='create' ? 'Create User' : 'Edit Permissions';
        document.getElementById('uMode').value = mode;
        document.getElementById('uEmail').value = '';
        document.getElementById('uName').value = '';
        document.getElementById('uPass').value = '';
        document.getElementById('uTeam').value = 'default';
        document.getElementById('uComplexityPref').value = 'all';
        document.getElementById('uTrainingComplete').checked = false;

        document.querySelectorAll('.perm-item input').forEach(c => c.checked=false);
        document.getElementById('btnDeleteUser').style.display = 'none';
        document.getElementById('uEmail').disabled = false;

        if(mode === 'create') {
            applyPreset('user');
        } else {
            document.getElementById('uEmail').value = user.email;
            document.getElementById('uEmail').disabled = true;
            document.getElementById('uName').value = user.name || '';
            document.getElementById('uTeam').value = user.team_id || 'default';
            document.getElementById('uComplexityPref').value = user.complexity_preference || 'all';
            document.getElementById('uRoleLabel').value = user.role || 'user';

            // NEW: training_complete
            document.getElementById('uTrainingComplete').checked = !!user.training_complete;

            const p = user.permissions || {};
            document.getElementById('p_view_all').checked = !!p.view_all_projects;
            document.getElementById('p_view_team').checked = !!p.view_team_projects;
            document.getElementById('p_manage_users').checked = !!p.manage_users;
            document.getElementById('p_create_users').checked = !!p.create_users;
            document.getElementById('p_assign_teams').checked = !!p.assign_teams;
            document.getElementById('p_manage_tutorials').checked = !!p.manage_tutorials;
            document.getElementById('p_admin_legacy').checked = !!p.is_admin_legacy;
            document.getElementById('p_manage_queue').checked = !!p.manage_queue;
            document.getElementById('p_manage_apple_key').checked = !!p.manage_apple_key;

            if(MY_PERMS.assign_teams) document.getElementById('btnDeleteUser').style.display = 'block';
        }
        document.getElementById('userModal').style.display = 'flex';
    }

    function applyPreset(role) {
        document.getElementById('uRoleLabel').value = role;
        const setC = (id, val) => document.getElementById(id).checked = val;
        document.querySelectorAll('.perm-item input').forEach(c => c.checked=false);

        if(role === 'admin') {
            document.querySelectorAll('.perm-item input').forEach(c => c.checked=true);
        } else if(role === 'lead') {
            setC('p_view_team', true);
            setC('p_manage_tutorials', true);
        }
    }

    async function saveUser() {
        const perms = {
            view_all_projects: document.getElementById('p_view_all').checked,
            view_team_projects: document.getElementById('p_view_team').checked,
            manage_users: document.getElementById('p_manage_users').checked,
            create_users: document.getElementById('p_create_users').checked,
            assign_teams: document.getElementById('p_assign_teams').checked,
            manage_tutorials: document.getElementById('p_manage_tutorials').checked,
            is_admin_legacy: document.getElementById('p_admin_legacy').checked,
            manage_queue: document.getElementById('p_manage_queue').checked,
            manage_apple_key: document.getElementById('p_manage_apple_key').checked
        };

        const fd = new FormData();
        fd.append('action', 'save_user');
        fd.append('mode', document.getElementById('uMode').value);
        fd.append('email', document.getElementById('uEmail').value);
        fd.append('name', document.getElementById('uName').value);
        fd.append('password', document.getElementById('uPass').value);
        fd.append('team', document.getElementById('uTeam').value);
        fd.append('complexity_preference', document.getElementById('uComplexityPref').value);
        fd.append('role', document.getElementById('uRoleLabel').value);
        fd.append('permissions', JSON.stringify(perms));

        // NEW: training_complete
        fd.append('training_complete', document.getElementById('uTrainingComplete').checked ? '1' : '0');

        const res = await fetch('portal.php',{method:'POST', body:fd});
        const data = await res.json();

        if(data.success) {
            closeModal('userModal');
            fetchUsers();
        } else {
            alert(data.error || 'Save failed');
        }
    }

    async function deleteUser() {
        if(!confirm("Are you sure you want to delete this user?")) return;
        const fd = new FormData();
        fd.append('action', 'delete_user');
        fd.append('email', document.getElementById('uEmail').value);
        const res = await fetch('portal.php', {method:'POST', body:fd});
        const data = await res.json();
        if(data.success) { closeModal('userModal'); fetchUsers(); }
        else alert("Delete failed");
    }
</script>
</body>
</html>
