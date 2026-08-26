<?php
require_once __DIR__ . '/_storage.php';
require_once dirname(__DIR__, 2) . '/includes/provider_keys.php';
/* backend.php - Secured Version */
session_start();
require_once __DIR__ . '/firstmeasure_node.php';
require_once __DIR__ . '/_tutorials.php';
require_once __DIR__ . '/_permission_options.php';

$GOOGLE_BROWSER_API_KEY = fm_google_provider_key('browser_internal');
$AZURE_MAPS_SUBSCRIPTION_KEY = fm_azure_maps_provider_key();

function fm_editor_internal_base_url() {
    $base = rtrim((string)fm_api_base_url(), '/');
    $internal = preg_replace('#/firstmeasure/?$#', '/internal', $base);
    if (is_string($internal) && $internal !== '' && $internal !== $base) return $internal;
    return rtrim($base, '/') . '/../internal';
}

function fm_editor_node_internal_user($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('curl_init')) return null;
    $headers = [
        'Accept: application/json',
        'X-Internal-User-Email: ' . strtolower(trim((string)($_SESSION['user_email'] ?? $email))),
    ];
    if (!empty($_SESSION['user_name'])) $headers[] = 'X-Internal-User-Name: ' . (string)$_SESSION['user_name'];
    $ch = curl_init(rtrim(fm_editor_internal_base_url(), '/') . '/users/' . rawurlencode($email));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status < 200 || $status >= 300 || !is_string($raw) || $raw === '') return null;
    $data = json_decode($raw, true);
    return is_array($data['user'] ?? null) ? $data['user'] : null;
}

function fm_editor_user_permissions($email) {
    $user = fm_editor_node_internal_user($email);
    if (!is_array($user)) return [];
    $permissions = permissionOptionsNormalizePermissions($user['permissions'] ?? [], $user['role'] ?? 'user');
    if (!empty($user['is_admin']) || strtolower(trim((string)($user['role'] ?? ''))) === 'admin') {
        $permissions['manage_tutorials'] = true;
    }
    return $permissions;
}

function fm_editor_tutorial_find_project_owner_email($tutorialId, $courseId) {
    $tutorialId = fm_tutorial_sanitize_project_id($tutorialId);
    if (!fm_tutorial_is_tutorial_project_id($tutorialId)) return '';

    $usersRoot = storagePath('tutorials/users');
    if (!is_dir($usersRoot)) return '';

    $courseId = (string)$courseId;
    $preferredCourses = [];
    if ($courseId !== '') $preferredCourses[] = $courseId;
    $preferredCourses[] = 'default';

    foreach (scandir($usersRoot) ?: [] as $safeUser) {
        if ($safeUser === '.' || $safeUser === '..') continue;
        $coursesRoot = $usersRoot . '/' . $safeUser . '/courses';
        if (!is_dir($coursesRoot)) continue;

        $courses = $preferredCourses;
        foreach (scandir($coursesRoot) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            if (is_dir($coursesRoot . '/' . $entry)) $courses[] = $entry;
        }
        $courses = array_values(array_unique($courses));

        foreach ($courses as $cid) {
            $manifestFile = $coursesRoot . '/' . $cid . '/projects/' . $tutorialId . '/manifest.json';
            if (!is_file($manifestFile)) continue;
            $manifest = json_decode((string)@file_get_contents($manifestFile), true);
            if (is_array($manifest) && ($manifest['id'] ?? '') === $tutorialId) {
                return (string)$safeUser;
            }
        }
    }

    return '';
}

function fm_editor_tutorial_request_user_email($sessionEmail, $tutorialId = '', $courseId = '') {
    $sessionEmail = strtolower(trim((string)$sessionEmail));
    $requestedEmail = strtolower(trim((string)($_GET['student_email'] ?? $_POST['student_email'] ?? $_GET['email'] ?? $_POST['email'] ?? '')));
    if ($requestedEmail === $sessionEmail) return $sessionEmail;

    $perms = fm_editor_user_permissions($sessionEmail);
    if (!empty($perms['manage_tutorials'])) {
        if ($requestedEmail !== '') return $requestedEmail;
        $ownerEmail = fm_editor_tutorial_find_project_owner_email($tutorialId, $courseId);
        if ($ownerEmail !== '') return $ownerEmail;
    }

    if ($requestedEmail === '') return $sessionEmail;

    header('Content-Type: application/json');
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Unauthorized']);
    exit;
}

// --- 1. LOGIN CHECK ---
// If the user email session is not set, redirect to the login page immediately.
$editorAction = strtolower(trim((string)($_GET['action'] ?? $_POST['action'] ?? '')));
if (!isset($_SESSION['user_email'])) {
    if ($editorAction === 'project_bundle' || strpos($editorAction, 'tutorial_project_') === 0) {
        header('Content-Type: application/json');
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Unauthorized']);
        exit;
    }
    header("Location: backend_login.php");
    exit;
}

if (strpos($editorAction, 'tutorial_project_') === 0) {
    $courseId = fm_tutorial_course_id_from_request();
    $tutorialId = fm_tutorial_sanitize_project_id($_GET['tutorial_id'] ?? $_POST['tutorial_id'] ?? $_GET['folder'] ?? $_POST['folder'] ?? '');
    $userEmail = fm_editor_tutorial_request_user_email($_SESSION['user_email'] ?? '', $tutorialId, $courseId);

    if (!fm_tutorial_is_tutorial_project_id($tutorialId)) {
        header('Content-Type: application/json');
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid tutorial project ID']);
        exit;
    }

    if ($editorAction === 'tutorial_project_artifact') {
        $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
        $name = fm_tutorial_sanitize_file_name($_GET['name'] ?? '');
        $path = $found ? ($found['dir'] . 'artifacts/' . $name) : '';
        if (!$found || $name === '' || !is_file($path)) {
            http_response_code(404);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Not found';
            exit;
        }
        $mime = function_exists('mime_content_type') ? (mime_content_type($path) ?: 'application/octet-stream') : 'application/octet-stream';
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($path));
        header('Cache-Control: no-store');
        readfile($path);
        exit;
    }

    header('Content-Type: application/json');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

    if ($editorAction === 'tutorial_project_bundle') {
        $viewerPermissions = fm_editor_user_permissions($_SESSION['user_email'] ?? '');
        $allowLockedTutorial = !empty($viewerPermissions['manage_tutorials']);
        $bundle = fm_tutorial_fetch_editor_bundle($tutorialId, $userEmail, $courseId, $allowLockedTutorial);
        if (!$bundle) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Tutorial project not found']);
            exit;
        }
        echo json_encode(['success' => true, 'ok' => true] + $bundle);
        exit;
    }

    if ($editorAction === 'tutorial_project_pdf_state') {
        $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
        if (!$found) {
            http_response_code(404);
            echo json_encode(null);
            exit;
        }
        echo json_encode(fm_tutorial_read_json_file($found['dir'] . 'pdf_state.json', null));
        exit;
    }

    if ($editorAction === 'tutorial_project_save') {
        echo json_encode(fm_tutorial_handle_save_request($tutorialId, $userEmail, $courseId));
        exit;
    }

    if ($editorAction === 'tutorial_project_artifacts') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
            echo json_encode([
                'success' => true,
                'artifacts' => $found ? fm_tutorial_list_artifacts($found['course_id'], $userEmail, $tutorialId) : []
            ]);
            exit;
        }

        $body = fm_tutorial_parse_request_body();
        if (isset($body['file_name']) && array_key_exists('content_text', $body)) {
            echo json_encode(fm_tutorial_store_text_artifact($tutorialId, $userEmail, $body['file_name'], $body['content_text'], $courseId));
            exit;
        }

        $file = null;
        foreach ($_FILES as $candidate) {
            if (is_array($candidate)) { $file = $candidate; break; }
        }
        echo json_encode($file ? fm_tutorial_store_uploaded_file($tutorialId, $userEmail, $file, $courseId) : ['success' => false, 'error' => 'No file uploaded']);
        exit;
    }

    if ($editorAction === 'tutorial_project_status') {
        $body = fm_tutorial_parse_request_body();
        $status = $body['status'] ?? $_POST['status'] ?? 'completed';
        $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
        if ($found && (($found['manifest']['tutorial_kind'] ?? '') === 'draft_reject' || !empty($found['manifest']['draft_reject_attempt_id']))) {
            $manifest = $found['manifest'];
            $manifest['draft_reject_decision'] = fm_tutorial_normalize_decision($body['decision'] ?? $body['draft_reject_decision'] ?? $_POST['decision'] ?? $status);
            $manifest['draft_reject_rejection_reason'] = trim((string)($body['rejection_reason'] ?? $body['draft_reject_rejection_reason'] ?? $_POST['rejection_reason'] ?? ''));
            $manifest['draft_reject_answered_at'] = gmdate('c');
            fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest);
        }
        echo json_encode(fm_tutorial_mark_project_complete($tutorialId, $userEmail, $courseId, $status === 'rejected' ? 'completed' : $status));
        exit;
    }

    if ($editorAction === 'tutorial_project_patch') {
        $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
        if (!$found) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Tutorial project not found']);
            exit;
        }
        $body = fm_tutorial_parse_request_body();
        $manifest = array_merge($found['manifest'], is_array($body) ? $body : []);
        $manifest['id'] = $tutorialId;
        $manifest['is_tutorial_instance'] = true;
        $manifest['tutorial_mode'] = true;
        $manifest['updated_at'] = gmdate('c');
        fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest);
        echo json_encode(['success' => true, 'manifest' => $manifest, 'project' => $manifest]);
        exit;
    }

    if ($editorAction === 'tutorial_project_pdfs_generate') {
        http_response_code(501);
        echo json_encode(['success' => false, 'error' => 'Tutorial projects do not generate production PDFs.']);
        exit;
    }

    http_response_code(404);
    echo json_encode(['success' => false, 'error' => 'Unknown tutorial editor action']);
    exit;
}

function fm_editor_node_v1_base_url() {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function fm_editor_internal_user() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $cached = [];
    $email = fm_norm_email($_SESSION['user_email'] ?? '');
    if ($email === '' || !function_exists('curl_init')) return $cached;

    $url = rtrim(fm_editor_node_v1_base_url(), '/') . '/internal/me';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPGET => true,
        CURLOPT_HTTPHEADER => [
            'Accept: application/json',
            'X-Internal-User-Email: ' . $email,
            'X-Internal-User-Name: ' . (string)($_SESSION['user_name'] ?? ''),
            'X-Internal-User-Role: ' . (string)($_SESSION['user_role'] ?? ($_SESSION['role'] ?? '')),
        ],
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => 8,
    ]);
    $raw = curl_exec($ch);
    curl_close($ch);
    $decoded = is_string($raw) ? json_decode($raw, true) : null;
    if (is_array($decoded) && is_array($decoded['user'] ?? null)) {
        $cached = $decoded['user'];
    }
    return $cached;
}

function fm_editor_can_view_qa_identity() {
    $email = fm_norm_email($_SESSION['user_email'] ?? '');
    if ($email === '') return false;
    if (!empty($_SESSION['user_is_admin'])) return true;
    $user = fm_editor_internal_user();
    $role = strtolower(trim((string)($user['role'] ?? $_SESSION['user_role'] ?? $_SESSION['role'] ?? '')));
    $perms = is_array($user['permissions'] ?? null) ? $user['permissions'] : [];
    if (!empty($user['is_admin'])) return true;

    if (in_array($role, ['admin', 'manager', 'qa'], true)) return true;
    return !empty($perms['manage_qa'])
        || !empty($perms['manage_qa_queue'])
        || !empty($perms['manage_queue'])
        || !empty($perms['is_admin_legacy']);
}

function fm_editor_scrub_history_actor_fields(&$event) {
    if (!is_array($event)) return;
    foreach ([
        'qa_email', 'qa_name',
        'qa_reviewer_email', 'qa_reviewer_name',
        'reviewer_email', 'reviewer_name',
        'reviewed_by_email', 'reviewed_by_name',
        'inspector', 'inspector_name',
        'by_email', 'by_name',
        'user_email', 'user_name',
        'actor_email', 'actor_name',
    ] as $key) {
        if (array_key_exists($key, $event)) $event[$key] = null;
    }
}

function fm_editor_blind_qa_threads(&$value) {
    if (!is_array($value)) return;

    $role = strtolower(trim((string)($value['role'] ?? '')));
    if ($role === 'qa' || $role === 'manager') {
        if (array_key_exists('by', $value)) $value['by'] = null;
        if (array_key_exists('by_email', $value)) $value['by_email'] = null;
        if (array_key_exists('email', $value)) $value['email'] = null;
        $label = $role === 'manager' ? 'Manager' : 'QA';
        if (array_key_exists('by_name', $value)) $value['by_name'] = $label;
        if (array_key_exists('name', $value)) $value['name'] = $label;
    }

    foreach ($value as &$child) {
        if (is_array($child)) fm_editor_blind_qa_threads($child);
    }
    unset($child);
}

function fm_editor_blind_qa_identity_payload($value) {
    if (!is_array($value)) return $value;

    $qaIdentityKeys = [
        'qa_claimed_by_email', 'qa_claimed_by_name',
        'qa_approved_by_email', 'qa_approved_by_name', 'qa_approved_by',
        'qa_reviewed_by_email', 'qa_reviewed_by_name', 'qa_reviewed_by',
        'qa_reviewer_email', 'qa_reviewer_name',
        'reviewer_email', 'reviewer_name',
        'reviewed_by_email', 'reviewed_by_name',
        'rejected_by_email', 'rejected_by_name',
        'reopened_by_email', 'reopened_by_name',
        'previous_qa_approved_by', 'previous_qa_approved_by_name',
        'manager_audit_updated_by_email', 'manager_audit_updated_by_name',
        'manager_audit_reviewed_by_email', 'manager_audit_reviewed_by_name',
        'manager_audit_flagged_by_email', 'manager_audit_flagged_by_name',
        'complexity_updated_by_email', 'complexity_updated_by_name',
    ];

    $walk = function (&$node) use (&$walk, $qaIdentityKeys) {
        if (!is_array($node)) return;

        $role = strtolower(trim((string)($node['role'] ?? '')));
        if ($role === 'qa' || $role === 'manager') {
            if (array_key_exists('by', $node)) $node['by'] = null;
            if (array_key_exists('by_email', $node)) $node['by_email'] = null;
            if (array_key_exists('email', $node)) $node['email'] = null;
            $label = $role === 'manager' ? 'Manager' : 'QA';
            if (array_key_exists('by_name', $node)) $node['by_name'] = $label;
            if (array_key_exists('name', $node)) $node['name'] = $label;
        }

        foreach ($qaIdentityKeys as $key) {
            if (array_key_exists($key, $node)) $node[$key] = null;
        }

        foreach (['work_history', 'qa_history', 'history'] as $historyKey) {
            if (!empty($node[$historyKey]) && is_array($node[$historyKey])) {
                foreach ($node[$historyKey] as &$event) {
                    fm_editor_scrub_history_actor_fields($event);
                }
                unset($event);
            }
        }

        if (isset($node['workflow']) && is_array($node['workflow'])) {
            foreach (['qa_claim'] as $key) {
                if (isset($node['workflow'][$key]) && is_array($node['workflow'][$key])) {
                    foreach (['email', 'name', 'id', 'claimed_by_email', 'claimed_by_name'] as $field) {
                        if (array_key_exists($field, $node['workflow'][$key])) $node['workflow'][$key][$field] = null;
                    }
                }
            }
        }

        foreach ($node as &$child) {
            if (is_array($child)) $walk($child);
        }
        unset($child);
    };

    $walk($value);
    return $value;
}

