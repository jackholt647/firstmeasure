/* public/libraries/apps/payroll/project.js
 * Project commission participants and commission ledger.
 */
(function(){
  'use strict';
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  if (!Portal) return;

  const escapeHtml = Portal.util?.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[match])));
  const injectCSS = Portal.util?.injectCSS || (() => {});
  const showToast = Portal.ui?.showToast || (() => {});
  const clean = (value) => String(value ?? '').trim();
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const title = (value) => clean(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const money = (cents) => new Intl.NumberFormat(undefined, { style:'currency', currency:'USD' }).format(Number(cents || 0) / 100);
  const date = (value) => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '—'; };

  function panelHtml(){ return '<div class="pc-app" data-project-commissions></div>'; }

  function installCss(){
    injectCSS('project_commissions_app', `
      .pc-app{height:100%;min-height:0;overflow:auto;background:#f6f8fb;color:#101828;padding:14px;box-sizing:border-box}.pc-shell{max-width:1120px;margin:0 auto;display:grid;gap:12px}
      .pc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.pc-head h2{margin:0;font-size:21px;font-weight:1000}.pc-head p{margin:5px 0 0;color:#667085;font-size:12px;line-height:1.5;font-weight:700}
      .pc-btn{height:36px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;padding:0 12px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font:800 11px inherit;cursor:pointer}.pc-btn:hover{border-color:#98a2b3}.pc-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}.pc-btn.icon{width:32px;height:32px;padding:0}.pc-btn:disabled{opacity:.55;cursor:not-allowed}
      .pc-card{border:1px solid #e4e7ec;border-radius:13px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.04);overflow:hidden}.pc-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid #eaecf0}.pc-card-head>strong{font-size:13px}.pc-card-summary{margin-left:auto;display:flex;align-items:baseline;justify-content:flex-end;gap:12px;flex-wrap:wrap;text-align:right}.pc-card-summary span{color:#667085;font-size:10px;font-weight:800}.pc-card-summary .pc-summary-upcoming{color:#175cd3}.pc-card-summary .pc-summary-accrued{color:#027a48}
      .pc-roles{display:grid;grid-template-columns:repeat(var(--pc-role-columns,1),minmax(0,1fr));gap:9px}.pc-role{min-width:0;border:1px solid #e4e7ec;border-radius:11px;background:#fff;overflow:hidden}.pc-role-top{padding:9px 10px;border-bottom:1px solid #f0f2f5;display:flex;justify-content:space-between;gap:8px}.pc-role-top strong{display:block;font-size:12px}.pc-role-top small{display:block;margin-top:2px;color:#667085;font-size:9px;font-weight:700}.pc-role-body{padding:9px;display:grid;gap:7px}.pc-payees{display:flex;flex-wrap:wrap;gap:5px}.pc-payee{display:inline-flex;align-items:center;gap:5px;border:1px solid #e4e7ec;border-radius:999px;background:#f8fafc;padding:3px 3px 3px 7px;font-size:9px;font-weight:900}.pc-payee em{font-style:normal;color:#667085}.pc-payee button{width:19px;height:19px;border:0;border-radius:50%;background:#fff;color:#98a2b3;cursor:pointer}.pc-payee button:hover{color:#b42318}.pc-empty{padding:7px;border:1px dashed #d0d5dd;border-radius:8px;color:#667085;text-align:center;font-size:9px;font-weight:750}.pc-add-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px}.pc-add-row .pc-btn{height:32px}.pc-select,.pc-input{width:100%;height:32px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:0 8px;color:#344054;font:750 10px inherit;box-sizing:border-box}.pc-new-role{background:#f8fafc}.pc-new-role .pc-role-top{align-items:center}.pc-new-role .pc-role-body{align-content:start}.pc-new-role .pc-btn{width:100%;height:32px}
      .pc-table-wrap{overflow:auto}.pc-table{width:100%;border-collapse:collapse}.pc-table th{padding:8px 11px;background:#f8fafc;text-align:left;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.pc-table td{padding:9px 11px;border-top:1px solid #f0f2f5;font-size:11px;color:#475467}.pc-table td strong{display:block;color:#101828;font-size:11px}.pc-amount{text-align:right!important;font-weight:1000;color:#101828!important}.pc-amount.negative{color:#b42318!important}.pc-pill{display:inline-flex;border-radius:999px;padding:3px 6px;font-size:9px;font-weight:1000;background:#f2f4f7;color:#475467}.pc-pill.accrued{background:#ecfdf3;color:#027a48}.pc-pill.projected{background:#eff8ff;color:#175cd3}.pc-pill.void{background:#f2f4f7;color:#667085}
      .pc-override-row td{background:#fffcf5}.pc-override-form{display:grid;grid-template-columns:150px minmax(220px,1fr) auto auto;gap:8px;align-items:end}.pc-override-form label{display:grid;gap:5px;color:#667085;font-size:9px;font-weight:950;text-transform:uppercase}.pc-override-form .pc-input{width:100%}.pc-entry-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}.pc-effective{display:block;margin-top:3px;color:#667085;font-size:9px;font-weight:800}
      .pc-state{min-height:220px;display:grid;place-items:center;color:#667085;font-size:12px;font-weight:800}.pc-state>div{text-align:center}.pc-state i{display:block;margin-bottom:8px;font-size:22px;color:var(--primary,#d93025)}
      @media(max-width:980px){.pc-roles{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:760px){.pc-app{padding:10px}.pc-head{align-items:stretch;flex-direction:column}.pc-roles{grid-template-columns:1fr}.pc-override-form{grid-template-columns:1fr}.pc-table th:nth-child(3),.pc-table td:nth-child(3){display:none}}
    `);
  }

  function createApp(context = {}){
    installCss();
    const root = context.panelRoot || context.roots?.main;
    const project = context.project || context.model?.state?.activeBaseProject || {};
    const orgId = clean(context.orgId || window.__APP?.userOrgId || Portal.cfg?.userOrgId);
    const projectId = clean(context.projectId || project.platform_project_id || project.base_project_id || project.id);
    const branchId = clean(context.branchId || project.branch_id || Portal.branchModules?.currentBranchId?.() || 'default') || 'default';
    const moneyTerms = object(context.moneyTerms);
    const word = (key, fallback) => clean(moneyTerms[key]) || fallback;
    const state = { loading:true, saving:false, error:'', roles:[], workers:[], entries:[], overrideEntryId:'', destroyed:false };
    if (!root) return { destroy(){} };
    root.innerHTML = panelHtml();
    const host = root.querySelector('[data-project-commissions]') || root;

    function workerKey(worker){ return `${clean(worker.type)}|${clean(worker.id)}`; }
    function normalizeWorkers(usersResult, connectionsResult){
      const users = array(usersResult?.users).map((user) => ({
        type:'organization_user', id:clean(user.id || user.user_id), name:clean(user.name || user.email || user.id), worker_type:clean(user.worker_classification || user.worker_type || 'employee'),
        access_role_ids:array(user.access_role_ids || user.assignment_role_ids), resource_group_ids:array(user.resource_group_ids)
      }));
      const connections = array(connectionsResult?.organization_connections || connectionsResult?.connections).map((connection) => ({
        type:'organization_connection', id:clean(connection.id), name:clean(connection.name || connection.legal_name || connection.id), worker_type:'subcontractor'
      }));
      return [...users, ...connections].filter((worker) => worker.id).sort((a,b) => a.name.localeCompare(b.name));
    }
    function normalizedRoles(roles){ return array(roles).map((role) => ({ ...role, payees:array(role.payees) })); }
    function normalizedEntries(entries){
      return array(entries).filter((entry) => clean(entry.state) !== 'void' && ['commission','clawback'].includes(clean(entry.kind)) && clean(entry.subgroup || 'commission') === 'commission').sort((a,b) => clean(b.created_at).localeCompare(clean(a.created_at)));
    }
    async function refreshEntries(){
      const ledger = await PayrollAPI.ledger.list(orgId, { project_id:projectId, limit:500 });
      state.entries = normalizedEntries(ledger?.entries);
    }
    function roleKeyForTitle(value){
      return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    }
    async function load(){
      if (context.params?.smoke) {
        const sampleWorkers = [
          { type:'organization_user', id:'user_estimator', name:'Jordan Ramirez', worker_type:'employee', access_role_ids:['estimator'] },
          { type:'organization_user', id:'user_booking', name:'Taylor Chen', worker_type:'employee', access_role_ids:['sales'] },
          { type:'organization_connection', id:'partner_roofing', name:'Summit Roofing Crew', worker_type:'subcontractor' }
        ];
        state.workers = sampleWorkers;
        state.roles = normalizedRoles([
          { role_key:'estimators', label:(globalThis.PlatformLanguage?.text("payroll","m_ebc17ecb030208","Estimators") ?? "Estimators"), revision:1, payees:[sampleWorkers[0]], metadata:{} },
          { role_key:'booked_by', label:(globalThis.PlatformLanguage?.text("payroll","m_635d2225681e25","Booked By") ?? "Booked By"), revision:1, payees:[sampleWorkers[1]], metadata:{} }
        ]);
        state.entries = [
          { id:'commission_1', payee:sampleWorkers[0], state:'accrued', kind:'commission', amount_cents:185000, eligible_at:new Date().toISOString(), description:(globalThis.PlatformLanguage?.text("payroll","m_2c7220f72f3a71","Proposal payment commission") ?? "Proposal payment commission") },
          { id:'commission_2', payee:sampleWorkers[1], state:'projected', kind:'commission', amount_cents:10000, eligible_at:new Date(Date.now() + 86400000 * 14).toISOString(), description:(globalThis.PlatformLanguage?.text("payroll","m_bc83d5a41de111","Project completion booking bonus") ?? "Project completion booking bonus") }
        ];
        state.loading = false;
        state.error = '';
        render();
        return;
      }
      if (!orgId || !projectId || !window.PayrollAPI) { state.error = 'Payroll API or project context is unavailable.'; state.loading = false; render(); return; }
      state.loading = true; state.error = ''; render();
      try {
        const [payees, ledger, users, connections] = await Promise.all([
          PayrollAPI.projects.payees(orgId, projectId),
          PayrollAPI.ledger.list(orgId, { project_id:projectId, limit:500 }),
          window.PlatformAPI?.workforce?.users?.(orgId, branchId).catch(() => ({ users:[] })) || { users:[] },
          window.PlatformAPI?.connections?.list?.(orgId, { branchId }).catch(() => ({ organization_connections:[] })) || { organization_connections:[] }
        ]);
        state.roles = normalizedRoles(payees?.payee_roles);
        state.entries = normalizedEntries(ledger?.entries);
        state.workers = normalizeWorkers(users, connections);
      } catch(error){ state.error = error?.message || 'Could not load commission participants.'; }
      state.loading = false; render();
    }
    async function saveRole(index, payees){
      const role = state.roles[index];
      if (!role || state.saving) return;
      state.saving = true; render();
      try {
        const result = await PayrollAPI.projects.setPayeeRole(orgId, projectId, role.role_key, {
          label:role.label || title(role.role_key), payees, metadata:object(role.metadata), ...(Number(role.revision || 0) > 0 ? { expected_revision:Number(role.revision) } : {})
        });
        state.roles[index] = { ...result.payee_role, payees:array(result.payee_role?.payees) };
        let refreshError = null;
        try { await refreshEntries(); } catch(error){ refreshError = error; }
        if (refreshError) showToast((globalThis.PlatformLanguage?.text("payroll","m_6d90a99cf9f002","Recipients saved") ?? "Recipients saved"), refreshError?.message || 'Commission payments could not refresh. Use Refresh to try again.', false);
        else showToast((globalThis.PlatformLanguage?.text("payroll","m_99e48359e03e95","Commission recipients saved") ?? "Commission recipients saved"), ((v0,v1,v2) => globalThis.PlatformLanguage?.text("payroll","m_7ec6d266e868d4",`${v0} now has ${v1} recipient${v2}.`,{v0,v1,v2}) ?? `${v0} now has ${v1} recipient${v2}.`)(role.label || title(role.role_key),payees.length,payees.length === 1 ? '' : 's'), true);
      } catch(error){ showToast((globalThis.PlatformLanguage?.text("payroll","m_2eff013b0449ed","Could not save recipients") ?? "Could not save recipients"), error?.message || 'Please try again.', false); }
      state.saving = false; render();
    }
    async function createRole(label){
      const roleLabel = clean(label);
      const roleKey = roleKeyForTitle(roleLabel);
      if (!roleLabel || !roleKey) return showToast((globalThis.PlatformLanguage?.text("payroll","m_4be28795a8a98d","Role title required") ?? "Role title required"), (globalThis.PlatformLanguage?.text("payroll","m_a06b2c3d3c41b2","Enter a title such as Estimator or Sales Team.") ?? "Enter a title such as Estimator or Sales Team."), false);
      if (state.roles.some((role) => clean(role.role_key) === roleKey || clean(role.label).toLowerCase() === roleLabel.toLowerCase())) {
        return showToast((globalThis.PlatformLanguage?.text("payroll","m_ca0779eccc4125","Role already exists") ?? "Role already exists"), ((v0) => globalThis.PlatformLanguage?.text("payroll","m_fc604fa4c50f35",`A role named ${v0} already exists.`,{v0}) ?? `A role named ${v0} already exists.`)(roleLabel), false);
      }
      state.saving = true; render();
      try {
        const result = await PayrollAPI.projects.setPayeeRole(orgId, projectId, roleKey, { label:roleLabel, payees:[], metadata:{} });
        state.roles.push({ ...result.payee_role, payees:array(result.payee_role?.payees) });
        showToast((globalThis.PlatformLanguage?.text("payroll","m_1ff3abaeaa859e","Commission role added") ?? "Commission role added"), ((v0) => globalThis.PlatformLanguage?.text("payroll","m_1ba74d3ff96e7d",`${v0} is ready for payees.`,{v0}) ?? `${v0} is ready for payees.`)(roleLabel), true);
      } catch(error){ showToast((globalThis.PlatformLanguage?.text("payroll","m_ef61ba1676f9a9","Could not add role") ?? "Could not add role"), error?.message || 'Please try again.', false); }
      state.saving = false; render();
    }
    function roleCard(role, index){
      const selected = new Set(array(role.payees).map(workerKey));
      const available = state.workers.filter((worker) => !selected.has(workerKey(worker)));
      const assignmentSource = clean(object(role.metadata).assignment_source); const assignmentLabel = assignmentSource === 'sales_appointment_assignee' ? 'From sales appointment assignee' : assignmentSource === 'sales_appointment_scheduler' ? 'From appointment scheduler' : 'Assigned manually';
      return `<section class="pc-role"><div class="pc-role-top"><div><strong>${String(escapeHtml(role.label || title(role.role_key)))}</strong><small>${((v1,v2,v3) => globalThis.PlatformLanguage?.text("payroll","m_a283c3781a622a",`${v1} payee${v2} assigned · ${v3}`,{v1,v2,v3}) ?? `${v1} payee${v2} assigned · ${v3}`)(array(role.payees).length,array(role.payees).length === 1 ? '' : 's',escapeHtml(assignmentLabel))}</small></div><i class="fas fa-user-group"></i></div><div class="pc-role-body">
        <div class="pc-payees">${String(array(role.payees).map((payee,payeeIndex) => `<span class="pc-payee"><span>${escapeHtml(payee.name || payee.id)}</span><em>${payee.worker_type === 'independent_contractor' ? 'Independent contractor' : payee.worker_type === 'subcontractor' || payee.type === 'organization_connection' ? 'Subcontractor' : 'Employee'}</em><button type="button" data-pc-remove="${index}:${payeeIndex}" aria-label="Remove"><i class="fas fa-xmark"></i></button></span>`).join('') || '<div class="pc-empty">No payees assigned yet.</div>')}</div>
        <div class="pc-add-row"><select class="pc-select" data-pc-worker="${String(index)}"><option value="">${(globalThis.PlatformLanguage?.text("payroll","m_e1aacfb1506cd1","Choose recipient…") ?? "Choose recipient…")}</option>${String(available.map((worker) => `<option value="${escapeHtml(workerKey(worker))}">${escapeHtml(worker.name)} · ${worker.worker_type === 'independent_contractor' ? 'Independent contractor' : worker.worker_type === 'subcontractor' ? 'Subcontractor' : 'Employee'}</option>`).join(''))}</select><button type="button" class="pc-btn" data-pc-add="${String(index)}" ${String(!available.length || state.saving ? 'disabled' : '')}><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("payroll","m_c807a71e1c06f5","Add") ?? "Add")}</button></div>
      </div></section>`;
    }
    function activity(){
      const upcoming = state.entries.filter((entry) => clean(entry.state) === 'projected').reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0); const accrued = state.entries.filter((entry) => clean(entry.state) === 'accrued').reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0);
      return `<section class="pc-card"><div class="pc-card-head"><strong>${String(escapeHtml(word('commission_payments', 'Commission Payments')))}</strong><div class="pc-card-summary"><span>${String(state.entries.length)} ${String(escapeHtml(state.entries.length === 1 ? word('commission_payment', 'Commission Payment').toLowerCase() : word('commission_payments', 'Commission Payments').toLowerCase()))}</span><span class="pc-summary-upcoming">${String(money(upcoming))} ${String(escapeHtml(word('upcoming', 'Upcoming').toLowerCase()))}</span><span class="pc-summary-accrued">${String(money(accrued))} ${String(escapeHtml(word('accrued', 'Accrued').toLowerCase()))}</span></div></div><div class="pc-table-wrap"><table class="pc-table"><thead><tr><th>${String(escapeHtml(word('commission_recipient', 'Commission Recipient')))}</th><th>${String(escapeHtml(word('commission_payment', 'Commission Payment')))}</th><th>${String(escapeHtml(word('timing', 'Timing')))}</th><th class="pc-amount">${(globalThis.PlatformLanguage?.text("payroll","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th></tr></thead><tbody>${String(state.entries.map((entry) => {
        const payee = object(entry.payee); const amount = Number(entry.amount_cents || 0); const status = clean(entry.state || 'accrued');
        const metadata = object(entry.metadata); const isAdjustment = !!clean(metadata.manual_override_for); const related = state.entries.filter((candidate) => clean(object(candidate.metadata).manual_override_for) === clean(entry.id)); const effective = amount + related.reduce((sum,candidate) => sum + Number(candidate.amount_cents || 0), 0); const canOverride = entry.kind === 'commission' && amount >= 0 && !isAdjustment && status !== 'void';
        const installmentTitle = clean(metadata.commission_installment_title); const recognition = object(metadata.commission_recognition); const timing = status === 'projected' ? (installmentTitle || title(recognition.node_id || 'future event')) : date(entry.eligible_at); const ruleTotal = Number(metadata.commission_rule_total_cents || 0); const share = Number(metadata.commission_installment_share_bps || 0) / 100;
        const description = clean(entry.description || title(entry.kind)); const installmentSuffix = installmentTitle ? ` — ${installmentTitle}` : ''; const paymentTitle = installmentSuffix && description.toLowerCase().endsWith(installmentSuffix.toLowerCase()) ? description.slice(0, -installmentSuffix.length) : description;
        return `<tr><td><strong>${escapeHtml(payee.name || payee.id)}</strong><span>${payee.worker_type === 'subcontractor' ? 'Subcontractor' : 'Employee'}</span></td><td><strong>${escapeHtml(paymentTitle || title(entry.kind))}</strong><span class="pc-pill ${escapeHtml(status)}">${escapeHtml(status === 'projected' ? 'Upcoming' : title(status))}</span>${ruleTotal && share ? `<span class="pc-effective">${escapeHtml(String(share))}% of ${escapeHtml(money(ruleTotal))} total commission</span>` : ''}</td><td><strong>${escapeHtml(timing)}</strong></td><td class="pc-amount ${amount < 0 ? 'negative' : ''}"><div class="pc-entry-actions"><span>${escapeHtml(money(amount))}${related.length ? `<small class="pc-effective">Effective ${escapeHtml(money(effective))}</small>` : ''}</span>${canOverride ? `<button type="button" class="pc-btn" data-pc-override="${escapeHtml(entry.id)}">Override</button>` : ''}</div></td></tr>${state.overrideEntryId === entry.id ? `<tr class="pc-override-row"><td colspan="4"><form class="pc-override-form" data-pc-override-form="${escapeHtml(entry.id)}"><label>Final amount<input class="pc-input" name="amount" type="number" min="0" step="0.01" value="${escapeHtml((effective / 100).toFixed(2))}" required></label><label>Reason<input class="pc-input" name="reason" maxlength="1000" placeholder="Required audit reason" required></label><button type="submit" class="pc-btn primary" ${state.saving ? 'disabled' : ''}>Save override</button><button type="button" class="pc-btn" data-pc-override-cancel>Cancel</button></form></td></tr>` : ''}`;
      }).join('') || '<tr><td colspan="4"><div class="pc-empty">No projected or accrued commissions on this project yet.</div></td></tr>')}</tbody></table></div></section>`;
    }
    function render(){
      if (state.destroyed) return;
      if (state.loading) { host.innerHTML = `<div class="pc-state"><div><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("payroll","m_0c4d44e49d9fdf","Loading commission participants…") ?? "Loading commission participants…")}</div></div>`; return; }
      if (state.error) { host.innerHTML = `<div class="pc-state"><div><i class="fas fa-triangle-exclamation"></i>${String(escapeHtml(state.error))}<br><button class="pc-btn" data-pc-refresh style="margin-top:12px">${(globalThis.PlatformLanguage?.text("payroll","m_ef39ad5e614a24","Try again") ?? "Try again")}</button></div></div>`; bind(); return; }
      const roleTileCount = state.roles.length + 1; const roleColumns = roleTileCount > 4 ? 3 : Math.max(1, roleTileCount);
      host.innerHTML = `<div class="pc-shell"><header class="pc-head"><div><h2>${String(escapeHtml(word('commissions', 'Commissions')))}</h2><p>${((v1,v2) => globalThis.PlatformLanguage?.text("payroll","m_57d8adf5033ef1",`Assign ${v1} and review their ${v2}.`,{v1,v2}) ?? `Assign ${v1} and review their ${v2}.`)(escapeHtml(word('commission_recipients', 'Commission Recipients').toLowerCase()),escapeHtml(word('commission_payments', 'Commission Payments').toLowerCase()))}</p></div><button type="button" class="pc-btn" data-pc-refresh><i class="fas fa-rotate-right"></i>${(globalThis.PlatformLanguage?.text("payroll","m_78973ce0cf3403","Refresh") ?? "Refresh")}</button></header>
        <div class="pc-roles" style="--pc-role-columns:${String(roleColumns)}">${String(state.roles.map(roleCard).join(''))}<section class="pc-role pc-new-role"><div class="pc-role-top"><div><strong>${(globalThis.PlatformLanguage?.text("payroll","m_433e848e538fe5","Add new") ?? "Add new")}</strong><small>${(globalThis.PlatformLanguage?.text("payroll","m_1050e39f362189","Create another commission recipient role") ?? "Create another commission recipient role")}</small></div><i class="fas fa-plus"></i></div><div class="pc-role-body"><input class="pc-input" data-pc-new-title placeholder="${(globalThis.PlatformLanguage?.text("payroll","m_3aa3842fbcac51","Role title, e.g. Estimator") ?? "Role title, e.g. Estimator")}"><button type="button" class="pc-btn primary" data-pc-new-role ${String(state.saving ? 'disabled' : '')}>${(globalThis.PlatformLanguage?.text("payroll","m_5470b926d9160c","Add role") ?? "Add role")}</button></div></section></div>${String(activity())}</div>`;
      bind();
    }
    function bind(){
      host.querySelectorAll('[data-pc-refresh]').forEach((button) => button.addEventListener('click', load));
      host.querySelectorAll('[data-pc-add]').forEach((button) => button.addEventListener('click', () => {
        const index = Number(button.dataset.pcAdd); const select = host.querySelector(`[data-pc-worker="${index}"]`); const worker = state.workers.find((item) => workerKey(item) === clean(select?.value));
        if (worker) saveRole(index, [...array(state.roles[index]?.payees), worker]);
      }));
      host.querySelectorAll('[data-pc-remove]').forEach((button) => button.addEventListener('click', () => {
        const [roleIndex,payeeIndex] = clean(button.dataset.pcRemove).split(':').map(Number); saveRole(roleIndex, array(state.roles[roleIndex]?.payees).filter((_item,index) => index !== payeeIndex));
      }));
      host.querySelectorAll('[data-pc-override]').forEach((button) => button.addEventListener('click', () => { state.overrideEntryId = clean(button.dataset.pcOverride); render(); }));
      host.querySelectorAll('[data-pc-override-cancel]').forEach((button) => button.addEventListener('click', () => { state.overrideEntryId = ''; render(); }));
      host.querySelector('[data-pc-override-form]')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (state.saving) return;
        const form = event.currentTarget; const data = new FormData(form); const entryId = clean(form.dataset.pcOverrideForm); const target = Math.max(0, Math.round(Number(data.get('amount') || 0) * 100)); const reason = clean(data.get('reason'));
        if (!entryId || !reason) return;
        state.saving = true; render();
        try {
          await PayrollAPI.projects.overrideCommission(orgId, projectId, { entry_id:entryId, target_amount_cents:target, reason, source_event_id:`manual_override:${entryId}:${Date.now()}` });
          state.overrideEntryId = ''; showToast((globalThis.PlatformLanguage?.text("payroll","m_3f2cfab584c5da","Commission override saved") ?? "Commission override saved"), (globalThis.PlatformLanguage?.text("payroll","m_713b694ba3a309","The payroll audit trail includes this adjustment.") ?? "The payroll audit trail includes this adjustment."), true); await load();
        } catch(error){ showToast((globalThis.PlatformLanguage?.text("payroll","m_a892f130d3e97d","Could not override commission") ?? "Could not override commission"), error?.message || 'Please try again.', false); }
        state.saving = false; render();
      });
      host.querySelector('[data-pc-new-role]')?.addEventListener('click', () => createRole(host.querySelector('[data-pc-new-title]')?.value));
    }
    load();
    return { destroy(){ state.destroyed = true; host.innerHTML = ''; }, setActive(active){ if (active && !state.loading) load(); } };
  }

  window.FirstMateProjectCommissions = { panelHtml, mount:createApp };
})();
