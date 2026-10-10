/* public/libraries/apps/contacts/modal.js
 * Contact overview modal and contact-mode project navigation.
 */
(function(){
  if (!window.Portal) return;

  const shellReady=window.FirstMateWindowShell?Promise.resolve():import(new URL('../../window-manager/window-shell.js?v=20260930-v1',document.currentScript?.src||location.origin+'/libraries/apps/contacts/modal.js').href);
  const cfg = window.Portal.cfg || {};
  const state = {
    open: false,
    contact: {},
    originalContact: {},
    contactRecord: null,
    saved: false,
    projects: [],
    loading: false,
    handle: null,
    addressAutocomplete: null,
    addressAutocompleteInput: null,
    catalog: [],
    trackTimeZones: false,
    relationshipMode: '',
    relationshipType: '',
    relationshipNames: {},
    relationshipContacts: {},
    returnToContact: null,
    mediaTab: false,
    docsTab: false,
    mediaLoading: false,
    todoController: null,
    secondaryPhoneOpen: false
  };
  let contactWindow = null;
  let contactShell=null,contactPanes=null,contactTrays=null;
  let saveTimer=null, savePromise=null, revision=0, savedRevision=0;
  let draftMedia=[];

  function $(selector, root = document){ return root.querySelector(selector); }
  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }
  function escapeHtml(value){
    return cleanText(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
  const phoneLabels=['home','cell','work','other'];
  const timeZones=typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):['America/Los_Angeles','America/Denver','America/Chicago','America/New_York','UTC'];
  function nameParts(contact={}){
    const first=cleanText(contact.first_name),last=cleanText(contact.last_name);
    if(first||last)return {first,last};
    const full=cleanText(contact.name),split=full.lastIndexOf(' ');
    return split>0?{first:full.slice(0,split),last:full.slice(split+1)}:{first:full,last:''};
  }
  function phoneLabelOptions(){
    return `<option value="">Label…</option>${phoneLabels.map(label=>`<option value="${label}">${label[0].toUpperCase()+label.slice(1)}</option>`).join('')}`;
  }
  function formatPhone(value){
    const raw=cleanText(value),digits=raw.replace(/\D/g,'');
    if(raw.startsWith('+') && !(digits.length===11 && digits[0]==='1'))return raw;
    if(digits.length>11)return raw;
    if(digits.length===11 && digits[0]==='1')return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
    if(digits.length>10)return raw;
    if(digits.length>7)return `(${digits.slice(0,3)}) ${digits.slice(3,6)}${digits.length>6?'-'+digits.slice(6):''}`;
    if(digits.length>3)return `${digits.slice(0,3)}-${digits.slice(3)}`;
    return digits;
  }
  function validPhone(value){
    const phone=cleanText(value),digits=phone.replace(/\D/g,'');
    return !phone || (/^[+\d\s().-]+$/.test(phone) && digits.length>=7 && digits.length<=15);
  }
  function formatPhoneInput(input){
    if(!input)return;
    const before=input.value,position=input.selectionStart ?? before.length;
    const digitOffset=before.slice(0,position).replace(/\D/g,'').length;
    const formatted=formatPhone(before);
    if(formatted===before)return;
    input.value=formatted;
    let cursor=0,digits=0;
    while(cursor<formatted.length && digits<digitOffset){if(/\d/.test(formatted[cursor]))digits++;cursor++;}
    input.setSelectionRange(cursor,cursor);
  }
  function orgId(){
    return firstText(cfg.userOrgId, cfg.orgId, window.__APP?.userOrgId);
  }
  function projectId(project = {}){
    project=project || {};
    return firstText(project.id, project.platform_project_id, project.base_project_id);
  }
  function projectTitle(project = {}){
    return firstText(project.title, project.project_title, project.project_name, project.projectName, project.address, 'Project');
  }
  function contactTitle(contact = {}){
    return firstText(contact.name, contact.email, contact.phone, contact.address, 'New Contact');
  }
  function contactHasLookupIdentity(contact = {}){
    return !!(
      firstText(contact.id, contact.project_id, contact.primary_project_id)
      || (Array.isArray(contact.project_ids) && contact.project_ids.some(cleanText))
    );
  }
  function ensureContactId(contact = {}){
    return firstText(contact.id, contact.contact_id) || `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  function isContactRecordProject(project = {}){
    return cleanText(project.workflow_state).toLowerCase() === 'contact_only';
  }
  function primaryContact(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const contact = contacts.find((item) => firstText(item?.name, item?.email, item?.phone)) || {};
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    return {
      id: firstText(contact.id, contact.contact_id, project.contact_id, project.primary_contact_id),
      name: firstText(contact.name, project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === 'string' ? project.resident : '', customer.name, resident.name),
      first_name:firstText(contact.first_name),last_name:firstText(contact.last_name),time_zone:firstText(contact.time_zone),
      email: firstText(contact.email, project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail, customer.email, resident.email),
      phone: firstText(contact.phone, project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone, customer.phone, resident.phone),
      address: firstText(contact.address, contact.default_address, project.contact_address, project.customer_address, project.primary_contact_address, customer.address, resident.address),
      company: firstText(contact.company),
      notes: firstText(contact.notes),
      birthday: firstText(contact.birthday),
      contact_kind: firstText(contact.contact_kind, 'human'),
      profile_media_id: firstText(contact.profile_media_id),
      tags: Array.isArray(contact.tags) ? contact.tags.map(cleanText).filter(Boolean) : [],
      imported_at: firstText(contact.imported_at),
      import_id: firstText(contact.import_id),
      import_source: firstText(contact.import_source),
      custom_field_values: {
        ...(project.contact_custom_field_values && typeof project.contact_custom_field_values === 'object' ? project.contact_custom_field_values : {}),
        ...(contact.custom_field_values && typeof contact.custom_field_values === 'object' ? contact.custom_field_values : {})
      }
    };
  }
  function normalizeContact(contact = {}, fallbackProject = null){
    const projectContact = fallbackProject ? primaryContact(fallbackProject) : {};
    return {
      id: firstText(contact.id, contact.contact_id, projectContact.id),
      project_id: firstText(contact.project_id, fallbackProject && projectId(fallbackProject)),
      project_ids: Array.isArray(contact.project_ids) ? contact.project_ids.map(cleanText).filter(Boolean) : [],
      name: firstText(contact.name, contact.customer_name, projectContact.name),
      first_name:firstText(contact.first_name,projectContact.first_name),last_name:firstText(contact.last_name,projectContact.last_name),time_zone:firstText(contact.time_zone,projectContact.time_zone),
      email: firstText(contact.email, projectContact.email),
      phone: firstText(contact.phone, projectContact.phone),
      address: firstText(contact.address, contact.default_address, contact.contact_address, projectContact.address, fallbackProject?.contact_address, fallbackProject?.customer_address, fallbackProject?.primary_contact_address, fallbackProject?.workflow_state === 'contact_only' ? fallbackProject?.address : ''),
      company: firstText(contact.company, projectContact.company),
      notes: firstText(contact.notes, projectContact.notes),
      birthday: firstText(contact.birthday, projectContact.birthday),
      record_project_id: firstText(contact.record_project_id, fallbackProject && projectId(fallbackProject)),
      contact_kind: firstText(contact.contact_kind, projectContact.contact_kind, 'human'),
      profile_media_id: firstText(contact.profile_media_id, projectContact.profile_media_id),
      tags: Array.isArray(contact.tags) && contact.tags.length
        ? contact.tags.map(cleanText).filter(Boolean)
        : (Array.isArray(projectContact.tags) ? projectContact.tags : []),
      imported_at: firstText(contact.imported_at, projectContact.imported_at),
      import_id: firstText(contact.import_id, projectContact.import_id),
      import_source: firstText(contact.import_source, projectContact.import_source),
      custom_field_values: {
        ...(fallbackProject?.contact_custom_field_values && typeof fallbackProject.contact_custom_field_values === 'object' ? fallbackProject.contact_custom_field_values : {}),
        ...(projectContact.custom_field_values && typeof projectContact.custom_field_values === 'object' ? projectContact.custom_field_values : {}),
        ...(contact.custom_field_values && typeof contact.custom_field_values === 'object' ? contact.custom_field_values : {})
      }
    };
  }
  function contactTokens(contact = {}){
    return {
      ids: [contact.project_id, contact.primary_project_id, ...(Array.isArray(contact.project_ids) ? contact.project_ids : [])].map(cleanText).filter(Boolean),
      contactId: firstText(contact.id, contact.contact_id)
    };
  }
  function contactSemanticKey(contact = {}){
    const email = cleanText(contact.email).toLowerCase();
    if (email) return `email:${email}`;
    const phone = cleanText(contact.phone).replace(/\D+/g, '');
    if (phone.length >= 7) return `phone:${phone}`;
    const name = cleanText(contact.name).toLowerCase().replace(/\s+/g, ' ');
    return name ? `name:${name}` : '';
  }
  function contactHasContent(contact = {}){
    return !!firstText(contact.name, contact.email, contact.phone, contact.address, contact.default_address);
  }
  function projectContactTokens(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const aliases = [primaryContact(project), ...contacts];
    return aliases.map((contact) => ({
      id: firstText(contact?.id, contact?.contact_id)
    })).filter((contact) => contact.id);
  }
  function contactMatchesProject(contact = {}, project = {}){
    const tokens = contactTokens(contact);
    const id = projectId(project);
    if (id && tokens.ids.includes(id)) return true;
    const projectContactIds = [
      project.contact_id,
      project.primary_contact_id,
      ...(Array.isArray(project.contact_ids) ? project.contact_ids : [])
    ].map(cleanText).filter(Boolean);
    if (tokens.contactId && projectContactIds.includes(tokens.contactId)) return true;
    return projectContactTokens(project).some((row) => tokens.contactId && row.id && tokens.contactId === row.id);
  }
  function dedupeProjects(projects = []){
    const out = [];
    const seen = new Set();
    projects.forEach((project) => {
      if (!project || typeof project !== 'object') return;
      const id = projectId(project);
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ ...project, id });
    });
    return out;
  }
  function visibleProjects(projects = state.projects){
    return dedupeProjects(projects).filter((project) => !isContactRecordProject(project));
  }
  function projectFromDocument(doc = {}){
    const data = doc?.data && typeof doc.data === 'object' ? doc.data : {};
    const id = firstText(data.platform_project_id, data.base_project_id, data.id, doc.id);
    return id ? { ...data, id, platform_project_id: firstText(data.platform_project_id, id), base_project_id: firstText(data.base_project_id, id) } : null;
  }
  async function loadContactProjectSummaries(contact = {}){
    const oid = orgId();
    if (!oid || !window.PlatformAPI?.projects?.listForContact) return [];
    const result = await window.PlatformAPI.projects.listForContact(oid, contact);
    return (result.documents || []).map(projectFromDocument).filter(Boolean);
  }
  async function loadAllProjects(){
    const cached = (window.Portal.ProjectStore?.cachedIds?.() || [])
      .map((id) => window.Portal.ProjectStore?.get?.(id))
      .filter(Boolean);
    const oid = orgId();
    if (!oid || !window.PlatformAPI?.projects?.list) return dedupeProjects(cached);
    const result = await window.PlatformAPI.projects.list(oid).catch(() => ({ documents: [] }));
    const remote = (result.documents || []).map(projectFromDocument).filter(Boolean);
    remote.forEach((project) => window.Portal.ProjectStore?.cache?.(project));
    return dedupeProjects([...cached, ...remote]);
  }
  async function loadContactProjects(contact, provided = [], options = {}){
    const providedProjects = Array.isArray(provided) ? provided : [];
    if (options.complete && providedProjects.length) return dedupeProjects(providedProjects);
    let remote = [];
    try {
      remote = await loadContactProjectSummaries(contact);
    } catch (error) {
      remote = [];
    }
    if (!remote.length && !providedProjects.length) remote = await loadAllProjects();
    const source = dedupeProjects([...providedProjects, ...remote]);
    const matches = source.filter((project) => contactMatchesProject(contact, project) && !isContactRecordProject(project));
    return dedupeProjects(matches);
  }
  function injectCSS(){
    if (document.getElementById('fm-contact-modal-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-contact-modal-css';
    style.textContent = `
      .fm-contact-overlay{position:fixed;inset:0;z-index:2147483100;background:rgba(11,16,24,.58);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;opacity:0;transition:opacity .22s ease}
      .fm-contact-overlay.active{display:flex;opacity:1}
      #fmContactGallery[hidden],#fmContactProjects[hidden],#fmContactNewProject[hidden],#fmContactProjectCount[hidden]{display:none!important}#fmContactCustomFields{display:contents}.fm-contact-fields{align-content:start;grid-auto-rows:max-content}.fm-contact-profile{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:16px}.fm-contact-profile-image{width:100px;height:100px;object-fit:cover;border-radius:10px}.fm-contact-tabs{display:flex;gap:8px;padding:0 18px;margin-bottom:12px}#fmContactGallery{min-width:0;overflow:auto;flex:1;padding:0 18px 18px}
      .fm-contact-win{width:min(1480px,94vw);height:min(940px,90vh);background:#fff;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:flex;flex-direction:column;position:relative}
       .fm-contact-window-header{min-height:36px;border-bottom:1px solid rgba(15,23,42,.10);background:#fff;flex:0 0 auto}
      .fm-contact-window-identity{display:flex;align-items:center;gap:9px;min-width:0;flex:1;padding:0 16px;color:#101828;font-size:13px;font-weight:1000}
      .fm-contact-window-identity i,.fm-contact-title-icon{color:var(--primary-readable,var(--primary,#d93025));flex:0 0 auto}
      .fm-contact-window-identity span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fm-contact-content{display:flex;flex:1;min-height:0;min-width:0}
      .fm-contact-photo-tile{width:100px;height:100px;border:1px dashed #cfd5df;border-radius:10px;background:#f8fafc;color:#667085;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;padding:0;overflow:hidden;font:inherit;font-size:12px}.fm-contact-photo-tile img{width:100%;height:100%;object-fit:cover}.fm-contact-photo-remove{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#667085;cursor:pointer}.fm-contact-photo-remove:hover{background:#f2f4f7;color:#b42318}.fm-contact-tabs{padding:12px 20px;margin:0;gap:8px;flex:0 0 auto;background:#fff;border-bottom:1px solid #eaecf0}.fm-contact-tabs .fm-contact-btn.primary{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));box-shadow:none}#fmContactGallery .pf-title{display:none}.fm-contact-tabs .fm-contact-btn{border-radius:9px;height:36px;flex:0 0 auto}.fm-contact-profile{margin:0 0 8px;flex-wrap:nowrap}.fm-contact-actions .fm-contact-btn{flex:1}.fm-contact-fields{flex:1 1 auto}.fm-contact-left{width:min(420px,42%);min-height:0;border-right:1px solid rgba(15,23,42,.08);padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;background:#fff;overflow:hidden}
      .fm-contact-right{flex:1;min-width:0;background:#eef2f6;display:flex;flex-direction:column;position:relative}
      .fm-contact-right .fm-shell-pane{padding:18px;box-sizing:border-box}
      #fmContactGallery{padding:0;min-height:0}
      .fm-contact-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .fm-contact-kicker{font-size:10px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
      .fm-contact-title-line{display:flex;align-items:center;gap:9px;min-width:0}
      .fm-contact-title{margin:2px 0 0;font-size:20px;font-weight:1000;color:#101828;letter-spacing:0;line-height:1.15;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
       .fm-contact-close{position:absolute;top:0;right:5px;z-index:2;width:34px;height:34px;border-radius:10px;border:1px solid rgba(15,23,42,.10);background:#fff;color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .fm-contact-close:hover{color:#101828;background:#f8fafc}
      .fm-contact-fields{display:grid;flex:0 1 auto;min-height:0;gap:6px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}
       .fm-contact-name-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}.fm-contact-relationship-actions{display:flex;gap:6px;flex-wrap:wrap}.fm-contact-relationship-panel{display:grid;gap:7px;border:1px solid #e4e7ec;border-radius:9px;padding:9px;background:#f8fafc}.fm-contact-relationship-panel[hidden],#fmContactTimeZoneField[hidden]{display:none!important}.fm-contact-relationship-match{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:850}.fm-contact-relationship-match button{border:0;background:none;color:#b42318;cursor:pointer}
      .fm-contact-relationship-match{align-items:flex-start;border:1px solid #e4e7ec;border-radius:9px;padding:9px;background:#fff;margin:5px 0}.fm-contact-relationship-details{display:grid;gap:4px;min-width:0;flex:1}.fm-contact-relationship-details strong{font-size:12px;color:#101828}.fm-contact-relationship-details span{font-weight:650;color:#667085;overflow-wrap:anywhere}.fm-contact-relationship-match .fm-contact-relationship-open{color:var(--primary-readable,var(--primary,#d93025));font-weight:900;padding:0;text-align:left}.fm-contact-relationship-match .fm-contact-relationship-remove{color:#b42318;font-size:10px}.fm-contact-relationship-panel label{display:grid;gap:3px;font-size:10px;font-weight:900;color:#667085}.fm-contact-relationship-panel .fm-contact-name-fields{gap:6px}.fm-contact-relationship-panel .fm-contact-btn{width:max-content}
      .fm-contact-docs{display:grid;align-content:start;gap:12px;min-height:100%;padding-bottom:20px}.fm-contact-docs-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.fm-contact-docs-head h3{font-size:15px;margin:0}.fm-contact-doc-list{display:grid;align-content:start;gap:8px}.fm-contact-doc{display:flex;align-items:center;gap:10px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:12px;color:#344054;text-decoration:none}.fm-contact-doc:hover{border-color:var(--primary,#d93025)}.fm-contact-doc span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-contact-doc small{margin-left:auto;color:#667085;white-space:nowrap}
      #fmContactBackContact[hidden]{display:none!important}
      .fm-contact-field{display:grid;gap:3px}
      .fm-contact-field label{font-size:10px;font-weight:1000;color:#667085;letter-spacing:.06em;text-transform:uppercase}
      .fm-contact-input{width:100%;box-sizing:border-box;border:1px solid rgba(15,23,42,.14);border-radius:9px;min-height:34px;padding:6px 9px;font-size:12px;font-weight:850;color:#101828;outline:none}
      .fm-contact-input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.55);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.10)}
      .fm-contact-phone-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.fm-contact-phone-heading label{margin:0}.fm-contact-phone-add{border:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:900;cursor:pointer;padding:2px 0}.fm-contact-phone-controls{display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:6px}.fm-contact-phone-actions{display:flex;gap:8px}.fm-contact-phone-actions button{border:0;background:transparent;color:#667085;font:inherit;font-size:11px;font-weight:850;cursor:pointer;padding:2px 0}.fm-contact-phone-actions button:hover{color:var(--primary-readable,var(--primary,#d93025))}#fmContactSecondaryField[hidden],#fmContactAddPhone[hidden]{display:none!important}
      .pac-container{z-index:2147483600!important}
      .fm-contact-actions{display:flex;flex:0 0 auto;gap:8px}
      .fm-contact-actions .fm-contact-btn{flex:1 1 0}
      .fm-contact-btn{border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#344054;min-height:36px;padding:0 11px;font-size:11px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
      .fm-contact-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .fm-contact-btn:disabled{opacity:.58;cursor:not-allowed}
      .fm-contact-meta{flex:0 0 auto;font-size:11px;font-weight:850;color:#667085;line-height:1.3;min-height:14px}
      .fm-contact-right-head{height:64px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .fm-contact-right-title{font-size:14px;font-weight:1000;color:#101828}
      .fm-contact-count{font-size:12px;font-weight:900;color:#667085}
      .fm-contact-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .fm-contact-required{display:none;font-size:10px;font-weight:1000;color:#b42318;letter-spacing:0;text-transform:none}
      .fm-contact-field.required .fm-contact-required{display:inline}
      .fm-contact-field.required .fm-contact-input{border-color:#d92d20;background:#fff5f4;box-shadow:0 0 0 4px rgba(217,45,32,.12)}
      .fm-contact-projects{padding:0 0 66px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
      .fm-contact-project{border:1px solid rgba(15,23,42,.10);border-radius:8px;background:#fff;min-height:116px;padding:14px;text-align:left;cursor:pointer;box-shadow:0 12px 28px rgba(15,23,42,.06);display:flex;flex-direction:column;gap:8px}
      .fm-contact-project:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 16px 34px rgba(15,23,42,.10);transform:translateY(-1px)}
      .fm-contact-project strong{font-size:14px;font-weight:1000;color:#101828;line-height:1.25}
      .fm-contact-project span{font-size:12px;font-weight:850;color:#667085;line-height:1.35}
      .fm-contact-project small{margin-top:auto;font-size:11px;font-weight:1000;color:#98a2b3;text-transform:uppercase;letter-spacing:.04em}
      .fm-contact-empty{grid-column:1/-1;align-self:start;border:1px dashed rgba(15,23,42,.16);border-radius:8px;background:#fff;padding:28px;text-align:center;color:#667085;font-size:13px;font-weight:900}
      .fm-contact-new-project{position:absolute;right:22px;bottom:22px;z-index:4;border:0;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);min-height:46px;padding:0 17px;box-shadow:0 18px 34px rgba(var(--primary-rgb,217,48,37),.26),0 14px 32px rgba(15,23,42,.14);display:inline-flex;align-items:center;justify-content:center;gap:9px;font-size:13px;font-weight:1000;cursor:pointer}
      .fm-contact-new-project:hover{filter:brightness(.96);transform:translateY(-1px)}
      .fm-contact-tags{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
      .fm-contact-tag{display:inline-flex;align-items:center;gap:5px;border:1px solid #e4e7ec;border-radius:999px;background:#f8fafc;color:#344054;font-size:10px;font-weight:900;padding:3px 7px;line-height:1.2}
      .fm-contact-tag button{border:0;background:none;color:#98a2b3;cursor:pointer;padding:0;margin:0;display:inline-flex;align-items:center;font-size:10px;line-height:1}
      .fm-contact-tag button:hover{color:#b42318}
      .fm-contact-tag-input{border:1px dashed rgba(15,23,42,.18);border-radius:999px;background:#fff;min-width:82px;flex:0 1 auto;box-sizing:border-box;font-size:10px;font-weight:900;color:#101828;padding:3px 8px;outline:none}
      .fm-contact-tag-input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.45);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}
      .fm-contact-import-meta{font-size:11px;font-weight:850;color:#98a2b3}
      .fm-contact-todos{display:flex;flex:1 1 180px;min-height:120px;flex-direction:column;gap:4px;overflow:hidden}
      .fm-contact-todos[hidden]{display:none}
      .fm-contact-todos>label{flex:0 0 auto;font-size:10px;font-weight:1000;color:#667085;letter-spacing:.06em;text-transform:uppercase}
      #fmContactTodoList{flex:1 1 auto;min-height:0;overflow:hidden}
      .fm-contact-overlay.window-managed .fm-contact-close{display:none}
      .fm-contact-overlay.window-managed .fm-window-controls{height:100%;gap:0}
      .fm-contact-overlay.window-managed .fm-window-controls button{height:100%;min-height:48px;width:34px;border-radius:0;border-left:1px solid #e4e7ec}
      .fm-contact-overlay.window-managed .fm-window-controls button[aria-pressed="true"]{background:#e4e7ec;color:#101828}
      .fm-contact-overlay.window-managed:not([data-window-mode="modal"]):not([data-window-mode="fullscreen"]){background:transparent;backdrop-filter:none;pointer-events:none}
      .fm-contact-overlay.window-managed .fm-contact-win{pointer-events:auto;transition:none}
      .fm-contact-overlay.window-managed .fm-contact-win[data-window="full"],.fm-contact-overlay.window-managed .fm-contact-win[data-window="fullscreen"]{border-radius:0}
      .fm-contact-overlay.window-managed .fm-contact-win[data-window="minimized"] .fm-contact-content{display:none}
      .fm-contact-overlay.window-managed .fm-contact-win[data-window="minimized"]{padding:0}
      .fm-contact-overlay.window-managed .fm-contact-win[data-window="minimized"] .fm-contact-window-header{height:30px;min-height:30px;padding:0 6px}
      .fm-contact-overlay.window-managed .fm-contact-win[data-window="minimized"] .fm-window-controls button:not([data-window-action="minimize"]):not([data-window-action="close"]){display:none}
      @media(max-width:760px){
        .fm-contact-win{width:100vw;height:100vh;border-radius:0}
        .fm-contact-content{flex-direction:column}
        .fm-contact-left{width:100%;height:52vh;border-right:0;border-bottom:1px solid rgba(15,23,42,.08)}
        .fm-contact-right .fm-shell-pane{padding:12px}
        .fm-contact-projects{grid-template-columns:1fr;padding:0 0 66px}
        .fm-contact-overlay.window-managed .fm-window-controls button{width:28px;min-height:39px}
      }
    `;
    document.head.appendChild(style);
  }
  function syncContactWindowModalRegistration(){
    state.handle?.unregister?.();
    state.handle = null;
    const overlay = $('#fmContactOverlay');
    const mode = contactWindow?.state.mode || 'modal';
    if (overlay && contactWindow) {
      const parent = ['modal','fullscreen'].includes(mode) ? document.body : (document.querySelector('main.main') || document.querySelector('.main'));
      if (parent && overlay.parentElement !== parent) parent.append(overlay);
    }
    if (overlay?.classList.contains('active') && ['modal','fullscreen'].includes(mode)) {
      state.handle = window.Portal?.modals?.register?.(overlay, {
        id:'contact-modal', closeOnEscape:true, closeOnBackdrop:false, onClose:close
      }) || null;
    }
  }
  function ensureContactWindow(overlay){
    if (contactWindow || !window.FirstMateWindows) return;
    const element = overlay?.querySelector('.fm-contact-win');
    const host = document.querySelector('main.main') || document.querySelector('.main');
    if (!element || !host) return;
    contactWindow = window.FirstMateWindows.attach({
      element, host, stackElement:overlay, menuHost:overlay,
      header:element.querySelector('.fm-contact-window-header'),
      controlsHost:element.querySelector('.r-window-bar-actions'),
      title:element.querySelector('.fm-contact-window-identity'),
      contentTarget:document.getElementById('mainPanels'),
      customChrome:true, titleMenu:false, presentationModes:true, mobileFullscreen:true, viewportCoordinates:true, nativeModalLayout:true,
      name:'contact', label:'Contact', mode:'modal', width:1100, height:760,
      dockWidth:760, minWidth:360, minimizedHeight:32,
      topInset:() => document.getElementById('platformTopbar')?.offsetHeight || 0,
      onClose:() => close(),
      onChange:({mode}) => {
        overlay.dataset.windowMode = mode;
        syncContactWindowModalRegistration();
      }
    });
    overlay.classList.add('window-managed');
    overlay.dataset.windowMode = contactWindow.state.mode;
    contactWindow.setVisible(false);
  }
  function ensureContactShell(overlay){
    if(contactShell)return;
    const element=overlay.querySelector('.fm-contact-win'),right=element.querySelector('.fm-contact-right');
    const projects=document.createElement('section'),media=document.createElement('section'),docs=document.createElement('section'),container=document.createElement('div');
    projects.dataset.contactPane='projects';media.dataset.contactPane='media';docs.dataset.contactPane='docs';
    projects.append($('#fmContactProjects'),$('#fmContactNewProject'));media.append($('#fmContactGallery'));docs.append($('#fmContactDocs'));right.append(container);
    contactPanes=window.FirstMateWindowShell.localPanes({container,definitions:[{tab:'projects',element:projects},{tab:'media',element:media},{tab:'docs',element:docs}],onChange:ids=>{
      const wasMediaVisible=state.mediaTab;
      const wasDocsVisible=state.docsTab;
      state.mediaTab=ids.includes('media');
      state.docsTab=ids.includes('docs');
      $('#fmContactGallery').hidden=!state.mediaTab;$('#fmContactProjects').hidden=!ids.includes('projects');$('#fmContactNewProject').hidden=!ids.includes('projects');
      for(const [id,tab] of [['fmContactProjectsTab','projects'],['fmContactMediaTab','media'],['fmContactDocsTab','docs']]){
        const button=$('#'+id);button.setAttribute('aria-selected',String(ids.includes(tab)));button.classList.toggle('primary',ids.includes(tab));
      }
      if(state.mediaTab&&!wasMediaVisible)void mountContactGallery();
      if(state.docsTab&&!wasDocsVisible)void mountContactDocs();
    }});
    const header=element.querySelector('.fm-contact-window-header');
    contactTrays=window.FirstMateWindowShell.trayHost({container:element.querySelector('.fm-contact-content'),header,getContext:()=>({contact:state.contact,orgId:orgId()})});
    contactShell=window.FirstMateWindowShell.mount({element,header,identity:element.querySelector('.fm-contact-window-identity'),tabs:element.querySelector('.fm-contact-tabs'),sidebar:element.querySelector('.fm-contact-left'),panes:contactPanes,trays:contactTrays,headerRows:2});
  }
  function ensureUI(){
    injectCSS();
    let overlay = $('#fmContactOverlay');
    if (overlay) { ensureContactWindow(overlay); ensureContactShell(overlay); return overlay; }
    overlay = document.createElement('div');
    overlay.className = 'fm-contact-overlay';
    overlay.id = 'fmContactOverlay';
    overlay.innerHTML = `
      <div class="fm-contact-win">
        <div class="fm-contact-window-header">
          <div class="fm-contact-window-identity"><i class="fas fa-address-card" aria-hidden="true"></i><span id="fmContactWindowTitle">${(globalThis.PlatformLanguage?.htmlText("contacts","m_90a1aa2fb77fc8","New Contact") ?? "New Contact")}</span></div>
          <button type="button" class="fm-contact-close" id="fmContactClose" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
           <div class="r-window-bar-actions"></div>
           <div class="fm-contact-tabs" role="tablist" aria-label="Contact sections"><button type="button" role="tab" data-tab="projects" id="fmContactProjectsTab">Projects</button><button type="button" role="tab" data-tab="media" id="fmContactMediaTab">Photos &amp; Media</button><button type="button" role="tab" data-tab="docs" id="fmContactDocsTab">Docs</button></div>
        </div>
        <div class="fm-contact-content">
        <section class="fm-contact-left">
          <div class="fm-contact-fields">
            <div class="fm-contact-profile" id="fmContactProfile"></div>
            <div class="fm-contact-name-fields"><div class="fm-contact-field" id="fmContactNameField"><label class="fm-contact-label-row" for="fmContactFirstName"><span>First name</span><span class="fm-contact-required">Required</span></label><input class="fm-contact-input" id="fmContactFirstName" autocomplete="given-name" required aria-required="true"></div><div class="fm-contact-field"><label for="fmContactLastName">Last name</label><input class="fm-contact-input" id="fmContactLastName" autocomplete="family-name"></div></div>
            <div class="fm-contact-field"><div class="fm-contact-phone-heading"><label for="fmContactPhone">Primary Phone</label><button type="button" class="fm-contact-phone-add" id="fmContactAddPhone" aria-label="Add secondary phone"><i class="fas fa-plus" aria-hidden="true"></i> Add phone</button></div><div class="fm-contact-phone-controls"><input class="fm-contact-input" id="fmContactPhone" type="tel" inputmode="tel" autocomplete="tel" aria-label="Primary Phone"><select class="fm-contact-input" id="fmContactPrimaryPhoneLabel" aria-label="Primary phone label">${phoneLabelOptions()}</select></div></div>
            <div class="fm-contact-field" id="fmContactSecondaryField" hidden><label for="fmContactSecondaryPhone">Secondary Phone</label><div class="fm-contact-phone-controls"><input class="fm-contact-input" id="fmContactSecondaryPhone" type="tel" inputmode="tel" autocomplete="tel-national" aria-label="Secondary Phone"><select class="fm-contact-input" id="fmContactSecondaryPhoneLabel" aria-label="Secondary phone label">${phoneLabelOptions()}</select></div><div class="fm-contact-phone-actions"><button type="button" id="fmContactMakeSecondaryPrimary">Set as primary</button><button type="button" id="fmContactRemoveSecondary">Remove</button></div></div>
            <div class="fm-contact-field"><label>${(globalThis.PlatformLanguage?.htmlText("contacts","m_5d2b9327181e33","Email") ?? "Email")}</label><input class="fm-contact-input" id="fmContactEmail" type="email" autocomplete="email"></div>
            <div class="fm-contact-field"><label>${(globalThis.PlatformLanguage?.htmlText("contacts","m_04774ec8f0f789","Default Address") ?? "Default Address")}</label><input class="fm-contact-input" id="fmContactAddress" autocomplete="street-address"></div>
            <div class="fm-contact-field" id="fmContactTimeZoneField" hidden><label for="fmContactTimeZone">Time zone</label><select class="fm-contact-input" id="fmContactTimeZone" aria-label="Contact time zone"></select></div>
            <div id="fmContactCustomFields"></div>
            <div class="fm-contact-field" id="fmContactTagsField">
              <label>${(globalThis.PlatformLanguage?.htmlText("contacts","m_562d2cd3a48b8f","Tags") ?? "Tags")}</label>
              <div class="fm-contact-tags" id="fmContactTags"></div>
              <div class="fm-contact-import-meta" id="fmContactImportMeta" hidden></div>
            </div>
            <button type="button" class="fm-contact-btn" id="fmContactBackContact" hidden></button>
            <div class="fm-contact-field" id="fmContactRelationships"><label>Relationships</label><div id="fmContactRelationshipMatches"></div><div class="fm-contact-relationship-actions"><button type="button" class="fm-contact-btn" data-add-relationship="employer">+ Add employer</button><button type="button" class="fm-contact-btn" data-add-relationship="spouse">+ Add spouse</button></div><div class="fm-contact-relationship-panel" id="fmContactRelationshipPanel" hidden></div></div>
          </div>
          <div class="fm-contact-todos" id="fmContactTodos" hidden>
            <label>${(globalThis.PlatformLanguage?.htmlText("contacts","m_a6534938817ec3","To-dos") ?? "To-dos")}</label>
            <div id="fmContactTodoList"></div>
          </div>
          <div class="fm-contact-meta" id="fmContactMeta"></div>
          <div class="fm-contact-actions">
            <button type="button" class="fm-contact-btn" id="fmContactCall"><i class="fas fa-phone"></i><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_8d4eaa0da004be","Call") ?? "Call")}</span></button>
            <button type="button" class="fm-contact-btn" id="fmContactText"><i class="fas fa-comment-sms"></i><span>Text</span></button>
            <button type="button" class="fm-contact-btn" id="fmContactEmailAction"><i class="fas fa-envelope"></i><span>Email</span></button>
          </div>
        </section>
        <section class="fm-contact-right">
          <input type="file" multiple hidden id="fmContactMediaUpload"><input type="file" multiple hidden id="fmContactDocsUpload" accept=".pdf,.doc,.docx,.txt,.csv,.xlsx,.xls,.ppt,.pptx,.odt,.rtf"><div id="fmContactGallery" hidden></div><div class="fm-contact-docs" id="fmContactDocs"><div class="fm-contact-docs-head"><h3>Contact docs</h3><button type="button" class="fm-contact-btn" id="fmContactDocsAdd"><i class="fas fa-plus" aria-hidden="true"></i> Add doc</button></div><div class="fm-contact-doc-list" id="fmContactDocsList"></div></div><div class="fm-contact-projects" id="fmContactProjects"></div>
          <button type="button" class="fm-contact-new-project" id="fmContactNewProject"><i class="fas fa-plus"></i><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_0747045bf3d919","New Project") ?? "New Project")}</span></button>
        </section>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    ensureContactWindow(overlay);
    ensureContactShell(overlay);
    $('#fmContactClose', overlay)?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { overlay.__downBackdrop = event.target === overlay; });
    overlay.addEventListener('mouseup', (event) => {
      if (overlay.__downBackdrop && event.target === overlay) close();
      overlay.__downBackdrop = false;
    });
    $('#fmContactProjectsTab', overlay)?.addEventListener('click',()=>showContactTab('projects'));
    $('#fmContactMediaTab', overlay)?.addEventListener('click',()=>showContactTab('media'));
    $('#fmContactDocsTab', overlay)?.addEventListener('click',()=>showContactTab('docs'));
    $('#fmContactMediaUpload',overlay)?.addEventListener('change',event=>uploadContactFiles(event.target.files));
    $('#fmContactDocsAdd',overlay)?.addEventListener('click',()=>$('#fmContactDocsUpload',overlay)?.click());
    $('#fmContactDocsUpload',overlay)?.addEventListener('change',event=>uploadContactFiles(event.target.files,false,'document'));
    $('#fmContactBackContact',overlay)?.addEventListener('click',()=>{const back=state.returnToContact;if(back)void open(back.contact,{projects:back.projects,projectsComplete:true});});
    $('#fmContactCall', overlay)?.addEventListener('click',async()=>{
      const phone=window.Portal?.CustomerPhone,button=$('#fmContactCall');if(!state.contact?.phone)return;
      button.disabled=true;try{if(phone)await phone.open({contact_id:firstText(state.contact.id,state.contact.contact_id),customer_name:state.contact.name,customer_number:state.contact.phone});else window.location.href='tel:'+state.contact.phone.replace(/[^+0-9*#,;]/g,'');}
      catch(error){window.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("contacts","m_8d4eaa0da004be","Call") ?? "Call"),error.message,false);}finally{button.disabled=false;}
    });
    $('#fmContactText',overlay)?.addEventListener('click',()=>{const number=cleanText(state.contact.phone).replace(/[^+0-9*#,;]/g,'');if(number)window.location.href='sms:'+number;});
    $('#fmContactEmailAction',overlay)?.addEventListener('click',()=>{const email=cleanText(state.contact.email);if(email)window.location.href='mailto:'+encodeURIComponent(email);});
    $('#fmContactNewProject', overlay)?.addEventListener('click', createProjectForContact);
    ['fmContactFirstName','fmContactLastName','fmContactPhone','fmContactSecondaryPhone','fmContactEmail','fmContactAddress'].forEach((id) => {
      $(`#${id}`, overlay)?.addEventListener('input', () => {
        if(id==='fmContactPhone'||id==='fmContactSecondaryPhone')formatPhoneInput($(`#${id}`,overlay));
        readContactInputs();
        if (id === 'fmContactFirstName') setNameRequired(!cleanText(state.contact.name));
        renderHeader();
        scheduleAutosave();
      });
    });
    ['fmContactPrimaryPhoneLabel','fmContactSecondaryPhoneLabel'].forEach(id=>{
      $(`#${id}`,overlay)?.addEventListener('change',()=>{readContactInputs();scheduleAutosave();});
    });
    $('#fmContactAddPhone',overlay)?.addEventListener('click',()=>{
      state.secondaryPhoneOpen=true;updateSecondaryPhoneVisibility();$('#fmContactSecondaryPhone',overlay)?.focus();
    });
    $('#fmContactRemoveSecondary',overlay)?.addEventListener('click',()=>{
      $('#fmContactSecondaryPhone').value='';$('#fmContactSecondaryPhoneLabel').value='';
      state.secondaryPhoneOpen=false;updateSecondaryPhoneVisibility();readContactInputs();scheduleAutosave();
    });
    $('#fmContactMakeSecondaryPrimary',overlay)?.addEventListener('click',()=>{
      const primary=$('#fmContactPhone'),secondary=$('#fmContactSecondaryPhone');
      const primaryLabel=$('#fmContactPrimaryPhoneLabel'),secondaryLabel=$('#fmContactSecondaryPhoneLabel');
      if(!cleanText(secondary?.value))return;
      [primary.value,secondary.value]=[secondary.value,primary.value];
      [primaryLabel.value,secondaryLabel.value]=[secondaryLabel.value,primaryLabel.value];
      state.secondaryPhoneOpen=!!cleanText(secondary.value);updateSecondaryPhoneVisibility();
      readContactInputs();renderHeader();scheduleAutosave();
    });
    $('#fmContactCustomFields', overlay)?.addEventListener('input', () => scheduleAutosave());
    $('#fmContactCustomFields', overlay)?.addEventListener('change', () => scheduleAutosave());
    $('#fmContactTimeZone',overlay)?.addEventListener('change',()=>{readContactInputs();scheduleAutosave();});
    $('#fmContactRelationships',overlay)?.addEventListener('click',event=>{
      const add=event.target.closest('[data-add-relationship]');if(add)return openRelationship(add.dataset.addRelationship);
      const openProfile=event.target.closest('[data-open-relationship]');if(openProfile)return void openRelatedProfile(openProfile.dataset.openRelationship);
      const remove=event.target.closest('[data-remove-relationship]');if(remove){const type=remove.dataset.removeRelationship;const values={...(state.contact.custom_field_values||{})};values.relationships={...(values.relationships||{}),[type]:null};state.contact.custom_field_values=values;delete state.relationshipContacts[type];delete state.relationshipNames[type];renderRelationships();scheduleAutosave();}
    });
    $('#fmContactAddress', overlay)?.addEventListener('focus', initAddressAutocomplete);
    $('#fmContactProjects', overlay)?.addEventListener('click', (event) => {
      const card = event.target.closest('[data-contact-project-id]');
      if (!card) return;
      const project = state.projects.find((item) => projectId(item) === card.dataset.contactProjectId);
      if (project) openProject(project);
    });
    return overlay;
  }
  function setMeta(message){
    const meta = $('#fmContactMeta');
    if (meta) meta.textContent = message || '';
  }
  function setNameRequired(on){
    const field = $('#fmContactNameField');
    const input = $('#fmContactFirstName');
    field?.classList.toggle('required', !!on);
    if (input) input.setAttribute('aria-invalid', on ? 'true' : 'false');
  }
  function validateName(options = {}){
    const name = cleanText($('#fmContactFirstName')?.value || state.contact?.first_name);
    const valid = !!name;
    setNameRequired(!valid);
    if (!valid) {
      setMeta('First name is required.');
      if (options.focus) $('#fmContactFirstName')?.focus();
    }
    return valid;
  }
  function readContactInputs(){
    const previousAddress = cleanText(state.contact?.address);
    const nextAddress = cleanText($('#fmContactAddress')?.value);
    const firstName=cleanText($('#fmContactFirstName')?.value),lastName=cleanText($('#fmContactLastName')?.value);
    const customValues={...(state.contact?.custom_field_values || {}),secondary_phone:cleanText($('#fmContactSecondaryPhone')?.value),primary_phone_label:cleanText($('#fmContactPrimaryPhoneLabel')?.value),secondary_phone_label:cleanText($('#fmContactSecondaryPhoneLabel')?.value)};
    state.contact = {
      ...state.contact,
      first_name:firstName,last_name:lastName,name:[firstName,lastName].filter(Boolean).join(' '),
      phone: cleanText($('#fmContactPhone')?.value),
      custom_field_values:customValues,
      email: cleanText($('#fmContactEmail')?.value),
      time_zone:cleanText($('#fmContactTimeZone')?.value),
      address: nextAddress,
      ...(previousAddress && nextAddress !== previousAddress ? { lat: '', lng: '', address_components: {} } : {})
    };
    return state.contact;
  }
  function writeContactInputs(){
    const contact = state.contact || {};
    const values=contact.custom_field_values || {};
    const names=nameParts(contact);
    if ($('#fmContactFirstName')) $('#fmContactFirstName').value = names.first;
    if ($('#fmContactLastName')) $('#fmContactLastName').value = names.last;
    if ($('#fmContactPhone')) $('#fmContactPhone').value = formatPhone(contact.phone || '');
    if ($('#fmContactSecondaryPhone')) $('#fmContactSecondaryPhone').value = formatPhone(values.secondary_phone || '');
    if ($('#fmContactPrimaryPhoneLabel')) $('#fmContactPrimaryPhoneLabel').value = phoneLabels.includes(values.primary_phone_label)?values.primary_phone_label:'';
    if ($('#fmContactSecondaryPhoneLabel')) $('#fmContactSecondaryPhoneLabel').value = phoneLabels.includes(values.secondary_phone_label)?values.secondary_phone_label:'';
    updateSecondaryPhoneVisibility();
    if ($('#fmContactEmail')) $('#fmContactEmail').value = contact.email || '';
    if ($('#fmContactAddress')) $('#fmContactAddress').value = contact.address || '';
    renderTimeZone();
  }
  function renderTimeZone(){
    const field=$('#fmContactTimeZoneField'),select=$('#fmContactTimeZone');if(!field||!select)return;
    field.hidden=!state.trackTimeZones;
    const value=cleanText(state.contact.time_zone),choices=value&&!timeZones.includes(value)?[value,...timeZones]:timeZones;
    select.innerHTML='<option value="">Select time zone…</option>'+choices.map(zone=>`<option value="${escapeHtml(zone)}">${escapeHtml(zone.replaceAll('_',' '))}</option>`).join('');
    select.value=value;
  }
  function updateSecondaryPhoneVisibility(){
    const secondary=$('#fmContactSecondaryField'),add=$('#fmContactAddPhone');
    const visible=state.secondaryPhoneOpen || !!cleanText($('#fmContactSecondaryPhone')?.value);
    if(secondary)secondary.hidden=!visible;
    if(add)add.hidden=visible;
  }
  function placeComponentsObject(place = {}){
    const out = {};
    (place.address_components || []).forEach((component) => {
      (component.types || []).forEach((type) => {
        out[type] = {
          long_name: component.long_name || '',
          short_name: component.short_name || ''
        };
      });
    });
    return out;
  }
  function applyAddressPlace(place = {}){
    const formatted = firstText(place.formatted_address, place.name);
    if (formatted && $('#fmContactAddress')) $('#fmContactAddress').value = formatted;
    state.contact = {
      ...state.contact,
      address: formatted || cleanText($('#fmContactAddress')?.value),
      lat: place.geometry?.location?.lat?.() ?? state.contact?.lat ?? '',
      lng: place.geometry?.location?.lng?.() ?? state.contact?.lng ?? '',
      address_components: placeComponentsObject(place)
    };
    renderHeader();
    scheduleAutosave();
  }
  function initAddressAutocomplete(){
    const input = $('#fmContactAddress');
    if (!input || !window.google?.maps?.places?.Autocomplete) return null;
    if (state.addressAutocomplete && state.addressAutocompleteInput === input) return state.addressAutocomplete;
    state.addressAutocompleteInput = input;
    state.addressAutocomplete = new window.google.maps.places.Autocomplete(input, {
      fields: ['formatted_address', 'geometry', 'address_components', 'name'],
      types: ['geocode']
    });
    state.addressAutocomplete.addListener('place_changed', () => {
      applyAddressPlace(state.addressAutocomplete.getPlace() || {});
    });
    return state.addressAutocomplete;
  }
  function renderHeader(){
    const callButton=$('#fmContactCall');if(callButton)callButton.disabled=!state.contact?.phone;
    const textButton=$('#fmContactText');if(textButton)textButton.disabled=!state.contact?.phone;
    const emailButton=$('#fmContactEmailAction');if(emailButton)emailButton.disabled=!state.contact?.email;
    const label = contactTitle(state.contact);
    const title = $('#fmContactTitle');
    if (title) title.textContent = label;
    const windowTitle = $('#fmContactWindowTitle');
    if (windowTitle) windowTitle.textContent = label;
    const back=$('#fmContactBackContact');
    if(back){back.hidden=!state.returnToContact;back.textContent=state.returnToContact?`← Back to ${contactTitle(state.returnToContact.contact)}`:'';}
  }
  function contactTags(){
    return Array.isArray(state.contact?.tags) ? state.contact.tags.map(cleanText).filter(Boolean) : [];
  }
  function addContactTag(value){
    const tag = cleanText(value).replace(/\s+/g, ' ').slice(0, 80);
    if (!tag || !state.catalog.some(row=>row.id===tag && row.enabled!==false)) return;
    if(tag==='org')state.contact.contact_kind='org';
    const tags = contactTags();
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    state.contact = { ...state.contact, tags: [...tags, tag] };
    renderTags();
    scheduleAutosave();
  }
  function removeContactTag(tag){
    if(tag==='org')state.contact.contact_kind='human';
    state.contact = { ...state.contact, tags: contactTags().filter((existing) => existing !== tag) };
    renderTags();
    scheduleAutosave();
  }
  function renderTags(){
    const mount = $('#fmContactTags');
    if (!mount) return;
    const tags = contactTags();
    const label=tag=>tag==='org'?orgLabel():state.catalog.find(row=>row.id===tag)?.label || tag;
    mount.innerHTML = tags.map(tag=>`<span class="fm-contact-tag" data-contact-tag="${escapeHtml(tag)}">${escapeHtml(label(tag))}<button type="button" aria-label="Remove ${escapeHtml(label(tag))}"><i class="fas fa-times"></i></button></span>`).join('')
      + `<select class="fm-contact-tag-input" id="fmContactTagInput" aria-label="Add managed tag"><option value="">Add tag…</option>${state.catalog.filter(row=>row.enabled!==false && !tags.includes(row.id)).map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.label)}</option>`).join('')}</select>`;
    mount.querySelectorAll('[data-contact-tag] button').forEach(button=>button.addEventListener('click',()=>removeContactTag(button.closest('[data-contact-tag]').dataset.contactTag)));
    $('#fmContactTagInput')?.addEventListener('change',event=>addContactTag(event.target.value));
    const importMeta = $('#fmContactImportMeta');
    if (importMeta) {
      const importedAt = firstText(state.contact?.imported_at);
      if (importedAt) {
        const when = Number.isFinite(Date.parse(importedAt))
          ? new Date(importedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : importedAt;
        importMeta.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("contacts","m_7d397e7213fa4d",`Imported${v0} · ${v1}`,{v0,v1}) ?? `Imported${v0} · ${v1}`)(state.contact?.import_source ? ` from ${state.contact.import_source}` : '',when);
        importMeta.hidden = false;
      } else {
        importMeta.hidden = true;
      }
    }
  }
  function relationshipValue(type){return state.contact?.custom_field_values?.relationships?.[type] || null;}
  function setRelationship(type,reference,contact){
    const values={...(state.contact.custom_field_values||{})};
    values.relationships={...(values.relationships||{}),[type]:reference};
    state.contact.custom_field_values=values;
    const details=typeof contact==='string'?{name:contact}:contact || {};
    state.relationshipNames[type]=details.name || 'Linked contact';
    state.relationshipContacts[type]=details;
    state.relationshipMode='';renderRelationships();scheduleAutosave();
    if(!details.phone&&!details.email&&!details.address)void loadRelationshipContact(type,reference);
  }
  async function loadRelationshipContact(type,reference){
    try{
      const result=await window.PlatformAPI.contacts.get(orgId(),reference);
      if(!state.open || relationshipValue(type)?.contact_id!==reference.contact_id || relationshipValue(type)?.project_id!==reference.project_id)return;
      state.relationshipContacts[type]=result.contact || {};
      state.relationshipNames[type]=result.contact?.name || 'Linked contact';
      renderRelationships();
    }catch(error){if(state.open)setMeta(error.message || 'Could not load linked contact.');}
  }
  function renderRelationships(){
    const matches=$('#fmContactRelationshipMatches');if(!matches)return;
    matches.innerHTML=['employer','spouse'].map(type=>{
      const ref=relationshipValue(type);if(!ref)return '';
      const details=state.relationshipContacts[type] || {},label=state.relationshipNames[type] || details.name || 'Linked contact';
      const phone=cleanText(details.phone),email=cleanText(details.email),address=cleanText(details.address || details.default_address);
      return `<div class="fm-contact-relationship-match"><div class="fm-contact-relationship-details"><strong>${type==='spouse'?'Spouse':'Employer'}</strong><button type="button" class="fm-contact-relationship-open" data-open-relationship="${type}" aria-label="Open ${type} profile">${escapeHtml(label)} · Open profile</button>${phone?`<span>Phone: ${escapeHtml(phone)}</span>`:''}${email?`<span>Email: ${escapeHtml(email)}</span>`:''}${address?`<span>Address: ${escapeHtml(address)}</span>`:''}</div><button type="button" class="fm-contact-relationship-remove" data-remove-relationship="${type}" aria-label="Remove ${type}">Remove</button></div>`;
    }).join('');
    const panel=$('#fmContactRelationshipPanel');if(panel&&!state.relationshipMode)panel.hidden=true;
  }
  async function openRelatedProfile(type){
    const ref=relationshipValue(type);if(!ref)return;
    readContactInputs();
    if(revision>savedRevision && !await flushAutosave())return;
    const back={contact:{...state.contact},projects:[state.contactRecord,...state.projects].filter(Boolean)};
    try{
      setMeta('Opening linked contact…');
      const [found,project]=await Promise.all([window.PlatformAPI.contacts.get(orgId(),ref),window.PlatformAPI.projects.get(orgId(),ref.project_id)]);
      const record=projectFromDocument(project.document);
      if(!record)throw Error('Could not open the linked contact record.');
      await open({...found.contact,id:ref.contact_id,project_id:ref.project_id},{projects:[record],projectsComplete:true,returnToContact:back});
    }catch(error){setMeta(error.message || 'Could not open linked contact.');}
  }
  async function openRelationship(type){
    if(!['employer','spouse'].includes(type))return;
    state.relationshipType=type;state.relationshipMode='choose';
    const panel=$('#fmContactRelationshipPanel');panel.hidden=false;
    panel.innerHTML=`<strong>Add ${type}</strong><div class="fm-contact-relationship-actions"><button type="button" class="fm-contact-btn" data-relationship-mode="search">Search existing contacts</button><button type="button" class="fm-contact-btn" data-relationship-mode="new">Add new contact</button><button type="button" class="fm-contact-btn" data-relationship-mode="cancel">Cancel</button></div>`;
    panel.querySelectorAll('[data-relationship-mode]').forEach(button=>button.onclick=()=>showRelationshipMode(button.dataset.relationshipMode));
  }
  async function showRelationshipMode(mode){
    if(mode==='cancel'){state.relationshipMode='';renderRelationships();return;}
    state.relationshipMode=mode;
    const panel=$('#fmContactRelationshipPanel'),type=state.relationshipType;
    if(mode==='search'){
      panel.innerHTML='<label>Search contacts<input class="fm-contact-input" type="search" data-relationship-search placeholder="Search by name"></label><div data-relationship-results>Loading contacts…</div>';
      try{
        const result=await window.PlatformAPI.contacts.options(orgId(),type==='spouse'?'human':'org');
        const options=(result.contacts||[]).filter(row=>row.contact_id!==state.contact.id);
        const input=panel.querySelector('[data-relationship-search]'),results=panel.querySelector('[data-relationship-results]');
        const render=()=>{const query=cleanText(input.value).toLowerCase();results.innerHTML=options.filter(row=>!query||cleanText(row.name).toLowerCase().includes(query)).slice(0,30).map(row=>`<button type="button" class="fm-contact-btn" data-contact-id="${escapeHtml(row.contact_id)}" data-project-id="${escapeHtml(row.project_id)}">${escapeHtml(row.name)}</button>`).join('')||'<span>No matching contacts.</span>';results.querySelectorAll('[data-contact-id]').forEach(button=>button.onclick=()=>setRelationship(type,{contact_id:button.dataset.contactId,project_id:button.dataset.projectId},{name:button.textContent}));};
        input.oninput=render;render();input.focus();
      }catch(error){panel.textContent=error.message||'Could not load contacts.';}
    }else if(mode==='new'){
      panel.innerHTML=`<strong>New ${type} contact</strong>${type==='spouse'?'<div class="fm-contact-name-fields"><label>First name<input class="fm-contact-input" data-related-first autocomplete="off" required></label><label>Last name<input class="fm-contact-input" data-related-last autocomplete="off"></label></div>':'<label>Organization name<input class="fm-contact-input" data-related-first autocomplete="off" required></label>'}<label>Primary phone<input class="fm-contact-input" type="tel" inputmode="tel" data-related-phone></label><label>Phone label<select class="fm-contact-input" data-related-phone-label>${phoneLabelOptions()}</select></label><label>Secondary phone<input class="fm-contact-input" type="tel" inputmode="tel" data-related-secondary-phone></label><label>Secondary phone label<select class="fm-contact-input" data-related-secondary-label>${phoneLabelOptions()}</select></label><label>Email<input class="fm-contact-input" type="email" data-related-email></label><label>Address<input class="fm-contact-input" data-related-address></label>${state.trackTimeZones?`<label>Time zone<select class="fm-contact-input" data-related-time-zone><option value="">Select time zone…</option>${timeZones.map(zone=>`<option value="${escapeHtml(zone)}">${escapeHtml(zone.replaceAll('_',' '))}</option>`).join('')}</select></label>`:''}<label>Notes<textarea class="fm-contact-input" data-related-notes rows="3"></textarea></label><button type="button" class="fm-contact-btn primary" data-related-create>Create and link contact</button>`;
      panel.querySelector('[data-related-create]').onclick=()=>createRelatedContact(type);
      panel.querySelectorAll('[data-related-phone],[data-related-secondary-phone]').forEach(input=>input.addEventListener('input',()=>formatPhoneInput(input)));
      panel.querySelector('[data-related-first]').focus();
    }
  }
  async function createRelatedContact(type){
    readContactInputs();
    if(!validateName({focus:true}))return;
    const panel=$('#fmContactRelationshipPanel'),first=cleanText(panel.querySelector('[data-related-first]')?.value),last=cleanText(panel.querySelector('[data-related-last]')?.value);
    if(!first){panel.querySelector('[data-related-first]')?.focus();return;}
    const phone=cleanText(panel.querySelector('[data-related-phone]')?.value),secondary=cleanText(panel.querySelector('[data-related-secondary-phone]')?.value),emailInput=panel.querySelector('[data-related-email]');
    if(!validPhone(phone)||!validPhone(secondary)){setMeta('Enter a valid phone number with 7 to 15 digits.');(!validPhone(phone)?panel.querySelector('[data-related-phone]'):panel.querySelector('[data-related-secondary-phone]'))?.focus();return;}
    if(emailInput?.value&&!emailInput.validity.valid){setMeta('Enter a valid email address.');emailInput.focus();return;}
    if(!state.contactRecord){scheduleAutosave();}
    if(!await flushAutosave())return;
    const name=[first,last].filter(Boolean).join(' '),id=ensureContactId(),recordId=`project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
    const related={id,contact_id:id,first_name:first,last_name:last,name,phone,email:cleanText(emailInput?.value),address:cleanText(panel.querySelector('[data-related-address]')?.value),notes:cleanText(panel.querySelector('[data-related-notes]')?.value),time_zone:cleanText(panel.querySelector('[data-related-time-zone]')?.value),contact_kind:type==='spouse'?'human':'org',tags:type==='spouse'?[]:['org'],custom_field_values:{primary_phone_label:cleanText(panel.querySelector('[data-related-phone-label]')?.value),secondary_phone:secondary,secondary_phone_label:cleanText(panel.querySelector('[data-related-secondary-label]')?.value)}};
    const record=patchProjectContact({id:recordId,title:name,project_title:name,workflow_state:'contact_only',project_type:'residential',contacts:[],measurement:{},measurement_project:{},events:[],proposals:[]},related);
    const button=panel.querySelector('[data-related-create]');button.disabled=true;
    try{const saved=await window.Portal.ProjectStore.saveRemote(record);if(!saved)throw Error('Could not create the related contact.');setRelationship(type,{contact_id:id,project_id:projectId(saved)||recordId},related);await flushAutosave();}
    catch(error){setMeta(error.message||'Could not create the related contact.');button.disabled=false;}
  }
  function contactTodosEnabled(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    const hasManagementAccess = window.Portal?.currentUser?.canAccessApplication?.('management') === true;
    const canViewProjects = window.Portal?.util?.hasPerm?.('view_projects') === true;
    return hasManagementAccess
      && canViewProjects
      && !!flags.has?.('platform', 'left_column_todo_list')
      && !!window.PlatformActionItems?.renderTodayList;
  }
  function destroyTodoController(){
    state.todoController?.destroy?.();
    state.todoController = null;
  }
  function mountContactTodos(){
    const section = $('#fmContactTodos');
    const mount = $('#fmContactTodoList');
    if (!section || !mount) return;
    const contactId = firstText(state.contact?.id, state.contact?.contact_id);
    const oid = orgId();
    if (!contactTodosEnabled() || !oid || !contactId) {
      section.hidden = true;
      destroyTodoController();
      return;
    }
    section.hidden = false;
    destroyTodoController();
    state.todoController = window.PlatformActionItems.renderTodayList(mount, {
      orgId: oid,
      userId: firstText(cfg.userId, window.__APP?.userId, window.Portal?.currentUser?.id),
      contactId,
      contactName: firstText(state.contact?.name),
      contactEmail: firstText(state.contact?.email),
      contactPhone: firstText(state.contact?.phone),
      projectIds: visibleProjects(state.projects || []).map(projectId).filter(Boolean),
      completedOpen: false,
      futureOpen: false,
      dockDeferredSections: true,
      scrollItemsOnly: true,
      showUpcoming: true,
      showFuture: true,
      showProjectContext: true,
      query: { includeAll: true, includeFuture: true }
    });
  }
  function projectStageLabel(project = {}){
    const projection = project.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    const active = Array.isArray(projection.active_instances)
      ? projection.active_instances
      : (Array.isArray(projection.instances) ? projection.instances.filter((instance) => instance && (instance.status === 'active' || instance.status === 'pending')) : []);
    const primary = active.find((instance) => instance?.kind === 'pipeline') || active[0] || null;
    const label = firstText(primary?.stage_title, primary?.title);
    if (label) return label;
    const lifecycle = projection.lifecycle && typeof projection.lifecycle === 'object'
      ? projection.lifecycle
      : (project.lifecycle && typeof project.lifecycle === 'object' ? project.lifecycle : {});
    const status = firstText(lifecycle.status).toLowerCase();
    if (status === 'lost') return 'Lost';
    if (status === 'completed') return 'Completed';
    if (status === 'canceled' || status === 'cancelled') return 'Cancelled';
    return '';
  }
  function renderProjects(){
    const mount = $('#fmContactProjects');
    const count = $('#fmContactProjectCount');
    if (!mount) return;
    const projects = visibleProjects(state.projects || []);
    if (count) count.textContent = state.loading ? 'Loading...' : `${projects.length} project${projects.length === 1 ? '' : 's'}`;
    if (state.loading) {
      mount.innerHTML = `<div class="fm-contact-empty">${(globalThis.PlatformLanguage?.htmlText("contacts","m_86ecafe542db8d","Loading projects...") ?? "Loading projects...")}</div>`;
      return;
    }
    if (!projects.length) {
      mount.innerHTML = `<div class="fm-contact-empty">${(globalThis.PlatformLanguage?.htmlText("contacts","m_3d87fe0f297c41","No projects are linked to this contact yet.") ?? "No projects are linked to this contact yet.")}</div>`;
      return;
    }
    mount.innerHTML = projects.map((project) => {
      const contact = primaryContact(project);
      return `
        <button type="button" class="fm-contact-project" data-contact-project-id="${String(escapeHtml(projectId(project)))}">
          <strong>${String(escapeHtml(projectTitle(project)))}</strong>
          <span>${String(escapeHtml(firstText(project.address, project.project_type, projectStageLabel(project), 'No address')))}</span>
          <span>${String(escapeHtml(firstText(contact.name, contact.email, contact.phone)))}</span>
          <small>${(globalThis.PlatformLanguage?.htmlText("contacts","m_27136d1254783a","Open project") ?? "Open project")}</small>
        </button>
      `;
    }).join('');
  }
  function render(){
    renderHeader();
    renderRelationships();
    writeContactInputs();setNameRequired(false);
    renderProfile();
    renderHeader();
    renderProjects();
    renderTags();
    const customFields = $('#fmContactCustomFields');
    if (customFields && window.FirstMateCustomFields?.renderEditor) {
      window.FirstMateCustomFields.renderEditor(customFields, state.contact || {}, 'contact', {
        orgId:orgId(),
        location:'overview',
        showSave:false,
        flat:true,
        excludePaths:['profile_photo','secondary_phone','primary_phone_label','secondary_phone_label','relationships.employer','relationships.spouse'],
        fieldClass:'fm-contact-field',
        inputClass:'fm-contact-input'
      });
    }
  }
  function scheduleAutosave(){
    revision++;clearTimeout(saveTimer);setMeta(cleanText(state.contact.name)?'Saving…':'Add a name to save automatically');
    saveTimer=setTimeout(()=>void flushAutosave(),550);
  }
  async function flushAutosave(){
    clearTimeout(saveTimer);if(savePromise)return savePromise;
    if(revision<=savedRevision)return true;
    if(!cleanText(state.contact.name))return false;
    savePromise=(async()=>{while(revision>savedRevision){if(!await saveContact())return false;}return true;})();
    try{return await savePromise;}finally{savePromise=null;}
  }
  async function editProfilePhoto(id){
    try {
      const identity=state.contact.id;const response=await fetch(window.PlatformAPI.media.fileUrl(orgId(),id));if(!response.ok)throw Error('Could not open profile photo');
      const blob=await response.blob(),url=URL.createObjectURL(blob),image=new Image();image.src=url;await image.decode();if(state.contact.id!==identity){URL.revokeObjectURL(url);return;}
      const dialog=document.createElement('dialog');dialog.style.cssText='padding:20px;border:0;border-radius:12px;width:min(440px,90vw);z-index:2147483647';
      dialog.innerHTML='<h3 style="margin:0 0 16px">Edit profile photo</h3><canvas width="400" height="400" style="width:100%;border-radius:8px"></canvas><label style="display:flex;gap:12px;margin:16px 0">Zoom<input type="range" min="1" max="3" step=".05" value="1" style="flex:1"></label><div style="display:flex;gap:8px;justify-content:flex-end"><button class="fm-contact-btn" data-replace>Replace</button><button class="fm-contact-btn" data-cancel>Cancel</button><button class="fm-contact-btn primary" data-apply>Apply</button></div>';
      document.body.append(dialog);dialog.showModal();const canvas=dialog.querySelector('canvas'),ctx=canvas.getContext('2d');
      const draw=()=>{const size=Math.min(image.width,image.height)/Number(dialog.querySelector('input').value);ctx.clearRect(0,0,400,400);ctx.drawImage(image,(image.width-size)/2,(image.height-size)/2,size,size,0,0,400,400);};draw();dialog.querySelector('input').oninput=draw;
      const finish=()=>{URL.revokeObjectURL(url);dialog.close();dialog.remove();};dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
      dialog.querySelector('[data-cancel]').onclick=finish;dialog.querySelector('[data-replace]').onclick=()=>{finish();$('#fmContactPhotoUpload').click();};
      dialog.querySelector('[data-apply]').onclick=()=>canvas.toBlob(async photo=>{finish();if(state.contact.id!==identity)return;await uploadContactFiles([new File([photo],'profile-photo.png',{type:'image/png'})],true);},'image/png');
    }catch(error){setMeta(error.message);}
  }
  function orgLabel(){return window.PlatformTerminology?.get?.('contacts.org','Org') || 'Org';}
  function setProfileInput(ref){
    const input=$('[data-fm-cf-input="profile_photo"]');if(!input)return;
    if(ref){const option=new Option('Profile photo',JSON.stringify(ref),true,true);input.appendChild(option);}else input.value='';
  }
  function renderProfile(){
    const mount=$('#fmContactProfile');if(!mount)return;
    const id=state.contact.profile_media_id || state.contact.custom_field_values?.profile_photo?.media_id;
    mount.innerHTML=`<button type="button" class="fm-contact-photo-tile" id="fmContactPhotoEdit" aria-label="${id?'Edit profile photo':'Upload profile photo'}">${id?`<img src="${escapeHtml(window.PlatformAPI.media.fileUrl(orgId(),id))}" alt="Contact profile photo">`:'<i class="fas fa-camera"></i><span>Upload</span>'}</button><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden id="fmContactPhotoUpload">${id?'<button class="fm-contact-photo-remove" type="button" id="fmContactPhotoRemove" aria-label="Remove profile photo" title="Remove photo"><i class="fas fa-trash-can"></i></button>':''}`;
    $('#fmContactPhotoEdit').addEventListener('click',()=>id?editProfilePhoto(id):$('#fmContactPhotoUpload').click());
    $('#fmContactPhotoUpload')?.addEventListener('change',event=>uploadContactFiles(event.target.files,true));
    $('#fmContactPhotoRemove')?.addEventListener('click',()=>{
      state.contact.custom_field_values={...state.contact.custom_field_values,profile_photo:null};state.contact.profile_media_id='';setProfileInput(null);renderProfile();scheduleAutosave();
    });
  }
  async function uploadContactFiles(files,profile=false,slot='media'){
    if(!files?.length)return;
    state.contact.id=ensureContactId(state.contact);
    const ref={contact_id:state.contact.id,project_id:projectId(state.contactRecord) || state.contact.record_project_id || `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`};
    state.contact.record_project_id=ref.project_id;
    try {
      setMeta('Uploading…');
      for(const file of files){
        const result=await window.PlatformAPI.media.upload(orgId(),file,{ownerType:'contact',ownerId:ref.contact_id,slot:profile?'profile':slot,collection:'contacts',scope:'contact',metadata:{contact_record_project_id:ref.project_id,contact_draft:!state.contactRecord}});
        if(state.contact.id!==ref.contact_id)return;
        draftMedia.push(result.media);
        if(profile){state.contact.custom_field_values={...state.contact.custom_field_values,profile_photo:{media_id:result.media.id}};state.contact.profile_media_id=result.media.id;setProfileInput({media_id:result.media.id});scheduleAutosave();await flushAutosave();}
      }
      if(!profile){scheduleAutosave();await flushAutosave();}
      setMeta(cleanText(state.contact.name)?'Saved':'Add a name to save automatically');renderProfile();if(state.mediaTab)await mountContactGallery();if(state.docsTab)await mountContactDocs();
      if(slot==='document'&&$('#fmContactDocsUpload'))$('#fmContactDocsUpload').value='';
    }catch(error){setMeta(error.message || 'Could not upload media.');}
  }
  function showContactTab(tab){
    contactPanes.apply([{tab,weight:1}]);
  }
  function isContactDoc(item){
    const type=cleanText(item.content_type || item.mime_type).toLowerCase();
    return !type.startsWith('image/')&&!type.startsWith('video/')&&!type.startsWith('audio/');
  }
  async function mountContactDocs(){
    const mount=$('#fmContactDocsList');if(!mount)return;
    state.contact.id=ensureContactId(state.contact);
    const identity=state.contact.id;
    mount.innerHTML='<div class="fm-contact-empty">Loading docs…</div>';
    try{
      const result=state.contactRecord?await window.PlatformAPI.contacts.media(orgId(),{contact_id:identity,project_id:projectId(state.contactRecord)}):{media:draftMedia};
      if(!state.open||state.contact.id!==identity)return;
      const docs=(result.media||[]).filter(isContactDoc);
      mount.innerHTML=docs.length?docs.map(row=>`<a class="fm-contact-doc" href="${escapeHtml(window.PlatformAPI.media.fileUrl(orgId(),row.id))}" target="_blank" rel="noopener noreferrer"><i class="fas fa-file-lines" aria-hidden="true"></i><span>${escapeHtml(row.file_name || 'Document')}</span><small>Open</small></a>`).join(''):'<div class="fm-contact-empty">No docs for this contact yet.</div>';
    }catch(error){mount.textContent=error.message||'Could not load contact docs.';}
  }
  async function mountContactGallery(){
    const mount=$('#fmContactGallery');
    if(!window.Portal.PhotoFeed?.mountProjectGallery){mount.innerHTML='<div class="fm-contact-empty">The media gallery is loading.</div>';return;}
    state.contact.id=ensureContactId(state.contact);
    const identity=state.contact.id;
    try {
      const result=state.contactRecord?await window.PlatformAPI.contacts.media(orgId(),{contact_id:identity,project_id:projectId(state.contactRecord)}):{media:draftMedia};
      if(!state.open || state.contact.id!==identity)return;
      const photos=(result.media || []).filter(row=>!isContactDoc(row)).map(row=>({id:row.id,media_id:row.id,content_type:row.content_type,label:row.file_name,uploaded_at:row.uploaded_at || row.created_at,updated_at:row.updated_at,metadata:row.metadata,src:window.PlatformAPI.media.fileUrl(orgId(),row.id),thumb:window.PlatformAPI.media.fileUrl(orgId(),row.id,row.variants?.thumb_320?'thumb_320':'original')}));
      window.Portal.PhotoFeed.mountProjectGallery(mount,{project:{id:projectId(state.contactRecord),title:contactTitle(state.contact),photos},photos,title:'Photos & Media',uploadLabel:'Upload',selectionEnabled:false,enableProjectLinks:false,projectLinkEnabled:false,deleteEnabled:false,typeFilters:true,routeScope:'contact',onUpload:()=>$('#fmContactMediaUpload').click()});

    }catch(error){mount.textContent=error.message || 'Could not load contact media.';}
  }
  function patchProjectContact(project = {}, contact = {}, options = {}){
    const contactId = ensureContactId(contact);
    const contacts = Array.isArray(project.contacts)
      ? project.contacts.filter(contactHasContent).map((row) => ({ ...row }))
      : [];
    const nextTokens = contactTokens({ ...contact, id: contactId, contact_id: contactId });
    const nextSemanticKey = contactSemanticKey(contact);
    let index = contacts.findIndex((row) => {
      const tokens = contactTokens(row || {});
      if (nextTokens.contactId && tokens.contactId === nextTokens.contactId) return true;
      return !!(
        nextSemanticKey
        && nextSemanticKey === contactSemanticKey(row || {})
        && (!tokens.contactId || !firstText(contact.id, contact.contact_id))
      );
    });
    const nextContact = {
      id: contactId,
      contact_id: contactId,
      contact_kind: contact.contact_kind || 'human',
      profile_media_id: contact.profile_media_id || '',
      name: contact.name || '',
      first_name:contact.first_name || '',last_name:contact.last_name || '',time_zone:contact.time_zone || '',
      phone: contact.phone || '',
      email: contact.email || '',
      address: contact.address || '',
      default_address: contact.address || '',
      ...(contact.company ? { company: contact.company } : {}),
      ...(contact.notes ? { notes: contact.notes } : {}),
      ...(contact.birthday ? { birthday: contact.birthday } : {}),
      ...(Array.isArray(contact.tags) ? { tags: contact.tags.map(cleanText).filter(Boolean) } : {}),
      ...(contact.imported_at ? { imported_at: contact.imported_at } : {}),
      ...(contact.import_id ? { import_id: contact.import_id } : {}),
      ...(contact.import_source ? { import_source: contact.import_source } : {}),
      custom_field_values: { ...(contact.custom_field_values || {}) },
      primary: true
    };
    const nextContacts = contactHasContent(nextContact) ? contacts : [];
    if (contactHasContent(nextContact)) {
      if (index >= 0) nextContacts[index] = { ...nextContacts[index], ...nextContact, primary: true };
      else nextContacts.unshift(nextContact);
      nextContacts.forEach((row, rowIndex) => { row.primary = rowIndex === (index >= 0 ? index : 0); });
    }
    return {
      ...project,
      title: firstText(project.title, contact.name),
      contacts: nextContacts,
      contact_id: contactId,
      primary_contact_id: contactId,
      contact_ids: Array.from(new Set([contactId, ...(Array.isArray(project.contact_ids) ? project.contact_ids : [])].map(cleanText).filter(Boolean))),
      address: project.workflow_state === 'contact_only' ? (contact.address || project.address || '') : project.address,
      lat: project.workflow_state === 'contact_only' ? (contact.lat || project.lat || '') : project.lat,
      lng: project.workflow_state === 'contact_only' ? (contact.lng || project.lng || '') : project.lng,
      address_components: project.workflow_state === 'contact_only' ? (contact.address_components || project.address_components || {}) : project.address_components,
      customer_name: contact.name || project.customer_name || '',
      primary_contact_name: contact.name || project.primary_contact_name || '',
      customer_email: contact.email || project.customer_email || '',
      primary_contact_email: contact.email || project.primary_contact_email || '',
      customer_phone: contact.phone ?? project.customer_phone ?? '',
      primary_contact_phone: contact.phone ?? project.primary_contact_phone ?? '',
      contact_address: contact.address || project.contact_address || '',
      customer_address: contact.address || project.customer_address || '',
      primary_contact_address: contact.address || project.primary_contact_address || '',
      ...(project.workflow_state === 'contact_only' ? { contact_custom_field_values:{ ...(contact.custom_field_values || {}) } } : {}),
      updated_at: new Date().toISOString()
    };
  }
  async function saveContact(){
    const savingRevision=revision;
    let contact = readContactInputs();
    if(!validPhone(contact.phone) || !validPhone(contact.custom_field_values?.secondary_phone)){
      setMeta('Enter a valid phone number with 7 to 15 digits.');
      (!validPhone(contact.phone)?$('#fmContactPhone'):$('#fmContactSecondaryPhone'))?.focus();
      return false;
    }
    const customFieldMount = $('#fmContactCustomFields');
    if (customFieldMount && window.FirstMateCustomFields?.editorValues) {
      const validation = window.FirstMateCustomFields.validateEditor?.(customFieldMount, contact, 'contact');
      if (validation && !validation.valid) {
        setMeta(validation.first?.message || 'Please check the custom fields.');
        customFieldMount.querySelector(`[data-fm-cf-input="${CSS.escape(validation.first?.key || '')}"]`)?.focus?.();
        return false;
      }
      contact = {
        ...contact,
        custom_field_values:validation?.values || window.FirstMateCustomFields.editorValues(customFieldMount, contact, 'contact')
      };
      state.contact = contact;
    }
    if (!validateName()) return false;
    contact.id = ensureContactId(contact);
    state.contact = contact;
    setMeta('Saving...');
    const contactRecord = patchProjectContact({
        ...(state.contactRecord || {}),
        id: projectId(state.contactRecord || {}) || firstText(contact.project_id, contact.record_project_id) || `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        title: contactTitle(contact),
        project_title: contactTitle(contact),
        contacts: Array.isArray(state.contactRecord?.contacts) ? state.contactRecord.contacts : [],
        address: contact.address || '',
        project_type: 'residential',
        workflow_state: 'contact_only',
        measurement: {},
        measurement: state.contactRecord?.measurement || {},
        measurement_project: state.contactRecord?.measurement_project || {},
        events: Array.isArray(state.contactRecord?.events) ? state.contactRecord.events : [],
        proposals: Array.isArray(state.contactRecord?.proposals) ? state.contactRecord.proposals : []
      }, contact);
    let savedRecord;
    try { savedRecord = await window.Portal.ProjectStore.saveRemote(contactRecord); }
    catch(error){setMeta(error.message || 'Could not save contact.');return false;}
    if(!savedRecord){setMeta('Could not save contact.');return false;}
    state.contactRecord = savedRecord;
    state.contact = {
      ...(revision===savingRevision?contact:state.contact),
      id: contact.id,
      project_id: projectId(savedRecord),
      record_project_id: projectId(savedRecord)
    };
    try { state.projects = await Promise.all(visibleProjects(state.projects).map(async (project) => {
      const linked = patchProjectContact(project, state.contact, { referenceOnly: true });
      return await window.Portal.ProjectStore.saveRemote(linked);
    })); } catch(error){setMeta('Contact saved, but a linked project could not be updated: '+error.message);return false;}
    state.originalContact = { ...contact };
    state.saved = true;
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    savedRevision=savingRevision;
    renderHeader();renderProjects();
    if (!state.todoController) mountContactTodos();
    setMeta(revision===savingRevision?'Saved':'Saving…');
    return true;
  }

  async function refreshProjects(provided = [], options = {}){
    state.loading = true;
    renderProjects();
    state.projects = visibleProjects(await loadContactProjects(state.contact, provided, options).catch(() => dedupeProjects(provided)));
    state.loading = false;
    renderProjects();
    // The project list feeds the to-do scope (project to-dos union contact
    // to-dos), so remount once the linked projects are known.
    if (state.open) mountContactTodos();
  }
  async function openProject(project){
    const contact = readContactInputs();
    let targetProject = project;
    if (project?._summary && orgId() && window.PlatformAPI?.projects?.get) {
      setMeta('Opening project...');
      const result = await window.PlatformAPI.projects.get(orgId(), projectId(project)).catch(() => null);
      targetProject = projectFromDocument(result?.document) || project;
    }
    const prepared = patchProjectContact(targetProject, contact, { referenceOnly: true });
    const saved = window.Portal.ProjectStore?.save?.(prepared) || prepared;
    state.projects = visibleProjects([saved, ...state.projects]);
    const context = { contact, projects: visibleProjects(state.projects) };
    close({ skipHistory:true });
    if (window.Portal.modules?.request?.openProject) {
      window.Portal.modules.request.openProject(saved, { contactContext: context, history:'push' });
    } else {
      window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project: saved, contactContext: context } }));
    }
  }

  async function createProjectForContact(){
    const contact = readContactInputs();
    if (!validateName()) {
      return;
    }
    if (!state.saved || !firstText(state.contact.id)) {
      scheduleAutosave();const saved = await flushAutosave();
      if (!saved) return;
    }
    const savedContact = readContactInputs();
    savedContact.id = ensureContactId(state.contact);
    state.contact = savedContact;
    const id = `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const base = {
      id,
      title: (globalThis.PlatformLanguage?.text("contacts","m_0747045bf3d919","New Project") ?? "New Project"),
      project_title: 'New Project',
      address: savedContact.address || '',
      project_type: 'residential',
      lat: savedContact.lat || '',
      lng: savedContact.lng || '',
      address_components: savedContact.address_components || {},
      contacts: [],
      project_notes: '',
      workflow_state: 'draft',
      measurement: {},
      measurement_project: {},
      events: [],
      proposals: [],
      photos: [],
      updated_at: new Date().toISOString()
    };
    const project = window.Portal.ProjectStore?.save?.(patchProjectContact(base, savedContact, { referenceOnly: true })) || patchProjectContact(base, savedContact, { referenceOnly: true });
    state.projects = visibleProjects([project, ...state.projects]);
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    openProject(project);
  }
  async function open(contact = {}, options = {}){
    await shellReady;
    if(state.open)await flushAutosave();
    const overlay = ensureUI();
    const layout={panes:[{tab:options.tab || 'projects'}],...options.layout};
    const fallbackProject = contact?.project || (Array.isArray(options.projects) ? options.projects[0] : null);
    const nextContact = normalizeContact(contact || {}, fallbackProject);
    contactShell.validate({...layout,tray:null});
    if(layout.tray!=null&&!contactTrays.available({contact:nextContact,orgId:orgId()}).includes(layout.tray))throw Error('Unavailable window tray: '+layout.tray);
    clearTimeout(saveTimer);revision=0;savedRevision=0;draftMedia=[];
    state.secondaryPhoneOpen=!!cleanText(nextContact.custom_field_values?.secondary_phone);
    state.relationshipMode='';state.relationshipNames={};state.relationshipContacts={};state.returnToContact=options.returnToContact||null;
    contactTrays.reset();contactShell.reset();
    state.contact = nextContact;
    state.originalContact = { ...state.contact };
    const initialProjects = dedupeProjects(options.projects || (contact?.project ? [contact.project] : []));
    const projectsComplete = options.projectsComplete === true || options.complete === true;
    state.contactRecord = initialProjects.find(isContactRecordProject) || (fallbackProject && isContactRecordProject(fallbackProject) ? fallbackProject : null);
    state.projects = visibleProjects(initialProjects);
    state.saved = !!(state.contact.id || state.contactRecord || state.projects.length);
    state.loading = false;
    state.open = true;
    overlay.classList.add('active');
    contactWindow?.setVisible(true);
    const routeContactId = firstText(state.contact.id, state.contact.contact_id);
    if (routeContactId && !options.fromRoute && !window.Portal?.navigation?.applying) {
      window.Portal?.navigation?.push?.({
        tab:'contacts',
        contact:routeContactId,
        project:null,
        projectTab:null,
        photo:null,
        photoScope:null
      }, { source:'contact-open', ownedKeys:['contact'] });
    }
    syncContactWindowModalRegistration();
    state.mediaTab=false;state.docsTab=false;
    contactShell.apply(layout);
    render();
    window.PlatformAPI?.contacts?.settings(orgId()).then(result=>{state.catalog=result.settings?.tags || [];state.trackTimeZones=result.settings?.track_time_zones===true;if(state.open){renderTags();renderTimeZone();}}).catch(error=>setMeta(error.message));
    for(const type of ['employer','spouse']){const ref=relationshipValue(type);if(ref)void loadRelationshipContact(type,ref);}
    mountContactTodos();
    if (projectsComplete && state.projects.length) {
      renderProjects();
    } else if (contactHasLookupIdentity(state.contact) || state.projects.length) {
      refreshProjects(state.projects, { complete: projectsComplete });
    } else {
      state.loading = false;
      state.projects = [];
      renderProjects();
    }
    setMeta('');
    setTimeout(() => {
      initAddressAutocomplete();
      $('#fmContactFirstName')?.focus();
    }, 40);
  }
  async function close(options = {}){
    if(revision>savedRevision && cleanText(state.contact.name) && !await flushAutosave())return;
    clearTimeout(saveTimer);
    state.handle?.unregister?.();
    state.handle = null;
    state.open = false;
    contactTrays?.reset();
    destroyTodoController();
    $('#fmContactOverlay')?.classList.remove('active');
    contactWindow?.setVisible(false);
    if (!options.skipHistory && !options.fromRoute) {
      window.Portal?.navigation?.backOrClose?.(['contact'], { contact:null, userTab:null }, { source:'contact-close' });
    }
  }

  window.Portal.modules = window.Portal.modules || {};
  window.addEventListener('fm:contact-settings:updated',event=>{state.trackTimeZones=event.detail?.track_time_zones===true;if(state.open)renderTimeZone();});
  window.addEventListener('fm:contact-tags:updated',()=>{if(state.open)window.PlatformAPI?.contacts?.settings(orgId()).then(result=>{state.catalog=result.settings?.tags||[];renderTags();}).catch(()=>{});});
  window.Portal.modules.contacts = { open, close, openProject,
    async setLayout(layout){await shellReady;ensureUI();return contactShell.apply(layout);},
    async registerTray(definition){await shellReady;ensureUI();return contactTrays.register(definition);}
  };
})();
