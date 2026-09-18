<?php
require_once __DIR__ . '/_tutorials.php';
require_once __DIR__ . '/_permission_options.php';
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

