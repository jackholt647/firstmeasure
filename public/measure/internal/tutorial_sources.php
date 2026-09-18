<?php
session_start();
session_write_close();
require_once __DIR__ . '/_tutorial_access.php';
header('Cache-Control: private, no-store');
if (empty($_SESSION['user_email'])) { http_response_code(401); exit('Login required.'); }
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (($_SERVER['HTTP_X_TUTORIAL_REQUEST'] ?? '') !== '1') { http_response_code(403); exit('Invalid request.'); }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || !in_array($body['operation'] ?? '', ['start', 'list', 'capability'], true)) { http_response_code(400); exit('Invalid operation.'); }
    $result = fm_tutorial_bridge($body);
    http_response_code($result['status']); header('Content-Type: application/json'); echo $result['body']; exit;
}
if (!in_array($_SERVER['REQUEST_METHOD'], ['GET','HEAD'], true)) { http_response_code(405); exit; }
$id = fm_tutorial_sanitize_project_id($_GET['tutorial_id'] ?? '');
$course = fm_tutorial_course_id_from_request();
$owner = fm_editor_tutorial_request_user_email($_SESSION['user_email'], $id, $course);
$name = (string)($_GET['name'] ?? '');
if (!$name) { http_response_code(400); exit; }
$result = fm_tutorial_source_request($id, $owner, $course, $name);
http_response_code($result['status']);
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: sandbox; default-src 'none'");
$types = ['png'=>'image/png', 'jpg'=>'image/jpeg', 'tif'=>'image/tiff', 'json'=>'application/json'];
header('Content-Type: ' . ($types[strtolower(pathinfo($name, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') echo $result['body'];
