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

if (session_status() === PHP_SESSION_ACTIVE && function_exists('session_write_close')) {
    session_write_close();
}

$assetVersion = (string)time();
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FirstMeasure Sales Tools</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; font-family: 'Montserrat-Regular', sans-serif; background: #f6f7f9; color: #17202a; }
    body { overflow: hidden; }
    .tools-shell { height: 100vh; min-height: 0; display: flex; flex-direction: column; background: #f6f7f9; }
    #portalPluginViews { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 22px; }
    #view-call-scripts { min-height: 100%; }
    .header-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .header-bar h1 { margin: 0; font-size: 24px; line-height: 1.15; }
    .btn-secondary, .btn-primary, .btn-danger {
      border: 1px solid #d7dce7;
      border-radius: 8px;
      padding: 9px 12px;
      font-weight: 800;
      cursor: pointer;
      font: inherit;
    }
    .btn-secondary { background: #fff; color: #344054; }
    .btn-secondary:hover { background: #f2f5f9; }
    .btn-primary { border-color: #d93025; background: #d93025; color: #fff; }
    .btn-danger { border-color: #f4b7b2; background: #fff5f4; color: #b42318; }
    .panel-card {
      background: #fff;
      border: 1px solid #e4e8ef;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 8px 22px rgba(15, 23, 42, .04);
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 5000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(15, 23, 42, .48);
    }
    .modal-overlay.active, .modal-overlay:not(.Fhide)[style*="display: flex"] { display: flex; }
    .modal-card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 24px 70px rgba(15, 23, 42, .28);
      overflow: hidden;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid #e8edf5;
    }
    .modal-header h2 { margin: 0; font-size: 20px; }
    .modal-body { padding: 18px; }
    :root { --primary: #d93025; --primary-rgb: 217,48,37; }
  </style>
</head>
<body>
  <div class="tools-shell">
    <main id="portalPluginViews"></main>
  </div>

  <script>
    window.PORTAL_CFG = {
      endpoints: {
        server: 'action.php'
      },
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'user') ?>
      },
      perms: <?= json_encode($currentPermissions, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>
    };
    window.Portal = {
      cfg: window.PORTAL_CFG,
      __plugins: {},
      registerPlugin(plugin) {
        if (plugin && plugin.id) this.__plugins[plugin.id] = plugin;
      },
      async switchView(id) {
        document.querySelectorAll('#portalPluginViews > [id^="view-"]').forEach((node) => {
          node.style.display = node.id === `view-${id}` ? 'block' : 'none';
        });
      },
      escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
      }
    };
  </script>
  <script src="scripts/script_viewer.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      window.Portal.switchView('call-scripts');
      window.CallScripts?.reload?.();
    });
  </script>
</body>
</html>