function fm_editor_json_response($payload, $statusCode = 200) {
    if (!headers_sent()) {
        header('Content-Type: application/json');
    }
    http_response_code((int)$statusCode);
    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) {
        error_log('editor project_bundle json_encode failed: ' . json_last_error_msg());
        http_response_code(500);
        echo '{"success":false,"error":"Project data could not be encoded."}';
        return;
    }
    echo $json;
}

if ($editorAction === 'project_bundle') {
    $rawProjectId = trim((string)($_GET['folder'] ?? $_POST['folder'] ?? ''));
    if (fm_tutorial_is_tutorial_project_id($rawProjectId)) {
        fm_editor_json_response(['success' => false, 'error' => 'Tutorial projects must be opened in tutorial mode.'], 403);
        exit;
    }
    $projectId = preg_replace('/[^a-f0-9]/', '', strtolower($rawProjectId));
    if ($projectId === '') {
        fm_editor_json_response(['success' => false, 'error' => 'Missing folder'], 400);
        exit;
    }

    try {
        $bundle = function_exists('fm_fetch_project_bundle') ? fm_fetch_project_bundle($projectId) : null;
        if (!is_array($bundle)) {
            fm_editor_json_response(['success' => false, 'error' => 'Project not found'], 404);
            exit;
        }

        if (!fm_editor_can_view_qa_identity()) {
            $bundle['manifest'] = fm_editor_blind_qa_identity_payload($bundle['manifest'] ?? null);
            $bundle['app_metadata'] = fm_editor_blind_qa_identity_payload($bundle['app_metadata'] ?? null);
            $bundle['pdf_state'] = fm_editor_blind_qa_identity_payload($bundle['pdf_state'] ?? null);
        }

        fm_editor_json_response([
            'success' => true,
            'folder' => $projectId,
            'manifest' => $bundle['manifest'] ?? null,
            'organization' => $bundle['organization'] ?? null,
            'app_metadata' => $bundle['app_metadata'] ?? null,
            'pdf_state' => $bundle['pdf_state'] ?? null,
            'pdf_state_asset' => $bundle['pdf_state_asset'] ?? null,
            'assets' => $bundle['assets'] ?? [],
            'insights' => $bundle['insights'] ?? null,
            'files' => $bundle['files'] ?? []
        ]);
    } catch (Throwable $e) {
        error_log('editor project_bundle failed for ' . $projectId . ': ' . $e->getMessage());
        fm_editor_json_response(['success' => false, 'error' => 'Project bundle failed to load.'], 500);
        exit;
    }
    exit;
}

$userName = $_SESSION['user_name'] ?? 'Guest User';
function fm_editor_asset_version($relativePath) {
    $path = __DIR__ . '/' . ltrim((string)$relativePath, '/');
    $mtime = is_file($path) ? @filemtime($path) : false;
    return $mtime ? (string)$mtime : '1';
}
function fm_editor_global_report_settings() {
    $path = storagePath('config/report_settings.json');
    $data = is_file($path) ? json_decode((string)@file_get_contents($path), true) : [];
    return is_array($data) ? $data : [];
}
$fmEditorGlobalReportSettings = fm_editor_global_report_settings();
$hideEditorHeader = filter_var(
    $_GET['hide_header'] ?? $_GET['hideHeader'] ?? $_GET['no_header'] ?? $_GET['embedded'] ?? false,
    FILTER_VALIDATE_BOOLEAN
);
$requestedFolder = trim((string)($_GET['folder'] ?? ''));
$isTutorialEditor = fm_tutorial_is_tutorial_project_id($requestedFolder) || filter_var($_GET['tutorial'] ?? false, FILTER_VALIDATE_BOOLEAN);
$tutorialCourseId = fm_tutorial_course_id_from_request();
$tutorialStudentEmail = strtolower(trim((string)($_GET['student_email'] ?? $_GET['email'] ?? '')));
?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>FirstMeasure</title>
    <!-- External Libraries -->
    <script src="https://cdn.jsdelivr.net/npm/geotiff"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js"></script>
    <script src="<?php
        $fmEditorHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        $fmEditorLocal = strpos($fmEditorHost, 'localhost') === 0 || strpos($fmEditorHost, '127.0.0.1') === 0;
        echo $fmEditorLocal
            ? 'http://127.0.0.1:3111/v1/firstmeasure/pdf-runtime/assets/jspdf'
            : '/v1/firstmeasure/pdf-runtime/assets/jspdf';
    ?>"></script>
    <!-- FontAwesome -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <!-- CesiumJS -->
    <script src="https://cesium.com/downloads/cesiumjs/releases/1.110/Build/Cesium/Cesium.js"></script>
    <link href="https://cesium.com/downloads/cesiumjs/releases/1.110/Build/Cesium/Widgets/widgets.css" rel="stylesheet">

