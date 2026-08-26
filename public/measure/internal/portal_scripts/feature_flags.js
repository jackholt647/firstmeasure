/* portal_scripts/feature_flags.js */
(function(){
  if (!window.Portal) return;

  const state = {
    booted: false,
    definitions: [],
    variantDefinitions: [],
    summary: {},
    newUserDefaults: null,
    totalOrgs: 0,
    page: 1,
    limit: 25,
    total: 0,
    orgs: [],
    selectedOrg: null
  };

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => window.Portal.escapeHtml(value);
  const ROLLOUT_BATCH_SIZE = 100;
  let activeRolloutPlan = null;
  let rolloutRunning = false;

  function canManage(){
    const cfg = window.Portal.cfg || {};
    const user = cfg.user || {};
    const perms = cfg.perms || {};
    return user.role === 'admin' || user.is_admin || perms.manage_users || perms.manage_sales_users;
  }

  function injectStyles(){
    if ($('#featureFlagsStyles')) return;
    const style = document.createElement('style');
    style.id = 'featureFlagsStyles';
    style.textContent = `
      .ff-feature-view{display:flex; flex-direction:column; gap:18px;}
      .ff-top-grid{display:grid; grid-template-columns:minmax(0,1.15fr) minmax(360px,.85fr); gap:18px; align-items:start;}
      .ff-rollout-stack,.ff-side-stack{display:flex; flex-direction:column; gap:18px;}
      .ff-panel{background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:18px; box-shadow:0 1px 2px rgba(16,24,40,.04);}
      .ff-panel h2{font-size:16px; margin:0 0 12px; color:#111827;}
      .ff-muted{color:#667085; font-size:12px; font-weight:700;}
      .ff-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:8px; max-height:300px; overflow:auto; padding:2px 4px 2px 0;}
      .ff-flag{border:1px solid #e5e7eb; border-radius:8px; padding:9px 10px; background:#fcfcfd; min-height:0; display:flex; flex-direction:column; gap:5px; cursor:pointer; text-align:left; transition:border-color .12s ease, background .12s ease, box-shadow .12s ease;}
      .ff-flag:hover{border-color:#98a2b3; box-shadow:0 1px 4px rgba(16,24,40,.08);}
      .ff-flag.selected[data-action="on"]{border-color:#12b76a; background:#f6fef9;}
      .ff-flag.selected[data-action="off"]{border-color:#f04438; background:#fffbfa;}
      .ff-flag-top{display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:8px; align-items:start;}
      .ff-flag-title{font-weight:900; color:#111827; line-height:1.2; font-size:12px;}
      .ff-info{display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border:1px solid #c7d7fe; border-radius:999px; background:#eef4ff; color:#175cd3; font-size:11px; font-weight:900; cursor:pointer;}
      .ff-flag-action{border:1px solid #d0d5dd; border-radius:999px; background:#fff; color:#344054; padding:3px 8px; font-size:10px; font-weight:900; cursor:pointer; text-transform:uppercase; min-width:62px;}
      .ff-flag.selected[data-action="on"] .ff-flag-action{background:#dcfae6; border-color:#75e0a7; color:#067647;}
      .ff-flag.selected[data-action="off"] .ff-flag-action{background:#fee4e2; border-color:#fda29b; color:#b42318;}
      .ff-key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#475467; font-size:11px; word-break:break-word;}
      .ff-count{font-size:11px; color:#344054; font-weight:800; margin-top:0;}
      .ff-controls{display:grid; grid-template-columns:1fr 150px 130px; gap:10px; align-items:end;}
      .ff-controls label,.ff-form label{display:block; font-size:11px; text-transform:uppercase; color:#667085; font-weight:900; margin-bottom:5px;}
      .ff-controls input,.ff-controls select,.ff-form input,.ff-form select{width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #d0d5dd; border-radius:8px; font-weight:700; background:#fff;}
      .ff-actions{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
      .ff-table-wrap{overflow:auto; border:1px solid #e5e7eb; border-radius:8px;}
      .ff-table{width:100%; min-width:1080px; border-collapse:collapse;}
      .ff-table th,.ff-table td{padding:11px 12px; border-bottom:1px solid #eef0f3; text-align:left; vertical-align:top;}
      .ff-table th{font-size:11px; text-transform:uppercase; color:#667085; background:#f9fafb; position:sticky; top:0; z-index:1;}
      .ff-table tr:last-child td{border-bottom:0;}
      .ff-org-name{font-weight:900; color:#111827;}
      .ff-chip{display:inline-flex; align-items:center; border-radius:999px; padding:3px 8px; background:#ecfdf3; color:#067647; font-size:11px; font-weight:900; margin:2px 4px 2px 0;}
      .ff-chip.off{background:#f2f4f7; color:#667085;}
      .ff-detail-empty{padding:38px 14px; text-align:center; color:#667085; font-weight:800; background:#f9fafb; border:1px dashed #d0d5dd; border-radius:8px;}
      .ff-org-flags{display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:8px; max-height:360px; overflow:auto; padding-right:4px;}
      .ff-default-flags{display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:8px; max-height:420px; overflow:auto; padding-right:4px;}
      .ff-toggle{display:flex; gap:9px; align-items:flex-start; padding:10px; border:1px solid #e5e7eb; border-radius:8px; background:#fcfcfd;}
      .ff-toggle b{display:block; font-size:12px; color:#111827;}
      .ff-toggle span{display:block; font-size:11px; color:#667085; margin-top:2px; word-break:break-word;}
      .ff-status{font-size:12px; font-weight:900; color:#475467;}
      .ff-danger-note{background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; padding:10px 12px; border-radius:8px; font-size:12px; font-weight:800;}
      .ff-variant-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px;}
      .ff-mini-toolbar{display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;}
      .ff-link-btn{border:0; background:transparent; padding:0; color:#175cd3; font-size:12px; font-weight:900; cursor:pointer;}
      .ff-tooltip{position:fixed; z-index:9999; max-width:320px; background:#101828; color:#fff; border-radius:8px; padding:10px 12px; box-shadow:0 10px 24px rgba(16,24,40,.24); font-size:12px; line-height:1.4; pointer-events:none;}
      .ff-tooltip b{display:block; font-size:12px; margin-bottom:4px;}
      .ff-tooltip span{display:block; color:#d0d5dd; margin-top:6px; font-size:11px;}
      .ff-filter-summary{display:flex; gap:8px; flex-wrap:wrap; align-items:center; padding:10px 12px; border:1px solid #dbeafe; background:#eff6ff; border-radius:8px; color:#1e3a8a; font-size:12px; font-weight:800; margin:12px 0;}
      .ff-filter-pill{display:inline-flex; align-items:center; border-radius:999px; background:#fff; border:1px solid #bfdbfe; color:#1d4ed8; padding:3px 8px; font-size:11px; font-weight:900;}
      .ff-modal-backdrop{position:fixed; inset:0; z-index:5000; background:rgba(15,23,42,.42); display:none; align-items:center; justify-content:center; padding:22px;}
      .ff-modal{width:min(680px,100%); max-height:min(82vh,720px); overflow:auto; background:#fff; border-radius:8px; box-shadow:0 24px 64px rgba(16,24,40,.28); border:1px solid #e5e7eb;}
      .ff-modal-head{display:flex; justify-content:space-between; gap:14px; align-items:flex-start; padding:16px 18px; border-bottom:1px solid #eef0f3;}
      .ff-modal-head h3{margin:0; font-size:16px; color:#111827;}
      .ff-modal-body{padding:18px; display:grid; gap:14px;}
      .ff-stat-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px;}
      .ff-stat{border:1px solid #e5e7eb; border-radius:8px; padding:12px; background:#fcfcfd;}
      .ff-stat b{display:block; font-size:22px; color:#111827; line-height:1.1;}
      .ff-stat span{display:block; color:#667085; font-size:11px; font-weight:900; text-transform:uppercase; margin-top:4px;}
      .ff-preview-list{display:grid; gap:6px; max-height:190px; overflow:auto; border:1px solid #e5e7eb; border-radius:8px; padding:8px; background:#f9fafb;}
      .ff-preview-list div{font-size:12px; font-weight:800; color:#344054;}
      .ff-progress-track{height:8px; background:#eef2f7; border-radius:999px; overflow:hidden;}
      .ff-progress-bar{height:100%; width:0; background:#175cd3; transition:width .18s ease;}
      .ff-batch-table{width:100%; border-collapse:collapse; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;}
      .ff-batch-table th,.ff-batch-table td{padding:9px 10px; border-bottom:1px solid #eef0f3; text-align:left; font-size:12px;}
      .ff-batch-table th{background:#f9fafb; color:#667085; font-size:11px; text-transform:uppercase; font-weight:900;}
      .ff-batch-table tr:last-child td{border-bottom:0;}
      .ff-batch-status{font-weight:900; color:#475467;}
      .ff-batch-status.ok{color:#067647;}
      .ff-batch-status.fail{color:#b42318;}
      .ff-batch-status.run{color:#175cd3;}
      @media (max-width:1100px){.ff-top-grid{grid-template-columns:1fr}.ff-controls{grid-template-columns:1fr;}}
    `;
    document.head.appendChild(style);
  }

  function ensureMarkup(){
    const host = $('#portalPluginViews');
    if (!host || $('#view-feature-flags')) return;
    injectStyles();
    const wrap = document.createElement('div');
    wrap.id = 'view-feature-flags';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="header-bar">
        <h1>Feature Flags</h1>
        <div class="ff-actions">
          <button class="btn-secondary" id="ffRefreshBtn" type="button"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>

      <div class="ff-feature-view">
        <div class="ff-top-grid">
          <div class="ff-rollout-stack">
          <section class="ff-panel">
            <h2>Rollout Control</h2>
            <div class="ff-danger-note" style="margin-bottom:14px;">
              Mass actions patch only the selected feature flags. Other flags are left untouched.
            </div>
            <div class="ff-mini-toolbar">
              <span class="ff-status" id="ffSelectedFlagStatus">0 flags selected</span>
              <span class="ff-actions">
                <button class="ff-link-btn" id="ffSelectAllFlags" type="button">Select all</button>
                <button class="ff-link-btn" id="ffClearFlags" type="button">Clear</button>
              </span>
            </div>
            <div class="ff-grid" id="ffFlagGrid"></div>
            <div class="ff-filter-summary" id="ffRolloutFilterSummary"></div>
            <div class="ff-form" style="display:grid; grid-template-columns:1fr 150px 150px; gap:10px; margin-top:14px; align-items:end;">
              <div>
                <label>Cohort method</label>
                <select id="ffRolloutMode">
                  <option value="percentage">Exact stable percentage</option>
                  <option value="all">Everyone in filter</option>
                </select>
              </div>
              <div id="ffRolloutPercentWrap">
                <label>Percent</label>
                <input id="ffRolloutPercent" type="number" min="0" max="100" step="1" value="10">
              </div>
              <div class="ff-actions">
                <button class="btn-secondary" id="ffPreviewBtn" type="button"><i class="fas fa-eye"></i> Preview</button>
                <button class="btn-primary" id="ffApplyBtn" type="button"><i class="fas fa-rocket"></i> Apply</button>
              </div>
            </div>
            <div class="ff-status" id="ffRolloutStatus" style="margin-top:10px;"></div>
          </section>

          <section class="ff-panel">
            <h2>Variant Split Test</h2>
            <div class="ff-muted" style="margin-bottom:12px;">
              Select an exact percentage of matching organizations, then split only that selected cohort evenly across mutually exclusive variants. Everyone outside the selected percentage gets no variant and the required gate is turned off.
            </div>
            <div class="ff-form" style="display:grid; grid-template-columns:1fr 150px 180px; gap:10px; align-items:end;">
              <div>
                <label>Variant family</label>
                <select id="ffVariantFamily"></select>
              </div>
              <div>
                <label>Eligible percent</label>
                <input id="ffVariantPercent" type="number" min="0" max="100" step="1" value="50">
              </div>
              <div class="ff-actions">
                <button class="btn-secondary" id="ffVariantPreviewBtn" type="button"><i class="fas fa-eye"></i> Preview</button>
                <button class="btn-primary" id="ffVariantApplyBtn" type="button"><i class="fas fa-vial"></i> Apply Split</button>
              </div>
            </div>
            <div class="ff-variant-grid" id="ffVariantGrid" style="margin-top:12px;"></div>
            <div class="ff-status" id="ffVariantStatus" style="margin-top:10px;"></div>
          </section>
          </div>

          <div class="ff-side-stack">
            <section class="ff-panel">
              <h2>New User Defaults</h2>
              <div class="ff-danger-note" style="margin-bottom:12px;">
                These defaults are written into new customer organizations at signup. Existing organizations are not changed.
              </div>
              <div class="ff-muted" id="ffDefaultMeta" style="margin-bottom:12px;"></div>
              <div class="ff-default-flags" id="ffDefaultFlags"></div>
              <div class="ff-actions" style="margin-top:14px;">
                <button class="btn-primary" id="ffSaveDefaultsBtn" type="button"><i class="fas fa-save"></i> Save New User Defaults</button>
                <button class="btn-secondary" id="ffResetDefaultsBtn" type="button"><i class="fas fa-undo"></i> Reset to Code Defaults</button>
                <span class="ff-status" id="ffDefaultSaveStatus"></span>
              </div>
            </section>

            <section class="ff-panel">
            <h2>Find Organizations</h2>
            <div class="ff-controls">
              <div>
                <label>Search</label>
                <input id="ffOrgSearch" placeholder="Name, org id, email, phone">
              </div>
              <div>
                <label>Status</label>
                <select id="ffOrgStatus">
                  <option value="">All</option>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div>
                <label>Page size</label>
                <select id="ffOrgLimit">
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="250">250</option>
                  <option value="500">500</option>
                </select>
              </div>
            </div>
            <div class="ff-controls" style="grid-template-columns:1fr 130px 1fr 150px; margin-top:10px;">
              <div>
                <label>Flag filter</label>
                <select id="ffFilterFlag"></select>
              </div>
              <div>
                <label>Flag state</label>
                <select id="ffFilterFlagState">
                  <option value="">Any</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div>
                <label>Variant filter</label>
                <select id="ffFilterVariantFamily"></select>
              </div>
              <div>
                <label>Variant state</label>
                <select id="ffFilterVariantState">
                  <option value="">Any</option>
                  <option value="none">No variant</option>
                </select>
              </div>
            </div>
            <div class="ff-actions" style="margin:12px 0;">
              <button class="btn-secondary" id="ffSearchBtn" type="button"><i class="fas fa-search"></i> Search</button>
              <button class="btn-secondary" id="ffPrevPage" type="button"><i class="fas fa-chevron-left"></i></button>
              <button class="btn-secondary" id="ffNextPage" type="button"><i class="fas fa-chevron-right"></i></button>
              <span class="ff-status" id="ffSearchStatus">Loading...</span>
            </div>
            </section>

            <aside class="ff-panel ff-detail">
              <h2>Organization Flags</h2>
              <div id="ffOrgDetail" class="ff-detail-empty">Search for an organization, then open it here.</div>
            </aside>
          </div>
        </div>

        <section class="ff-panel">
          <h2>Organizations</h2>
          <div class="ff-table-wrap">
            <table class="ff-table">
              <thead><tr><th>Organization</th><th>Status</th><th>Contact</th><th>Referral Variant</th><th>Enabled Flags</th><th>Updated</th><th></th></tr></thead>
              <tbody id="ffOrgTable"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="ff-modal-backdrop" id="ffRolloutModal" role="dialog" aria-modal="true" aria-labelledby="ffRolloutModalTitle">
        <div class="ff-modal">
          <div class="ff-modal-head">
            <div>
              <h3 id="ffRolloutModalTitle">Rollout Preview</h3>
              <div class="ff-muted" id="ffRolloutModalSubtitle"></div>
            </div>
            <button class="btn-secondary" id="ffRolloutModalClose" type="button"><i class="fas fa-times"></i></button>
          </div>
          <div class="ff-modal-body" id="ffRolloutModalBody"></div>
        </div>
      </div>
    `;
    host.appendChild(wrap);
  }

  async function post(action, payload={}){
    const fd = new FormData();
    fd.append('action', action);
    Object.entries(payload).forEach(([key, value]) => fd.append(key, value));
    const res = await fetch(window.location.pathname, { method:'POST', body:fd, credentials:'same-origin' });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch (err) { throw new Error(`Invalid server response: ${text.slice(0, 180)}`); }
    if (!data.success) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function postResult(action, payload={}){
    const fd = new FormData();
    fd.append('action', action);
    Object.entries(payload).forEach(([key, value]) => fd.append(key, value));
    const res = await fetch(window.location.pathname, { method:'POST', body:fd, credentials:'same-origin' });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch (err) { throw new Error(`Invalid server response: ${text.slice(0, 180)}`); }
    if (!res.ok && !data.error) data.error = res.statusText || `HTTP ${res.status}`;
    if (!Object.prototype.hasOwnProperty.call(data, 'success')) data.success = res.ok;
    return data;
  }

  function selectedFlagKeys(){
    return $$('.ff-flag.selected').map((el) => el.dataset.flagKey).filter(Boolean);
  }

  function selectedFlagActions(){
    const actions = {};
    $$('.ff-flag.selected').forEach((el) => {
      const key = el.dataset.flagKey || '';
      if (key) actions[key] = el.dataset.action === 'off' ? 'off' : 'on';
    });
    return actions;
  }

  function selectedVariantKeys(){
    return $$('.ff-select-variant:checked').map((el) => el.value);
  }

  function flagLabel(key){
    const definition = state.definitions.find((item) => item.key === key);
    return definition ? definition.label : key;
  }

  function variantLabel(family, key){
    const definition = state.variantDefinitions.find((item) => item.family === family && item.key === key);
    return definition ? definition.label : (key || 'No variant');
  }

  function renderFlagGrid(){
    const grid = $('#ffFlagGrid');
    if (!grid) return;
    grid.innerHTML = state.definitions.map((definition) => {
      const stat = state.summary[definition.key] || {};
      const enabled = Number(stat.enabled || 0);
      const pct = state.totalOrgs ? Math.round((enabled / state.totalOrgs) * 1000) / 10 : 0;
      const requires = (definition.requires || []).length ? `Requires ${definition.requires.map(esc).join(', ')}` : '';
      const tooltip = esc(definition.description || 'No description available.');
      return `
        <div class="ff-flag" role="button" tabindex="0" aria-pressed="false" data-flag-key="${esc(definition.key)}" data-action="on">
          <div class="ff-flag-top">
            <div>
              <div class="ff-flag-title">${esc(definition.label)}</div>
              <div class="ff-key">${esc(definition.key)}</div>
            </div>
            <button class="ff-flag-action" type="button" aria-label="Toggle add or remove for ${esc(definition.label)}">Add</button>
            <button class="ff-info" type="button" data-tooltip-title="${esc(definition.label)}" data-tooltip-body="${tooltip}" data-tooltip-extra="${requires ? esc(requires) : ''}" aria-label="Show description for ${esc(definition.label)}">?</button>
          </div>
          <div class="ff-count">${enabled.toLocaleString()} / ${state.totalOrgs.toLocaleString()} effective (${pct}%)</div>
        </div>
      `;
    }).join('');
    bindFlagTiles(grid);
    renderSelectedFlagStatus();
  }

  function defaultFlagValue(raw, definition){
    const group = (raw || {})[definition.group] || {};
    return Object.prototype.hasOwnProperty.call(group, definition.flag)
      ? group[definition.flag] !== false
      : !!definition.default;
  }

  function renderDefaultFlags(){
    const grid = $('#ffDefaultFlags');
    if (!grid) return;
    const record = state.newUserDefaults || {};
    const flags = record.flags || {};
    grid.innerHTML = state.definitions.map((definition) => {
      const checked = defaultFlagValue(flags, definition) ? 'checked' : '';
      const requires = (definition.requires || []).length ? `Requires ${definition.requires.join(', ')}` : '';
      return `
        <label class="ff-toggle">
          <input class="ff-default-flag-input" type="checkbox" data-group="${esc(definition.group)}" data-flag="${esc(definition.flag)}" ${checked}>
          <span>
            <b>${esc(definition.label)}</b>
            <span>${esc(definition.key)}</span>
            <span>${esc(requires || definition.description || '')}</span>
          </span>
        </label>
      `;
    }).join('');
    const meta = $('#ffDefaultMeta');
    if (meta) {
      const saved = !!record.saved;
      const when = record.updated_at ? ` Last saved ${record.updated_at}` : '';
      const by = record.updated_by ? ` by ${record.updated_by}` : '';
      meta.textContent = saved ? `Using saved signup defaults.${when}${by}.` : 'Using code defaults until this template is saved.';
    }
  }

  function collectDefaultFlags(){
    const flags = {};
    state.definitions.forEach((definition) => {
      if (!flags[definition.group]) flags[definition.group] = {};
      const input = $$('.ff-default-flag-input').find((el) => el.dataset.group === definition.group && el.dataset.flag === definition.flag);
      flags[definition.group][definition.flag] = !!input?.checked;
    });
    return flags;
  }

  function codeDefaultFlags(){
    const defaults = {};
    state.definitions.forEach((definition) => {
      if (!defaults[definition.group]) defaults[definition.group] = {};
      defaults[definition.group][definition.flag] = !!definition.default;
    });
    return defaults;
  }

  function setDefaultFlags(flags){
    state.definitions.forEach((definition) => {
      const input = $$('.ff-default-flag-input').find((el) => el.dataset.group === definition.group && el.dataset.flag === definition.flag);
      if (input) input.checked = defaultFlagValue(flags, definition);
    });
  }

  function summarizeFlagsByState(flags, enabled){
    return state.definitions
      .filter((definition) => defaultFlagValue(flags, definition) === enabled)
      .map((definition) => definition.label);
  }

  function showDefaultConfirmModal(){
    const modal = $('#ffRolloutModal');
    const body = $('#ffRolloutModalBody');
    if (!modal || !body) return;
    const flags = collectDefaultFlags();
    const enabled = summarizeFlagsByState(flags, true);
    const disabled = summarizeFlagsByState(flags, false);
    const title = $('#ffRolloutModalTitle');
    const subtitle = $('#ffRolloutModalSubtitle');
    if (title) title.textContent = 'Confirm New User Defaults';
    if (subtitle) subtitle.textContent = 'This will apply to new customer organizations created after this save.';
    body.innerHTML = `
      <div class="ff-danger-note">
        Existing organizations will not be changed. Every new signup will receive these saved feature flags in its organization global settings.
      </div>
      <div class="ff-stat-grid">
        <div class="ff-stat"><b>${enabled.length.toLocaleString()}</b><span>Default On</span></div>
        <div class="ff-stat"><b>${disabled.length.toLocaleString()}</b><span>Default Off</span></div>
      </div>
      <div>
        <div class="ff-muted" style="margin-bottom:6px;">Default on for new users</div>
        <div class="ff-actions">${enabled.length ? enabled.map((label) => `<span class="ff-chip">${esc(label)}</span>`).join('') : '<span class="ff-chip off">none</span>'}</div>
      </div>
      <div>
        <div class="ff-muted" style="margin-bottom:6px;">Default off</div>
        <div class="ff-actions">${disabled.slice(0, 14).map((label) => `<span class="ff-chip off">${esc(label)}</span>`).join('')}${disabled.length > 14 ? `<span class="ff-chip off">+${disabled.length - 14}</span>` : ''}</div>
      </div>
      <div class="ff-actions" style="justify-content:flex-end;">
        <button class="btn-secondary" id="ffDefaultsModalCancel" type="button">Cancel</button>
        <button class="btn-primary" id="ffDefaultsModalApply" type="button"><i class="fas fa-save"></i> Confirm Defaults</button>
      </div>
    `;
    $('#ffDefaultsModalCancel')?.addEventListener('click', closeRolloutModal);
    $('#ffDefaultsModalApply')?.addEventListener('click', () => saveDefaultFlags(flags));
    modal.style.display = 'flex';
  }

  async function saveDefaultFlags(flags){
    const status = $('#ffDefaultSaveStatus');
    if (status) status.textContent = 'Saving...';
    try {
      const data = await post('feature_flags_save_defaults', {
        flags: JSON.stringify(flags || collectDefaultFlags())
      });
      state.newUserDefaults = data.new_user_defaults || state.newUserDefaults;
      renderDefaultFlags();
      closeRolloutModal();
      if (status) status.textContent = 'Saved for new users.';
    } catch (err) {
      if (status) status.textContent = err.message || 'Save failed.';
    }
  }

  function renderSelectedFlagStatus(){
    const label = $('#ffSelectedFlagStatus');
    if (!label) return;
    const actions = selectedFlagActions();
    const values = Object.values(actions);
    const addCount = values.filter((value) => value === 'on').length;
    const removeCount = values.filter((value) => value === 'off').length;
    const parts = [];
    if (addCount) parts.push(`${addCount} add`);
    if (removeCount) parts.push(`${removeCount} remove`);
    label.textContent = parts.length ? parts.join(', ') : '0 flags selected';
  }

  function syncRolloutModeControls(){
    const mode = $('#ffRolloutMode')?.value || 'percentage';
    const wrap = $('#ffRolloutPercentWrap');
    const input = $('#ffRolloutPercent');
    if (wrap) wrap.style.display = mode === 'all' ? 'none' : '';
    if (input) input.disabled = mode === 'all';
    renderRolloutFilterSummary();
  }

  function selectedOptionText(selector, fallback=''){
    const select = $(selector);
    if (!select) return fallback;
    return select.options[select.selectedIndex]?.textContent?.trim() || fallback;
  }

  function rolloutFilterParts(){
    const query = $('#ffOrgSearch')?.value?.trim() || '';
    const status = $('#ffOrgStatus')?.value || '';
    const flag = $('#ffFilterFlag')?.value || '';
    const flagState = $('#ffFilterFlagState')?.value || '';
    const variantFamily = $('#ffFilterVariantFamily')?.value || '';
    const variantState = $('#ffFilterVariantState')?.value || '';
    const parts = [];
    if (query) parts.push(`Search: ${query}`);
    if (status) parts.push(`Status: ${selectedOptionText('#ffOrgStatus', status)}`);
    if (flag) parts.push(`Flag: ${selectedOptionText('#ffFilterFlag', flag)}`);
    if (flagState) parts.push(`Flag state: ${selectedOptionText('#ffFilterFlagState', flagState)}`);
    if (variantFamily) parts.push(`Variant: ${selectedOptionText('#ffFilterVariantFamily', variantFamily)}`);
    if (variantState) parts.push(`Variant state: ${selectedOptionText('#ffFilterVariantState', variantState)}`);
    return parts;
  }

  function renderRolloutFilterSummary(){
    const host = $('#ffRolloutFilterSummary');
    if (!host) return;
    const mode = $('#ffRolloutMode')?.value || 'percentage';
    const cohort = mode === 'all'
      ? 'Cohort: everyone matching these filters'
      : `Cohort: ${$('#ffRolloutPercent')?.value || '0'}% exact stable sample of matching organizations`;
    const parts = rolloutFilterParts();
    const pills = parts.length
      ? parts.map((part) => `<span class="ff-filter-pill">${esc(part)}</span>`).join('')
      : '<span class="ff-filter-pill">No filters: all organizations</span>';
    host.innerHTML = `
      <span>${esc(cohort)}</span>
      ${pills}
      <button class="ff-link-btn" id="ffFocusFilters" type="button">Edit filters</button>
    `;
    $('#ffFocusFilters')?.addEventListener('click', () => {
      $('#ffOrgSearch')?.scrollIntoView({ behavior:'smooth', block:'center' });
      $('#ffOrgSearch')?.focus();
    });
  }

  function setFlagAction(tile, action){
    if (!tile) return;
    tile.dataset.action = action === 'off' ? 'off' : 'on';
    const button = $('.ff-flag-action', tile);
    if (button) {
      button.textContent = tile.dataset.action === 'off' ? 'Remove' : 'Add';
      const title = $('.ff-flag-title', tile)?.textContent || 'flag';
      button.setAttribute('aria-label', `Set ${title} action to ${tile.dataset.action === 'off' ? 'add' : 'remove'}`);
    }
  }

  function setFlagSelected(tile, selected){
    if (!tile) return;
    tile.classList.toggle('selected', !!selected);
    tile.setAttribute('aria-pressed', selected ? 'true' : 'false');
    renderSelectedFlagStatus();
  }

  function toggleFlagTile(tile){
    setFlagSelected(tile, !tile.classList.contains('selected'));
  }

  function toggleFlagAction(tile){
    if (!tile) return;
    if (!tile.classList.contains('selected')) {
      setFlagSelected(tile, true);
      return;
    }
    setFlagAction(tile, tile.dataset.action === 'off' ? 'on' : 'off');
    renderSelectedFlagStatus();
  }

  function tooltipEl(){
    let el = $('#ffTooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ffTooltip';
      el.className = 'ff-tooltip';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }

  function showTooltip(trigger){
    const tip = tooltipEl();
    const title = trigger.dataset.tooltipTitle || 'Feature flag';
    const body = trigger.dataset.tooltipBody || 'No description available.';
    const extra = trigger.dataset.tooltipExtra || '';
    tip.innerHTML = `<b>${esc(title)}</b>${esc(body)}${extra ? `<span>${esc(extra)}</span>` : ''}`;
    tip.style.display = 'block';
    const rect = trigger.getBoundingClientRect();
    const margin = 10;
    const width = Math.min(320, window.innerWidth - (margin * 2));
    tip.style.maxWidth = `${width}px`;
    const tipRect = tip.getBoundingClientRect();
    let left = rect.right + margin;
    let top = rect.top - 4;
    if (left + tipRect.width > window.innerWidth - margin) left = rect.left - tipRect.width - margin;
    if (left < margin) left = margin;
    if (top + tipRect.height > window.innerHeight - margin) top = window.innerHeight - tipRect.height - margin;
    if (top < margin) top = margin;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTooltip(){
    const tip = $('#ffTooltip');
    if (tip) tip.style.display = 'none';
  }

  function bindFlagTiles(grid){
    $$('.ff-flag', grid).forEach((tile) => {
      tile.addEventListener('click', (event) => {
        if (event.target.closest('.ff-info') || event.target.closest('.ff-flag-action')) return;
        toggleFlagTile(tile);
      });
      tile.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleFlagTile(tile);
      });
    });
    $$('.ff-flag-action', grid).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFlagAction(button.closest('.ff-flag'));
      });
    });
    $$('.ff-info', grid).forEach((button) => {
      button.addEventListener('mouseenter', () => showTooltip(button));
      button.addEventListener('focus', () => showTooltip(button));
      button.addEventListener('mouseleave', hideTooltip);
      button.addEventListener('blur', hideTooltip);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        showTooltip(button);
      });
    });
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.ff-info')) hideTooltip();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  });
  window.addEventListener('scroll', hideTooltip, true);

  function renderVariantControls(){
    const familySelect = $('#ffVariantFamily');
    const grid = $('#ffVariantGrid');
    if (!familySelect || !grid) return;
    const families = Array.from(new Set(state.variantDefinitions.map((item) => item.family)));
    const previous = familySelect.value;
    familySelect.innerHTML = families.map((family) => `<option value="${esc(family)}">${esc(family)}</option>`).join('');
    if (previous && families.includes(previous)) familySelect.value = previous;
    const activeFamily = familySelect.value || families[0] || '';
    const variants = state.variantDefinitions.filter((item) => item.family === activeFamily);
    grid.innerHTML = variants.map((variant) => `
      <label class="ff-toggle">
        <input class="ff-select-variant" type="checkbox" value="${esc(variant.key)}" checked>
        <span>
          <b>${esc(variant.label)}</b>
          <span>${esc(variant.key)}</span>
          <span>${esc(variant.description)}</span>
          ${(variant.requires || []).length ? `<span>Requires ${variant.requires.map(esc).join(', ')}</span>` : ''}
        </span>
      </label>
    `).join('');
  }

  function renderTableFilters(){
    const flagSelect = $('#ffFilterFlag');
    const variantFamily = $('#ffFilterVariantFamily');
    if (flagSelect) {
      const previous = flagSelect.value;
      flagSelect.innerHTML = '<option value="">Any flag</option>' + state.definitions
        .map((definition) => `<option value="${esc(definition.key)}">${esc(definition.label)} (${esc(definition.key)})</option>`)
        .join('');
      if (previous) flagSelect.value = previous;
    }
    if (variantFamily) {
      const previous = variantFamily.value;
      const families = Array.from(new Set(state.variantDefinitions.map((item) => item.family)));
      variantFamily.innerHTML = '<option value="">Any variant family</option>' + families
        .map((family) => `<option value="${esc(family)}">${esc(family)}</option>`)
        .join('');
      if (previous) variantFamily.value = previous;
      renderVariantStateFilter();
    }
  }

  function renderVariantStateFilter(){
    const family = $('#ffFilterVariantFamily')?.value || '';
    const select = $('#ffFilterVariantState');
    if (!select) return;
    const previous = select.value;
    const variants = family ? state.variantDefinitions.filter((item) => item.family === family) : [];
    select.innerHTML = `
      <option value="">Any</option>
      <option value="none">No variant</option>
      ${variants.map((variant) => `<option value="${esc(variant.key)}">${esc(variant.label)}</option>`).join('')}
    `;
    if (previous) select.value = previous;
  }

  function chips(keys){
    if (!keys || !keys.length) return '<span class="ff-chip off">none</span>';
    return keys.slice(0, 6).map((key) => `<span class="ff-chip">${esc(flagLabel(key))}</span>`).join('') +
      (keys.length > 6 ? `<span class="ff-chip off">+${keys.length - 6}</span>` : '');
  }

  function setTableMessage(message){
    const tbody = $('#ffOrgTable');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px;">${esc(message)}</td></tr>`;
  }

  function renderOrgTable(){
    const tbody = $('#ffOrgTable');
    if (!tbody) return;
    if (!state.orgs.length) {
      setTableMessage('No organizations found.');
      return;
    }
    tbody.innerHTML = state.orgs.map((org) => `
      <tr>
        <td>
          <div class="ff-org-name">${esc(org.name)}</div>
          <div class="ff-key">${esc(org.id)}</div>
        </td>
        <td><span class="ff-chip off">${esc(org.status || 'active')}</span></td>
        <td>
          <div>${esc(org.email || '')}</div>
          <div class="ff-muted">${esc(org.phone || '')}</div>
        </td>
        <td>${renderVariantChips(org)}</td>
        <td>${chips(org.enabled_flags || [])}</td>
        <td><div class="ff-muted">${esc(org.updated_at || org.created_at || '')}</div></td>
        <td style="text-align:right;"><button class="btn-secondary ff-open-org" data-org-id="${esc(org.id)}" type="button"><i class="fas fa-sliders"></i> Open</button></td>
      </tr>
    `).join('');
    $$('.ff-open-org', tbody).forEach((btn) => btn.addEventListener('click', () => loadOrg(btn.dataset.orgId)));
  }

  function renderVariantChips(org){
    const variants = org.effective_variants || {};
    const families = Array.from(new Set(state.variantDefinitions.map((item) => item.family)));
    const rendered = families.map((family) => {
      const value = variants[family];
      return value ? `<span class="ff-chip">${esc(variantLabel(family, value))}</span>` : `<span class="ff-chip off">${esc(family)}: none</span>`;
    });
    return rendered.length ? rendered.join('') : '<span class="ff-chip off">none</span>';
  }

  function renderSearchStatus(){
    const label = $('#ffSearchStatus');
    if (!label) return;
    const all = !state.limit;
    const start = state.total ? (all ? 1 : ((state.page - 1) * state.limit) + 1) : 0;
    const end = all ? state.total : Math.min(state.total, state.page * state.limit);
    label.textContent = `${start}-${end} of ${state.total.toLocaleString()}`;
    $('#ffPrevPage').disabled = all || state.page <= 1;
    $('#ffNextPage').disabled = all || state.page * state.limit >= state.total;
  }

  function readSearch(){
    const rawLimit = $('#ffOrgLimit')?.value || '25';
    state.limit = rawLimit === 'all' ? 0 : Number(rawLimit || 25);
    return {
      query: $('#ffOrgSearch')?.value || '',
      status: $('#ffOrgStatus')?.value || '',
      limit: rawLimit,
      page: state.page,
      flag_key: $('#ffFilterFlag')?.value || '',
      flag_state: $('#ffFilterFlagState')?.value || '',
      variant_family: $('#ffFilterVariantFamily')?.value || '',
      variant_state: $('#ffFilterVariantState')?.value || ''
    };
  }

  function closeRolloutModal(){
    const modal = $('#ffRolloutModal');
    if (modal) modal.style.display = 'none';
  }

  function showRolloutModal(data, dryRun){
    const modal = $('#ffRolloutModal');
    const body = $('#ffRolloutModalBody');
    if (!modal || !body) return;
    const title = $('#ffRolloutModalTitle');
    const subtitle = $('#ffRolloutModalSubtitle');
    const mode = $('#ffRolloutMode')?.value || 'percentage';
    const percent = mode === 'all' ? 100 : Number($('#ffRolloutPercent')?.value || 0);
    const matched = Number(data.matched || 0);
    const selected = Number(data.selected || 0);
    const changed = Number(data.changed || 0);
    const selectedPct = state.totalOrgs ? Math.round((selected / state.totalOrgs) * 1000) / 10 : 0;
    const matchedPct = state.totalOrgs ? Math.round((matched / state.totalOrgs) * 1000) / 10 : 0;
    const actions = selectedFlagActions();
    const addFlags = Object.entries(actions).filter(([, value]) => value === 'on').map(([key]) => flagLabel(key));
    const removeFlags = Object.entries(actions).filter(([, value]) => value === 'off').map(([key]) => flagLabel(key));
    const filterParts = rolloutFilterParts();
    const sample = (data.preview || [])
      .map((org) => `<div>${org.selected ? 'Will patch' : 'Outside cohort'}: ${esc(org.name || org.id || '')}</div>`)
      .join('');
    if (title) title.textContent = dryRun ? 'Rollout Preview' : 'Rollout Result';
    if (subtitle) {
      subtitle.textContent = mode === 'all'
        ? 'Everyone matching the filters will be patched.'
        : `${percent}% exact stable sample of organizations matching the filters will be patched.`;
    }
    body.innerHTML = `
      <div class="ff-stat-grid">
        <div class="ff-stat"><b>${matched.toLocaleString()}</b><span>Match Filters (${matchedPct}% of all)</span></div>
        <div class="ff-stat"><b>${selected.toLocaleString()}</b><span>Will Be Patched (${selectedPct}% of all)</span></div>
        <div class="ff-stat"><b>${changed.toLocaleString()}</b><span>${dryRun ? 'Would Change' : 'Changed'}</span></div>
      </div>
      <div>
        <div class="ff-muted" style="margin-bottom:6px;">Filters used</div>
        <div class="ff-actions">${filterParts.length ? filterParts.map((part) => `<span class="ff-filter-pill">${esc(part)}</span>`).join('') : '<span class="ff-filter-pill">No filters: all organizations</span>'}</div>
      </div>
      <div>
        <div class="ff-muted" style="margin-bottom:6px;">Flag patch</div>
        <div class="ff-actions">
          ${addFlags.length ? `<span class="ff-chip">Add: ${esc(addFlags.join(', '))}</span>` : ''}
          ${removeFlags.length ? `<span class="ff-chip off">Remove: ${esc(removeFlags.join(', '))}</span>` : ''}
        </div>
      </div>
      ${sample ? `<div><div class="ff-muted" style="margin-bottom:6px;">Sample</div><div class="ff-preview-list">${sample}</div></div>` : ''}
      <div class="ff-actions" style="justify-content:flex-end;">
        <button class="btn-secondary" id="ffRolloutModalCancel" type="button">Close</button>
        ${dryRun ? '<button class="btn-primary" id="ffRolloutModalApply" type="button"><i class="fas fa-rocket"></i> Apply This Patch</button>' : ''}
      </div>
    `;
    $('#ffRolloutModalCancel')?.addEventListener('click', closeRolloutModal);
    $('#ffRolloutModalApply')?.addEventListener('click', () => {
      closeRolloutModal();
      runRollout(false);
    });
    modal.style.display = 'flex';
  }

  async function bootstrap(){
    const status = $('#ffSearchStatus');
    if (status) status.textContent = 'Loading flags...';
    try {
      const data = await post('feature_flags_bootstrap');
      state.booted = true;
      state.definitions = data.definitions || [];
      state.variantDefinitions = data.variant_definitions || [];
      state.summary = data.summary || {};
      state.newUserDefaults = data.new_user_defaults || null;
      state.totalOrgs = Number(data.total_orgs || 0);
      renderFlagGrid();
      renderDefaultFlags();
      renderVariantControls();
      renderTableFilters();
      renderRolloutFilterSummary();
      await searchOrgs(true);
    } catch (err) {
      if (status) status.textContent = err.message || 'Could not load feature flags.';
      setTableMessage(err.message || 'Could not load organizations.');
    }
  }

  async function searchOrgs(resetPage=false){
    if (resetPage) state.page = 1;
    const status = $('#ffSearchStatus');
    if (status) status.textContent = 'Loading...';
    try {
      const data = await post('feature_flags_search', readSearch());
      state.total = Number(data.total || 0);
      state.page = Number(data.page || state.page);
      state.limit = Number(data.limit ?? state.limit);
      state.orgs = data.organizations || [];
      renderOrgTable();
      renderSearchStatus();
    } catch (err) {
      if (status) status.textContent = err.message || 'Search failed.';
      setTableMessage(err.message || 'Search failed.');
    }
  }

  function orgFlagValue(raw, definition){
    return ((raw || {})[definition.group] || {})[definition.flag] !== false;
  }

  function renderOrgDetail(){
    const host = $('#ffOrgDetail');
    const org = state.selectedOrg;
    if (!host) return;
    if (!org) {
      host.className = 'ff-detail-empty';
      host.textContent = 'Search for an organization, then open it here.';
      return;
    }
    host.className = '';
    host.innerHTML = `
      <div class="ff-org-name">${esc(org.name)}</div>
      <div class="ff-key" style="margin:4px 0 12px;">${esc(org.id)}</div>
          <div class="ff-muted" style="margin-bottom:12px;">Effective flags respect dependencies; raw toggles below are what gets saved to global.json.</div>
          <div class="ff-form" style="margin-bottom:14px;">
            ${Array.from(new Set(state.variantDefinitions.map((item) => item.family))).map((family) => {
              const current = (org.raw_variants || {})[family] || '';
              const variants = state.variantDefinitions.filter((item) => item.family === family);
              return `
                <label>${esc(family)}</label>
                <select class="ff-org-variant-input" data-family="${esc(family)}">
                  <option value="">No variant</option>
                  ${variants.map((variant) => `<option value="${esc(variant.key)}" ${variant.key === current ? 'selected' : ''}>${esc(variant.label)}</option>`).join('')}
                </select>
                <div class="ff-muted" style="margin:5px 0 10px;">Effective: ${esc(variantLabel(family, (org.effective_variants || {})[family]))}</div>
              `;
            }).join('')}
          </div>
      <div class="ff-org-flags">
        ${state.definitions.map((definition) => {
          const checked = orgFlagValue(org.raw, definition) ? 'checked' : '';
          const effective = org.effective_by_key && org.effective_by_key[definition.key] ? 'effective on' : (org.disabled_reasons?.[definition.key] || 'off');
          return `
            <label class="ff-toggle">
              <input class="ff-org-flag-input" type="checkbox" data-group="${esc(definition.group)}" data-flag="${esc(definition.flag)}" ${checked}>
              <span>
                <b>${esc(definition.label)}</b>
                <span>${esc(definition.key)}</span>
                <span>${esc(effective)}</span>
              </span>
            </label>
          `;
        }).join('')}
      </div>
      <div class="ff-actions" style="margin-top:14px;">
        <button class="btn-primary" id="ffSaveOrgBtn" type="button"><i class="fas fa-save"></i> Save Org Flags</button>
        <span class="ff-status" id="ffOrgSaveStatus"></span>
      </div>
    `;
    $('#ffSaveOrgBtn')?.addEventListener('click', saveSelectedOrg);
  }

  async function loadOrg(orgId){
    const data = await post('feature_flags_org', { org_id: orgId });
    state.selectedOrg = data.organization;
    renderOrgDetail();
  }

  function collectOrgFlags(){
    const flags = {};
    state.definitions.forEach((definition) => {
      if (!flags[definition.group]) flags[definition.group] = {};
      const input = $$('.ff-org-flag-input').find((el) => el.dataset.group === definition.group && el.dataset.flag === definition.flag);
      flags[definition.group][definition.flag] = !!input?.checked;
    });
    return flags;
  }

  function collectOrgVariants(){
    const variants = {};
    $$('.ff-org-variant-input').forEach((input) => {
      variants[input.dataset.family] = input.value || null;
    });
    return variants;
  }

  async function saveSelectedOrg(){
    if (!state.selectedOrg) return;
    const status = $('#ffOrgSaveStatus');
    if (status) status.textContent = 'Saving...';
    try {
      const data = await post('feature_flags_save_org', {
        org_id: state.selectedOrg.id,
        flags: JSON.stringify(collectOrgFlags()),
        variants: JSON.stringify(collectOrgVariants())
      });
      state.selectedOrg = data.organization;
      if (status) status.textContent = 'Saved.';
      renderOrgDetail();
      await bootstrap();
    } catch (err) {
      if (status) status.textContent = err.message || 'Save failed.';
    }
  }

  function rolloutPayload(dryRun){
    return {
      flag_keys: JSON.stringify(selectedFlagKeys()),
      flag_actions: JSON.stringify(selectedFlagActions()),
      mode: $('#ffRolloutMode')?.value || 'percentage',
      percent: $('#ffRolloutPercent')?.value || '100',
      query: $('#ffOrgSearch')?.value || '',
      status: $('#ffOrgStatus')?.value || '',
      filter_flag_key: $('#ffFilterFlag')?.value || '',
      filter_flag_state: $('#ffFilterFlagState')?.value || '',
      filter_variant_family: $('#ffFilterVariantFamily')?.value || '',
      filter_variant_state: $('#ffFilterVariantState')?.value || '',
      dry_run: dryRun ? '1' : '0'
    };
  }

  function chunkList(items, size){
    const chunks = [];
    const step = Math.max(1, Number(size || ROLLOUT_BATCH_SIZE));
    for (let i = 0; i < items.length; i += step) chunks.push(items.slice(i, i + step));
    return chunks;
  }

  function showRolloutBatchModal(plan, dryRun, batches){
    const modal = $('#ffRolloutModal');
    const body = $('#ffRolloutModalBody');
    if (!modal || !body) return;
    const title = $('#ffRolloutModalTitle');
    const subtitle = $('#ffRolloutModalSubtitle');
    if (title) title.textContent = dryRun ? 'Rollout Batch Preview' : 'Rollout Batch Deploy';
    if (subtitle) subtitle.textContent = dryRun
      ? 'Each row is a read-only dry-run request.'
      : 'Each row is one small deploy request against the locked preview cohort.';

    body.innerHTML = `
      <div class="ff-stat-grid">
        <div class="ff-stat"><b>${Number(plan.matched || 0).toLocaleString()}</b><span>Match Filters</span></div>
        <div class="ff-stat"><b>${Number(plan.selected || 0).toLocaleString()}</b><span>In Cohort</span></div>
        <div class="ff-stat"><b id="ffRolloutChanged">0</b><span>${dryRun ? 'Would Change' : 'Changed'}</span></div>
      </div>
      <div class="ff-progress-track"><div class="ff-progress-bar" id="ffRolloutProgressBar"></div></div>
      <div class="ff-status" id="ffRolloutProgressText">Preparing ${batches.length.toLocaleString()} batch${batches.length === 1 ? '' : 'es'}...</div>
      <div class="ff-table-wrap">
        <table class="ff-batch-table">
          <thead><tr><th>Batch</th><th>Organizations</th><th>Status</th><th>Changed</th><th>Errors</th></tr></thead>
          <tbody>
            ${batches.map((batch, index) => `
              <tr id="ffBatchRow${index}">
                <td>${index + 1}</td>
                <td>${batch.length.toLocaleString()}</td>
                <td><span class="ff-batch-status">Pending</span></td>
                <td>0</td>
                <td></td>
              </tr>
            `).join('') || '<tr><td colspan="5">No organizations are in this cohort.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="ff-actions" id="ffRolloutModalActions" style="justify-content:flex-end;">
        <button class="btn-secondary" id="ffRolloutModalCancel" type="button">Close</button>
      </div>
    `;
    $('#ffRolloutModalCancel')?.addEventListener('click', closeRolloutModal);
    modal.style.display = 'flex';
  }

  function updateBatchRow(index, statusText, statusClass, changed, errors){
    const row = $(`#ffBatchRow${index}`);
    if (!row) return;
    const cells = row.querySelectorAll('td');
    const status = row.querySelector('.ff-batch-status');
    if (status) {
      status.className = `ff-batch-status ${statusClass || ''}`.trim();
      status.textContent = statusText;
    }
    if (cells[3]) cells[3].textContent = Number(changed || 0).toLocaleString();
    if (cells[4]) cells[4].textContent = errors && errors.length ? errors.join(' | ') : '';
  }

  function updateRolloutProgress(done, total, changed){
    const pct = total ? Math.round((done / total) * 100) : 100;
    const bar = $('#ffRolloutProgressBar');
    const text = $('#ffRolloutProgressText');
    const changedEl = $('#ffRolloutChanged');
    if (bar) bar.style.width = `${pct}%`;
    if (text) text.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} batches complete.`;
    if (changedEl) changedEl.textContent = Number(changed || 0).toLocaleString();
  }

  async function runRollout(dryRun, existingPlan=null){
    const keys = selectedFlagKeys();
    const status = $('#ffRolloutStatus');
    if (!existingPlan && !keys.length) {
      if (status) status.textContent = 'Choose at least one flag.';
      return;
    }
    if (rolloutRunning) return;
    rolloutRunning = true;
    if (status) status.textContent = dryRun ? 'Preparing preview batches...' : 'Preparing deploy batches...';
    try {
      const payload = existingPlan?._payload ? { ...existingPlan._payload, dry_run: dryRun ? '1' : '0' } : rolloutPayload(dryRun);
      const plan = existingPlan || await post('feature_flags_rollout_plan', payload);
      plan._payload = payload;
      activeRolloutPlan = plan;
      const batches = chunkList(plan.org_ids || [], Number(plan.batch_size || ROLLOUT_BATCH_SIZE));
      showRolloutBatchModal(plan, dryRun, batches);

      let totalChanged = 0;
      let failed = 0;
      updateRolloutProgress(0, batches.length, totalChanged);
      for (let index = 0; index < batches.length; index++) {
        updateBatchRow(index, 'Running...', 'run', 0, []);
        try {
          const data = await postResult('feature_flags_rollout_batch', {
            ...payload,
            dry_run: dryRun ? '1' : '0',
            org_ids: JSON.stringify(batches[index])
          });
          totalChanged += Number(data.changed || 0);
          if (!data.success) failed++;
          updateBatchRow(index, data.success ? 'Success' : 'Failed', data.success ? 'ok' : 'fail', data.changed || 0, data.errors || (data.error ? [data.error] : []));
        } catch (err) {
          failed++;
          updateBatchRow(index, err.message || 'Failed', 'fail', 0, [err.message || 'Request failed']);
        }
        updateRolloutProgress(index + 1, batches.length, totalChanged);
      }

      const message = `${dryRun ? 'Preview complete' : 'Deploy complete'}: matched ${plan.matched}, selected ${plan.selected}, ${dryRun ? 'would change' : 'changed'} ${totalChanged}, failed batches ${failed}.`;
      if (status) status.textContent = message;
      const progressText = $('#ffRolloutProgressText');
      if (progressText) progressText.textContent = message;
      const actions = $('#ffRolloutModalActions');
      if (actions && dryRun && batches.length) {
        const apply = document.createElement('button');
        apply.className = 'btn-primary';
        apply.type = 'button';
        apply.innerHTML = '<i class="fas fa-rocket"></i> Apply This Patch';
        apply.addEventListener('click', () => runRollout(false, activeRolloutPlan));
        actions.appendChild(apply);
      }
      if (!dryRun) await bootstrap();
    } catch (err) {
      if (status) status.textContent = err.message || 'Rollout failed.';
      const progressText = $('#ffRolloutProgressText');
      if (progressText) progressText.textContent = err.message || 'Rollout failed.';
    } finally {
      rolloutRunning = false;
    }
  }

  async function runVariantRollout(dryRun){
    const family = $('#ffVariantFamily')?.value || '';
    const keys = selectedVariantKeys();
    const status = $('#ffVariantStatus');
    if (!family) {
      if (status) status.textContent = 'Choose a variant family.';
      return;
    }
    if (!keys.length) {
      if (status) status.textContent = 'Choose at least one variant.';
      return;
    }
    if (!dryRun) {
      const ok = confirm(`Apply ${family} split test to matching organizations? Preview first if you have not already.`);
      if (!ok) return;
    }
    if (status) status.textContent = dryRun ? 'Previewing split...' : 'Applying split...';
    try {
      const data = await post('feature_flags_variant_rollout', {
        variant_family: family,
        variant_keys: JSON.stringify(keys),
        percent: $('#ffVariantPercent')?.value || '50',
        query: $('#ffOrgSearch')?.value || '',
        status: $('#ffOrgStatus')?.value || '',
        filter_flag_key: $('#ffFilterFlag')?.value || '',
        filter_flag_state: $('#ffFilterFlagState')?.value || '',
        filter_variant_family: $('#ffFilterVariantFamily')?.value || '',
        filter_variant_state: $('#ffFilterVariantState')?.value || '',
        dry_run: dryRun ? '1' : '0'
      });
      const counts = Object.entries(data.variant_counts || {})
        .map(([key, count]) => `${variantLabel(family, key)}: ${count}`)
        .join(', ');
      const sample = (data.preview || []).map((org) => `${org.variant || 'holdout'}: ${org.name}`).join(' | ');
      if (status) status.textContent = `${data.message} matched ${data.matched}, selected ${data.selected}, holdout ${data.holdout}, changed ${data.changed}. ${counts}. ${sample}`;
      if (!dryRun) await bootstrap();
    } catch (err) {
      if (status) status.textContent = err.message || 'Variant rollout failed.';
    }
  }

  function bind(){
    $('#ffRefreshBtn')?.addEventListener('click', () => bootstrap().catch((err) => $('#ffSearchStatus').textContent = err.message));
    $('#ffSearchBtn')?.addEventListener('click', () => searchOrgs(true));
    $('#ffOrgSearch')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') searchOrgs(true);
    });
    $('#ffOrgStatus')?.addEventListener('change', () => searchOrgs(true));
    $('#ffOrgLimit')?.addEventListener('change', () => searchOrgs(true));
    $('#ffFilterFlag')?.addEventListener('change', () => searchOrgs(true));
    $('#ffFilterFlagState')?.addEventListener('change', () => searchOrgs(true));
    $('#ffFilterVariantFamily')?.addEventListener('change', () => {
      renderVariantStateFilter();
      searchOrgs(true);
    });
    $('#ffFilterVariantState')?.addEventListener('change', () => searchOrgs(true));
    $('#ffPrevPage')?.addEventListener('click', () => {
      if (state.page > 1) {
        state.page--;
        searchOrgs(false);
      }
    });
    $('#ffNextPage')?.addEventListener('click', () => {
      if (state.page * state.limit < state.total) {
        state.page++;
        searchOrgs(false);
      }
    });
    $('#ffPreviewBtn')?.addEventListener('click', () => runRollout(true));
    $('#ffApplyBtn')?.addEventListener('click', () => runRollout(false));
    $('#ffSaveDefaultsBtn')?.addEventListener('click', showDefaultConfirmModal);
    $('#ffResetDefaultsBtn')?.addEventListener('click', () => {
      setDefaultFlags(codeDefaultFlags());
      const status = $('#ffDefaultSaveStatus');
      if (status) status.textContent = 'Reset locally. Save to apply to future signups.';
    });
    $('#ffRolloutMode')?.addEventListener('change', syncRolloutModeControls);
    $('#ffRolloutPercent')?.addEventListener('input', renderRolloutFilterSummary);
    $('#ffSelectAllFlags')?.addEventListener('click', () => {
      $$('.ff-flag').forEach((tile) => setFlagSelected(tile, true));
      renderSelectedFlagStatus();
    });
    $('#ffClearFlags')?.addEventListener('click', () => {
      $$('.ff-flag').forEach((tile) => setFlagSelected(tile, false));
      renderSelectedFlagStatus();
    });
    $('#ffVariantFamily')?.addEventListener('change', renderVariantControls);
    $('#ffVariantPreviewBtn')?.addEventListener('click', () => runVariantRollout(true));
    $('#ffVariantApplyBtn')?.addEventListener('click', () => runVariantRollout(false));
    ['#ffOrgSearch', '#ffOrgStatus', '#ffFilterFlag', '#ffFilterFlagState', '#ffFilterVariantFamily', '#ffFilterVariantState'].forEach((selector) => {
      $(selector)?.addEventListener('input', renderRolloutFilterSummary);
      $(selector)?.addEventListener('change', renderRolloutFilterSummary);
    });
    $('#ffRolloutModalClose')?.addEventListener('click', closeRolloutModal);
    $('#ffRolloutModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'ffRolloutModal') closeRolloutModal();
    });
    syncRolloutModeControls();
  }

  const FeatureFlags = {
    async onShow(){
      ensureMarkup();
      if (!state.booted) await bootstrap();
    },
    init(){
      if (!canManage()) return;
      ensureMarkup();
      bind();
      window.Portal.registerPlugin({ id:'feature-flags', title:'Feature Flags', iconClass:'fas fa-flask' });
    }
  };

  window.FeatureFlags = FeatureFlags;

  const originalSwitch = window.Portal.switchView.bind(window.Portal);
  window.Portal.switchView = async function(id, btn){
    const result = await originalSwitch(id, btn);
    if (id === 'feature-flags') await FeatureFlags.onShow();
    return result;
  };

  document.addEventListener('DOMContentLoaded', () => FeatureFlags.init());
})();
