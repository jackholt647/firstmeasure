<?php
session_start();
require_once __DIR__ . '/../../internal/_storage.php';

if (!isset($_SESSION['user_email'])) {
    header("Location: ../../internal/backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
$currentUserName = trim((string)($_SESSION['user_name'] ?? $currentUserEmail));
$currentUserRole = strtolower(trim((string)($_SESSION['user_role'] ?? $_SESSION['role'] ?? '')));
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
  <title>Referral Rewards</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    html, body { min-height: 100%; margin: 0; font-family: 'Montserrat-Regular', sans-serif; background: #f6f7f9; color: #17202a; }
    :root { --primary: #d93025; --primary-rgb: 217,48,37; }
  </style>
</head>
<body>
  <div id="referralRewardsRoot"></div>
  <script>
    window.PORTAL_CFG = {
      endpoints: {
        server: <?= json_encode($apiBase . '/internal/legacy-action') ?>,
        crm: <?= json_encode($apiBase . '/internal/crm') ?>,
        crm_referrals: <?= json_encode($apiBase . '/internal/crm/referrals') ?>
      },
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'user') ?>
      },
      flags: { is_sales_portal: true }
    };
    window.Portal = {
      cfg: window.PORTAL_CFG,
      escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
      },
      apiPost(url, payload) {
        return fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload || {})
        }).then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.success === false) throw new Error(data.error || data.message || 'Request failed');
          return data;
        });
      }
    };
  </script>
  <script src="../../internal/portal_scripts/referral_rewards.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      if (window.ReferralRewardsTab) window.ReferralRewardsTab.onShow();
    });
  </script>
</body>
</html>
