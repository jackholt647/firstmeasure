/* portal_scripts/users.js
 * Users module for the portal user manager.
 *
 * Permission controls are rendered from permission_options.json on the PHP side
 * and exposed to the frontend through cfg().permission_model.
 */

(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;
  const USER_DEBUG_KEY = '__fmUsersDiagnostics';
  const ALL_USERS_TEAM_SCOPE = '__all_users__';
  const userDebugState = window[USER_DEBUG_KEY] || {
    bootedAt: Date.now(),
    seq: 0,
    events: [],
    activeFetchId: 0
  };
  window[USER_DEBUG_KEY] = userDebugState;

  function diag(event, data = {}, level = 'log'){
    const entry = {
      seq: ++userDebugState.seq,
      t: new Date().toISOString(),
      ms: Date.now() - userDebugState.bootedAt,
      event,
      ...data
    };
    userDebugState.events.push(entry);
    if (userDebugState.events.length > 250) userDebugState.events.shift();
    const fn = console[level] || console.log;
    fn.call(console, `[UsersDiag #${entry.seq} +${entry.ms}ms] ${event}`, data);
    return entry;
  }

  function diagCounts(users){
    const rows = Array.isArray(users) ? users : [];
    const counts = {
      total: rows.length,
      visible: 0,
      disabled: 0,
      customer: 0,
      hidden_untrained_unscheduled: 0,
      training_complete: 0,
      scheduled: 0,
      roles: {},
      departments: {}
    };
    rows.forEach(user => {
      const role = String(user?.role || '(blank)').toLowerCase();
      const department = String(user?.department || '(blank)').toLowerCase();
      counts.roles[role] = (counts.roles[role] || 0) + 1;
      counts.departments[department] = (counts.departments[department] || 0) + 1;
      const disabled = user?.disabled === true || String(user?.status || '').toLowerCase() === 'disabled';
      const customer = String(user?.account_type || 'employee').toLowerCase() === 'customer';
      const trained = !!user?.training_complete;
      const scheduled = hasShiftScheduleBlocks(user);
      if (disabled) counts.disabled += 1;
      if (customer) counts.customer += 1;
      if (trained) counts.training_complete += 1;
      if (scheduled) counts.scheduled += 1;
      if (isVisibleTeamUser(user)) counts.visible += 1;
      else if (!disabled && !customer && !trained && !scheduled) counts.hidden_untrained_unscheduled += 1;
    });
    return counts;
  }

  const internalApiBase = () => {
    const endpoints = (cfg() && cfg().endpoints) || {};
    if (endpoints.internal) return String(endpoints.internal).replace(/\/+$/, '');
    if (endpoints.firstmeasure) return String(endpoints.firstmeasure).replace(/\/firstmeasure\/?$/, '/internal').replace(/\/+$/, '');
    if (endpoints.server) return String(endpoints.server).replace(/\/legacy-action\/?$/, '').replace(/\/+$/, '');
    if (endpoints.portal) return String(endpoints.portal).replace(/\/legacy-action\/?$/, '').replace(/\/+$/, '');
    return `${location.origin}/v1/internal`;
  };

  async function internalJson(path, options = {}){
    const method = options.method || 'GET';
    const url = `${internalApiBase()}${path}`;
    const requestId = `${method}:${path}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    const started = performance.now();
    const timeoutMs = Number(options.timeoutMs || 0) || 0;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timeoutTimer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const headers = { ...(options.headers || {}) };
    const init = { method, credentials:'include', headers };
    // These endpoints are mutable admin state. A cached GET can otherwise
    // resurrect the pre-save roster until the browser performs a hard reload.
    if (method === 'GET') init.cache = 'no-store';
    if (controller) init.signal = controller.signal;
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers['Content-Type'] = 'application/json';
    }
    diag('request:start', {
      requestId,
      method,
      path,
      url,
      timeoutMs,
      hasBody: options.body !== undefined,
      bodyKeys: options.body && typeof options.body === 'object' ? Object.keys(options.body) : []
    });
    let res;
    let raw;
    try {
      res = await fetch(url, init);
      raw = await res.text();
    } catch(fetchErr) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      diag('request:network-error', {
        requestId,
        method,
        path,
        url,
        ms: Math.round(performance.now() - started),
        error: fetchErr?.name + ': ' + fetchErr?.message
      }, 'error');
      throw fetchErr;
    }
    if (timeoutTimer) clearTimeout(timeoutTimer);
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch(parseErr) {
      diag('request:parse-error', {
        requestId,
        path,
        status: res.status,
        statusText: res.statusText,
        ms: Math.round(performance.now() - started),
        bodyStart: raw.slice(0, 600)
      }, 'error');
      const err = new Error(`Non-JSON response from ${path} (${res.status} ${res.statusText})`);
      err.cause = parseErr;
      throw err;
    }
    diag('request:done', {
      requestId,
      method,
      path,
      status: res.status,
      ok: res.ok,
      ms: Math.round(performance.now() - started),
      bytes: raw.length,
      success: data.success,
      okField: data.ok,
      users: Array.isArray(data.users) ? data.users.length : undefined,
      count: data.count
    }, res.ok ? 'log' : 'warn');
    if (!res.ok || data.success === false || data.ok === false) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return data;
  }

  function currentUserEmail(){
    return String(cfg()?.user?.email || '').trim().toLowerCase();
  }

  function isStrictAdmin(){
    const portalCfg = cfg() || {};
    const user = portalCfg.user || {};
    const perms = portalCfg.perms || {};
    return String(user.role || '').toLowerCase() === 'admin'
      || user.is_admin === true
      || perms.is_admin_legacy === true;
  }

  async function postBackendLoginAction(action, fields = {}){
    const started = performance.now();
    const body = new FormData();
    body.append('action', action);
    Object.entries(fields).forEach(([key, value]) => body.append(key, value == null ? '' : String(value)));
    diag('backendLoginAction:start', { action, fields: Object.keys(fields) });
    const res = await fetch('backend_login.php', {
      method: 'POST',
      credentials: 'include',
      body
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      diag('backendLoginAction:parse-error', {
        action,
        status: res.status,
        ms: Math.round(performance.now() - started),
        bodyStart: text.slice(0, 500)
      }, 'error');
      throw new Error(`Non-JSON response from backend_login.php (${res.status})`);
    }
    diag('backendLoginAction:done', {
      action,
      status: res.status,
      ok: res.ok,
      success: data.success,
      ms: Math.round(performance.now() - started)
    }, res.ok ? 'log' : 'warn');
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Action failed (${res.status})`);
    }
    return data;
  }

  function hasShiftScheduleBlocks(user){
    const schedule = (user && typeof user.shift_schedule === 'object') ? user.shift_schedule : {};
    const recurring = (schedule.recurring && typeof schedule.recurring === 'object') ? schedule.recurring : {};
    const hasRecurring = Object.values(recurring).some(blocks => Array.isArray(blocks) && blocks.length > 0);
    const overrides = (schedule.overrides && typeof schedule.overrides === 'object') ? schedule.overrides : {};
    return hasRecurring || Object.keys(overrides).length > 0;
  }

  function isVisibleTeamUser(user){
    if (!user || user.disabled === true || String(user.status || '').toLowerCase() === 'disabled') return false;
    if (String(user.account_type || 'employee').toLowerCase() === 'customer') return false;
    return !!user.training_complete || hasShiftScheduleBlocks(user);
  }

  function normalizedTeamId(value){
    const id = String(value || '').trim();
    return id.toLowerCase() === 'default' ? '' : id;
  }

  function isManagedUser(user){
    if (!user || user.disabled === true || String(user.status || '').toLowerCase() === 'disabled') return false;
    return String(user.account_type || 'employee').toLowerCase() !== 'customer';
  }

  const FALLBACK_ROLE_PRESETS = [
    { value:'admin', label:'Admin', icon:'fa-user-shield', color:'#d93025', department:'production', training_complete:true, permissions:{} },
    { value:'manager', label:'Manager', icon:'fa-user-tie', color:'#7b1fa2', department:'production', training_complete:true, permissions:{ view_all_projects:true, view_team_projects:true, manage_queue:true, manage_qa_queue:true, shift_view:'all', shift_edit:'none' } },
    { value:'qa', label:'QA', icon:'fa-clipboard-check', color:'#e37400', department:'production', training_complete:true, permissions:{ view_team_projects:true, manage_qa:true, shift_view:'all', shift_edit:'none' } },
    { value:'technician', label:'Technician', icon:'fa-drafting-compass', color:'#1a73e8', department:'production', training_complete:true, permissions:{ shift_view:'all', shift_edit:'none' } },
    { value:'sales_manager', label:'Sales Manager', icon:'fa-chart-line', color:'#0b8043', department:'sales', training_complete:true, permissions:{ manage_sales_users:true, manage_tutorials:true, shift_view:'none', shift_edit:'none' } },
    { value:'salesperson', label:'Salesperson', icon:'fa-handshake', color:'#00897b', department:'sales', training_complete:true, permissions:{ shift_view:'none', shift_edit:'none' } },
    { value:'trainee', label:'Trainee', icon:'fa-user-graduate', color:'#5f6368', department:'production', training_complete:false, permissions:{ shift_view:'none', shift_edit:'none' } }
  ];

  const DOM_TO_SERVER = {
    view_all: 'view_all_projects',
    view_team: 'view_team_projects',
    admin_legacy: 'is_admin_legacy'
  };
  const SERVER_TO_DOM = {};
  Object.entries(DOM_TO_SERVER).forEach(([dom, srv]) => { SERVER_TO_DOM[srv] = dom; });

  function domToServer(domSuffix){ return DOM_TO_SERVER[domSuffix] || domSuffix; }
  function serverToDom(serverKey){ return SERVER_TO_DOM[serverKey] || serverKey; }

  function permissionModel(){
    return (cfg() && cfg().permission_model && typeof cfg().permission_model === 'object')
      ? cfg().permission_model
      : {};
  }

  const Users = {
    allUsers: [],
    teams: [],
    lastFetchError: null,
    selectedTeamId: ALL_USERS_TEAM_SCOPE,
    searchTerm: '',
    sortKey: 'name',
    sortDir: 'asc',
    modalUser: null,
    savingUser: false,

    init(){
      diag('init', {
        href: location.href,
        internalApiBase: internalApiBase(),
        endpoints: (cfg() && cfg().endpoints) || {},
        flags: (cfg() && cfg().flags) || {},
        user: {
          email: cfg()?.user?.email,
          role: cfg()?.user?.role,
          account_type: cfg()?.user?.account_type
        }
      });
      window.fetchUsers = () => this.fetchUsers();
      window.openUserModal = (mode, user) => this.openUserModal(mode, user || null);
      window.applyPreset = (role) => this.applyPreset(role);
      window.saveUser = () => this.saveUser();
      window.deleteUser = () => this.deleteUser();
      window.impersonateInternalUser = () => this.impersonateSelectedUser();
      window.stopInternalImpersonation = () => this.stopImpersonation();
      window.openTeamModal = (mode) => this.openTeamModal(mode || 'create');
      window.saveTeam = () => this.saveTeam();
      window.dumpUsersDiagnostics = () => this.debugDump();

      this._buildRoleUI();
      this._buildSegmentedControls();
      this._wirePriorityEligibilityControls();
      this._wireUserListUI();
      this._renderImpersonationBanner();
      diag('init:complete', {
        rolePresetCount: this.rolePresets().length,
        checkboxCount: this.permCheckboxes().length,
        selectCount: this.permSelects().length,
        hasUsersTable: !!document.getElementById('usersTable')
      });
    },

    _renderImpersonationBanner(){
      const state = cfg()?.impersonation || {};
      if (!state.active) return;
      if (document.getElementById('internalImpersonationBanner')) return;
      const banner = document.createElement('div');
      banner.id = 'internalImpersonationBanner';
      banner.style.cssText = [
        'position:fixed', 'right:18px', 'bottom:18px', 'z-index:9999',
        'display:flex', 'align-items:center', 'gap:12px',
        'max-width:min(520px, calc(100vw - 36px))', 'padding:12px 14px',
        'background:#202124', 'color:#fff', 'border-radius:8px',
        'box-shadow:0 12px 30px rgba(0,0,0,.24)', 'font-size:13px'
      ].join(';') + ';';
      const admin = state.admin_email ? ` from ${Portal.escapeHtml(state.admin_email)}` : '';
      banner.innerHTML = `
        <div style="font-weight:800; line-height:1.35;">
          Impersonating ${Portal.escapeHtml(currentUserEmail() || 'internal user')}${admin}
        </div>
        <button type="button" class="btn-secondary btn-sm" onclick="stopInternalImpersonation()" style="background:#fff; color:#202124; border-color:#fff; white-space:nowrap;">Stop</button>
      `;
      document.body.appendChild(banner);
    },

    rolePresets(){
      const roles = permissionModel().roles;
      return Array.isArray(roles) && roles.length ? roles : FALLBACK_ROLE_PRESETS;
    },

    rolePreset(role){
      return this.rolePresets().find(r => r.value === role) || null;
    },

    defaultCreateRole(){
      const modelDefault = String(permissionModel().default_create_role || '').trim();
      if (modelDefault) return modelDefault;
      return (cfg().flags && cfg().flags.is_sales_portal) ? 'salesperson' : 'trainee';
    },

    _wireUserListUI(){
      const search = document.getElementById('usersSearchInput');
      if (search && !search.dataset.wired) {
        search.dataset.wired = 'true';
        search.addEventListener('input', () => {
          this.searchTerm = String(search.value || '').trim().toLowerCase();
          this.renderUsersTable();
        });
      }

      const userForm = document.getElementById('userForm');
      if (userForm && !userForm.dataset.wired) {
        userForm.dataset.wired = 'true';
        userForm.addEventListener('submit', event => {
          event.preventDefault();
          this.saveUser();
        });
      }

      Portal.qsa('[data-user-sort]').forEach(th => {
        if (th.dataset.wired === 'true') return;
        th.dataset.wired = 'true';
        th.addEventListener('click', () => {
          const key = th.getAttribute('data-user-sort');
          if (!key) return;
          if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
          else {
            this.sortKey = key;
            this.sortDir = 'asc';
          }
          this.renderUsersTable();
        });
      });
    },

    _buildRoleUI(){
      const oldPresets = document.querySelector('#userModal .presets');
      if (oldPresets) {
        oldPresets.style.display = 'none';
        const prevSib = oldPresets.previousElementSibling;
        if (prevSib && prevSib.tagName === 'LABEL' && /preset/i.test(prevSib.textContent)) {
          prevSib.style.display = 'none';
        }
      }

      const trainCb = document.getElementById('uTrainingComplete');
      if (trainCb) {
        const trainRow = trainCb.closest('.form-row');
        if (trainRow) trainRow.style.display = 'none';
      }

      let container = document.getElementById('rolePresetBtns');
      if (!container) {
        container = document.createElement('div');
        container.id = 'rolePresetBtns';

        const form = document.getElementById('userForm');
        if (oldPresets && form) {
          const insertRef = oldPresets.previousElementSibling && /preset/i.test(oldPresets.previousElementSibling.textContent)
            ? oldPresets.previousElementSibling
            : oldPresets;
          form.insertBefore(container, insertRef);
        } else if (form) {
          const detailedLabel = Array.from(form.querySelectorAll('label'))
            .find(l => /detailed/i.test(l.textContent));
          form.insertBefore(container, detailedLabel || form.firstChild);
        }
      }

      container.style.cssText = [
        'display:flex', 'gap:8px', 'flex-wrap:wrap', 'align-items:center',
        'margin:0 0 20px', 'padding:14px 16px',
        'background:#f8f9fa', 'border:1px solid #eee', 'border-radius:10px'
      ].join(';') + ';';

      container.innerHTML = '<div style="width:100%; font-size:11px; font-weight:900; color:#555; margin-bottom:6px; text-transform:uppercase;">Role</div>';

      this.rolePresets().forEach(r => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'role-preset-btn';
        btn.dataset.role = r.value;
        btn.style.cssText = [
          'display:inline-flex', 'align-items:center', 'gap:6px',
          'font-weight:800', 'font-size:12px', 'padding:8px 16px',
          'border-radius:8px', 'cursor:pointer',
          'border:1.5px solid #dadce0', 'background:#fff', `color:${r.color || '#5f6368'}`,
          'transition:.15s', 'flex:0 0 auto'
        ].join(';') + ';';
        btn.innerHTML = `<i class="fas ${r.icon || 'fa-user'}" style="font-size:11px;"></i> ${r.label || r.value}`;
        btn.addEventListener('click', () => this.applyPreset(r.value));
        container.appendChild(btn);
      });
    },

    _highlightPresetBtn(role){
      document.querySelectorAll('.role-preset-btn').forEach(btn => {
        const isActive = btn.dataset.role === role;
        const preset = this.rolePreset(btn.dataset.role);
        const color = preset ? preset.color : '#5f6368';
        if (isActive) {
          btn.style.background = color + '14';
          btn.style.borderColor = color;
          btn.style.fontWeight = '900';
          btn.style.boxShadow = `0 0 0 1px ${color}44`;
        } else {
          btn.style.background = '#fff';
          btn.style.borderColor = '#dadce0';
          btn.style.fontWeight = '800';
          btn.style.boxShadow = 'none';
        }
      });
    },

    _makeSegmentedControl(id, options){
      const source = document.getElementById(id);
      if (!source || source.dataset.segmented === 'true') return null;
      source.dataset.segmented = 'true';
      source.classList.add('seg-hidden');
      const wrap = document.createElement('div');
      wrap.className = 'seg-control';
      wrap.dataset.for = id;
      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn';
        btn.dataset.value = opt.value;
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          source.value = opt.value;
          source.dispatchEvent(new Event('change', { bubbles: true }));
          this._syncSegmentedControl(id);
        });
        wrap.appendChild(btn);
      });
      source.insertAdjacentElement('afterend', wrap);
      source.addEventListener('change', () => this._syncSegmentedControl(id));
      this._syncSegmentedControl(id);
      return wrap;
    },

    _syncSegmentedControl(id){
      const source = document.getElementById(id);
      const wrap = document.querySelector(`.seg-control[data-for="${id}"]`);
      if (!source || !wrap) return;
      const value = String(source.value || '');
      wrap.querySelectorAll('.seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
      });
    },

    _syncAllSegmentedControls(){
      ['uDrafterRank', 'p_shift_view', 'p_shift_edit'].forEach(id => this._syncSegmentedControl(id));
    },

    _buildSegmentedControls(){
      const rankRow = document.getElementById('uDrafterRankRow');
      const productionSection = Array.from(document.querySelectorAll('.perm-section')).find(section => {
        const title = section.querySelector('.perm-section-title');
        return title && /production/i.test(title.textContent || '');
      });
      if (rankRow && productionSection && rankRow.parentElement !== productionSection) {
        rankRow.classList.add('perm-item', 'perm-item-select');
        rankRow.style.marginBottom = '0';
        const label = rankRow.querySelector('label');
        if (label) label.className = 'perm-control-label';
        const selectsGrid = productionSection.querySelector('.perm-grid-selects');
        if (selectsGrid) selectsGrid.insertBefore(rankRow, selectsGrid.firstChild);
        else productionSection.appendChild(rankRow);
      }
      this._makeSegmentedControl('uDrafterRank', [
        { value:'junior', label:'Junior' },
        { value:'standard', label:'Standard' },
        { value:'senior', label:'Senior' }
      ]);

      ['p_shift_view', 'p_shift_edit'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        const options = Array.from(select.options || []).map(opt => ({ value: opt.value, label: opt.textContent || opt.value }));
        this._makeSegmentedControl(id, options);
      });
    },

    _fallbackPriorityEligibility(priority){
      const rank = String(document.getElementById('uDrafterRank')?.value || 'junior').toLowerCase();
      if (priority === 'p1') return rank === 'senior' || rank === 'standard';
      return true;
    },

    _syncPriorityEligibilityControls(){
      const states = [];
      [['uP1Eligible', 'p1'], ['uP2Eligible', 'p2']].forEach(([id, priority]) => {
        const input = document.getElementById(id);
        if (!input) return;
        const explicit = input.dataset.explicit === 'true';
        if (!explicit) input.checked = this._fallbackPriorityEligibility(priority);
        states.push(`${priority.toUpperCase()}: ${explicit ? 'explicit' : 'rank fallback'}`);
      });
      const hint = document.getElementById('uPriorityEligibilityHint');
      if (hint) hint.textContent = `${states.join(' · ')}. Changing a switch makes that priority explicit.`;
    },

    _setPriorityEligibility(user){
      [['uP1Eligible', 'p1_eligible'], ['uP2Eligible', 'p2_eligible']].forEach(([id, key]) => {
        const input = document.getElementById(id);
        if (!input) return;
        const explicit = !!user && typeof user[key] === 'boolean';
        input.dataset.explicit = explicit ? 'true' : 'false';
        if (explicit) input.checked = user[key];
      });
      this._syncPriorityEligibilityControls();
    },

    _wirePriorityEligibilityControls(){
      ['uP1Eligible', 'uP2Eligible'].forEach(id => {
        const input = document.getElementById(id);
        if (!input || input.dataset.eligibilityWired === 'true') return;
        input.dataset.eligibilityWired = 'true';
        input.addEventListener('change', () => {
          input.dataset.explicit = 'true';
          this._syncPriorityEligibilityControls();
        });
      });
      document.getElementById('uDrafterRank')?.addEventListener('change', () => this._syncPriorityEligibilityControls());
    },

    userDepartment(user){
      const raw = String(user?.department || '').trim().toLowerCase();
      return raw === 'sales' ? 'sales' : 'production';
    },

    departmentLabel(dept){
      return dept === 'sales' ? 'Sales' : 'Production';
    },

    roleInfoForUser(user){
      return this.rolePreset(String(user?.role || '').toLowerCase());
    },

    drafterRank(user){
      const rank = String(user?.drafter_rank || '').trim().toLowerCase();
      return ['junior', 'standard', 'senior'].includes(rank) ? rank : 'junior';
    },

    drafterRankLabel(user){
      const labels = { junior:'Junior', standard:'Standard', senior:'Senior' };
      return labels[this.drafterRank(user)] || 'Junior';
    },

    drafterRankColor(user){
      const colors = { junior:'#5f6368', standard:'#1a73e8', senior:'#7b1fa2' };
      return colors[this.drafterRank(user)] || '#5f6368';
    },

    showsDrafterRank(user){
      return this.userDepartment(user) === 'production';
    },

    teamById(teamId){
      const id = normalizedTeamId(teamId);
      return this.teams.find(team => team.id === id) || null;
    },

    teamName(teamId){
      const id = normalizedTeamId(teamId);
      if (!id) return 'No Team';
      return this.teamById(id)?.name || id;
    },

    teamOptionsHtml(selectedId){
      const selected = normalizedTeamId(selectedId);
      const options = [`<option value=""${selected === '' ? ' selected' : ''}>No Team</option>`];
      this.teams.forEach(team => {
        options.push(`<option value="${Portal.escapeHtml(team.id)}"${team.id === selected ? ' selected' : ''}>${Portal.escapeHtml(team.name)}</option>`);
      });
      return options.join('');
    },

    renderTeamControls(){
      const filter = document.getElementById('usersTeamFilter');
      if (!filter) return;
      const buttons = [
        { id:ALL_USERS_TEAM_SCOPE, name:'All Users' },
        { id:'', name:'No Team' },
        ...this.teams.map(team => ({ id:team.id, name:team.name }))
      ];
      filter.innerHTML = '';
      buttons.forEach(team => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `filter-btn${team.id === this.selectedTeamId ? ' active' : ''}`;
        button.dataset.userTeam = team.id;
        button.textContent = team.name;
        button.addEventListener('click', () => {
          this.selectedTeamId = team.id;
          this.renderTeamControls();
          this.renderUsersTable();
        });
        filter.appendChild(button);
      });
      const edit = document.getElementById('usersEditTeamBtn');
      if (edit) edit.style.display = this.selectedTeamId && this.selectedTeamId !== ALL_USERS_TEAM_SCOPE ? '' : 'none';
      this.populateUserTeamSelect();
    },

    renderTeamStats(){
      const members = this.selectedTeamId === ALL_USERS_TEAM_SCOPE
        ? this.allUsers
        : this.allUsers.filter(user => normalizedTeamId(user.team_id) === this.selectedTeamId);
      const roleCount = role => members.filter(user => String(user.role || '').toLowerCase() === role).length;
      const managerEl = document.getElementById('usersTeamManagerCount');
      const qaEl = document.getElementById('usersTeamQaCount');
      const technicianEl = document.getElementById('usersTeamTechnicianCount');
      if (managerEl) managerEl.textContent = String(roleCount('manager'));
      if (qaEl) qaEl.textContent = String(roleCount('qa'));
      if (technicianEl) technicianEl.textContent = String(roleCount('technician'));
    },

    populateUserTeamSelect(selectedId){
      const select = document.getElementById('uTeam');
      if (!select) return;
      const value = selectedId === undefined ? normalizedTeamId(select.value) : normalizedTeamId(selectedId);
      select.innerHTML = this.teamOptionsHtml(value);
    },

    sortValue(user, key){
      if (key === 'training_complete') return user?.training_complete ? 1 : 0;
      if (key === 'department') return this.userDepartment(user);
      if (key === 'drafter_rank') {
        const order = { junior: 1, standard: 2, senior: 3 };
        return this.showsDrafterRank(user) ? (order[this.drafterRank(user)] || 0) : 0;
      }
      return String(user?.[key] ?? '').toLowerCase();
    },

    filteredUsers(){
      const q = this.searchTerm;
      let rows = Array.isArray(this.allUsers) ? [...this.allUsers] : [];

      if (this.selectedTeamId !== ALL_USERS_TEAM_SCOPE) {
        rows = rows.filter(u => normalizedTeamId(u.team_id) === this.selectedTeamId);
      }

      if (q) {
        rows = rows.filter(u => {
          const hay = [
            u.name || '',
            u.email || '',
            u.role || '',
            this.showsDrafterRank(u) ? this.drafterRankLabel(u) : '',
            this.showsDrafterRank(u) ? this.drafterRank(u) : '',
            this.teamName(u.team_id),
            this.userDepartment(u)
          ].join(' ').toLowerCase();
          return hay.includes(q);
        });
      }

      rows.sort((a, b) => {
        const av = this.sortValue(a, this.sortKey);
        const bv = this.sortValue(b, this.sortKey);
        let cmp = 0;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        return this.sortDir === 'asc' ? cmp : -cmp;
      });

      return rows;
    },

    renderUsersTable(){
      const renderStarted = performance.now();
      const tb = document.getElementById('usersTable');
      if (!tb) {
        diag('render:missing-table', {}, 'warn');
        return;
      }

      const summary = document.getElementById('usersResultSummary');
      const rows = this.filteredUsers();
      const teamMemberCount = this.selectedTeamId === ALL_USERS_TEAM_SCOPE
        ? this.allUsers.length
        : this.allUsers.filter(user => normalizedTeamId(user.team_id) === this.selectedTeamId).length;
      tb.innerHTML = '';
      this.renderTeamStats();

      Portal.qsa('[data-user-sort]').forEach(th => {
        const key = th.getAttribute('data-user-sort');
        const base = th.textContent.replace(/[↑↓]\s*$/, '').trim();
        th.textContent = key === this.sortKey ? `${base} ${this.sortDir === 'asc' ? '↑' : '↓'}` : base;
      });

      if (summary) summary.textContent = `${rows.length} shown of ${teamMemberCount}`;
      diag('render:start', {
        filteredRows: rows.length,
        allUsers: this.allUsers.length,
        lastFetchError: this.lastFetchError,
        selectedTeamId: this.selectedTeamId,
        searchTerm: this.searchTerm,
        sortKey: this.sortKey,
        sortDir: this.sortDir
      });

      if (this.lastFetchError) {
        tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:#b0261e;">
          Users could not load: ${Portal.escapeHtml(this.lastFetchError)}
        </td></tr>`;
      }

      rows.forEach(u => {
        const uRole = (u.role || '').toLowerCase();
        const roleInfo = this.roleInfoForUser(u);
        const roleColor = roleInfo ? roleInfo.color : '#5f6368';
        const roleLabel = roleInfo ? roleInfo.label : (u.role || 'user');
        const isTrained = !!u.training_complete;
        const dept = this.userDepartment(u);
        const showRank = this.showsDrafterRank(u);
        const rankColor = this.drafterRankColor(u);
        const rankLabel = this.drafterRankLabel(u);

        let statusPill = '';
        if (uRole !== 'trainee' && !isTrained) {
          statusPill = `<span class="user-pill" style="background:#fce8e6; color:#b0261e; margin-left:6px;">Untrained</span>`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>${Portal.escapeHtml(u.name || '-')}</b></td>
          <td>${Portal.escapeHtml(u.email || '-')}</td>
          <td>
            <span class="user-pill" style="background:${roleColor}14; color:${roleColor}; border:1px solid ${roleColor}33;">${Portal.escapeHtml(roleLabel)}</span>
            ${statusPill}
          </td>
          <td>${showRank ? `<span class="user-pill" style="background:${rankColor}14; color:${rankColor}; border:1px solid ${rankColor}33;">${Portal.escapeHtml(rankLabel)}</span>` : '<span style="color:#999;">-</span>'}</td>
          <td class="user-col-secondary"><span class="user-pill" style="background:${dept === 'sales' ? '#e6f4ea' : '#e8f0fe'}; color:${dept === 'sales' ? '#137333' : '#1a73e8'};">${Portal.escapeHtml(this.departmentLabel(dept))}</span></td>
          <td><select class="user-inline-team" data-user-id="${Portal.escapeHtml(u.id || u.email || '')}" aria-label="Team for ${Portal.escapeHtml(u.name || u.email || 'user')}" style="width:100%; min-width:150px; padding:7px 28px 7px 9px; border:1px solid #d7dbe0; border-radius:7px; background:#fff; font-size:12px;">${this.teamOptionsHtml(u.team_id)}</select></td>
          <td class="user-col-secondary">${isTrained ? 'Complete' : 'Pending'}</td>
          <td style="text-align:right">
            <button class="btn-secondary btn-sm" onclick='openUserModal("edit", ${JSON.stringify(u)})'>Edit</button>
          </td>
        `;
        tb.appendChild(tr);
      });

      tb.querySelectorAll('.user-inline-team').forEach(select => {
        select.addEventListener('change', () => this.assignUserTeam(select));
      });

      if (!this.lastFetchError && rows.length === 0) {
        tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:#999;">No users match this view.</td></tr>`;
      }
      diag('render:done', {
        filteredRows: rows.length,
        allUsers: this.allUsers.length,
        ms: Math.round(performance.now() - renderStarted),
        tbodyChildren: tb.children.length
      });
    },

    async onShowUsers(){
      diag('onShowUsers');
      await this.fetchUsers();
    },

    async assignUserTeam(select){
      const userId = String(select.dataset.userId || '');
      const user = this.allUsers.find(row => String(row.id || row.email || '') === userId);
      if (!user) return;
      const previousTeamId = normalizedTeamId(user.team_id);
      const nextTeamId = normalizedTeamId(select.value);
      if (previousTeamId === nextTeamId) return;
      select.disabled = true;
      try {
        const data = await internalJson(`/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          body: { team_id: nextTeamId }
        });
        Object.assign(user, data.user || {}, { team_id: nextTeamId });
        this.renderUsersTable();
      } catch (error) {
        select.value = previousTeamId;
        select.disabled = false;
        alert(error?.message || 'Team assignment could not be saved.');
      }
    },

    openTeamModal(mode='create'){
      const team = mode === 'edit' ? this.teamById(this.selectedTeamId) : null;
      if (mode === 'edit' && !team) return;
      document.getElementById('teamMode').value = team ? 'edit' : 'create';
      document.getElementById('teamModalTitle').textContent = team ? 'Edit Team' : 'Add Team';
      document.getElementById('teamName').value = team?.name || '';
      const managerSelect = document.getElementById('teamManagers');
      const explicitManagers = new Set((team?.manager_user_ids || []).map(value => String(value).toLowerCase()));
      const managers = this.allUsers.filter(user => String(user.role || '').toLowerCase() === 'manager');
      managerSelect.innerHTML = '';
      managers.forEach(user => {
        const option = document.createElement('option');
        option.value = String(user.id || user.email || '');
        option.textContent = `${user.name || user.email} — ${this.teamName(user.team_id)}`;
        const isCurrentTeamManager = team && normalizedTeamId(user.team_id) === team.id;
        option.selected = explicitManagers.has(option.value.toLowerCase()) || (!explicitManagers.size && isCurrentTeamManager);
        managerSelect.appendChild(option);
      });
      Portal.openModal('teamModal');
      setTimeout(() => document.getElementById('teamName')?.focus(), 0);
    },

    async saveTeam(){
      const mode = document.getElementById('teamMode').value;
      const name = String(document.getElementById('teamName').value || '').trim();
      if (!name) {
        document.getElementById('teamName').focus();
        return;
      }
      const managerIds = Array.from(document.getElementById('teamManagers').selectedOptions).map(option => option.value);
      const button = document.getElementById('teamSaveBtn');
      button.disabled = true;
      try {
        const path = mode === 'edit' ? `/teams/${encodeURIComponent(this.selectedTeamId)}` : '/teams';
        const data = await internalJson(path, {
          method: mode === 'edit' ? 'PUT' : 'POST',
          body: { name, manager_user_ids: managerIds }
        });
        if (mode === 'create') this.selectedTeamId = data.team.id;
        Portal.closeModal('teamModal');
        await this.fetchUsers();
      } catch (error) {
        alert(error?.message || 'Team could not be saved.');
      } finally {
        button.disabled = false;
      }
    },

    permCheckboxes(){
      return Portal.qsa('[data-perm-key][type="checkbox"]');
    },

    permSelects(){
      return Portal.qsa('select[data-perm-key]');
    },

    domSuffixFromId(id){
      if (!id || !id.startsWith('p_')) return null;
      const s = id.slice(2).trim();
      return s || null;
    },

    controlPermKey(el){
      if (!el) return null;
      const dataKey = (typeof el.getAttribute === 'function') ? el.getAttribute('data-perm-key') : '';
      if (dataKey) return dataKey;
      const domSuffix = this.domSuffixFromId(el.id || '');
      return domSuffix ? domToServer(domSuffix) : null;
    },

    controlForPermKey(serverKey){
      return Portal.qsa('[data-perm-key]').find(el => el.getAttribute('data-perm-key') === serverKey)
        || document.getElementById('p_' + serverToDom(serverKey));
    },

    clearPermControls(){
      this.permCheckboxes().forEach(cb => cb.checked = false);
      this.permSelects().forEach(sel => {
        const def = sel.querySelector('option[value="none"]')
          || sel.querySelector('option[value="self"]')
          || sel.options[0];
        sel.value = def ? def.value : '';
      });
    },

    setPermValue(serverKey, val){
      const el = this.controlForPermKey(serverKey);
      if (!el) return;
      if (el.tagName === 'SELECT') {
        el.value = (val !== null && val !== undefined) ? String(val) : (el.options[0]?.value || '');
        this._syncSegmentedControl(el.id);
      } else if (el.type === 'checkbox') {
        el.checked = !!val;
      }
    },

    collectPermsFromUI(){
      const perms = {};
      this.permCheckboxes().forEach(cb => {
        const serverKey = this.controlPermKey(cb);
        if (!serverKey) return;
        perms[serverKey] = !!cb.checked;
      });
      this.permSelects().forEach(sel => {
        const serverKey = this.controlPermKey(sel);
        if (!serverKey) return;
        perms[serverKey] = sel.value;
      });
      return perms;
    },

    applyPermsToUI(permsObj){
      const p = (permsObj && typeof permsObj === 'object') ? permsObj : {};
      this.permCheckboxes().forEach(cb => {
        const serverKey = this.controlPermKey(cb);
        if (!serverKey) return;
        cb.checked = !!p[serverKey];
      });
      this.permSelects().forEach(sel => {
        const serverKey = this.controlPermKey(sel);
        if (!serverKey) return;
        const val = p[serverKey];
        if (val !== undefined && val !== null) sel.value = String(val);
        this._syncSegmentedControl(sel.id);
      });
    },

    async fetchUsers(){
      const fetchId = ++userDebugState.activeFetchId;
      const started = performance.now();
      const tb = document.getElementById('usersTable');
      if (tb) tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px;">Loading...</td></tr>`;
      diag('fetchUsers:start', {
        fetchId,
        internalApiBase: internalApiBase(),
        previousUsers: this.allUsers.length,
        activeElement: document.activeElement ? {
          tag: document.activeElement.tagName,
          id: document.activeElement.id,
          className: String(document.activeElement.className || '').slice(0, 80)
        } : null
      });

      this.lastFetchError = null;
      const [usersResult, teamsResult] = await Promise.allSettled([
        internalJson('/users', { timeoutMs: 15000 }),
        internalJson('/teams', { timeoutMs: 15000 })
      ]);
      // A navigation or save can start a newer refresh while this one is in
      // flight. Never let the older response replace newer roster state.
      if (fetchId !== userDebugState.activeFetchId) {
        diag('fetchUsers:stale-response', { fetchId, ms: Math.round(performance.now() - started) }, 'warn');
        return;
      }
      const data = {
        usersData: usersResult.status === 'fulfilled' ? usersResult.value : null,
        teamsData: teamsResult.status === 'fulfilled' ? teamsResult.value : null
      };
      const failures = [
        usersResult.status === 'rejected' ? `users: ${usersResult.reason?.message || usersResult.reason}` : '',
        teamsResult.status === 'rejected' ? `teams: ${teamsResult.reason?.message || teamsResult.reason}` : ''
      ].filter(Boolean);
      if (failures.length) {
        diag('fetchUsers:partial-error', {
          fetchId,
          ms: Math.round(performance.now() - started),
          failures
        }, 'error');
      }
      if (usersResult.status === 'rejected') {
        const error = usersResult.reason;
        this.lastFetchError = error?.name === 'AbortError'
          ? 'Timed out after 15s waiting for users'
          : (error?.message || 'Unknown users fetch failure');
      }

      const rawUsers = Array.isArray(data.usersData?.users) ? data.usersData.users : [];
      const counts = diagCounts(rawUsers);
      const visible = rawUsers.filter(isManagedUser);
      if (usersResult.status === 'fulfilled') this.allUsers = visible;
      if (teamsResult.status === 'fulfilled') this.teams = Array.isArray(data.teamsData?.teams) ? data.teamsData.teams : [];
      if (this.selectedTeamId && this.selectedTeamId !== ALL_USERS_TEAM_SCOPE && !this.teamById(this.selectedTeamId)) {
        this.selectedTeamId = ALL_USERS_TEAM_SCOPE;
      }
      diag('fetchUsers:data', {
        fetchId,
        ms: Math.round(performance.now() - started),
        counts,
        sampleVisible: visible.slice(0, 5).map(user => ({
          email: user.email,
          role: user.role,
          department: user.department,
          training_complete: !!user.training_complete,
          has_schedule: hasShiftScheduleBlocks(user)
        })),
        sampleHidden: rawUsers.filter(user => !isVisibleTeamUser(user)).slice(0, 5).map(user => ({
          email: user.email,
          role: user.role,
          department: user.department,
          account_type: user.account_type,
          status: user.status,
          training_complete: !!user.training_complete,
          has_schedule: hasShiftScheduleBlocks(user)
        }))
      });
      this.renderTeamControls();
      this.renderUsersTable();
      diag('fetchUsers:done', {
        fetchId,
        totalMs: Math.round(performance.now() - started),
        renderedUsers: this.allUsers.length,
        stale: fetchId !== userDebugState.activeFetchId
      });
    },

    openUserModal(mode, user=null){
      this.modalUser = mode === 'edit' && user ? user : null;
      document.getElementById('uModalTitle').innerText = mode === 'create' ? 'Create User' : 'Edit Permissions';
      document.getElementById('uMode').value = mode;

      document.getElementById('uEmail').value = '';
      document.getElementById('uName').value = '';
      document.getElementById('uPass').value = '';
      this.populateUserTeamSelect(mode === 'create'
        ? (this.selectedTeamId === ALL_USERS_TEAM_SCOPE ? '' : this.selectedTeamId)
        : user?.team_id);
      document.getElementById('uDepartment').value = (cfg().flags && cfg().flags.is_sales_portal) ? 'sales' : 'production';
      document.getElementById('uComplexityPref').value = 'all';
      document.getElementById('uDrafterRank').value = 'junior';
      this._setPriorityEligibility(null);
      document.getElementById('uQueueMode').value = 'disabled';
      document.getElementById('uQaTrainee').checked = false;
      document.getElementById('uTrainingComplete').checked = false;
      document.getElementById('uShiftRate').value = 940;
      this._syncAllSegmentedControls();

      this.clearPermControls();

      document.getElementById('btnDeleteUser').style.display = 'none';
      const impersonateBtn = document.getElementById('btnImpersonateUser');
      if (impersonateBtn) impersonateBtn.style.display = 'none';
      document.getElementById('uEmail').disabled = false;

      if (mode === 'create') {
        this.applyPreset(this.defaultCreateRole());
      } else {
        document.getElementById('uEmail').value = user.email;
        document.getElementById('uEmail').disabled = true;
        document.getElementById('uName').value = user.name || '';
        this.populateUserTeamSelect(user.team_id);
        document.getElementById('uDepartment').value = this.userDepartment(user);
        document.getElementById('uComplexityPref').value = user.complexity_preference || 'all';
        document.getElementById('uDrafterRank').value = ['junior', 'standard', 'senior'].includes(String(user.drafter_rank || '').toLowerCase())
          ? String(user.drafter_rank).toLowerCase()
          : 'junior';
        this._syncSegmentedControl('uDrafterRank');
        this._setPriorityEligibility(user);
        document.getElementById('uQueueMode').value = user.queue_mode || 'disabled';
        document.getElementById('uQaTrainee').checked = !!user.is_qa_trainee;
        document.getElementById('uShiftRate').value = (typeof user.shift_rate === 'number') ? user.shift_rate : 940;

        const isTrained = !!user.training_complete;
        let effectiveRole = (user.role || '').toLowerCase();

        const knownRoles = this.rolePresets().map(r => r.value);
        if (!knownRoles.includes(effectiveRole)) {
          if (effectiveRole === 'lead') effectiveRole = 'manager';
          else if (effectiveRole === 'user') effectiveRole = this.userDepartment(user) === 'sales' ? 'salesperson' : 'technician';
          else effectiveRole = 'technician';
        }

        if (!isTrained && knownRoles.includes('trainee') && this.userDepartment(user) !== 'sales') {
          effectiveRole = 'trainee';
        }

        document.getElementById('uRoleLabel').value = effectiveRole;
        document.getElementById('uTrainingComplete').checked = isTrained;
        this._highlightPresetBtn(effectiveRole);
        this.applyPermsToUI(user.permissions || {});

        if (cfg().perms.assign_teams) {
          document.getElementById('btnDeleteUser').style.display = 'block';
        }
        const targetEmail = String(user.email || '').trim().toLowerCase();
        const canImpersonate = isStrictAdmin()
          && targetEmail
          && targetEmail !== currentUserEmail()
          && !(cfg()?.impersonation?.active);
        if (impersonateBtn && canImpersonate) {
          impersonateBtn.style.display = 'inline-flex';
        }
      }

      Portal.openModal('userModal');
      this.updateDrafterRankVisibility();
      this._syncAllSegmentedControls();
    },

    async impersonateSelectedUser(){
      const email = String(document.getElementById('uEmail')?.value || this.modalUser?.email || '').trim().toLowerCase();
      const name = String(document.getElementById('uName')?.value || this.modalUser?.name || email);
      if (!email) {
        alert('Pick a user first.');
        return;
      }
      if (!isStrictAdmin()) {
        alert('Strict admin access is required to impersonate users.');
        return;
      }
      if (email === currentUserEmail()) {
        alert('You cannot impersonate your own current session.');
        return;
      }
      if (!confirm(`Impersonate ${name || email}? Your staff session will switch to that internal user until you stop impersonating.`)) {
        return;
      }
      try {
        const data = await postBackendLoginAction('impersonate_internal_user', { email });
        diag('impersonate:success', {
          email,
          admin_email: data.admin_email,
          target_role: data.target_role
        });
        window.location.href = 'portal.php?impersonated=1';
      } catch (e) {
        diag('impersonate:error', { email, error: e?.message || String(e) }, 'error');
        alert(e?.message || 'Impersonation failed');
      }
    },

    async stopImpersonation(){
      try {
        const data = await postBackendLoginAction('stop_internal_impersonation');
        diag('impersonate:stopped', { user_email: data.user_email });
        window.location.href = 'portal.php?impersonation_stopped=1';
      } catch (e) {
        diag('impersonate:stop-error', { error: e?.message || String(e) }, 'error');
        alert(e?.message || 'Could not stop impersonating');
      }
    },

    applyPreset(role){
      const preset = this.rolePreset(role);
      document.getElementById('uRoleLabel').value = role;
      this._highlightPresetBtn(role);

      const trainCb = document.getElementById('uTrainingComplete');
      if (trainCb) {
        const trainingComplete = (preset && typeof preset.training_complete === 'boolean')
          ? preset.training_complete
          : (role !== 'trainee');
        trainCb.checked = trainingComplete;
      }

      const deptSel = document.getElementById('uDepartment');
      if (deptSel && preset && preset.department) deptSel.value = preset.department;

      this.clearPermControls();

      if (preset && preset.permissions && typeof preset.permissions === 'object' && Object.keys(preset.permissions).length) {
        Object.entries(preset.permissions).forEach(([key, value]) => this.setPermValue(key, value));
        this.updateDrafterRankVisibility();
        return;
      }

      if (role === 'admin') {
        this.permCheckboxes().forEach(cb => cb.checked = true);
        this.permSelects().forEach(sel => {
          const allOpt = sel.querySelector('option[value="all"]');
          sel.value = allOpt ? 'all' : (sel.options[sel.options.length - 1]?.value || '');
        });
        this.updateDrafterRankVisibility();
        return;
      }

      if (role === 'manager') {
        ['view_all_projects', 'view_team_projects', 'manage_queue', 'manage_qa_queue'].forEach(k => this.setPermValue(k, true));
        this.setPermValue('shift_view', 'all');
        this.setPermValue('shift_edit', 'none');
        this.updateDrafterRankVisibility();
        return;
      }

      if (role === 'sales_manager') {
        ['manage_sales_users', 'manage_tutorials'].forEach(k => this.setPermValue(k, true));
        this.setPermValue('shift_view', 'none');
        this.setPermValue('shift_edit', 'none');
        this.updateDrafterRankVisibility();
        return;
      }

      if (role === 'qa') {
        ['view_team_projects', 'manage_qa'].forEach(k => this.setPermValue(k, true));
        this.setPermValue('shift_view', 'all');
        this.setPermValue('shift_edit', 'none');
        this.updateDrafterRankVisibility();
        return;
      }

      if (role === 'technician') {
        this.setPermValue('shift_view', 'all');
        this.setPermValue('shift_edit', 'none');
        this.updateDrafterRankVisibility();
        return;
      }

      this.setPermValue('shift_view', 'none');
      this.setPermValue('shift_edit', 'none');
      this.updateDrafterRankVisibility();
    },

    updateDrafterRankVisibility(){
      const row = document.getElementById('uDrafterRankRow');
      if (row) row.style.display = '';
      this._syncSegmentedControl('uDrafterRank');
    },

    async saveUser(){
      if (this.savingUser) return;
      const form = document.getElementById('userForm');
      if (form && !form.reportValidity()) return;
      const started = performance.now();
      const perms = this.collectPermsFromUI();
      const email = String(document.getElementById('uEmail').value || '').trim().toLowerCase();
      const mode = document.getElementById('uMode').value;
      const payload = {
        id: email,
        email,
        name: document.getElementById('uName').value,
        password: document.getElementById('uPass').value,
        team_id: document.getElementById('uTeam').value,
        department: document.getElementById('uDepartment').value,
        complexity_preference: document.getElementById('uComplexityPref').value,
        drafter_rank: document.getElementById('uDrafterRank').value,
        queue_mode: document.getElementById('uQueueMode').value,
        role: document.getElementById('uRoleLabel').value,
        permissions: perms,
        is_qa_trainee: !!document.getElementById('uQaTrainee').checked,
        training_complete: !!document.getElementById('uTrainingComplete').checked,
        shift_rate: Number(document.getElementById('uShiftRate').value) || 0
      };
      const p1Input = document.getElementById('uP1Eligible');
      const p2Input = document.getElementById('uP2Eligible');
      if (p1Input?.dataset.explicit === 'true') payload.p1_eligible = !!p1Input.checked;
      if (p2Input?.dataset.explicit === 'true') payload.p2_eligible = !!p2Input.checked;
      diag('saveUser:start', {
        mode,
        email,
        role: payload.role,
        department: payload.department,
        training_complete: payload.training_complete,
        permissionTrueKeys: Object.keys(perms).filter(key => perms[key] === true),
        permissionSelects: Object.fromEntries(Object.entries(perms).filter(([, value]) => typeof value === 'string'))
      });

      this.savingUser = true;
      const saveButton = document.getElementById('uSaveUserBtn');
      if (saveButton) saveButton.disabled = true;
      const data = await internalJson(
        mode === 'create' ? '/users' : `/users/${encodeURIComponent(email)}`,
        { method: mode === 'create' ? 'POST' : 'PUT', body: payload }
      ).catch(e => {
        diag('saveUser:error', {
          mode,
          email,
          ms: Math.round(performance.now() - started),
          error: e?.name + ': ' + e?.message
        }, 'error');
        return { success:false, error:e.message };
      });
      this.savingUser = false;
      if (saveButton) saveButton.disabled = false;

      if (data.success) {
        diag('saveUser:success', {
          mode,
          email,
          ms: Math.round(performance.now() - started),
          returnedUser: data.user ? {
            email: data.user.email,
            role: data.user.role,
            training_complete: !!data.user.training_complete
          } : null
        });
        Portal.closeModal('userModal');
        this.fetchUsers();
      } else {
        diag('saveUser:failed', { mode, email, error: data.error || 'Save failed' }, 'warn');
        alert(data.error || 'Save failed');
      }
    },

    async deleteUser(){
      if (!confirm('Are you sure you want to delete this user?')) return;
      const email = String(document.getElementById('uEmail').value || '').trim().toLowerCase();
      const started = performance.now();
      diag('deleteUser:start', { email });

      const data = await internalJson(`/users/${encodeURIComponent(email)}`, {
        method: 'DELETE'
      }).catch(e => {
        diag('deleteUser:error', {
          email,
          ms: Math.round(performance.now() - started),
          error: e?.name + ': ' + e?.message
        }, 'error');
        return { success:false, error:e.message };
      });

      if (data.success) {
        diag('deleteUser:success', { email, ms: Math.round(performance.now() - started) });
        Portal.closeModal('userModal');
        this.fetchUsers();
      } else {
        diag('deleteUser:failed', { email, error: data.error || 'Delete failed' }, 'warn');
        alert(data.error || 'Delete failed');
      }
    },

    debugDump(){
      console.group('Users diagnostics');
      console.log('State', {
        bootedAt: new Date(userDebugState.bootedAt).toISOString(),
        seq: userDebugState.seq,
        activeFetchId: userDebugState.activeFetchId,
        internalApiBase: internalApiBase(),
        allUsers: this.allUsers.length,
        scopeFilter: this.scopeFilter,
        searchTerm: this.searchTerm,
        sortKey: this.sortKey,
        sortDir: this.sortDir
      });
      console.table(userDebugState.events);
      console.groupEnd();
      return userDebugState.events;
    },

    async compareFetches(){
      const url = `${internalApiBase()}/users`;
      const teamUrl = `${internalApiBase()}/users/team`;
      const plainStarted = performance.now();
      diag('compare:plain-start', { url });
      const plain = await fetch(url, { credentials:'include' })
        .then(async res => {
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          return {
            kind: 'plain-console-style',
            status: res.status,
            ok: res.ok,
            ms: Math.round(performance.now() - plainStarted),
            bytes: text.length,
            users: Array.isArray(json?.users) ? json.users.length : undefined,
            contentType: res.headers.get('content-type'),
            preview: text.slice(0, 120)
          };
        })
        .catch(e => ({
          kind: 'plain-console-style',
          status: 'network-error',
          ms: Math.round(performance.now() - plainStarted),
          error: e?.name + ': ' + e?.message
        }));

      const internalStarted = performance.now();
      diag('compare:internal-start', { url: teamUrl });
      const internal = await internalJson('/users/team', { timeoutMs: 20000 })
        .then(data => ({
          kind: 'users-tab-internalJson-team',
          status: 200,
          ok: true,
          ms: Math.round(performance.now() - internalStarted),
          users: Array.isArray(data.users) ? data.users.length : undefined,
          count: data.count
        }))
        .catch(e => ({
          kind: 'users-tab-internalJson',
          status: 'error',
          ms: Math.round(performance.now() - internalStarted),
          error: e?.name + ': ' + e?.message
        }));

      const result = {
        url,
        note: 'Plain fetch differs only by headers/timeout; if this works later but tab fetch timed out earlier, timing/concurrent startup load is the real difference.',
        plain,
        internal
      };
      diag('compare:done', result);
      console.table([plain, internal]);
      console.log('Users fetch comparison', result);
      return result;
    }
  };

  window.Users = Users;
})();
