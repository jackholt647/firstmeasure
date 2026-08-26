<?php
session_start();
require_once __DIR__ . '/../../internal/_storage.php';
require_once __DIR__ . '/../../internal/_permission_options.php';

if (!isset($_SESSION['user_email'])) {
    header("Location: ../../internal/backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
$currentUserName = trim((string)($_SESSION['user_name'] ?? $currentUserEmail));
$currentUserRole = strtolower(trim((string)($_SESSION['user_role'] ?? $_SESSION['role'] ?? '')));
$userData = [];

try {
    $userFile = storageDir('users') . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', $currentUserEmail) . '.json';
    if (is_file($userFile)) {
        $decoded = json_decode((string)file_get_contents($userFile), true);
        if (is_array($decoded)) $userData = $decoded;
    }
} catch (Throwable $e) {
    $userData = [];
}

if ($currentUserRole === '' && !empty($userData['role'])) {
    $currentUserRole = strtolower(trim((string)$userData['role']));
}
$perms = function_exists('permissionOptionsNormalizePermissions')
    ? permissionOptionsNormalizePermissions($userData['permissions'] ?? [], $currentUserRole ?: 'user')
    : ($userData['permissions'] ?? []);
$canUse = $currentUserRole === 'admin' || !empty($userData['is_admin']) || !empty($perms['is_admin_legacy']);
if (!$canUse) {
    http_response_code(403);
    echo 'Not authorized for the FirstMeasure Data Agent.';
    exit;
}

if (session_status() === PHP_SESSION_ACTIVE && function_exists('session_write_close')) session_write_close();

$host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
$localHost = in_array($host, ['127.0.0.1:8021', 'localhost:8021', '127.0.0.1', 'localhost'], true);
$apiBase = $localHost ? 'http://127.0.0.1:3111/v1' : '/v1';
$assetVersion = (string)time();
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FirstMeasure Data Agent</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    :root { --primary:#d93025; }
    html, body { margin:0; height:100%; font-family:'Montserrat-Regular', sans-serif; background:#eef2f5; }
  </style>
</head>
<body>
  <div id="dataAgentStandaloneMount" class="data-agent-standalone"></div>
  <script>
    window.PORTAL_CFG = {
      endpoints: {
        data_agent: <?= json_encode($apiBase . '/internal/legacy-action') ?>,
        portal: <?= json_encode($apiBase . '/internal/legacy-action') ?>,
        firstmeasure: <?= json_encode($apiBase . '/firstmeasure') ?>
      },
      flags: { can_data_agent: true },
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'user') ?>
      }
    };
  </script>
  <script src="../../internal/portal_scripts/data_agent.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
</body>
</html>