<style>
    :root { --primary: #d93025; --success: #34a853; --warning: #fbbc04; --bg: #f0f2f5; }
    body {
        font-family: 'Segoe UI', Roboto, sans-serif;
        margin: 0; padding: 0;
        background: var(--bg); color: #333;
        height: 100vh; min-height: 100vh; display: flex; flex-direction: column; overflow: hidden; 
    }

    /* HEADER */
    header {
        display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 600px) minmax(532px, 1fr); align-items: center; gap: 20px;
        padding: 0 20px; border-bottom: 3px solid var(--primary);
        background: #fff; min-height: 70px; height: auto; box-shadow: 0 2px 5px rgba(0,0,0,0.05); z-index: 1000; flex: 0 0 auto; position: relative; overflow: visible;
    }
    header.editor-rush-active {
        border-bottom-color: #ea580c;
        background:
            linear-gradient(90deg, rgba(255, 126, 36, 0.48) 0%, rgba(255, 237, 213, 0.72) 22%, rgba(255,255,255,0.98) 48%),
            #fff;
    }
    .logo-area { display: flex; align-items: center; justify-self: start; gap:10px; font-weight:bold; color:var(--primary); font-size:18px;}
    .editor-rush-pill {
        position: relative;
        display: none;
        align-items: center;
        gap: 8px;
        min-height: 28px;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.72);
        background: #9a3412;
        color: #fff;
        font-size: 11px;
        font-weight: 950;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        box-shadow: 0 6px 18px rgba(154, 52, 18, 0.22);
        cursor: help;
        white-space: nowrap;
    }
    .editor-rush-pill:focus {
        outline: 2px solid rgba(234, 88, 12, 0.28);
        outline-offset: 3px;
    }
    .editor-rush-pill.active { display: inline-flex; }
    .editor-rush-countdown {
        font-family: "Segoe UI Mono", Consolas, monospace;
        letter-spacing: 0;
        color: #ffedd5;
        font-variant-numeric: tabular-nums;
    }
    .editor-rush-tooltip {
        position: absolute;
        top: calc(100% + 10px);
        left: 0;
        width: min(260px, 68vw);
        padding: 10px 11px;
        border-radius: 10px;
        border: 1px solid rgba(251, 146, 60, 0.55);
        background: #1f130b;
        color: #fff7ed;
        font-size: 11px;
        font-weight: 750;
        line-height: 1.4;
        letter-spacing: 0;
        text-transform: none;
        white-space: normal;
        box-shadow: 0 14px 30px rgba(154, 52, 18, 0.30);
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
        transition: opacity 0.16s ease, transform 0.16s ease;
        z-index: 1100;
    }
    .editor-rush-tooltip::before {
        content: '';
        position: absolute;
        top: -6px;
        left: 18px;
        width: 10px;
        height: 10px;
        background: #1f130b;
        border-left: 1px solid rgba(251, 146, 60, 0.55);
        border-top: 1px solid rgba(251, 146, 60, 0.55);
        transform: rotate(45deg);
    }
    .editor-rush-pill:hover .editor-rush-tooltip,
    .editor-rush-pill:focus .editor-rush-tooltip {
        opacity: 1;
        transform: translateY(0);
    }
    .editor-rush-toast {
        position: fixed;
        top: 84px;
        left: 18px;
        z-index: 3000;
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 10px 13px;
        border-radius: 10px;
        border: 1px solid #fb923c;
        background: #fff7ed;
        color: #9a3412;
        font-size: 13px;
        font-weight: 900;
        box-shadow: 0 12px 28px rgba(154, 52, 18, 0.22);
        opacity: 0;
        transform: translateY(-8px);
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease;
    }
    .editor-rush-toast.visible {
        opacity: 1;
        transform: translateY(0);
    }

    /* ADDRESS INPUT AREA */
    .address-bar-container { display: flex; gap: 10px; align-items: center; justify-self: center; width: 100%; max-width: 600px; min-width: 0; }
    .address-input { flex: 1; min-width: 0; padding: 10px 15px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; outline: none; transition: border-color 0.2s; }
    .address-input:focus { border-color: var(--primary); }
    .btn-analyze { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: background 0.2s; }
    .btn-analyze:hover { background: #b0261e; }
    .btn-analyze:disabled { background: #ccc; cursor: not-allowed; }
    .claim-status {
        justify-self: end;
        display: flex;
        align-items: center;
        gap: 16px;
    }
    .claim-timer {
        min-width: 120px;
        text-align: right;
        font-family: "Segoe UI Mono", Consolas, monospace;
        font-size: 17px;
        font-weight: 900;
        color: #202124;
        letter-spacing: 0;
        font-variant-numeric: tabular-nums;
    }
    .claim-timer.waiting { color: #777; }
    .claim-timer.zone-green { color: #188038; }
    .claim-timer.zone-yellow { color: #b06000; }
    .claim-timer.zone-orange { color: #b45309; }
    .claim-timer.zone-red { color: #a50e0e; }
    .claim-timer.zone-expired { color: #5f1b1b; }
    .claim-timeline {
        position: relative;
        width: 360px;
        height: 42px;
        display: none;
        flex: 0 0 360px;
        z-index: 1001;
    }
    .claim-timeline.active { display: block; }
    .claim-timeline-labels {
        position: absolute;
        left: 0;
        right: 0;
        top: 28px;
        height: 12px;
        font-size: 10px;
        font-weight: 800;
        color: #5f6368;
        font-variant-numeric: tabular-nums;
    }
    .claim-timeline-label {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        white-space: nowrap;
    }
    .claim-timeline-label:first-child { transform: none; }
    .claim-timeline-label:last-child { transform: translateX(-100%); }
    .claim-timeline-bar {
        position: absolute;
        left: 0;
        top: 12px;
        display: flex;
        width: 360px;
        height: 15px;
        overflow: hidden;
        border: 1px solid rgba(0,0,0,0.25);
        border-radius: 2px;
        background: #eee;
    }
    .claim-timeline-section { height: 100%; border-right: 1px solid rgba(255,255,255,0.95); }
    .claim-timeline-section:last-child { border-right: 0; }
    .claim-timeline-section.green { width: 120px; background: #34a853; }
    .claim-timeline-section.yellow { width: 60px; background: #fbbc04; }
    .claim-timeline-section.orange { width: 60px; background: #f29900; }
    .claim-timeline-section.red { width: 120px; background: #d93025; }
    .claim-timeline-marker {
        position: absolute;
        left: 0;
        top: 3px;
        width: 1px;
        height: 24px;
        background: #202124;
        transform: translate3d(-0.5px, 0, 0);
        will-change: transform;
        transition: none;
    }
    .claim-timeline-marker::before {
        content: "";
        position: absolute;
        left: -4px;
        top: -2px;
        width: 0;
        height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-top: 6px solid #202124;
    }
    .claim-timeline-tooltip {
        position: absolute;
        left: 0;
        top: 44px;
        min-width: 150px;
        padding: 8px 10px;
        border-radius: 6px;
        background: rgba(32,33,36,0.96);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.35;
        box-shadow: 0 6px 16px rgba(0,0,0,0.25);
        opacity: 0;
        pointer-events: none;
        transform: translate(-50%, 4px);
        transition: opacity 0.12s ease, transform 0.12s ease;
        z-index: 10000;
        white-space: nowrap;
    }
    .claim-timeline-tooltip.active {
        opacity: 1;
        transform: translate(-50%, 0);
    }
    .claim-timeline-tooltip-total {
        display: block;
        margin-top: 4px;
        font-size: 18px;
        font-weight: 900;
        line-height: 1.1;
    }

    /* WORKSPACE */
    .workspace { display: flex; flex: 1 1 auto; min-height: 0; height: auto; position: relative; }
    .left-column { width: 60%; display: flex; flex-direction: column; background: #fff; min-width: 300px; min-height: 0; position: relative; border-right:1px solid #ddd;}
    
    .tab-header { display: none; border-bottom: 1px solid #ddd; background: #f8f9fa; }
    .tab-btn { padding: 12px 20px; background: transparent; border: none; border-bottom: 3px solid transparent; color: #5f6368; cursor: pointer; font-weight: 600; font-size: 13px; }
    .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); background: #fff; }
    .tab-content { flex: 1; position: relative; overflow: hidden; display: none; }
    .tab-content.active { display: block; }
    #tab-view2d.active { display: flex; flex-direction: column; min-height: 0; }
    #structure-mode-bar {
        display: none;
        align-items: center;
        gap: 6px;
        height: 30px;
        min-height: 30px;
        padding: 3px 8px;
        border-bottom: 1px solid #d8dde6;
        background: #f8f9fa;
        overflow-x: auto;
        white-space: nowrap;
        box-sizing: border-box;
        z-index: 30;
    }
    .structure-mode-label {
        font-size: 11px;
        font-weight: 800;
        color: #3c4043;
        margin-right: 2px;
    }
    .structure-mode-btn {
        min-width: 28px;
        height: 22px;
        padding: 0 8px;
        border-radius: 4px;
        border: 1px solid #c8ced8;
        background: #fff;
        color: #3c4043;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
    }
    .structure-mode-btn.active {
        border-color: #1a73e8;
        box-shadow: 0 0 0 2px rgba(26,115,232,0.18);
    }
    .structure-status-done { background: #e6f4ea; border-color: #34a853; color: #137333; }
    .structure-status-missing { background: #fce8e6; border-color: #d93025; color: #a50e0e; }
    .structure-imagery-queued { opacity: .72; }
    .structure-imagery-loading { box-shadow: inset 0 -2px 0 #1a73e8; }
    .structure-imagery-ready { opacity: 1; }
    .structure-imagery-error { outline: 2px solid #d93025; outline-offset: 1px; }
    
    #viewport { width: 100%; height: 100%; flex: 1 1 auto; min-height: 0; overflow: hidden; position: relative; background: #202124; cursor: default; }
    #zoom-layer { position: absolute; top: 0; left: 0; transform-origin: 0 0; overflow: visible; }
    canvas { display: block; }
    
    #geoSvg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 20; overflow: visible; }
    .geo-line { fill: none; stroke-linecap: round; pointer-events: none; }
    .geo-point-group { pointer-events: auto; cursor: pointer; }
    
    /* RIGHT COLUMN & 3D/MAPS FIXES */
    .right-column { flex: 1 1 auto; display: flex; flex-direction: column; background: #111; min-width: 300px; min-height: 0; }
    .resizer { width: 5px; background: #ddd; cursor: col-resize; z-index: 10; }
    
    /* NEW: Vertical Resizer for Right Column */
    .resizer-vertical {
        height: 8px;
        background: #2a2a2a;
        cursor: row-resize;
        z-index: 10;
        border-top: 1px solid #444;
        border-bottom: 1px solid #444;
        flex-shrink: 0; /* Prevent it from collapsing */
        display: flex;
        align-items: center;
        justify-content: center;
    }
    /* Optional handle visual */
    .resizer-vertical::after {
        content: "";
        width: 30px;
        height: 2px;
        background: #666;
        border-radius: 1px;
    }
    .resizer-vertical:hover {
        background: #444;
    }
    .resizer-vertical:hover::after {
        background: #999;
    }


    /* 3D Wrapper */
    #three-view-wrapper {
        flex: 0 0 calc((100% - 8px) / 2);
        height: calc((100% - 8px) / 2);
        min-height: 0;
        position: relative; /* border-bottom removed */
    }
    #three-container { width: 100%; height: 100%; }
    .controls-3d-overlay { position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.6); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none; }
    .controls-3d-actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 10px; z-index: 10; }
    
    /* === MAPS WRAPPER FIXES === */
    #google-earth-wrapper { 
        flex: 1 1 0; 
        min-height: 0;
        position: relative; 
        background: #000; 
        overflow: hidden; 
        display: flex;       
        flex-direction: column;
    }
    
    #btnRecenterMap {
        position: absolute;
        bottom: 20px;
        right: 20px;
        z-index: 100;
        width: 40px;
        height: 40px;
        background: white;
        border: 1px solid #ccc;
        border-radius: 4px;
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #555;
        font-size: 18px;
        transition: background 0.2s;
    }

    #btnRecenterMap:hover {
        background: #f8f8f8;
        color: var(--primary);
    }

    .map-view-tabs { 
        position: absolute; 
        top: 10px; 
        left: 10px; 
        z-index: 100; 
        display: flex; 
        gap: 5px; 
    }
    
    .map-tab { 
        background: rgba(0,0,0,0.6); 
        color: #fff; 
        border: 1px solid rgba(255,255,255,0.3); 
        padding: 5px 10px; 
        border-radius: 4px; 
        cursor: pointer; 
        font-size: 11px; 
        font-weight: 600; 
    }
    .map-tab.active { background: var(--primary); border-color: var(--primary); }
    .map-tab:disabled,
    .toolbar-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }

    /* Force the map containers to fill the parent relative wrapper */
    #google-map-container, #google-js-map {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
    }

    #help-bar {
        background: #202124;
        color: #e8eaed;
        font-size: 11px;
        min-height: 30px;
        height: auto;
        max-height: 66px;
        display: none; /* Hidden by default */
        align-items: center;
        justify-content: center;
        align-content: center;
        column-gap: 12px;
        row-gap: 6px;
        flex-wrap: wrap;
        border-bottom: 1px solid #444;
        white-space: normal;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 6px 12px;
        box-sizing: border-box;
        width: 100%;
        z-index: 45; /* Below header, above workspace */
    }

    /* Scrollbar styling for the help bar if window is narrow */
    #help-bar::-webkit-scrollbar { height: 4px; }
    #help-bar::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }


    .shortcut-group {
        display: flex;
        align-items: center;
        gap: 4px;
        opacity: 0.9;
        flex: 0 0 auto;
        white-space: nowrap;
    }
    .shortcut-group:hover {
        opacity: 1;
        background: rgba(255,255,255,0.1);
    }


    .key-badge {
        background: #5f6368;
        border: 1px solid #80868b;
        border-radius: 3px;
        padding: 0px 4px;
        font-family: 'Roboto Mono', monospace;
        font-weight: bold;
        color: #fff;
        font-size: 10px;
        line-height: 14px;
    }

    .separator {
        flex: 0 0 auto;
        width: 1px;
        height: 16px;
        background: #555;
        margin: 0 2px;
    }

    /* TOOLBAR (Global) */
    #global-toolbar { background: #f8f9fa; display: flex; align-items: center; padding: 0 20px; gap: 15px; min-height: 50px; border-bottom: 3px solid #ccc; box-shadow: 0 2px 4px rgba(0,0,0,0.05); flex: 0 0 auto; }
    .toolbar-row, .toolbar-section { display: contents; }
    .controls-group { display: flex; align-items: center; gap: 8px; border-right: 1px solid #ddd; padding-right: 15px; height: 30px; flex-wrap: nowrap; }
    .controls-group:last-child { border-right: none; }
    .toolbar-btn { padding: 6px 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: pointer; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; white-space: nowrap; line-height: 1; min-height: 34px; box-sizing: border-box; }
    .toolbar-btn:hover { background: #eee; }
    .toolbar-btn.primary { background: var(--primary); color: white; border-color: var(--primary); }
    .toolbar-btn:disabled {
        background: #e5e7eb !important;
        border-color: #c7cdd4 !important;
        color: #8a8f98 !important;
        box-shadow: none !important;
    }
    #toolbar-mode-shell #modeLabel { display:flex; align-items:center; height:100%; white-space: nowrap; }

    #global-toolbar.toolbar-split {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        grid-template-areas:
            "mode secondary"
            "mode primary";
        align-items: stretch;
        column-gap: 15px;
        row-gap: 10px;
        padding: 10px 20px;
    }
    #global-toolbar.toolbar-split #toolbar-mode-shell {
        grid-area: mode;
        height: auto;
        min-height: 78px;
        align-self: stretch;
        padding-right: 18px;
    }
    #global-toolbar.toolbar-split .toolbar-row {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 15px;
        min-width: 0;
        width: 100%;
    }
    #global-toolbar.toolbar-split .toolbar-row-primary { grid-area: primary; }
    #global-toolbar.toolbar-split .toolbar-row-secondary { grid-area: secondary; }
    #global-toolbar.toolbar-split .toolbar-section {
        display: flex;
        align-items: center;
        gap: 15px;
        min-width: 0;
        flex-wrap: nowrap;
    }
    #global-toolbar.toolbar-split .toolbar-section-left {
        flex: 1 1 auto;
    }
    #global-toolbar.toolbar-split .toolbar-section-right {
        flex: 0 0 auto;
        margin-left: auto;
        justify-content: flex-end;
    }
    #global-toolbar.toolbar-split .controls-group {
        height: 34px;
    }
    #global-toolbar.toolbar-split .toolbar-section-right .controls-group:last-child,
    #global-toolbar.toolbar-split #layer-controls-group {
        border-right: none;
        padding-right: 0;
        justify-content: flex-end;
    }
    #toolbar-action-group {
        gap: 8px;
    }
    #toolbar-action-group > * {
        margin-left: 0 !important;
        margin-right: 0 !important;
    }
    body.editor-embedded #global-toolbar,
    body.editor-embedded #global-toolbar.toolbar-split {
        padding-left: 16px;
        padding-right: 16px;
    }
    body.editor-embedded .tab-header,
    body.editor-embedded .map-view-tabs {
        padding-left: 8px;
        padding-right: 8px;
    }
    
    /* Data Panel */
    .data-panel-scroll { padding: 15px; overflow-y: auto; height: 100%; box-sizing: border-box; }
    .thumb-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
    .thumb-item { height: 100px; background: #eee; border: 2px solid transparent; cursor: pointer; position: relative; }
    .thumb-item.active { border-color: var(--primary); }
    .thumb-preview { width: 100%; height: 100%; object-fit: cover; }
    .thumb-label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(255,255,255,0.9); font-size: 10px; padding: 2px; text-align: center; }

    /* Helpers */
    #selection-box, #selection-box-3d { position: absolute; border: 1px dashed #1a73e8; background: rgba(26,115,232,0.2); display: none; pointer-events: none; z-index: 30; }
    #snap-indicator { position: absolute; width: 10px; height: 10px; border: 2px solid cyan; border-radius: 50%; display: none; z-index: 25; pointer-events: none; transform: translate(-50%, -50%); }
    .marker { position: absolute; width: 24px; height: 24px; background: #d93025; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; border: 2px solid white; transform: translate(-50%, -50%); z-index: 15; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }

    /* Loading Overlay */
    #loadingOverlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(255,255,255,0.9); z-index: 9999;
        display: none; flex-direction: column; align-items: center; justify-content: center;
    }
    .spinner { font-size: 40px; color: var(--primary); animation: spin 1s infinite linear; margin-bottom: 20px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

    #addrEditableWrap {
        display: none !important;
    }
</style>
</head>
<body<?php echo $hideEditorHeader ? ' class="editor-embedded"' : ''; ?>>

    <!-- LOADING OVERLAY -->
    <div id="loadingOverlay">
        <i class="fas fa-circle-notch spinner"></i>
        <h2 id="loadingText" style="color:#555;">Analyzing Address...</h2>
        <p style="color:#777; font-size:14px;">Fetching Satellite Data, LiDAR, and Generating Geometry</p>
    </div>

    <!-- HEADER -->
    <header<?php echo $hideEditorHeader ? ' style="display:none;"' : ''; ?>>
        <div class="logo-area">
            <img src="/images/logo_square.png" alt="Icon" height="40">
            <div class="editor-rush-pill" id="editorRushPill" tabindex="0" aria-describedby="editorRushTooltip">
                <i class="fas fa-bolt"></i>
                <span>Rush Mode</span>
                <span class="editor-rush-countdown" id="editorRushCountdown">--:--</span>
                <span class="editor-rush-tooltip" id="editorRushTooltip" role="tooltip">Projects completed during the rush period earn a 25% bonus.</span>
            </div>
        </div>

        <div class="address-bar-container" id="addressBarContainer">
            <!-- EDITABLE MODE (default for direct visits) -->
            <div id="addrEditableWrap" style="display:flex; gap:10px; align-items:center; flex:1;">
                <input
                type="text"
                id="manualAddress"
                class="address-input"
                placeholder="Enter property address..."
                value=""
                onkeypress="if(event.key==='Enter') handleDirectAnalysis()"
                >
                <button class="btn-analyze" id="btnAnalyze" onclick="handleDirectAnalysis()">
                <i class="fas fa-search-location"></i> Analyze
                </button>
            </div>

            <!-- LOCKED MODE (for redirected/auto-loaded jobs) -->
            <div id="addrLockedWrap" style="display:none; gap:10px; align-items:center; flex:1; justify-content:center;">
                <input
                type="text"
                id="manualAddressLocked"
                class="address-input"
                value="..."
                readonly
                tabindex="-1"
                data-lock-address="1"
                style="
                    border: none;
                    background: transparent;
                    font-weight: 700;
                    color: #333;
                    box-shadow: none;
                    cursor: pointer;
                    pointer-events: auto;
                    text-align: center;
                "
                onclick="copyAddressToClipboard(this)"
                title="Click to copy"
                >
            </div>
        </div>

        <div class="claim-status">
            <div class="claim-timeline" id="claimTimeline">
                <div class="claim-timeline-labels" id="claimTimelineLabels"></div>
                <div class="claim-timeline-bar" aria-hidden="true">
                    <div class="claim-timeline-section green" data-section-index="0"></div>
                    <div class="claim-timeline-section yellow" data-section-index="1"></div>
                    <div class="claim-timeline-section orange" data-section-index="2"></div>
                    <div class="claim-timeline-section red" data-section-index="3"></div>
                </div>
                <div class="claim-timeline-marker" id="claimTimelineMarker"></div>
                <div class="claim-timeline-tooltip" id="claimTimelineTooltip"></div>
            </div>
            <div class="claim-timer waiting" id="claimElapsedTimer" title="Elapsed since project claim">--:--:--.--</div>
        </div>
    </header>
    <div class="editor-rush-toast" id="editorRushToast">
        <i class="fas fa-bolt"></i>
        <span>Rush mode has started</span>
    </div>

    
    <!-- HELP BAR (Hidden by default) -->
    <div id="help-bar">
        <div class="shortcut-group" title="Nudge selection"><span class="key-badge">Arrows</span> Nudge</div>
        <div class="shortcut-group" title="Rotate the 2D view"><span class="key-badge">Shift+Arrows</span> Spin View</div>
        <div class="shortcut-group" title="Merge selected points at their center"><span class="key-badge">W</span> Merge Pts</div>
        <div class="shortcut-group" title="Cycle two-face, three-face, and curved dormers"><span class="key-badge">D</span> Dormer</div>
        <div class="shortcut-group" title="Start Smart Face placement"><span class="key-badge">S</span> Smart Face</div>
        <div class="shortcut-group" title="Start Jerkin Head placement"><span class="key-badge">J</span> Jerkin</div>
        <div class="shortcut-group" title="Place a new point at the source point height"><span class="key-badge">Alt+Click</span> Level New Pt</div>
        <div class="shortcut-group" title="Create Quadrilateral"><span class="key-badge">Q</span> Quad</div>
        <div class="shortcut-group" title="Hold Alt on the final quad click to place new points at the source point height"><span class="key-badge">Alt+Final</span> Level Quad</div>
    </div>

    <!-- TOOLBAR -->

    <div id="global-toolbar">
        <div class="controls-group" id="toolbar-mode-shell">
            <div id="modeLabel" onclick="cycleSelectionMode()" title="Cycle Selection Mode (TAB)" style="font-weight:bold; font-size:11px; color:var(--primary); cursor:pointer; text-transform:uppercase;">POINT MODE</div>
        </div>

        <div class="toolbar-row toolbar-row-primary">
            <div class="toolbar-section toolbar-section-left">
                <div class="controls-group" title="Hold Ctrl + Scroll Wheel to adjust radius">
                    <label style="font-size:11px;">Snap:</label>
                    <input type="range" id="snapRadiusInput" min="5" max="100" value="20" style="width:60px;" oninput="updateSnapRadius()">
                    <span id="snapRadiusVal" style="font-size:11px; width:20px;">20</span>
                </div>

                <div class="controls-group">
                    <button class="toolbar-btn" onclick="deleteSelected2D()" title="Delete Selection (Del / Backspace)"><i class="fas fa-trash"></i></button>
                    <button class="toolbar-btn" onclick="handleGenerateMeasurements()" title="Recalculate Line Types (Reset)"><i class="fas fa-sync"></i></button>
                </div>
                
                <div class="controls-group">
                    <button class="toolbar-btn active" id="btnToggleImage" onclick="toggleImageDisplay()" title="Toggle Image Layer (I)" style="background:#e8f0fe; color:#1a73e8; border-color:#1a73e8;">
                        <i class="fas fa-image"></i>
                    </button>
                    <button class="toolbar-btn" id="btnToggleMeasure" onclick="toggleMeasurementDisplay()" title="Toggle Measurements (O)">
                        <i class="fas fa-ruler"></i>
                    </button>
                    <button class="toolbar-btn" id="btnToggleTypes" onclick="toggleLineTypes()" title="Show Line Types / Widget (P)">
                        <i class="fas fa-palette"></i>
                    </button>
                    <button class="toolbar-btn active" id="btnToggleFaces" onclick="toggleFacesGlobal()" title="Toggle Generated Faces ([)" style="background:#e8f0fe; color:#1a73e8; border-color:#1a73e8;">
                        <i class="fas fa-shapes"></i>
                    </button>
                    <button class="toolbar-btn active" id="btnToggleGrid" onclick="toggleGridDisplay()" title="Toggle Grid Overlay (G)" style="margin-left:5px; background:#e8f0fe; color:#1a73e8; border-color:#1a73e8;">
                        <i class="fas fa-border-all"></i>
                    </button>
                    <button class="toolbar-btn active" id="btnToggleSnap" onclick="toggleSnapMode()" title="Snapping ON (F)" style="margin-left:5px; background:#e8f0fe; color:#1a73e8; border-color:#1a73e8;">
                        <i class="fas fa-magnet"></i>
                    </button>
                    <button class="toolbar-btn" id="btnSplat" onclick="toggleSplatMode()" title="Splat Face (Experimental)" style="display: none;">
                        <i class="fas fa-paint-roller"></i>
                    </button>
                    <button class="toolbar-btn" id="btnFixRotation" onclick="window.straightenView()" title="Straigten View">
                        <i class="fas fa-compass"></i>
                    </button>
                </div>
            </div>

            <div class="toolbar-section toolbar-section-right">
                <div class="controls-group" id="layer-controls-group">
                    <!-- Layer numbers injected by JS -->
                </div>
            </div>
        </div>

        <div class="toolbar-row toolbar-row-secondary">
            <div class="toolbar-section toolbar-section-left">
                <div class="controls-group">
                    <label style="font-size:11px;" title="Scroll Wheel to Zoom">Zoom:</label>
                    <input type="range" id="zoomRange" min="0.1" max="10" step="0.1" value="1" style="width:60px;" oninput="updateZoomViaSlider()" title="Manual Zoom Level">
                    
                    <button class="toolbar-btn primary" onclick="window.processAndRenderAllLayers()" style="margin-left: 10px; background-color: #673ab7; border-color: #673ab7;" title="Recalculate 3D Face Topology">
                        <i class="fas fa-vector-square"></i> Resolve Faces
                    </button>
                </div>
                    
                <div class="controls-group">
                    <div class="btn-group" style="display:flex; margin-left:5px; border:1px solid #ccc; border-radius:4px; overflow:hidden;">
                        <button class="toolbar-btn" onclick="selectView('solar')" title="Solar Layer" style="border:none; border-radius:0; padding:6px 8px; font-size:10px;">Solar</button>
                        <button class="toolbar-btn" onclick="selectView('google')" title="Google Maps" style="border:none; border-left:1px solid #eee; border-radius:0; padding:6px 8px; font-size:10px;">G</button>
                        <button class="toolbar-btn" onclick="selectView('azure')" title="Bing Maps" style="border:none; border-left:1px solid #eee; border-radius:0; padding:6px 8px; font-size:10px;">B</button>
                        <button class="toolbar-btn" onclick="selectView('apple')" title="Apple Maps" style="border:none; border-left:1px solid #eee; border-radius:0; padding:6px 8px; font-size:10px;">A</button>
                    </div>
                </div>
            </div>

            <div class="toolbar-section toolbar-section-right">
                <div class="controls-group" id="toolbar-action-group" style="margin-left:auto; padding-right: 0;">
                    <div class="btn-group" style="display:flex; border:1px solid #ccc; border-radius:4px; overflow:hidden;">
                        <button class="toolbar-btn" onclick="openGoogleEarth()" title="Open Google Earth" style="border:none; border-radius:0; padding:6px 9px;">
                            <i class="fas fa-globe-americas"></i>
                        </button>
                        <button class="toolbar-btn" onclick="openStreetView()" title="Open Google Street View" style="border:none; border-left:1px solid #eee; border-radius:0; padding:6px 9px;">
                            <i class="fas fa-street-view"></i>
                        </button>
                        <button class="toolbar-btn" onclick="openAppleStreetView()" title="Open Apple Look Around" style="border:none; border-left:1px solid #eee; border-radius:0; padding:6px 9px;">
                            <i class="fab fa-apple"></i>
                        </button>
                    </div>
                    <button class="toolbar-btn primary" id="btnQuadView" onclick="launchQuadView()" title="Open Quad View Tool" style="transition: all 0.4s ease;">
                        <i class="fas fa-cube"></i> Quad
                    </button>
                    <button class="toolbar-btn" id="btnToggleHelp" onclick="toggleHelpBar()" title="Keyboard Shortcuts">
                        <i class="fas fa-question-circle"></i>
                    </button>
                </div>
            </div>
        </div>
    </div>


    <!-- MAIN WORKSPACE -->
    <div class="workspace" id="workspace">
        <!-- 2D Column -->
        <div class="left-column" id="leftColumn">
            <div class="tab-header">
                <button class="tab-btn active" onclick="switchTab('view2d')">2D Canvas</button>
                <button class="tab-btn" onclick="switchTab('data')">Data & AI</button>
            </div>

            <div id="tab-view2d" class="tab-content active" style="height:100%;">
                <div id="structure-mode-bar"></div>
                <div id="viewport">
                    <div id="zoom-layer"></div>
                    <div id="selection-box"></div>
                    <div id="snap-indicator"></div>
                </div>
            </div>

            <div id="tab-data" class="tab-content">
                <div class="data-panel-scroll">
                    <h3>AI Geometry Controls</h3>
                    <textarea id="geminiPrompt" style="width:100%; height:60px; font-size:11px; margin-bottom:10px;">Remove background, keep roof. Draw red lines on ridges/hips/valleys/eaves.</textarea>
                    
                    
                    <div style="display:flex; gap:5px; margin-bottom:15px;">
                        <button class="toolbar-btn" onclick="addAiAttempts()">+1 AI Crop</button>
                        <button class="toolbar-btn primary" id="btnGeo" onclick="handleGenerateGeometry()">Run Geometry</button>
                    </div>

                    <div id="thumbGrid" class="thumb-grid"></div>

                    <hr style="border:0; border-top:1px solid #ddd; margin:15px 0;">
                    
                    <h4>Computer Vision Params</h4>
                    <div style="font-size:11px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                        <label>Blue Sens: <span id="valBlue">20</span><br><input type="range" id="paramBlue" min="0" max="100" value="20" oninput="updateCvParamsUI()"></label>
                        <label>Red Thresh: <span id="valRed">20</span><br><input type="range" id="paramRed" min="0" max="100" value="20" oninput="updateCvParamsUI()"></label>
                        <label>Erosion: <span id="valErode">0</span><br><input type="range" id="paramErode" min="0" max="5" step="1" value="0" oninput="updateCvParamsUI()"></label>
                    </div>
                    <button class="toolbar-btn" id="btnReprocess" style="width:100%; margin-top:10px;" onclick="handleReprocessGeometry()" disabled>Recalc Geometry</button>
                </div>
            </div>
        </div>

        <div class="resizer" id="dragResizer"></div>

        <!-- 3D / Map Column -->
        <div class="right-column" id="rightColumn">
            <div id="three-view-wrapper">
                <div class="controls-3d-overlay">Right-Click to Pan, Middle to Rotate</div>
                <div class="controls-3d-actions" style="display: flex; align-items: center; gap: 10px;">
                    <!-- Crop Slider -->
                    <label style="color:white; font-size:11px; display:flex; align-items:center; gap:5px;" title="Ctrl + Scroll to adjust">
                        Crop <input type="range" id="cropRange" min="0" max="100" value="0" oninput="update3DCrop()" style="width:60px;">
                    </label>
                    
                    <!-- Mask Checkbox
                    <label style="color:white; font-size:11px; display:flex; align-items:center; gap:4px; cursor:pointer;">
                        <input type="checkbox" id="maskEnabled" checked onchange="onMaskControlsChanged()"> Mask
                    </label>-->
                    
                    <!-- NEW: Image Toggle Button (Matches Global Style) -->
                    <button id="btnToggleImage3D" onclick="toggle3DImage()" title="Toggle 3D Image Layer" class="active" 
                            style="
                                padding: 4px 8px; 
                                border-radius: 4px; 
                                border: 1px solid rgb(60 145 255); 
                                background: rgb(0 93 255 / 40%); 
                                color: rgb(60 145 255);
                                cursor: pointer; 
                                font-size: 12px;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            ">
                        <i class="fas fa-image"></i>
                    </button>
                </div>
                <div id="three-container"></div>
                <div id="selection-box-3d"></div>
            </div>

            <!-- NEW: Vertical Resizer -->
            <div class="resizer-vertical" id="verticalResizer" title="Drag to resize views"></div>

            <!-- === MAPS WRAPPER === -->
            <div id="google-earth-wrapper">
                <div class="map-view-tabs">
                    <button class="map-tab" id="tabCesium" onclick="switchMapLayer('cesium')">3D Tiles</button>
                    <button class="map-tab active" id="tabGoogle" onclick="switchMapLayer('google')">Google Maps</button>
                    
                    <!-- NEW RECENTER BUTTON -->
                    <button class="map-tab" onclick="recenterMap()" title="Recenter on property" style="border-color: rgba(255,255,255,0.5);">
                        <i class="fas fa-crosshairs"></i>
                    </button>
                </div>
                
                <div id="google-map-container" style="display:none;"></div>
                <div id="google-js-map" style="display:block;"></div>
            </div>
        </div>
    </div>

    <!-- Hidden Inputs for logic -->
    <input type="hidden" id="addressInput"> <!-- populated by handleDirectAnalysis -->
    <input type="color" id="maskColor" value="#ffffff" style="display:none;">
    <input type="range" id="maskTolerance" value="10" style="display:none;">
    <select id="geminiModelSelect" style="display:none;"><option value="gemini-3-pro-image-preview" selected></option></select>

    <!-- SCRIPTS -->
    <script>
      window.FIRSTMEASURE_BROWSER_GOOGLE_API_KEY = <?=json_encode($GOOGLE_BROWSER_API_KEY, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)?>;
      window.FIRSTMEASURE_AZURE_MAPS_KEY = <?=json_encode($AZURE_MAPS_SUBSCRIPTION_KEY, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)?>;
    </script>
    <script src="editor_scripts/geometry_core.js?v=<?=fm_editor_asset_version('editor_scripts/geometry_core.js')?>"></script>
    <script src="editor_scripts/structure_mode.js?v=<?=fm_editor_asset_version('editor_scripts/structure_mode.js')?>"></script>
    <script src="editor_scripts/scene_3d.js?v=<?=fm_editor_asset_version('editor_scripts/scene_3d.js')?>"></script>
    <script src="editor_scripts/interaction_2d.js?v=<?=fm_editor_asset_version('editor_scripts/interaction_2d.js')?>"></script>
    <script src="editor_scripts/main.js?v=<?=fm_editor_asset_version('editor_scripts/main.js')?>"></script>
    <script src="editor_scripts/measurements.js?v=<?=fm_editor_asset_version('editor_scripts/measurements.js')?>"></script>
    <script src="editor_scripts/pdf.js?v=<?=fm_editor_asset_version('editor_scripts/pdf.js')?>"></script>
    <script src="editor_scripts/pdf_standalone.js?v=<?=fm_editor_asset_version('editor_scripts/pdf_standalone.js')?>"></script>
    <script src="editor_scripts/report.js?v=<?=fm_editor_asset_version('editor_scripts/report.js')?>"></script>
    <?php if ($isTutorialEditor): ?>
    <script src="editor_scripts/tutorials.js?v=<?=fm_editor_asset_version('editor_scripts/tutorials.js')?>"></script>
    <?php endif; ?>
    <script src="editor_scripts/quad_view.js?v=<?=fm_editor_asset_version('editor_scripts/quad_view.js')?>"></script>
    <script src="editor_scripts/dev_tools.js?v=<?=fm_editor_asset_version('editor_scripts/dev_tools.js')?>"></script>
    <script src="editor_scripts/maps.js?v=<?=fm_editor_asset_version('editor_scripts/maps.js')?>"></script>
    <script src="editor_scripts/notes_overlay.js?v=<?=fm_editor_asset_version('editor_scripts/notes_overlay.js')?>"></script>
    <script src="editor_scripts/customer_rework.js?v=<?=fm_editor_asset_version('editor_scripts/customer_rework.js')?>"></script>
    <script src="editor_scripts/xml_generator.js?v=<?=fm_editor_asset_version('editor_scripts/xml_generator.js')?>"></script> 
    <script src="editor_scripts/smart_stickers.js?v=<?=fm_editor_asset_version('editor_scripts/smart_stickers.js')?>"></script> 
    <script src="editor_scripts/monitor.js?v=<?=fm_editor_asset_version('editor_scripts/monitor.js')?>"></script>

    
    <!-- Google Maps (Callback initAppMapViewGlobal defined in main.js) -->
    <?php if ($GOOGLE_BROWSER_API_KEY !== ''): ?>
    <script async defer src="https://maps.googleapis.com/maps/api/js?key=<?=htmlspecialchars(rawurlencode($GOOGLE_BROWSER_API_KEY), ENT_QUOTES, 'UTF-8')?>&v=3.64&libraries=places,geocoding&callback=initAppMapViewGlobal"></script>
    <?php endif; ?>

    <script>
        window.FIRSTMEASURE_API_BASE = (function() {
            const host = (location.hostname || '').toLowerCase();
            if (host === '127.0.0.1' || host === 'localhost') {
                return 'http://127.0.0.1:3111/v1/firstmeasure';
            }
            return `${location.origin}/v1/firstmeasure`;
        })();

        window.FIRSTMEASURE_TUTORIAL = {
            enabled: <?php echo json_encode((bool)$isTutorialEditor); ?>,
            courseId: <?php echo json_encode($tutorialCourseId); ?>,
            projectId: <?php echo json_encode($requestedFolder); ?>,
            studentEmail: <?php echo json_encode($tutorialStudentEmail); ?>
        };

        window.FIRSTMEASURE_ACTOR = {
            email: <?php echo json_encode($_SESSION['user_email'] ?? ''); ?>,
            name: <?php echo json_encode($userName); ?>,
            organization_id: <?php echo json_encode($_SESSION['user_org_id'] ?? $_SESSION['org_id'] ?? ''); ?>
        };

        window.FIRSTMEASURE_REJECTION_REASONS = <?php echo json_encode(function_exists('fm_rejection_reasons') ? fm_rejection_reasons() : []); ?>;
        window.FIRSTMEASURE_REPORT_SETTINGS = <?php echo json_encode($fmEditorGlobalReportSettings); ?>;
        window.FIRSTMEASURE_DISABLE_QUAD_VIEWS = !!(window.FIRSTMEASURE_REPORT_SETTINGS && (
            window.FIRSTMEASURE_REPORT_SETTINGS.disable_quad_views ||
            window.FIRSTMEASURE_REPORT_SETTINGS.disableQuadViews ||
            window.FIRSTMEASURE_REPORT_SETTINGS.no_quad_views ||
            window.FIRSTMEASURE_REPORT_SETTINGS.noQuadViews
        ));

        window.firstMeasureIsTutorialProjectId = window.firstMeasureIsTutorialProjectId || function(projectId) {
            return /^tutorial_[a-f0-9]{16,64}$/i.test(String(projectId || '').trim());
        };

        window.firstMeasureBuildTutorialUrl = function(path) {
            if (!window.FIRSTMEASURE_TUTORIAL || !window.FIRSTMEASURE_TUTORIAL.enabled) return null;
            const rawPath = String(path || '');
            const match = rawPath.match(/^\/projects\/([^\/?#]+)(.*)$/);
            if (!match) return null;
            const projectId = decodeURIComponent(match[1] || '');
            if (!window.firstMeasureIsTutorialProjectId(projectId)) {
                throw new Error('Tutorial mode blocked a project request that did not target a tutorial project.');
            }
            const rest = match[2] || '';
            const query = new URLSearchParams();
            query.set('tutorial_id', projectId);
            query.set('course_id', window.FIRSTMEASURE_TUTORIAL.courseId || 'default');
            if (window.FIRSTMEASURE_TUTORIAL.studentEmail) query.set('student_email', window.FIRSTMEASURE_TUTORIAL.studentEmail);

            let action = '';
            let artifactName = '';
            if (rest === '/editor' || rest === '/editor/') {
                action = 'tutorial_project_bundle';
            } else if (rest === '/editor/save') {
                const v1Base = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
                query.set('actor_email', window.FIRSTMEASURE_ACTOR?.email || '');
                query.set('actor_name', window.FIRSTMEASURE_ACTOR?.name || '');
                query.set('actor_role', window.FIRSTMEASURE_ACTOR?.role || '');
                return `${v1Base}/internal/tutorial-projects/${encodeURIComponent(projectId)}/pdf-state?${query.toString()}`;
            } else if (rest === '/editor/pdf-state') {
                action = 'tutorial_project_pdf_state';
            } else if (rest === '/artifacts' || rest === '/artifacts/') {
                action = 'tutorial_project_artifacts';
            } else if (rest.startsWith('/artifacts/')) {
                action = 'tutorial_project_artifact';
                artifactName = decodeURIComponent(rest.slice('/artifacts/'.length).split('?')[0] || '');
            } else if (rest === '/status') {
                action = 'tutorial_project_status';
            } else if (rest === '' || rest === '/') {
                action = 'tutorial_project_patch';
            } else if (rest === '/pdfs/generate' || rest === '/pdfs/generate/server') {
                action = 'tutorial_project_pdfs_generate';
            } else {
                action = 'tutorial_project_unsupported';
            }

            query.set('action', action);
            if (artifactName) query.set('name', artifactName);
            return `editor.php?${query.toString()}`;
        };

        window.firstMeasureBuildUrl = function(path) {
            const tutorialUrl = window.firstMeasureBuildTutorialUrl(path);
            if (tutorialUrl) return tutorialUrl;
            const rawPath = String(path || '');
            const match = rawPath.match(/^\/projects\/([^\/?#]+)(?:\/|$|\?|#)/);
            if (match && window.firstMeasureIsTutorialProjectId(decodeURIComponent(match[1] || ''))) {
                throw new Error('Tutorial projects must be opened in tutorial mode.');
            }
            return `${window.FIRSTMEASURE_API_BASE}${path}`;
        };

        window.firstMeasureBuildEditorBundleUrl = function(projectId) {
            const isTutorialProject = window.firstMeasureIsTutorialProjectId(projectId);
            if (isTutorialProject && (!window.FIRSTMEASURE_TUTORIAL || !window.FIRSTMEASURE_TUTORIAL.enabled)) {
                throw new Error('Tutorial projects must be opened in tutorial mode.');
            }
            const base = location.pathname || 'editor.php';
            const query = new URLSearchParams({
                action: 'project_bundle',
                folder: String(projectId || '')
            });
            if (isTutorialProject) {
                query.set('action', 'tutorial_project_bundle');
                query.set('tutorial_id', String(projectId || ''));
                query.delete('folder');
                query.set('course_id', window.FIRSTMEASURE_TUTORIAL?.courseId || 'default');
                if (window.FIRSTMEASURE_TUTORIAL?.studentEmail) query.set('student_email', window.FIRSTMEASURE_TUTORIAL.studentEmail);
            }
            return `${base}?${query.toString()}`;
        };

        window.firstMeasureEditorBundleCacheKey = function(projectId) {
            const apiBase = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/+$/, '');
            return `qa_editor_bundle:v1:${apiBase}:${String(projectId || '').trim()}`;
        };

        window.firstMeasureReadQaEditorBundleCache = function(url, maxAgeMs = 120000) {
            try {
                const pageQuery = new URLSearchParams(window.location.search || '');
                if (!pageQuery.has('qa_embed')) return null;
                const parsed = new URL(url, window.location.href);
                const query = parsed.searchParams;
                const action = String(query.get('action') || '');
                if (action !== 'project_bundle' && action !== 'tutorial_project_bundle') return null;
                const projectId = query.get('folder') || query.get('tutorial_id') || '';
                if (!projectId || !window.sessionStorage) return null;
                const raw = sessionStorage.getItem(window.firstMeasureEditorBundleCacheKey(projectId));
                if (!raw) return null;
                const wrapped = JSON.parse(raw);
                const savedAt = Number(wrapped && wrapped.savedAt);
                if (!savedAt || Date.now() - savedAt > maxAgeMs) return null;
                return wrapped.data && typeof wrapped.data === 'object' ? wrapped.data : null;
            } catch (e) {
                return null;
            }
        };

        window.firstMeasureWriteQaEditorBundleCache = function(url, data) {
            try {
                const pageQuery = new URLSearchParams(window.location.search || '');
                if (!pageQuery.has('qa_embed')) return;
                const parsed = new URL(url, window.location.href);
                const query = parsed.searchParams;
                const action = String(query.get('action') || '');
                if (action !== 'project_bundle' && action !== 'tutorial_project_bundle') return;
                const projectId = query.get('folder') || query.get('tutorial_id') || '';
                if (!projectId || !data || typeof data !== 'object' || !window.sessionStorage) return;
                sessionStorage.setItem(window.firstMeasureEditorBundleCacheKey(projectId), JSON.stringify({
                    savedAt: Date.now(),
                    data
                }));
            } catch (e) {}
        };

        window.firstMeasureFetchLocalJson = async function(url, options = {}) {
            const cached = window.firstMeasureReadQaEditorBundleCache(url);
            if (cached) return cached;
            const res = await fetch(url, options);
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch (e) {
                throw new Error(`Local editor endpoint returned invalid JSON (${res.status}).`);
            }
            if (!res.ok || data.success === false) {
                throw new Error(data.message || data.error || `Local editor request failed (${res.status}).`);
            }
            window.firstMeasureWriteQaEditorBundleCache(url, data);
            return data;
        };

        window.firstMeasureFetchJson = async function(path, options = {}) {
            const init = { credentials: 'include', ...options };
            const method = String(init.method || 'GET').toUpperCase();
            const bypassEditorBundle = !!(init.firstMeasureBypassEditorBundle || init.bypassLocalEditorBundle);
            delete init.firstMeasureBypassEditorBundle;
            delete init.bypassLocalEditorBundle;
            const editorBundleMatch = String(path || '').match(/^\/projects\/([^\/?#]+)\/editor\/?$/);
            if (method === 'GET' && editorBundleMatch && !bypassEditorBundle) {
                return window.firstMeasureFetchLocalJson(
                    window.firstMeasureBuildEditorBundleUrl(decodeURIComponent(editorBundleMatch[1] || '')),
                    init
                );
            }
            const tutorialSaveMatch = String(path || '').match(/^\/projects\/([^\/?#]+)\/editor\/save$/);
            if (method === 'POST' && tutorialSaveMatch && window.FIRSTMEASURE_TUTORIAL?.enabled) {
                let savePayload = {};
                try {
                    savePayload = typeof init.body === 'string' ? JSON.parse(init.body) : {};
                } catch (e) {
                    throw new Error('Tutorial save payload was not valid JSON.');
                }
                const v1Base = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
                const res = await fetch(`${v1Base}/internal/legacy-action`, {
                    method: 'POST',
                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...savePayload,
                        action: 'save_tutorial_project_editor',
                        tutorial_id: decodeURIComponent(tutorialSaveMatch[1] || ''),
                        course_id: window.FIRSTMEASURE_TUTORIAL.courseId || 'default',
                        student_email: window.FIRSTMEASURE_TUTORIAL.studentEmail || window.FIRSTMEASURE_ACTOR?.email || '',
                        actor: window.FIRSTMEASURE_ACTOR || {}
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || data.error || `Tutorial save failed (${res.status}).`);
                }
                if (window.sessionStorage) {
                    sessionStorage.removeItem(window.firstMeasureEditorBundleCacheKey(decodeURIComponent(tutorialSaveMatch[1] || '')));
                }
                return data;
            }
            const res = await fetch(window.firstMeasureBuildUrl(path), init);
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch (e) {
                throw new Error(`FirstMeasure returned invalid JSON (${res.status}).`);
            }
            if (!res.ok) {
                throw new Error(data.message || data.error || `FirstMeasure request failed (${res.status}).`);
            }
            if (method !== 'GET' && window.FIRSTMEASURE_TUTORIAL?.enabled) {
                const projectMatch = String(path || '').match(/^\/projects\/([^\/?#]+)/);
                if (projectMatch && window.sessionStorage) {
                    sessionStorage.removeItem(window.firstMeasureEditorBundleCacheKey(decodeURIComponent(projectMatch[1] || '')));
                }
            }
            return data;
        };

        window.firstMeasureUploadArtifact = async function(projectId, file, fileName, fieldName = 'file') {
            const fd = new FormData();
            fd.append(fieldName, file, fileName);
            let uploadUrl = window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(projectId)}/artifacts`);
            if (window.FIRSTMEASURE_TUTORIAL?.enabled && window.firstMeasureIsTutorialProjectId(projectId)) {
                const v1Base = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
                const query = new URLSearchParams({
                    course_id: window.FIRSTMEASURE_TUTORIAL.courseId || 'default',
                    student_email: window.FIRSTMEASURE_TUTORIAL.studentEmail || window.FIRSTMEASURE_ACTOR?.email || '',
                    actor_email: window.FIRSTMEASURE_ACTOR?.email || '',
                    actor_name: window.FIRSTMEASURE_ACTOR?.name || '',
                    actor_role: window.FIRSTMEASURE_ACTOR?.role || '',
                    file_name: fileName || file?.name || 'artifact.bin'
                });
                uploadUrl = `${v1Base}/internal/tutorial-projects/${encodeURIComponent(projectId)}/artifacts?${query.toString()}`;
            }
            const res = await fetch(uploadUrl, {
                method: 'POST',
                body: fd
            });
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch (e) {
                throw new Error(`FirstMeasure returned invalid JSON (${res.status}).`);
            }
            if (!res.ok) {
                throw new Error(data.message || data.error || `FirstMeasure upload failed (${res.status}).`);
            }
            return data;
        };

        window.firstMeasureUploadTextArtifact = async function(projectId, fileName, contentText, contentType = 'text/plain') {
            return window.firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/artifacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_name: fileName,
                    content_text: contentText,
                    content_type: contentType
                })
            });
        };

        window.firstMeasureRushModeState = {
            activeId: null,
            endMs: null,
            timer: null,
            pollTimer: null,
            lastActive: false
        };

        window.firstMeasureFormatRushCountdown = function(seconds) {
            const safe = Math.max(0, Math.floor(Number(seconds) || 0));
            const hours = Math.floor(safe / 3600);
            const minutes = Math.floor((safe % 3600) / 60);
            const secs = safe % 60;
            return hours > 0
                ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
                : `${minutes}:${String(secs).padStart(2, '0')}`;
        };

        window.firstMeasureShowRushToast = function() {
            const toast = document.getElementById('editorRushToast');
            if (!toast) return;
            toast.classList.add('visible');
            clearTimeout(window.firstMeasureShowRushToast._timer);
            window.firstMeasureShowRushToast._timer = setTimeout(() => {
                toast.classList.remove('visible');
            }, 4200);
        };

        window.firstMeasureApplyRushMode = function(rushMode, options = {}) {
            const state = window.firstMeasureRushModeState;
            const active = !!rushMode;
            const header = document.querySelector('header');
            const pill = document.getElementById('editorRushPill');
            const countdown = document.getElementById('editorRushCountdown');

            if (state.timer) {
                clearInterval(state.timer);
                state.timer = null;
            }

            if (!active) {
                state.activeId = null;
                state.endMs = null;
                if (header) header.classList.remove('editor-rush-active');
                if (pill) pill.classList.remove('active');
                if (countdown) countdown.textContent = '--:--';
                state.lastActive = false;
                return;
            }

            const endMs = Date.parse(String(rushMode.end_at || ''));
            state.activeId = String(rushMode.id || '');
            state.endMs = Number.isFinite(endMs) ? endMs : null;
            if (header) header.classList.add('editor-rush-active');
            if (pill) pill.classList.add('active');
            if (options.announce && !state.lastActive) window.firstMeasureShowRushToast();
            state.lastActive = true;

            const tick = () => {
                const remaining = state.endMs ? Math.max(0, Math.ceil((state.endMs - Date.now()) / 1000)) : Number(rushMode.remaining_seconds || 0);
                if (countdown) countdown.textContent = window.firstMeasureFormatRushCountdown(remaining);
                if (remaining <= 0) {
                    window.firstMeasureApplyRushMode(null);
                }
            };
            tick();
            state.timer = setInterval(tick, 1000);
        };

        window.firstMeasureCheckRushMode = async function(options = {}) {
            try {
                const data = await window.firstMeasureFetchJson('/rush/current', {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });
                const mode = data && data.active && data.rush_mode ? data.rush_mode : null;
                const previousId = window.firstMeasureRushModeState.activeId;
                const nextId = mode ? String(mode.id || '') : null;
                window.firstMeasureApplyRushMode(mode, {
                    announce: options.announce && !!nextId && nextId !== previousId
                });
                return mode;
            } catch (e) {
                console.warn('[Rush Mode] Failed to refresh rush mode:', e);
                return null;
            }
        };

        window.firstMeasureStartRushModePolling = function() {
            const state = window.firstMeasureRushModeState;
            if (state.pollTimer) return;
            window.firstMeasureCheckRushMode({ announce: false });
            state.pollTimer = setInterval(() => {
                window.firstMeasureCheckRushMode({ announce: true });
            }, 120000);
        };

        window.firstMeasureNormalizeProjectStatus = function(status) {
            return String(status || '').toLowerCase().trim().replace(/\s+/g, '_');
        };

        window.firstMeasureTerminalProjectStatuses = new Set([
            'completed',
            'rejected',
            'rejected_no_coverage',
            'cancelled'
        ]);

        window.firstMeasureGetProjectManifest = async function(projectId, { refresh = false } = {}) {
            const normalizedId = String(projectId || '').trim();
            const currentId = String(window.currentProjectId || '').trim();
            const cachedManifest = (currentId === normalizedId && window.currentProjectManifest && typeof window.currentProjectManifest === 'object')
                ? window.currentProjectManifest
                : null;

            if (!refresh && cachedManifest) return cachedManifest;

            const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/editor`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            const manifest = data && typeof data === 'object' && data.manifest && typeof data.manifest === 'object'
                ? data.manifest
                : null;

            if (manifest && currentId === normalizedId) {
                window.currentProjectManifest = manifest;
                if (typeof window.refreshStructureMode === 'function') window.refreshStructureMode();
                if (typeof window.firstMeasureRenderCustomerReworkPrompt === 'function') {
                    window.firstMeasureRenderCustomerReworkPrompt(manifest);
                }
            }

            return manifest;
        };

        window.firstMeasureSetProjectStatus = async function(projectId, status, options = {}) {
            const requestedStatus = window.firstMeasureNormalizeProjectStatus(status);
            let currentStatus = '';

            try {
                const manifest = await window.firstMeasureGetProjectManifest(projectId);
                currentStatus = window.firstMeasureNormalizeProjectStatus(manifest && manifest.status);
            } catch (e) {
                console.warn('[FirstMeasure] Failed to load manifest before status update:', e);
            }

            if (
                currentStatus &&
                window.firstMeasureTerminalProjectStatuses.has(currentStatus) &&
                currentStatus !== requestedStatus
            ) {
                console.info(
                    `[FirstMeasure] Preserving terminal project status "${currentStatus}" for ${projectId}; blocked attempted transition to "${requestedStatus}".`
                );
                throw new Error(`Project status is already "${currentStatus}"; the requested "${requestedStatus}" transition was not saved.`);
            }

            const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status,
                    pdf_sync_job_id: String(options.pdf_sync_job_id || ''),
                    pdf_sync_revision: String(options.pdf_sync_revision || ''),
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });

            const nextManifest =
                (data && typeof data === 'object' && data.manifest && typeof data.manifest === 'object') ? data.manifest :
                (data && typeof data === 'object' && data.project && data.project.manifest && typeof data.project.manifest === 'object') ? data.project.manifest :
                (data && typeof data === 'object' && data.project && typeof data.project === 'object') ? data.project :
                null;
            const persistedStatus = window.firstMeasureNormalizeProjectStatus(nextManifest && nextManifest.status);
            const reviewStatuses = new Set(['awaiting_review', 'awaiting_manager_review']);
            const statusMatches = reviewStatuses.has(requestedStatus)
                ? reviewStatuses.has(persistedStatus)
                : persistedStatus === requestedStatus;

            if (!nextManifest || data.accepted === false || !statusMatches) {
                throw new Error(
                    `The server did not persist the requested project status. Expected "${requestedStatus}", received "${persistedStatus || 'unknown'}".`
                );
            }

            if (
                nextManifest &&
                String(window.currentProjectId || '').trim() === String(projectId || '').trim()
            ) {
                window.currentProjectManifest = nextManifest;
                if (typeof window.firstMeasureUpdateClaimTimer === 'function') {
                    window.firstMeasureUpdateClaimTimer(nextManifest);
                }
                if (typeof window.firstMeasureRenderCustomerReworkPrompt === 'function') {
                    window.firstMeasureRenderCustomerReworkPrompt(nextManifest);
                }
            }

            return data;
        };

        window.firstMeasureClaimTimerState = {
            startMs: null,
            frameId: null,
            points: null,
            timeline: null,
            timing: null
        };

        window.FIRSTMEASURE_COMPLEXITY_POINTS = {
            1: 2,
            2: 3,
            3: 4,
            4: 6,
            5: 10,
            very_simple: 2,
            very_simple_project: 2,
            simple: 3,
            simple_project: 3,
            standard: 4,
            standard_project: 4,
            complex: 6,
            complex_project: 6,
            very_complex: 10,
            very_complex_project: 10
        };

        window.FIRSTMEASURE_TIMELINE_PESO_RATES = [19, 16, 13, 10, 5];

        window.firstMeasureParseClaimTimestamp = function(raw) {
            if (raw === null || raw === undefined || raw === '') return null;

            if (typeof raw === 'number' && Number.isFinite(raw)) {
                const ms = raw > 100000000000 ? raw : raw * 1000;
                return Number.isFinite(ms) ? ms : null;
            }

            const text = String(raw).trim();
            if (!text) return null;

            if (/^\d+(\.\d+)?$/.test(text)) {
                const value = Number(text);
                if (Number.isFinite(value)) return value > 100000000000 ? value : value * 1000;
            }

            const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
            const hasSqlTimestamp = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(text);
            const normalized = hasSqlTimestamp ? text.replace(' ', 'T') : text;
            if (hasSqlTimestamp && !hasTimezone) {
                const localMs = Date.parse(normalized);
                const utcMs = Date.parse(normalized + 'Z');
                const nowMs = Date.now();
                if (Number.isFinite(localMs) && Number.isFinite(utcMs)) {
                    return localMs > nowMs + 60000 && utcMs <= nowMs + 60000 ? utcMs : localMs;
                }
            }

            const parsed = Date.parse(normalized);
            return Number.isFinite(parsed) ? parsed : null;
        };

        window.firstMeasureFindLatestReopenMs = function(manifest) {
            if (!manifest || typeof manifest !== 'object') return null;

            const workflow = manifest.workflow && typeof manifest.workflow === 'object' ? manifest.workflow : {};
            let latest = window.firstMeasureParseClaimTimestamp(manifest.resubmitted_at || manifest.last_resubmission_at || null);
            const resubmissions = Array.isArray(manifest.resubmissions) ? manifest.resubmissions : [];
            for (const item of resubmissions) {
                if (!item || typeof item !== 'object') continue;
                const ms = window.firstMeasureParseClaimTimestamp(item.reopened_at || item.resubmitted_at || null);
                if (ms !== null && (latest === null || ms > latest)) latest = ms;
            }
            const historiesForReopen = [manifest.work_history, workflow.history];
            for (const history of historiesForReopen) {
                if (!Array.isArray(history)) continue;
                for (const entry of history) {
                    if (!entry || typeof entry !== 'object') continue;
                    const event = String(entry.event || entry.type || '').toLowerCase();
                    if (event !== 'project_reopened_for_edits') continue;
                    const ms = window.firstMeasureParseClaimTimestamp(entry.ts || entry.at || entry.created_at);
                    if (ms !== null && (latest === null || ms > latest)) latest = ms;
                }
            }
            return latest;
        };

        window.firstMeasureFindClaimStartedAt = function(manifest) {
            if (!manifest || typeof manifest !== 'object') return null;

            const workflow = manifest.workflow && typeof manifest.workflow === 'object' ? manifest.workflow : {};
            const assignedTo = workflow.assigned_to && typeof workflow.assigned_to === 'object' ? workflow.assigned_to : {};
            const latestReopenMs = window.firstMeasureFindLatestReopenMs(manifest);
            const candidates = [
                manifest.assigned_at,
                manifest.claimed_at,
                manifest.technician_claimed_at,
                workflow.assigned_at,
                workflow.claimed_at,
                assignedTo.assigned_at,
                assignedTo.claimed_at,
                manifest.started_at,
                workflow.started_at
            ];

            let earliestPostReopenClaimMs = null;
            for (const candidate of candidates) {
                const ms = window.firstMeasureParseClaimTimestamp(candidate);
                if (ms !== null && (latestReopenMs === null || ms >= latestReopenMs)) {
                    if (earliestPostReopenClaimMs === null || ms < earliestPostReopenClaimMs) earliestPostReopenClaimMs = ms;
                }
            }

            const histories = [manifest.work_history, manifest.technician_history, workflow.history];
            for (const history of histories) {
                if (!Array.isArray(history)) continue;
                for (const entry of history) {
                    if (!entry || typeof entry !== 'object') continue;
                    const event = String(entry.event || entry.type || '').toLowerCase();
                    if (!event.includes('claim') && !event.includes('assign')) continue;
                    const ms = window.firstMeasureParseClaimTimestamp(entry.ts || entry.at || entry.created_at || entry.assigned_at || entry.claimed_at);
                    if (ms !== null && (latestReopenMs === null || ms >= latestReopenMs)) {
                        if (earliestPostReopenClaimMs === null || ms < earliestPostReopenClaimMs) earliestPostReopenClaimMs = ms;
                    }
                }
            }

            if (earliestPostReopenClaimMs !== null) return earliestPostReopenClaimMs;
            return null;
        };

        window.firstMeasureCollectTimerHistory = function(manifest) {
            if (!manifest || typeof manifest !== 'object') return [];
            const workflow = manifest.workflow && typeof manifest.workflow === 'object' ? manifest.workflow : {};
            const histories = [
                manifest.work_history,
                manifest.technician_history,
                workflow.work_history,
                workflow.history
            ];
            const seen = new Set();
            const output = [];

            for (const history of histories) {
                if (!Array.isArray(history)) continue;
                for (const entry of history) {
                    if (!entry || typeof entry !== 'object') continue;
                    const event = String(entry.event || entry.type || '').trim().toLowerCase();
                    const ms = window.firstMeasureParseClaimTimestamp(
                        entry.ts || entry.at || entry.created_at || entry.assigned_at || entry.claimed_at || entry.submitted_at
                    );
                    if (!event || ms === null) continue;
                    const key = `${event}:${ms}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    output.push({ event, ms });
                }
            }

            output.sort((a, b) => a.ms - b.ms);
            return output;
        };

        window.firstMeasureBuildClaimTiming = function(manifest, startMs) {
            if (startMs === null) return null;

            const status = String(manifest && manifest.status || '').trim().toLowerCase();
            const workflow = manifest && typeof manifest.workflow === 'object' ? manifest.workflow : {};
            const timestamps = manifest && typeof manifest.timestamps === 'object' ? manifest.timestamps : {};
            const pauseEvents = new Set(['submitted_for_qa', 'correction_submitted']);
            const resumeEvents = new Set(['qa_sent_back_to_tech', 'manager_sent_back_to_tech']);
            const reviewStatuses = new Set(['awaiting_review', 'awaiting_manager_review']);
            const events = window.firstMeasureCollectTimerHistory(manifest)
                .filter((entry) => entry.ms >= startMs)
                .map((entry) => {
                    if (pauseEvents.has(entry.event)) return { type: 'pause', ms: entry.ms };
                    if (resumeEvents.has(entry.event)) return { type: 'resume', ms: entry.ms };
                    return null;
                })
                .filter(Boolean);

            const uploadedMs = window.firstMeasureParseClaimTimestamp(
                manifest && (manifest.uploaded_at || timestamps.uploaded_at)
            );
            const hasPauseEvent = events.some((entry) => entry.type === 'pause');
            const hasResumeEvent = events.some((entry) => entry.type === 'resume');
            if (uploadedMs !== null && uploadedMs >= startMs && (!hasPauseEvent || (reviewStatuses.has(status) && !hasResumeEvent))) {
                events.push({ type: 'pause', ms: uploadedMs });
            }

            events.sort((a, b) => a.ms - b.ms);

            let totalPausedMs = 0;
            let pausedAtMs = null;
            for (const entry of events) {
                if (entry.type === 'pause') {
                    if (pausedAtMs === null) pausedAtMs = entry.ms;
                    continue;
                }
                if (entry.type === 'resume' && pausedAtMs !== null) {
                    totalPausedMs += Math.max(0, entry.ms - pausedAtMs);
                    pausedAtMs = null;
                }
            }

            if (!reviewStatuses.has(status)) {
                pausedAtMs = null;
            }

            return {
                startMs,
                totalPausedMs,
                pausedAtMs
            };
        };

        window.firstMeasureGetActiveElapsedMs = function(timing) {
            if (!timing) return 0;
            const endMs = timing.pausedAtMs !== null ? timing.pausedAtMs : Date.now();
            return Math.max(0, endMs - timing.startMs - timing.totalPausedMs);
        };

        window.firstMeasureResolveProjectPoints = function(manifest) {
            if (!manifest || typeof manifest !== 'object') return null;
            const direct = Number(
                manifest.point_value
                ?? manifest.project_points
                ?? manifest.points_value
                ?? manifest.points
            );
            if (Number.isFinite(direct) && direct > 0) return direct;

            const rawComplexity = String(manifest.complexity ?? '').trim().toLowerCase();
            if (!rawComplexity) return null;
            const normalized = rawComplexity
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');
            const numericComplexity = Number(rawComplexity);
            const key = Number.isFinite(numericComplexity) ? numericComplexity : normalized;
            const mapped = window.FIRSTMEASURE_COMPLEXITY_POINTS[key];
            return Number.isFinite(mapped) && mapped > 0 ? mapped : null;
        };

        window.firstMeasureBuildTimeline = function(points) {
            if (!Number.isFinite(points) || points <= 0) return null;
            const sectionMinutes = [6 * points, 3 * points, 3 * points, 6 * points];
            const boundariesMs = [];
            let runningMs = 0;
            for (const minutes of sectionMinutes) {
                runningMs += minutes * 60 * 1000;
                boundariesMs.push(runningMs);
            }
            return {
                totalMs: runningMs,
                boundariesMs,
                sectionMinutes,
                markerWidth: 360
            };
        };

        window.firstMeasureFormatTimelineLabel = function(ms) {
            if (!Number.isFinite(ms) || ms <= 0) return '0';
            const totalMinutes = Math.round(ms / 60000);
            if (totalMinutes < 60) return String(totalMinutes);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            return `${hours}:${String(minutes).padStart(2, '0')}`;
        };

        window.firstMeasureTimelineZone = function(elapsedMs, timeline) {
            if (!timeline || !Array.isArray(timeline.boundariesMs)) return null;
            const zones = ['green', 'yellow', 'orange', 'red'];
            for (let i = 0; i < timeline.boundariesMs.length; i++) {
                if (elapsedMs <= timeline.boundariesMs[i]) return zones[i];
            }
            return 'expired';
        };

        window.firstMeasureSetTimerZone = function(el, zone) {
            if (!el) return;
            el.classList.remove('zone-green', 'zone-yellow', 'zone-orange', 'zone-red', 'zone-expired');
            if (zone) el.classList.add(`zone-${zone}`);
        };

        window.firstMeasureRenderTimelineLabels = function(timeline) {
            const labels = document.getElementById('claimTimelineLabels');
            if (!labels || !timeline) return;
            const boundaryValues = [0, ...timeline.boundariesMs];
            labels.innerHTML = boundaryValues.map((ms) => {
                const pct = timeline.totalMs > 0 ? Math.max(0, Math.min(100, (ms / timeline.totalMs) * 100)) : 0;
                return `<span class="claim-timeline-label" style="left:${pct}%">${window.firstMeasureFormatTimelineLabel(ms)}</span>`;
            }).join('');
        };

        window.firstMeasureFormatSectionDuration = function(minutes) {
            if (!Number.isFinite(minutes)) return '0 min';
            if (minutes < 60) return `${Math.round(minutes)} min`;
            const hours = Math.floor(minutes / 60);
            const mins = Math.round(minutes % 60);
            return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
        };

        window.firstMeasureRenderTimelineTooltip = function(sectionIndex, anchorX) {
            const state = window.firstMeasureClaimTimerState;
            const tooltip = document.getElementById('claimTimelineTooltip');
            if (!tooltip || !state.timeline || !Number.isFinite(state.points)) return;

            const idx = Math.max(0, Math.min(3, Number(sectionIndex) || 0));
            const endpointMs = state.timeline.boundariesMs[idx] || 0;
            const rate = window.FIRSTMEASURE_TIMELINE_PESO_RATES[idx] || 0;
            const total = Math.round(state.points * rate);
            tooltip.innerHTML = [
                `<div>By ${window.firstMeasureFormatSectionDuration(endpointMs / 60000)}</div>`,
                `<div>${state.points} project points</div>`,
                `<div>&#8369;${rate} per point</div>`,
                `<span class="claim-timeline-tooltip-total">&#8369;${total}</span>`,
                idx === 3 ? `<div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.22); color:#fca5a5; font-weight:950;">After full time: &#8369;5 per point</div>` : '',
                (window.firstMeasureRushModeState && window.firstMeasureRushModeState.activeId)
                    ? `<div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.22); color:#fdba74; font-weight:950;">Rush Mode Bonus: +25%</div>`
                    : ''
            ].join('');
            tooltip.style.left = `${Math.max(8, Math.min(352, anchorX))}px`;
            tooltip.classList.add('active');
        };

        window.firstMeasureHideTimelineTooltip = function() {
            const tooltip = document.getElementById('claimTimelineTooltip');
            if (tooltip) tooltip.classList.remove('active');
        };

        window.firstMeasureBindTimelineTooltips = function() {
            const timeline = document.getElementById('claimTimeline');
            if (!timeline || timeline.dataset.tooltipsBound === '1') return;
            timeline.dataset.tooltipsBound = '1';

            timeline.querySelectorAll('.claim-timeline-section').forEach((section) => {
                section.addEventListener('mouseenter', (event) => {
                    const rect = timeline.getBoundingClientRect();
                    const sectionRect = section.getBoundingClientRect();
                    window.firstMeasureRenderTimelineTooltip(
                        section.dataset.sectionIndex,
                        sectionRect.left + (sectionRect.width / 2) - rect.left
                    );
                });
                section.addEventListener('mousemove', (event) => {
                    const rect = timeline.getBoundingClientRect();
                    window.firstMeasureRenderTimelineTooltip(
                        section.dataset.sectionIndex,
                        event.clientX - rect.left
                    );
                });
                section.addEventListener('mouseleave', window.firstMeasureHideTimelineTooltip);
            });
        };

        window.firstMeasureFormatElapsed = function(elapsedMs) {
            const safeMs = Math.max(0, Math.floor(elapsedMs));
            const hundredths = Math.floor((safeMs % 1000) / 10);
            const totalSeconds = Math.floor(safeMs / 1000);
            const seconds = totalSeconds % 60;
            const totalMinutes = Math.floor(totalSeconds / 60);
            const minutes = totalMinutes % 60;
            const hours = Math.floor(totalMinutes / 60);

            return [
                String(hours).padStart(2, '0'),
                String(minutes).padStart(2, '0'),
                String(seconds).padStart(2, '0')
            ].join(':') + '.' + String(hundredths).padStart(2, '0');
        };

        window.firstMeasureStopClaimTimer = function() {
            const state = window.firstMeasureClaimTimerState;
            if (state.frameId !== null) {
                cancelAnimationFrame(state.frameId);
                state.frameId = null;
            }
        };

        window.firstMeasureRenderClaimTimer = function() {
            const state = window.firstMeasureClaimTimerState;
            const el = document.getElementById('claimElapsedTimer');
            const marker = document.getElementById('claimTimelineMarker');
            if (!el || state.startMs === null || !state.timing) return;

            const elapsedMs = window.firstMeasureGetActiveElapsedMs(state.timing);
            el.textContent = window.firstMeasureFormatElapsed(elapsedMs);
            window.firstMeasureSetTimerZone(el, window.firstMeasureTimelineZone(elapsedMs, state.timeline));
            if (state.timeline && elapsedMs > state.timeline.totalMs) {
                el.title = 'Elapsed since project claim (full time expired: 5 PHP per point)';
            } else {
                el.title = 'Elapsed since project claim';
            }
            if (marker && state.timeline) {
                const progress = state.timeline.totalMs > 0 ? Math.max(0, Math.min(1, elapsedMs / state.timeline.totalMs)) : 0;
                marker.style.transform = `translate3d(${(progress * state.timeline.markerWidth) - 0.5}px, 0, 0)`;
            }
            if (state.timing.pausedAtMs === null) {
                state.frameId = requestAnimationFrame(window.firstMeasureRenderClaimTimer);
            } else {
                state.frameId = null;
            }
        };

        window.firstMeasureHasCustomerReworkRequest = function(manifest) {
            if (!manifest || typeof manifest !== 'object') return false;
            if (Array.isArray(manifest.report_change_requests) && manifest.report_change_requests.length > 0) return true;
            return !!(manifest.latest_report_change_request && typeof manifest.latest_report_change_request === 'object');
        };

        window.firstMeasureShouldHideClaimTimer = function(manifest) {
            if (!window.firstMeasureHasCustomerReworkRequest(manifest)) return false;
            const status = window.firstMeasureNormalizeProjectStatus(manifest && manifest.status);
            return [
                'rework_requested',
                'reworking',
                'customer_rework_requested',
                'completed'
            ].includes(status);
        };

        window.firstMeasureSetClaimTimerVisible = function(visible) {
            const statusBox = document.querySelector('.claim-status');
            const el = document.getElementById('claimElapsedTimer');
            const timelineEl = document.getElementById('claimTimeline');
            const marker = document.getElementById('claimTimelineMarker');
            if (statusBox) statusBox.style.display = visible ? '' : 'none';
            if (!visible) {
                window.firstMeasureStopClaimTimer();
                if (el) {
                    el.textContent = '--:--:--.--';
                    el.classList.add('waiting');
                    window.firstMeasureSetTimerZone(el, null);
                    el.title = 'Timer disabled for customer rework';
                }
                if (timelineEl) {
                    timelineEl.classList.remove('active');
                    window.firstMeasureHideTimelineTooltip();
                }
                if (marker) marker.style.transform = 'translate3d(-0.5px, 0, 0)';
                window.firstMeasureClaimTimerState.startMs = null;
                window.firstMeasureClaimTimerState.points = null;
                window.firstMeasureClaimTimerState.timeline = null;
                window.firstMeasureClaimTimerState.timing = null;
            }
        };

        window.firstMeasureUpdateClaimTimer = function(manifest) {
            const el = document.getElementById('claimElapsedTimer');
            const timelineEl = document.getElementById('claimTimeline');
            const marker = document.getElementById('claimTimelineMarker');
            if (window.firstMeasureShouldHideClaimTimer(manifest)) {
                window.firstMeasureSetClaimTimerVisible(false);
                return;
            }
            window.firstMeasureSetClaimTimerVisible(true);
            const startMs = window.firstMeasureFindClaimStartedAt(manifest);
            const points = window.firstMeasureResolveProjectPoints(manifest);
            const timeline = window.firstMeasureBuildTimeline(points);
            const timing = window.firstMeasureBuildClaimTiming(manifest, startMs);

            window.firstMeasureStopClaimTimer();
            window.firstMeasureClaimTimerState.startMs = startMs;
            window.firstMeasureClaimTimerState.points = points;
            window.firstMeasureClaimTimerState.timeline = timeline;
            window.firstMeasureClaimTimerState.timing = timing;

            if (!el) return;
            if (startMs === null) {
                el.textContent = '--:--:--.--';
                el.classList.add('waiting');
                window.firstMeasureSetTimerZone(el, null);
                el.title = 'Elapsed since project claim';
                if (timelineEl) timelineEl.classList.remove('active');
                return;
            }

            el.classList.remove('waiting');
            el.title = 'Elapsed since project claim';
            if (timelineEl && timeline) {
                timelineEl.classList.add('active');
                timelineEl.removeAttribute('title');
                window.firstMeasureRenderTimelineLabels(timeline);
                window.firstMeasureBindTimelineTooltips();
                if (marker) marker.style.transform = 'translate3d(-0.5px, 0, 0)';
            } else if (timelineEl) {
                timelineEl.classList.remove('active');
                window.firstMeasureHideTimelineTooltip();
            }
            window.firstMeasureRenderClaimTimer();
        };

        window.firstMeasureFindProjectByAddress = async function(address) {
            return window.firstMeasureFetchJson('/projects/find-by-address', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address })
            });
        };

        window.firstMeasureClaimNextCompat = async function(extra = {}) {
            const payload = {
                action: 'claim_next_for_me',
                actor_email: String(window.FIRSTMEASURE_ACTOR?.email || ''),
                actor_name: String(window.FIRSTMEASURE_ACTOR?.name || ''),
                actor_role: String(window.FIRSTMEASURE_ACTOR?.role || '')
            };
            if (extra && typeof extra === 'object') {
                Object.keys(extra).forEach((key) => {
                    const value = extra[key];
                    if (value === undefined || value === null || typeof value === 'object') return;
                    payload[key] = String(value);
                });
            }
            const v1Base = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
            const endpoint = `${v1Base}/internal/legacy-action`;
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const text = await resp.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch (e) {
                throw new Error('Next project request returned an invalid response.');
            }
            if (!resp.ok || !data || data.success === false) {
                throw new Error((data && (data.error || data.message)) || 'No project available.');
            }
            return data;
        };

        window.firstMeasureRecordReopenedProjectClaim = async function(projectId) {
            if (!projectId) return null;
            try {
                const v1Base = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
                const payload = {
                    action: 'record_reopened_project_claim',
                    folder: String(projectId),
                    actor_email: String(window.FIRSTMEASURE_ACTOR?.email || ''),
                    actor_name: String(window.FIRSTMEASURE_ACTOR?.name || ''),
                    actor_role: String(window.FIRSTMEASURE_ACTOR?.role || '')
                };
                const resp = await fetch(`${v1Base}/internal/legacy-action`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const text = await resp.text();
                let data = null;
                try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
                if (!resp.ok || !data || data.success === false) {
                    console.warn('[FirstMeasure] Reopen claim tracking was not saved:', data && (data.error || data.reason) || text);
                    return null;
                }
                return data;
            } catch (e) {
                console.warn('[FirstMeasure] Failed to record reopened project claim:', e);
                return null;
            }
        };

        window.firstMeasureMaybeClaimReservedProject = async function(projectId, manifest) {
            try {
                const params = new URLSearchParams(window.location.search || '');
                const isHeadlessEmbedded = params.has('qa_embed')
                    || params.has('headless')
                    || (params.has('embedded') && (params.has('hide_header') || params.has('hideHeader') || params.has('no_header')));
                if (isHeadlessEmbedded) return manifest;
            } catch (e) {}
            const actorEmail = String(window.FIRSTMEASURE_ACTOR?.email || '').trim().toLowerCase();
            if (!actorEmail || !projectId || !manifest || typeof manifest !== 'object') return manifest;

            const workflow = manifest.workflow && typeof manifest.workflow === 'object' ? manifest.workflow : {};
            const assigned = String(
                manifest.assigned_to_email
                || (workflow.assigned_to && workflow.assigned_to.email)
                || ''
            ).trim().toLowerCase();
            const reserved = String(
                manifest.reserved_to_email
                || (workflow.reserved_to && workflow.reserved_to.email)
                || ''
            ).trim().toLowerCase();
            const status = window.firstMeasureNormalizeProjectStatus(manifest.status);
            const claimableStatuses = new Set(['queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue']);

            if (assigned || !claimableStatuses.has(status)) return manifest;
            if (reserved !== actorEmail) return manifest;

            try {
                const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/queue/claim`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ actor: window.FIRSTMEASURE_ACTOR || {} })
                });
                const claimedManifest =
                    (data && typeof data === 'object' && data.manifest && typeof data.manifest === 'object') ? data.manifest :
                    (data && typeof data === 'object' && data.project && data.project.manifest && typeof data.project.manifest === 'object') ? data.project.manifest :
                    (data && typeof data === 'object' && data.project && typeof data.project === 'object') ? data.project :
                    null;
                if (claimedManifest) {
                    window.currentProjectManifest = claimedManifest;
                    if (Array.isArray(claimedManifest.resubmissions) && claimedManifest.resubmissions.length > 0) {
                        const tracking = await window.firstMeasureRecordReopenedProjectClaim(projectId);
                        if (tracking && tracking.project && typeof tracking.project === 'object') {
                            window.currentProjectManifest = tracking.project;
                            return tracking.project;
                        }
                    }
                    return claimedManifest;
                }
            } catch (e) {
                console.warn('[FirstMeasure] Failed to auto-claim reserved project:', e);
            }

            return manifest;
        };

        window.loadProjectOrganizationContext = async function(projectId) {
            try {
                const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/editor`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });
                return data && data.organization ? data.organization : null;
            } catch (e) {
                console.warn('[Project Org] Failed to load organization context:', e);
                return null;
            }
        };

        // --- DIRECT ADDRESS ANALYSIS LOGIC ---

        function copyAddressToClipboard(el) {
            const original = el.value;
            if (!original) return;

            navigator.clipboard.writeText(original).then(() => {
                // Visual confirmation
                el.value = "Copied!";
                el.style.opacity = "0.6";

                setTimeout(() => {
                    el.value = original;
                    el.style.opacity = "1";
                }, 700);
            });
        }

        function setAddressModeLocked(isLocked) {
            const editableWrap = document.getElementById('addrEditableWrap');
            const lockedWrap   = document.getElementById('addrLockedWrap');

            const editableInput = document.getElementById('manualAddress');
            const lockedInput   = document.getElementById('manualAddressLocked');

            const hidden = document.getElementById('addressInput');

            if (!editableWrap || !lockedWrap) return;

            editableWrap.style.display = isLocked ? 'none' : 'flex';
            lockedWrap.style.display   = isLocked ? 'flex' : 'none';

            // keep values in sync
            const val = (editableInput && editableInput.value) ? editableInput.value : (lockedInput ? lockedInput.value : '');
            if (editableInput && editableInput.value !== val) editableInput.value = val;
            if (lockedInput && lockedInput.value !== val) lockedInput.value = val;
            if (hidden && hidden.value !== val) hidden.value = val;
            }

            // Replace your existing setHeaderAddress with this version (drop-in)
        function setHeaderAddress(addr) {
            const a = (addr || '').trim();
            if (!a) return;

            const editable = document.getElementById('manualAddress');
            const locked   = document.getElementById('manualAddressLocked');
            const hidden   = document.getElementById('addressInput');

            if (editable) editable.value = a;
            if (locked) locked.value = a;
            if (hidden) hidden.value = a;
            }

            // Detect “redirected/autoload” intent
            function shouldLockAddressUI() {
            // 1) LocalStorage autoload (your existing pattern)
            const autoLoad = localStorage.getItem('autoLoadProject');
            if (autoLoad) return true;

            // 2) URL hints (optional but handy if you ever do redirects)
            const qs = new URLSearchParams(location.search);
            if (qs.get('folder')) return true;   // ex: editor.php?folder=abcd...
            if (qs.get('address')) return true;  // ex: editor.php?address=...
            if (qs.get('autoload') === '1') return true;

            return false;
            }

        // Call this once as soon as the editor DOM is ready. Waiting for window
        // load also waits on async map/CDN assets, which delays project autoload.
        function firstMeasureInitializeAddressChrome() {
            setAddressModeLocked(shouldLockAddressUI());
            if (typeof window.firstMeasureStartRushModePolling === 'function') {
                window.firstMeasureStartRushModePolling();
            }

            // If someone passed address in URL, populate it (and keep locked if that’s your intent)
            const qs = new URLSearchParams(location.search);
            const addr = (qs.get('address') || '').trim();
            if (addr) setHeaderAddress(addr);
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', firstMeasureInitializeAddressChrome, { once: true });
        } else {
            firstMeasureInitializeAddressChrome();
        }

        async function handleDirectAnalysis() {
            const addr = document.getElementById('manualAddress').value;
            if (!addr) return alert("Please enter an address.");

            // Show Loading
            document.getElementById('loadingOverlay').style.display = 'flex';
            document.getElementById('addressInput').value = addr;

            try {
                const data = await window.firstMeasureFetchJson('/projects/queue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address: addr,
                        issuer: {
                            name: '<?php echo addslashes($userName); ?>',
                            email: window.FIRSTMEASURE_ACTOR.email || ''
                        },
                        owner_ref: {
                            name: '<?php echo addslashes($userName); ?>',
                            email: window.FIRSTMEASURE_ACTOR.email || ''
                        },
                        resident: {
                            name: 'Homeowner'
                        },
                        process_async: false
                    })
                });

                if (data.success) {
                    await loadProjectFromFolder(data.folder);
                    
                    // ADD THIS CHECK HERE:
                    if (autoRunGemini) {
                        handleGenerateMeasurements(); 
                    }
                    
                    activateStep(1);
                    document.getElementById('loadingOverlay').style.display = 'none';
                } else {
                    throw new Error(data.error || "Server creation failed");
                }
            } catch (e) {
                console.error(e);
                alert("Analysis failed: " + e.message);
                document.getElementById('loadingOverlay').style.display = 'none';
            }
        }

        // --- UI HELPERS ---

        function activateStep(n) {
            // 1. Loop updated to 6 steps
            for(let i=1; i<=6; i++) {
                const el = document.getElementById('step'+i);
                if(el) {
                    el.classList.remove('active', 'done');
                    if(i < n) el.classList.add('done');
                    if(i === n) el.classList.add('active');
                }
            }

            // 2. UPDATED: Measure Step Logic
            // Use toggleLineTypes() instead of handleGenerateMeasurements()
            // to prevent overwriting existing line classifications.
            if(n === 2) {
                if (typeof toggleLineTypes === 'function') {
                    toggleLineTypes();
                } else if (typeof handleGenerateMeasurements === 'function') {
                    // Fallback only if measurements.js isn't fully loaded
                    handleGenerateMeasurements();
                }
            }

            // 3. Handle Configuration Mode
            if(n === 5) {
                if(typeof openReportConfiguration === 'function') {
                    openReportConfiguration();
                } else {
                    console.error("Report configuration not loaded.");
                }
            } else {
                if(typeof closeReportConfig === 'function') {
                    closeReportConfig();
                }
            }
        }

        // NEW FUNCTION
        function handleConfigureStep() {
            // Optional: Check if Quad View (Step 4) is done before allowing entry
            if(!window.quadViewCroppedImage && !(typeof window.firstMeasureAreQuadViewsDisabled === 'function' && window.firstMeasureAreQuadViewsDisabled())) {
                // Optional: Alert user they skipped a step, or just let them proceed
                console.warn("Quad View not generated yet.");
            }
            activateStep(5);
        }

        function launchQuadViewStep() {
            if (typeof window.firstMeasureAreQuadViewsDisabled === 'function' && window.firstMeasureAreQuadViewsDisabled()) {
                return;
            }
            if (window.__quadTiltAvailable !== true) {
                const msg = window.__quadTiltAvailable === false
                    ? "Quad view is unavailable for this property because Google did not return all four oblique angles."
                    : "Quad view availability is still being checked. Try again in a moment.";
                alert(msg);
                return;
            }
            activateStep(4);
            launchQuadView();
        }

        async function handleSubmitReport() {
            // Open the report configuration panel and jump to the finalize page
            activateStep(5);

            setTimeout(() => {
                if (typeof goToFinalizePage === 'function') {
                    goToFinalizePage();
                }
            }, 100);
        }


        // Resizer Logic
        const resizer = document.getElementById('dragResizer');
        const leftCol = document.getElementById('leftColumn');
        const workspace = document.getElementById('workspace');
        let isResizing = false;
        resizer.addEventListener('mousedown', (e) => { isResizing=true; document.body.style.cursor='col-resize'; e.preventDefault(); });
        window.addEventListener('mousemove', (e) => {
            if(isResizing) {
                const w = (e.clientX / workspace.clientWidth) * 100;
                if(w>20 && w<80) leftCol.style.setProperty('width', w+'%');
                window.dispatchEvent(new Event('resize'));
            }
        });
        window.addEventListener('mouseup', () => { 
            if(isResizing) { isResizing=false; document.body.style.cursor='default'; window.dispatchEvent(new Event('resize')); }
        });

        // NEW: Resizer Logic (Vertical for Right Column)
        const vResizer = document.getElementById('verticalResizer');
        const topView = document.getElementById('three-view-wrapper');
        const bottomView = document.getElementById('google-earth-wrapper');
        const rightCol = document.getElementById('rightColumn');
        let isResizingV = false;
        const DEFAULT_RIGHT_SPLIT_RATIO = 0.5;
        let rightSplitRatio = DEFAULT_RIGHT_SPLIT_RATIO;
        let rightSplitSyncFrame = 0;

        function clampRightSplitRatio(value) {
            return Math.min(0.85, Math.max(0.15, value));
        }

        function applyRightColumnSplit(nextRatio = rightSplitRatio) {
            if (!topView || !rightCol) return;
            const resizerHeight = vResizer ? (vResizer.offsetHeight || 8) : 0;
            const availableHeight = rightCol.clientHeight - resizerHeight;
            if (availableHeight <= 100) return;

            rightSplitRatio = clampRightSplitRatio(nextRatio);
            const topHeight = Math.round(availableHeight * rightSplitRatio);

            topView.style.flex = `0 0 ${topHeight}px`;
            topView.style.height = `${topHeight}px`;

            if (bottomView) {
                bottomView.style.flex = '1 1 0';
                bottomView.style.minHeight = '0';
            }
        }

        function queueRightColumnSplitSync() {
            if (rightSplitSyncFrame) return;
            rightSplitSyncFrame = requestAnimationFrame(() => {
                rightSplitSyncFrame = 0;
                applyRightColumnSplit();
            });
        }

        window.syncRightColumnSplit = queueRightColumnSplitSync;

        queueRightColumnSplitSync();
        window.addEventListener('load', queueRightColumnSplitSync);
        window.addEventListener('resize', queueRightColumnSplitSync);

        if (typeof ResizeObserver !== 'undefined' && rightCol) {
            const rightColumnResizeObserver = new ResizeObserver(() => {
                queueRightColumnSplitSync();
            });
            rightColumnResizeObserver.observe(rightCol);
        }

        vResizer.addEventListener('mousedown', (e) => { 
            isResizingV = true; 
            document.body.style.cursor = 'row-resize'; 
            e.preventDefault(); 
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizingV) return;
            
            // Calculate height relative to the container top
            const containerRect = rightCol.getBoundingClientRect();
            const relativeY = e.clientY - containerRect.top;
            const resizerHeight = vResizer ? (vResizer.offsetHeight || 8) : 0;
            const availableHeight = containerRect.height - resizerHeight;
            
            // Constrain size (min 50px for top and bottom)
            if (availableHeight > 100 && relativeY > 50 && relativeY < containerRect.height - 50) {
                rightSplitRatio = clampRightSplitRatio(relativeY / availableHeight);
                applyRightColumnSplit(rightSplitRatio);
                window.dispatchEvent(new Event('resize'));
            }
        });

        window.addEventListener('mouseup', () => {
            if (isResizingV) {
                isResizingV = false;
                document.body.style.cursor = 'default';
                window.dispatchEvent(new Event('resize'));
            }
        });

        if (typeof window.loadProjectFromFolder === 'function') {
            const baseLoadProjectFromFolder = window.loadProjectFromFolder;
            const editorQs = new URLSearchParams(window.location.search || '');
            const isQaEditorEmbed = editorQs.has('qa_embed');
            let qaEmbedPdfOpenPromise = null;
            function applyQaEditorEmbedDefaults() {
                if (!isQaEditorEmbed) return;
                if (editorQs.has('qa_line_mode')) {
                    try {
                        if (typeof enterMeasurementMode === 'function') {
                            enterMeasurementMode();
                        } else if (typeof toggleLineTypes === 'function' && typeof isMeasurementMode !== 'undefined' && !isMeasurementMode) {
                            toggleLineTypes();
                        }
                        if (typeof selectionMode !== 'undefined') selectionMode = 'LINE';
                        const lbl = document.getElementById('modeLabel') || document.getElementById('selectionModeLabel');
                        if (lbl) lbl.textContent = 'LINE MODE';
                        if (typeof renderGeometry2D === 'function') renderGeometry2D();
                    } catch (e) {
                        console.warn('[QA Embed] Failed to apply line mode defaults:', e);
                    }
                }
                if (editorQs.has('qa_open_pdf')) {
                    if (qaEmbedPdfOpenPromise) return;
                    try {
                        const afterOpen = () => setTimeout(() => {
                            if (typeof goToFinalizePage === 'function') goToFinalizePage();
                        }, 120);
                        if (typeof openReportConfiguration === 'function') {
                            qaEmbedPdfOpenPromise = Promise.resolve(openReportConfiguration())
                                .then(afterOpen)
                                .catch((e) => {
                                    console.warn('[QA Embed] Failed to open PDF configuration:', e);
                                    qaEmbedPdfOpenPromise = null;
                                    afterOpen();
                                });
                        } else {
                            afterOpen();
                        }
                    } catch (e) {
                        console.warn('[QA Embed] Failed to open PDF configuration:', e);
                    }
                }
            }
            window.firstMeasureApplyQaEditorEmbedDefaults = applyQaEditorEmbedDefaults;
            window.loadProjectFromFolder = async function() {
                const result = await baseLoadProjectFromFolder.apply(this, arguments);
                const isTutorialMode = !!(window.FIRSTMEASURE_TUTORIAL && window.FIRSTMEASURE_TUTORIAL.enabled);
                if (!isTutorialMode && typeof window.firstMeasureMaybeClaimReservedProject === 'function') {
                    const claimedManifest = await window.firstMeasureMaybeClaimReservedProject(
                        window.currentProjectId || arguments[0],
                        window.currentProjectManifest || null
                    );
                    if (claimedManifest && typeof claimedManifest === 'object') {
                        window.currentProjectManifest = claimedManifest;
                    }
                }
                if (isTutorialMode && typeof window.firstMeasureStartTutorialTimer === 'function') {
                    window.firstMeasureStartTutorialTimer(true);
                } else if (typeof window.firstMeasureUpdateClaimTimer === 'function') {
                    window.firstMeasureUpdateClaimTimer(window.currentProjectManifest || null);
                }
                queueRightColumnSplitSync();
                setTimeout(queueRightColumnSplitSync, 0);
                setTimeout(queueRightColumnSplitSync, 250);
                setTimeout(queueRightColumnSplitSync, 750);
                setTimeout(applyQaEditorEmbedDefaults, 180);
                setTimeout(applyQaEditorEmbedDefaults, 700);
                return result;
            };
        }

        if (typeof window.startAnalysis === 'function') {
            const baseStartAnalysis = window.startAnalysis;
            window.startAnalysis = async function() {
                const result = await baseStartAnalysis.apply(this, arguments);
                queueRightColumnSplitSync();
                setTimeout(queueRightColumnSplitSync, 0);
                setTimeout(queueRightColumnSplitSync, 250);
                setTimeout(queueRightColumnSplitSync, 750);
                return result;
            };
        }

        function switchTab(t) {
            document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(e=>e.classList.remove('active'));
            document.getElementById('tab-'+t).classList.add('active');
            // Simplified button toggling
            const btns = document.querySelectorAll('.tab-btn');
            if(t==='view2d') btns[0].classList.add('active'); else btns[1].classList.add('active');
        }

        function firstMeasureAutoLoadRequestedProject() {
            const autoLoad = localStorage.getItem('autoLoadProject');
            if (autoLoad) {
                setAddressModeLocked(true);
                localStorage.removeItem('autoLoadProject');
                console.log("Auto-loading project:", autoLoad);
                loadProjectFromFolder(autoLoad);
            }
            
            // NEW: Support ?folder= query param (for QA mirror / external links)
            const qs = new URLSearchParams(location.search);
            const folderParam = qs.get('folder');
            if (folderParam && !autoLoad) {
                setAddressModeLocked(true);
                console.log("Loading project from URL param:", folderParam);
                loadProjectFromFolder(folderParam);
            }
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', firstMeasureAutoLoadRequestedProject, { once: true });
        } else {
            firstMeasureAutoLoadRequestedProject();
        }

        window.updateToolbarLayout = function() {
            const toolbar = document.getElementById('global-toolbar');
            if (!toolbar) return;

            toolbar.classList.remove('toolbar-split');
            const needsSplit = toolbar.scrollWidth > (toolbar.clientWidth + 1);

            toolbar.classList.toggle('toolbar-split', needsSplit);
        };

        window.addEventListener('load', () => {
            const toolbar = document.getElementById('global-toolbar');
            if (!toolbar) return;

            const refreshToolbarLayout = () => requestAnimationFrame(() => {
                if (typeof window.updateToolbarLayout === 'function') {
                    window.updateToolbarLayout();
                }
            });

            refreshToolbarLayout();
            window.addEventListener('resize', refreshToolbarLayout);

            if (typeof ResizeObserver !== 'undefined') {
                const toolbarResizeObserver = new ResizeObserver(refreshToolbarLayout);
                toolbarResizeObserver.observe(toolbar);
            }

            if (typeof MutationObserver !== 'undefined') {
                const toolbarMutationObserver = new MutationObserver(refreshToolbarLayout);
                toolbarMutationObserver.observe(toolbar, { childList: true, subtree: true, attributes: true, characterData: true });
            }
        });

    </script>
</body>
</html>
