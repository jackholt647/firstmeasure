<?php
require_once __DIR__ . '/_storage.php';
session_start();

$userDir = storageDir('users');

function leadCallbackUserFile($email) {
    global $userDir;
    return $userDir . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email))) . '.json';
}

function leadCallbackIsEmployee($u) {
    if (!is_array($u)) return false;
    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'customer') return false;
    if ($acct === 'employee') return true;
    $role = strtolower(trim((string)($u['role'] ?? '')));
    if (in_array($role, ['admin', 'system_admin', 'sales_manager', 'salesperson', 'lead'], true)) return true;
    $perms = is_array($u['permissions'] ?? null) ? $u['permissions'] : [];
    return !empty($perms['manage_users']) || !empty($perms['manage_sales_users']) || !empty($perms['create_users']);
}

function extractLeadCallbackStyles() {
    static $cached = null;
    if ($cached !== null) return $cached;

    $indexPath = __DIR__ . '/index.php';
    if (!file_exists($indexPath)) return '';
    $cachePath = storagePath('cache/lead_callback_styles.css', true);
    $indexMtime = (int)@filemtime($indexPath);
    if (file_exists($cachePath) && (int)@filemtime($cachePath) >= $indexMtime) {
        $cached = (string)@file_get_contents($cachePath);
        return $cached;
    }

    $raw = file_get_contents($indexPath);
    if (!is_string($raw) || $raw === '') return '';
    $cached = preg_match('/<style>(.*)<\/style>/sU', $raw, $m) ? trim($m[1]) : '';
    @file_put_contents($cachePath, $cached, LOCK_EX);
    return $cached;
}

if (!isset($_SESSION['user_email'])) {
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = $_SESSION['user_email'];
$uFile = leadCallbackUserFile($currentUserEmail);
if (!file_exists($uFile)) {
    header("Location: backend_logout.php");
    exit;
}

$myUserData = json_decode(file_get_contents($uFile), true);
if (!leadCallbackIsEmployee($myUserData)) {
    header("Location: /app");
    exit;
}

$leadId = trim((string)($_GET['lead_id'] ?? ''));
$source = preg_replace('/[^a-z0-9_\-]/', '', strtolower(trim((string)($_GET['source'] ?? 'manual'))));
$pageTitle = 'Lead Callback';
$ver = @filemtime(__DIR__ . '/portal_scripts/lead_viewer.js') ?: time();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><?php echo htmlspecialchars($pageTitle); ?></title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style>
    <?php echo extractLeadCallbackStyles(); ?>
    html,body{height:auto;min-height:100%;}
    body{background:#f5f7fb;font-family:'Segoe UI',Roboto,sans-serif;overflow:auto;}
    .lead-callback-shell{width:100%;max-width:none;margin:0;padding:24px 28px 36px;box-sizing:border-box;}
    .lead-callback-card{background:transparent;border:none;border-radius:0;padding:0;box-shadow:none;}
    .lead-callback-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px;}
    .lead-callback-sub{font-size:13px;color:#657083;margin-top:6px;}
    .lead-callback-body{min-height:220px;overflow:visible;}
    .lead-callback-body .lead-viewer-grid.compact{grid-template-columns:repeat(6,minmax(0,1fr));}
    @media (max-width: 900px){.lead-callback-shell{padding:18px 16px 28px;}}
    @media (max-width: 1200px){.lead-callback-body .lead-viewer-grid.compact{grid-template-columns:repeat(3,minmax(0,1fr));}}
    @media (max-width: 760px){.lead-callback-body .lead-viewer-grid.compact{grid-template-columns:1fr;}}
  </style>
</head>
<body>
  <div class="lead-callback-shell">
    <div class="lead-callback-card">
      <div class="lead-callback-head">
        <div>
          <h1 style="margin:0;">Lead Callback</h1>
          <div class="lead-callback-sub">
            <?php if ($source !== ''): ?>
              Opened from <?php echo htmlspecialchars($source); ?>. Answer activity will be recorded automatically.
            <?php else: ?>
              Lightweight lead view for dialer callbacks.
            <?php endif; ?>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <a class="btn-secondary" href="sales.php" style="text-decoration:none;"><i class="fas fa-arrow-left"></i> Back To CRM</a>
        </div>
      </div>
      <div id="leadCallbackRoot" class="lead-callback-body">
        <div style="padding:28px;color:#7a8594;font-style:italic;">Loading lead...</div>
      </div>
    </div>
  </div>

  <script>
    window.LEAD_VIEWER_CFG = {
      server: 'server.php',
      lead_callback: 'lead_callback.php',
      lead_id: <?php echo json_encode($leadId); ?>,
      source: <?php echo json_encode($source); ?>,
      call_ts: <?php echo json_encode(trim((string)($_GET['call_ts'] ?? ''))); ?>
    };
  </script>
  <script src="portal_scripts/lead_viewer.js?v=<?=$ver?>"></script>
  <script src="portal_scripts/script_viewer.js?v=<?=$ver?>"></script>
  <script>
    (function(){
      const cfg = window.LEAD_VIEWER_CFG || {};
      if (!cfg.call_ts) {
        cfg.call_ts = String(Math.floor(Date.now() / 1000));
        const url = new URL(window.location.href);
        url.searchParams.set('call_ts', cfg.call_ts);
        window.history.replaceState({}, '', url.toString());
      }
      const root = document.getElementById('leadCallbackRoot');
      const api = (data) => fetch(cfg.server || 'server.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(r => r.json());

      const viewer = window.LeadViewer.createController({
        bodyEl: root,
        api,
        bannerText: cfg.source ? `Answer activity is being logged from ${cfg.source}.` : '',
        preferLatestDialEvent: true,
        callbackMode: true,
        callSessionTs: Number(cfg.call_ts || 0)
      });

      async function boot(){
        if (!cfg.lead_id) {
          root.innerHTML = '<div style="padding:28px;color:#7a8594;font-style:italic;">Missing lead id.</div>';
          return;
        }
        await viewer.loadLead(cfg.lead_id);
        if (cfg.source) {
          await viewer.markDialed(cfg.source, {
            page: 'lead_callback',
            query: window.location.search,
            event_token: cfg.call_ts,
            call_started_at: cfg.call_ts
          });
        }
      }

      boot();
    })();
  </script>
</body>
</html>
