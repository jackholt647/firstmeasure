<?php
session_start();
require_once __DIR__ . '/../internal/_storage.php';
require_once __DIR__ . '/../internal/_permission_options.php';

if (!isset($_SESSION['user_email'])) {
    header("Location: ../internal/backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
$currentUserName = trim((string)($_SESSION['user_name'] ?? $currentUserEmail));
$currentUserRole = strtolower(trim((string)($_SESSION['user_role'] ?? $_SESSION['role'] ?? '')));
$currentUserData = [];

try {
    $userFile = storageDir('users') . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', $currentUserEmail) . '.json';
    if (is_file($userFile)) {
        $decoded = json_decode((string)file_get_contents($userFile), true);
        if (is_array($decoded)) $currentUserData = $decoded;
    }
} catch (Throwable $e) {
    $currentUserData = [];
}

if ($currentUserRole === '' && !empty($currentUserData['role'])) {
    $currentUserRole = strtolower(trim((string)$currentUserData['role']));
}

$currentPermissions = function_exists('permissionOptionsNormalizePermissions')
    ? permissionOptionsNormalizePermissions($currentUserData['permissions'] ?? [], $currentUserRole ?: 'user')
    : ($currentUserData['permissions'] ?? []);

$isManager = in_array($currentUserRole, ['admin', 'manager', 'sales_manager'], true)
    || !empty($_SESSION['user_is_admin'])
    || !empty($currentUserData['is_admin'])
    || !empty($currentPermissions['is_admin_legacy'])
    || !empty($currentPermissions['manage_sales'])
    || !empty($currentPermissions['manage_crm']);

if (session_status() === PHP_SESSION_ACTIVE && function_exists('session_write_close')) {
    session_write_close();
}

$localHost = in_array(strtolower((string)($_SERVER['HTTP_HOST'] ?? '')), ['127.0.0.1:8021', 'localhost:8021'], true);
$apiBase = $localHost ? 'http://127.0.0.1:3111/v1' : '/v1';
$assetVersion = (string)time();
$leadId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($_GET['id'] ?? $_GET['lead_id'] ?? ''));
$cfg = [
    'apiBase' => $apiBase,
    'leadId' => $leadId,
    'user' => [
        'email' => $currentUserEmail,
        'name' => $currentUserName,
        'role' => $currentUserRole,
        'manager' => $isManager,
    ],
];
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lead Viewer</title>
  <link rel="stylesheet" href="styles/leads.css?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>">
</head>
<body class="lead-viewer-page">
  <main class="standalone-viewer">
    <header class="viewer-header">
      <div>
        <h2 id="viewer-title">Loading lead...</h2>
        <div id="viewer-subtitle" class="viewer-subtitle"></div>
      </div>
      <a class="toolbar-button" href="index.php">Back to Leads</a>
    </header>
    <div id="lead-viewer-body" class="viewer-body"></div>
  </main>
  <script>
    window.LEAD_VIEWER_CFG = <?= json_encode($cfg, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
  </script>
  <script src="scripts/lead_viewer.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
</body>
</html>
