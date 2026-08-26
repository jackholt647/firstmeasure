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
  <title>Customers</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; font-family: 'Montserrat-Regular', sans-serif; color: #17202a; background: #f6f7f9; }
    body { overflow: auto; }
    :root { --primary: #d93025; --primary-rgb: 217,48,37; }
    #portalPluginViews, #view-customers { min-height: 100%; }
    #view-customers { padding: 20px; }
    .header-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .header-bar h1 { margin: 0; font-size: 24px; }
    .btn-secondary, .btn-primary, .btn-danger { border: 1px solid #d7dce7; background: #fff; color: #344054; border-radius: 8px; padding: 9px 12px; font-weight: 800; cursor: pointer; }
    .btn-primary { background: #d93025; border-color: #d93025; color: #fff; }
    .btn-danger { background: #b42318; border-color: #b42318; color: #fff; }
    .modal-overlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 18px; background: rgba(15,23,42,.46); z-index: 50; }
    .modal-card { width: min(1180px, 96vw); max-height: 94vh; background: #fff; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 24px 70px rgba(15,23,42,.28); }
    .modal-header, .modal-footer { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #edf0f5; }
    .modal-footer { border-top: 1px solid #edf0f5; border-bottom: 0; }
    .modal-body { padding: 16px; overflow: auto; }
  </style>
</head>
<body>
  <main id="portalPluginViews"></main>
  <script>
    window.PORTAL_CFG = {
      endpoints: {
        server: <?= json_encode($apiBase . '/internal/legacy-action') ?>,
        portal: <?= json_encode($apiBase . '/internal/legacy-action') ?>,
        crm: <?= json_encode($apiBase . '/crm') ?>,
        internal: <?= json_encode($apiBase . '/internal') ?>,
        platform: <?= json_encode($apiBase . '/platform') ?>
      },
      perms: <?= json_encode($currentPermissions) ?>,
      capabilities: {
        manage_sales_users: true,
        view_own_assigned_leads: true,
        view_all_callers_list_progress: true
      },
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'user') ?>,
        account_type: 'employee'
      },
      flags: { is_sales_portal: true }
    };
    window.Portal = {
      cfg: window.PORTAL_CFG,
      qs(sel, root){ return (root || document).querySelector(sel); },
      qsa(sel, root){ return Array.from((root || document).querySelectorAll(sel)); },
      registerPlugin(){},
      async switchView(id) {
        document.querySelectorAll('[id^="view-"]').forEach((node) => node.style.display = 'none');
        const target = document.getElementById('view-' + id);
        if (target) target.style.display = 'block';
      },
      openModal(id){ const el = document.getElementById(id); if (el) el.style.display = 'flex'; },
      closeModal(id){ const el = document.getElementById(id); if (el) el.style.display = 'none'; },
      apiPost(url, payload) {
        const fd = new FormData();
        Object.entries(payload || {}).forEach(([key, value]) => fd.append(key, value));
        fd.append('actor_email', window.PORTAL_CFG.user.email || '');
        fd.append('actor_name', window.PORTAL_CFG.user.name || '');
        fd.append('actor_role', window.PORTAL_CFG.user.role || '');
        return fetch(url, { method: 'POST', body: fd }).then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.success === false) throw new Error(data.error || data.message || 'Request failed');
          return data;
        });
      },
      escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
      }
    };
    window.closeModal = (id) => window.Portal.closeModal(id);
  </script>
  <script src="../../internal/portal_scripts/customers.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script>
    document.addEventListener('DOMContentLoaded', async () => {
      const view = document.getElementById('view-customers');
      if (view) view.style.display = 'block';
      if (window.Customers && typeof window.Customers.onShow === 'function') {
        await window.Customers.onShow();
      }
    });
  </script>
</body>
</html>
