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
$currentUserData = [];

try {
    $userFile = storageDir('users') . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', $currentUserEmail) . '.json';
    if (is_file($userFile)) {
        $decoded = json_decode((string)file_get_contents($userFile), true);
        if (is_array($decoded)) {
            $currentUserData = $decoded;
        }
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

$isManager = in_array($currentUserRole, ['admin', 'manager', 'sales_manager', 'system_admin'], true)
    || !empty($_SESSION['user_is_admin'])
    || !empty($currentUserData['is_admin'])
    || !empty($currentPermissions['is_admin_legacy'])
    || !empty($currentPermissions['manage_users'])
    || !empty($currentPermissions['manage_sales_users'])
    || !empty($currentPermissions['view_all_projects']);

if (session_status() === PHP_SESSION_ACTIVE && function_exists('session_write_close')) {
    session_write_close();
}

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
  <title>FirstMeasure Sample Reports</title>
  <link rel="stylesheet" href="/fonts.css">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; font-family: 'Montserrat-Regular', sans-serif; background: #f6f7f9; color: #17202a; }
    body { overflow: auto; }
    #view-sample-reports { min-height: 100%; padding: 20px; }
    .header-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .header-bar h1 { margin: 0; font-size: 24px; line-height: 1.15; }
    .btn-secondary { border: 1px solid #d7dce7; background: #fff; color: #344054; border-radius: 8px; padding: 9px 12px; font-weight: 800; cursor: pointer; }
    .btn-secondary:hover { background: #f2f5f9; }
    :root { --primary: #d93025; --primary-rgb: 217,48,37; }
  </style>
</head>
<body>
  <main id="view-sample-reports"></main>

  <script>
    window.PORTAL_CFG = {
      endpoints: {
        sample_reports: <?= json_encode($apiBase . '/internal/sample-reports') ?>
      },
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'user') ?>
      },
      flags: {
        sample_reports_admin: <?= $isManager ? 'true' : 'false' ?>
      }
    };
    window.Portal = {
      cfg: window.PORTAL_CFG,
      escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
      }
    };
  </script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="../../internal/editor_scripts/pdf.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script src="../../internal/editor_scripts/pdf_standalone.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script src="scripts/sample_reports.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      if (window.SampleReports && typeof window.SampleReports.onShow === 'function') {
        window.SampleReports.onShow();
      }
    });
  </script>
</body>
</html>
