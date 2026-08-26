(function(){
  if (!window.Portal) return;

  const MI2KM = 1.60934;
  const KM_PER_DEG_LAT = 111.32;
  const PRICE_NEARBY = 0.032;
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = (s) => Portal.escapeHtml(s ?? '');

  const state = {
    dashboard: [],
    lists: [],
    selectedListId: '',
    selectedList: null,
    selectedLeads: [],
    selectedLeadFilters: {
      q: '',
      status: '',
      assigned_to_email: ''
    },
    selectedExportHistory: [],
    salesUsers: [],
    busyMessage: '',
    assignModalMode: '',
    assignModalSelected: [],
    assignModalSingle: '',
    territory: {
      config: {
        center_lat: 47.6062,
        center_lng: -122.3321,
        tile_side_miles: 1,
        search_type: 'roofing_contractor',
        extent: 2
      },
      tileStatus: {},
      selectedTiles: {},
      rawBusinesses: [],
      detailIndex: {},
      filteredBusinesses: [],
      derivedStates: []
    }
  };

  function isManager(){
    const perms = cfg().perms || {};
    return !!(perms.manage_users || perms.manage_sales_users || perms.create_users);
  }

  function onlyMineMode(){
    return !isManager();
  }

  function fmtTs(ts){
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleString() : '-';
  }

  async function api(payload){
    return Portal.apiPost(cfg().endpoints.server, payload);
  }

  async function fetcherApi(action, data = {}){
    return Portal.apiPost(cfg().endpoints.server, { action: `lead_list_fetcher_${action}`, ...data });
  }

  function setBusy(message){
    state.busyMessage = message || '';
    const host = document.getElementById('leadBusyState');
    if (!host) return;
    if (!state.busyMessage) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    host.style.display = 'flex';
    host.innerHTML = `
      <div style="width:16px; height:16px; border:2px solid #e8b16a; border-top-color:#b55a00; border-radius:50%; animation:leadSpin .8s linear infinite;"></div>
      <div>${esc(state.busyMessage)}</div>
    `;
  }

  function setButtonBusy(id, busy, busyLabel){
    const btn = document.getElementById(id);
    if (!btn) return;
    if (!btn.dataset.baseLabel) btn.dataset.baseLabel = btn.innerHTML;
    btn.disabled = !!busy;
    btn.innerHTML = busy ? (busyLabel || 'Working...') : btn.dataset.baseLabel;
  }

  function submitCsvDownload(listId){
    const frameId = 'leadDownloadFrame';
    let frame = document.getElementById(frameId);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = frameId;
      frame.name = frameId;
      frame.style.display = 'none';
      document.body.appendChild(frame);
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = cfg().endpoints.server;
    form.target = frameId;
    form.style.display = 'none';
    [
      ['action', 'lead_export_csv'],
      ['list_id', listId],
      ['download', '1']
    ].forEach(([key, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  function submitLeadSelectionCsv(leadIds){
    const ids = Array.isArray(leadIds) ? leadIds.map(id => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return;
    const frameId = 'leadDownloadFrame';
    let frame = document.getElementById(frameId);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = frameId;
      frame.name = frameId;
      frame.style.display = 'none';
      document.body.appendChild(frame);
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = cfg().endpoints.server;
    form.target = frameId;
    form.style.display = 'none';
    [
      ['action', 'lead_export_leads_csv'],
      ['mode', 'selected'],
      ['lead_ids_csv', ids.join(',')],
      ['download', '1']
    ].forEach(([key, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host || document.getElementById('view-lead-lists')) return;

    const wrap = document.createElement('div');
    wrap.id = 'view-lead-lists';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <style>
        @keyframes leadSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        #view-lead-lists .lead-input,
        #view-lead-lists .lead-textarea,
        #view-lead-lists .lead-select {
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          padding: 10px 12px;
          border: 1px solid #ccc;
          border-radius: 8px;
          background: #fff;
        }
        #view-lead-lists .lead-textarea {
          min-height: 84px;
          resize: vertical;
        }
        #view-lead-lists .lead-two-col {
          display: grid;
          grid-template-columns: minmax(320px, 0.95fr) minmax(420px, 1.25fr);
          gap: 18px;
          align-items: start;
        }
        #view-lead-lists .lead-scroll-panel {
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        #view-lead-lists .lead-scroll-body {
          flex: 1;
          min-height: 0;
          max-height: 780px;
          overflow: auto;
        }
        #view-lead-lists .lead-table-wrap { width:100%; overflow-x:auto; }
        #view-lead-lists .lead-toggle-group { display:flex; gap:8px; flex-wrap:wrap; }
        #view-lead-lists .lead-toggle-btn,
        #view-lead-lists .lead-tile-btn {
          border:1px solid #d8d8d8;
          background:#fff;
          color:#444;
          border-radius:999px;
          padding:8px 12px;
          font-size:12px;
          font-weight:800;
          cursor:pointer;
        }
        #view-lead-lists .lead-toggle-btn.active {
          background:#fff1dc;
          border-color:#e5b673;
          color:#9a5300;
        }
        #view-lead-lists .lead-list-detail-table,
        #view-lead-lists .lead-territory-table { width:100%; table-layout:fixed; }
        #view-lead-lists .lead-list-detail-table th,
        #view-lead-lists .lead-list-detail-table td,
        #view-lead-lists .lead-territory-table th,
        #view-lead-lists .lead-territory-table td {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          vertical-align: middle;
        }
        #view-lead-lists .lead-list-detail-table th:nth-child(1),
        #view-lead-lists .lead-list-detail-table td:nth-child(1) { width: 24%; }
        #view-lead-lists .lead-list-detail-table th:nth-child(2),
        #view-lead-lists .lead-list-detail-table td:nth-child(2) { width: 14%; }
        #view-lead-lists .lead-list-detail-table th:nth-child(3),
        #view-lead-lists .lead-list-detail-table td:nth-child(3) { width: 16%; }
        #view-lead-lists .lead-list-detail-table th:nth-child(4),
        #view-lead-lists .lead-list-detail-table td:nth-child(4) { width: 18%; }
        #view-lead-lists .lead-list-detail-table th:nth-child(5),
        #view-lead-lists .lead-list-detail-table td:nth-child(5) { width: 28%; }
        #view-lead-lists .lead-territory-grid {
          display:grid;
          grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
          gap:10px;
        }
        #view-lead-lists .lead-tile-btn {
          border-radius:14px;
          padding:10px 8px;
          display:flex;
          flex-direction:column;
          align-items:flex-start;
          gap:4px;
          min-height:82px;
          text-align:left;
        }
        #view-lead-lists .lead-tile-btn.selected {
          border-color:#d59a3e;
          background:#fff6e6;
          color:#8a4b00;
        }
        #view-lead-lists .lead-tile-btn.pulled {
          border-color:#7fcf9b;
          background:#eefbf2;
        }
        #view-lead-lists .lead-tile-btn.saturated {
          border-color:#efae73;
          background:#fff0e2;
        }
        #view-lead-lists .lead-territory-stats {
          display:grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap:12px;
        }
        #view-lead-lists .lead-stat-card {
          border:1px solid #e5e5e5;
          border-radius:12px;
          padding:12px;
          background:#fff;
        }
        #view-lead-lists .lead-stat-label {
          font-size:11px;
          font-weight:900;
          color:#888;
          text-transform:uppercase;
          letter-spacing:.4px;
        }
        #view-lead-lists .lead-stat-value {
          margin-top:6px;
          font-size:18px;
          font-weight:900;
        }
        #view-lead-lists .lead-territory-panel[hidden] { display:none !important; }
        @media (max-width: 1180px) {
          #view-lead-lists .lead-two-col { grid-template-columns: 1fr; }
          #view-lead-lists .lead-scroll-body { max-height: none; }
        }
      </style>

      <div class="header-bar">
        <h1>Lists</h1>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn-secondary" id="leadOpenTerritoryBtn" style="display:none; padding:7px 10px; font-size:12px; background:transparent; border:none; color:#8a4b00; text-decoration:underline;">Territory Builder</button>
          <button class="btn-secondary" id="leadGenerateDailyBtn" style="display:none; padding:7px 12px; font-size:12px;">Generate Daily Calls</button>
          <button class="btn-secondary" id="leadGenerateFollowupBtn" style="display:none; padding:7px 12px; font-size:12px;">Generate Follow-up Lists</button>
          <button class="btn-secondary" id="leadCreateManualBtn" style="display:none; padding:7px 12px; font-size:12px;">Create Manual List</button>
          <button class="btn-secondary" id="leadListsRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>

      <div id="leadBusyState" style="display:none; align-items:center; gap:10px; background:#fff3df; border:1px solid #f1d1a3; color:#8a4b00; border-radius:12px; padding:12px 14px; margin-bottom:18px; font-size:13px; font-weight:800;"></div>

      <div class="panel-card" id="leadAssignedDashboardPanel" style="margin-bottom:18px;">
        <div style="font-size:12px; font-weight:900; letter-spacing:.4px; text-transform:uppercase; color:#777;">Assigned Dashboard</div>
        <div style="margin-top:10px; color:#555;">Salespeople export only the lists assigned to them. Exporting marks the list as exported and records who did it.</div>
        <div id="leadAssignedLists" style="margin-top:16px;">Loading...</div>
      </div>

      <div id="leadManagerPanel" style="display:none;"></div>
    `;
    host.appendChild(wrap);
  }

  function extendMarkup(){
    const wrap = document.getElementById('view-lead-lists');
    if (!wrap || document.getElementById('leadTerritoryPanel')) return;
    wrap.insertAdjacentHTML('beforeend', `
      <div class="panel-card lead-territory-panel" id="leadTerritoryPanel" hidden style="margin-bottom:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-size:12px; font-weight:900; letter-spacing:.4px; text-transform:uppercase; color:#777;">Territory Builder</div>
            <div style="margin-top:6px; color:#555;">Pull territory businesses directly in the CRM, filter them, and create lead lists grouped by region.</div>
          </div>
          <button class="btn-secondary" id="leadCloseTerritoryBtn"><i class="fas fa-chevron-up"></i> Hide Builder</button>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-top:18px;">
          <div><input id="leadTerritoryName" class="lead-input" type="text" placeholder="Territory name"></div>
          <div><input id="leadTerritoryChunkSize" class="lead-input" type="number" min="0" value="250" placeholder="Max leads per list"></div>
          <div><input id="leadTerritorySearchType" class="lead-input" type="text" placeholder="Search type"></div>
          <div><input id="leadTerritoryTileMiles" class="lead-input" type="number" min="0.1" step="0.1" placeholder="Tile miles"></div>
          <div><input id="leadTerritoryCenterLat" class="lead-input" type="number" step="0.0001" placeholder="Center latitude"></div>
          <div><input id="leadTerritoryCenterLng" class="lead-input" type="number" step="0.0001" placeholder="Center longitude"></div>
          <div><input id="leadTerritoryExtent" class="lead-input" type="number" min="0" max="12" step="1" placeholder="Grid extent"></div>
          <div><input id="leadTerritoryDetailBatchSize" class="lead-input" type="number" min="1" max="500" value="100" placeholder="Detail batch size"></div>
        </div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
          <button class="btn-secondary" id="leadTerritoryBuildBtn">Build Grid</button>
          <button class="btn-secondary" id="leadTerritorySelectAllBtn">Select All Tiles</button>
          <button class="btn-secondary" id="leadTerritoryClearBtn">Clear Selection</button>
          <button class="btn-primary" id="leadTerritoryPullBtn">Pull Selected Tiles</button>
          <button class="btn-secondary" id="leadTerritoryReloadBtn">Reload Territory Businesses</button>
        </div>

        <div class="lead-territory-stats" style="margin-top:14px;">
          <div class="lead-stat-card"><div class="lead-stat-label">Selected Tiles</div><div class="lead-stat-value" id="leadTerritorySelectedCount">0</div></div>
          <div class="lead-stat-card"><div class="lead-stat-label">Estimated Cost</div><div class="lead-stat-value" id="leadTerritoryCost">$0.00 - $0.00</div></div>
          <div class="lead-stat-card"><div class="lead-stat-label">Raw Businesses</div><div class="lead-stat-value" id="leadTerritoryRawCount">0</div></div>
          <div class="lead-stat-card"><div class="lead-stat-label">Filtered Results</div><div class="lead-stat-value" id="leadTerritoryFilteredCount">0</div></div>
        </div>

        <div id="leadTerritoryGrid" class="lead-territory-grid" style="margin-top:16px;"></div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-top:18px;">
          <div><input id="leadTerritorySearch" class="lead-input" type="text" placeholder="Search preview by company/address"></div>
          <div><input id="leadTerritoryInclude" class="lead-input" type="text" placeholder="Include keywords (comma-separated)"></div>
          <div><input id="leadTerritoryExclude" class="lead-input" type="text" placeholder="Exclude keywords (comma-separated)"></div>
          <div><input id="leadTerritoryTypes" class="lead-input" type="text" placeholder="Require Google types (comma-separated)"></div>
          <div>
            <select id="leadTerritoryIncludeMode" class="lead-select">
              <option value="any">Match any include keyword</option>
              <option value="all">Match all include keywords</option>
            </select>
          </div>
          <div>
            <select id="leadTerritoryScope" class="lead-select">
              <option value="current">Current territory only</option>
              <option value="all">All pulled tiles</option>
            </select>
          </div>
          <div><input id="leadTerritoryMinRating" class="lead-input" type="number" min="0" max="5" step="0.1" value="0" placeholder="Min rating"></div>
          <div><input id="leadTerritoryMinReviews" class="lead-input" type="number" min="0" step="1" value="0" placeholder="Min reviews"></div>
          <div>
            <select id="leadTerritoryState" class="lead-select">
              <option value="">All states</option>
            </select>
          </div>
          <div><input id="leadTerritoryZip" class="lead-input" type="text" placeholder="Zip codes (comma-separated)"></div>
          <div>
            <select id="leadTerritoryDetailFilter" class="lead-select">
              <option value="all">All detail states</option>
              <option value="detailed">Detailed only</option>
              <option value="not_detailed">Missing details only</option>
            </select>
          </div>
          <div>
            <select id="leadTerritoryOperational" class="lead-select">
              <option value="all">All business statuses</option>
              <option value="operational">Operational only</option>
            </select>
          </div>
          <div><input id="leadTerritoryWeightKey" class="lead-input" type="number" min="0" step="1" value="60" placeholder="Keyword weight"></div>
          <div><input id="leadTerritoryWeightRating" class="lead-input" type="number" min="0" step="1" value="20" placeholder="Rating weight"></div>
          <div><input id="leadTerritoryWeightReviews" class="lead-input" type="number" min="0" step="1" value="20" placeholder="Review weight"></div>
        </div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
          <button class="btn-secondary" id="leadTerritoryApplyFiltersBtn">Apply Filters</button>
          <button class="btn-secondary" id="leadTerritoryFetchDetailsBtn">Fetch Missing Details</button>
          <button class="btn-primary" id="leadTerritoryCreateBtn">Create Territory Lead Lists</button>
        </div>

        <div id="leadTerritorySummary" style="margin-top:14px; color:#555;">Build a grid, pull tiles, and apply filters to preview businesses here.</div>
        <div class="lead-table-wrap" style="margin-top:12px;">
          <table class="lead-territory-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>State</th>
                <th>Rating</th>
                <th>Reviews</th>
                <th>Detail</th>
                <th>Address</th>
              </tr>
            </thead>
            <tbody id="leadTerritoryResultsBody">
              <tr><td colspan="6" style="color:#999; padding:14px;">No territory results yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="lead-two-col" style="margin-bottom:18px;">
        <div class="panel-card lead-scroll-panel">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
            <div>
              <div style="font-size:12px; font-weight:900; letter-spacing:.4px; text-transform:uppercase; color:#777;">List Management</div>
              <div style="margin-top:6px; color:#555;">View all current lists and the leads stored inside them.</div>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
              <select id="leadListAssignmentFilter" class="lead-select" style="min-width:180px; max-width:220px; display:none;">
                <option value="all">All Lists</option>
                <option value="unassigned">Unassigned Only</option>
                <option value="assigned">Assigned Only</option>
              </select>
              <button class="btn-secondary" id="leadDistributeUnassignedInlineBtn" style="display:none;">Distribute Unassigned</button>
              <input id="leadListSearch" type="text" placeholder="Search lists..." class="lead-input" style="min-width:240px; max-width:320px;">
            </div>
          </div>
          <div class="lead-scroll-body" style="margin-top:16px;">
            <div id="leadListsSummary">Loading...</div>
          </div>
        </div>

        <div class="panel-card lead-scroll-panel">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
            <div>
              <div style="font-size:12px; font-weight:900; letter-spacing:.4px; text-transform:uppercase; color:#777;">Selected List</div>
              <div id="leadSelectedListMeta" style="margin-top:6px; color:#555;">Choose a list to inspect its leads.</div>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="btn-secondary" id="leadExportSelectedBtn" disabled onclick="window.LeadLists && window.LeadLists.exportList(window.LeadListsCurrentId || ''); return false;"><i class="fas fa-file-csv"></i> Export CSV</button>
              <button class="btn-secondary" id="leadAssignSelectedOpenBtn" style="display:none;"><i class="fas fa-user-tag"></i> Assign</button>
              <button class="btn-danger" id="leadDeleteSelectedBtn" style="display:none;"><i class="fas fa-trash"></i> Delete List</button>
            </div>
            </div>
            <div id="leadSelectedListStats" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-top:14px;"></div>
            <div id="leadManualLeadEntry" style="display:none; margin-top:16px;"></div>
            <div class="lead-scroll-body" style="margin-top:16px;">
              <div id="leadSelectedLeads" style="color:#777;">No list selected.</div>
            </div>
          </div>
        </div>

      <iframe id="leadDownloadFrame" name="leadDownloadFrame" style="display:none;"></iframe>

      <div class="modal-overlay" id="leadAssignModal">
        <div class="modal-card" style="width:min(760px, 94vw); max-height:85vh;">
          <div class="modal-header">
            <h2 id="leadAssignModalTitle">Assign Lists</h2>
            <button id="leadAssignModalClose" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body">
            <div id="leadAssignModalText" style="color:#555; margin-bottom:14px;"></div>
            <div id="leadAssignModalButtons" class="lead-toggle-group"></div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" id="leadAssignModalCancel">Cancel</button>
            <button class="btn-primary" id="leadAssignModalConfirm">Confirm</button>
          </div>
        </div>
      </div>

      <div class="modal-overlay" id="leadActionModal">
        <div class="modal-card" style="width:min(560px, 94vw); max-height:85vh;">
          <div class="modal-header">
            <h2 id="leadActionModalTitle">Lead Action</h2>
            <button id="leadActionModalClose" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body">
            <div id="leadActionModalText" style="color:#555; margin-bottom:14px;"></div>

            <div id="leadActionDailyFields" style="display:none;">
              <label style="display:block; font-size:12px; font-weight:800; color:#666; margin-bottom:6px;">Max leads per generated list</label>
              <input id="leadActionChunkSize" class="lead-input" type="number" min="1" max="5000" value="100" style="width:100%;">
            </div>

            <div id="leadActionManualFields" style="display:none;">
              <div style="display:grid; gap:12px;">
                <div>
                  <label style="display:block; font-size:12px; font-weight:800; color:#666; margin-bottom:6px;">List name</label>
                  <input id="leadActionManualName" class="lead-input" type="text" placeholder="List name" style="width:100%;">
                </div>
                <div>
                  <label style="display:block; font-size:12px; font-weight:800; color:#666; margin-bottom:6px;">Region / state</label>
                  <input id="leadActionManualRegion" class="lead-input" type="text" placeholder="Region / state" style="width:100%;">
                </div>
                <div>
                  <label style="display:block; font-size:12px; font-weight:800; color:#666; margin-bottom:6px;">Description</label>
                  <textarea id="leadActionManualDescription" class="lead-input" rows="4" placeholder="Optional description" style="width:100%; resize:vertical;"></textarea>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" id="leadActionModalCancel">Cancel</button>
            <button class="btn-primary" id="leadActionModalConfirm">Continue</button>
          </div>
        </div>
      </div>
    `);
  }

  function openAssignModal(mode){
    const title = document.getElementById('leadAssignModalTitle');
    const text = document.getElementById('leadAssignModalText');
    const host = document.getElementById('leadAssignModalButtons');
    if (!title || !text || !host) return;

    state.assignModalMode = mode;
    state.assignModalSelected = [];
    state.assignModalSingle = state.selectedList?.assigned_to_email || '';

    if (mode === 'distribute') {
      title.textContent = 'Distribute Unassigned Lists';
      text.textContent = 'Choose the salespeople who should receive the current unassigned lists. They will be distributed as evenly as possible.';
      host.innerHTML = state.salesUsers.map(u => `
        <button type="button" class="lead-toggle-btn lead-assign-choice" data-email="${esc(u.email)}">${esc(u.name)} (${esc(u.email)})</button>
      `).join('');
    } else {
      title.textContent = 'Assign Selected List';
      text.textContent = state.selectedList ? `Choose who should own "${state.selectedList.name}".` : 'Choose who should own this list.';
      host.innerHTML = `
        <button type="button" class="lead-toggle-btn lead-assign-choice ${state.assignModalSingle === '' ? 'active' : ''}" data-email="">Unassigned</button>
        ${state.salesUsers.map(u => `
          <button type="button" class="lead-toggle-btn lead-assign-choice ${state.assignModalSingle === u.email ? 'active' : ''}" data-email="${esc(u.email)}">${esc(u.name)} (${esc(u.email)})</button>
        `).join('')}
      `;
    }

    Portal.openModal('leadAssignModal');
  }

  function closeAssignModal(){
    state.assignModalMode = '';
    state.assignModalSelected = [];
    state.assignModalSingle = '';
    Portal.closeModal('leadAssignModal');
  }

  function openActionModal(mode){
    state.actionModalMode = mode;
    const title = document.getElementById('leadActionModalTitle');
    const text = document.getElementById('leadActionModalText');
    const daily = document.getElementById('leadActionDailyFields');
    const manual = document.getElementById('leadActionManualFields');
    const confirm = document.getElementById('leadActionModalConfirm');
    if (!title || !text || !daily || !manual || !confirm) return;

    daily.style.display = 'none';
    manual.style.display = 'none';

    if (mode === 'daily') {
      title.textContent = 'Generate Daily Calls';
      text.textContent = 'Create daily customer-call lists for the current user or, if you are a manager, across the sales workflow.';
      daily.style.display = 'block';
      document.getElementById('leadActionChunkSize').value = '100';
      confirm.textContent = 'Generate';
    } else if (mode === 'followup') {
      title.textContent = 'Generate Follow-up Lists';
      text.textContent = 'Create follow-up lists from all currently due follow-ups for the current user.';
      daily.style.display = 'block';
      document.getElementById('leadActionChunkSize').value = '100';
      confirm.textContent = 'Generate';
    } else {
      title.textContent = 'Create Manual List';
      text.textContent = 'Create a new manual lead list.';
      manual.style.display = 'block';
      document.getElementById('leadActionManualName').value = '';
      document.getElementById('leadActionManualRegion').value = '';
      document.getElementById('leadActionManualDescription').value = '';
      confirm.textContent = 'Create List';
    }

    Portal.openModal('leadActionModal');
  }

  function closeActionModal(){
    state.actionModalMode = '';
    Portal.closeModal('leadActionModal');
  }

  function handleAssignChoice(btn){
    const email = btn.getAttribute('data-email') || '';
    if (state.assignModalMode === 'distribute') {
      const idx = state.assignModalSelected.indexOf(email);
      if (idx >= 0) state.assignModalSelected.splice(idx, 1);
      else state.assignModalSelected.push(email);
      btn.classList.toggle('active', state.assignModalSelected.includes(email));
      return;
    }
    state.assignModalSingle = email;
    Portal.qsa('.lead-assign-choice', document.getElementById('leadAssignModalButtons')).forEach(el => {
      el.classList.toggle('active', (el.getAttribute('data-email') || '') === email);
    });
  }

  function renderDashboard(){
    const host = document.getElementById('leadAssignedLists');
    if (!host) return;
    if (isManager()) {
      host.innerHTML = '';
      return;
    }
    if (!state.dashboard.length) {
      host.innerHTML = '<div style="color:#999; font-style:italic;">No assigned lead lists yet.</div>';
      return;
    }
    host.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>List</th>
            <th>Type</th>
            <th>Region</th>
            <th>Leads</th>
            <th>Exported</th>
            <th style="text-align:right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${state.dashboard.map(row => `
            <tr>
              <td><button type="button" class="link-btn lead-open-list" data-list-id="${esc(row.id)}">${esc(row.name)}</button></td>
              <td>${esc(row.type || 'manual')}</td>
              <td>${esc(row.region_code || row.region || '-')}</td>
              <td>${Number(row.lead_count || 0)}</td>
              <td>${row.exported_at ? `${fmtTs(row.exported_at)} by ${esc(row.exported_by_email || '')}` : '<span style="color:#999;">Not exported</span>'}</td>
              <td style="text-align:right;"><button class="btn-primary lead-dashboard-export" data-list-id="${esc(row.id)}" onclick="window.LeadLists && window.LeadLists.exportList('${esc(row.id)}'); return false;">Export</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderListSummary(){
    const host = document.getElementById('leadListsSummary');
    if (!host) return;
    const q = (document.getElementById('leadListSearch')?.value || '').trim().toLowerCase();
    const assignmentFilter = document.getElementById('leadListAssignmentFilter')?.value || 'all';
    const rows = state.lists.filter(row => {
      if (assignmentFilter === 'unassigned' && row.assigned_to_email) return false;
      if (assignmentFilter === 'assigned' && !row.assigned_to_email) return false;
      return !q || [row.name, row.region, row.region_code, row.assigned_to_email, row.type].join(' ').toLowerCase().includes(q);
    });
    if (!rows.length) {
      host.innerHTML = '<div style="color:#999; font-style:italic;">No lists match the current filter.</div>';
      return;
    }
    host.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Region</th>
            <th>Assigned</th>
            <th>Leads</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr class="lead-list-row" data-list-id="${esc(row.id)}" style="cursor:pointer; ${row.id === state.selectedListId ? 'background:#fff6e8;' : ''}">
              <td><b>${esc(row.name)}</b></td>
              <td>${esc(row.type || 'manual')}</td>
              <td>${esc(row.region_code || row.region || '-')}</td>
              <td>${esc(row.assigned_to_email || '-')}</td>
              <td>${Number(row.lead_count || row.computed_lead_count || 0)}</td>
              <td>${fmtTs(row.updated_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderSelectedList(){
      const meta = document.getElementById('leadSelectedListMeta');
      const stats = document.getElementById('leadSelectedListStats');
      const manualEntry = document.getElementById('leadManualLeadEntry');
      const host = document.getElementById('leadSelectedLeads');
      const exportBtn = document.getElementById('leadExportSelectedBtn');
      const assignBtn = document.getElementById('leadAssignSelectedOpenBtn');
      const deleteBtn = document.getElementById('leadDeleteSelectedBtn');
      const list = state.selectedList;
      if (!meta || !stats || !manualEntry || !host || !exportBtn || !assignBtn || !deleteBtn) return;

      if (!list) {
        window.LeadListsCurrentId = '';
        meta.innerHTML = 'Choose a list to inspect its leads.';
        stats.innerHTML = '';
        manualEntry.style.display = 'none';
        manualEntry.innerHTML = '';
        host.innerHTML = '<div style="color:#777;">No list selected.</div>';
        exportBtn.disabled = true;
        assignBtn.style.display = 'none';
        deleteBtn.style.display = 'none';
        return;
    }

    meta.innerHTML = `
      <b>${esc(list.name)}</b> | ${esc(list.type || 'manual')} | ${esc(list.region_code || list.region || '-')}
      | Assigned to ${esc(list.assigned_to_email || 'unassigned')}
      | Updated ${fmtTs(list.updated_at)}
    `;
    stats.innerHTML = `
      <div class="lead-stat-card"><div class="lead-stat-label">Lead Count</div><div class="lead-stat-value">${Number(list.lead_count || list.computed_lead_count || state.selectedLeads.length || 0)}</div></div>
      <div class="lead-stat-card"><div class="lead-stat-label">Export Status</div><div class="lead-stat-value" style="font-size:14px;">${list.exported_at ? 'Exported' : 'Not Exported'}</div></div>
      <div class="lead-stat-card"><div class="lead-stat-label">Exported By</div><div class="lead-stat-value" style="font-size:14px;">${esc(list.exported_by_email || '-')}</div></div>
      <div class="lead-stat-card"><div class="lead-stat-label">Exported At</div><div class="lead-stat-value" style="font-size:14px;">${fmtTs(list.exported_at)}</div></div>
      <div class="lead-stat-card"><div class="lead-stat-label">Export Count</div><div class="lead-stat-value" style="font-size:14px;">${Number(list.exported_count || 0)}</div></div>
      <div class="lead-stat-card"><div class="lead-stat-label">Last Export</div><div class="lead-stat-value" style="font-size:13px;">${state.selectedExportHistory[0] ? `${fmtTs(state.selectedExportHistory[0].exported_at)} by ${esc(state.selectedExportHistory[0].exported_by_email || '')}` : 'None yet'}</div></div>
    `;
    const mine = (cfg().user?.email || '').toLowerCase() === String(list.assigned_to_email || '').toLowerCase();
    const manager = isManager();
      exportBtn.disabled = false;
      exportBtn.style.opacity = (manager || mine || !list.assigned_to_email) ? '1' : '.7';
      assignBtn.style.display = isManager() ? 'inline-flex' : 'none';
      deleteBtn.style.display = isManager() ? 'inline-flex' : 'none';
      if ((list.type || 'manual') === 'manual') {
        manualEntry.style.display = 'block';
        manualEntry.innerHTML = `
          <div class="panel-card" style="padding:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
              <div>
                <div style="font-size:12px; font-weight:900; letter-spacing:.4px; text-transform:uppercase; color:#777;">Add Manual Lead</div>
                <div style="margin-top:4px; color:#666; font-size:13px;">Custom phone, email, notes, and names for manual lists only.</div>
              </div>
              <button class="btn-primary" type="button" id="leadSaveManualLeadBtn"><i class="fas fa-plus"></i> Add Lead</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin-top:14px;">
              <input id="leadManualLeadCompany" class="lead-input" type="text" placeholder="Company name">
              <input id="leadManualLeadName" class="lead-input" type="text" placeholder="Name">
              <input id="leadManualLeadPhone" class="lead-input" type="text" placeholder="Phone">
              <input id="leadManualLeadEmail" class="lead-input" type="email" placeholder="Email">
              <input id="leadManualLeadWebsite" class="lead-input" type="text" placeholder="Website">
              <input id="leadManualLeadAddress" class="lead-input" type="text" placeholder="Address">
            </div>
            <textarea id="leadManualLeadNotes" class="lead-input" rows="3" placeholder="Notes" style="width:100%; resize:vertical; margin-top:12px;"></textarea>
          </div>
        `;
      } else {
        manualEntry.style.display = 'none';
        manualEntry.innerHTML = '';
      }

      if (!state.selectedLeads.length) {
        host.innerHTML = '<div style="color:#999; font-style:italic;">This list has no leads yet.</div>';
        return;
      }
    const leadFilters = state.selectedLeadFilters || { q:'', status:'', assigned_to_email:'' };
    const assignedOptions = Array.from(new Set(
      state.selectedLeads
        .map(row => String(row.assigned_to_email || '').trim())
        .filter(Boolean)
    )).sort();
    host.innerHTML = `
      <div style="display:grid; grid-template-columns:minmax(0,1.6fr) minmax(180px,.7fr) minmax(220px,.8fr); gap:10px; margin-bottom:12px;">
        <input id="leadSelectedSearch" class="lead-input" type="text" placeholder="Search company, phone, email, website..." value="${esc(leadFilters.q || '')}">
        <select id="leadSelectedStageFilter" class="lead-input">
          <option value="">All Stages</option>
          ${Object.entries({
            new: 'New',
            contacted: 'Contacted',
            info_sent: 'Info Sent',
            info_received: 'Info Received',
            signed_up: 'Signed Up',
            active_customer: 'Active Customer',
            lost: 'Lost',
            do_not_contact: 'Do Not Contact'
          }).map(([value, label]) => `<option value="${esc(value)}" ${leadFilters.status === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <select id="leadSelectedAssignedFilter" class="lead-input">
          <option value="">All Assigned Reps</option>
          ${assignedOptions.map(email => `<option value="${esc(email)}" ${leadFilters.assigned_to_email === email ? 'selected' : ''}>${esc(email)}</option>`).join('')}
        </select>
      </div>
      <div class="lead-table-wrap">
        <table class="lead-list-detail-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Stage</th>
              <th>Assigned</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Website</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            ${state.selectedLeads.map(row => `
              <tr>
                <td><b>${esc(row.company || '')}</b></td>
                <td>${esc(row.status || '-')}</td>
                <td>${esc(row.assigned_to_email || '-')}</td>
                <td>${esc(row.phone || '-')}</td>
                <td>${esc(row.email || '-')}</td>
                <td>${row.website ? `<a href="${esc(row.website)}" target="_blank" rel="noopener">${esc(row.website)}</a>` : '-'}</td>
                <td>${esc(row.address || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function territoryReadInputs(){
    const next = {
      center_lat: parseFloat(document.getElementById('leadTerritoryCenterLat')?.value || state.territory.config.center_lat || 0),
      center_lng: parseFloat(document.getElementById('leadTerritoryCenterLng')?.value || state.territory.config.center_lng || 0),
      tile_side_miles: parseFloat(document.getElementById('leadTerritoryTileMiles')?.value || state.territory.config.tile_side_miles || 1),
      search_type: (document.getElementById('leadTerritorySearchType')?.value || state.territory.config.search_type || 'roofing_contractor').trim(),
      extent: parseInt(document.getElementById('leadTerritoryExtent')?.value || state.territory.config.extent || 2, 10)
    };
    if (!Number.isFinite(next.center_lat)) next.center_lat = 47.6062;
    if (!Number.isFinite(next.center_lng)) next.center_lng = -122.3321;
    if (!Number.isFinite(next.tile_side_miles) || next.tile_side_miles <= 0) next.tile_side_miles = 1;
    if (!Number.isFinite(next.extent) || next.extent < 0) next.extent = 2;
    if (!next.search_type) next.search_type = 'roofing_contractor';
    state.territory.config = next;
    return next;
  }

  function territoryApplyInputs(){
    const c = state.territory.config;
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    set('leadTerritorySearchType', c.search_type || 'roofing_contractor');
    set('leadTerritoryTileMiles', c.tile_side_miles ?? 1);
    set('leadTerritoryCenterLat', c.center_lat ?? 47.6062);
    set('leadTerritoryCenterLng', c.center_lng ?? -122.3321);
    set('leadTerritoryExtent', c.extent ?? 2);
  }

  function territoryTileMath(){
    const c = state.territory.config;
    const sKm = c.tile_side_miles * MI2KM;
    const dLat = sKm / KM_PER_DEG_LAT;
    const safeCos = Math.max(Math.cos(c.center_lat * Math.PI / 180), 0.2);
    const dLng = sKm / (KM_PER_DEG_LAT * safeCos);
    const extent = c.extent;
    const gridRows = extent * 2 + 1;
    const gridCols = extent * 2 + 1;
    const centerGridRow = Math.round(c.center_lat / dLat);
    const centerGridCol = Math.round(c.center_lng / dLng);
    const originLat = (centerGridRow - extent) * dLat;
    const originLng = (centerGridCol - extent) * dLng;
    return { dLat, dLng, originLat, originLng, gridRows, gridCols };
  }

  function territoryTileKey(row, col){
    const math = territoryTileMath();
    const absRow = Math.round(math.originLat / math.dLat) + row;
    const absCol = Math.round(math.originLng / math.dLng) + col;
    return `${absRow}_${absCol}`;
  }

  function territoryTileCenterByLocal(row, col){
    const math = territoryTileMath();
    const south = math.originLat + row * math.dLat;
    const north = south + math.dLat;
    const west = math.originLng + col * math.dLng;
    const east = west + math.dLng;
    return { lat: (south + north) / 2, lng: (west + east) / 2 };
  }

  function territoryTileRadiusMeters(){
    return (state.territory.config.tile_side_miles * MI2KM * Math.SQRT2 / 2) * 1000;
  }

  function territoryCurrentGridKeys(){
    const math = territoryTileMath();
    const keys = [];
    for (let row = 0; row < math.gridRows; row++) {
      for (let col = 0; col < math.gridCols; col++) {
        keys.push(territoryTileKey(row, col));
      }
    }
    return keys;
  }

  function territorySelectedTileKeys(){
    return Object.keys(state.territory.selectedTiles);
  }

  function territoryUpdateStats(){
    const selected = territorySelectedTileKeys().length;
    const minCalls = selected;
    const maxCalls = selected * 3;
    const rawCount = state.territory.rawBusinesses.length;
    const filteredCount = state.territory.filteredBusinesses.length;
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    setText('leadTerritorySelectedCount', String(selected));
    setText('leadTerritoryCost', `$${(minCalls * PRICE_NEARBY).toFixed(2)} - $${(maxCalls * PRICE_NEARBY).toFixed(2)}`);
    setText('leadTerritoryRawCount', String(rawCount));
    setText('leadTerritoryFilteredCount', String(filteredCount));
  }

  function renderTerritoryGrid(){
    const host = document.getElementById('leadTerritoryGrid');
    if (!host) return;
    const math = territoryTileMath();
    const tiles = [];
    for (let row = 0; row < math.gridRows; row++) {
      for (let col = 0; col < math.gridCols; col++) {
        const key = territoryTileKey(row, col);
        const info = state.territory.tileStatus[key];
        const selected = !!state.territory.selectedTiles[key];
        const pulled = !!info;
        const saturated = pulled && Number(info.result_count || 0) >= 60;
        tiles.push(`
          <button type="button" class="lead-tile-btn ${selected ? 'selected' : ''} ${pulled ? 'pulled' : ''} ${saturated ? 'saturated' : ''}" data-territory-tile="${esc(key)}" data-territory-row="${row}" data-territory-col="${col}">
            <span>${esc(key)}</span>
            <span style="font-size:11px; color:#777;">${pulled ? `${Number(info.result_count || 0)} results` : 'Not pulled'}</span>
            <span style="font-size:11px; color:#777;">${saturated ? 'Saturated' : (pulled ? 'Loaded' : 'Selectable')}</span>
          </button>
        `);
      }
    }
    host.innerHTML = tiles.join('');
    territoryUpdateStats();
  }

  function territoryToggleTile(key){
    if (!key) return;
    if (state.territory.selectedTiles[key]) delete state.territory.selectedTiles[key];
    else state.territory.selectedTiles[key] = true;
    renderTerritoryGrid();
  }

  function parseStateZip(str){
    if (!str) return { state: '', zip: '' };
    const upper = String(str).toUpperCase();
    const zipMatch = upper.match(/\b(\d{5})(?:-\d{4})?\b/);
    const stateMatch = upper.match(/\b([A-Z]{2})\b/);
    const stateAbbrs = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
    return {
      state: stateMatch && stateAbbrs.includes(stateMatch[1]) ? stateMatch[1] : '',
      zip: zipMatch ? zipMatch[1] : ''
    };
  }

  function territoryFilterValues(){
    const get = id => document.getElementById(id);
    return {
      q: (get('leadTerritorySearch')?.value || '').trim().toLowerCase(),
      include: (get('leadTerritoryInclude')?.value || '').trim().toLowerCase(),
      exclude: (get('leadTerritoryExclude')?.value || '').trim().toLowerCase(),
      types: (get('leadTerritoryTypes')?.value || '').trim().toLowerCase(),
      includeMode: get('leadTerritoryIncludeMode')?.value || 'any',
      scope: get('leadTerritoryScope')?.value || 'current',
      minRating: parseFloat(get('leadTerritoryMinRating')?.value || '0') || 0,
      minReviews: parseInt(get('leadTerritoryMinReviews')?.value || '0', 10) || 0,
      state: get('leadTerritoryState')?.value || '',
      zip: (get('leadTerritoryZip')?.value || '').trim(),
      detailFilter: get('leadTerritoryDetailFilter')?.value || 'all',
      operational: get('leadTerritoryOperational')?.value || 'all',
      wKey: parseInt(get('leadTerritoryWeightKey')?.value || '60', 10) || 0,
      wRating: parseInt(get('leadTerritoryWeightRating')?.value || '20', 10) || 0,
      wReviews: parseInt(get('leadTerritoryWeightReviews')?.value || '20', 10) || 0
    };
  }

  function renderTerritoryStateOptions(){
    const sel = document.getElementById('leadTerritoryState');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">All states</option>' + state.territory.derivedStates.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    sel.value = current;
  }

  function territoryApplyFilters(){
    const filters = territoryFilterValues();
    const includeWords = filters.include.split(',').map(s => s.trim()).filter(Boolean);
    const excludeWords = filters.exclude.split(',').map(s => s.trim()).filter(Boolean);
    const reqTypes = filters.types.split(',').map(s => s.trim()).filter(Boolean);
    const zipCodes = filters.zip.split(',').map(s => s.trim()).filter(Boolean);
    const currentKeys = new Set(territoryCurrentGridKeys());
    let maxReviews = 1;
    state.territory.rawBusinesses.forEach(b => {
      maxReviews = Math.max(maxReviews, Number(b.user_ratings_total || 0));
    });

    const weightSum = filters.wKey + filters.wRating + filters.wReviews || 1;
    const next = [];
    state.territory.rawBusinesses.forEach(b => {
      const stateCode = b._state || '';
      const zip = b._zip || '';
      const company = String(b.name || '').toLowerCase();
      const address = String(b.vicinity || '').toLowerCase();
      const hay = `${company} ${address}`;
      const types = Array.isArray(b.types) ? b.types.map(t => String(t).toLowerCase()) : [];
      const rating = Number(b.rating || 0);
      const reviews = Number(b.user_ratings_total || 0);
      const detailed = !!b._detailed;

      if (filters.scope === 'current' && !currentKeys.has(String(b._tile || ''))) return;
      if (filters.q && !hay.includes(filters.q)) return;
      if (filters.operational === 'operational' && String(b.business_status || '').toUpperCase() !== 'OPERATIONAL') return;
      if (filters.minRating && rating < filters.minRating) return;
      if (filters.minReviews && reviews < filters.minReviews) return;
      if (filters.state && stateCode !== filters.state) return;
      if (zipCodes.length && (!zip || !zipCodes.includes(zip))) return;
      if (filters.detailFilter === 'detailed' && !detailed) return;
      if (filters.detailFilter === 'not_detailed' && detailed) return;
      if (excludeWords.some(word => hay.includes(word))) return;
      if (reqTypes.length && !reqTypes.some(word => types.includes(word))) return;

      let keywordScore = 1;
      if (includeWords.length) {
        const matches = includeWords.filter(word => hay.includes(word));
        if (filters.includeMode === 'all' && matches.length < includeWords.length) return;
        if (filters.includeMode === 'any' && matches.length === 0) return;
        keywordScore = matches.length / includeWords.length;
      }

      const score = (
        keywordScore * (filters.wKey / weightSum) +
        (rating / 5) * (filters.wRating / weightSum) +
        Math.min(reviews / maxReviews, 1) * (filters.wReviews / weightSum)
      ) * 100;

      next.push({ ...b, _score: Math.round(score) });
    });

    next.sort((a, b) => {
      const scoreDiff = Number(b._score || 0) - Number(a._score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    state.territory.filteredBusinesses = next;
    renderTerritoryResults();
    territoryUpdateStats();
  }

  function renderTerritoryResults(){
    const host = document.getElementById('leadTerritoryResultsBody');
    const summary = document.getElementById('leadTerritorySummary');
    if (!host || !summary) return;
    const rows = state.territory.filteredBusinesses.slice(0, 250);
    const detailedCount = state.territory.filteredBusinesses.filter(row => row._detailed).length;
    summary.innerHTML = state.territory.filteredBusinesses.length
      ? `Showing <b>${state.territory.filteredBusinesses.length}</b> filtered businesses. <b>${detailedCount}</b> already have detailed place data ready for phone and website export.`
      : 'No businesses match the current territory filters yet.';
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="6" style="color:#999; padding:14px;">No territory results yet.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(row => `
      <tr>
        <td title="${esc(row.name || '')}"><b>${esc(row.name || '')}</b></td>
        <td>${esc(row._state || '-')}</td>
        <td>${row.rating ?? '-'}</td>
        <td>${row.user_ratings_total ?? '-'}</td>
        <td>${row._detailed ? 'Detailed' : 'Raw only'}</td>
        <td title="${esc(row.vicinity || '')}">${esc(row.vicinity || '-')}</td>
      </tr>
    `).join('');
  }

  async function territoryLoadSupport(){
    const [configData, tileData, rawData, detailData] = await Promise.all([
      fetcherApi('get_config').catch(() => ({})),
      fetcherApi('get_tile_status').catch(() => ({})),
      fetcherApi('get_raw_businesses').catch(() => ({})),
      fetcherApi('get_detail_index').catch(() => ({}))
    ]);

    if (configData.status === 'ok' && configData.config) {
      state.territory.config = {
        center_lat: Number(configData.config.center_lat || 47.6062),
        center_lng: Number(configData.config.center_lng || -122.3321),
        tile_side_miles: Number(configData.config.tile_side_miles || 1),
        search_type: String(configData.config.search_type || 'roofing_contractor'),
        extent: Number(document.getElementById('leadTerritoryExtent')?.value || state.territory.config.extent || 2)
      };
    }
    state.territory.tileStatus = tileData.status === 'ok' && tileData.tiles ? tileData.tiles : {};
    state.territory.detailIndex = detailData.status === 'ok' && detailData.index ? detailData.index : {};
    state.territory.rawBusinesses = Array.isArray(rawData.businesses) ? rawData.businesses.map(row => {
      const parsed = parseStateZip(row.vicinity || '');
      return {
        ...row,
        _state: parsed.state,
        _zip: parsed.zip,
        _detailed: !!state.territory.detailIndex[row.place_id]
      };
    }) : [];
    state.territory.derivedStates = Array.from(new Set(state.territory.rawBusinesses.map(row => row._state).filter(Boolean))).sort();
    territoryApplyInputs();
    renderTerritoryStateOptions();
    renderTerritoryGrid();
    territoryApplyFilters();
  }

  async function territoryBuildGrid(){
    const next = territoryReadInputs();
    await fetcherApi('save_config', {
      center_lat: next.center_lat,
      center_lng: next.center_lng,
      tile_side_miles: next.tile_side_miles,
      search_type: next.search_type
    }).catch(() => ({}));
    renderTerritoryGrid();
    territoryApplyFilters();
  }

  async function territoryPullSelected(){
    const keys = territorySelectedTileKeys();
    if (!keys.length) return alert('Select one or more territory tiles first.');
    const next = territoryReadInputs();
    const math = territoryTileMath();
    setBusy(`Pulling ${keys.length} territory tile${keys.length === 1 ? '' : 's'}...`);
    setButtonBusy('leadTerritoryPullBtn', true, 'Pulling...');
    for (const key of keys) {
      const parts = key.split('_');
      const absRow = Number(parts[0]);
      const absCol = Number(parts[1]);
      if (!Number.isFinite(absRow) || !Number.isFinite(absCol)) continue;
      const row = absRow - Math.round(math.originLat / math.dLat);
      const col = absCol - Math.round(math.originLng / math.dLng);
      const center = territoryTileCenterByLocal(row, col);
      const response = await fetcherApi('pull_tile', {
        tile_key: key,
        center_lat: center.lat,
        center_lng: center.lng,
        radius_meters: territoryTileRadiusMeters(),
        search_type: next.search_type,
        tile_side_miles: next.tile_side_miles
      }).catch(() => ({}));
      if (response.status === 'ok' && response.result) {
        state.territory.tileStatus[key] = response.result;
      }
    }
    state.territory.selectedTiles = {};
    setBusy('');
    setButtonBusy('leadTerritoryPullBtn', false);
    await territoryLoadSupport();
  }

  async function territoryReloadBusinesses(){
    setBusy('Reloading territory businesses...');
    await territoryLoadSupport();
    setBusy('');
  }

  async function territoryFetchMissingDetails(){
    const ids = state.territory.filteredBusinesses.map(row => row.place_id).filter(id => id && !state.territory.detailIndex[id]);
    if (!ids.length) return alert('All filtered territory businesses already have details.');
    const batchSize = Math.max(1, Math.min(500, parseInt(document.getElementById('leadTerritoryDetailBatchSize')?.value || '100', 10) || 100));
    setBusy(`Fetching missing place details for ${Math.min(ids.length, batchSize)} territory businesses...`);
    setButtonBusy('leadTerritoryFetchDetailsBtn', true, 'Fetching...');
    const response = await fetcherApi('pull_details_batch', {
      place_ids: ids.slice(0, batchSize)
    }).catch(() => ({}));
    setBusy('');
    setButtonBusy('leadTerritoryFetchDetailsBtn', false);
    if (response.status !== 'ok') return alert(response.message || 'Could not fetch territory details.');
    await territoryLoadSupport();
    alert(`Fetched ${Number(response.fetched || 0)} detailed place records.`);
  }

  async function territoryCreateLists(){
    const territoryName = (document.getElementById('leadTerritoryName')?.value || '').trim();
    if (!territoryName) return alert('Enter a territory name first.');
    const placeIds = state.territory.filteredBusinesses.map(row => row.place_id).filter(Boolean);
    if (!placeIds.length) return alert('No filtered territory businesses are ready to save.');
    const chunkSize = document.getElementById('leadTerritoryChunkSize')?.value || '250';
    const filterValues = territoryFilterValues();
    const builderConfig = {
      ...state.territory.config,
      current_tile_keys: territoryCurrentGridKeys()
    };
    setBusy(`Creating territory lead lists from ${placeIds.length} businesses...`);
    setButtonBusy('leadTerritoryCreateBtn', true, 'Creating...');
    const data = await api({
      action: 'lead_create_territory_lists',
      territory_name: territoryName,
      chunk_size: chunkSize,
      place_ids_json: JSON.stringify(placeIds),
      filter_json: JSON.stringify(filterValues),
      builder_config_json: JSON.stringify(builderConfig)
    }).catch(() => ({}));
    setBusy('');
    setButtonBusy('leadTerritoryCreateBtn', false);
    if (!data.success) return alert(data.error || 'Could not create territory lead lists.');
    await refreshLists();
    await refreshDashboard();
    if (Array.isArray(data.lists) && data.lists[0]?.id) await openList(data.lists[0].id);
    alert(`Created ${Array.isArray(data.lists) ? data.lists.length : 0} list(s) from ${Number(data.selected_count || 0)} territory businesses. ${Number(data.detailed_count || 0)} already had detail data.`);
  }

  async function loadSupportData(){
    const usersData = await api({ action: 'lead_sales_users' }).catch(() => ({ users: [] }));
    state.salesUsers = Array.isArray(usersData.users) ? usersData.users : [];
  }

  async function refreshDashboard(){
    if (isManager()) {
      state.dashboard = [];
      renderDashboard();
      return;
    }
    const data = await api({ action: 'lead_dashboard' }).catch(() => ({}));
    state.dashboard = Array.isArray(data.lists) ? data.lists : [];
    renderDashboard();
  }

  async function refreshLists(){
    const data = await api({ action: 'lead_list_list', only_mine: onlyMineMode() ? '1' : '0' }).catch(() => ({}));
    state.lists = Array.isArray(data.lists) ? data.lists : [];
    if (state.selectedListId && !state.lists.find(row => row.id === state.selectedListId)) {
      state.selectedListId = '';
      state.selectedList = null;
      state.selectedLeads = [];
      state.selectedExportHistory = [];
    }
    renderListSummary();
  }

  async function openList(listId){
    if (!listId) return;
    state.selectedListId = listId;
    state.selectedLeadFilters = { q: '', status: '', assigned_to_email: '' };
    window.LeadListsCurrentId = listId;
    setBusy('Loading selected list...');
    const [listData, exportData] = await Promise.all([
      api({ action: 'lead_list_get', id: listId }).catch(() => ({})),
      api({ action: 'lead_export_history', list_id: listId }).catch(() => ({}))
    ]);
    state.selectedList = listData.list || null;
    state.selectedExportHistory = Array.isArray(exportData.exports) ? exportData.exports : [];
    await loadSelectedListLeads();
    renderListSummary();
    renderSelectedList();
    setBusy('');
  }

  async function loadSelectedListLeads(){
    if (!state.selectedListId) {
      state.selectedLeads = [];
      return;
    }
    const filters = state.selectedLeadFilters || {};
    const data = await api({
      action: 'lead_list_leads',
      list_id: state.selectedListId,
      limit: 500,
      q: filters.q || '',
      status: filters.status || '',
      assigned_to_email: filters.assigned_to_email || ''
    }).catch(() => ({}));
    state.selectedLeads = Array.isArray(data.leads) ? data.leads : [];
  }

  async function exportList(listId){
    if (!listId) return alert('Choose a list to export first.');
    const list = state.selectedListId === listId
      ? state.selectedList
      : state.lists.find(row => row.id === listId) || state.dashboard.find(row => row.id === listId) || null;
    const manager = isManager();
    const myEmail = String(cfg().user?.email || '').toLowerCase();
    const assignedTo = String(list?.assigned_to_email || '').toLowerCase();
    if (!manager && !assignedTo) return alert('This list is unassigned. A manager needs to assign it before a salesperson can export it.');
    if (!manager && assignedTo !== myEmail) return alert(`Only the assigned salesperson can export this list.\n\nAssigned to: ${list?.assigned_to_email || 'Unknown'}`);
    setBusy('Exporting CSV and recording export history...');
    setButtonBusy('leadExportSelectedBtn', true, 'Exporting...');
    try {
      const filters = state.selectedLeadFilters || {};
      const hasFilters = !!(String(filters.q || '').trim() || String(filters.status || '').trim() || String(filters.assigned_to_email || '').trim());
      if (hasFilters && state.selectedListId === listId) {
        submitLeadSelectionCsv(state.selectedLeads.map(row => row.id));
      } else {
        submitCsvDownload(listId);
      }
    } catch (err) {
      setBusy('');
      setButtonBusy('leadExportSelectedBtn', false);
      return alert(err?.message || 'Could not export list.');
    }
    window.setTimeout(async () => {
      await refreshDashboard();
      await refreshLists();
      if (state.selectedListId === listId) await openList(listId);
      setBusy('');
      setButtonBusy('leadExportSelectedBtn', false);
    }, 1200);
  }

  async function createManualList(){
      const name = (document.getElementById('leadActionManualName')?.value || '').trim();
      if (!name) return alert('Enter a list name first.');
      const region = (document.getElementById('leadActionManualRegion')?.value || '').trim();
      const description = (document.getElementById('leadActionManualDescription')?.value || '').trim();
    const data = await api({
      action: 'lead_list_save',
      name,
      region,
      description,
      type: 'manual'
    }).catch(() => ({}));
    if (!data.success) return alert(data.error || 'Could not create list.');
    closeActionModal();
    await refreshLists();
      await refreshDashboard();
      await openList(data.id);
    }

    async function addManualLead(){
      const list = state.selectedList;
      if (!list || (list.type || 'manual') !== 'manual') return alert('Choose a manual list first.');
      const company = (document.getElementById('leadManualLeadCompany')?.value || '').trim();
      if (!company) return alert('Enter a company name first.');
      const leadName = (document.getElementById('leadManualLeadName')?.value || '').trim();
      const phone = (document.getElementById('leadManualLeadPhone')?.value || '').trim();
      const email = (document.getElementById('leadManualLeadEmail')?.value || '').trim();
      const website = (document.getElementById('leadManualLeadWebsite')?.value || '').trim();
      const address = (document.getElementById('leadManualLeadAddress')?.value || '').trim();
      const notes = (document.getElementById('leadManualLeadNotes')?.value || '').trim();
      setBusy('Adding manual lead...');
      const data = await api({
        action: 'lead_save',
        list_id: list.id,
        company,
        lead_name: leadName,
        phone,
        email,
        website,
        address,
        notes,
        source: 'manual_entry'
      }).catch(() => ({}));
      setBusy('');
      if (!data.success) return alert(data.error || 'Could not add manual lead.');
      ['leadManualLeadCompany', 'leadManualLeadName', 'leadManualLeadPhone', 'leadManualLeadEmail', 'leadManualLeadWebsite', 'leadManualLeadAddress', 'leadManualLeadNotes'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      await openList(list.id);
    }

  async function assignSelectedList(){
    if (!state.selectedListId) return alert('Choose a list first.');
    setBusy('Updating list assignment...');
    const data = await api({
      action: 'lead_assign_list',
      list_id: state.selectedListId,
      assigned_to_email: state.assignModalSingle || ''
    }).catch(() => ({}));
    setBusy('');
    if (!data.success) return alert(data.error || 'Could not assign list.');
    closeAssignModal();
    await refreshLists();
    await refreshDashboard();
    await openList(state.selectedListId);
  }

  async function distributeUnassigned(){
    const csv = state.assignModalSelected.join(',');
    if (!csv) return alert('Select at least one salesperson first.');
    setBusy('Distributing unassigned lists...');
    const data = await api({
      action: 'lead_distribute_unassigned',
      assigned_emails_csv: csv
    }).catch(() => ({}));
    setBusy('');
    if (!data.success) return alert(data.error || 'Could not distribute unassigned lists.');
    closeAssignModal();
    alert(`Assigned ${Number(data.assigned_count || 0)} list(s).`);
    await refreshLists();
    await refreshDashboard();
  }

  async function generateDaily(){
    const chunkSize = document.getElementById('leadActionChunkSize')?.value || '100';
    if (!String(chunkSize).trim()) return;
    setBusy('Generating daily customer call lists...');
    setButtonBusy('leadGenerateDailyBtn', true, 'Generating...');
    const data = await api({
      action: 'lead_generate_daily_lists',
      chunk_size: chunkSize
    }).catch(() => ({}));
    setBusy('');
    setButtonBusy('leadGenerateDailyBtn', false);
    if (!data.success) return alert(data.error || 'Could not generate daily lists.');
    closeActionModal();
    alert(`Generated ${Array.isArray(data.lists) ? data.lists.length : 0} list(s) from ${Number(data.candidate_count || 0)} customers.`);
    await refreshLists();
    await refreshDashboard();
  }

  async function generateFollowups(){
    const chunkSize = document.getElementById('leadActionChunkSize')?.value || '100';
    if (!String(chunkSize).trim()) return;
    setBusy('Generating follow-up lead lists...');
    setButtonBusy('leadGenerateFollowupBtn', true, 'Generating...');
    const data = await api({
      action: 'lead_generate_followup_lists',
      chunk_size: chunkSize
    }).catch(() => ({}));
    setBusy('');
    setButtonBusy('leadGenerateFollowupBtn', false);
    if (!data.success) return alert(data.error || 'Could not generate follow-up lists.');
    closeActionModal();
    alert(`Generated ${Array.isArray(data.lists) ? data.lists.length : 0} follow-up list(s) from ${Number(data.candidate_count || 0)} due follow-ups.`);
    await refreshLists();
    await refreshDashboard();
  }

  async function deleteSelected(){
    if (!state.selectedListId) return;
    if (!confirm('Delete this lead list and all leads inside it?')) return;
    const data = await api({ action: 'lead_list_delete', id: state.selectedListId }).catch(() => ({}));
    if (!data.success) return alert(data.error || 'Could not delete list.');
    state.selectedListId = '';
    state.selectedList = null;
    state.selectedLeads = [];
    state.selectedExportHistory = [];
    renderSelectedList();
    await refreshLists();
    await refreshDashboard();
  }

  async function refreshAll(){
    const manager = isManager();
    document.getElementById('leadManagerPanel')?.style.setProperty('display', manager ? 'block' : 'none');
    document.getElementById('leadOpenTerritoryBtn')?.style.setProperty('display', manager ? 'inline-flex' : 'none');
    document.getElementById('leadGenerateDailyBtn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('leadGenerateFollowupBtn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('leadCreateManualBtn')?.style.setProperty('display', manager ? 'inline-flex' : 'none');
    document.getElementById('leadAssignedDashboardPanel')?.style.setProperty('display', manager ? 'none' : 'block');
    document.getElementById('leadListAssignmentFilter')?.style.setProperty('display', manager ? 'block' : 'none');
    document.getElementById('leadDistributeUnassignedInlineBtn')?.style.setProperty('display', manager ? 'inline-flex' : 'none');
    document.getElementById('leadTerritoryPanel')?.setAttribute('hidden', 'hidden');
    await loadSupportData();
    await refreshDashboard();
    await refreshLists();
    if (manager) await territoryLoadSupport();
    renderSelectedList();
  }

  ensureMarkup();
  extendMarkup();
  window.LeadLists = { exportList, openList };
  Portal.registerPlugin({ id: 'lead-lists', title: 'Lists', iconClass: 'fas fa-list-check' });

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('leadListsRefreshBtn')?.addEventListener('click', refreshAll);
    document.getElementById('leadOpenTerritoryBtn')?.addEventListener('click', () => Portal.switchView('territory-builder'));
    document.getElementById('leadCloseTerritoryBtn')?.addEventListener('click', () => document.getElementById('leadTerritoryPanel')?.setAttribute('hidden', 'hidden'));
    document.getElementById('leadCreateManualBtn')?.addEventListener('click', () => openActionModal('manual'));
    document.getElementById('leadGenerateDailyBtn')?.addEventListener('click', () => openActionModal('daily'));
    document.getElementById('leadGenerateFollowupBtn')?.addEventListener('click', () => openActionModal('followup'));
    document.getElementById('leadListSearch')?.addEventListener('input', renderListSummary);
    document.getElementById('leadListAssignmentFilter')?.addEventListener('change', renderListSummary);
    document.getElementById('leadExportSelectedBtn')?.addEventListener('click', () => exportList(state.selectedListId));
    document.getElementById('leadAssignSelectedOpenBtn')?.addEventListener('click', () => openAssignModal('single'));
    document.getElementById('leadDeleteSelectedBtn')?.addEventListener('click', deleteSelected);
    document.getElementById('leadAssignModalClose')?.addEventListener('click', closeAssignModal);
    document.getElementById('leadAssignModalCancel')?.addEventListener('click', closeAssignModal);
    document.getElementById('leadAssignModalConfirm')?.addEventListener('click', () => {
      if (state.assignModalMode === 'distribute') distributeUnassigned();
      else assignSelectedList();
    });
    document.getElementById('leadActionModalClose')?.addEventListener('click', closeActionModal);
    document.getElementById('leadActionModalCancel')?.addEventListener('click', closeActionModal);
    document.getElementById('leadActionModalConfirm')?.addEventListener('click', () => {
      if (state.actionModalMode === 'daily') generateDaily();
      else if (state.actionModalMode === 'followup') generateFollowups();
      else createManualList();
    });
    document.getElementById('leadTerritoryBuildBtn')?.addEventListener('click', territoryBuildGrid);
    document.getElementById('leadTerritorySelectAllBtn')?.addEventListener('click', () => {
      state.territory.selectedTiles = {};
      territoryCurrentGridKeys().forEach(key => { state.territory.selectedTiles[key] = true; });
      renderTerritoryGrid();
    });
    document.getElementById('leadTerritoryClearBtn')?.addEventListener('click', () => {
      state.territory.selectedTiles = {};
      renderTerritoryGrid();
    });
    document.getElementById('leadTerritoryPullBtn')?.addEventListener('click', territoryPullSelected);
    document.getElementById('leadTerritoryReloadBtn')?.addEventListener('click', territoryReloadBusinesses);
    document.getElementById('leadTerritoryApplyFiltersBtn')?.addEventListener('click', territoryApplyFilters);
    document.getElementById('leadTerritoryFetchDetailsBtn')?.addEventListener('click', territoryFetchMissingDetails);
    document.getElementById('leadTerritoryCreateBtn')?.addEventListener('click', territoryCreateLists);
    [
      'leadTerritorySearch', 'leadTerritoryInclude', 'leadTerritoryExclude', 'leadTerritoryTypes',
      'leadTerritoryMinRating', 'leadTerritoryMinReviews', 'leadTerritoryState', 'leadTerritoryZip',
      'leadTerritoryDetailFilter', 'leadTerritoryOperational', 'leadTerritoryScope',
      'leadTerritoryIncludeMode', 'leadTerritoryWeightKey', 'leadTerritoryWeightRating', 'leadTerritoryWeightReviews'
    ].forEach(id => {
      document.getElementById(id)?.addEventListener('input', territoryApplyFilters);
      document.getElementById(id)?.addEventListener('change', territoryApplyFilters);
    });
    document.addEventListener('input', (ev) => {
      const search = ev.target.closest('#leadSelectedSearch');
      if (!search) return;
      state.selectedLeadFilters.q = search.value || '';
      clearTimeout(state._selectedLeadFilterTimer);
      state._selectedLeadFilterTimer = setTimeout(async () => {
        setBusy('Filtering selected list...');
        await loadSelectedListLeads();
        renderSelectedList();
        setBusy('');
      }, 180);
    });
    document.addEventListener('change', async (ev) => {
      const stage = ev.target.closest('#leadSelectedStageFilter');
      if (stage) {
        state.selectedLeadFilters.status = stage.value || '';
        setBusy('Filtering selected list...');
        await loadSelectedListLeads();
        renderSelectedList();
        setBusy('');
        return;
      }
      const assigned = ev.target.closest('#leadSelectedAssignedFilter');
      if (assigned) {
        state.selectedLeadFilters.assigned_to_email = assigned.value || '';
        setBusy('Filtering selected list...');
        await loadSelectedListLeads();
        renderSelectedList();
        setBusy('');
      }
    });
    document.addEventListener('click', (ev) => {
      const assignChoice = ev.target.closest('.lead-assign-choice');
      if (assignChoice) return void handleAssignChoice(assignChoice);
      const addManualLeadBtn = ev.target.closest('#leadSaveManualLeadBtn');
      if (addManualLeadBtn) return void addManualLead();
      const openBtn = ev.target.closest('.lead-open-list, .lead-list-row');
      if (openBtn) return void openList(openBtn.getAttribute('data-list-id'));
      const exportBtn = ev.target.closest('.lead-dashboard-export');
      if (exportBtn) return void exportList(exportBtn.getAttribute('data-list-id'));
      const distributeBtn = ev.target.closest('#leadDistributeUnassignedInlineBtn');
      if (distributeBtn) return void openAssignModal('distribute');
      const tileBtn = ev.target.closest('[data-territory-tile]');
      if (tileBtn) return void territoryToggleTile(tileBtn.getAttribute('data-territory-tile') || '');
    });
  });

  const origSwitch = Portal.switchView ? Portal.switchView.bind(Portal) : null;
  if (origSwitch) {
    Portal.switchView = async function(id, btn){
      await origSwitch(id, btn);
      if (id === 'lead-lists') await refreshAll();
    };
  }
})();
