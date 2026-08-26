/* portal_scripts/customers.js
 * Customers module (Organization-centric):
 * - Organization list with aggregated analytics
 * - Click-to-select rows (click, shift, ctrl, drag) with selection stats
 * - Dedicated "Open" button per row for org detail modal
 * - Credit management at the org level
 * - Column-header filtering & sorting
 * - Rolling 7-day order count + avg orders/day (last 7 days)
 * - Test organization flag: toggle visibility, exclude from totals
 * - Weekly rolling 7-day order volume chart
 *
 * Sales portal access follows the sales permission model.
 *
 * Self-contained: All UI, styles, and logic in one file.
 * Just include in index.php to activate.
 */
(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;
  const apiServer = () => (cfg().endpoints && cfg().endpoints.server) ? cfg().endpoints.server : window.Portal.internalLegacyEndpoint();
  const COMMISSION_MILESTONE_ORDERS = 10;
  function canAccessCustomers(){
    const p = (cfg().perms || {});
    const caps = (cfg().capabilities || {});
    const role = ((cfg().user && cfg().user.role) || '').toLowerCase();
    const acct = ((cfg().user && cfg().user.account_type) || '').toLowerCase();
    if (cfg().flags && cfg().flags.is_sales_portal) {
      if (acct === 'customer') return false;
      return !!caps.view_own_assigned_leads || !!caps.manage_sales_users || !!caps.view_all_callers_list_progress;
    }
    return role === 'admin' || !!p.manage_users;
  }

  function canManageCustomers(){
    const p = (cfg().perms || {});
    const caps = (cfg().capabilities || {});
    const role = ((cfg().user && cfg().user.role) || '').toLowerCase();
    return !!caps.manage_sales_users || !!p.sales_assign_customers_to_sdrs || !!p.manage_users || role === 'admin' || role === 'system_admin' || role === 'sales_manager';
  }

  /* ───────────── STYLES ───────────── */
  function ensureStyles(){
    if (document.getElementById('customersPluginStyles')) return;
    const css = `
      /* ── Org Table ── */
      .cust-table-wrap { padding:20px; overflow-y:auto; flex:1; }
      .cust-table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; }
      .cust-table th {
        background:#f8f9fa; padding:10px 14px; text-align:left;
        font-size:11px; color:#555; text-transform:uppercase;
        border-bottom:1px solid #eee; font-weight:700; cursor:pointer;
        user-select:none; position:relative; white-space:nowrap;
      }
      .cust-table th:hover { background:#eef1f5; }
      .cust-table th .sort-arrow { margin-left:4px; font-size:9px; opacity:0.5; }
      .cust-table th.sorted-asc .sort-arrow,
      .cust-table th.sorted-desc .sort-arrow { opacity:1; color:var(--primary); }
      .cust-table td {
        padding:10px 14px; border-bottom:1px solid #eee;
        font-size:13px; vertical-align:middle;
      }
      .cust-table tbody tr { cursor:default; transition:background 0.08s, box-shadow 0.08s; }
      .cust-table tbody tr:hover td { background:#f5f7fa; }

      .cust-modal-pager{
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        margin-top:12px; font-size:12px; color:#667085;
      }
      .cust-modal-pager .pager-actions{display:flex;gap:8px}
      .cust-modal-pager button[disabled]{opacity:.45; cursor:not-allowed}

      /* ── Row selection ── */
      .cust-table tbody tr.row-selected td {
        background:rgba(var(--primary-rgb, 103,126,234), 0.10);
        border-bottom-color:rgba(var(--primary-rgb, 103,126,234), 0.18);
      }
      .cust-table tbody tr.row-selected:hover td {
        background:rgba(var(--primary-rgb, 103,126,234), 0.16);
      }
      .cust-table tbody tr.row-selected td:first-child {
        box-shadow:inset 3px 0 0 0 var(--primary, #667eea);
      }
      .cust-table tbody tr.row-drag-preview td {
        background:rgba(var(--primary-rgb, 103,126,234), 0.06);
      }

      /* Selection checkbox column */
      .cust-table .sel-cell { width:36px; text-align:center; padding:10px 6px !important; }
      .cust-table .sel-cell .sel-check {
        width:16px; height:16px; border-radius:4px; border:2px solid #ccc;
        display:inline-flex; align-items:center; justify-content:center;
        transition:all 0.12s; cursor:pointer; background:#fff;
        font-size:10px; color:transparent;
      }
      .cust-table .sel-cell .sel-check:hover { border-color:#999; }
      .row-selected .sel-cell .sel-check {
        background:var(--primary, #667eea); border-color:var(--primary, #667eea);
        color:#fff;
      }

      /* Prevent text selection while dragging */
      .cust-selecting { user-select:none !important; -webkit-user-select:none !important; }
      .cust-selecting * { user-select:none !important; -webkit-user-select:none !important; }

      /* Column filter row */
      .cust-table .filter-row th { padding:4px 6px; background:#f0f2f5; position:relative; }
      .cust-filter-wrap{position:relative}
      .cust-table .filter-row input {
        width:100%; padding:5px 8px; border:1px solid #ddd;
        border-radius:4px; font-size:11px; box-sizing:border-box;
      }
      .cust-filter-menu{
        position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:20;
        max-height:180px; overflow:auto; background:#fff; border:1px solid #d9dee8;
        border-radius:8px; box-shadow:0 8px 20px rgba(0,0,0,0.08); display:none;
      }
      .cust-filter-menu.visible{display:block}
      .cust-filter-option{
        padding:7px 9px; font-size:11px; color:#344054; cursor:pointer;
        border-bottom:1px solid #eef2f6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .cust-filter-option:last-child{border-bottom:none}
      .cust-filter-option:hover{background:#f8fafc}

      /* ── Stats Cards ── */
      .cust-stats {
        display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));
        gap:15px; padding:20px; background:#f8f9fa; border-bottom:1px solid #eee;
      }
      .cust-stat-card {
        background:#fff; border:1px solid #e0e0e0; border-radius:10px;
        padding:16px; display:flex; flex-direction:column; gap:6px;
        box-shadow:0 1px 3px rgba(0,0,0,0.05);
      }
      .cust-stat-card .label {
        font-size:11px; font-weight:800; color:#777;
        text-transform:uppercase; letter-spacing:0.3px;
      }
      .cust-stat-card .value {
        font-size:24px; font-weight:900; color:var(--primary); line-height:1;
      }
      .cust-stat-card .sub { font-size:12px; color:#666; font-weight:600; }

      /* ── Toolbar row ── */
      .cust-toolbar {
        display:flex; align-items:center; gap:16px; padding:12px 20px;
        border-bottom:1px solid #eee; background:#fff; flex-wrap:wrap;
      }
      .cust-email-search{
        position:relative; flex:1 1 280px; min-width:240px; max-width:420px;
      }
      .cust-email-search > i{
        position:absolute; left:13px; top:50%; transform:translateY(-50%);
        color:#7b8492; pointer-events:none;
      }
      .cust-email-search .cust-search-input{
        padding:9px 12px 9px 36px; border-radius:9px;
      }
      .cust-page-controls{
        margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        font-size:12px; color:#667085; font-weight:700;
      }
      .cust-page-controls select{
        border:1px solid #d9dee8; border-radius:8px; background:#fff;
        padding:7px 9px; font:inherit; color:#344054;
      }
      .cust-pager{
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        padding:12px 2px 0; color:#667085; font-size:12px; font-weight:700;
      }
      .cust-pager-actions{display:flex;align-items:center;gap:8px}
      .cust-pager button[disabled]{opacity:.45;cursor:not-allowed}

      /* ── Toggle Switch ── */
      .cust-toggle {
        display:flex; align-items:center; gap:10px; cursor:pointer;
        user-select:none; font-size:12px; font-weight:700; color:#555;
      }
      .cust-toggle-track {
        position:relative; width:40px; height:22px;
        background:#ccc; border-radius:11px;
        transition:background 0.2s; flex-shrink:0;
      }
      .cust-toggle-track::after {
        content:''; position:absolute; top:2px; left:2px;
        width:18px; height:18px; border-radius:50%;
        background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.2);
        transition:transform 0.2s cubic-bezier(0.4,0,0.2,1);
      }
      .cust-toggle.active .cust-toggle-track {
        background:var(--primary, #667eea);
      }
      .cust-toggle.active .cust-toggle-track::after {
        transform:translateX(18px);
      }

      /* ── Test org badge ── */
      .test-badge {
        display:inline-block; padding:2px 7px; border-radius:999px;
        font-size:9px; font-weight:900; text-transform:uppercase;
        background:#fff3e0; color:#e65100; border:1px solid #ffcc80;
        margin-left:8px; vertical-align:middle;
      }
      .test-badge-lg {
        display:inline-block; padding:3px 10px; border-radius:999px;
        font-size:10px; font-weight:900; text-transform:uppercase;
        background:rgba(255,255,255,0.2); color:#fff;
        border:1px solid rgba(255,255,255,0.4);
        margin-left:10px; vertical-align:middle;
      }
      .test-row td { opacity:0.6; }
      .test-row:hover td { opacity:0.85; }
      .test-row.row-selected td { opacity:0.85; }

      /* ── Row action button ── */
      .btn-row-open {
        display:inline-flex; align-items:center; gap:5px;
        background:#fff; color:var(--primary, #667eea);
        border:1px solid #ddd; border-radius:6px;
        padding:4px 10px; font-size:11px; font-weight:700;
        cursor:pointer; transition:all 0.12s; white-space:nowrap;
      }
      .btn-row-open:hover {
        background:var(--primary, #667eea); color:#fff; border-color:var(--primary, #667eea);
        box-shadow:0 2px 6px rgba(102,126,234,0.3);
      }
      .btn-row-open i { font-size:10px; }

      /* ── Selection Stats (bottom-right floating panel) ── */
      .sel-stats-panel {
        position:fixed; bottom:96px; right:24px; z-index:900;
        background:#fff; border:1px solid #e0e0e0; border-radius:14px;
        box-shadow:0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
        padding:0; width:380px;
        transform:translateY(20px); opacity:0;
        transition:transform 0.25s cubic-bezier(0.4,0,0.2,1), opacity 0.25s cubic-bezier(0.4,0,0.2,1);
        pointer-events:none;
        overflow:hidden;
      }
      .sel-stats-panel.visible {
        transform:translateY(0); opacity:1; pointer-events:all;
      }
      .sel-stats-header {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 16px; background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color:#fff;
      }
      .sel-stats-header .sel-title {
        font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;
      }
      .sel-stats-header .sel-count {
        font-size:11px; font-weight:700; opacity:0.9;
        background:rgba(255,255,255,0.2); padding:2px 8px; border-radius:99px;
      }
      .sel-stats-close {
        background:none; border:none; color:#fff; font-size:16px;
        cursor:pointer; opacity:0.8; transition:opacity 0.15s;
        padding:0 2px; margin-left:8px; line-height:1;
      }
      .sel-stats-close:hover { opacity:1; }
      .sel-stats-body {
        display:grid; grid-template-columns:1fr 1fr; gap:0;
      }
      .sel-stats-body .sel-stat {
        padding:12px 16px; border-bottom:1px solid #f0f0f0;
        border-right:1px solid #f0f0f0;
      }
      .sel-stats-body .sel-stat:nth-child(even) { border-right:none; }
      .sel-stats-body .sel-stat:nth-last-child(-n+2) { border-bottom:none; }
      .sel-stat .sel-stat-label {
        font-size:9px; font-weight:800; color:#999;
        text-transform:uppercase; letter-spacing:0.3px; margin-bottom:3px;
      }
      .sel-stat .sel-stat-value {
        font-size:18px; font-weight:900; color:var(--primary, #667eea); line-height:1.2;
      }
      .sel-stats-footer {
        padding:10px 16px; border-top:1px solid #eee;
        display:grid; gap:10px;
      }
      .sel-assign-row{display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:stretch}
      .sel-assign-row button{white-space:nowrap; width:100%; justify-content:center}
      .sel-action-btn{
        display:inline-flex; align-items:center; justify-content:center; gap:8px;
        min-height:40px; padding:0 14px; font-size:12px; font-weight:800; border-radius:10px;
      }
      .sel-action-btn-clear{
        background:#fff; color:#5f6876; border:1px solid #d6dce5;
      }
      .sel-action-btn-clear:hover{
        background:#f7f9fc; border-color:#c5ceda;
      }
      .sales-pick-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
      .sales-pick-btn{border:1px solid #d7dde7;background:#fff;border-radius:10px;padding:10px 12px;text-align:left;font:inherit;cursor:pointer}
      .sales-pick-btn:hover{border-color:#d93025;background:#fff8f7}
      .btn-clear-sel {
        background:none; border:1px solid #ddd; border-radius:6px;
        padding:5px 14px; font-size:11px; font-weight:700; color:#666;
        cursor:pointer; transition:all 0.12s;
      }
      .btn-clear-sel:hover { background:#f5f5f5; border-color:#bbb; }

      .pair-row{display:grid;grid-template-columns:auto 1.2fr 1.2fr 1fr;gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid #eef1f5}
      .pair-row:last-child{border-bottom:none}
      .pair-reasons{font-size:11px;color:#667085}
      .pair-score{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:#fef3f2;color:#b42318;font-size:10px;font-weight:800;text-transform:uppercase}
      .pair-subtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
      .pair-subtab{border:1px solid #d9dee8;background:#fff;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:800;color:#5e6775;cursor:pointer}
      .pair-subtab.active{background:#d93025;border-color:#d93025;color:#fff}
      .pair-summary-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .manual-pair-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .manual-pair-col{border:1px solid #e7ebf2;border-radius:12px;padding:12px;background:#fbfcff;display:grid;gap:10px}
      .manual-pair-list{display:grid;gap:8px;max-height:340px;overflow:auto}
      .manual-pair-item{border:1px solid #dfe5ee;border-radius:10px;padding:10px;background:#fff;cursor:pointer}
      .manual-pair-item.active{border-color:#d93025;box-shadow:0 0 0 2px rgba(217,48,37,.12)}
      .manual-pair-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}

      /* ── Org Detail Modal ── */
      .org-modal { width:960px; max-height:85vh; }
      .org-modal .modal-body { padding:0; overflow:hidden; display:flex; flex-direction:column; }

      .org-header {
        padding:20px; border-bottom:1px solid #eee;
        background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color:#fff;
      }
      .org-header-main {
        display:flex; align-items:center; gap:14px; min-width:0;
      }
      .org-logo-frame {
        width:58px; height:58px; border-radius:10px; background:#fff;
        border:1px solid rgba(255,255,255,.6); display:none; align-items:center; justify-content:center;
        overflow:hidden; box-shadow:0 8px 24px rgba(0,0,0,.16); flex:0 0 auto;
      }
      .org-logo-frame.visible { display:flex; }
      .org-logo-frame img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
      .org-header-title { min-width:0; }
      .org-header h2 { margin:0 0 8px 0; font-size:22px; }
      .org-header .meta {
        display:flex; gap:20px; font-size:13px; opacity:0.95; font-weight:600;
        align-items:center; flex-wrap:wrap;
      }

      .org-tabs {
        display:flex; border-bottom:1px solid #eee; background:#f8f9fa; padding:0 20px;
      }
      .org-tab {
        padding:12px 20px; background:transparent; border:none;
        border-bottom:3px solid transparent; color:#5f6368;
        cursor:pointer; font-weight:700; font-size:13px; transition:all 0.2s;
      }
      .org-tab:hover { color:var(--primary); background:#fff; }
      .org-tab.active { color:var(--primary); border-bottom-color:var(--primary); background:#fff; }

      .org-content { flex:1; overflow-y:auto; }
      .org-tab-pane { display:none; padding:20px; }
      .org-tab-pane.active { display:block; }

      /* ── Info Grid ── */
      .info-grid {
        display:grid; grid-template-columns:repeat(2, 1fr);
        gap:15px; margin-bottom:20px;
      }
      .info-item {
        background:#f8f9fa; border:1px solid #e0e0e0;
        border-radius:8px; padding:12px;
      }
      .info-item .label {
        font-size:10px; font-weight:800; color:#777;
        text-transform:uppercase; margin-bottom:4px;
      }
      .info-item .value {
        font-size:14px; font-weight:700; color:#202124; word-break:break-word;
      }
      .org-logo-info {
        grid-column:span 2; display:flex; align-items:center; gap:14px;
      }
      .org-logo-preview {
        width:96px; height:64px; border-radius:8px; background:#fff;
        border:1px solid #e0e0e0; display:none; align-items:center; justify-content:center;
        overflow:hidden; flex:0 0 auto;
      }
      .org-logo-preview.visible { display:flex; }
      .org-logo-preview img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
      .org-logo-empty { color:#7b8794; font-size:13px; font-weight:700; }
      .paired-lead-meta {
        font-size:12px; color:#667085; font-weight:600; line-height:1.45; margin-top:6px;
      }
      .paired-lead-actions {
        display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;
      }

      /* ── Credit Section ── */
      .credit-section {
        background:#e8f5e9; border:1px solid #c8e6c9;
        border-radius:12px; padding:16px; margin-bottom:20px;
      }
      .credit-balance {
        font-size:32px; font-weight:900; color:#2e7d32; margin-bottom:8px;
      }
      .credit-actions { display:flex; gap:10px; margin-top:12px; flex-wrap:wrap; }
      .credit-input {
        flex:1 1 180px; padding:10px; border:1px solid #c8e6c9;
        border-radius:6px; font-size:14px;
      }
      .free-expedite-card{margin-top:14px;padding:14px;border:1px solid #fde68a;border-radius:12px;background:#fffbeb}
      .free-expedite-top{display:flex;justify-content:space-between;gap:12px;align-items:center}
      .free-expedite-label{font-size:11px;font-weight:900;color:#92400e;text-transform:uppercase;letter-spacing:.05em}
      .free-expedite-count{font-size:24px;font-weight:1000;color:#78350f}
      .free-expedite-note{margin-top:5px;font-size:12px;font-weight:700;color:#92400e}
      .credit-actions button { white-space:nowrap; }
      .btn-credit-deduct {
        background:#fff; color:#b42318; border:1px solid #f3b8b2;
      }
      .btn-credit-deduct:hover { background:#fff3f1; }

      /* ── Ledger Table ── */
      .ledger-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:15px; }
      .ledger-table th {
        background:#f8f9fa; padding:8px 10px; text-align:left;
        font-size:10px; color:#555; text-transform:uppercase; border-bottom:1px solid #eee;
      }
      .ledger-table td { padding:8px 10px; border-bottom:1px solid #f0f0f0; }
      .ledger-table tr:hover td { background:#fafafa; }
      .ledger-delta { font-weight:700; }
      .ledger-delta.positive { color:#2e7d32; }
      .ledger-delta.negative { color:#c62828; }

      /* ── Sub-user table ── */
      .subuser-table { width:100%; border-collapse:collapse; font-size:12px; }
      .subuser-table th {
        background:#f8f9fa; padding:10px 12px; text-align:left;
        font-size:10px; color:#555; text-transform:uppercase; border-bottom:1px solid #eee;
      }
      .subuser-table td { padding:10px 12px; border-bottom:1px solid #f0f0f0; }
      .subuser-table tr:hover td { background:#fafafa; }

      /* ── Orders Table ── */
      .orders-table { width:100%; border-collapse:collapse; font-size:12px; }
      .orders-table th {
        background:#f8f9fa; padding:10px 12px; text-align:left;
        font-size:10px; color:#555; text-transform:uppercase; border-bottom:1px solid #eee;
      }
      .orders-table td { padding:10px 12px; border-bottom:1px solid #f0f0f0; }
      .orders-table tr:hover td { background:#fafafa; }
      .order-badge {
        padding:3px 8px; border-radius:999px; font-size:9px;
        font-weight:900; text-transform:uppercase; display:inline-block;
      }
      .order-badge.completed { background:#e6f4ea; color:#137333; }
      .order-badge.processing { background:#e8f0fe; color:#1a73e8; }
      .order-badge.queued { background:#fff7e0; color:#7a4b00; }
      .order-badge.correction { background:#fce8e6; color:#b0261e; }

      /* ── Volume Chart (rolling 7-day weekly) ── */
      .volume-chart {
        display:flex; gap:6px; align-items:flex-end;
        margin-top:15px; overflow-x:auto; padding-bottom:8px;
        min-height:180px;
      }
      .volume-bar {
        display:flex; flex-direction:column; align-items:center; gap:4px;
        min-width:44px; flex-shrink:0;
      }
      .volume-bar-fill {
        width:100%; background:#e0e0e0; border-radius:4px;
        height:120px; display:flex; align-items:flex-end; overflow:hidden;
      }
      .volume-bar-inner {
        width:100%; background:linear-gradient(to top, var(--primary), #ff6b6b);
        transition:height 0.3s; border-radius:4px 4px 0 0;
      }
      .volume-bar-label {
        font-size:9px; font-weight:800; color:#666;
        white-space:nowrap; max-height:50px; overflow:hidden;
      }
      .volume-bar-value { font-size:11px; font-weight:900; color:#202124; }

      /* ── Empty State ── */
      .empty-state { text-align:center; padding:40px 20px; color:#999; }
      .empty-state i { font-size:48px; margin-bottom:12px; opacity:0.4; }
      .empty-state p { font-size:14px; }

      /* ── Impersonate Button ── */
      .btn-impersonate {
        background: linear-gradient(135deg, #ff6f00, #e65100);
        color: #fff; border: none; border-radius: 6px;
        padding: 5px 12px; font-size: 11px; font-weight: 800;
        cursor: pointer; transition: all 0.15s;
        box-shadow: 0 2px 6px rgba(230, 81, 0, 0.25);
        white-space: nowrap;
      }
      .btn-impersonate:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(230, 81, 0, 0.35);
      }
      .btn-impersonate:active { transform: translateY(0); }

      /* ── Test Toggle Button (in modal) ── */
      .btn-test-toggle {
        background: #fff3e0; color: #e65100; border: 1px solid #ffcc80;
        border-radius: 6px; padding: 5px 14px; font-size: 11px; font-weight: 800;
        cursor: pointer; transition: all 0.15s; white-space: nowrap;
      }
      .btn-test-toggle:hover { background: #ffe0b2; }
      .btn-test-toggle.is-test {
        background: #e65100; color: #fff; border-color: #e65100;
      }
      .btn-test-toggle.is-test:hover { background: #bf360c; }
      .cust-search-input {
        width:100%;
        box-sizing:border-box;
        padding:11px 13px;
        border:1px solid #d6dde7;
        border-radius:12px;
        background:#fff;
        color:#223040;
        font:inherit;
        line-height:1.35;
        box-shadow:0 1px 2px rgba(16,24,40,.04);
        transition:border-color .16s ease, box-shadow .16s ease, background .16s ease;
      }
      .cust-search-input::placeholder { color:#97a0af; }
      .cust-search-input:focus {
        outline:none;
        border-color:#d93025;
        box-shadow:0 0 0 4px rgba(217,48,37,.12);
      }
    `;
    const style = document.createElement('style');
    style.id = 'customersPluginStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ───────────── MARKUP ───────────── */
  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host || document.getElementById('view-customers')) return;

    const wrap = document.createElement('div');
    wrap.id = 'view-customers';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="header-bar">
        <h1>Customers</h1>
        <div style="display:flex;gap:10px;">
          <button class="btn-secondary" id="customersExportUsersBtn">
            <i class="fas fa-file-download"></i> Export Users TSV
          </button>
          <button class="btn-secondary" id="customersPairingBtn" style="display:none;">
            <i class="fas fa-link"></i> Pair Leads
          </button>
          <button class="btn-secondary" id="customersRefreshBtn">
            <i class="fas fa-sync"></i> Refresh
          </button>
        </div>
      </div>

      <div class="cust-stats" id="customerStats">
        <div class="cust-stat-card">
          <div class="label">Organizations</div>
          <div class="value" id="statTotalOrgs">0</div>
          <div class="sub" id="statTotalOrgsSub">Active accounts</div>
        </div>
        <div class="cust-stat-card">
          <div class="label">Total Users</div>
          <div class="value" id="statTotalUsers">0</div>
          <div class="sub" id="statTotalUsersSub">Across all orgs</div>
        </div>
        <div class="cust-stat-card">
          <div class="label">Total Lifetime Orders</div>
          <div class="value" id="statTotalOrders">0</div>
          <div class="sub" id="statTotalOrdersSub">All time</div>
        </div>
        <div class="cust-stat-card">
          <div class="label">Last 7 Days Orders</div>
          <div class="value" id="statRolling7">0</div>
          <div class="sub" id="statRolling7Sub">Rolling 7-day count</div>
        </div>
        <div class="cust-stat-card">
          <div class="label">Avg Orders / Day</div>
          <div class="value" id="statAvgOrdersDay">0</div>
          <div class="sub" id="statAvgOrdersDaySub">Based on last 7 days</div>
        </div>
        <div class="cust-stat-card">
          <div class="label">Total Credits</div>
          <div class="value" id="statTotalCredits">$0</div>
          <div class="sub" id="statTotalCreditsSub">In org accounts</div>
        </div>
      </div>

      <div class="cust-toolbar">
        <div class="cust-email-search">
          <i class="fas fa-search" aria-hidden="true"></i>
          <input type="search" id="customerEmailSearch" class="cust-search-input" placeholder="Search customer email…" aria-label="Search customers by email">
        </div>
        <div class="cust-toggle" id="hideTestOrgsToggle" tabindex="0" role="switch" aria-checked="false">
          <div class="cust-toggle-track"></div>
          <span>Hide test organizations</span>
        </div>
        <div class="cust-toggle" id="hideCommissionPaidToggle" tabindex="0" role="switch" aria-checked="false">
          <div class="cust-toggle-track"></div>
          <span>Hide 10+ order commission-paid organizations</span>
        </div>
        <div class="cust-page-controls">
          <label for="customerPageSize">Rows per page</label>
          <select id="customerPageSize">
            ${[100,200,300,400,500,600,700,800,900,1000].map(size => `<option value="${size}">${size}</option>`).join('')}
          </select>
          <span id="customerPageSummary">0 organizations</span>
        </div>
      </div>

      <div class="cust-table-wrap">
        <table class="cust-table" id="orgTable">
          <thead>
            <tr id="orgTableHeaderRow">
              <th class="sel-cell" data-col="_sel">&nbsp;</th>
              <th data-col="name">Name <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="users">Users <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="lifetimeOrders">Lifetime Orders <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="rolling7">Last 7d <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="avgOrdersDay">Avg/Day <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="credits">Credits <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="salesperson">Salesperson <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th data-col="created">Created <span class="sort-arrow">\u25B2\u25BC</span></th>
              <th style="width:1%; white-space:nowrap; cursor:default;">&nbsp;</th>
            </tr>
            <tr class="filter-row" id="orgTableFilterRow">
              <th></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="name" placeholder="Filter name\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="users" placeholder="Filter\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="lifetimeOrders" placeholder="Filter\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="rolling7" placeholder="Filter\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="avgOrdersDay" placeholder="Filter\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="credits" placeholder="Filter\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="salesperson" placeholder="Filter salesperson\u2026"><div class="cust-filter-menu"></div></div></th>
              <th><div class="cust-filter-wrap"><input type="text" data-col="created" placeholder="Filter\u2026"><div class="cust-filter-menu"></div></div></th>
              <th></th>
            </tr>
          </thead>
          <tbody id="orgTableBody">
            <tr>
              <td colspan="10" style="text-align:center;padding:30px;">
                <i class="fas fa-spinner fa-spin"></i> Loading organizations\u2026
              </td>
            </tr>
          </tbody>
        </table>
        <div class="cust-pager" id="customerPager">
          <div id="customerPagerSummary">Page 1 of 1</div>
          <div class="cust-pager-actions">
            <button class="btn-secondary" id="customerFirstPageBtn" type="button"><i class="fas fa-angle-double-left"></i> First</button>
            <button class="btn-secondary" id="customerPrevPageBtn" type="button"><i class="fas fa-chevron-left"></i> Previous</button>
            <button class="btn-secondary" id="customerNextPageBtn" type="button">Next <i class="fas fa-chevron-right"></i></button>
            <button class="btn-secondary" id="customerLastPageBtn" type="button">Last <i class="fas fa-angle-double-right"></i></button>
          </div>
        </div>
      </div>
    `;
    host.appendChild(wrap);

    /* ── Selection Stats Panel ── */
    const selPanel = document.createElement('div');
    selPanel.className = 'sel-stats-panel';
    selPanel.id = 'selStatsPanel';
    selPanel.innerHTML = `
      <div class="sel-stats-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="sel-title">Selection</span>
          <span class="sel-count" id="selCountBadge">0 orgs</span>
        </div>
        <button class="sel-stats-close" id="selStatsCloseBtn" title="Clear selection">&times;</button>
      </div>
      <div class="sel-stats-body">
        <div class="sel-stat">
          <div class="sel-stat-label">Organizations</div>
          <div class="sel-stat-value" id="selStatOrgs">0</div>
        </div>
        <div class="sel-stat">
          <div class="sel-stat-label">Users</div>
          <div class="sel-stat-value" id="selStatUsers">0</div>
        </div>
        <div class="sel-stat">
          <div class="sel-stat-label">Lifetime Orders</div>
          <div class="sel-stat-value" id="selStatOrders">0</div>
        </div>
        <div class="sel-stat">
          <div class="sel-stat-label">Last 7d Orders</div>
          <div class="sel-stat-value" id="selStatRolling7">0</div>
        </div>
        <div class="sel-stat">
          <div class="sel-stat-label">Avg / Day (7d)</div>
          <div class="sel-stat-value" id="selStatAvgDay">0</div>
        </div>
        <div class="sel-stat">
          <div class="sel-stat-label">Credits</div>
          <div class="sel-stat-value" id="selStatCredits">$0</div>
        </div>
      </div>
      <div class="sel-stats-footer">
        <div class="sel-assign-row" id="selAssignRow" style="display:none;">
          <button class="sel-action-btn sel-action-btn-clear" id="selClearBtn"><i class="fas fa-times"></i> Clear Selection</button>
          <button class="btn-primary sel-action-btn" id="selAssignBtn"><i class="fas fa-user-plus"></i> Assign Selected</button>
        </div>
        <button class="btn-clear-sel" id="selClearBtnFallback"><i class="fas fa-times"></i> Clear Selection</button>
      </div>
    `;
    document.body.appendChild(selPanel);

    const pairModal = document.createElement('div');
    pairModal.className = 'modal-overlay';
    pairModal.id = 'customerPairingModal';
    pairModal.innerHTML = `
      <div class="modal-card" style="width:1040px;max-height:88vh;display:flex;flex-direction:column;">
        <div class="modal-header">
          <h3 style="margin:0;">Lead Pairing</h3>
          <button class="modal-close" id="customerPairingClose">&times;</button>
        </div>
        <div class="modal-body" style="overflow:auto;padding:18px;">
          <div class="pair-subtabs">
            <button class="pair-subtab active" id="customerPairSuggestedTab" data-pair-mode="suggested">Suggested Matches</button>
            <button class="pair-subtab" id="customerPairManualTab" data-pair-mode="manual">Manual Pairing</button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
            <div id="customerPairingIntro" style="font-size:13px;color:#667085;">Review suggested customer-to-lead matches. Uncheck anything that should not be linked.</div>
            <button class="btn-secondary" id="customerPairingRefresh"><i class="fas fa-sync"></i> Rescan</button>
          </div>
          <div id="customerPairingBody"><div class="empty-state"><p>No pairing candidates loaded yet.</p></div></div>
        </div>
        <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div class="pair-summary-actions">
            <div id="customerPairingSummary" style="font-size:12px;color:#667085;">0 selected</div>
            <button class="btn-secondary" id="customerPairingDeselectAll" style="display:none;"><i class="fas fa-square"></i> Deselect All</button>
          </div>
          <div style="display:flex;gap:10px;">
            <button class="btn-secondary" id="customerPairingCancel">Close</button>
            <button class="btn-primary" id="customerPairingApply"><i class="fas fa-link"></i> Pair Selected</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(pairModal);

    const assignModal = document.createElement('div');
    assignModal.className = 'modal-overlay';
    assignModal.id = 'customerAssignModal';
    assignModal.innerHTML = `
      <div class="modal-card" style="width:720px;max-height:84vh;display:flex;flex-direction:column;">
        <div class="modal-header">
          <h3 style="margin:0;">Assign Customers</h3>
          <button class="modal-close" id="customerAssignClose">&times;</button>
        </div>
        <div class="modal-body" style="padding:18px;overflow:auto;">
          <div style="font-size:13px;color:#667085;margin-bottom:14px;">Choose the salesperson who should own the selected organizations.</div>
          <div class="sales-pick-grid" id="customerAssignGrid"></div>
        </div>
      </div>
    `;
    document.body.appendChild(assignModal);

    /* ── Org Detail Modal ── */
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'orgModal';
    modal.innerHTML = `
      <div class="modal-card org-modal">
        <div class="org-header">
          <div class="org-header-main">
            <div class="org-logo-frame" id="orgModalLogoFrame">
              <img id="orgModalLogoImg" alt="">
            </div>
            <div class="org-header-title">
              <h2 id="orgModalName">Organization</h2>
              <div class="meta">
                <span id="orgModalId">ID: -</span>
                <span>\u2022</span>
                <span id="orgModalCreated">Created: -</span>
                <span id="orgModalTestBadge"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="org-tabs">
          <button class="org-tab active" data-tab="overview">Overview</button>
          <button class="org-tab" data-tab="users">Users</button>
          <button class="org-tab" data-tab="orders">Orders</button>
          <button class="org-tab" data-tab="credits">Credits</button>
        </div>

        <div class="org-content">
          <!-- Overview -->
          <div class="org-tab-pane active" id="orgTabOverview">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <h3 style="margin:0;">Organization Info</h3>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                  <button class="btn-test-toggle" id="btnToggleTestOrg" title="Toggle test organization flag">
                    <i class="fas fa-flask"></i> <span id="btnToggleTestLabel">Mark as Test</span>
                  </button>
                </div>
            </div>
            <div class="info-grid">
              <div class="info-item org-logo-info">
                <div class="org-logo-preview" id="detailOrgLogoFrame">
                  <img id="detailOrgLogoImg" alt="">
                </div>
                <div>
                  <div class="label">Logo</div>
                  <div class="value" id="detailOrgLogoStatus">No logo</div>
                </div>
              </div>
              <div class="info-item">
                <div class="label">Name</div>
                <div class="value" id="detailOrgName">-</div>
              </div>
              <div class="info-item">
                <div class="label">Org ID</div>
                <div class="value" id="detailOrgId">-</div>
              </div>
              <div class="info-item">
                <div class="label">Total Users</div>
                <div class="value" id="detailOrgUsers">0</div>
              </div>
              <div class="info-item">
                <div class="label">Lifetime Orders</div>
                <div class="value" id="detailOrgLifetime">0</div>
              </div>
              <div class="info-item">
                <div class="label">Last 7 Days Orders</div>
                <div class="value" id="detailOrgRolling7">0</div>
              </div>
              <div class="info-item">
                <div class="label">Avg Orders / Day (7d)</div>
                <div class="value" id="detailOrgAvgDay">0</div>
              </div>
              <div class="info-item">
                <div class="label">Credit Balance</div>
                <div class="value" id="detailOrgBalance">$0</div>
              </div>
              <div class="info-item">
                <div class="label">Paired Lead</div>
                <div class="value" id="detailOrgPairedLead">-</div>
                <div class="paired-lead-actions" id="detailOrgPairedLeadActions"></div>
              </div>
            </div>
            <h3>Rolling 7-Day Order Volume (Weekly)</h3>
            <div class="volume-chart" id="orgVolumeChart"></div>
          </div>

          <!-- Users -->
          <div class="org-tab-pane" id="orgTabUsers">
            <h3 style="margin-top:0;">Organization Users</h3>
            <table class="subuser-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Perm Level</th>
                  <th>Orders</th>
                  <th>Joined</th>
                  <th style="text-align:right;">Actions</th>
                </tr>
              </thead>
              <tbody id="orgUsersTableBody">
                <tr><td colspan="6" class="empty-state"><p>No users</p></td></tr>
              </tbody>
            </table>
          </div>

          <!-- Orders -->
           <div class="org-tab-pane" id="orgTabOrders">
             <h3 style="margin-top:0;">All Orders</h3>
             <table class="orders-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Ordered By</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
               <tbody id="orgOrdersTableBody">
                 <tr><td colspan="4" class="empty-state"><p>No orders yet</p></td></tr>
               </tbody>
             </table>
             <div id="orgOrdersPager" class="cust-modal-pager"></div>
           </div>

          <!-- Credits -->
          <div class="org-tab-pane" id="orgTabCredits">
            <div class="credit-section">
              <div style="font-size:11px;font-weight:800;color:#2e7d32;text-transform:uppercase;margin-bottom:4px;">
                Organization Balance
              </div>
              <div class="credit-balance" id="orgCreditBalance">$0</div>
              <div class="credit-actions">
                <input type="number" id="orgCreditAmountInput" class="credit-input"
                       placeholder="Amount ($)" min="1" step="1">
                <button class="btn-primary" id="btnOrgIssueCredit">
                  <i class="fas fa-plus-circle"></i> Add Credit
                </button>
                <button class="btn-secondary btn-credit-deduct" id="btnOrgDeductCredit">
                  <i class="fas fa-minus-circle"></i> Deduct Credit
                </button>
              </div>
              <div class="free-expedite-card">
                <div class="free-expedite-top">
                  <div>
                    <div class="free-expedite-label">Free Expedite Uses</div>
                    <div class="free-expedite-note">Used to waive rush delivery charges on roof reports.</div>
                  </div>
                  <div class="free-expedite-count" id="orgFreeExpediteUses">0</div>
                </div>
                <div class="credit-actions">
                  <input type="number" id="orgFreeExpediteAmountInput" class="credit-input"
                         placeholder="Uses" min="1" step="1">
                  <button class="btn-primary" id="btnOrgIssueFreeExpedite">
                    <i class="fas fa-bolt"></i> Add Uses
                  </button>
                  <button class="btn-secondary btn-credit-deduct" id="btnOrgDeductFreeExpedite">
                    <i class="fas fa-minus-circle"></i> Deduct Uses
                  </button>
                </div>
              </div>
            </div>
            <h3>Credit Ledger</h3>
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Balance After</th>
                </tr>
              </thead>
               <tbody id="orgLedgerTableBody">
                 <tr><td colspan="4" class="empty-state"><p>No transactions</p></td></tr>
               </tbody>
             </table>
             <div id="orgCreditsPager" class="cust-modal-pager"></div>
           </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" id="orgModalClose">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  /* ───────────── STATE ───────────── */
  let allOrgs = [];
  let currentOrg = null;
  let orgDetailRequestSeq = 0;
  let sortCol = 'name';
  let sortDir = 'asc';
  let colFilters = {};
  let customerEmailSearch = '';
  let hideTestOrgs = true;
  let hideCommissionPaidOrgs = false;
  let salesUsers = [];
  let canManageView = false;
  let pairingCandidates = [];
  let pairingSelected = new Set();
  let pairingMode = 'suggested';
  let manualCustomerSearch = '';
  let manualLeadSearch = '';
  let manualLeadResults = [];
  let manualSelectedOrgId = '';
  let manualSelectedLeadId = '';
  let manualCustomerSearchTimer = null;
  let manualLeadSearchTimer = null;
  let manualLeadSearchSeq = 0;
  const CUSTOMER_PAGE_SIZE_KEY = 'customers_page_size_v1';
  let customerPage = 1;
  let customerPageSize = loadCustomerPageSize();
  let customerTotalCount = 0;
  let customerTotalPages = 1;
  let customerTotals = null;
  let customerTotalsComplete = false;
  let customerLoadSeq = 0;
  let customerFilterTimer = null;

  // Selection state
  let selectedIds = new Set();
  let lastClickedIndex = null;
  let dragSelecting = false;
  let dragStartIndex = null;
  let dragMode = null;        // 'add' | 'remove'
  let dragBaseSelection = new Set(); // snapshot of selection when drag started (for ctrl+drag)
  let dragPreviewIds = new Set();
  let visibleOrgsList = [];

  /* ───────────── UTILS ───────────── */
  const esc = s => Portal.escapeHtml(s);

  function loadCustomerPageSize(){
    try {
      const value = parseInt(localStorage.getItem(CUSTOMER_PAGE_SIZE_KEY) || '200', 10);
      return value >= 100 && value <= 1000 && value % 100 === 0 ? value : 200;
    } catch(e) {
      return 200;
    }
  }

  function saveCustomerPageSize(value){
    try { localStorage.setItem(CUSTOMER_PAGE_SIZE_KEY, String(value)); } catch(e){}
  }

  function fmtDate(d){
    if (!d) return '-';
    try { return new Date(String(d).replace(' ','T')).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); }
    catch(e){ return d; }
  }
  function fmtDateTime(d){
    if (!d) return '-';
    try { return new Date(String(d).replace(' ','T')).toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
    catch(e){ return d; }
  }
  function fmtCurrency(n){ return '$' + (parseFloat(n)||0).toFixed(0); }
  function tsvCell(v){
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
  }
  function tsvList(values){
    return (Array.isArray(values) ? values : []).map(tsvCell).filter(Boolean).join(' | ');
  }
  function emailDomain(email){
    const raw = String(email || '').trim().toLowerCase();
    const at = raw.lastIndexOf('@');
    return at >= 0 ? raw.slice(at + 1) : '';
  }
  function userPermissionLevel(user){
    const perms = user && typeof user.org_permissions === 'object' ? user.org_permissions : {};
    return String(user?.org_permission_level || user?.permission_level || perms.level || user?.role || '').trim().toLowerCase();
  }
  function userContactInfo(user){
    const profile = user && typeof user.profile === 'object' ? user.profile : {};
    const contact = user && typeof user.contact === 'object' ? user.contact : {};
    return {
      name: user?.name || contact.name || profile.name || '',
      email: user?.email || contact.email || profile.email || '',
      phone: user?.phone || contact.phone || profile.phone || '',
      title: user?.title || contact.title || profile.title || profile.job_title || '',
      company: user?.company || contact.company || profile.company || '',
      address: user?.address || contact.address || profile.address || '',
      permission: userPermissionLevel(user),
      created_at: user?.created_at || ''
    };
  }
  function orgAdminContacts(org){
    const rank = { super_admin: 0, owner: 1, admin: 2 };
    return (Array.isArray(org?.users) ? org.users : [])
      .map(user => ({ user, level: userPermissionLevel(user) }))
      .filter(item => Object.prototype.hasOwnProperty.call(rank, item.level))
      .sort((a, b) => {
        const byRank = rank[a.level] - rank[b.level];
        if (byRank) return byRank;
        return ((a.user?.name || a.user?.email || '')).localeCompare((b.user?.name || b.user?.email || ''), undefined, { sensitivity:'base' });
      })
      .slice(0, 2)
      .map(item => userContactInfo(item.user));
  }
  function adminContactTsvFields(contact){
    const c = contact || {};
    return [
      c.name || '',
      c.email || '',
      emailDomain(c.email || ''),
      c.phone || '',
      c.title || '',
      c.company || '',
      c.address || '',
      c.permission || '',
      c.created_at || ''
    ];
  }
  function pickLatestByDate(rows, key){
    if (!Array.isArray(rows) || !rows.length) return null;
    let latest = null;
    let latestTs = -Infinity;
    rows.forEach(row => {
      if (!row || typeof row !== 'object') return;
      const raw = row[key];
      const ts = raw ? new Date(String(raw).replace(' ', 'T')).getTime() : NaN;
      if (Number.isFinite(ts) && ts > latestTs) {
        latest = row;
        latestTs = ts;
      } else if (!latest) {
        latest = row;
      }
    });
    return latest;
  }

  function canOpenPairedLead(){
    return !!(window.Leads && typeof window.Leads.queueOpenLead === 'function' && window.Portal && typeof window.Portal.switchView === 'function');
  }

  function getPairedLeads(org){
    return Array.isArray(org?.paired_leads)
      ? org.paired_leads.filter(lead => lead && typeof lead === 'object' && String(lead.id || '').trim() !== '')
      : [];
  }

  function getPrimaryPairedLead(org){
    const leads = getPairedLeads(org);
    const primaryId = String(org?.paired_primary_lead_id || '').trim();
    if (primaryId) {
      const linkedMatch = leads.find(lead => String(lead.id || '') === primaryId && lead.is_linked !== false);
      if (linkedMatch) return linkedMatch;
      const anyMatch = leads.find(lead => String(lead.id || '') === primaryId);
      if (anyMatch) return anyMatch;
    }
    return leads[0] || null;
  }

  async function openLeadFromCustomer(leadId){
    const id = String(leadId || '').trim();
    if (!id || !canOpenPairedLead()) return;
    try {
      window.Leads.queueOpenLead(id, { sourceView:'customers', sourceNavId:'nav-customers' });
      const navBtn = document.getElementById('nav-leads');
      await Promise.resolve(window.Portal.switchView('leads', navBtn));
    } catch (e) {
      alert(e?.message || 'Could not open lead.');
    }
  }

  function countOrdersInLastDays(orders, days){
    const cutoff = Date.now() - (days * 86400000);
    return (orders||[]).filter(o => {
      const t = new Date(o.created_at||0).getTime();
      return t && t >= cutoff;
    }).length;
  }

  /* ───────────── DATA FETCH ───────────── */

  async function fetchAllOrgData(){
    try {
      const payload = {
        action:'customer_org_dashboard_data',
        paginate:'1',
        page:String(customerPage),
        per_page:String(customerPageSize),
        sort_col:sortCol,
        sort_dir:sortDir,
        filters:JSON.stringify({ ...colFilters, email: customerEmailSearch }),
        hide_test:hideTestOrgs ? '1' : '0',
        hide_commission_paid:hideCommissionPaidOrgs ? '1' : '0'
      };
      const data = (window.Portal && typeof window.Portal.apiPost === 'function')
        ? await window.Portal.apiPost(apiServer(), payload)
        : await fetch(apiServer(), {
            method:'POST',
            body: new URLSearchParams(payload)
          }).then(async res => {
            const raw = await res.text();
            try {
              return JSON.parse(raw);
            } catch(parseErr) {
              console.error('fetchAllOrgData received non-JSON response', {
                status: res.status,
                statusText: res.statusText,
                bodyStart: raw.slice(0, 600)
              });
              throw parseErr;
            }
          });
      if (!data.success) throw new Error(data.error || 'Failed to load customers');
      salesUsers = Array.isArray(data.sales_users) ? data.sales_users : [];
      canManageView = !!data.can_manage;
      const pagination = data.pagination && typeof data.pagination === 'object' ? data.pagination : {};
      customerPage = Math.max(1, parseInt(pagination.page || customerPage, 10) || 1);
      customerPageSize = Math.max(100, Math.min(1000, parseInt(pagination.per_page || customerPageSize, 10) || 200));
      customerTotalCount = Math.max(0, parseInt(pagination.total_count || 0, 10) || 0);
      customerTotalPages = Math.max(1, parseInt(pagination.total_pages || 1, 10) || 1);
      customerTotals = data.totals && typeof data.totals === 'object' ? data.totals : null;
      customerTotalsComplete = data.totals_complete === true;
      return Array.isArray(data.organizations) ? data.organizations : [];
    } catch(e){
      console.error('fetchAllOrgData error', e);
      return [];
    }
  }

  async function fetchOrgDetail(orgId, options = {}){
    const payload = {
      action: 'customer_org_detail',
      org_id: orgId,
      orders_page: String(options.ordersPage || 1),
      ledger_page: String(options.ledgerPage || 1)
    };
    if (window.Portal && typeof window.Portal.apiPost === 'function') {
      return await window.Portal.apiPost(apiServer(), payload);
    }
    const res = await fetch(apiServer(), { method:'POST', body: new URLSearchParams(payload) });
    const raw = await res.text();
    try {
      return JSON.parse(raw);
    } catch(parseErr) {
      console.error('fetchOrgDetail received non-JSON response', {
        status: res.status,
        statusText: res.statusText,
        bodyStart: raw.slice(0, 600),
        orgId
      });
      throw parseErr;
    }
  }

  function mergeOrgData(orgId, detail){
    const idx = allOrgs.findIndex(o => o.id === orgId);
    if (idx < 0) return null;
    allOrgs[idx] = { ...allOrgs[idx], ...detail };
    if (currentOrg && currentOrg.id === orgId) currentOrg = allOrgs[idx];
    return allOrgs[idx];
  }

  function normalizeEmail(value){
    return String(value || '').trim().toLowerCase();
  }

  function normalizeOrgId(value){
    return String(value || '').trim().toLowerCase();
  }

  function orgLogoUrl(org){
    const branding = org && org.branding && typeof org.branding === 'object' ? org.branding : {};
    const raw = String(branding.logo_url || branding.logo_node_url || branding.logo || '').trim();
    if (!raw) return '';
    if (/^(https?:|data:)/i.test(raw)) return raw;
    if (raw.startsWith('/')) return raw;
    return '';
  }

  function updateImageSlot(frameId, imgId, url, alt){
    const frame = document.getElementById(frameId);
    const img = document.getElementById(imgId);
    if (!frame || !img) return;
    frame.classList.toggle('visible', !!url);
    if (!url) {
      img.removeAttribute('src');
      img.alt = '';
      return;
    }
    img.alt = alt || 'Organization logo';
    img.onerror = () => {
      frame.classList.remove('visible');
      img.removeAttribute('src');
    };
    img.src = url;
  }

  function projectOrgId(project){
    const orgRef = project && typeof project.organization_ref === 'object' ? project.organization_ref : {};
    return normalizeOrgId(
      project?.organization_id ||
      project?.org_id ||
      project?.org ||
      orgRef.id ||
      orgRef.organization_id
    );
  }

  function projectOwnerEmail(project){
    const ownerRef = project && typeof project.owner_ref === 'object' ? project.owner_ref : {};
    return normalizeEmail(
      project?.owner_email ||
      ownerRef.email ||
      project?.customer_email ||
      project?.email
    );
  }

  function projectIssuerEmail(project){
    const issuer = project && typeof project.issuer === 'object' ? project.issuer : {};
    return normalizeEmail(project?.issuer_email || issuer.email);
  }

  function projectBelongsToOrg(project, org){
    const orgId = normalizeOrgId(org?.id);
    if (!project || !orgId) return false;
    if (projectOrgId(project) === orgId) return true;

    const userEmails = new Set((Array.isArray(org?.users) ? org.users : [])
      .map(user => normalizeEmail(user?.email))
      .filter(Boolean));
    if (!userEmails.size) return false;
    return userEmails.has(projectOwnerEmail(project)) || userEmails.has(projectIssuerEmail(project));
  }

  function projectCreatedAt(project){
    const timestamps = project && typeof project.timestamps === 'object' ? project.timestamps : {};
    return project?.created_at || timestamps.created_at || project?.queued_at || timestamps.queued_at || project?.updated_at || null;
  }

  function orderRowFromProject(project){
    const id = String(project?.id || project?.folder || '').trim();
    return {
      id,
      address: String(project?.address || project?.property_address || ''),
      status: String(project?.status || project?.st || 'queued').trim() || 'queued',
      owner_email: projectOwnerEmail(project),
      issuer: { email: projectIssuerEmail(project) },
      revenue: Number(project?.amount_charged || project?.revenue || 0) || 0,
      created_at: projectCreatedAt(project)
    };
  }

  function volumeBucketsFromOrders(orders){
    const now = new Date();
    const weeks = 52;
    const dayMs = 86400000;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const buckets = [];
    for (let w = 0; w < weeks; w++) {
      const endDate = new Date(today.getTime() - (w * 7 * dayMs));
      const startDate = new Date(endDate.getTime() - (7 * dayMs));
      buckets.push({
        startDate,
        endDate,
        label: (endDate.getMonth() + 1) + '/' + endDate.getDate(),
        count: 0
      });
    }
    buckets.reverse();
    (Array.isArray(orders) ? orders : []).forEach(order => {
      const ts = new Date(order?.created_at || 0).getTime();
      if (!ts) return;
      for (const bucket of buckets) {
        if (ts > bucket.startDate.getTime() && ts <= bucket.endDate.getTime() + dayMs) {
          bucket.count++;
          break;
        }
      }
    });
    return buckets.map(bucket => ({ label: bucket.label, count: bucket.count }));
  }

  async function fetchOrgOrdersFromProjectsApi(org, options = {}){
    if (!window.Portal || typeof window.Portal.fmPost !== 'function') return null;
    const orgId = normalizeOrgId(org?.id);
    if (!orgId) return null;

    const ordersPage = Math.max(1, parseInt(options.ordersPage || 1, 10) || 1);
    const perPage = Math.max(10, Math.min(200, parseInt(options.ordersPerPage || 50, 10) || 50));
    const collected = [];
    const seen = new Set();
    let page = 1;
    let totalPages = 1;
    const maxPages = 250;

    while (page <= totalPages && page <= maxPages) {
      const data = await window.Portal.fmPost('projects/list', {
        filter: 'all',
        status_filter: 'all',
        include_all: true,
        limit: 200,
        page
      });
      const batch = Array.isArray(data?.projects) ? data.projects : [];
      batch.forEach(project => {
        if (!projectBelongsToOrg(project, org)) return;
        const row = orderRowFromProject(project);
        const key = row.id || `${row.owner_email}|${row.address}|${row.created_at}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        collected.push(row);
      });

      const pagination = data && typeof data.pagination === 'object' ? data.pagination : {};
      const reportedTotalPages = parseInt(pagination.total_pages || 0, 10) || 0;
      if (reportedTotalPages > 0) {
        totalPages = reportedTotalPages;
      } else {
        const totalCount = parseInt(pagination.total_count || data?.total_count || 0, 10) || 0;
        totalPages = totalCount > 0 ? Math.ceil(totalCount / 200) : page;
      }
      if (!batch.length || page >= totalPages) break;
      page++;
    }

    collected.sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0));
    const total = collected.length;
    const totalPagesOut = Math.max(1, Math.ceil(total / perPage));
    const pageClamped = Math.min(ordersPage, totalPagesOut);
    const offset = (pageClamped - 1) * perPage;
    return {
      orders: collected.slice(offset, offset + perPage),
      orders_pagination: {
        page: pageClamped,
        per_page: perPage,
        total,
        total_pages: totalPagesOut
      },
      volume_buckets: volumeBucketsFromOrders(collected),
      latest_order: collected[0] || null
    };
  }

  async function hydrateMissingOrgOrders(org, options = {}){
    const declaredCount = parseInt(org?.orders_count ?? org?.lifetimeOrders ?? 0, 10) || 0;
    if (!org || (Array.isArray(org.orders) && org.orders.length) || declaredCount <= 0) return org;
    try {
      const fallback = await fetchOrgOrdersFromProjectsApi(org, options);
      if (!fallback || !Array.isArray(fallback.orders) || !fallback.orders.length) return org;
      return {
        ...org,
        orders: fallback.orders,
        orders_pagination: fallback.orders_pagination,
        volume_buckets: fallback.volume_buckets,
        latest_order: org.latest_order || fallback.latest_order,
        orders_count: Math.max(declaredCount, fallback.orders_pagination.total),
        lifetimeOrders: Math.max(parseInt(org.lifetimeOrders || 0, 10) || 0, fallback.orders_pagination.total)
      };
    } catch (e) {
      console.warn('Could not hydrate customer orders from projects API', e);
      return org;
    }
  }

  /* ───────────── RENDER ───────────── */

  function computeStatsFor(orgs){
    const real = orgs.filter(o => !o.is_test);
    const testCount = orgs.length - real.length;
    const totalUsers = real.reduce((s,o)=>s+o.users.length,0);
    const totalOrders = real.reduce((s,o)=>s+o.lifetimeOrders,0);
    const totalCredits = real.reduce((s,o)=>s+(o.credits_balance||0),0);
    const totalRolling7 = real.reduce((s,o)=>s+o.rolling7,0);
    const avgDay = +(totalRolling7 / 7).toFixed(2);
    return { count:real.length, testCount, totalUsers, totalOrders, totalCredits, totalRolling7, avgDay };
  }

  function renderStats(orgs){
    const pageStats = computeStatsFor(orgs);
    const hasCompleteTotals = customerTotalsComplete && customerTotals;
    const s = hasCompleteTotals ? {
      count:Number(customerTotals.organizations || 0),
      testCount:Number(customerTotals.test_organizations || 0),
      totalUsers:Number(customerTotals.users || 0),
      totalOrders:Number(customerTotals.lifetime_orders || 0),
      totalCredits:Number(customerTotals.credits_balance || 0),
      totalRolling7:Number(customerTotals.rolling7 || 0),
      avgDay:Number(customerTotals.avg_orders_day || 0)
    } : {
      ...pageStats,
      count:customerTotalCount || pageStats.count
    };
    document.getElementById('statTotalOrgs').textContent = s.count;
    document.getElementById('statTotalOrgsSub').textContent =
      hasCompleteTotals && s.testCount > 0 ? `Active accounts (${s.testCount} test hidden)` : 'Matching accounts';
    document.getElementById('statTotalUsers').textContent = s.totalUsers;
    document.getElementById('statTotalOrders').textContent = s.totalOrders;
    document.getElementById('statRolling7').textContent = s.totalRolling7;
    document.getElementById('statAvgOrdersDay').textContent = s.avgDay;
    document.getElementById('statTotalCredits').textContent = fmtCurrency(s.totalCredits);
    const labels = hasCompleteTotals ? {
      statTotalUsersSub:'Across all matching orgs',
      statTotalOrdersSub:'All matching orgs · all time',
      statRolling7Sub:'All matching orgs · rolling 7 days',
      statAvgOrdersDaySub:'All matching orgs · last 7 days',
      statTotalCreditsSub:'Across all matching orgs'
    } : {
      statTotalUsersSub:'Current page',
      statTotalOrdersSub:'Current page · all time',
      statRolling7Sub:'Current page · rolling 7 days',
      statAvgOrdersDaySub:'Current page · last 7 days',
      statTotalCreditsSub:'Current page'
    };
    Object.entries(labels).forEach(([id, label]) => {
      const sub = document.getElementById(id);
      if (sub) sub.textContent = label;
    });
  }

  function getVisibleOrgs(){
    let list = [...allOrgs];
    return list;
  }

  function renderCustomerPager(){
    const summary = document.getElementById('customerPageSummary');
    const pagerSummary = document.getElementById('customerPagerSummary');
    const firstRow = customerTotalCount ? ((customerPage - 1) * customerPageSize) + 1 : 0;
    const lastRow = Math.min(customerTotalCount, customerPage * customerPageSize);
    if (summary) summary.textContent = `${customerTotalCount.toLocaleString()} organization${customerTotalCount === 1 ? '' : 's'}`;
    if (pagerSummary) {
      pagerSummary.textContent = `Page ${customerPage.toLocaleString()} of ${customerTotalPages.toLocaleString()} · showing ${firstRow.toLocaleString()}–${lastRow.toLocaleString()}`;
    }
    const first = document.getElementById('customerFirstPageBtn');
    const prev = document.getElementById('customerPrevPageBtn');
    const next = document.getElementById('customerNextPageBtn');
    const last = document.getElementById('customerLastPageBtn');
    if (first) first.disabled = customerPage <= 1;
    if (prev) prev.disabled = customerPage <= 1;
    if (next) next.disabled = customerPage >= customerTotalPages;
    if (last) last.disabled = customerPage >= customerTotalPages;
    const size = document.getElementById('customerPageSize');
    if (size) size.value = String(customerPageSize);
  }

  function renderOrgTable(){
    const list = getVisibleOrgs();
    visibleOrgsList = list;
    const tbody = document.getElementById('orgTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    document.querySelectorAll('#orgTableHeaderRow th').forEach(th => {
      th.classList.remove('sorted-asc','sorted-desc');
      if (th.dataset.col === sortCol) th.classList.add(sortDir==='asc'?'sorted-asc':'sorted-desc');
    });

    if (list.length === 0){
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:#999;">
        <i class="fas fa-building" style="font-size:48px;opacity:0.3;display:block;margin-bottom:12px;"></i>
        No organizations found</td></tr>`;
      updateSelectionStats();
      return;
    }

    list.forEach((o, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.orgId = o.id;
      tr.dataset.visIdx = idx;
      if (o.is_test) tr.classList.add('test-row');
      if (selectedIds.has(o.id)) tr.classList.add('row-selected');
      if (dragPreviewIds.has(o.id)) tr.classList.add('row-drag-preview');

      const testBadge = o.is_test ? '<span class="test-badge">TEST</span>' : '';
      const salesLabel = (o.assigned_sales_name || o.assigned_sales_email)
        ? esc(o.assigned_sales_name || o.assigned_sales_email)
        : '<span style="color:#98a2b3;">Unassigned</span>';
      tr.innerHTML = `
        <td class="sel-cell"><div class="sel-check"><i class="fas fa-check" style="font-size:10px;"></i></div></td>
        <td><strong>${esc(o.name)}</strong>${testBadge}</td>
        <td>${o.users.length}</td>
        <td><strong>${o.lifetimeOrders}</strong></td>
        <td>${o.rolling7}</td>
        <td>${o.avgOrdersDay}</td>
        <td><strong style="color:#2e7d32;">${fmtCurrency(o.credits_balance)}</strong></td>
        <td>${salesLabel}</td>
        <td>${fmtDate(o.created_at)}</td>
        <td style="text-align:right;">
          <button class="btn-row-open" data-org-id="${esc(o.id)}" title="View organization details">
            <i class="fas fa-external-link-alt"></i> Open
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Wire open buttons
    tbody.querySelectorAll('.btn-row-open').forEach(btn => {
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openOrgDetail(btn.dataset.orgId);
      });
    });

    updateSelectionStats();
  }

  /* ───────────── SELECTION LOGIC ───────────── */

  function setRowVisual(orgId, selected){
    const row = document.querySelector(`#orgTableBody tr[data-org-id="${orgId}"]`);
    if (row) row.classList.toggle('row-selected', selected);
  }

  function clearSelection(){
    selectedIds.clear();
    document.querySelectorAll('#orgTableBody tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
    lastClickedIndex = null;
    updateSelectionStats();
  }

  function renderRowClasses(){
    document.querySelectorAll('#orgTableBody tr[data-org-id]').forEach(tr => {
      const id = tr.dataset.orgId;
      tr.classList.toggle('row-selected', selectedIds.has(id));
      tr.classList.toggle('row-drag-preview', dragPreviewIds.has(id));
    });
  }

  function handleRowMousedown(e, tr){
    // Ignore if clicking a button, input, or link
    if (e.target.closest('button, a, input')) return;

    const idx = parseInt(tr.dataset.visIdx, 10);
    const orgId = tr.dataset.orgId;

    if (e.shiftKey && lastClickedIndex !== null) {
      // Shift+click: range select
      e.preventDefault();
      const lo = Math.min(lastClickedIndex, idx);
      const hi = Math.max(lastClickedIndex, idx);
      if (!(e.ctrlKey || e.metaKey)) {
        selectedIds.clear();
      }
      for (let i = lo; i <= hi; i++){
        const org = visibleOrgsList[i];
        if (org) selectedIds.add(org.id);
      }
      // don't update lastClickedIndex on shift-click (anchor stays)
      renderRowClasses();
      updateSelectionStats();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle single, keep rest
      e.preventDefault();
      if (selectedIds.has(orgId)) selectedIds.delete(orgId);
      else selectedIds.add(orgId);
      setRowVisual(orgId, selectedIds.has(orgId));
      lastClickedIndex = idx;
      updateSelectionStats();
      return;
    }

    // Plain click: begin drag-select
    e.preventDefault();
    dragSelecting = true;
    dragStartIndex = idx;
    dragMode = 'add';
    dragBaseSelection = new Set(); // plain click clears previous
    dragPreviewIds.clear();

    selectedIds.clear();
    selectedIds.add(orgId);
    lastClickedIndex = idx;

    document.body.classList.add('cust-selecting');
    renderRowClasses();
    updateSelectionStats();
  }

  function handleRowMouseenter(tr){
    if (!dragSelecting) return;
    const idx = parseInt(tr.dataset.visIdx, 10);
    const lo = Math.min(dragStartIndex, idx);
    const hi = Math.max(dragStartIndex, idx);

    // Rebuild selection: base + drag range
    selectedIds = new Set(dragBaseSelection);
    for (let i = lo; i <= hi; i++){
      const org = visibleOrgsList[i];
      if (org) selectedIds.add(org.id);
    }
    renderRowClasses();
    updateSelectionStats();
  }

  function handleMouseup(){
    if (!dragSelecting) return;
    dragSelecting = false;
    dragPreviewIds.clear();
    dragBaseSelection.clear();
    document.body.classList.remove('cust-selecting');
    renderRowClasses();
    updateSelectionStats();
  }

  /* ───────────── SELECTION STATS PANEL ───────────── */

  function updateSelectionStats(){
    const panel = document.getElementById('selStatsPanel');
    if (!panel) return;

    if (selectedIds.size === 0) {
      panel.classList.remove('visible');
      return;
    }

    const selOrgs = allOrgs.filter(o => selectedIds.has(o.id));
    const s = computeStatsFor(selOrgs);

    const testNote = (selOrgs.length !== s.count) ? ` (${selOrgs.length - s.count} test)` : '';
    document.getElementById('selCountBadge').textContent = selOrgs.length + (selOrgs.length===1 ? ' org' : ' orgs');
    document.getElementById('selStatOrgs').textContent = s.count + testNote;
    document.getElementById('selStatUsers').textContent = s.totalUsers;
    document.getElementById('selStatOrders').textContent = s.totalOrders;
    document.getElementById('selStatRolling7').textContent = s.totalRolling7;
    document.getElementById('selStatAvgDay').textContent = s.avgDay;
    document.getElementById('selStatCredits').textContent = fmtCurrency(s.totalCredits);

    const assignRow = document.getElementById('selAssignRow');
    if (assignRow) assignRow.style.display = canManageView ? 'flex' : 'none';
    const clearFallback = document.getElementById('selClearBtnFallback');
    if (clearFallback) clearFallback.style.display = canManageView ? 'none' : '';
    panel.classList.add('visible');
  }

  function populateSalespersonOptions(){
    const grid = document.getElementById('customerAssignGrid');
    if (!grid) return;
    grid.innerHTML = `
      <button type="button" class="sales-pick-btn" data-assign-sales="">
        <div style="font-weight:900;color:#223040;">Unassigned</div>
        <div style="font-size:12px;color:#667085;margin-top:4px;">Remove salesperson ownership from the selected organizations.</div>
      </button>
      ${salesUsers.map(u => `
        <button type="button" class="sales-pick-btn" data-assign-sales="${esc(u.email)}">
          <div style="font-weight:900;color:#223040;">${esc(u.name || u.email)}</div>
          <div style="font-size:12px;color:#667085;margin-top:4px;">${esc(u.email || '')}</div>
        </button>
      `).join('')}
    `;
  }

  function uniqueFilterValues(col){
    const values = [];
    const seen = new Set();
    getVisibleOrgs().forEach(o => {
      let raw = '';
      switch (col) {
        case 'name': raw = o.name || ''; break;
        case 'users': raw = String(o.users.length); break;
        case 'lifetimeOrders': raw = String(o.lifetimeOrders); break;
        case 'rolling7': raw = String(o.rolling7); break;
        case 'avgOrdersDay': raw = String(o.avgOrdersDay); break;
        case 'credits': raw = String(o.credits_balance || 0); break;
        case 'salesperson': raw = o.assigned_sales_name || o.assigned_sales_email || 'Unassigned'; break;
        case 'created': raw = fmtDate(o.created_at); break;
      }
      raw = String(raw || '').trim();
      if (!raw) return;
      const key = raw.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      values.push(raw);
    });
    values.sort((a,b) => a.localeCompare(b, undefined, { numeric:true, sensitivity:'base' }));
    return values;
  }

  function renderFilterMenu(input){
    const wrap = input.closest('.cust-filter-wrap');
    const menu = wrap ? wrap.querySelector('.cust-filter-menu') : null;
    if (!menu) return;
    const q = (input.value || '').trim().toLowerCase();
    const items = uniqueFilterValues(input.dataset.col).filter(v => !q || v.toLowerCase().includes(q)).slice(0, 200);
    if (!items.length) {
      menu.classList.remove('visible');
      menu.innerHTML = '';
      return;
    }
    menu.innerHTML = items.map(v => `<div class="cust-filter-option" data-value="${esc(v)}">${esc(v)}</div>`).join('');
    menu.classList.add('visible');
    menu.querySelectorAll('.cust-filter-option').forEach(opt => {
      opt.onmousedown = e => {
        e.preventDefault();
        input.value = opt.dataset.value || '';
        colFilters[input.dataset.col] = input.value.trim();
        menu.classList.remove('visible');
        queueCustomerReload();
      };
    });
  }

  function hideAllFilterMenus(){
    document.querySelectorAll('.cust-filter-menu.visible').forEach(el => el.classList.remove('visible'));
  }

  function hideOtherFilterMenus(currentInput){
    const currentWrap = currentInput?.closest('.cust-filter-wrap') || null;
    document.querySelectorAll('.cust-filter-menu.visible').forEach(el => {
      if (!currentWrap || !currentWrap.contains(el)) el.classList.remove('visible');
    });
  }

  async function assignSelectedOrganizations(assignedTo){
    if (!selectedIds.size) return;
    const res = await fetch(apiServer(), {
      method:'POST',
      body: new URLSearchParams({
        action: 'org_assign_sales_owner',
        org_ids: JSON.stringify(Array.from(selectedIds)),
        assigned_to_email: assignedTo
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert('Assignment failed: ' + (data.error || 'Unknown error'));
      return;
    }
    Portal.closeModal('customerAssignModal');
    await loadCustomers();
  }

  async function loadPairingCandidates(){
    const body = document.getElementById('customerPairingBody');
    if (!body) return;
    body.innerHTML = '<div class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Scanning for possible matches…</p></div>';
    pairingSelected.clear();
    const res = await fetch(apiServer(), {
      method:'POST',
      body: new URLSearchParams({ action: 'customer_pair_candidates' })
    });
    const data = await res.json();
    pairingCandidates = (Array.isArray(data.pairs) ? data.pairs : []).filter(pair => !pair.organization_is_test);
    pairingCandidates.forEach(p => pairingSelected.add(p.pair_id));
    renderPairingCandidates();
  }

  function filteredManualCustomers(){
    const q = manualCustomerSearch.trim().toLowerCase();
    const rows = allOrgs.filter(o => !o.is_test).filter(o => !q || [
      o.name || '',
      o.id || '',
      o.assigned_sales_name || '',
      o.assigned_sales_email || '',
      ...((o.users || []).map(u => `${u.name || ''} ${u.email || ''}`))
    ].join(' ').toLowerCase().includes(q));
    return rows.slice(0, 60);
  }

  async function searchManualLeads(){
    const seq = ++manualLeadSearchSeq;
    const q = manualLeadSearch.trim();
    if (!q) {
      manualLeadResults = [];
      renderPairingCandidates();
      return;
    }
    const res = await fetch(apiServer(), {
      method:'POST',
      body: new URLSearchParams({ action: 'lead_pair_search', q })
    });
    const data = await res.json();
    if (seq !== manualLeadSearchSeq) return;
    manualLeadResults = Array.isArray(data.leads) ? data.leads : [];
    renderPairingCandidates();
  }

  function debounceManualCustomerSearch(){
    if (manualCustomerSearchTimer) clearTimeout(manualCustomerSearchTimer);
    manualCustomerSearchTimer = setTimeout(() => {
      manualCustomerSearchTimer = null;
      renderPairingCandidates();
    }, 1000);
  }

  function debounceManualLeadSearch(){
    if (manualLeadSearchTimer) clearTimeout(manualLeadSearchTimer);
    manualLeadSearchTimer = setTimeout(() => {
      manualLeadSearchTimer = null;
      searchManualLeads();
    }, 1000);
  }

  function syncPairingFooter(){
    const summary = document.getElementById('customerPairingSummary');
    const deselectBtn = document.getElementById('customerPairingDeselectAll');
    const applyBtn = document.getElementById('customerPairingApply');
    if (!summary) return;
    if (pairingMode === 'manual') {
      const selectedOrg = allOrgs.find(o => o.id === manualSelectedOrgId && !o.is_test);
      const selectedLead = manualLeadResults.find(l => String(l.id) === String(manualSelectedLeadId));
      summary.textContent = `${selectedOrg ? 1 : 0} customer - ${selectedLead ? 1 : 0} lead selected`;
      if (deselectBtn) deselectBtn.style.display = 'none';
      if (applyBtn) applyBtn.style.display = 'none';
      return;
    }
    summary.textContent = `${pairingSelected.size} selected`;
    if (deselectBtn) {
      deselectBtn.style.display = pairingCandidates.length ? '' : 'none';
      deselectBtn.disabled = pairingSelected.size === 0;
    }
    if (applyBtn) {
      applyBtn.style.display = '';
      applyBtn.disabled = pairingSelected.size === 0;
    }
  }

  function renderManualPairing(){
    const body = document.getElementById('customerPairingBody');
    const summary = document.getElementById('customerPairingSummary');
    const intro = document.getElementById('customerPairingIntro');
    if (!body || !summary || !intro) return;
    intro.textContent = 'Search for a specific customer and a specific lead, select one of each, then pair them manually.';
    const activeId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : '';
    const activeSelectionStart = document.activeElement && typeof document.activeElement.selectionStart === 'number' ? document.activeElement.selectionStart : null;
    const activeSelectionEnd = document.activeElement && typeof document.activeElement.selectionEnd === 'number' ? document.activeElement.selectionEnd : null;
    const customers = filteredManualCustomers();
    const selectedOrg = allOrgs.find(o => o.id === manualSelectedOrgId && !o.is_test);
    const selectedLead = manualLeadResults.find(l => String(l.id) === String(manualSelectedLeadId));
    syncPairingFooter();
    body.innerHTML = `
      <div class="manual-pair-grid">
        <div class="manual-pair-col">
          <div style="font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#6d7787;">Customer Search</div>
          <input type="text" id="manualPairCustomerSearch" class="cust-search-input" placeholder="Search customers..." value="${esc(manualCustomerSearch)}">
          <div class="manual-pair-list">
            ${customers.length ? customers.map(org => `
              <div class="manual-pair-item ${org.id === manualSelectedOrgId ? 'active' : ''}" data-manual-org="${esc(org.id)}">
                <div style="font-weight:900;color:#223040;">${esc(org.name || org.id)}</div>
                <div style="font-size:12px;color:#667085;margin-top:4px;">${esc(org.assigned_sales_name || org.assigned_sales_email || 'Unassigned')}</div>
              </div>
            `).join('') : '<div class="comm-empty">No customers match that search.</div>'}
          </div>
        </div>
        <div class="manual-pair-col">
          <div style="font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#6d7787;">Lead Search</div>
          <input type="text" id="manualPairLeadSearch" class="cust-search-input" placeholder="Search leads..." value="${esc(manualLeadSearch)}">
          <div class="manual-pair-list">
            ${manualLeadResults.length ? manualLeadResults.map(lead => `
              <div class="manual-pair-item ${String(lead.id) === String(manualSelectedLeadId) ? 'active' : ''}" data-manual-lead="${esc(lead.id)}">
                <div style="font-weight:900;color:#223040;">${esc(lead.company || 'Lead')}</div>
                <div style="font-size:12px;color:#667085;margin-top:4px;">${esc(lead.email || lead.phone || '-')}</div>
                <div style="font-size:11px;color:#98a2b3;margin-top:4px;">${esc(lead.list_name || '')}${lead.organization_id ? ' • Converted' : ''}</div>
              </div>
            `).join('') : '<div class="comm-empty">Search leads to populate this list.</div>'}
          </div>
        </div>
      </div>
      <div class="manual-pair-actions">
        <button class="btn-primary" id="manualPairApplyBtn" ${selectedOrg && selectedLead ? '' : 'disabled'}><i class="fas fa-link"></i> Pair Selected Customer + Lead</button>
      </div>
    `;
    document.getElementById('manualPairCustomerSearch')?.addEventListener('input', (e) => {
      manualCustomerSearch = e.target.value || '';
      debounceManualCustomerSearch();
    });
    document.getElementById('manualPairLeadSearch')?.addEventListener('input', (e) => {
      manualLeadSearch = e.target.value || '';
      manualLeadSearchSeq++;
      debounceManualLeadSearch();
    });
    body.querySelectorAll('[data-manual-org]').forEach(el => {
      el.addEventListener('click', () => {
        manualSelectedOrgId = el.getAttribute('data-manual-org') || '';
        renderPairingCandidates();
      });
    });
    body.querySelectorAll('[data-manual-lead]').forEach(el => {
      el.addEventListener('click', () => {
        manualSelectedLeadId = el.getAttribute('data-manual-lead') || '';
        renderPairingCandidates();
      });
    });
    document.getElementById('manualPairApplyBtn')?.addEventListener('click', () => applyManualPair());
    if (activeId) {
      const activeEl = document.getElementById(activeId);
      if (activeEl) {
        activeEl.focus();
        if (activeSelectionStart !== null && activeSelectionEnd !== null && typeof activeEl.setSelectionRange === 'function') {
          activeEl.setSelectionRange(activeSelectionStart, activeSelectionEnd);
        }
      }
    }
  }

  function renderPairingCandidates(){
    const body = document.getElementById('customerPairingBody');
    const summary = document.getElementById('customerPairingSummary');
    const intro = document.getElementById('customerPairingIntro');
    if (!body || !summary || !intro) return;
    document.querySelectorAll('[data-pair-mode]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-pair-mode') === pairingMode));
    if (pairingMode === 'manual') return renderManualPairing();
    intro.textContent = 'Review suggested customer-to-lead matches. Uncheck anything that should not be linked.';
    if (!pairingCandidates.length) {
      body.innerHTML = '<div class="empty-state"><p>No likely lead-to-customer matches were found.</p></div>';
      syncPairingFooter();
      return;
    }
    syncPairingFooter();
    body.innerHTML = pairingCandidates.map(pair => `
      <label class="pair-row">
        <div><input type="checkbox" data-pair-id="${esc(pair.pair_id)}" ${pairingSelected.has(pair.pair_id) ? 'checked' : ''}></div>
        <div>
          <div style="font-weight:900;color:#1f2937;">${esc(pair.organization_name)}</div>
          <div style="font-size:12px;color:#667085;">Org ${esc(pair.organization_id)}</div>
        </div>
        <div>
          <div style="font-weight:900;color:#1f2937;">${esc(pair.lead_company || 'Lead')}</div>
          <div style="font-size:12px;color:#667085;">${esc(pair.lead_email || pair.lead_phone || '-')}</div>
          <div style="font-size:11px;color:#98a2b3;">${esc(pair.lead_list_name || '')}</div>
        </div>
        <div>
          <div class="pair-score">Score ${esc(String(pair.score || 0))}</div>
          <div class="pair-reasons" style="margin-top:6px;">${esc((pair.reasons || []).join(' • '))}</div>
        </div>
      </label>
    `).join('');
    body.querySelectorAll('input[data-pair-id]').forEach(inp => {
      inp.onchange = () => {
        if (inp.checked) pairingSelected.add(inp.dataset.pairId);
        else pairingSelected.delete(inp.dataset.pairId);
        syncPairingFooter();
      };
    });
  }

  async function applyManualPair(){
    const org = allOrgs.find(o => o.id === manualSelectedOrgId);
    const lead = manualLeadResults.find(l => String(l.id) === String(manualSelectedLeadId));
    if (!org || org.is_test || !lead) return;
    const pair = {
      organization_id: org.id,
      lead_id: lead.id,
      assigned_sales_email: lead.assigned_to_email || ''
    };
    const res = await fetch(apiServer(), {
      method:'POST',
      body: new URLSearchParams({ action: 'customer_apply_pairs', pairs: JSON.stringify([pair]) })
    });
    const data = await res.json();
    if (!data.success) {
      alert('Pairing failed: ' + (data.error || 'Unknown error'));
      return;
    }
    Portal.closeModal('customerPairingModal');
    await loadCustomers();
  }

  async function applySelectedPairs(){
    const pairs = pairingCandidates.filter(p => pairingSelected.has(p.pair_id));
    if (!pairs.length) return;
    const res = await fetch(apiServer(), {
      method:'POST',
      body: new URLSearchParams({ action: 'customer_apply_pairs', pairs: JSON.stringify(pairs) })
    });
    const data = await res.json();
    if (!data.success) {
      alert('Pairing failed: ' + (data.error || 'Unknown error'));
      return;
    }
    Portal.closeModal('customerPairingModal');
    await loadCustomers();
  }

  /* ───────────── ORG DETAIL MODAL ───────────── */

  function syncOrgModalSummary(org){
    document.getElementById('orgModalName').textContent = org.name || 'Organization';
    document.getElementById('orgModalId').textContent = 'ID: ' + org.id;
    document.getElementById('orgModalCreated').textContent = 'Created: ' + fmtDate(org.created_at);
    const logoUrl = orgLogoUrl(org);
    const logoAlt = `${org.name || 'Organization'} logo`;
    updateImageSlot('orgModalLogoFrame', 'orgModalLogoImg', logoUrl, logoAlt);
    updateImageSlot('detailOrgLogoFrame', 'detailOrgLogoImg', logoUrl, logoAlt);
    const logoStatus = document.getElementById('detailOrgLogoStatus');
    if (logoStatus) {
      const branding = org && org.branding && typeof org.branding === 'object' ? org.branding : {};
      logoStatus.textContent = logoUrl
        ? (branding.logo_migration_status === 'legacy_unresolved' ? 'Legacy logo not migrated' : 'Logo available')
        : 'No logo';
    }

    const badgeEl = document.getElementById('orgModalTestBadge');
    badgeEl.innerHTML = org.is_test ? '<span class="test-badge-lg">TEST ORG</span>' : '';

    updateTestToggleButton(org);

    document.getElementById('detailOrgName').textContent = org.name || '-';
    document.getElementById('detailOrgId').textContent = org.id;
    document.getElementById('detailOrgUsers').textContent = (org.users || []).length;
    document.getElementById('detailOrgLifetime').textContent = org.lifetimeOrders || 0;
    document.getElementById('detailOrgRolling7').textContent = org.rolling7 || 0;
    document.getElementById('detailOrgAvgDay').textContent = org.avgOrdersDay || 0;
    document.getElementById('detailOrgBalance').textContent = fmtCurrency(org.credits_balance);

    const pairedLeadEl = document.getElementById('detailOrgPairedLead');
    const pairedLeadActionsEl = document.getElementById('detailOrgPairedLeadActions');
    const pairedLeads = getPairedLeads(org);
    const primaryLead = getPrimaryPairedLead(org);
    if (!pairedLeadEl || !pairedLeadActionsEl) return;

    if (!primaryLead) {
      pairedLeadEl.textContent = 'No lead linked';
      pairedLeadActionsEl.innerHTML = '';
      return;
    }

    const summaryBits = [];
    if (primaryLead.email) summaryBits.push(primaryLead.email);
    else if (primaryLead.phone) summaryBits.push(primaryLead.phone);
    summaryBits.push(primaryLead.is_linked === false ? 'Saved on customer only' : 'Linked in Leads');
    if (pairedLeads.length > 1) summaryBits.push(`${pairedLeads.length} total leads`);
    pairedLeadEl.innerHTML = `
      <div>${esc(primaryLead.company || primaryLead.email || primaryLead.phone || primaryLead.id || 'Lead')}</div>
      <div class="paired-lead-meta">${esc(summaryBits.join(' • '))}</div>
    `;

    let actionsHtml = '';
    if (canOpenPairedLead()) {
      actionsHtml += `
        <button type="button" class="btn-row-open" id="detailOrgOpenLeadBtn">
          <i class="fas fa-address-book"></i> Open Lead
        </button>
      `;
    }
    if (primaryLead.is_linked === false) {
      actionsHtml += `<div class="paired-lead-meta">This lead is listed on the customer record, but the lead DB is not currently linked to this customer.</div>`;
    }
    pairedLeadActionsEl.innerHTML = actionsHtml;
    const openLeadBtn = document.getElementById('detailOrgOpenLeadBtn');
    if (openLeadBtn) {
      openLeadBtn.onclick = () => openLeadFromCustomer(primaryLead.id);
    }
  }

  function showOrgDetailLoading(){
    const chart = document.getElementById('orgVolumeChart');
    const ordersBody = document.getElementById('orgOrdersTableBody');
    const creditsBody = document.getElementById('orgLedgerTableBody');
    const ordersPager = document.getElementById('orgOrdersPager');
    const creditsPager = document.getElementById('orgCreditsPager');
    if (chart) chart.innerHTML = '<div class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading order history…</p></div>';
    if (ordersBody) ordersBody.innerHTML = '<tr><td colspan="4" class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading orders…</p></td></tr>';
    if (creditsBody) creditsBody.innerHTML = '<tr><td colspan="4" class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading credit ledger…</p></td></tr>';
    if (ordersPager) ordersPager.innerHTML = '';
    if (creditsPager) creditsPager.innerHTML = '';
  }

  async function loadOrgDetail(orgId, options = {}){
    const baseOrg = allOrgs.find(o => o.id === orgId);
    if (!baseOrg) return;
    const ordersPage = parseInt(options.ordersPage || (baseOrg.orders_pagination && baseOrg.orders_pagination.page) || 1, 10) || 1;
    const ledgerPage = parseInt(options.ledgerPage || (baseOrg.credits_pagination && baseOrg.credits_pagination.page) || 1, 10) || 1;
    const reqId = ++orgDetailRequestSeq;
    if (currentOrg && currentOrg.id === orgId && currentOrg.detail_loaded) {
      const currentOrdersPage = parseInt(currentOrg.orders_pagination?.page || 1, 10) || 1;
      const currentLedgerPage = parseInt(currentOrg.credits_pagination?.page || 1, 10) || 1;
      const wantsOrdersPage = Object.prototype.hasOwnProperty.call(options, 'ordersPage') && ordersPage !== currentOrdersPage;
      const wantsLedgerPage = Object.prototype.hasOwnProperty.call(options, 'ledgerPage') && ledgerPage !== currentLedgerPage;
      if (wantsOrdersPage || wantsLedgerPage) {
        const nextOrg = { ...currentOrg };
        if (wantsOrdersPage) {
          nextOrg.orders_loading = true;
          nextOrg.orders_pagination = {
            ...(currentOrg.orders_pagination || {}),
            page: ordersPage,
            current_page: ordersPage
          };
          renderOrdersTab(nextOrg);
        }
        if (wantsLedgerPage) {
          nextOrg.credits_loading = true;
          nextOrg.credits_pagination = {
            ...(currentOrg.credits_pagination || {}),
            page: ledgerPage,
            current_page: ledgerPage
          };
          renderCreditsTab(nextOrg);
        }
        currentOrg = nextOrg;
      }
    }
    try {
      const data = await fetchOrgDetail(orgId, { ordersPage, ledgerPage });
      if (reqId !== orgDetailRequestSeq) return;
      if (!data.success || !data.organization) throw new Error(data.error || 'Failed to load organization detail');
      const detailOrg = await hydrateMissingOrgOrders({ ...baseOrg, ...data.organization }, {
        ordersPage,
        ordersPerPage: 50
      });
      if (reqId !== orgDetailRequestSeq) return;
      const merged = mergeOrgData(orgId, {
        ...detailOrg,
        detail_loaded: true,
        detail_loading: false,
        orders_loading: false,
        credits_loading: false
      });
      if (!merged || !currentOrg || currentOrg.id !== orgId) return;
      currentOrg = merged;
      syncOrgModalSummary(currentOrg);
      renderUsersTab(currentOrg);
      renderVolumeChart(currentOrg);
      renderOrdersTab(currentOrg);
      renderCreditsTab(currentOrg);
    } catch (e) {
      if (reqId !== orgDetailRequestSeq) return;
      console.error('loadOrgDetail error', e);
      if (currentOrg && currentOrg.id === orgId) {
        currentOrg.detail_loading = false;
        currentOrg.orders_loading = false;
        currentOrg.credits_loading = false;
        const chart = document.getElementById('orgVolumeChart');
        const ordersBody = document.getElementById('orgOrdersTableBody');
        const creditsBody = document.getElementById('orgLedgerTableBody');
        if (chart) chart.innerHTML = '<div class="empty-state"><p>Could not load order history.</p></div>';
        if (ordersBody) ordersBody.innerHTML = `<tr><td colspan="4" class="empty-state"><p>${esc(e.message || 'Could not load orders.')}</p></td></tr>`;
        if (creditsBody) creditsBody.innerHTML = `<tr><td colspan="4" class="empty-state"><p>${esc(e.message || 'Could not load credit ledger.')}</p></td></tr>`;
      }
    }
  }

  async function openOrgDetail(orgId){
    const org = allOrgs.find(o => o.id === orgId);
    if (!org) return;
    currentOrg = org;
    currentOrg.detail_loaded = false;
    currentOrg.detail_loading = true;
    currentOrg.orders = [];
    currentOrg.credits_ledger = [];
    currentOrg.volume_buckets = [];

    syncOrgModalSummary(currentOrg);
    renderUsersTab(currentOrg);
    showOrgDetailLoading();

    switchOrgTab('overview');
    Portal.openModal('orgModal');
    await loadOrgDetail(orgId, { ordersPage: 1, ledgerPage: 1 });
  }

  function updateTestToggleButton(org){
    const btn = document.getElementById('btnToggleTestOrg');
    if (!btn) return;
    if (org.is_test) {
      btn.classList.add('is-test');
      btn.innerHTML = '<i class="fas fa-flask"></i> <span id="btnToggleTestLabel">Remove Test Flag</span>';
    } else {
      btn.classList.remove('is-test');
      btn.innerHTML = '<i class="fas fa-flask"></i> <span id="btnToggleTestLabel">Mark as Test</span>';
    }
  }

  function renderVolumeChart(org){
    const chart = document.getElementById('orgVolumeChart');
    if (!chart) return;

    if (Array.isArray(org.volume_buckets) && org.volume_buckets.length) {
      const max = Math.max(...org.volume_buckets.map(b => b.count || 0), 1);
      chart.innerHTML = org.volume_buckets.map((b, i) => {
        const showLabel = (i % 4 === 0) || (i === org.volume_buckets.length - 1);
        return `
          <div class="volume-bar" title="Week ending ${b.label}: ${b.count} orders">
            <div class="volume-bar-value">${b.count > 0 ? b.count : ''}</div>
            <div class="volume-bar-fill">
              <div class="volume-bar-inner" style="height:${(b.count/max*100)}%"></div>
            </div>
            <div class="volume-bar-label">${showLabel ? b.label : ''}</div>
          </div>
        `;
      }).join('');
      return;
    }

    if (org.detail_loading) {
      chart.innerHTML = '<div class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading order history…</p></div>';
      return;
    }

    const now = new Date();
    const WEEKS = 52;
    const DAY_MS = 86400000;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const buckets = [];
    for (let w = 0; w < WEEKS; w++) {
      const endDate = new Date(today.getTime() - (w * 7 * DAY_MS));
      const startDate = new Date(endDate.getTime() - (7 * DAY_MS));
      buckets.push({ startDate, endDate, label: (endDate.getMonth()+1) + '/' + endDate.getDate(), count: 0 });
    }
    buckets.reverse();

    (org.orders||[]).forEach(o => {
      const t = new Date(o.created_at||0).getTime();
      if (!t) return;
      for (const b of buckets) {
        if (t > b.startDate.getTime() && t <= b.endDate.getTime() + DAY_MS) { b.count++; break; }
      }
    });

    const max = Math.max(...buckets.map(b=>b.count), 1);
    chart.innerHTML = buckets.map((b, i) => {
      const showLabel = (i % 4 === 0) || (i === buckets.length - 1);
      return `
        <div class="volume-bar" title="Week ending ${b.label}: ${b.count} orders">
          <div class="volume-bar-value">${b.count > 0 ? b.count : ''}</div>
          <div class="volume-bar-fill">
            <div class="volume-bar-inner" style="height:${(b.count/max*100)}%"></div>
          </div>
          <div class="volume-bar-label">${showLabel ? b.label : ''}</div>
        </div>
      `;
    }).join('');
  }

  function renderUsersTab(org){
    const tbody = document.getElementById('orgUsersTableBody');
    if (!tbody) return;
    const users = Array.isArray(org.users) ? org.users : [];
    if (!users.length){
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><p>No users in this organization</p></td></tr>`;
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${esc(u.name||'-')}</strong></td>
        <td>${esc(u.email)}</td>
        <td><span style="text-transform:capitalize;">${esc(u.org_permission_level||'viewer')}</span></td>
        <td>${u.orderCount}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td style="text-align:right;">
          <button class="btn-impersonate"
                  onclick="event.stopPropagation(); Customers.impersonateUser('${esc(u.email)}', '${esc(u.name||u.email)}')"
                  title="Login as this user">
            <i class="fas fa-user-secret"></i> Impersonate
          </button>
        </td>
      </tr>
    `).join('');
  }

  /* ───────────── IMPERSONATE USER ───────────── */

  async function impersonateUser(email, displayName){
    if (!confirm(
      'Switch to "' + displayName + '" (' + email + ')?\n\n' +
      'A new tab will open with the customer portal as this user.\n' +
      'An orange banner will show while impersonating.'
    )) return;

    try {
      const actor = (window.Portal && typeof window.Portal.internalActor === 'function')
        ? window.Portal.internalActor()
        : {
            email: cfg().user?.email || window.__APP?.userEmail || '',
            name: cfg().user?.name || window.__APP?.userName || '',
            role: cfg().user?.role || ''
          };
      const body = {
        action: 'admin_impersonate_user',
        email,
        org_id: (currentOrg && currentOrg.id) ? currentOrg.id : '',
        actor_email: actor.email || actor.user_email || '',
        actor_name: actor.name || actor.user_name || '',
        actor_role: actor.role || actor.user_role || '',
        actor
      };
      const data = (window.Portal && typeof window.Portal.apiPost === 'function')
        ? await window.Portal.apiPost(apiServer(), body)
        : await fetch(apiServer(), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }).then(res => res.json());
      if (data.success) {
        const fallback = '/portal/';
        window.open(data.redirect_url || fallback, '_blank');
      } else {
        alert('Impersonation failed: ' + (data.error || 'Unknown error'));
      }
    } catch(e) {
      alert('Connection error: ' + e.message);
    }
  }

  function renderOrdersPager(org){
    const el = document.getElementById('orgOrdersPager');
    if (!el) return;
    const p = org.orders_pagination || { page:1, per_page:50, total:(org.orders || []).length, total_pages:1 };
    const isLoading = !!org.orders_loading;
    if (!p.total) {
      el.innerHTML = '';
      return;
    }
    const start = ((p.page - 1) * p.per_page) + 1;
    const end = Math.min(p.page * p.per_page, p.total);
    el.innerHTML = `
      <div>${isLoading ? `<i class="fas fa-spinner fa-spin"></i> Loading page ${p.page}...` : `Showing ${start}-${end} of ${p.total} orders`}</div>
      <div class="pager-actions">
        <button class="btn-secondary" id="orgOrdersPrevBtn" ${isLoading || p.page <= 1 ? 'disabled' : ''}>Prev</button>
        <button class="btn-secondary" id="orgOrdersNextBtn" ${isLoading || p.page >= p.total_pages ? 'disabled' : ''}>${isLoading ? 'Loading...' : 'Next'}</button>
      </div>
    `;
    const prev = document.getElementById('orgOrdersPrevBtn');
    const next = document.getElementById('orgOrdersNextBtn');
    if (prev) prev.onclick = () => loadOrgDetail(org.id, { ordersPage: p.page - 1, ledgerPage: (currentOrg?.credits_pagination?.page || 1) });
    if (next) next.onclick = () => loadOrgDetail(org.id, { ordersPage: p.page + 1, ledgerPage: (currentOrg?.credits_pagination?.page || 1) });
  }

  function renderOrdersTab(org){
    const tbody = document.getElementById('orgOrdersTableBody');
    if (!tbody) return;
    if (org.detail_loading && !org.detail_loaded) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading orders…</p></td></tr>`;
      renderOrdersPager({ orders_pagination: { total: 0 } });
      return;
    }
    if (org.orders_loading) {
      const page = parseInt(org.orders_pagination?.page || 1, 10) || 1;
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading orders page ${page}...</p></td></tr>`;
      renderOrdersPager(org);
      return;
    }
    const orders = [...(org.orders||[])].sort((a,b) =>
      new Date(b.created_at||0) - new Date(a.created_at||0)
    );
    if (!orders.length){
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><p>No orders yet</p></td></tr>`;
      renderOrdersPager({ orders_pagination: { total: 0 } });
      return;
    }
    tbody.innerHTML = orders.map(o => {
      let bc = 'queued';
      if (o.status==='completed') bc='completed';
      else if (o.status==='processing'||o.status==='awaiting_review') bc='processing';
      else if (o.status==='correction_needed') bc='correction';
      const orderedBy = (o.issuer && o.issuer.email) || o.owner_email || '-';
      return `<tr>
        <td><strong>${esc(o.address || (o.id ? ('Project ' + o.id) : '-'))}</strong></td>
        <td>${esc(orderedBy)}</td>
        <td>${fmtDate(o.created_at)}</td>
        <td><span class="order-badge ${bc}">${o.status||'queued'}</span></td>
      </tr>`;
    }).join('');
    renderOrdersPager(org);
  }

  function renderCreditsPager(org){
    const el = document.getElementById('orgCreditsPager');
    if (!el) return;
    const p = org.credits_pagination || { page:1, per_page:50, total:(org.credits_ledger || []).length, total_pages:1 };
    const isLoading = !!org.credits_loading;
    if (!p.total) {
      el.innerHTML = '';
      return;
    }
    const start = ((p.page - 1) * p.per_page) + 1;
    const end = Math.min(p.page * p.per_page, p.total);
    el.innerHTML = `
      <div>${isLoading ? `<i class="fas fa-spinner fa-spin"></i> Loading page ${p.page}...` : `Showing ${start}-${end} of ${p.total} ledger entries`}</div>
      <div class="pager-actions">
        <button class="btn-secondary" id="orgCreditsPrevBtn" ${isLoading || p.page <= 1 ? 'disabled' : ''}>Prev</button>
        <button class="btn-secondary" id="orgCreditsNextBtn" ${isLoading || p.page >= p.total_pages ? 'disabled' : ''}>${isLoading ? 'Loading...' : 'Next'}</button>
      </div>
    `;
    const prev = document.getElementById('orgCreditsPrevBtn');
    const next = document.getElementById('orgCreditsNextBtn');
    if (prev) prev.onclick = () => loadOrgDetail(org.id, { ordersPage: (currentOrg?.orders_pagination?.page || 1), ledgerPage: p.page - 1 });
    if (next) next.onclick = () => loadOrgDetail(org.id, { ordersPage: (currentOrg?.orders_pagination?.page || 1), ledgerPage: p.page + 1 });
  }

  function renderCreditsTab(org){
    document.getElementById('orgCreditBalance').textContent = fmtCurrency(org.credits_balance||0);
    const freeExpediteEl = document.getElementById('orgFreeExpediteUses');
    if (freeExpediteEl) freeExpediteEl.textContent = String(Math.max(0, parseInt(org.free_expedite_uses || 0, 10) || 0));
    const tbody = document.getElementById('orgLedgerTableBody');
    if (!tbody) return;
    if (org.detail_loading && !org.detail_loaded) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading credit ledger…</p></td></tr>`;
      renderCreditsPager({ credits_pagination: { total: 0 } });
      return;
    }
    if (org.credits_loading) {
      const page = parseInt(org.credits_pagination?.page || 1, 10) || 1;
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><p><i class="fas fa-spinner fa-spin"></i> Loading ledger page ${page}...</p></td></tr>`;
      renderCreditsPager(org);
      return;
    }
    const ledger = [...(org.credits_ledger||[])].sort((a,b) =>
      new Date(b.ts||0) - new Date(a.ts||0)
    );
    if (!ledger.length){
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><p>No transactions</p></td></tr>`;
      renderCreditsPager({ credits_pagination: { total: 0 } });
      return;
    }
    tbody.innerHTML = ledger.map(e => {
      const delta = parseFloat(e.delta)||0;
      const meta = (e.meta && typeof e.meta === 'object') ? e.meta : {};
      let desc = (e.reason||'transaction').replace(/_/g,' ');
      if ((e.reason || '') === 'cancellation_refund') desc = 'cancellation refund';
      const address = e.address || meta.address || '';
      if (address) desc += ' - ' + address;
      if (e.applied_for_user_email) desc += ' (' + e.applied_for_user_email + ')';
      const bal = parseFloat(e.balance_after!=null ? e.balance_after : (e.balance||0));
      return `<tr>
        <td>${fmtDateTime(e.ts)}</td>
        <td>${esc(desc)}</td>
        <td><span class="ledger-delta ${delta>=0?'positive':'negative'}">${delta>=0?'+':''}${fmtCurrency(delta)}</span></td>
        <td><strong>${fmtCurrency(bal)}</strong></td>
      </tr>`;
    }).join('');
    renderCreditsPager(org);
  }

  function switchOrgTab(tabName){
    document.querySelectorAll('.org-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tabName)
    );
    document.querySelectorAll('.org-tab-pane').forEach(p =>
      p.classList.toggle('active', p.id === 'orgTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1))
    );
  }

  /* ───────────── TOGGLE TEST ORG FLAG ───────────── */

  async function toggleTestOrgFlag(){
    if (!currentOrg) return;
    const newVal = !currentOrg.is_test;
    const action = newVal ? 'mark as a TEST organization' : 'remove the TEST flag from';
    if (!confirm('Are you sure you want to ' + action + ' "' + currentOrg.name + '"?\n\nTest organizations are excluded from all totals and statistics.')) return;

    const btn = document.getElementById('btnToggleTestOrg');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving\u2026';

    try {
      const res = await fetch(apiServer(), {
        method: 'POST',
        body: new URLSearchParams({ action: 'org_set_test_flag', org_id: currentOrg.id, is_test: newVal ? '1' : '' })
      });
      const data = await res.json();
      if (data.success) {
        currentOrg.is_test = newVal;
        const idx = allOrgs.findIndex(o => o.id === currentOrg.id);
        if (idx >= 0) allOrgs[idx].is_test = newVal;

        updateTestToggleButton(currentOrg);
        document.getElementById('orgModalTestBadge').innerHTML =
          newVal ? '<span class="test-badge-lg">TEST ORG</span>' : '';

        renderStats(allOrgs);
        renderOrgTable();
        updateSelectionStats();

        btn.innerHTML = '<i class="fas fa-check"></i> Saved!';
        setTimeout(() => { btn.disabled = false; updateTestToggleButton(currentOrg); }, 1500);
      } else {
        throw new Error(data.error || 'Failed');
      }
    } catch(e) {
      alert('Error updating test flag: ' + e.message);
      btn.disabled = false;
      btn.innerHTML = origHTML;
    }
  }

  /* ───────────── ISSUE CREDIT ───────────── */

  function applyCreditAdjustment(data){
    if (!currentOrg || !data) return;
    const delta = parseFloat(data.delta)||0;
    const newBalance = parseFloat(data.new_balance);
    const entry = data.ledger_entry || {
      ts: new Date().toISOString(),
      delta,
      reason: delta < 0 ? 'manual_admin_deduction' : 'manual_admin_credit',
      balance_after: isFinite(newBalance) ? newBalance : ((currentOrg.credits_balance || 0) + delta),
      unit: 'usd_dollars'
    };

    const prevPager = currentOrg.credits_pagination || { page:1, per_page:50, total:(currentOrg.credits_ledger || []).length, total_pages:1 };
    const perPage = parseInt(prevPager.per_page || 50, 10) || 50;
    const nextLedger = [entry, ...(currentOrg.credits_ledger || [])];
    if (nextLedger.length > perPage) nextLedger.length = perPage;
    const nextTotal = (parseInt(prevPager.total || currentOrg.credits_ledger_count || 0, 10) || 0) + 1;

    const merged = mergeOrgData(currentOrg.id, {
      credits_balance: isFinite(newBalance) ? newBalance : entry.balance_after,
      credits_ledger: nextLedger,
      credits_ledger_count: (parseInt(currentOrg.credits_ledger_count || 0, 10) || 0) + 1,
      latest_credit_entry: entry,
      credits_pagination: {
        page: 1,
        per_page: perPage,
        total: nextTotal,
        total_pages: Math.max(1, Math.ceil(nextTotal / perPage))
      }
    });
    if (merged) currentOrg = merged;

    syncOrgModalSummary(currentOrg);
    renderCreditsTab(currentOrg);
    renderStats(allOrgs);
    renderOrgTable();
    updateSelectionStats();
  }

  async function adjustOrgCredit(direction){
    if (!currentOrg) return;

    const input = document.getElementById('orgCreditAmountInput');
    const amount = parseInt(input.value)||0;
    if (amount <= 0) { alert('Enter a valid credit amount ($1+).'); return; }

    const isDeduct = direction === 'deduct';
    if (isDeduct && amount > (parseFloat(currentOrg.credits_balance)||0)) {
      alert('Cannot deduct more credits than the current organization balance.');
      return;
    }

    const verb = isDeduct ? 'Deduct' : 'Add';
    const preposition = isDeduct ? 'from' : 'to';
    if (!confirm(verb + ' $' + amount + ' credit ' + preposition + ' organization "' + currentOrg.name + '"?')) return;

    const btn = document.getElementById(isDeduct ? 'btnOrgDeductCredit' : 'btnOrgIssueCredit');
    const otherBtn = document.getElementById(isDeduct ? 'btnOrgIssueCredit' : 'btnOrgDeductCredit');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    if (otherBtn) otherBtn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    try {
      const res = await fetch(apiServer(), {
        method:'POST',
        body: new URLSearchParams({
          action: 'admin_adjust_org_credits',
          org_id: currentOrg.id,
          amount: String(isDeduct ? -amount : amount),
          direction,
          reason: isDeduct ? 'manual_admin_deduction' : 'manual_admin_credit'
        })
      });
      const data = await res.json();
      if (data.success) {
        input.value = '';
        applyCreditAdjustment(data);
        btn.innerHTML = isDeduct
          ? '<i class="fas fa-check"></i> Credit Deducted'
          : '<i class="fas fa-check"></i> Credit Added';
        setTimeout(() => {
          btn.disabled = false;
          if (otherBtn) otherBtn.disabled = false;
          btn.innerHTML = origHTML;
        }, 1200);
      } else {
        throw new Error(data.error || 'Failed');
      }
    } catch(e){
      alert((isDeduct ? 'Error deducting credit: ' : 'Error adding credit: ') + e.message);
      btn.disabled = false;
      if (otherBtn) otherBtn.disabled = false;
      btn.innerHTML = origHTML;
    }
  }

  /* ───────────── MAIN LOAD ───────────── */

  function applyFreeExpediteAdjustment(data){
    if (!currentOrg || !data) return;
    const nextUses = parseInt(data.free_expedite_uses, 10);
    const merged = mergeOrgData(currentOrg.id, {
      free_expedite_uses: isFinite(nextUses) ? nextUses : currentOrg.free_expedite_uses,
      free_expedite_ledger_count: parseInt(data.free_expedite_ledger_count || currentOrg.free_expedite_ledger_count || 0, 10) || 0,
      latest_free_expedite_entry: data.free_expedite_ledger_entry || null
    });
    if (merged) currentOrg = merged;
    renderCreditsTab(currentOrg);
    renderOrgTable();
    updateSelectionStats();
  }

  async function adjustOrgFreeExpedites(direction){
    if (!currentOrg) return;

    const input = document.getElementById('orgFreeExpediteAmountInput');
    const amount = parseInt(input.value)||0;
    if (amount <= 0) { alert('Enter a valid number of free expedite uses.'); return; }

    const isDeduct = direction === 'deduct';
    if (isDeduct && amount > (parseInt(currentOrg.free_expedite_uses || 0, 10)||0)) {
      alert('Cannot deduct more free expedite uses than this organization has.');
      return;
    }

    const verb = isDeduct ? 'Deduct' : 'Add';
    const preposition = isDeduct ? 'from' : 'to';
    if (!confirm(verb + ' ' + amount + ' free expedite use' + (amount === 1 ? '' : 's') + ' ' + preposition + ' organization "' + currentOrg.name + '"?')) return;

    const btn = document.getElementById(isDeduct ? 'btnOrgDeductFreeExpedite' : 'btnOrgIssueFreeExpedite');
    const otherBtn = document.getElementById(isDeduct ? 'btnOrgIssueFreeExpedite' : 'btnOrgDeductFreeExpedite');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    if (otherBtn) otherBtn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    try {
      const res = await fetch(apiServer(), {
        method:'POST',
        body: new URLSearchParams({
          action: 'admin_adjust_org_free_expedites',
          org_id: currentOrg.id,
          amount: String(isDeduct ? -amount : amount),
          direction,
          reason: isDeduct ? 'manual_admin_free_expedite_deduction' : 'manual_admin_free_expedite_grant'
        })
      });
      const data = await res.json();
      if (data.success) {
        input.value = '';
        applyFreeExpediteAdjustment(data);
        btn.innerHTML = isDeduct
          ? '<i class="fas fa-check"></i> Uses Deducted'
          : '<i class="fas fa-check"></i> Uses Added';
        setTimeout(() => {
          btn.disabled = false;
          if (otherBtn) otherBtn.disabled = false;
          btn.innerHTML = origHTML;
        }, 1200);
      } else {
        throw new Error(data.error || 'Failed');
      }
    } catch(e){
      alert((isDeduct ? 'Error deducting uses: ' : 'Error adding uses: ') + e.message);
      btn.disabled = false;
      if (otherBtn) otherBtn.disabled = false;
      btn.innerHTML = origHTML;
    }
  }

  async function loadCustomers(){
    const loadSeq = ++customerLoadSeq;
    const tbody = document.getElementById('orgTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:30px;"><i class="fas fa-spinner fa-spin"></i> Loading organizations\u2026</td></tr>';

    const organizations = await fetchAllOrgData();
    if (loadSeq !== customerLoadSeq) return;
    allOrgs = organizations;

    populateSalespersonOptions();
    const pairBtn = document.getElementById('customersPairingBtn');
    if (pairBtn) pairBtn.style.display = canManageView ? '' : 'none';
    renderStats(allOrgs);
    renderOrgTable();
    renderCustomerPager();
  }

  function queueCustomerReload(){
    customerPage = 1;
    if (customerFilterTimer) clearTimeout(customerFilterTimer);
    customerFilterTimer = setTimeout(() => {
      customerFilterTimer = null;
      clearSelection();
      loadCustomers();
    }, 450);
  }

  async function goToCustomerPage(page){
    const nextPage = Math.max(1, Math.min(customerTotalPages, page));
    if (nextPage === customerPage) return;
    customerPage = nextPage;
    clearSelection();
    await loadCustomers();
    document.getElementById('orgTable')?.scrollIntoView({ block:'start' });
  }

  /* ───────────── WIRE UI ───────────── */

  async function fetchOrganizationsForExport(){
    const organizations = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await window.Portal.apiPost(apiServer(), {
        action:'customer_org_dashboard_data',
        paginate:'1',
        page:String(page),
        per_page:'1000',
        sort_col:'name',
        sort_dir:'asc',
        filters:'{}',
        hide_test:'0',
        hide_commission_paid:'0'
      });
      if (!data?.success) throw new Error(data?.error || 'Could not load organizations for export.');
      organizations.push(...(Array.isArray(data.organizations) ? data.organizations : []));
      totalPages = Math.max(1, parseInt(data?.pagination?.total_pages || 1, 10) || 1);
      page++;
    } while (page <= totalPages);
    return organizations;
  }

  async function exportUsersTsv(){
    const exportBtn = document.getElementById('customersExportUsersBtn');
    const originalLabel = exportBtn?.innerHTML || '';
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading all customers…';
    }
    let exportOrgs;
    try {
      exportOrgs = await fetchOrganizationsForExport();
    } catch (error) {
      alert(error?.message || 'Could not load customers for export.');
      return;
    } finally {
      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.innerHTML = originalLabel;
      }
    }
    const rows = [];
    [...exportOrgs]
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity:'base' }))
      .forEach(org => {
        const orgUsers = Array.isArray(org.users) ? [...org.users] : [];
        const latestOrder = org.latest_order || null;
        const latestLedgerEntry = org.latest_credit_entry || null;
        const pairedLeadIds = Array.isArray(org.paired_lead_ids) ? org.paired_lead_ids : [];
        const orgContact = org.contact && typeof org.contact === 'object' ? org.contact : {};
        const adminContacts = orgAdminContacts(org);
        const adminOne = adminContacts[0] || null;
        const adminTwo = adminContacts[1] || null;
        const users = Array.isArray(org.users) ? [...org.users] : [];
        users
          .sort((a, b) => ((a.name || a.email || '')).localeCompare((b.name || b.email || ''), undefined, { sensitivity:'base' }))
          .forEach(user => {
            const userEmail = user.email || '';
            const userName = user.name || '';
            const userPermission = user.org_permission_level || '';
            const latestLedgerMeta = latestLedgerEntry && typeof latestLedgerEntry.meta === 'object' ? latestLedgerEntry.meta : {};
            rows.push([
              org.id || '',
              org.name || '',
              org.is_test ? 'Yes' : 'No',
              org.created_at || '',
              orgUsers.length,
              org.lifetimeOrders || 0,
              org.rolling7 || 0,
              org.avgOrdersDay || 0,
              org.credits_balance || 0,
              org.credits_ledger_count || 0,
              orgContact.email || '',
              orgContact.phone || '',
              orgContact.address || '',
              ...adminContactTsvFields(adminOne),
              ...adminContactTsvFields(adminTwo),
              org.assigned_sales_name || '',
              org.assigned_sales_email || '',
              org.assigned_sales_by_email || '',
              org.assigned_sales_at || '',
              org.assigned_sales_email ? 'Yes' : 'No',
              pairedLeadIds.length,
              org.paired_primary_lead_id || '',
              org.paired_at || '',
              tsvList(pairedLeadIds),
              latestOrder ? 'Yes' : 'No',
              latestOrder ? latestOrder.created_at || '' : '',
              latestOrder ? latestOrder.status || '' : '',
              latestOrder ? latestOrder.address || '' : '',
              latestOrder ? latestOrder.owner_email || '' : '',
              latestOrder && latestOrder.issuer ? latestOrder.issuer.email || '' : '',
              latestLedgerEntry ? latestLedgerEntry.ts || '' : '',
              latestLedgerEntry ? latestLedgerEntry.reason || '' : '',
              latestLedgerEntry ? latestLedgerEntry.delta || 0 : '',
              latestLedgerEntry ? (latestLedgerEntry.balance_after != null ? latestLedgerEntry.balance_after : (latestLedgerEntry.balance != null ? latestLedgerEntry.balance : '')) : '',
              latestLedgerEntry ? latestLedgerEntry.applied_for_user_email || '' : '',
              latestLedgerEntry ? latestLedgerEntry.address || latestLedgerMeta.address || '' : '',
              user.id || '',
              userName,
              userEmail,
              emailDomain(userEmail),
              user.phone || '',
              user.created_at || '',
              userPermission,
              (user.orderCount || 0) > 0 ? 'Yes' : 'No',
              user.orderCount || 0,
              userEmail && String(orgContact.email || '').trim().toLowerCase() === String(userEmail).trim().toLowerCase() ? 'Yes' : 'No'
            ]);
          });
      });

    if (!rows.length) {
      alert('No users are available to export yet.');
      return;
    }

    const header = [
      'organization_id',
      'organization_name',
      'organization_is_test',
      'organization_created_at',
      'organization_total_users',
      'organization_total_lifetime_orders',
      'organization_total_rolling7_orders',
      'organization_avg_orders_per_day_7d',
      'organization_credits_balance',
      'organization_credits_ledger_entry_count',
      'organization_contact_email',
      'organization_contact_phone',
      'organization_contact_address',
      'organization_super_admin_1_name',
      'organization_super_admin_1_email',
      'organization_super_admin_1_email_domain',
      'organization_super_admin_1_phone',
      'organization_super_admin_1_title',
      'organization_super_admin_1_company',
      'organization_super_admin_1_address',
      'organization_super_admin_1_permission_level',
      'organization_super_admin_1_created_at',
      'organization_super_admin_2_name',
      'organization_super_admin_2_email',
      'organization_super_admin_2_email_domain',
      'organization_super_admin_2_phone',
      'organization_super_admin_2_title',
      'organization_super_admin_2_company',
      'organization_super_admin_2_address',
      'organization_super_admin_2_permission_level',
      'organization_super_admin_2_created_at',
      'organization_assigned_sales_name',
      'organization_assigned_sales_email',
      'organization_assigned_sales_by_email',
      'organization_assigned_sales_at',
      'organization_has_assigned_sales',
      'organization_paired_lead_count',
      'organization_paired_primary_lead_id',
      'organization_paired_at',
      'organization_paired_lead_ids',
      'organization_has_orders',
      'organization_latest_order_created_at',
      'organization_latest_order_status',
      'organization_latest_order_address',
      'organization_latest_order_owner_email',
      'organization_latest_order_issuer_email',
      'organization_latest_credit_event_at',
      'organization_latest_credit_event_reason',
      'organization_latest_credit_event_delta',
      'organization_latest_credit_event_balance_after',
      'organization_latest_credit_event_applied_for_user_email',
      'organization_latest_credit_event_address',
      'user_id',
      'user_name',
      'user_email',
      'user_email_domain',
      'user_phone',
      'user_created_at',
      'user_permission_level',
      'user_has_orders',
      'user_order_count',
      'user_matches_org_contact_email'
    ];
    const tsv = [header, ...rows]
      .map(cols => cols.map(tsvCell).join('\t'))
      .join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([tsv], { type:'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer_users_${stamp}.tsv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function wireUI(){
    document.getElementById('customersRefreshBtn').onclick = () => loadCustomers();
    document.getElementById('customersExportUsersBtn').onclick = () => exportUsersTsv();
    document.getElementById('customerPageSize').value = String(customerPageSize);
    document.getElementById('customerPageSize').onchange = async e => {
      const value = parseInt(e.target.value || '200', 10);
      customerPageSize = value >= 100 && value <= 1000 && value % 100 === 0 ? value : 200;
      saveCustomerPageSize(customerPageSize);
      customerPage = 1;
      clearSelection();
      await loadCustomers();
    };
    document.getElementById('customerFirstPageBtn').onclick = () => goToCustomerPage(1);
    document.getElementById('customerPrevPageBtn').onclick = () => goToCustomerPage(customerPage - 1);
    document.getElementById('customerNextPageBtn').onclick = () => goToCustomerPage(customerPage + 1);
    document.getElementById('customerLastPageBtn').onclick = () => goToCustomerPage(customerTotalPages);
    const pairBtn = document.getElementById('customersPairingBtn');
    if (pairBtn) {
      pairBtn.style.display = canManageView ? '' : 'none';
      pairBtn.onclick = async () => {
        pairingMode = 'suggested';
        manualCustomerSearch = '';
        manualLeadSearch = '';
        manualLeadResults = [];
        manualSelectedOrgId = '';
        manualSelectedLeadId = '';
        if (manualCustomerSearchTimer) clearTimeout(manualCustomerSearchTimer);
        if (manualLeadSearchTimer) clearTimeout(manualLeadSearchTimer);
        manualCustomerSearchTimer = null;
        manualLeadSearchTimer = null;
        manualLeadSearchSeq++;
        Portal.openModal('customerPairingModal');
        await loadPairingCandidates();
      };
    }

    // Toggle switch for hiding test orgs
    const toggle = document.getElementById('hideTestOrgsToggle');
    toggle.classList.toggle('active', hideTestOrgs);
    toggle.setAttribute('aria-checked', String(hideTestOrgs));
    toggle.onclick = () => {
      hideTestOrgs = !hideTestOrgs;
      toggle.classList.toggle('active', hideTestOrgs);
      toggle.setAttribute('aria-checked', String(hideTestOrgs));
      customerPage = 1;
      clearSelection();
      loadCustomers();
    };
    toggle.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle.click(); } };

    const milestoneToggle = document.getElementById('hideCommissionPaidToggle');
    if (milestoneToggle) {
      milestoneToggle.classList.toggle('active', hideCommissionPaidOrgs);
      milestoneToggle.setAttribute('aria-checked', String(hideCommissionPaidOrgs));
      milestoneToggle.onclick = () => {
        hideCommissionPaidOrgs = !hideCommissionPaidOrgs;
        milestoneToggle.classList.toggle('active', hideCommissionPaidOrgs);
        milestoneToggle.setAttribute('aria-checked', String(hideCommissionPaidOrgs));
        customerPage = 1;
        clearSelection();
        loadCustomers();
      };
      milestoneToggle.onkeydown = e => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          milestoneToggle.click();
        }
      };
    }

    const emailSearch = document.getElementById('customerEmailSearch');
    if (emailSearch) {
      emailSearch.value = customerEmailSearch;
      emailSearch.oninput = () => {
        customerEmailSearch = emailSearch.value.trim();
        queueCustomerReload();
      };
      emailSearch.onkeydown = event => {
        if (event.key !== 'Escape' || !emailSearch.value) return;
        emailSearch.value = '';
        customerEmailSearch = '';
        queueCustomerReload();
      };
    }

    // Column-header sort
    document.querySelectorAll('#orgTableHeaderRow th').forEach(th => {
      if (!th.dataset.col || th.dataset.col === '_sel') return;
      th.onclick = () => {
        const col = th.dataset.col;
        if (!col) return;
        if (sortCol === col) sortDir = sortDir==='asc'?'desc':'asc';
        else { sortCol = col; sortDir = 'asc'; }
        customerPage = 1;
        clearSelection();
        loadCustomers();
      };
    });

    // Column-filter inputs
    document.querySelectorAll('#orgTableFilterRow input').forEach(inp => {
      inp.onclick = e => e.stopPropagation();
      inp.onmousedown = e => e.stopPropagation();
      inp.onfocus = () => {
        hideOtherFilterMenus(inp);
        renderFilterMenu(inp);
      };
      inp.oninput = () => {
        colFilters[inp.dataset.col] = inp.value.trim();
        hideOtherFilterMenus(inp);
        renderFilterMenu(inp);
        queueCustomerReload();
      };
    });
    document.addEventListener('mousedown', e => { if (!e.target.closest('.cust-filter-wrap')) hideAllFilterMenus(); });

    // Modal close
    document.getElementById('orgModalClose').onclick = () => Portal.closeModal('orgModal');
    document.getElementById('orgModal').onclick = e => { if (e.target.id==='orgModal') Portal.closeModal('orgModal'); };
    document.getElementById('customerPairingClose').onclick = () => Portal.closeModal('customerPairingModal');
    document.getElementById('customerPairingCancel').onclick = () => Portal.closeModal('customerPairingModal');
    document.getElementById('customerPairingModal').onclick = e => { if (e.target.id==='customerPairingModal') Portal.closeModal('customerPairingModal'); };
    document.getElementById('customerPairingRefresh').onclick = () => loadPairingCandidates();
    document.getElementById('customerPairingApply').onclick = () => applySelectedPairs();
    document.getElementById('customerPairingDeselectAll').onclick = () => {
      pairingSelected.clear();
      renderPairingCandidates();
    };
    document.getElementById('customerPairSuggestedTab').onclick = () => { pairingMode = 'suggested'; renderPairingCandidates(); };
    document.getElementById('customerPairManualTab').onclick = () => { pairingMode = 'manual'; renderPairingCandidates(); };
    document.getElementById('customerAssignClose').onclick = () => Portal.closeModal('customerAssignModal');
    document.getElementById('customerAssignModal').onclick = e => { if (e.target.id==='customerAssignModal') Portal.closeModal('customerAssignModal'); };

    // Tabs
    document.querySelectorAll('.org-tab').forEach(t => { t.onclick = () => switchOrgTab(t.dataset.tab); });

    // Credit adjustments
    document.getElementById('btnOrgIssueCredit').onclick = () => adjustOrgCredit('add');
    document.getElementById('btnOrgDeductCredit').onclick = () => adjustOrgCredit('deduct');
    document.getElementById('btnOrgIssueFreeExpedite').onclick = () => adjustOrgFreeExpedites('add');
    document.getElementById('btnOrgDeductFreeExpedite').onclick = () => adjustOrgFreeExpedites('deduct');

    // Toggle test org flag
    document.getElementById('btnToggleTestOrg').onclick = () => toggleTestOrgFlag();

    // Selection stats panel
    document.getElementById('selStatsCloseBtn').onclick = () => clearSelection();
    document.getElementById('selClearBtn').onclick = () => clearSelection();
    document.getElementById('selClearBtnFallback').onclick = () => clearSelection();
    document.getElementById('selAssignBtn').onclick = () => Portal.openModal('customerAssignModal');
    document.getElementById('customerAssignGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-assign-sales]');
      if (!btn) return;
      assignSelectedOrganizations(btn.getAttribute('data-assign-sales') || '');
    });

    // ── Row selection: mousedown delegation on tbody ──
    const tbody = document.getElementById('orgTableBody');
    tbody.addEventListener('mousedown', e => {
      const tr = e.target.closest('tr[data-org-id]');
      if (!tr) return;
      handleRowMousedown(e, tr);
    });
    tbody.addEventListener('mouseover', e => {
      if (!dragSelecting) return;
      const tr = e.target.closest('tr[data-org-id]');
      if (tr) handleRowMouseenter(tr);
    });
    document.addEventListener('mouseup', handleMouseup);

    // Escape key clears selection
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && selectedIds.size > 0) {
        clearSelection();
      }
    });
  }

  /* ───────────── PUBLIC API / REGISTRATION ───────────── */

  const Customers = {
    init(){
      if (!canAccessCustomers()) return;
      ensureStyles();
      ensureMarkup();
      Portal.registerPlugin({ id:'customers', title:'Customers', iconClass:'fas fa-user-friends' });
      wireUI();
      window.Customers = this;
    },
    async onShow(){ await loadCustomers(); },
    openOrgDetail(orgId){ openOrgDetail(orgId); },
    impersonateUser(email, name){ impersonateUser(email, name); }
  };

  const origSwitch = Portal.switchView ? Portal.switchView.bind(Portal) : null;
  if (origSwitch){
    Portal.switchView = async function(id, btn){
      await origSwitch(id, btn);
      if (id !== 'customers') clearSelection();
      if (id === 'customers') await Customers.onShow();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Customers.init());
  else Customers.init();

  window.Customers = Customers;
})();
