/* public/libraries/apps/contacts/modal.js
 * Contact overview modal and contact-mode project navigation.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const state = {
    open: false,
    contact: {},
    originalContact: {},
    contactRecord: null,
    saved: false,
    projects: [],
    loading: false,
    portalLoading: false,
    portalUrl: '',
    handle: null,
    addressAutocomplete: null,
    addressAutocompleteInput: null
  };

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
  function orgId(){
    return firstText(cfg.userOrgId, cfg.orgId, window.__APP?.userOrgId);
  }
  function projectId(project = {}){
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
      email: firstText(contact.email, project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail, customer.email, resident.email),
      phone: firstText(contact.phone, project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone, customer.phone, resident.phone),
      address: firstText(contact.address, contact.default_address, project.contact_address, project.customer_address, project.primary_contact_address, customer.address, resident.address)
    };
  }
  function normalizeContact(contact = {}, fallbackProject = null){
    const projectContact = fallbackProject ? primaryContact(fallbackProject) : {};
    return {
      id: firstText(contact.id, contact.contact_id, projectContact.id),
      project_id: firstText(contact.project_id, fallbackProject && projectId(fallbackProject)),
      project_ids: Array.isArray(contact.project_ids) ? contact.project_ids.map(cleanText).filter(Boolean) : [],
      name: firstText(contact.name, contact.customer_name, projectContact.name),
      email: firstText(contact.email, projectContact.email),
      phone: firstText(contact.phone, projectContact.phone),
      address: firstText(contact.address, contact.default_address, contact.contact_address, projectContact.address, fallbackProject?.contact_address, fallbackProject?.customer_address, fallbackProject?.primary_contact_address, fallbackProject?.workflow_state === 'contact_only' ? fallbackProject?.address : '')
    };
  }
  function contactTokens(contact = {}){
    return {
      ids: [contact.project_id, contact.primary_project_id, ...(Array.isArray(contact.project_ids) ? contact.project_ids : [])].map(cleanText).filter(Boolean),
      contactId: firstText(contact.id, contact.contact_id)
    };
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
      .fm-contact-win{width:min(1480px,94vw);height:min(940px,90vh);background:#fff;border-radius:28px;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:flex;position:relative}
      .fm-contact-left{width:min(420px,42%);border-right:1px solid rgba(15,23,42,.08);padding:18px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px;background:#fff}
      .fm-contact-right{flex:1;min-width:0;background:#eef2f6;display:flex;flex-direction:column;position:relative}
      .fm-contact-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .fm-contact-kicker{font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
      .fm-contact-title{margin:4px 0 0;font-size:24px;font-weight:1000;color:#101828;letter-spacing:0}
      .fm-contact-close{position:absolute;top:14px;right:14px;z-index:8;width:40px;height:40px;border-radius:14px;border:1px solid rgba(15,23,42,.10);background:rgba(255,255,255,.88);backdrop-filter:blur(12px);color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 10px 24px rgba(15,23,42,.08)}
      .fm-contact-close:hover{color:#101828;background:#f8fafc}
      .fm-contact-fields{display:grid;gap:10px}
      .fm-contact-field{display:grid;gap:5px}
      .fm-contact-field label{font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
      .fm-contact-input{width:100%;box-sizing:border-box;border:1px solid rgba(15,23,42,.14);border-radius:12px;min-height:40px;padding:9px 11px;font-size:13px;font-weight:850;color:#101828;outline:none}
      .fm-contact-input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.55);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.10)}
      .pac-container{z-index:2147483600!important}
      .fm-contact-actions{display:flex;gap:8px;margin-top:auto}
      .fm-contact-actions .fm-contact-btn{flex:1 1 0}
      .fm-contact-btn{border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;color:#344054;min-height:40px;padding:0 13px;font-size:12px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
      .fm-contact-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .fm-contact-btn:disabled{opacity:.58;cursor:not-allowed}
      .fm-contact-meta{font-size:12px;font-weight:850;color:#667085;line-height:1.4;min-height:18px}
      .fm-contact-right-head{height:64px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 76px 0 20px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .fm-contact-right-title{font-size:14px;font-weight:1000;color:#101828}
      .fm-contact-count{font-size:12px;font-weight:900;color:#667085}
      .fm-contact-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .fm-contact-required{display:none;font-size:10px;font-weight:1000;color:#b42318;letter-spacing:0;text-transform:none}
      .fm-contact-field.required .fm-contact-required{display:inline}
      .fm-contact-field.required .fm-contact-input{border-color:#d92d20;background:#fff5f4;box-shadow:0 0 0 4px rgba(217,45,32,.12)}
      .fm-contact-projects{padding:18px 18px 84px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
      .fm-contact-project{border:1px solid rgba(15,23,42,.10);border-radius:8px;background:#fff;min-height:116px;padding:14px;text-align:left;cursor:pointer;box-shadow:0 12px 28px rgba(15,23,42,.06);display:flex;flex-direction:column;gap:8px}
      .fm-contact-project:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 16px 34px rgba(15,23,42,.10);transform:translateY(-1px)}
      .fm-contact-project strong{font-size:14px;font-weight:1000;color:#101828;line-height:1.25}
      .fm-contact-project span{font-size:12px;font-weight:850;color:#667085;line-height:1.35}
      .fm-contact-project small{margin-top:auto;font-size:11px;font-weight:1000;color:#98a2b3;text-transform:uppercase;letter-spacing:.04em}
      .fm-contact-empty{grid-column:1/-1;align-self:start;border:1px dashed rgba(15,23,42,.16);border-radius:8px;background:#fff;padding:28px;text-align:center;color:#667085;font-size:13px;font-weight:900}
      .fm-contact-new-project{position:absolute;right:22px;bottom:22px;z-index:4;border:0;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);min-height:46px;padding:0 17px;box-shadow:0 18px 34px rgba(var(--primary-rgb,217,48,37),.26),0 14px 32px rgba(15,23,42,.14);display:inline-flex;align-items:center;justify-content:center;gap:9px;font-size:13px;font-weight:1000;cursor:pointer}
      .fm-contact-new-project:hover{filter:brightness(.96);transform:translateY(-1px)}
      @media(max-width:760px){
        .fm-contact-win{width:100vw;height:100vh;border-radius:0;flex-direction:column}
        .fm-contact-left{width:100%;max-height:46vh;border-right:0;border-bottom:1px solid rgba(15,23,42,.08)}
        .fm-contact-projects{grid-template-columns:1fr;padding:12px}
      }
    `;
    document.head.appendChild(style);
  }
  function ensureUI(){
    injectCSS();
    let overlay = $('#fmContactOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'fm-contact-overlay';
    overlay.id = 'fmContactOverlay';
    overlay.innerHTML = `
      <div class="fm-contact-win">
        <section class="fm-contact-left">
          <div class="fm-contact-head">
            <div>
              <div class="fm-contact-kicker">Contact</div>
              <h2 class="fm-contact-title" id="fmContactTitle">New Contact</h2>
            </div>
            <button type="button" class="fm-contact-close" id="fmContactClose" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="fm-contact-fields">
            <div class="fm-contact-field" id="fmContactNameField"><label class="fm-contact-label-row"><span>Name</span><span class="fm-contact-required">Required</span></label><input class="fm-contact-input" id="fmContactName" autocomplete="name" required aria-required="true"></div>
            <div class="fm-contact-field"><label>Phone</label><input class="fm-contact-input" id="fmContactPhone" type="tel" autocomplete="tel"></div>
            <div class="fm-contact-field"><label>Email</label><input class="fm-contact-input" id="fmContactEmail" type="email" autocomplete="email"></div>
            <div class="fm-contact-field"><label>Default Address</label><input class="fm-contact-input" id="fmContactAddress" autocomplete="street-address"></div>
          </div>
          <div class="fm-contact-meta" id="fmContactMeta"></div>
          <div class="fm-contact-actions">
            <button type="button" class="fm-contact-btn" id="fmContactPortal" data-fm-tooltip="Copy Customer Portal link"><i class="fas fa-link"></i><span>Portal</span></button>
            <button type="button" class="fm-contact-btn primary" id="fmContactSave"><i class="fas fa-save"></i><span>Save</span></button>
          </div>
        </section>
        <section class="fm-contact-right">
          <div class="fm-contact-right-head">
            <div class="fm-contact-right-title">Projects</div>
            <div class="fm-contact-count" id="fmContactProjectCount"></div>
          </div>
          <div class="fm-contact-projects" id="fmContactProjects"></div>
          <button type="button" class="fm-contact-new-project" id="fmContactNewProject"><i class="fas fa-plus"></i><span>New Project</span></button>
        </section>
      </div>
    `;
    document.body.appendChild(overlay);
    $('#fmContactClose', overlay)?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { overlay.__downBackdrop = event.target === overlay; });
    overlay.addEventListener('mouseup', (event) => {
      if (overlay.__downBackdrop && event.target === overlay) close();
      overlay.__downBackdrop = false;
    });
    $('#fmContactSave', overlay)?.addEventListener('click', saveContact);
    $('#fmContactPortal', overlay)?.addEventListener('click', ensureContactPortalLink);
    $('#fmContactNewProject', overlay)?.addEventListener('click', createProjectForContact);
    ['fmContactName','fmContactPhone','fmContactEmail','fmContactAddress'].forEach((id) => {
      $(`#${id}`, overlay)?.addEventListener('input', () => {
        readContactInputs();
        if (id === 'fmContactName') setNameRequired(!cleanText(state.contact.name));
        renderHeader();
        setMeta('Unsaved changes.');
      });
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
    const input = $('#fmContactName');
    field?.classList.toggle('required', !!on);
    if (input) input.setAttribute('aria-invalid', on ? 'true' : 'false');
  }
  function validateName(options = {}){
    const name = cleanText($('#fmContactName')?.value || state.contact?.name);
    const valid = !!name;
    setNameRequired(!valid);
    if (!valid) {
      setMeta('Name is required.');
      if (options.focus) $('#fmContactName')?.focus();
    }
    return valid;
  }
  function readContactInputs(){
    const previousAddress = cleanText(state.contact?.address);
    const nextAddress = cleanText($('#fmContactAddress')?.value);
    state.contact = {
      ...state.contact,
      name: cleanText($('#fmContactName')?.value),
      phone: cleanText($('#fmContactPhone')?.value),
      email: cleanText($('#fmContactEmail')?.value),
      address: nextAddress,
      ...(previousAddress && nextAddress !== previousAddress ? { lat: '', lng: '', address_components: {} } : {})
    };
    return state.contact;
  }
  function writeContactInputs(){
    const contact = state.contact || {};
    if ($('#fmContactName')) $('#fmContactName').value = contact.name || '';
    if ($('#fmContactPhone')) $('#fmContactPhone').value = contact.phone || '';
    if ($('#fmContactEmail')) $('#fmContactEmail').value = contact.email || '';
    if ($('#fmContactAddress')) $('#fmContactAddress').value = contact.address || '';
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
    setMeta('Unsaved changes.');
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
    const title = $('#fmContactTitle');
    if (title) title.textContent = contactTitle(state.contact);
  }
  function renderProjects(){
    const mount = $('#fmContactProjects');
    const count = $('#fmContactProjectCount');
    if (!mount) return;
    const projects = visibleProjects(state.projects || []);
    if (count) count.textContent = state.loading ? 'Loading...' : `${projects.length} project${projects.length === 1 ? '' : 's'}`;
    if (state.loading) {
      mount.innerHTML = '<div class="fm-contact-empty">Loading projects...</div>';
      return;
    }
    if (!projects.length) {
      mount.innerHTML = '<div class="fm-contact-empty">No projects are linked to this contact yet.</div>';
      return;
    }
    mount.innerHTML = projects.map((project) => {
      const contact = primaryContact(project);
      return `
        <button type="button" class="fm-contact-project" data-contact-project-id="${escapeHtml(projectId(project))}">
          <strong>${escapeHtml(projectTitle(project))}</strong>
          <span>${escapeHtml(firstText(project.address, project.project_type, project.stage, 'No address'))}</span>
          <span>${escapeHtml(firstText(contact.name, contact.email, contact.phone))}</span>
          <small>Open project</small>
        </button>
      `;
    }).join('');
  }
  function render(){
    writeContactInputs();
    renderHeader();
    renderProjects();
    const portalButton = $('#fmContactPortal');
    if (portalButton) portalButton.disabled = !!state.portalLoading;
  }
  function patchProjectContact(project = {}, contact = {}, options = {}){
    const contactId = ensureContactId(contact);
    const contacts = Array.isArray(project.contacts)
      ? project.contacts.filter(contactHasContent).map((row) => ({ ...row }))
      : [];
    const nextTokens = contactTokens({ ...contact, id: contactId, contact_id: contactId });
    let index = contacts.findIndex((row) => {
      const tokens = contactTokens(row || {});
      return nextTokens.contactId && tokens.contactId === nextTokens.contactId;
    });
    const nextContact = {
      id: contactId,
      contact_id: contactId,
      name: contact.name || '',
      phone: contact.phone || '',
      email: contact.email || '',
      address: contact.address || '',
      default_address: contact.address || '',
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
      customer_phone: contact.phone || project.customer_phone || '',
      primary_contact_phone: contact.phone || project.primary_contact_phone || '',
      contact_address: contact.address || project.contact_address || '',
      customer_address: contact.address || project.customer_address || '',
      primary_contact_address: contact.address || project.primary_contact_address || '',
      updated_at: new Date().toISOString()
    };
  }
  async function saveContact(){
    const contact = readContactInputs();
    if (!validateName({ focus: true })) return false;
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
        stage: 'contacting',
        stage_id: 'contacting',
        workflow_state: 'contact_only',
        measurement: {},
        measurement: state.contactRecord?.measurement || {},
        measurement_project: state.contactRecord?.measurement_project || {},
        events: Array.isArray(state.contactRecord?.events) ? state.contactRecord.events : [],
        proposals: Array.isArray(state.contactRecord?.proposals) ? state.contactRecord.proposals : []
      }, contact);
    const savedRecord = window.Portal.ProjectStore?.save?.(contactRecord) || contactRecord;
    state.contactRecord = savedRecord;
    state.contact = {
      ...contact,
      id: contact.id,
      project_id: firstText(contact.project_id),
      record_project_id: projectId(savedRecord)
    };
    state.projects = visibleProjects(state.projects).map((project) => {
      const linked = patchProjectContact(project, state.contact, { referenceOnly: true });
      return window.Portal.ProjectStore?.save?.(linked) || linked;
    });
    state.originalContact = { ...contact };
    state.saved = true;
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    render();
    setMeta('Saved.');
    return true;
  }

  async function copyText(value, successMessage){
    try {
      await navigator.clipboard.writeText(value);
      setMeta(successMessage);
    } catch (_) {
      setMeta('Could not copy the portal link.');
    }
  }

  async function ensureContactPortalLink(){
    const contact = readContactInputs();
    if (!validateName({ focus: true })) return;
    if (!state.saved || !firstText(state.contact.id)) {
      const saved = await saveContact();
      if (!saved) return;
    }
    const projects = visibleProjects(state.projects);
    if (!projects.length) {
      setMeta('Create or link a project before creating a portal link.');
      return;
    }
    const oid = orgId();
    const project = projects[0];
    const pid = projectId(project);
    if (!oid || !pid || !window.PlatformAPI?.customerPortals?.ensure) {
      setMeta('Customer Portal is not available right now.');
      return;
    }
    const contactId = ensureContactId(state.contact);
    const savedContact = { ...readContactInputs(), id: contactId, contact_id: contactId };
    state.contact = savedContact;
    state.portalLoading = true;
    render();
    setMeta('Creating portal link...');
    try {
      const result = await window.PlatformAPI.customerPortals.ensure(oid, pid, {
        contact_id: savedContact.id,
        customer: savedContact
      });
      const url = cleanText(result?.portal?.live_url);
      state.portalUrl = url;
      if (url) await copyText(url, 'Customer portal link copied.');
      else setMeta('Portal link created.');
    } catch (error) {
      setMeta(error?.message || 'Could not create the portal link.');
    } finally {
      state.portalLoading = false;
      render();
    }
  }
  async function refreshProjects(provided = [], options = {}){
    state.loading = true;
    renderProjects();
    state.projects = visibleProjects(await loadContactProjects(state.contact, provided, options).catch(() => dedupeProjects(provided)));
    state.loading = false;
    renderProjects();
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
    close();
    if (window.Portal.modules?.request?.openProject) {
      window.Portal.modules.request.openProject(saved, { contactContext: context });
    } else {
      window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project: saved, contactContext: context } }));
    }
  }

  async function createProjectForContact(){
    const contact = readContactInputs();
    if (!validateName({ focus: true })) {
      return;
    }
    if (!state.saved || !firstText(state.contact.id)) {
      const saved = await saveContact();
      if (!saved) return;
    }
    const savedContact = readContactInputs();
    savedContact.id = ensureContactId(state.contact);
    state.contact = savedContact;
    const id = `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const base = {
      id,
      title: 'New Project',
      project_title: 'New Project',
      address: savedContact.address || '',
      project_type: 'residential',
      lat: savedContact.lat || '',
      lng: savedContact.lng || '',
      address_components: savedContact.address_components || {},
      contacts: [],
      project_notes: '',
      stage: 'contacting',
      stage_id: 'contacting',
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
  function open(contact = {}, options = {}){
    const overlay = ensureUI();
    const fallbackProject = contact?.project || (Array.isArray(options.projects) ? options.projects[0] : null);
    state.contact = normalizeContact(contact || {}, fallbackProject);
    state.originalContact = { ...state.contact };
    const initialProjects = dedupeProjects(options.projects || (contact?.project ? [contact.project] : []));
    const projectsComplete = options.projectsComplete === true || options.complete === true;
    state.contactRecord = initialProjects.find(isContactRecordProject) || (fallbackProject && isContactRecordProject(fallbackProject) ? fallbackProject : null);
    state.projects = visibleProjects(initialProjects);
    state.saved = !!(state.contact.id || state.contactRecord || state.projects.length);
    state.loading = false;
    state.open = true;
    overlay.classList.add('active');
    state.handle?.unregister?.();
    state.handle = window.Portal?.modals?.register?.(overlay, {
      id: 'contact-modal',
      closeOnEscape: true,
      closeOnBackdrop: false,
      onClose: close
    }) || null;
    render();
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
      $('#fmContactName')?.focus();
    }, 40);
  }
  function close(){
    state.handle?.unregister?.();
    state.handle = null;
    state.open = false;
    $('#fmContactOverlay')?.classList.remove('active');
  }

  window.Portal.modules = window.Portal.modules || {};
  window.Portal.modules.contacts = { open, close, openProject };
})();
