/* public/libraries/apps/calls/app.js
 * Calls task board tab for call workflow rollout.
 */
(function(){
  const Portal = window.Portal || {};
  const util = Portal.util || {};
  const $ = util.$ || ((sel, root=document) => root.querySelector(sel));
  const $$ = util.$$ || ((sel, root=document) => Array.from(root.querySelectorAll(sel)));
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? ''));
  const APP = window.__APP || {};

  const sampleColumns = [
    {
      id: 'new_leads',
      title: 'New Leads',
      icon: 'fa-phone-volume',
      tone: 'lead',
      tasks: [
        { id:'lead-1', name:'Maya Rodriguez', phone:'(206) 555-0182', address:'1421 NW Market St, Seattle, WA 98107', meta:'Website estimate request' },
        { id:'lead-2', name:'Grant Holloway', phone:'(425) 555-0128', address:'8801 166th Ave NE, Redmond, WA 98052', meta:'Inbound email lead' },
        { id:'lead-3', name:'Lena Brooks', phone:'(253) 555-0174', address:'619 S 15th St, Tacoma, WA 98405', meta:'New roof inquiry' }
      ]
    },
    {
      id: 'follow_ups',
      title: 'Follow-ups',
      icon: 'fa-clock',
      tone: 'followup',
      tasks: [
        { id:'follow-1', name:'Evan Carter', phone:'(360) 555-0165', address:'2198 Cooper Point Rd SW, Olympia, WA 98502', meta:'Due today at 10:30 AM' },
        { id:'follow-2', name:'Priya Shah', phone:'(206) 555-0149', address:'3417 NE 65th St, Seattle, WA 98115', meta:'Proposal follow-up' },
        { id:'follow-3', name:'Nolan Kim', phone:'(425) 555-0113', address:'12704 NE 116th St, Kirkland, WA 98034', meta:'Inspection recap' }
      ]
    },
    {
      id: 'new_customers',
      title: 'New Customers',
      icon: 'fa-handshake',
      tone: 'customer',
      tasks: [
        { id:'customer-1', name:'Avery Johnson', phone:'(206) 555-0199', address:'7356 35th Ave NE, Seattle, WA 98115', meta:'Signed yesterday' },
        { id:'customer-2', name:'Sofia Nguyen', phone:'(425) 555-0171', address:'4510 146th Pl SE, Bellevue, WA 98006', meta:'Welcome call' },
        { id:'customer-3', name:'Miles Thompson', phone:'(253) 555-0134', address:'1012 N Yakima Ave, Tacoma, WA 98403', meta:'Project kickoff' }
      ]
    }
  ];

  const state = {
    root: null,
    completed: new Set(),
    collapsedColumns: new Set()
  };

  function orgId(){ return String(APP.userOrgId || '').trim(); }

  function injectCss(){
    const css = `
      .calls-shell{height:100%;min-height:0;background:#f6f7f9;display:flex;flex-direction:column;color:#111827}
      .calls-head{flex:0 0 auto;background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:10px 22px;display:flex;align-items:center;justify-content:space-between;gap:16px}
      .calls-title{display:grid;gap:5px;min-width:0}
      .calls-title h2{margin:0;font-size:18px;font-weight:1000;letter-spacing:0;color:#111827}
      .calls-title span{font-size:12px;font-weight:850;color:#667085}
      .calls-actions{display:flex;align-items:center;gap:10px}
      .calls-icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;color:#344054;display:grid;place-items:center;cursor:pointer}
      .calls-icon-btn:hover{border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025));background:#fff}
      .calls-board{flex:1;min-height:0;overflow:auto;padding:18px 22px;display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:16px;align-items:start}
      .calls-column{min-height:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.04);display:flex;flex-direction:column}
      .calls-column-head{width:100%;padding:14px 14px 12px;border:0;border-bottom:1px solid #eef2f7;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;color:inherit;font:inherit}
      .calls-column-head:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:-3px}
      .calls-column-label{display:flex;align-items:center;gap:10px;min-width:0}
      .calls-column-icon{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;color:#fff;background:#1f2937;flex:0 0 auto}
      .calls-column.lead .calls-column-icon{background:#2563eb}
      .calls-column.followup .calls-column-icon{background:#7c3aed}
      .calls-column.customer .calls-column-icon{background:#047857}
      .calls-column h3{margin:0;font-size:15px;font-weight:1000;letter-spacing:0;color:#111827;line-height:1.2}
      .calls-column-meta{display:flex;align-items:center;gap:8px;flex:0 0 auto}
      .calls-count{font-size:12px;font-weight:950;color:#667085;background:#f2f4f7;border:1px solid #eaecf0;border-radius:999px;padding:5px 9px;white-space:nowrap}
      .calls-collapse-icon{display:none;color:#667085;font-size:12px;transition:transform .16s ease}
      .calls-list{padding:10px;display:flex;flex-direction:column;gap:9px}
      .calls-card{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:12px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:11px;align-items:start;transition:border-color .14s ease,background .14s ease,opacity .14s ease}
      .calls-card:hover{border-color:#cbd5e1;background:#fbfdff}
      .calls-card.done{opacity:.62;background:#f8fafc}
      .calls-checkbox{width:20px;height:20px;margin:2px 0 0;accent-color:var(--primary,#d93025);cursor:pointer}
      .calls-customer{min-width:0;display:grid;gap:6px}
      .calls-mainline{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}
      .calls-name{font-size:14px;font-weight:1000;color:#101828;line-height:1.25;min-width:0;overflow-wrap:anywhere}
      .calls-phone{font-size:13px;font-weight:950;color:var(--primary-readable,var(--primary,#d93025));text-decoration:none;white-space:nowrap}
      .calls-phone:hover{text-decoration:underline}
      .calls-address{font-size:12px;font-weight:800;color:#667085;line-height:1.35}
      .calls-meta{font-size:11px;font-weight:900;color:#475467;background:#f8fafc;border:1px solid #eef2f7;border-radius:999px;padding:5px 8px;width:max-content;max-width:100%;overflow-wrap:anywhere}
      .calls-empty{border:1px dashed #d0d5dd;border-radius:8px;padding:18px;text-align:center;color:#667085;font-size:13px;font-weight:900;background:#fcfcfd}
      @media(max-width:1120px){.calls-board{grid-template-columns:1fr}.calls-column{min-height:auto}.calls-mainline{flex-wrap:wrap}.calls-phone{white-space:normal}}
      @media(max-width:700px){
        .calls-head{padding:8px 16px;justify-content:flex-end}
        .calls-title{display:none}
        .calls-board{padding:14px 16px}
        .calls-column-head{cursor:pointer}
        .calls-collapse-icon{display:inline-block}
        .calls-column.collapsed .calls-list{display:none}
        .calls-column.collapsed .calls-collapse-icon{transform:rotate(-90deg)}
      }
    `;
    if (util.injectCSS) util.injectCSS('calls_tab', css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function activeCount(column){
    return column.tasks.filter((task) => !state.completed.has(task.id)).length;
  }

  function renderTask(task){
    const done = state.completed.has(task.id);
    const phoneHref = String(task.phone || '').replace(/[^\d+]/g, '');
    return `
      <div class="calls-card ${done ? 'done' : ''}" data-call-task="${escapeHtml(task.id)}">
        <input class="calls-checkbox" type="checkbox" ${done ? 'checked' : ''} aria-label="Mark ${escapeHtml(task.name)} completed">
        <span class="calls-customer">
          <span class="calls-mainline">
            <span class="calls-name">${escapeHtml(task.name)}</span>
            <a class="calls-phone" href="tel:${escapeHtml(phoneHref)}">${escapeHtml(task.phone)}</a>
          </span>
          <span class="calls-address">${escapeHtml(task.address)}</span>
          <span class="calls-meta">${escapeHtml(task.meta)}</span>
        </span>
      </div>
    `;
  }

  function renderColumn(column){
    const remaining = activeCount(column);
    const tasks = column.tasks.map(renderTask).join('');
    const collapsed = state.collapsedColumns.has(column.id);
    return `
      <section class="calls-column ${escapeHtml(column.tone)} ${collapsed ? 'collapsed' : ''}">
        <button class="calls-column-head" type="button" data-call-column-toggle="${escapeHtml(column.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
          <div class="calls-column-label">
            <span class="calls-column-icon"><i class="fas ${escapeHtml(column.icon)}"></i></span>
            <h3>${escapeHtml(column.title)}</h3>
          </div>
          <span class="calls-column-meta">
            <span class="calls-count">${remaining}</span>
            <i class="fas fa-chevron-down calls-collapse-icon" aria-hidden="true"></i>
          </span>
        </button>
        <div class="calls-list">
          ${tasks || '<div class="calls-empty">No calls queued</div>'}
        </div>
      </section>
    `;
  }

  function render(){
    if (!state.root) return;
    state.root.innerHTML = `
      <div class="calls-shell">
        <header class="calls-head">
          <div class="calls-title">
            <h2>Calls</h2>
            <span>Today</span>
          </div>
          <div class="calls-actions">
            <button class="calls-icon-btn" id="callsWorkflowSettings" type="button" aria-label="Call workflow settings" data-fm-tooltip="Call workflow settings">
              <i class="fas fa-gear"></i>
            </button>
          </div>
        </header>
        <div class="calls-board">
          ${sampleColumns.map(renderColumn).join('')}
        </div>
      </div>
    `;
    $$('.calls-card', state.root).forEach((card) => {
      const input = $('input[type="checkbox"]', card);
      input?.addEventListener('change', () => {
        const id = card.dataset.callTask || '';
        if (!id) return;
        if (input.checked) state.completed.add(id);
        else state.completed.delete(id);
        render();
      });
    });
    $('#callsWorkflowSettings', state.root)?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('fm:open-call-workflow-settings'));
    });
    $$('.calls-column-head', state.root).forEach((button) => {
      button.addEventListener('click', () => {
        if (!window.matchMedia?.('(max-width: 700px)').matches) return;
        const id = button.dataset.callColumnToggle || '';
        if (!id) return;
        if (state.collapsedColumns.has(id)) state.collapsedColumns.delete(id);
        else state.collapsedColumns.add(id);
        render();
      });
    });
  }

  function mount(root){
    injectCss();
    state.root = root;
    render();
  }

  let tabRegistered = false;
  let syncTimer = null;

  function appsReady(){
    return !!window.Portal?.apps?.registerPortalApp && !!window.Portal?.tabs?.renderTabs && !!document.getElementById('mainPanels');
  }

  function queueSync(delay = 0){
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncCallsTab().catch(() => null);
    }, delay);
  }

  function registerCallsTab(){
    if (tabRegistered) return;
    if (!appsReady()) {
      queueSync(100);
      return;
    }
    tabRegistered = true;
    window.Portal.apps.registerPortalApp({
      id: 'portal.calls',
      tabId: 'calls',
      title: 'Calls',
      icon: 'fa-phone',
      order: 22,
      fullBleed: true,
      mount
    });
    window.Portal.tabs.renderTabs?.();
  }

  function unregisterCallsTab(){
    if (!tabRegistered || !window.Portal?.apps?.unregisterPortalApp) return;
    tabRegistered = false;
    state.root = null;
    window.Portal.apps.unregisterPortalApp('calls');
  }

  async function syncCallsTab(){
    if (!orgId()) {
      queueSync(150);
      return;
    }
    if (window.Portal?.appFlags?.load) await window.Portal.appFlags.load().catch(() => null);
    const enabled = window.Portal?.appFlags?.has ? window.Portal.appFlags.has('calls', 'app') : false;
    if (enabled) registerCallsTab();
    else unregisterCallsTab();
  }

  window.addEventListener('fm:platform-session:updated', () => queueSync());
  window.addEventListener('fm:app-flags:updated', () => queueSync());
  document.addEventListener('DOMContentLoaded', () => queueSync());
  queueSync();
})();
