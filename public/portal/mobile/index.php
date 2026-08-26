<?php
require_once __DIR__ . '/../session_bootstrap.php';
portalStartSession();

if (!isset($_SESSION['user_email'])) {
    header('Location: ../login.php?redirect=' . rawurlencode('mobile/'));
    exit;
}

$userName = $_SESSION['user_name'] ?? '';
$userEmail = $_SESSION['user_email'] ?? '';
$userCompany = $_SESSION['user_company'] ?? '';
$userOrgId = $_SESSION['user_org_id'] ?? ($_SESSION['org_id'] ?? null);
$userId = $_SESSION['platform_user_id'] ?? ($_SESSION['user_id'] ?? null);
$userBranchId = $_SESSION['platform_branch_id'] ?? ($_SESSION['branch_id'] ?? 'default');
$ver = time();

session_write_close();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#f7f8fa">
  <title>FirstMate Mobile</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="mobile.css?v=<?= $ver ?>">
  <script>
    window.__APP = {
      userName: <?= json_encode($userName) ?>,
      userEmail: <?= json_encode($userEmail) ?>,
      userCompany: <?= json_encode($userCompany) ?>,
      userOrgId: <?= json_encode($userOrgId) ?>,
      userId: <?= json_encode($userId) ?>,
      userBranchId: <?= json_encode($userBranchId) ?>,
      platformApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
          return `${location.protocol}//${location.hostname}:3111/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
      })(),
      serverEndpoint: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
          return `${location.protocol}//${location.hostname}:3111/v1/platform/portal-action`;
        }
        return `${location.origin}/v1/platform/portal-action`;
      })()
    };
  </script>
</head>
<body>
  <div id="mobileApp" class="mobile-app">
    <header class="app-header">
      <a class="brand" href="./" aria-label="FirstMate mobile home">
        <img src="/images/logo_red.png" alt="FirstMate">
      </a>
      <div class="header-actions">
        <button class="icon-btn" type="button" id="refreshBtn" aria-label="Refresh appointments">
          <i class="fas fa-rotate"></i>
        </button>
        <button class="account-btn" type="button" id="accountBtn" aria-label="Account menu" aria-expanded="false">
          <span id="accountInitial">?</span>
          <i class="fas fa-chevron-down"></i>
        </button>
      </div>
      <div class="account-menu" id="accountMenu" aria-hidden="true">
        <div class="account-menu-user">
          <strong id="menuUserName"></strong>
          <span id="menuUserEmail"></span>
        </div>
        <button type="button" data-app-tab="sales"><i class="fas fa-calendar-check"></i><span>Sales</span></button>
        <button type="button" data-app-tab="future"><i class="fas fa-table-cells"></i><span>Other apps</span></button>
        <a href="../logout.php"><i class="fas fa-right-from-bracket"></i><span>Log out</span></a>
      </div>
    </header>

    <main class="app-main">
      <section class="screen active" id="salesScreen" aria-labelledby="salesTitle">
        <div class="screen-title">
          <div>
            <h1 id="salesTitle">Sales</h1>
            <p id="salesSubtitle">Appointments assigned to you</p>
          </div>
          <div class="sync-status" id="syncStatus">Loading</div>
        </div>
        <div class="appointment-sections" id="appointmentSections"></div>
      </section>

      <section class="screen empty-app" id="futureScreen" aria-labelledby="futureTitle">
        <h1 id="futureTitle">Apps</h1>
        <p>Sales is available now. Additional role-specific apps can plug into this menu when they are ready.</p>
      </section>
    </main>

    <section class="project-sheet" id="projectSheet" aria-hidden="true">
      <header class="sheet-header">
        <button class="icon-btn" type="button" id="closeProjectBtn" aria-label="Close project">
          <i class="fas fa-xmark"></i>
        </button>
        <div class="sheet-title">
          <strong id="sheetProjectTitle">Project</strong>
          <span id="sheetProjectMeta"></span>
        </div>
        <div class="sheet-tabs" role="tablist" aria-label="Project tabs">
          <button class="sheet-tab active" type="button" data-project-tab="home" aria-label="Project details">
            <i class="fas fa-house"></i>
          </button>
          <button class="sheet-tab" type="button" data-project-tab="photos" aria-label="Project photos">
            <i class="fas fa-images"></i>
          </button>
        </div>
      </header>
      <div class="sheet-body">
        <div class="project-panel active" data-panel="home">
          <div class="detail-list" id="projectDetails"></div>
          <section class="office-notes">
            <h2>Office notes</h2>
            <div id="officeNotes"></div>
          </section>
        </div>
        <div class="project-panel" data-panel="photos">
          <div class="photo-toolbar">
            <label class="upload-btn">
              <i class="fas fa-camera"></i>
              <span>Upload</span>
              <input type="file" id="photoInput" accept="image/*" multiple>
            </label>
            <span id="photoStatus"></span>
          </div>
          <div class="photo-groups" id="photoGroups"></div>
        </div>
      </div>
    </section>

    <section class="photo-viewer" id="photoViewer" aria-hidden="true">
      <header class="viewer-header">
        <button class="icon-btn" type="button" id="closePhotoBtn" aria-label="Close photo">
          <i class="fas fa-xmark"></i>
        </button>
        <div class="viewer-title">
          <strong id="viewerPhotoTitle">Photo</strong>
          <span id="viewerPhotoMeta"></span>
        </div>
        <button class="icon-btn primary" type="button" id="saveMarkupBtn" aria-label="Save markup">
          <i class="fas fa-check"></i>
        </button>
      </header>
      <div class="markup-stage" id="markupStage">
        <img id="markupImage" alt="">
        <canvas id="markupCanvas"></canvas>
      </div>
      <div class="markup-tools">
        <button class="tool-btn active" type="button" data-tool="draw" aria-label="Draw">
          <i class="fas fa-pen"></i>
        </button>
        <button class="tool-btn" type="button" id="undoStrokeBtn" aria-label="Undo drawing">
          <i class="fas fa-rotate-left"></i>
        </button>
        <button class="tool-btn danger" type="button" id="clearMarkupBtn" aria-label="Clear drawing">
          <i class="fas fa-eraser"></i>
        </button>
        <textarea id="photoNotes" rows="2" placeholder="Notes"></textarea>
      </div>
    </section>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script src="../../libraries/platform-api/platform-api.js?v=<?= $ver ?>"></script>
  <script src="../../libraries/platform-scheduling/platform-scheduling.js?v=<?= $ver ?>"></script>
  <script src="mobile.js?v=<?= $ver ?>"></script>
</body>
</html>
