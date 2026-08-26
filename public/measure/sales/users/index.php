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
  <title>Users & Teams</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; font-family: 'Montserrat-Regular', sans-serif; color: #17202a; background: #f6f7f9; }
    body { padding: 20px; }
    :root { --primary: #d93025; --primary-rgb: 217,48,37; }
    .header-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .header-bar h1 { margin: 0; font-size: 24px; }
    .btn-primary, .btn-secondary, .btn-danger, .filter-btn { border: 1px solid #d7dce7; border-radius: 8px; padding: 9px 12px; font-weight: 800; cursor: pointer; background: #fff; color: #344054; }
    .btn-primary { background: #d93025; border-color: #d93025; color: #fff; }
    .btn-danger { background: #b42318; border-color: #b42318; color: #fff; }
    .filter-btn.active { background: #e7f0ff; color: #193b67; border-color: #b8d3ff; }
    .panel-card { background: #fff; border: 1px solid #e4e8ef; border-radius: 8px; padding: 14px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e4e8ef; border-radius: 8px; overflow: hidden; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #edf0f5; font-size: 13px; text-align: left; }
    th { background: #f8fafc; font-size: 11px; text-transform: uppercase; color: #667085; }
    tr:hover td { background: #f6f8fb; }
    .modal-overlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 18px; background: rgba(15,23,42,.46); z-index: 50; }
    .modal-card { width: min(980px, 96vw); max-height: 94vh; background: #fff; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 24px 70px rgba(15,23,42,.28); }
    .modal-header, .modal-footer { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #edf0f5; }
    .modal-footer { border-top: 1px solid #edf0f5; border-bottom: 0; }
    .modal-header h2 { margin: 0; font-size: 18px; }
    .modal-body { padding: 16px; overflow: auto; }
    .form-row { margin-bottom: 13px; }
    .form-row label, form > label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 800; color: #667085; text-transform: uppercase; }
    input, select { font: inherit; }
    .form-row input, .form-row select { width: 100%; padding: 10px; border: 1px solid #cfd6e1; border-radius: 7px; }
    .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .btn-preset { border: 1px solid #d7dce7; background: #fff; border-radius: 8px; padding: 8px 10px; cursor: pointer; font-weight: 800; }
    .perm-section { border: 1px solid #edf0f5; border-radius: 8px; padding: 12px; margin: 12px 0; background: #fbfcfe; }
    .perm-section-title { font-size: 12px; font-weight: 900; margin-bottom: 10px; }
    .perm-grid, .perm-grid-selects { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
    .perm-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .seg-hidden { display: none !important; }
    .seg-control { display: flex; flex-wrap: wrap; gap: 6px; }
    .seg-btn { border: 1px solid #d7dce7; border-radius: 999px; padding: 7px 10px; background: #fff; cursor: pointer; font-weight: 800; font-size: 12px; }
    .seg-btn.active { background: #d93025; border-color: #d93025; color: #fff; }
  </style>
</head>
<body>
  <div id="view-users">
    <div class="header-bar">
      <h1>Users &amp; Teams</h1>
      <div style="display:flex; gap:10px;">
        <button class="btn-secondary" onclick="fetchUsers()"><i class="fas fa-sync"></i> Refresh</button>
        <button class="btn-primary" onclick="openUserModal('create')"><i class="fas fa-plus"></i> Add User</button>
      </div>
    </div>
    <div class="panel-card" style="max-width:none; margin-bottom:18px;">
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <div class="filter-group" id="usersScopeFilter">
          <button class="filter-btn active" type="button" data-user-scope="all">All</button>
          <button class="filter-btn" type="button" data-user-scope="production">Production</button>
          <button class="filter-btn" type="button" data-user-scope="sales">Sales</button>
        </div>
        <input id="usersSearchInput" type="text" placeholder="Search name, email, role, team..." style="min-width:280px; max-width:420px; padding:10px 12px; border:1px solid #ccc; border-radius:8px;">
        <div id="usersResultSummary" style="font-size:12px; font-weight:800; color:#666;">Loading...</div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th data-user-sort="name" style="cursor:pointer;">Name</th>
          <th data-user-sort="email" style="cursor:pointer;">Email</th>
          <th data-user-sort="role" style="cursor:pointer;">Role</th>
          <th data-user-sort="department" style="cursor:pointer;">Dept</th>
          <th data-user-sort="team_id" style="cursor:pointer;">Team ID</th>
          <th data-user-sort="training_complete" style="cursor:pointer;">Training</th>
          <th style="text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody id="usersTable"></tbody>
    </table>
  </div>

  <div class="modal-overlay" id="userModal">
    <div class="modal-card md-user">
      <div class="modal-header">
        <h2 id="uModalTitle">Edit User</h2>
        <button onclick="closeModal('userModal')" style="margin-left:auto;border:none;background:none;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <form id="userForm">
          <input type="hidden" id="uMode">
          <div class="form-row"><label>Email</label><input type="email" id="uEmail" required></div>
          <div class="form-row"><label>Full Name</label><input type="text" id="uName"></div>
          <div class="form-row"><label>Password <span style="font-weight:normal; font-size:10px;">(Leave blank to keep existing)</span></label><input type="text" id="uPass"></div>
          <div class="form-row"><label>Team Identifier</label><input type="text" id="uTeam" placeholder="default"></div>
          <div class="form-row"><label>User Department</label><select id="uDepartment"><option value="production">Production</option><option value="sales">Sales</option></select></div>
          <div class="form-row"><label>Queue Priority</label><select id="uComplexityPref"><option value="all">No Preference (FIFO)</option><option value="simple">Prioritize Simple</option><option value="complex">Prioritize Complex</option></select></div>
          <div class="form-row" id="uDrafterRankRow"><label>Drafter Rank</label><select id="uDrafterRank"><option value="junior">Junior</option><option value="standard">Standard</option><option value="senior">Senior</option></select></div>
          <div class="form-row"><label>Queue Mode (Hot Swapping)</label><select id="uQueueMode"><option value="disabled">Disabled (Standard)</option><option value="wait_for_feedback">Wait for Feedback</option><option value="hot_swap">Hot Swapping Enabled</option></select></div>
          <div class="form-row"><label for="uShiftRate">Shift Rate (PHP/day)</label><input type="number" id="uShiftRate" min="0" max="100000" step="1" value="940"></div>
          <div class="form-row"><label>Training Complete</label><label style="display:flex;align-items:center;gap:10px;text-transform:none;font-size:13px;color:#333;"><input type="checkbox" id="uTrainingComplete" style="width:20px;"> Training complete. Approved for live system use.</label></div>
          <label>Permissions Preset</label>
          <div class="presets">
            <button type="button" class="btn-preset" onclick="applyPreset('admin')">Admin</button>
            <button type="button" class="btn-preset" onclick="applyPreset('lead')">Team Lead</button>
            <button type="button" class="btn-preset" onclick="applyPreset('user')">User</button>
          </div>
          <label>Detailed Permissions</label>
          <?php echo permissionOptionsRenderHtml(); ?>
          <input type="hidden" id="uRoleLabel">
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn-danger" id="btnDeleteUser" style="margin-right:auto; display:none;" onclick="deleteUser()">Delete</button>
        <button class="btn-secondary" onclick="closeModal('userModal')">Cancel</button>
        <button class="btn-primary" onclick="saveUser()">Save User</button>
      </div>
    </div>
  </div>

  <script>
    window.PORTAL_CFG = {
      endpoints: {
        portal: <?= json_encode($apiBase . '/internal/legacy-action') ?>
      },
      permission_model: <?= json_encode(permissionOptionsFrontendModel('all')) ?>,
      perms: <?= json_encode($currentPermissions) ?>,
      user: {
        email: <?= json_encode($currentUserEmail) ?>,
        name: <?= json_encode($currentUserName) ?>,
        role: <?= json_encode($currentUserRole ?: 'user') ?>
      },
      flags: { is_sales_portal: true }
    };
    window.Portal = {
      cfg: window.PORTAL_CFG,
      qs(sel, root){ return (root || document).querySelector(sel); },
      qsa(sel, root){ return Array.from((root || document).querySelectorAll(sel)); },
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
  <script src="../../internal/portal_scripts/users.js?v=<?= htmlspecialchars($assetVersion, ENT_QUOTES, 'UTF-8') ?>"></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      if (window.Users) {
        window.Users.init();
        window.Users.fetchUsers();
      }
    });
  </script>
</body>
</html>
