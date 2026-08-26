/* public/libraries/apps/proposals/global.js
 * Global Proposals portal tab.
 */
(function(){
  const Portal = window.Portal;
  const runtime = window.FirstMateEmbeddableApps;
  if (!Portal || !runtime?.registerApp) return;

  const util = Portal.util || {};
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const injectCSS = util.injectCSS || (() => {});
  const showToast = Portal.ui?.showToast || (() => {});

  const PAGE_SIZE = 12;

  function cleanText(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function proposalsFeatureEnabled(){
    const flags = Portal.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    if (flags.has?.('platform', 'proposals')) return true;
    const value = flags.value?.('platform', 'proposals', undefined);
    return typeof value === 'boolean' ? value : false;
  }

  function projectFromDocument(document){
    const data = document?.data && typeof document.data === 'object' ? document.data : null;
    if (!data) return null;
    const documentId = cleanText(document.id);
    const id = cleanText(data.platform_project_id, data.base_project_id, data.id, documentId);
    const title = cleanText(data.title, data.project_title, data.project_name, data.projectName, data.name);
    return {
      ...data,
      id,
      platform_project_id: cleanText(data.platform_project_id, id),
      base_project_id: cleanText(data.base_project_id, id),
      title: title || cleanText(data.address, id),
      project_title: cleanText(data.project_title, title),
      contacts: Array.isArray(data.contacts) ? data.contacts : [],
      events: Array.isArray(data.events) ? data.events : [],
      proposals: Array.isArray(data.proposals) ? data.proposals : []
    };
  }

  function projectId(project = {}){
    return cleanText(project.platform_project_id, project.base_project_id, project.id);
  }

  function primaryContact(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const contact = contacts.find((item) => item && typeof item === 'object') || {};
    return {
      name: cleanText(project.customer_name, project.customerName, project.primary_contact_name, contact.name),
      email: cleanText(project.customer_email, project.customerEmail, project.primary_contact_email, contact.email),
      phone: cleanText(project.customer_phone, project.customerPhone, project.primary_contact_phone, contact.phone)
    };
  }

  function eventTypeText(event = {}){
    return [
      event.event_type_default_id,
      event.event_type_id,
      event.eventTypeId,
      event.type,
      event.kind,
      event.title,
      event.name,
      event.id
    ].map((value) => cleanText(value).toLowerCase()).join(' ');
  }

  function isSalesAppointment(event = {}){
    const type = eventTypeText(event);
    return type.includes('sales_appointment') || type.includes('appointment');
  }

  function eventDateValue(event = {}){
    return cleanText(
      event.start_at,
      event.starts_at,
      event.startAt,
      event.start,
      event.start_time,
      event.scheduled_at,
      event.scheduled_for,
      event.date,
      event.appointment_at,
      event.appointmentAt
    );
  }

  function proposalActionAttrs(projectIndex, proposal, proposalIndex){
    return `data-gp-index="${projectIndex}" data-gp-proposal-index="${proposalIndex}" data-gp-proposal-id="${escapeHtml(proposalIdentity(proposal, proposalIndex))}"`;
  }

  function parseDate(value){
    const text = cleanText(value);
    if (!text) return null;
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function appointmentDate(project = {}){
    const events = Array.isArray(project.events) ? project.events : [];
    const appointmentEvents = events
      .filter((event) => event && typeof event === 'object' && isSalesAppointment(event))
      .map((event) => ({ event, date: parseDate(eventDateValue(event)) }))
      .filter((entry) => entry.date);
    if (appointmentEvents.length) {
      appointmentEvents.sort((a, b) => b.date.getTime() - a.date.getTime());
      return appointmentEvents[0].date;
    }
    return parseDate(project.appointment_at || project.appointmentAt || project.scheduled_at || project.created_at || project.updated_at) || new Date(0);
  }

  function dayKey(date){
    const d = date instanceof Date ? date : new Date(0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dayLabel(date){
    const d = date instanceof Date ? date : new Date(0);
    const today = new Date();
    const start = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (d.getTime() === 0) return 'No appointment date';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function proposalDisplayName(proposal = {}, index = 0){
    return cleanText(proposal.title, proposal.name, proposal.proposal_title, `Proposal ${String.fromCharCode(65 + (index % 26))}`);
  }

  function proposalStatus(proposal = {}){
    const status = cleanText(proposal.status, proposal.delivery_status, proposal.delivery?.status).toLowerCase();
    if (status === 'sent') return 'Sent';
    if (status === 'viewed') return 'Viewed';
    if (status === 'signed') return 'Signed';
    if (status === 'archived') return 'Archived';
    if (status === 'void') return 'Void';
    return 'Draft';
  }

  function normalizeRemoteProposal(apiProposal = {}, index = 0){
    const editable = apiProposal.editable && typeof apiProposal.editable === 'object' ? apiProposal.editable : {};
    return {
      ...editable,
      ...apiProposal,
      id: cleanText(apiProposal.id, editable.id, `proposal_${index}`),
      title: cleanText(apiProposal.title, editable.title, `Proposal ${String.fromCharCode(65 + (index % 26))}`),
      status: cleanText(apiProposal.status, editable.status, 'draft'),
      created_at: cleanText(apiProposal.created_at, editable.created_at),
      updated_at: cleanText(apiProposal.updated_at, editable.updated_at)
    };
  }

  function proposalIdentity(proposal = {}, index = 0){
    return cleanText(
      proposal.id,
      proposal.proposal_api_id,
      proposal.proposalApiId,
      proposal.backend_id,
      proposal.backendId,
      proposal.proposal_id,
      proposal.proposalId,
      `proposal_index_${index}`
    );
  }

  function renderProposalRows(proposals = [], projectIndex = 0){
    if (!proposals.length) {
      return '<div class="gp-empty-proposals">No proposals yet.</div>';
    }
    return proposals.map((proposal, index) => {
      const attrs = proposalActionAttrs(projectIndex, proposal, index);
      const key = `${projectIndex}:${proposalIdentity(proposal, index)}`;
      const menuOpen = window.__globalProposalsMenuKey === key;
      const deleteConfirm = window.__globalProposalsDeleteKey === key;
      return `
        <div class="gp-proposal-row" ${attrs}>
          <button type="button" class="gp-proposal-select" data-gp-action="preview" ${attrs}>
            <span class="gp-proposal-main">
              <i class="fas fa-file-signature"></i>
              <span>${escapeHtml(proposalDisplayName(proposal, index))}</span>
            </span>
          </button>
          <div class="gp-row-actions">
            <button type="button" class="gp-row-icon" data-gp-action="edit" ${attrs} data-fm-tooltip="Edit"><i class="fas fa-pen"></i></button>
            <button type="button" class="gp-row-icon" data-gp-action="send" ${attrs} data-fm-tooltip="Send"><i class="fas fa-paper-plane"></i></button>
            <span class="gp-more-wrap${menuOpen ? ' open' : ''}">
              <button type="button" class="gp-row-icon" data-gp-action="more-menu" ${attrs} data-fm-tooltip="More actions"><i class="fas fa-ellipsis"></i></button>
              <span class="gp-more-menu">
                <button type="button" data-gp-action="download" ${attrs}><i class="fas fa-download"></i><span>Download</span></button>
                <button type="button" data-gp-action="print" ${attrs}><i class="fas fa-print"></i><span>Print</span></button>
                <button type="button" data-gp-action="duplicate" ${attrs}><i class="fas fa-copy"></i><span>Duplicate</span></button>
                <button type="button" class="${deleteConfirm ? 'danger confirm' : 'danger'}" data-gp-action="delete" ${attrs}><i class="fas fa-trash"></i><span>${deleteConfirm ? 'Confirm delete' : 'Delete'}</span></button>
              </span>
            </span>
            <span class="gp-status">${escapeHtml(proposalStatus(proposal))}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderSkeleton(){
    return `
      <div class="gp-shell">
        <div class="gp-top">
          <div>
            <h2>Proposals</h2>
            <p>Projects grouped by appointment date.</p>
          </div>
          <button type="button" class="gp-refresh" data-gp-action="refresh" data-fm-tooltip="Refresh"><i class="fas fa-rotate-right"></i></button>
        </div>
        <div class="gp-body">
          <div class="gp-list" data-gp-list>
            <div class="gp-state"><i class="fas fa-circle-notch fa-spin"></i><span>Loading proposals...</span></div>
          </div>
          <div class="gp-preview" data-gp-preview>
            <div class="gp-preview-empty"><i class="fas fa-file-signature"></i><span>Select a proposal to preview it.</span></div>
          </div>
        </div>
      </div>
    `;
  }

  function installCss(){
    injectCSS('global_proposals_app', `
      .gp-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f6f8fb;color:#101828}
      .gp-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid #e4e7ec;background:#fff}
      .gp-top h2{margin:0;font-size:22px;line-height:1.15;font-weight:1000;color:#101828}
      .gp-top p{margin:4px 0 0;color:#667085;font-size:12px;font-weight:850}
      .gp-refresh{width:38px;height:38px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .gp-refresh:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);color:var(--primary-readable,var(--primary,#d93025))}
      .gp-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr)}
      .gp-list{min-height:0;overflow:auto;padding:14px 14px 24px;display:flex;flex-direction:column;gap:14px;border-right:1px solid #e4e7ec;background:#f8fafc}
      .gp-day{display:flex;flex-direction:column;gap:10px}
      .gp-day-head{position:sticky;top:-14px;z-index:2;display:flex;align-items:center;gap:10px;padding:8px 0;background:#f8fafc;color:#475467;font-size:12px;font-weight:1000}
      .gp-day-head:after{content:"";height:1px;background:#e4e7ec;flex:1}
      .gp-project{border:1px solid #e4e7ec;background:#fff;border-radius:8px;box-shadow:0 10px 24px rgba(16,24,40,.05);overflow:visible}
      .gp-project-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px;border-bottom:1px solid #edf0f5}
      .gp-project-title{min-width:0}
      .gp-project-title strong{display:block;font-size:13px;line-height:1.25;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gp-project-title span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gp-project-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
      .gp-icon-btn{width:32px;height:32px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .gp-icon-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .gp-icon-btn:hover{transform:translateY(-1px);box-shadow:0 10px 20px rgba(16,24,40,.08)}
      .gp-proposals{display:flex;flex-direction:column;position:relative}
      .gp-proposal-row{position:relative;width:100%;border-bottom:1px solid #f0f2f5;background:#fff;display:flex;align-items:center;gap:3px;color:#344054}
      .gp-proposal-row:hover{background:#fbfcfe;color:#101828}
      .gp-proposal-row.active{background:color-mix(in srgb,var(--primary,#d93025) 9%,#fff);color:#101828}
      .gp-proposal-row:last-child{border-bottom:0}
      .gp-proposal-select{appearance:none;min-width:0;flex:1;border:0;background:transparent;padding:9px 0 9px 11px;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;cursor:pointer;color:inherit}
      .gp-proposal-main{min-width:0;display:flex;align-items:center;gap:9px;font-size:12px;font-weight:950}
      .gp-proposal-main span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gp-proposal-main i{color:var(--primary-readable,var(--primary,#d93025));font-size:13px}
      .gp-status{border:1px solid #e4e7ec;background:#f8fafc;border-radius:999px;padding:3px 7px;color:#667085;font-size:10px;font-weight:1000;flex-shrink:0;margin-left:2px}
      .gp-row-actions{flex:0 0 auto;display:flex;align-items:center;gap:1px;padding-right:7px}
      .gp-row-icon{width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .gp-row-icon:hover{background:#f2f4f7;color:#101828}
      .gp-row-icon i{font-size:11px}
      .gp-more-wrap{position:relative;display:inline-flex}
      .gp-more-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:152px;border:1px solid #e4e7ec;border-radius:8px;background:#fff;box-shadow:0 18px 34px rgba(16,24,40,.16);padding:5px;display:none}
      .gp-more-wrap.open .gp-more-menu{display:flex;flex-direction:column;gap:2px}
      .gp-more-menu button{width:100%;border:0;border-radius:7px;background:transparent;color:#344054;padding:8px 9px;display:flex;align-items:center;gap:8px;text-align:left;font-size:12px;font-weight:900;cursor:pointer}
      .gp-more-menu button:hover{background:#f8fafc;color:#101828}
      .gp-more-menu button.danger{color:#b42318}
      .gp-more-menu button.confirm{background:#fff1f0;color:#981b1b}
      .gp-empty-proposals{padding:13px 16px;color:#667085;font-size:12px;font-weight:850}
      .gp-state{min-height:220px;display:flex;align-items:center;justify-content:center;gap:9px;color:#667085;font-size:13px;font-weight:900}
      .gp-load-more{align-self:center;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;padding:10px 14px;font-size:12px;font-weight:1000;cursor:pointer}
      .gp-load-more:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);color:var(--primary-readable,var(--primary,#d93025))}
      .gp-preview{min-width:0;min-height:0;display:flex;flex-direction:column;background:#d6d8dc}
      .gp-preview-head{flex:0 0 auto;min-height:64px;padding:12px 16px;background:#fff;border-bottom:1px solid #e4e7ec;display:flex;align-items:center;justify-content:space-between;gap:14px}
      .gp-preview-title{min-width:0}
      .gp-preview-title strong{display:block;font-size:14px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gp-preview-title span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gp-preview-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
      .gp-action-btn{border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;min-height:36px;padding:0 12px;font-size:12px;font-weight:1000;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
      .gp-action-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .gp-action-btn:hover{transform:translateY(-1px);box-shadow:0 10px 20px rgba(16,24,40,.08)}
      .gp-preview-stage{flex:1;min-height:0}
      .gp-preview-empty{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#667085;font-size:13px;font-weight:900;text-align:center;background:#f6f8fb}
      .gp-preview-empty i{font-size:24px;color:#98a2b3}
      @media (max-width:760px){
        .gp-top{padding:16px}
        .gp-body{grid-template-columns:1fr;grid-template-rows:42% 58%}
        .gp-list{padding:14px 12px 22px;border-right:0;border-bottom:1px solid #e4e7ec}
        .gp-project-head{align-items:stretch;flex-direction:column}
        .gp-project-actions{justify-content:flex-end}
        .gp-preview-head{align-items:stretch;flex-direction:column}
        .gp-preview-actions{justify-content:flex-end}
      }
    `);
  }

  function createApp(context = {}){
    const root = context.root || context.roots?.main || context.panelRoot;
    const state = {
      root,
      projects: [],
      visibleCount: PAGE_SIZE,
      loading: false,
      destroyed: false,
      projectProposalLoads: new Map(),
      projectDetailLoads: new Map(),
      selected: null,
      openMenuKey: '',
      pendingDeleteKey: '',
      actionBusy: false
    };

    function mergeProjectDetails(base = {}, incoming = {}){
      const merged = { ...base, ...incoming };
      ['contacts', 'photos', 'events'].forEach((key) => {
        const baseList = Array.isArray(base[key]) ? base[key] : [];
        const incomingList = Array.isArray(incoming[key]) ? incoming[key] : [];
        merged[key] = incomingList.length >= baseList.length ? incomingList : baseList;
      });
      const baseProposals = Array.isArray(base.proposals) ? base.proposals : [];
      const incomingProposals = Array.isArray(incoming.proposals) ? incoming.proposals : [];
      merged.proposals = baseProposals.length ? baseProposals : incomingProposals;
      merged._appointmentDate = base._appointmentDate || incoming._appointmentDate || appointmentDate(merged);
      merged._detailsLoaded = true;
      return merged;
    }

    async function loadRemoteProposals(project){
      const oid = cleanText(context.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
      const pid = projectId(project);
      if (!oid || !pid || !window.ProposalsAPI?.projects?.list) return Array.isArray(project.proposals) ? project.proposals : [];
      if (state.projectProposalLoads.has(pid)) return state.projectProposalLoads.get(pid);
      const promise = window.ProposalsAPI.projects.list(oid, pid)
        .then((result) => {
          const remote = Array.isArray(result?.proposals) ? result.proposals.map(normalizeRemoteProposal) : [];
          if (remote.length || !Array.isArray(project.proposals)) project.proposals = remote;
          return project.proposals || [];
        })
        .catch(() => Array.isArray(project.proposals) ? project.proposals : []);
      state.projectProposalLoads.set(pid, promise);
      return promise;
    }

    async function hydrateProjectDetails(index){
      const project = state.projects[index];
      const oid = cleanText(context.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
      const pid = projectId(project);
      if (!project || project._detailsLoaded || !oid || !pid || !window.PlatformAPI?.projects?.get) return project;
      if (state.projectDetailLoads.has(pid)) return state.projectDetailLoads.get(pid);
      const promise = window.PlatformAPI.projects.get(oid, pid)
        .then((result) => {
          const incoming = projectFromDocument(result?.document);
          if (!incoming) return project;
          const current = state.projects[index] || project;
          const merged = mergeProjectDetails(current, incoming);
          state.projects[index] = merged;
          return merged;
        })
        .catch(() => project);
      state.projectDetailLoads.set(pid, promise);
      return promise;
    }

    async function loadProjects(){
      const oid = cleanText(context.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
      if (!oid || !window.PlatformAPI?.projects?.list) {
        state.projects = [];
        render();
        return;
      }
      state.loading = true;
      state.projectDetailLoads.clear();
      render();
      try {
        const result = await window.PlatformAPI.projects.list(oid);
        const docs = Array.isArray(result?.documents) ? result.documents : [];
        state.projects = docs.map(projectFromDocument).filter(Boolean)
          .map((project) => ({ ...project, _appointmentDate: appointmentDate(project) }))
          .sort((a, b) => b._appointmentDate.getTime() - a._appointmentDate.getTime());
        state.visibleCount = PAGE_SIZE;
      } catch (error) {
        console.warn('Global proposals load failed', error);
        showToast('Could not load proposals', error?.message || 'Project list unavailable.', false);
        state.projects = [];
      } finally {
        state.loading = false;
        render();
        hydrateVisibleProposals();
      }
    }

    async function hydrateVisibleProposals(){
      const visible = state.projects.slice(0, state.visibleCount);
      await Promise.all(visible.map(loadRemoteProposals));
      ensureSelection();
      if (!state.destroyed) render();
    }

    function openProject(index, intent = {}){
      const project = state.projects[index];
      if (!project) return;
      if (!Portal.modules?.request?.openProject) {
        showToast('Project unavailable', 'Project workspace is not ready yet.', false);
        return;
      }
      Portal.modules.request.openProject(project, {
        tab: 'proposal',
        proposalIntent: intent
      });
    }

    function selectedProposalRef(){
      const selected = state.selected;
      if (!selected) return null;
      const project = state.projects[selected.projectIndex];
      const proposals = Array.isArray(project?.proposals) ? project.proposals : [];
      const proposal = proposals[selected.proposalIndex];
      if (!project || !proposal) return null;
      const selectedId = cleanText(selected.proposalId);
      if (selectedId && proposalIdentity(proposal, selected.proposalIndex) !== selectedId) {
        const foundIndex = proposals.findIndex((item, index) => proposalIdentity(item, index) === selectedId);
        if (foundIndex >= 0) {
          state.selected = { projectIndex: selected.projectIndex, proposalIndex: foundIndex, proposalId: selectedId };
          return { project, proposal: proposals[foundIndex], projectIndex: selected.projectIndex, proposalIndex: foundIndex, proposalId: selectedId };
        }
      }
      return { project, proposal, projectIndex: selected.projectIndex, proposalIndex: selected.proposalIndex, proposalId: proposalIdentity(proposal, selected.proposalIndex) };
    }

    function ensureSelection(){
      if (selectedProposalRef()) return true;
      for (let projectIndex = 0; projectIndex < Math.min(state.visibleCount, state.projects.length); projectIndex += 1) {
        const proposals = Array.isArray(state.projects[projectIndex]?.proposals) ? state.projects[projectIndex].proposals : [];
        if (proposals.length) {
          state.selected = { projectIndex, proposalIndex: 0, proposalId: proposalIdentity(proposals[0], 0) };
          return true;
        }
      }
      state.selected = null;
      return false;
    }

    function selectProposal(projectIndex, proposalIndex, proposalId = ''){
      const project = state.projects[projectIndex];
      const proposals = Array.isArray(project?.proposals) ? project.proposals : [];
      const proposal = proposals[proposalIndex];
      if (!proposal) return;
      state.selected = {
        projectIndex,
        proposalIndex,
        proposalId: cleanText(proposalId, proposalIdentity(proposal, proposalIndex))
      };
      syncSelectedRows();
      renderPreview();
    }

    function editSelectedProposal(){
      const selected = selectedProposalRef();
      if (!selected) return;
      openProject(selected.projectIndex, {
        action: 'edit',
        proposalId: selected.proposalId,
        proposalIndex: selected.proposalIndex
      });
    }

    function proposalKey(projectIndex, proposal, proposalIndex){
      return `${projectIndex}:${proposalIdentity(proposal, proposalIndex)}`;
    }

    function proposalRefFromButton(button){
      const projectIndex = Number(button.dataset.gpIndex || 0);
      const proposalIndex = Number(button.dataset.gpProposalIndex || 0);
      const project = state.projects[projectIndex];
      const proposals = Array.isArray(project?.proposals) ? project.proposals : [];
      const proposalId = cleanText(button.dataset.gpProposalId || '');
      let index = proposalIndex;
      if (proposalId) {
        const found = proposals.findIndex((item, itemIndex) => proposalIdentity(item, itemIndex) === proposalId);
        if (found >= 0) index = found;
      }
      const proposal = proposals[index];
      if (!project || !proposal) return null;
      return { project, proposal, projectIndex, proposalIndex: index, proposalId: proposalIdentity(proposal, index), key: proposalKey(projectIndex, proposal, index) };
    }

    async function runGlobalProposalAction(button, action){
      const ref = proposalRefFromButton(button);
      if (!ref || state.actionBusy) return;
      state.openMenuKey = '';
      if (action !== 'delete') state.pendingDeleteKey = '';
      const hydratedProject = await hydrateProjectDetails(ref.projectIndex);
      const current = proposalRefFromButton(button) || ref;
      const project = hydratedProject || current.project;
      const proposals = Array.isArray(project?.proposals) ? project.proposals : [];
      const proposal = proposals[current.proposalIndex] || current.proposal;
      const tab = Portal.modules?.proposalsTab || Portal.ProposalsTab || null;
      if (!tab?.invoke) {
        showToast('Proposal unavailable', 'Proposal tools are not ready yet.', false);
        return;
      }
      state.actionBusy = true;
      try {
        const result = await tab.invoke('runReadOnlyProposalAction', [{
          action,
          project,
          proposal,
          proposalIndex: current.proposalIndex
        }]);
        if (Array.isArray(result?.proposals)) {
          state.projects[current.projectIndex].proposals = result.proposals;
          const nextIndex = Math.max(0, Math.min(Number(result.activeProposalIndex || 0) || 0, result.proposals.length - 1));
          if (result.proposals.length) {
            state.selected = {
              projectIndex: current.projectIndex,
              proposalIndex: nextIndex,
              proposalId: proposalIdentity(result.proposals[nextIndex], nextIndex)
            };
          } else {
            state.selected = null;
          }
          render();
        } else if (action === 'print' || action === 'download') {
          syncSelectedRows();
        }
      } catch (error) {
        console.warn(`Global proposal ${action} failed`, error);
        showToast('Proposal action failed', error?.message || 'Could not complete this proposal action.', false);
      } finally {
        state.actionBusy = false;
      }
    }

    function renderPreview(){
      const preview = state.root?.querySelector('[data-gp-preview]');
      if (!preview) return;
      const selected = selectedProposalRef();
      if (!selected) {
        preview.innerHTML = '<div class="gp-preview-empty"><i class="fas fa-file-signature"></i><span>Select a proposal to preview it.</span></div>';
        return;
      }
      const selectionKey = `${selected.projectIndex}:${selected.proposalId || selected.proposalIndex}`;
      hydrateProjectDetails(selected.projectIndex).then((updatedProject) => {
        const current = selectedProposalRef();
        const currentKey = current ? `${current.projectIndex}:${current.proposalId || current.proposalIndex}` : '';
        if (!state.destroyed && updatedProject && currentKey === selectionKey && updatedProject !== selected.project) renderPreview();
      });
      const contact = primaryContact(selected.project);
      const projectTitle = cleanText(selected.project.title, selected.project.project_title, selected.project.address, 'Project');
      const subtitle = [projectTitle, selected.project.address, contact.name].filter(Boolean).join(' - ');
      const proposalTitle = proposalDisplayName(selected.proposal, selected.proposalIndex);
      preview.innerHTML = `
        <div class="gp-preview-head">
          <div class="gp-preview-title">
            <strong>${escapeHtml(proposalTitle)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <div class="gp-preview-actions">
            <button type="button" class="gp-action-btn primary" data-gp-action="edit-selected"><i class="fas fa-pen"></i><span>Edit</span></button>
          </div>
        </div>
        <div class="gp-preview-stage" data-gp-preview-root></div>
      `;
      const previewRoot = preview.querySelector('[data-gp-preview-root]');
      const tab = Portal.modules?.proposalsTab || Portal.ProposalsTab || null;
      const rendered = tab?.invoke?.('renderReadOnlyPreview', [{
        root: previewRoot,
        project: selected.project,
        proposal: selected.proposal,
        proposalIndex: selected.proposalIndex
      }]);
      if (!rendered && previewRoot) {
        previewRoot.innerHTML = '<div class="gp-preview-empty"><i class="fas fa-eye-slash"></i><span>Preview unavailable for this proposal.</span></div>';
      }
    }

    function groupedVisibleProjects(){
      const groups = [];
      const byKey = new Map();
      state.projects.slice(0, state.visibleCount).forEach((project, index) => {
        const date = project._appointmentDate || appointmentDate(project);
        const key = dayKey(date);
        if (!byKey.has(key)) {
          const group = { key, date, label: dayLabel(date), items: [] };
          byKey.set(key, group);
          groups.push(group);
        }
        byKey.get(key).items.push({ project, index });
      });
      return groups;
    }

    function renderProjectCard(project, index){
      const contact = primaryContact(project);
      const title = cleanText(project.title, project.project_title, project.address, `Project ${index + 1}`);
      const subtitle = [cleanText(project.address), contact.name].filter(Boolean).join(' - ');
      const proposalList = Array.isArray(project.proposals) ? project.proposals : [];
      return `
        <article class="gp-project">
          <div class="gp-project-head">
            <div class="gp-project-title">
              <strong>${escapeHtml(title)}</strong>
              <span>${escapeHtml(subtitle || projectId(project) || 'Project')}</span>
            </div>
            <div class="gp-project-actions">
              <button type="button" class="gp-icon-btn primary" data-gp-action="add" data-gp-index="${index}" data-fm-tooltip="Add proposal"><i class="fas fa-plus"></i></button>
              <button type="button" class="gp-icon-btn" data-gp-action="open" data-gp-index="${index}" data-fm-tooltip="Open proposals"><i class="fas fa-up-right-from-square"></i></button>
            </div>
          </div>
          <div class="gp-proposals">${renderProposalRows(proposalList, index)}</div>
        </article>
      `;
    }

    function renderList(){
      if (state.loading && !state.projects.length) return '<div class="gp-state"><i class="fas fa-circle-notch fa-spin"></i><span>Loading proposals...</span></div>';
      if (!state.projects.length) return '<div class="gp-state"><span>No appointment projects found.</span></div>';
      const groups = groupedVisibleProjects();
      const body = groups.map((group) => `
        <section class="gp-day">
          <div class="gp-day-head">${escapeHtml(group.label)}</div>
          ${group.items.map(({ project, index }) => renderProjectCard(project, index)).join('')}
        </section>
      `).join('');
      const more = state.visibleCount < state.projects.length
        ? '<button type="button" class="gp-load-more" data-gp-action="more">Load more</button>'
        : '';
      return body + more;
    }

    function syncSelectedRows(){
      state.root?.querySelectorAll('.gp-proposal-row').forEach((row) => {
        const selected = state.selected;
        row.classList.toggle('active', !!selected
          && Number(row.dataset.gpIndex || -1) === selected.projectIndex
          && Number(row.dataset.gpProposalIndex || -1) === selected.proposalIndex);
      });
    }

    function render(){
      if (!state.root || state.destroyed) return;
      installCss();
      if (!state.root.querySelector('.gp-shell')) state.root.innerHTML = renderSkeleton();
      ensureSelection();
      window.__globalProposalsMenuKey = state.openMenuKey;
      window.__globalProposalsDeleteKey = state.pendingDeleteKey;
      const list = state.root.querySelector('[data-gp-list]');
      if (list) {
        list.innerHTML = renderList();
        list.onscroll = onScroll;
      }
      syncSelectedRows();
      renderPreview();
      window.PlatformUI?.initTooltips?.(state.root);
    }

    function showMoreProjects(){
      if (state.visibleCount >= state.projects.length) return;
      state.visibleCount += PAGE_SIZE;
      render();
      hydrateVisibleProposals();
    }

    function onScroll(event){
      const list = event.currentTarget;
      if (!list || state.loading || state.visibleCount >= state.projects.length) return;
      const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (remaining < 280) showMoreProjects();
    }

    function onClick(event){
      const button = event.target.closest('[data-gp-action]');
      if (!button || !state.root?.contains(button)) return;
      const action = button.dataset.gpAction;
      if (action === 'refresh') {
        state.projectProposalLoads.clear();
        state.projectDetailLoads.clear();
        state.openMenuKey = '';
        state.pendingDeleteKey = '';
        loadProjects();
        return;
      }
      if (action === 'more') {
        showMoreProjects();
        return;
      }
      if (action === 'preview') {
        state.openMenuKey = '';
        state.pendingDeleteKey = '';
        selectProposal(
          Number(button.dataset.gpIndex || 0),
          Number(button.dataset.gpProposalIndex || 0),
          button.dataset.gpProposalId || ''
        );
        return;
      }
      if (action === 'add') {
        state.openMenuKey = '';
        state.pendingDeleteKey = '';
        openProject(Number(button.dataset.gpIndex || 0), { action: 'create' });
        return;
      }
      if (action === 'edit-selected') {
        editSelectedProposal();
        return;
      }
      if (action === 'edit') {
        state.openMenuKey = '';
        state.pendingDeleteKey = '';
        openProject(Number(button.dataset.gpIndex || 0), {
          action: 'edit',
          proposalId: button.dataset.gpProposalId || '',
          proposalIndex: Number(button.dataset.gpProposalIndex || 0)
        });
        return;
      }
      if (action === 'send') {
        state.openMenuKey = '';
        state.pendingDeleteKey = '';
        openProject(Number(button.dataset.gpIndex || 0), {
          action: 'send',
          proposalId: button.dataset.gpProposalId || '',
          proposalIndex: Number(button.dataset.gpProposalIndex || 0)
        });
        return;
      }
      if (action === 'download' || action === 'print' || action === 'duplicate') {
        runGlobalProposalAction(button, action);
        return;
      }
      if (action === 'more-menu') {
        const ref = proposalRefFromButton(button);
        state.openMenuKey = state.openMenuKey === ref?.key ? '' : (ref?.key || '');
        render();
        return;
      }
      if (action === 'delete') {
        const ref = proposalRefFromButton(button);
        if (!ref) return;
        if (state.pendingDeleteKey !== ref.key) {
          state.pendingDeleteKey = ref.key;
          state.openMenuKey = ref.key;
          render();
          return;
        }
        state.pendingDeleteKey = '';
        runGlobalProposalAction(button, 'delete');
        return;
      }
      if (action === 'open') {
        state.openMenuKey = '';
        state.pendingDeleteKey = '';
        openProject(Number(button.dataset.gpIndex || 0), { action: 'list' });
      }
    }

    state.root?.addEventListener('click', onClick);
    render();
    loadProjects();

    return {
      destroy(){
        state.destroyed = true;
        const list = state.root?.querySelector('[data-gp-list]');
        if (list) list.onscroll = null;
        state.root?.removeEventListener('click', onClick);
        delete window.__globalProposalsMenuKey;
        delete window.__globalProposalsDeleteKey;
      },
      setActive(active){
        if (active) loadProjects();
      }
    };
  }

  runtime.registerApp({
    id: 'portal.proposals',
    package: 'proposals',
    kind: 'portal_tab',
    title: 'Proposals',
    label: 'Proposals',
    icon: 'fa-file-signature',
    order: 25,
    surfaces: ['portal_tab'],
    regions: ['main'],
    visible: true,
    fullBleed: true,
    enabled: () => proposalsFeatureEnabled(),
    mount: createApp
  });
})();
