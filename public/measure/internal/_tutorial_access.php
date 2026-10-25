<?php
require_once __DIR__ . '/_tutorials.php';
require_once __DIR__ . '/_tutorial_courses.php';
require_once __DIR__ . '/_permission_options.php';
function fm_editor_internal_base_url() {
    $base = rtrim((string)fm_api_base_url(), '/');
    $internal = preg_replace('#/firstmeasure/?$#', '/internal', $base);
    if (is_string($internal) && $internal !== '' && $internal !== $base) return $internal;
    return rtrim($base, '/') . '/../internal';
}

function fm_editor_node_internal_user($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || fm_api_base_url() === '') return null;
    // Signed as the Node-verified staff member (includes/node_api.php).
    $res = fm_node_request('GET', rtrim(fm_editor_internal_base_url(), '/') . '/users/' . rawurlencode($email), ['timeout' => 8]);
    $data = $res['json'];
    return ($res['ok'] && is_array($data['user'] ?? null)) ? $data['user'] : null;
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

    $perms = fm_editor_user_permissions($sessionEmail);
    if (!empty($perms['manage_tutorials'])) {
        if ($requestedEmail === $sessionEmail) return $sessionEmail;
        if ($requestedEmail !== '') return $requestedEmail;
        $ownerEmail = fm_editor_tutorial_find_project_owner_email($tutorialId, $courseId);
        if ($ownerEmail !== '') return $ownerEmail;
        return $sessionEmail;
    }

    if ($requestedEmail === '' || $requestedEmail === $sessionEmail) {
        $user = fm_editor_node_internal_user($sessionEmail);
        // Resolve the actual stored course: omitting/changing the query must not bypass assignment.
        $found = $tutorialId !== '' ? fm_tutorial_find_project($tutorialId, $sessionEmail, $courseId) : null;
        $actualCourse = $found['course_id'] ?? ($courseId !== '' ? $courseId : 'default');
        if (is_array($user) && fm_tutorial_has_course($user, $actualCourse)) return $sessionEmail;
    }

    header('Content-Type: application/json');
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Unauthorized']);
    exit;
}

