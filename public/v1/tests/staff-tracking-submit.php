<?php
// Integration fixture: real project completion against a temporary tutorials root.
if (!getenv('MEASURE_INTERNAL_TUTORIALS_ROOT') || getenv('FIRSTMATE_ENV') !== 'test') exit(2);
if (!function_exists('curl_init')) { fwrite(STDERR, 'PHP curl extension is required for this integration test.'); exit(4); }
require_once __DIR__ . '/../../measure/internal/_tutorials.php';
require_once __DIR__ . '/../../measure/internal/_staff_tracking.php';
session_id('tracking-fixture-session');
$_SESSION = ['user_email' => 'trainee@tracking.example.test'];
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '8.8.8.8';
$_SERVER['HTTP_USER_AGENT'] = 'Chrome/1 Windows';
$result = fm_tutorial_mark_project_complete($argv[1], $_SESSION['user_email'], 'default');
if (empty($result['success']) || ($result['manifest']['status'] ?? '') !== 'tutorial_completed') exit(3);
fm_staff_tracking_submission($result, $_SESSION['user_email'], $argv[1]);
// A failed or non-completed result must not create another receipt.
fm_staff_tracking_submission(['success' => false], $_SESSION['user_email'], 'missing');
fm_staff_tracking_submission(['success' => true, 'manifest' => ['status' => 'tutorial_in_progress']], $_SESSION['user_email'], 'in-progress');
