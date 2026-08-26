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
$cfg = [
    'apiBase' => $apiBase,
    'user' => [
        'email' => $currentUserEmail,
        'name' => $currentUserName,
        'role' => $currentUserRole,
        'manager' => $isManager,
        'scopeLabel' => $isManager ? 'Manager view: all leads' : ('Assigned to ' . $currentUserEmail),
    ],
];
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FirstMeasure Sales Leads</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="styles/leads.css?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>">
</head>
<body>
  <div class="sales-shell">
    <aside class="sales-sidebar">
      <div class="sales-logo-area">
        <img src="/images/logo_red.png" alt="First Mate" onerror="this.style.display='none'; document.getElementById('salesLogoTxt').style.display='block';">
        <span id="salesLogoTxt" class="sales-logo-fallback">FM</span>
      </div>
      <nav class="sales-nav" aria-label="Sales navigation">
        <button class="sales-nav-btn active" type="button" data-sales-view="leads">
          <i class="sales-nav-icon fas fa-address-book" aria-hidden="true"></i>
          <span>Sales Leads</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="tools">
          <i class="sales-nav-icon fas fa-screwdriver-wrench" aria-hidden="true"></i>
          <span>Script settings</span>
        </button>
        <?php if ($isManager): ?>
        <button class="sales-nav-btn" type="button" data-sales-view="territory">
          <i class="sales-nav-icon fas fa-map-location-dot" aria-hidden="true"></i>
          <span>Territory Builder</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="sample-reports">
          <i class="sales-nav-icon fas fa-file-signature" aria-hidden="true"></i>
          <span>Sample Reports</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="referral-partners">
          <i class="sales-nav-icon fas fa-handshake" aria-hidden="true"></i>
          <span>Referral Partners</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="referral-rewards">
          <i class="sales-nav-icon fas fa-gift" aria-hidden="true"></i>
          <span>Referral Rewards</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="users">
          <i class="sales-nav-icon fas fa-users-gear" aria-hidden="true"></i>
          <span>Users &amp; Teams</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="customers">
          <i class="sales-nav-icon fas fa-building" aria-hidden="true"></i>
          <span>Customers</span>
        </button>
        <button class="sales-nav-btn" type="button" data-sales-view="data-agent">
          <i class="sales-nav-icon fas fa-robot" aria-hidden="true"></i>
          <span>Data Agent</span>
        </button>
        <?php endif; ?>
      </nav>
      <div class="sales-user-panel">
        <strong><?= htmlspecialchars($currentUserName ?: 'Sales', ENT_QUOTES, 'UTF-8') ?></strong>
        <span><?= htmlspecialchars($currentUserEmail, ENT_QUOTES, 'UTF-8') ?></span>
        <a class="sales-signout" href="../internal/backend_logout.php">Sign Out</a>
      </div>
    </aside>

    <main class="sales-content">
      <section id="sales-view-leads" class="sales-view active">
        <div id="lead-app" class="lead-app" aria-busy="true">
          <header class="lead-topbar">
            <div class="brand-block">
              <div class="brand-title">Sales Leads</div>
              <div class="brand-subtitle" id="lead-scope-label">Loading leads</div>
            </div>
            <div class="topbar-main">
              <div class="filter-row" role="search">
                <input id="lead-search" class="filter-input search-input topbar-primary" type="search" placeholder="Search leads">
                <select id="lead-status" class="filter-input filter-control">
                  <option value="">All statuses</option>
                </select>
                <select id="lead-region" class="filter-input filter-control">
                  <option value="">All regions</option>
                </select>
                <select id="lead-assigned" class="filter-input filter-control manager-only">
                  <option value="">All assignees</option>
                </select>
                <select id="lead-disposition" class="filter-input filter-control">
                  <option value="">All dispositions</option>
                </select>
                <select id="lead-presence" class="filter-input filter-control">
                  <option value="">All contact data</option>
                  <option value="has_email">Has email</option>
                  <option value="has_phone">Has phone</option>
                  <option value="has_website">Has website</option>
                  <option value="no_contact_data">No contact data</option>
                </select>
                <input id="lead-imported-from" class="filter-input filter-control date-filter" type="date" title="Imported from">
                <input id="lead-imported-to" class="filter-input filter-control date-filter" type="date" title="Imported to">
                <div id="custom-topbar-filters" class="custom-topbar-filters"></div>
              </div>
              <div class="topbar-tools" aria-label="Lead tools">
                <button id="lead-refresh" class="icon-button topbar-action" type="button" title="Refresh">Refresh</button>
                <button id="lead-columns" class="toolbar-button topbar-action" type="button">Columns</button>
                <button id="lead-import" class="primary-button topbar-action" type="button">Import</button>
              </div>
            </div>
          </header>

          <section class="action-bar is-disabled" id="lead-actions">
            <div id="selected-summary">0 selected</div>
            <div class="action-buttons">
              <button id="reassign-selected" class="toolbar-button manager-only" type="button" disabled>Reassign</button>
              <button id="export-selected" class="toolbar-button" type="button" disabled>Export CSV</button>
            </div>
          </section>

          <main class="sheet-shell">
            <div id="lead-loading" class="loading-panel">Loading leads...</div>
            <div class="sheet-scroll" id="sheet-scroll">
              <table class="lead-table" id="lead-table">
                <thead id="lead-head"></thead>
                <tbody id="lead-body"></tbody>
              </table>
            </div>
          </main>

          <footer class="lead-footer">
            <div class="footer-group">
              <button id="select-visible" class="toolbar-button" type="button">Select page</button>
              <button id="select-filtered" class="toolbar-button" type="button">Select all filtered</button>
              <button id="view-selected" class="toolbar-button" type="button" disabled>View selected</button>
              <button id="deselect-all" class="toolbar-button" type="button">Deselect</button>
              <span id="page-summary">0 leads</span>
            </div>
            <div class="footer-group">
              <label class="compact-label">Rows
                <select id="per-page" class="compact-select">
                  <option>50</option>
                  <option selected>100</option>
                  <option>200</option>
                  <option>500</option>
                </select>
              </label>
              <button id="prev-page" class="toolbar-button" type="button">Previous</button>
              <span id="page-number">Page 1</span>
              <button id="next-page" class="toolbar-button" type="button">Next</button>
            </div>
          </footer>
        </div>
      </section>

      <section id="sales-view-tools" class="sales-view">
        <iframe id="tools-frame" class="sales-embedded-frame" title="Sales Tools" data-src="tools/index.php"></iframe>
      </section>

      <?php if ($isManager): ?>
      <section id="sales-view-territory" class="sales-view">
        <iframe id="territory-frame" class="sales-embedded-frame" title="Territory Builder" data-src="territory/index.php?embedded=1"></iframe>
      </section>
      <section id="sales-view-sample-reports" class="sales-view">
        <iframe id="sample-reports-frame" class="sales-embedded-frame" title="Sample Reports" data-src="sample-reports/index.php"></iframe>
      </section>
      <section id="sales-view-referral-partners" class="sales-view">
        <iframe id="referral-partners-frame" class="sales-embedded-frame" title="Referral Partners" data-src="referral-partners/index.php"></iframe>
      </section>
      <section id="sales-view-referral-rewards" class="sales-view">
        <iframe id="referral-rewards-frame" class="sales-embedded-frame" title="Referral Rewards" data-src="referral-rewards/index.php"></iframe>
      </section>
      <section id="sales-view-users" class="sales-view">
        <iframe id="users-frame" class="sales-embedded-frame" title="Users &amp; Teams" data-src="users/index.php"></iframe>
      </section>
      <section id="sales-view-customers" class="sales-view">
        <iframe id="customers-frame" class="sales-embedded-frame" title="Customers" data-src="customers/index.php"></iframe>
      </section>
      <section id="sales-view-data-agent" class="sales-view">
        <iframe id="data-agent-frame" class="sales-embedded-frame" title="Data Agent" data-src="data-agent/index.php"></iframe>
      </section>
      <?php endif; ?>
    </main>
  </div>

  <div id="notes-popover" class="floating-panel notes-panel" hidden></div>

  <dialog id="columns-modal" class="columns-modal">
    <form method="dialog" class="modal-frame">
      <header class="modal-header">
        <h2>Columns</h2>
        <button class="icon-button" value="cancel" type="submit">Close</button>
      </header>
      <div class="columns-modal-body">
        <section class="custom-column-builder">
          <h3>Custom Columns</h3>
          <div class="custom-column-form" id="custom-column-form">
            <input id="custom-column-name" class="filter-input" type="text" placeholder="Column name">
            <select id="custom-column-type" class="filter-input">
              <option value="text">Free entry</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="select">Single selection</option>
              <option value="multiselect">Multiple selection</option>
            </select>
            <input id="custom-column-options" class="filter-input" type="text" placeholder="Options, comma separated">
            <label class="compact-label"><input id="custom-column-topbar" type="checkbox"> Top bar filter</label>
            <button id="add-custom-column" class="primary-button" type="button">Add column</button>
          </div>
        </section>
        <div id="columns-panel"></div>
      </div>
    </form>
  </dialog>

  <dialog id="lead-viewer-modal" class="lead-viewer-modal">
    <form method="dialog" class="viewer-frame">
      <header class="viewer-header">
        <div>
          <h2 id="viewer-title">Lead</h2>
          <div id="viewer-subtitle" class="viewer-subtitle"></div>
        </div>
        <div class="viewer-actions">
          <a id="viewer-open-page" class="toolbar-button" href="#" target="_blank" rel="noopener">Open Page</a>
          <button class="icon-button" value="cancel" type="submit">Close</button>
        </div>
      </header>
      <div id="lead-viewer-body" class="viewer-body"></div>
    </form>
  </dialog>

  <dialog id="import-modal" class="import-modal">
    <form method="dialog" class="modal-frame">
      <header class="modal-header">
        <h2>Import Leads</h2>
        <button class="icon-button" value="cancel" type="submit">Close</button>
      </header>
      <div class="modal-body">
        <input id="import-file" type="file" accept=".csv,text/csv">
        <textarea id="import-text" placeholder="Paste CSV rows here"></textarea>
        <div class="import-controls">
          <button id="preview-import" class="primary-button" type="button">Preview Import</button>
          <select id="new-action" class="filter-input">
            <option value="create">Create new</option>
            <option value="skip">Skip new</option>
          </select>
          <select id="duplicate-action" class="filter-input">
            <option value="update">Update changed</option>
            <option value="skip">Skip changed</option>
            <option value="create">Add changed as new</option>
          </select>
          <select id="unchanged-action" class="filter-input">
            <option value="skip">Skip identical</option>
            <option value="touch">Update import date</option>
          </select>
          <button id="commit-import" class="toolbar-button" type="button" disabled>Commit Import</button>
        </div>
        <div id="import-summary" class="import-summary">No import preview yet.</div>
      </div>
    </form>
  </dialog>

  <dialog id="reassign-modal" class="import-modal">
    <form method="dialog" class="modal-frame">
      <header class="modal-header">
        <h2>Reassign Leads</h2>
        <button class="icon-button" value="cancel" type="submit">Close</button>
      </header>
      <div class="modal-body">
        <div id="reassign-people" class="people-grid"></div>
        <div id="reassign-preview" class="import-summary">Choose one or more salespeople.</div>
        <div class="import-controls">
          <button id="preview-reassign" class="toolbar-button" type="button">Preview</button>
          <button id="commit-reassign" class="primary-button" type="button" disabled>Apply Reassignment</button>
        </div>
      </div>
    </form>
  </dialog>

  <script>
    window.LEADS_CFG = <?= json_encode($cfg, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('[data-sales-view]').forEach((button) => {
        button.addEventListener('click', () => {
          const view = button.dataset.salesView || 'leads';
          document.querySelectorAll('[data-sales-view]').forEach((node) => node.classList.toggle('active', node === button));
          document.querySelectorAll('.sales-view').forEach((node) => node.classList.toggle('active', node.id === `sales-view-${view}`));
          const activeView = document.getElementById(`sales-view-${view}`);
          const frame = activeView ? activeView.querySelector('iframe[data-src]') : null;
          if (frame && !frame.src) {
            frame.src = frame.dataset.src;
          }
        });
      });
    });
  </script>
  <script src="scripts/lead_viewer.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script src="scripts/leads.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
</body>
</html>
