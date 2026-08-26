<?php
require_once dirname(__DIR__, 3) . '/includes/provider_keys.php';
session_start();

$assetVersion = (string)time();
$currentUserEmail = strtolower(trim((string)($_SESSION['user']['email'] ?? $_SESSION['email'] ?? '')));
$currentUserName = trim((string)($_SESSION['user']['name'] ?? $_SESSION['name'] ?? $currentUserEmail));
$currentUserRole = strtolower(trim((string)($_SESSION['user']['role'] ?? $_SESSION['role'] ?? 'admin')));

$host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
$localHost = in_array($host, ['127.0.0.1:8021', 'localhost:8021', '127.0.0.1', 'localhost'], true);
$apiBase = $localHost ? 'http://127.0.0.1:3111/v1' : '/v1';
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FirstMeasure Territory</title>
  <link rel="stylesheet" href="/fonts.css">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; font-family: 'Montserrat-Regular', sans-serif; background: #f6f7f9; color: #17202a; }
    .territory-shell { height: 100vh; min-height: 0; display: block; background: #f6f7f9; }
    .territory-main { min-width: 0; min-height: 0; height: 100vh; overflow: hidden; }
    #portalPluginViews { height: 100%; min-height: 0; }
  </style>
</head>
<body>
  <div class="territory-shell">
    <main class="territory-main" id="portalPluginViews"></main>
  </div>

  <script>
    window.PORTAL_CFG = {
      standalone_territory: true,
      browser_google_api_key: <?= json_encode(fm_google_provider_key('browser_territory')) ?>,
      endpoints: {
        server: 'action.php',
        crm: <?= json_encode($apiBase . '/internal/crm') ?>
      },
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'admin') ?>
      },
      perms: { manage_users: true, manage_sales_users: true }
    };
    window.Portal = {
      cfg: window.PORTAL_CFG,
      apiPost(url, payload) {
        const fd = new FormData();
        Object.entries(payload || {}).forEach(([key, value]) => fd.append(key, value));
        return fetch(url, { method: 'POST', body: fd }).then(async (response) => {
          const text = await response.text();
          const json = text ? JSON.parse(text) : {};
          if (!response.ok || json.success === false || json.status === 'error') throw new Error(json.error || json.message || 'Request failed');
          return json;
        });
      },
      registerPlugin() {},
      switchView() {},
      escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
      }
    };
  </script>
  <script src="scripts/territory_builder.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
</body>
</html>
